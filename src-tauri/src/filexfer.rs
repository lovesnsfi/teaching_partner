// 文件传输：1:1 复刻 electron/main.js 的 offer / accept / reject / chunk / done / cancel 协议。
//
// 协议要点（与 Electron 版一致）：
//   · 信令复用 TCP 41235（换行分隔 JSON），发送方连到目标 IP，写一条 JSON 即关；
//   · 普通文件：offer（元信息）→ 等对方 accept → 才开始分片；reject 则通知发送方已拒绝；
//   · 图片（direct）：不等确认直接分片发送，接收端首片到达时补出消息；
//   · 分片 24KB 二进制 → base64，一条连接内连续发送；接收端写临时文件，收齐后挪到
//     「下载/局域网沟通广播」目录（或用户「另存为」指定路径）；
//   · 接收方可中途取消：停写、删半截文件，并通知发送方停发剩余分片。
//
// 与 Electron 版的差异：信道从 WebSocket 换成朴素 TCP（Tauri 版两端都是 Rust，自洽即可）。

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::discovery::SelfInput;

const SIGNAL_PORT: u16 = 41235;
const CHUNK_SIZE: usize = 24 * 1024; // base64 前的二进制分片大小（与 Electron 版一致）

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- 前端传入的形状 ----
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSpecInput {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mime: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendSpecInput {
    pub file_id: String,
    pub ips: Vec<String>,
    pub file: FileSpecInput,
    #[serde(default)]
    pub conv_id: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub direct: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptResult {
    pub ok: bool,
    #[serde(default)]
    pub canceled: bool,
}

// ---- 内部状态 ----
struct PendingIn {
    name: String,
    from_ip: String,
}

struct PendingOut {
    ips: Vec<String>,
    file: FileSpecInput,
    conv_id: String,
    group_id: Option<String>,
    granted: HashSet<String>,
    rejected_count: u32,
}

#[derive(Default)]
struct SendState {
    per_ip: u64,
    granted: usize,
    done: u64,
}

struct RecvState {
    file: File,
    tmp: PathBuf,
    dest_path: Option<PathBuf>,
    from_ip: String,
    received: u64,
    total: u64,
    conv_id: String,
    group_id: Option<String>,
    from_name: String,
    name: String,
    size: u64,
    mime: String,
}

/// 文件传输共享状态：既由 `manage` 暴露给命令，也被信令 server 持有用于入站路由。
pub struct FileInner {
    app: AppHandle,
    self_info: Arc<Mutex<SelfInput>>,
    pending_in: Mutex<HashMap<String, PendingIn>>,
    pending_out: Mutex<HashMap<String, PendingOut>>,
    send_state: Mutex<HashMap<String, SendState>>,
    recv: Mutex<HashMap<String, RecvState>>,
    pre_recv_dest: Mutex<HashMap<String, PathBuf>>,
    cancelled: Mutex<HashSet<String>>,
}

impl FileInner {
    pub fn new(app: AppHandle, self_info: Arc<Mutex<SelfInput>>) -> Self {
        FileInner {
            app,
            self_info,
            pending_in: Mutex::new(HashMap::new()),
            pending_out: Mutex::new(HashMap::new()),
            send_state: Mutex::new(HashMap::new()),
            recv: Mutex::new(HashMap::new()),
            pre_recv_dest: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
        }
    }

    /// 给外发消息补上发送者身份（对应 Electron 信令层注入的 from/fromName/fromAvatar）
    fn inject_from(&self, msg: &mut Value) {
        let si = self.self_info.lock().unwrap().clone();
        if let Value::Object(ref mut map) = msg {
            map.insert("from".into(), json!(si.id));
            map.insert("fromName".into(), json!(si.name));
            map.insert("fromAvatar".into(), json!(si.avatar));
        }
    }

    /// 发送一条信令（连上目标、写一行 JSON、关闭）
    fn send_line(&self, ip: &str, payload: Value) -> bool {
        let mut msg = payload;
        self.inject_from(&mut msg);
        let line = match serde_json::to_string(&msg) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let addr: SocketAddr = match format!("{}:{}", ip.trim(), SIGNAL_PORT).parse() {
            Ok(a) => a,
            Err(_) => return false,
        };
        match TcpStream::connect_timeout(&addr, Duration::from_millis(2500)) {
            Ok(mut s) => {
                let _ = s.set_write_timeout(Some(Duration::from_millis(2500)));
                let _ = s.write_all(line.as_bytes());
                let _ = s.write_all(b"\n");
                let _ = s.flush();
                let _ = s.shutdown(std::net::Shutdown::Write);
                true
            }
            Err(_) => false,
        }
    }

    // ===== 发送端 =====

    pub fn send(self: &Arc<Self>, spec: SendSpecInput) {
        if spec.ips.is_empty() || spec.file.path.is_empty() || spec.file_id.is_empty() {
            return;
        }
        if spec.direct {
            self.direct_send(spec);
        } else {
            self.queue_send(spec);
        }
    }

    fn per_ip(size: u64) -> u64 {
        ((size as usize).div_ceil(CHUNK_SIZE)).max(1) as u64
    }

    /// 登记为「待确认」，给每个目标发一条只含元信息的 offer
    fn queue_send(self: &Arc<Self>, spec: SendSpecInput) {
        let per_ip = Self::per_ip(spec.file.size);
        {
            let mut po = self.pending_out.lock().unwrap();
            po.insert(
                spec.file_id.clone(),
                PendingOut {
                    ips: spec.ips.clone(),
                    file: spec.file.clone(),
                    conv_id: spec.conv_id.clone(),
                    group_id: spec.group_id.clone(),
                    granted: HashSet::new(),
                    rejected_count: 0,
                },
            );
        }
        self.send_state.lock().unwrap().insert(
            spec.file_id.clone(),
            SendState {
                per_ip,
                granted: 0,
                done: 0,
            },
        );
        for ip in &spec.ips {
            self.send_line(
                ip,
                json!({
                    "type": "file",
                    "action": "offer",
                    "fileId": spec.file_id,
                    "convId": spec.conv_id,
                    "groupId": spec.group_id,
                    "name": spec.file.name,
                    "size": spec.file.size,
                    "mime": spec.file.mime,
                    "total": per_ip
                }),
            );
        }
    }

    /// 免确认直发（图片）：立即开始分片传输
    fn direct_send(self: &Arc<Self>, spec: SendSpecInput) {
        let per_ip = Self::per_ip(spec.file.size);
        {
            let mut po = self.pending_out.lock().unwrap();
            po.insert(
                spec.file_id.clone(),
                PendingOut {
                    ips: spec.ips.clone(),
                    file: spec.file.clone(),
                    conv_id: spec.conv_id.clone(),
                    group_id: spec.group_id.clone(),
                    granted: spec.ips.iter().cloned().collect(),
                    rejected_count: 0,
                },
            );
        }
        self.send_state.lock().unwrap().insert(
            spec.file_id.clone(),
            SendState {
                per_ip,
                granted: spec.ips.len(),
                done: 0,
            },
        );
        let _ = self.app.emit(
            "lan:file-send-start",
            json!({
                "fileId": spec.file_id,
                "convId": spec.conv_id,
                "groupId": spec.group_id,
                "name": spec.file.name,
                "size": spec.file.size
            }),
        );
        self.send_to_ips(
            &spec.ips,
            &spec.file,
            &spec.file_id,
            &spec.conv_id,
            spec.group_id.as_deref(),
        );
        self.finish_out(&spec.file_id, &spec.conv_id);
    }

    /// 收到对端 accept：为该目标启动传输（群发场景各自确认、各自启动）
    fn start_transfer(self: &Arc<Self>, file_id: &str, ip: &str) {
        let (ips_len, file, conv_id, group_id) = {
            let mut po = self.pending_out.lock().unwrap();
            let spec = match po.get_mut(file_id) {
                Some(s) => s,
                None => return,
            };
            if !spec.granted.insert(ip.to_string()) {
                return; // 该目标已启动过
            }
            let granted = spec.granted.len();
            {
                let mut ss = self.send_state.lock().unwrap();
                if let Some(st) = ss.get_mut(file_id) {
                    st.granted = granted;
                }
            }
            if granted == 1 {
                let _ = self.app.emit(
                    "lan:file-send-start",
                    json!({
                        "fileId": file_id,
                        "convId": spec.conv_id,
                        "groupId": spec.group_id,
                        "name": spec.file.name,
                        "size": spec.file.size
                    }),
                );
            }
            (
                spec.ips.len(),
                spec.file.clone(),
                spec.conv_id.clone(),
                spec.group_id.clone(),
            )
        };
        self.send_to_ips(&[ip.to_string()], &file, file_id, &conv_id, group_id.as_deref());
        if self.pending_out.lock().unwrap().get(file_id).map(|s| s.granted.len()).unwrap_or(0) >= ips_len
        {
            self.finish_out(file_id, &conv_id);
        }
    }

    /// 发送完成（或被拒/取消）后的清理 + 「发送完成」通知
    fn finish_out(self: &Arc<Self>, file_id: &str, conv_id: &str) {
        self.pending_out.lock().unwrap().remove(file_id);
        self.send_state.lock().unwrap().remove(file_id);
        let _ = self.app.emit(
            "lan:file-send-done",
            json!({ "fileId": file_id, "convId": conv_id }),
        );
    }

    /// 底层：读文件 → base64 分片 → 逐目标 IP 在一条连接内连续发送
    fn send_to_ips(
        self: &Arc<Self>,
        ips: &[String],
        file: &FileSpecInput,
        file_id: &str,
        conv_id: &str,
        group_id: Option<&str>,
    ) -> bool {
        let buf = match fs::read(&file.path) {
            Ok(b) => b,
            Err(_) => return false,
        };
        let total = buf.len().div_ceil(CHUNK_SIZE).max(1);
        // 预序列化全部分片（带上发送者身份）
        let mut lines: Vec<String> = Vec::with_capacity(total);
        for i in 0..total {
            let start = i * CHUNK_SIZE;
            let end = ((i + 1) * CHUNK_SIZE).min(buf.len());
            let mut msg = json!({
                "type": "file",
                "action": "chunk",
                "fileId": file_id,
                "convId": conv_id,
                "groupId": group_id,
                "name": file.name,
                "size": file.size,
                "mime": file.mime,
                "index": i,
                "total": total,
                "data": BASE64.encode(&buf[start..end])
            });
            self.inject_from(&mut msg);
            lines.push(serde_json::to_string(&msg).unwrap_or_default());
        }

        for ip in ips {
            if self.cancelled.lock().unwrap().contains(file_id) {
                return false; // 接收方已取消：停发
            }
            let addr: SocketAddr = match format!("{}:{}", ip.trim(), SIGNAL_PORT).parse() {
                Ok(a) => a,
                Err(_) => continue,
            };
            let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(2500)) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
            for line in &lines {
                if self.cancelled.lock().unwrap().contains(file_id) {
                    return false;
                }
                if stream.write_all(line.as_bytes()).is_err() || stream.write_all(b"\n").is_err() {
                    break;
                }
                // 进度：done 递增；分母随已确认目标数动态增长，保证最终能到 100%
                let (done, total_den) = {
                    let mut ss = self.send_state.lock().unwrap();
                    match ss.get_mut(file_id) {
                        Some(st) => {
                            st.done += 1;
                            (st.done, st.per_ip * (st.granted.max(1) as u64))
                        }
                        None => (0, 1),
                    }
                };
                let _ = self.app.emit(
                    "lan:file-send-progress",
                    json!({ "fileId": file_id, "done": done, "total": total_den }),
                );
            }
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        }

        if self.cancelled.lock().unwrap().contains(file_id) {
            return false; // 不再发「传输完成」
        }
        for ip in ips {
            self.send_line(
                ip,
                json!({
                    "type": "file",
                    "action": "done",
                    "fileId": file_id,
                    "convId": conv_id,
                    "groupId": group_id,
                    "name": file.name
                }),
            );
        }
        true
    }

    // ===== 接收端 =====

    /// 接收方确认接收；saveAs=true 时先弹「另存为」
    pub fn accept(self: &Arc<Self>, file_id: &str, save_as: bool) -> AcceptResult {
        let info = {
            let mut pi = self.pending_in.lock().unwrap();
            pi.remove(file_id)
        };
        let info = match info {
            Some(i) => i,
            None => return AcceptResult { ok: false, canceled: false },
        };
        if save_as {
            let (tx, rx): (Sender<Option<PathBuf>>, Receiver<Option<PathBuf>>) = channel();
            self.app
                .dialog()
                .file()
                .set_file_name(&info.name)
                .save_file(move |p| {
                    let _ = tx.send(p.and_then(|fp| fp.into_path().ok()));
                });
            match rx.recv_timeout(Duration::from_secs(600)) {
                Ok(Some(dest)) => {
                    self.pre_recv_dest
                        .lock()
                        .unwrap()
                        .insert(file_id.to_string(), dest);
                }
                _ => {
                    // 用户取消：恢复待确认状态，对方仍显示「等待接收」
                    self.pending_in.lock().unwrap().insert(file_id.to_string(), info);
                    return AcceptResult { ok: false, canceled: true };
                }
            }
        }
        self.send_line(
            &info.from_ip,
            json!({ "type": "file", "action": "accept", "fileId": file_id }),
        );
        AcceptResult { ok: true, canceled: false }
    }

    /// 接收方拒绝接收
    pub fn reject(&self, file_id: &str) {
        let info = {
            let mut pi = self.pending_in.lock().unwrap();
            pi.remove(file_id)
        };
        self.pre_recv_dest.lock().unwrap().remove(file_id);
        if let Some(i) = info {
            self.send_line(
                &i.from_ip,
                json!({ "type": "file", "action": "reject", "fileId": file_id }),
            );
        }
    }

    /// 接收方取消：停写、删半截文件，并通知发送方停发
    pub fn cancel_receive(&self, file_id: &str) {
        let rec = { self.recv.lock().unwrap().remove(file_id) };
        if let Some(rec) = rec {
            drop(rec.file); // 关闭句柄
            let partial = rec.dest_path.clone().unwrap_or_else(|| rec.tmp.clone());
            let _ = fs::remove_file(&partial);
            self.send_line(
                &rec.from_ip,
                json!({ "type": "file", "action": "cancel", "fileId": file_id }),
            );
        }
        self.pending_in.lock().unwrap().remove(file_id);
        self.pre_recv_dest.lock().unwrap().remove(file_id);
    }

    /// 入站 file 消息路由（由信令 server 调用）
    pub fn handle_msg(self: &Arc<Self>, msg: &Value, from_ip: &str) {
        let action = msg.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let file_id = match msg.get("fileId").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s,
            _ => return,
        };
        // 会话 id 归一化：群聊 -> groupId；单聊 -> 发送方设备 id（与 Electron 一致）
        let conv_id = msg
            .get("groupId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                msg.get("from")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();

        match action {
            "offer" => {
                {
                    let mut pi = self.pending_in.lock().unwrap();
                    pi.insert(
                        file_id.to_string(),
                        PendingIn {
                            name: msg
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            from_ip: from_ip.to_string(),
                        },
                    );
                }
                let _ = self.app.emit(
                    "lan:file-offer",
                    json!({
                        "fileId": file_id,
                        "name": msg.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        "size": msg.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                        "mime": msg.get("mime").and_then(|v| v.as_str()).unwrap_or(""),
                        "total": msg.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
                        "convId": conv_id,
                        "groupId": msg.get("groupId"),
                        "from": msg.get("from"),
                        "fromName": msg.get("fromName").and_then(|v| v.as_str()).unwrap_or("对方"),
                        "fromAvatar": msg.get("fromAvatar").and_then(|v| v.as_str()).unwrap_or(""),
                        "awaiting": true
                    }),
                );
            }
            "accept" => {
                let fx = self.clone();
                let fid = file_id.to_string();
                let ip = from_ip.to_string();
                thread::spawn(move || fx.start_transfer(&fid, &ip));
            }
            "reject" => {
                let (all_rejected, conv_id_out, group_id_out) = {
                    let mut po = self.pending_out.lock().unwrap();
                    match po.get_mut(file_id) {
                        Some(spec) => {
                            spec.rejected_count += 1;
                            (
                                spec.granted.is_empty()
                                    && spec.rejected_count >= spec.ips.len() as u32,
                                spec.conv_id.clone(),
                                spec.group_id.clone(),
                            )
                        }
                        None => return,
                    }
                };
                if all_rejected {
                    self.pending_out.lock().unwrap().remove(file_id);
                    self.send_state.lock().unwrap().remove(file_id);
                    let _ = self.app.emit(
                        "lan:file-rejected",
                        json!({
                            "fileId": file_id,
                            "convId": conv_id_out,
                            "groupId": group_id_out
                        }),
                    );
                }
            }
            "cancel" => {
                self.cancelled.lock().unwrap().insert(file_id.to_string());
                // 60s 后清理，避免同 fileId 长期残留
                let fx = self.clone();
                let fid = file_id.to_string();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(60));
                    fx.cancelled.lock().unwrap().remove(&fid);
                });
                let conv_out = self
                    .pending_out
                    .lock()
                    .unwrap()
                    .get(file_id)
                    .map(|s| s.conv_id.clone())
                    .unwrap_or_else(|| conv_id.clone());
                let _ = self.app.emit(
                    "lan:file-cancelled",
                    json!({ "fileId": file_id, "convId": conv_out }),
                );
            }
            "chunk" => self.handle_chunk(msg, file_id, &conv_id, from_ip),
            // done：分片收齐即定稿，无需额外处理
            _ => {}
        }
    }

    fn handle_chunk(self: &Arc<Self>, msg: &Value, file_id: &str, conv_id: &str, from_ip: &str) {
        let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let size = msg.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        let mime = msg.get("mime").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let total = msg.get("total").and_then(|v| v.as_u64()).unwrap_or(1).max(1);
        let group_id = msg
            .get("groupId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let from_name = msg
            .get("fromName")
            .and_then(|v| v.as_str())
            .unwrap_or("对方")
            .to_string();

        let mut recs = self.recv.lock().unwrap();
        if !recs.contains_key(file_id) {
            // 「另存为」时用户已选定目标路径；否则先写临时文件
            let dest = self.pre_recv_dest.lock().unwrap().remove(file_id);
            let tmp = std::env::temp_dir().join(format!("lanfile-{file_id}.part"));
            let target = dest.clone().unwrap_or_else(|| tmp.clone());
            let file = match OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&target)
            {
                Ok(f) => f,
                Err(_) => return,
            };
            recs.insert(
                file_id.to_string(),
                RecvState {
                    file,
                    tmp,
                    dest_path: dest,
                    from_ip: from_ip.to_string(),
                    received: 0,
                    total,
                    conv_id: conv_id.to_string(),
                    group_id: group_id.clone(),
                    from_name: from_name.clone(),
                    name: name.clone(),
                    size,
                    mime: mime.clone(),
                },
            );
            // 通知渲染层「文件开始到达」：普通文件此前已有 offer 卡片，这里只需切换状态；
            // 图片等免确认直传场景则靠这条通知即时新建消息。
            let _ = self.app.emit(
                "lan:file-incoming",
                json!({
                    "fileId": file_id,
                    "name": name,
                    "size": size,
                    "mime": mime,
                    "total": total,
                    "convId": conv_id,
                    "groupId": group_id,
                    "from": msg.get("from"),
                    "fromName": from_name,
                    "fromAvatar": msg.get("fromAvatar").and_then(|v| v.as_str()).unwrap_or("")
                }),
            );
        }

        let rec = match recs.get_mut(file_id) {
            Some(r) => r,
            None => return,
        };
        if let Some(data) = msg.get("data").and_then(|v| v.as_str()) {
            if let Ok(bytes) = BASE64.decode(data) {
                let _ = rec.file.write_all(&bytes);
            }
        }
        rec.received += 1;
        let (received, rec_total) = (rec.received, rec.total);
        let _ = self.app.emit(
            "lan:file-progress",
            json!({
                "fileId": file_id,
                "received": received,
                "total": rec_total
            }),
        );
        if received < rec_total {
            return;
        }

        // 收齐：定稿
        let mut rec = recs.remove(file_id).unwrap();
        drop(recs); // 先释放锁再做磁盘操作
        let _ = rec.file.flush();
        let _ = rec.file.sync_all();
        drop(rec.file);

        let final_path = match rec.dest_path.clone() {
            Some(p) => p,
            None => {
                let dir = self
                    .app
                    .path()
                    .download_dir()
                    .or_else(|_| self.app.path().home_dir())
                    .unwrap_or_else(|_| std::env::temp_dir());
                let _ = fs::create_dir_all(&dir);
                let fp = unique_path(&dir, &rec.name);
                if fs::rename(&rec.tmp, &fp).is_err() {
                    // 跨盘符 rename 失败兜底：复制后删临时文件
                    let _ = fs::copy(&rec.tmp, &fp);
                    let _ = fs::remove_file(&rec.tmp);
                }
                fp
            }
        };
        let _ = self.app.emit(
            "lan:file-done",
            json!({
                "fileId": file_id,
                "name": rec.name,
                "size": rec.size,
                "mime": rec.mime,
                "path": final_path.to_string_lossy(),
                "convId": rec.conv_id,
                "groupId": rec.group_id,
                "from": msg.get("from"),
                "fromName": rec.from_name,
                "ts": now_ms()
            }),
        );
    }
}

/// 目标目录下生成不重名的文件名（与 Electron 的 uniqueName 一致：追加 " (n)"）
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_string());
    for i in 1..1000 {
        let cand = match &ext {
            Some(e) => dir.join(format!("{stem} ({i}).{e}")),
            None => dir.join(format!("{stem} ({i})")),
        };
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!("{stem}-{}", now_ms()))
}

// ===== Tauri 命令 =====

#[tauri::command]
pub fn file_send(fx: tauri::State<'_, Arc<FileInner>>, spec: SendSpecInput) {
    let fx = fx.inner().clone();
    thread::spawn(move || fx.send(spec));
}

#[tauri::command]
pub async fn file_accept(
    fx: tauri::State<'_, Arc<FileInner>>,
    file_id: String,
    save_as: bool,
) -> Result<AcceptResult, String> {
    // 异步命令跑在 worker 线程上，主线程可正常响应「另存为」对话框回调
    Ok(fx.inner().clone().accept(&file_id, save_as))
}

#[tauri::command]
pub fn file_reject(fx: tauri::State<'_, Arc<FileInner>>, file_id: String) {
    fx.inner().reject(&file_id)
}

#[tauri::command]
pub fn file_cancel_receive(fx: tauri::State<'_, Arc<FileInner>>, file_id: String) {
    fx.inner().cancel_receive(&file_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipImageResult {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

/// 保存剪贴板里的图片（Ctrl+V 粘贴截图）到临时目录
/// 走 Rust 而非 JS fs 插件：临时/下载目录不在 fs 插件默认 scope 内。
#[tauri::command]
pub fn clipboard_image_save(data_url: String, mime: Option<String>) -> Option<ClipImageResult> {
    if !data_url.starts_with("data:") {
        return None;
    }
    let b64 = data_url.split(',').nth(1)?;
    let buf = BASE64.decode(b64).ok()?;
    if buf.is_empty() {
        return None;
    }
    let ty = mime
        .filter(|m| m.starts_with("image/"))
        .unwrap_or_else(|| "image/png".to_string());
    let ext = if ty == "image/jpeg" {
        "jpg"
    } else {
        ty.split('/').nth(1).unwrap_or("png")
    };
    let dir = std::env::temp_dir().join("lan-clipboard");
    fs::create_dir_all(&dir).ok()?;
    let name = format!("paste-{}.{ext}", now_ms());
    let p = dir.join(&name);
    fs::write(&p, &buf).ok()?;
    Some(ClipImageResult {
        path: p.to_string_lossy().to_string(),
        name,
        size: buf.len() as u64,
        mime: ty,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAsResult {
    pub ok: bool,
    #[serde(default)]
    pub canceled: bool,
    #[serde(default)]
    pub path: String,
}

/// 图片「另存为」：弹保存对话框并复制到指定位置
#[tauri::command]
pub async fn image_save_as(
    app: AppHandle,
    src: String,
    name: Option<String>,
) -> Result<SaveAsResult, String> {
    if src.is_empty() || !Path::new(&src).exists() {
        return Ok(SaveAsResult {
            ok: false,
            canceled: false,
            path: String::new(),
        });
    }
    let default_name = name
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| base_name(&src));
    let (tx, rx) = channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |p| {
            let _ = tx.send(p.and_then(|fp| fp.into_path().ok()));
        });
    let dest = match rx.recv_timeout(Duration::from_secs(600)) {
        Ok(Some(d)) => d,
        _ => {
            return Ok(SaveAsResult {
                ok: false,
                canceled: true,
                path: String::new(),
            })
        }
    };
    match fs::copy(&src, &dest) {
        Ok(_) => Ok(SaveAsResult {
            ok: true,
            canceled: false,
            path: dest.to_string_lossy().to_string(),
        }),
        Err(e) => Err(format!("复制失败：{e}")),
    }
}

fn base_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}
