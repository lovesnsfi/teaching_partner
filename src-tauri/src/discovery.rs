// 局域网设备发现：UDP 广播宣告 + 接收邻居广播 + 心跳超时清理 + 退出告别。
// 复刻自 electron/lan.js 的协议，保证与 Electron 版互通：
//   - 端口 41234，每 3s 广播一次 hello（JSON）
//   - 12s 未收到即视为离线并清理
//   - 退出时连发 3 遍 bye，让对方立刻把自己标为离线
// 实现上用「阻塞 socket + 线程」，不引 tokio，最稳；设备列表变化时通过
// app.emit("lan:devices", list) 推给前端（适配层 onDevices 已在监听）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use if_addrs::{get_if_addrs, IfAddr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const DISCOVERY_PORT: u16 = 41234;
const SIGNAL_PORT: u16 = 41235;
const BROADCAST_INTERVAL: Duration = Duration::from_millis(3000);
const HEARTBEAT_TIMEOUT_MS: i64 = 12000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Windows 电脑名（对应 Node 的 os.hostname()）
fn computer_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

// 收集所有非回环 IPv4 网卡：(名称, ip, netmask, broadcast)
fn collect_v4(
) -> Vec<(String, std::net::Ipv4Addr, std::net::Ipv4Addr, Option<std::net::Ipv4Addr>)> {
    let mut out = Vec::new();
    if let Ok(ifaces) = get_if_addrs() {
        for iface in ifaces {
            if let IfAddr::V4(v4) = &iface.addr {
                if !v4.ip.is_loopback() {
                    out.push((iface.name.clone(), v4.ip, v4.netmask, v4.broadcast));
                }
            }
        }
    }
    out
}

fn is_private(ip: std::net::Ipv4Addr) -> bool {
    ip.is_private()
}

// 默认局域网 IP：优先私有网段，否则第一个非回环 IPv4
fn default_lan_ip() -> String {
    let list = collect_v4();
    if let Some((_, ip, _, _)) = list.iter().find(|(_, ip, _, _)| is_private(*ip)) {
        return ip.to_string();
    }
    if let Some((_, ip, _, _)) = list.first() {
        return ip.to_string();
    }
    "127.0.0.1".to_string()
}

// 当前对外宣告使用的 IP：手动指定优先，否则自动
fn lan_ip(selected: Option<&str>) -> String {
    match selected {
        Some(ip) if !ip.is_empty() => ip.to_string(),
        _ => default_lan_ip(),
    }
}

fn compute_broadcast(ip: std::net::Ipv4Addr, netmask: std::net::Ipv4Addr) -> std::net::Ipv4Addr {
    let a = ip.octets();
    let m = netmask.octets();
    let b = [
        a[0] | (!m[0] & 255),
        a[1] | (!m[1] & 255),
        a[2] | (!m[2] & 255),
        a[3] | (!m[3] & 255),
    ];
    std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3])
}

// 某 IP 所在子网的广播地址；找不到则 255.255.255.255
fn broadcast_for(selected: Option<&str>) -> String {
    let sel = match selected {
        Some(ip) if !ip.is_empty() => ip,
        _ => return "255.255.255.255".to_string(),
    };
    if let Ok(target) = sel.parse::<std::net::Ipv4Addr>() {
        for (_, ip, netmask, bcast) in collect_v4() {
            if ip == target {
                return bcast.unwrap_or_else(|| compute_broadcast(ip, netmask)).to_string();
            }
        }
    }
    "255.255.255.255".to_string()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub host: String,
    pub ip: String,
    pub port: u16,
    pub role: String,
    pub avatar: String,
    pub last_seen: i64,
}

#[derive(Clone, Default, Deserialize)]
pub struct SelfInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub role: String,
}

pub struct Discovery {
    pub self_info: Arc<Mutex<SelfInput>>,
    devices: Arc<Mutex<HashMap<String, Device>>>,
    selected_ip: Arc<Mutex<Option<String>>>,
    running: Arc<AtomicBool>,
    socket: Arc<Mutex<Option<Arc<UdpSocket>>>>,
    started: AtomicBool,
    app: AppHandle,
    // 文件传输路由句柄（与 FileXfer 命令共享同一份状态）；信令 server 收到 file 消息时转交
    file_router: Arc<crate::filexfer::FileInner>,
}

impl Discovery {
    pub fn new(
        app: AppHandle,
        self_info: Arc<Mutex<SelfInput>>,
        file_router: Arc<crate::filexfer::FileInner>,
    ) -> Self {
        Discovery {
            self_info,
            devices: Arc::new(Mutex::new(HashMap::new())),
            selected_ip: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
            socket: Arc::new(Mutex::new(None)),
            started: AtomicBool::new(false),
            app,
            file_router,
        }
    }

    pub fn list(&self) -> Vec<Device> {
        self.devices.lock().unwrap().values().cloned().collect()
    }

    fn emit_devices(&self) {
        let _ = self.app.emit("lan:devices", self.list());
    }

    pub fn start(&self, input: SelfInput) {
        {
            let mut si = self.self_info.lock().unwrap();
            *si = input;
        }
        if self.started.swap(true, Ordering::SeqCst) {
            return; // 已在运行
        }
        self.running.store(true, Ordering::SeqCst);

        // 绑定到 0.0.0.0 以收听所有网卡的广播（宣告目标仍按所选网卡定向）
        match UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) {
            Ok(sock) => {
                let _ = sock.set_broadcast(true);
                let _ = sock.set_read_timeout(Some(Duration::from_millis(800)));
                *self.socket.lock().unwrap() = Some(Arc::new(sock));
            }
            Err(e) => {
                eprintln!("[discovery] 绑定 {DISCOVERY_PORT} 失败：{e}");
            }
        }

        self.spawn_announce();
        self.spawn_recv();
        self.spawn_purge();
        self.spawn_signal_server();
    }

    // ===== 聊天 / 信令传输（TCP 41235，换行分隔 JSON）=====
    // 复刻 electron/signaling.js 的"临时连接发一条"模型：发送方连到目标 IP:41235，
    // 写一行 JSON（带上 from/fromName）后关闭；接收方 server 收下一行即处理。
    // 与 Electron 版的差异：用朴素 TCP 换行分隔，而非 WebSocket（Tauri 版两端都是 Rust，自洽即可）。
    pub fn signal_send(&self, ip: String, mut payload: Value) -> bool {
        let si = self.self_info.lock().unwrap().clone();
        if let Value::Object(ref mut map) = payload {
            map.insert("from".into(), json!(si.id));
            map.insert("fromName".into(), json!(si.name));
        }
        let line = match serde_json::to_string(&payload) {
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

    fn spawn_signal_server(&self) {
        let app = self.app.clone();
        let running = self.running.clone();
        let file_router = self.file_router.clone();
        thread::spawn(move || {
            let listener = match TcpListener::bind(("0.0.0.0", SIGNAL_PORT)) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[signal] 绑定 {SIGNAL_PORT} 失败：{e}");
                    return;
                }
            };
            let _ = listener.set_nonblocking(true);
            for incoming in listener.incoming() {
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                match incoming {
                    Ok(stream) => {
                        let app = app.clone();
                        let file_router = file_router.clone();
                        thread::spawn(move || handle_signal_conn(app, file_router, stream));
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(120));
                    }
                    Err(_) => {}
                }
            }
        });
    }

    fn spawn_announce(&self) {
        let self_info = self.self_info.clone();
        let selected = self.selected_ip.clone();
        let socket = self.socket.clone();
        let running = self.running.clone();
        thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                if let Some(sock) = socket.lock().unwrap().clone() {
                    let si = self_info.lock().unwrap().clone();
                    let sel = selected.lock().unwrap().clone();
                    let role = if si.role.trim().is_empty() {
                        "user".to_string()
                    } else {
                        si.role.clone()
                    };
                    let payload = json!({
                        "type": "hello",
                        "id": si.id,
                        "host": computer_name(),
                        "name": si.name,
                        "port": SIGNAL_PORT,
                        "ip": lan_ip(sel.as_deref()),
                        "role": role,
                        "avatar": si.avatar,
                    });
                    if let Ok(bytes) = serde_json::to_vec(&payload) {
                        let target = broadcast_for(sel.as_deref());
                        let _ = sock.send_to(&bytes, (target.as_str(), DISCOVERY_PORT));
                    }
                }
                thread::sleep(BROADCAST_INTERVAL);
            }
        });
    }

    fn spawn_recv(&self) {
        let app = self.app.clone();
        let devices = self.devices.clone();
        let self_id = self.self_info.lock().unwrap().id.clone();
        let socket = self.socket.clone();
        let running = self.running.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while running.load(Ordering::SeqCst) {
                let sock = match socket.lock().unwrap().clone() {
                    Some(s) => s,
                    None => {
                        thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                };
                match sock.recv_from(&mut buf) {
                    Ok((n, rinfo)) => {
                        if let Ok(data) = serde_json::from_slice::<Value>(&buf[..n]) {
                            let ip = rinfo.ip().to_string();
                            handle_message(&app, &devices, &self_id, &data, &ip);
                        }
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        // 读超时：继续循环以便检查 running
                    }
                    Err(_) => {}
                }
            }
        });
    }

    fn spawn_purge(&self) {
        let app = self.app.clone();
        let devices = self.devices.clone();
        let running = self.running.clone();
        thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                thread::sleep(BROADCAST_INTERVAL);
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let now = now_ms();
                let mut changed = false;
                {
                    let mut map = devices.lock().unwrap();
                    let before = map.len();
                    map.retain(|_, d| now - d.last_seen <= HEARTBEAT_TIMEOUT_MS);
                    if map.len() != before {
                        changed = true;
                    }
                }
                if changed {
                    let list: Vec<Device> = devices.lock().unwrap().values().cloned().collect();
                    let _ = app.emit("lan:devices", list);
                }
            }
        });
    }

    pub fn update_self(&self, name: String, avatar: String) {
        let mut si = self.self_info.lock().unwrap();
        si.name = name;
        si.avatar = avatar;
    }

    // 切换网卡：仅改宣告目标与 IP，清空已发现设备并重推（recv 仍听所有网卡）
    pub fn set_interface(&self, ip: String) -> String {
        let sel = if ip.is_empty() || ip == "auto" {
            None
        } else {
            Some(ip)
        };
        *self.selected_ip.lock().unwrap() = sel.clone();
        self.devices.lock().unwrap().clear();
        self.emit_devices();
        sel.unwrap_or_else(|| "auto".to_string())
    }

    pub fn selected(&self) -> String {
        self.selected_ip
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "auto".to_string())
    }

    pub fn stop(&self) {
        if !self.started.swap(false, Ordering::SeqCst) {
            return;
        }
        self.running.store(false, Ordering::SeqCst);
        // 连发数遍 bye，让对方立刻把自己标为离线
        let si = self.self_info.lock().unwrap().clone();
        let sel = self.selected_ip.lock().unwrap().clone();
        if let Some(sock) = self.socket.lock().unwrap().clone() {
            if let Ok(bytes) = serde_json::to_vec(&json!({ "type": "bye", "id": si.id })) {
                let target = broadcast_for(sel.as_deref());
                for _ in 0..3 {
                    let _ = sock.send_to(&bytes, (target.as_str(), DISCOVERY_PORT));
                    thread::sleep(Duration::from_millis(60));
                }
            }
        }
        *self.socket.lock().unwrap() = None;
    }
}

fn handle_message(
    app: &AppHandle,
    devices: &Arc<Mutex<HashMap<String, Device>>>,
    self_id: &str,
    data: &Value,
    ip: &str,
) {
    let id = match data.get("id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s,
        _ => return,
    };
    if id == self_id {
        return;
    }
    let typ = data.get("type").and_then(|v| v.as_str()).unwrap_or("");

    if typ == "bye" {
        let mut map = devices.lock().unwrap();
        if map.remove(id).is_some() {
            drop(map);
            let list: Vec<Device> = devices.lock().unwrap().values().cloned().collect();
            let _ = app.emit("lan:devices", list);
        }
        return;
    }

    if typ != "hello" {
        return;
    }

    let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let host = data.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let port = data.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    let role = data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("user")
        .to_string();
    let avatar = data.get("avatar").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let mut map = devices.lock().unwrap();
    let mut changed = false;
    match map.get_mut(id) {
        Some(existing) => {
            existing.last_seen = now_ms();
            if existing.ip != ip
                || existing.name != name
                || existing.port != port
                || existing.host != host
                || existing.avatar != avatar
                || existing.role != role
            {
                existing.ip = ip.to_string();
                existing.name = name;
                existing.host = host;
                existing.port = port;
                existing.role = role;
                existing.avatar = avatar;
                changed = true;
            }
        }
        None => {
            map.insert(
                id.to_string(),
                Device {
                    id: id.to_string(),
                    name,
                    host,
                    ip: ip.to_string(),
                    port,
                    role,
                    avatar,
                    last_seen: now_ms(),
                },
            );
            changed = true;
        }
    }
    if changed {
        drop(map);
        let list: Vec<Device> = devices.lock().unwrap().values().cloned().collect();
        let _ = app.emit("lan:devices", list);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceItem {
    pub name: String,
    pub address: String,
    pub netmask: String,
    pub mac: String,
    pub cidr: String,
}

#[derive(Serialize)]
pub struct InterfacesResult {
    pub list: Vec<InterfaceItem>,
    pub selected: String,
}

fn netmask_to_cidr(netmask: std::net::Ipv4Addr) -> u32 {
    netmask.octets().iter().map(|b| b.count_ones()).sum()
}

#[tauri::command]
pub fn interfaces(disc: State<'_, Discovery>) -> InterfacesResult {
    let list = collect_v4()
        .into_iter()
        .map(|(name, ip, netmask, _)| InterfaceItem {
            name,
            address: ip.to_string(),
            netmask: netmask.to_string(),
            mac: String::new(),
            cidr: format!("{}/{}", ip, netmask_to_cidr(netmask)),
        })
        .collect();
    InterfacesResult {
        list,
        selected: disc.selected(),
    }
}

#[tauri::command]
pub fn set_interface(disc: State<'_, Discovery>, ip: String) -> String {
    disc.set_interface(ip)
}

#[tauri::command]
pub fn discovery_start(disc: State<'_, Discovery>, input: SelfInput) {
    disc.start(input)
}

#[tauri::command]
pub fn discovery_list(disc: State<'_, Discovery>) -> Vec<Device> {
    disc.list()
}

#[tauri::command]
pub fn discovery_update_self(disc: State<'_, Discovery>, name: String, avatar: String) {
    disc.update_self(name, avatar)
}

#[tauri::command]
pub fn discovery_stop(disc: State<'_, Discovery>) {
    disc.stop()
}

#[tauri::command]
pub fn signal_send(disc: State<'_, Discovery>, ip: String, payload: Value) -> bool {
    disc.signal_send(ip, payload)
}

// 处理一条入站信令/聊天连接：按行读 JSON，按 type 路由到前端事件。
// 每条消息都会补上 `_from`（对端 IP）——前端（联系人 / 信令 / 广播）依赖它。
fn handle_signal_conn(
    app: AppHandle,
    file_router: Arc<crate::filexfer::FileInner>,
    stream: TcpStream,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    // 大文件分片单条可达 ~32KB，行缓冲给足余量
    let from_ip = stream
        .peer_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = match line {
            Ok(s) => s,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let mut msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Value::Object(ref mut map) = msg {
            map.insert("_from".into(), json!(from_ip));
        }
        let typ = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match typ {
            "chat" => {
                let _ = app.emit("lan:chat", msg);
            }
            "group" => {
                let _ = app.emit("lan:group", msg);
            }
            "signal" => {
                // 信令路由：握手类给广播观看窗口（若开着），其余给主窗口
                if let Some(bs) = app.try_state::<crate::broadcast::BroadcastState>() {
                    bs.route_signal(&msg);
                } else {
                    let _ = app.emit("lan:signal", msg);
                }
            }
            "file" => {
                file_router.handle_msg(&msg, &from_ip);
            }
            _ => {}
        }
    }
}
