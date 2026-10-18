// 录屏模块（Rust 起 ffmpeg，1:1 复刻 electron/recorder.js 的单遍方案）。
//
// 关键能力：
//   · 屏幕用 gdigrab / ddagrab（桌面复制 API，GPU 直采，CPU 极低）；窗口用 gdigrab title=。
//   · 麦克风用 dshow 音频输入，系统声音用 wasapi loopback（比桌面采集器可靠）。
//   · 麦克风 / 系统声音分成两条独立音轨（各编一条 AAC：音轨0=麦克风，音轨1=系统）。
//   · 摄像头（可选）用 dshow 视频设备，overlay 叠到右下角。
//   · 视频只编码一次：优先 h264_nvenc 硬加速（实测通过才用），否则 libx264，直接写 mp4。
//   · 暂停 / 继续：分片录制（每片首帧强制关键帧），停止时 concat 拼接（流拷贝，失败退回重编码）。
//   · 开录前探测系统声音是否真的可用（volumedetect 短采），不可用则本次不录系统声音并告警。
//   · wasapi 电平监测进程（8kHz 单声道 s16le）→ 每 100ms 算 RMS → 经 recorder:level 推给悬浮球。
//
// 悬浮球（?float=recorder 的轻量窗口）通过 recorder:float-state 收状态、recorder:level 收波形；
// 悬浮球按钮 → recorder_float_cmd → Rust 转成 recorder:control 推给主窗口（store 据此驱动状态机）。

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

pub const FLOAT_LABEL: &str = "recorder-float";
const FLOAT_W: f64 = 248.0;
const FLOAT_H: f64 = 80.0;

// ===== 入参（与 electron/preload.js recorder:start 契约一致）=====
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    #[serde(default)]
    pub source: Option<SourceSpec>,
    #[serde(default)]
    pub fps: u32,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub mic: bool,
    #[serde(default)]
    pub mic_device: String,
    #[serde(default)]
    pub system_audio: bool,
    #[serde(default)]
    pub system_device: String,
    #[serde(default)]
    pub camera: bool,
    #[serde(default)]
    pub camera_device: String,
    #[serde(default)]
    pub save_dir: String,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub index: i32,
    #[serde(default)]
    pub title: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub video: Vec<String>,
    pub audio_input: Vec<String>,
    pub audio_loopback: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub ok: bool,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleResult {
    pub ok: bool,
    #[serde(default)]
    pub error: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FloatPos {
    pub x: i32,
    pub y: i32,
}

// ===== 内部可变状态 =====
struct Inner {
    child: Option<Child>,
    level_child: Option<Child>,
    seg_dir: String,
    base_name: String,
    out_path: String,
    tmp_path: String,
    segments: Vec<String>,
    seg_index: i32,
    paused: bool,
    last_opts: Option<RecordOptions>,
    nvenc: bool,
    ddagrab: bool,
    features_checked: bool,
}

pub struct RecorderState {
    inner: Arc<Mutex<Inner>>,
}

impl RecorderState {
    pub fn new() -> Self {
        RecorderState {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                level_child: None,
                seg_dir: String::new(),
                base_name: String::new(),
                out_path: String::new(),
                tmp_path: String::new(),
                segments: Vec::new(),
                seg_index: -1,
                paused: false,
                last_opts: None,
                nvenc: false,
                ddagrab: false,
                features_checked: false,
            })),
        }
    }
}

// ===== ffmpeg 路径解析：优先 sidecar（binaries/ffmpeg-<target>.exe）→ ffmpeg.exe → PATH =====
fn find_ffmpeg(app: &AppHandle) -> String {
    if let Ok(res) = app.path().resource_dir() {
        // externalBin 打包后落在 resources 根目录（保留 target-triple 后缀名）
        let sidecar = res.join("ffmpeg-x86_64-pc-windows-msvc.exe");
        if sidecar.exists() {
            return sidecar.to_string_lossy().to_string();
        }
        // 开发期：src-tauri/binaries/ 下直接放置的二进制
        let dev = res.join("binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
        if dev.exists() {
            return dev.to_string_lossy().to_string();
        }
        let plain = res.join("ffmpeg.exe");
        if plain.exists() {
            return plain.to_string_lossy().to_string();
        }
        let bin = res.join("bin/ffmpeg.exe");
        if bin.exists() {
            return bin.to_string_lossy().to_string();
        }
    }
    // 退回 PATH（开发机若已装 ffmpeg）
    "ffmpeg".to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// 跑一条 ffmpeg 命令，捕获 stderr，超时返回；用于探测（设备/编码器/系统声音）
fn run_capture(ffmpeg: &str, args: &[String], timeout_ms: u64) -> (bool, String) {
    let mut child = match Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return (false, String::new()),
    };
    let mut stderr = String::new();
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let mut buf = [0u8; 1024];
        // 非阻塞式读：超时由外层线程控制，stderr 用 channel 回传（避免跨线程共享可变变量）
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let mut s = String::new();
            loop {
                match e.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if s.len() > 8000 {
                            s = s[s.len() - 8000..].to_string();
                        }
                    }
                }
            }
            let _ = tx.send(s);
        });
        let _ = rx.recv_timeout(Duration::from_millis(timeout_ms));
        let _ = child.kill();
        let _ = child.wait();
        // 等读取线程把 stderr 回传
        if let Ok(s) = rx.recv_timeout(Duration::from_millis(500)) {
            stderr = s;
        }
    }
    (true, stderr)
}

fn check_features(ffmpeg: &str, inner: &mut Inner) {
    if inner.features_checked {
        return;
    }
    inner.features_checked = true;
    let (_, d) = run_capture(
        ffmpeg,
        &["-hide_banner".into(), "-devices".into()],
        8000,
    );
    inner.ddagrab = d.contains("ddagrab");
    let (_, e) = run_capture(
        ffmpeg,
        &["-hide_banner".into(), "-encoders".into()],
        8000,
    );
    inner.nvenc = e.contains("h264_nvenc");
}

// 用一段合成视频试编一帧，验证编码器真能用（ffmpeg -encoders 列出 ≠ 真能用）
fn probe_encoder(ffmpeg: &str, vc: &str, vc_args: &[&str]) -> bool {
    let mut args = vec![
        "-hide_banner".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "color=c=black:s=640x480:d=0.1".into(),
        "-c:v".into(),
        vc.into(),
    ];
    for a in vc_args {
        args.push(a.to_string());
    }
    args.push("-f".into());
    args.push("null".into());
    args.push("-".into());
    let (ok, _) = run_capture(ffmpeg, &args, 15000);
    ok
}

fn pick_encoder(ffmpeg: &str, inner: &Inner) -> (String, Vec<String>) {
    if inner.nvenc {
        // 新版本 ffmpeg 的 NVENC 支持 p1-p7 preset
        let args = ["-preset", "p4", "-rc", "vbr", "-cq", "23"];
        if probe_encoder(ffmpeg, "h264_nvenc", &args) {
            return (
                "h264_nvenc".to_string(),
                args.iter().map(|s| s.to_string()).collect(),
            );
        }
    }
    (
        "libx264".to_string(),
        vec![
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "23".to_string(),
        ],
    )
}

// 枚举设备：视频(dshow) / 麦克风输入(dshow) / 系统声音(wasapi loopback)
fn list_devices(ffmpeg: &str) -> DeviceList {
    let mut dev = DeviceList::default();
    let (_, out) = run_capture(
        ffmpeg,
        &[
            "-hide_banner".into(),
            "-list_devices".into(),
            "true".into(),
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            "dummy".into(),
        ],
        8000,
    );
    let mut section = "";
    for line in out.split('\n') {
        if line.contains("DirectShow video devices") {
            section = "v";
        } else if line.contains("DirectShow audio") {
            section = "a";
        } else {
            let m = regex_quote(line);
            if let Some(name) = m {
                if section == "v" {
                    dev.video.push(name);
                } else if section == "a" {
                    dev.audio_input.push(name);
                }
            }
        }
    }
    let (_, out2) = run_capture(
        ffmpeg,
        &[
            "-hide_banner".into(),
            "-list_devices".into(),
            "true".into(),
            "-f".into(),
            "wasapi".into(),
            "-i".into(),
            "\"\"".into(),
        ],
        8000,
    );
    for line in out2.split('\n') {
        if let Some(name) = regex_quote(line) {
            dev.audio_loopback.push(name);
        }
    }
    // 老版 ffmpeg 没 wasapi：在 dshow 音频设备里找「立体声混音 / Stereo Mix」等
    if dev.audio_loopback.is_empty() {
        let pat = ["混音", "stereo mix", "what u hear", "wave out", "loopback", "speakers"];
        for d in &dev.audio_input {
            let low = d.to_lowercase();
            if pat.iter().any(|p| low.contains(p)) {
                dev.audio_loopback.push(d.clone());
            }
        }
    }
    dev
}

fn regex_quote(line: &str) -> Option<String> {
    let s = line.trim();
    let start = s.find('"')?;
    let rest = &s[start + 1..];
    let end = rest.find('"')?;
    let name = rest[..end].to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

// 解析系统声音设备：优先 wasapi loopback
fn resolve_system(opts: &RecordOptions, devs: &DeviceList) -> Option<(String, bool)> {
    if !opts.system_audio {
        return None;
    }
    let dev = if opts.system_device.is_empty() {
        devs.audio_loopback.first().cloned()
    } else {
        Some(opts.system_device.clone())
    }?;
    let mic_dev = if opts.mic {
        if opts.mic_device.is_empty() {
            devs.audio_input.first().cloned()
        } else {
            Some(opts.mic_device.clone())
        }
    } else {
        None
    };
    if Some(dev.clone()) == mic_dev {
        return None; // 与麦克风同一设备，不重复打开
    }
    let is_dshow = devs.audio_input.iter().any(|d| d == &dev);
    Some((dev, is_dshow))
}

// 探测系统声音是否真能打开 + 有无信号
fn probe_system_audio(ffmpeg: &str, dev: &str, is_dshow: bool) -> (bool, bool, String) {
    let input = if is_dshow {
        vec![
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            format!("audio=\"{dev}\""),
        ]
    } else {
        vec!["-f".into(), "wasapi".into(), "-i".into(), dev.to_string()]
    };
    let mut args = vec!["-hide_banner".into()];
    args.extend(input);
    args.push("-t".into());
    args.push("0.6".into());
    args.push("-af".into());
    args.push("volumedetect".into());
    args.push("-f".into());
    args.push("null".into());
    args.push("-".into());
    let (ok, err) = run_capture(ffmpeg, &args, 8000);
    if !ok {
        return (false, false, "设备打开失败".into());
    }
    let m = err
        .lines()
        .rev()
        .find_map(|l| l.find("max_volume:"))
        .and_then(|_| {
            let s = &err[err.rfind("max_volume:").unwrap()..];
            s.split_whitespace().nth(1).and_then(|v| v.parse::<f64>().ok())
        });
    let max_v = m.unwrap_or(-91.0);
    (true, max_v <= -91.0, String::new())
}

// 真正起一条 ffmpeg 子进程录一个分片
fn begin_segment(ffmpeg: &str, inner: &mut Inner, opts: &RecordOptions) -> Result<(), String> {
    check_features(ffmpeg, inner);
    let fps = if opts.fps == 0 { 30 } else { opts.fps };

    let mut args: Vec<String> = Vec::new();
    // 0: 屏幕 / 窗口
    if let Some(src) = &opts.source {
        if src.r#type == "window" && !src.title.is_empty() {
            args.push("-f".into());
            args.push("gdigrab".into());
            args.push("-framerate".into());
            args.push(fps.to_string());
            args.push("-i".into());
            args.push(format!("title={}", src.title));
        } else if inner.ddagrab {
            let idx = if src.r#type == "screen" && src.index >= 0 {
                src.index
            } else {
                0
            };
            args.push("-f".into());
            args.push("lavfi".into());
            args.push("-i".into());
            args.push(format!("ddagrab=output={idx}:framerate={fps}"));
        } else {
            args.push("-f".into());
            args.push("gdigrab".into());
            args.push("-framerate".into());
            args.push(fps.to_string());
            args.push("-i".into());
            args.push("desktop".into());
        }
    } else if inner.ddagrab {
        args.push("-f".into());
        args.push("lavfi".into());
        args.push("-i".into());
        args.push(format!("ddagrab=output=0:framerate={fps}"));
    } else {
        args.push("-f".into());
        args.push("gdigrab".into());
        args.push("-framerate".into());
        args.push(fps.to_string());
        args.push("-i".into());
        args.push("desktop".into());
    }

    let devs = list_devices(ffmpeg);
    let mut next = 1i32;
    let mut cam_idx = -1i32;

    // 摄像头（可选）
    if opts.camera {
        let dev = if opts.camera_device.is_empty() {
            devs.video.first().cloned()
        } else {
            Some(opts.camera_device.clone())
        };
        if let Some(d) = dev {
            cam_idx = next;
            next += 1;
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-i".into());
            args.push(format!("video=\"{d}\""));
        }
    }

    // 麦克风（可选）
    let mut mic_idx = -1i32;
    if opts.mic {
        let dev = if opts.mic_device.is_empty() {
            devs.audio_input.first().cloned()
        } else {
            Some(opts.mic_device.clone())
        };
        if let Some(d) = dev {
            mic_idx = next;
            next += 1;
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-i".into());
            args.push(format!("audio=\"{d}\""));
        }
    }

    // 系统声音（可选）
    let mut sys_idx = -1i32;
    if let Some((dev, is_dshow)) = resolve_system(opts, &devs) {
        sys_idx = next;
        if is_dshow {
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-i".into());
            args.push(format!("audio=\"{dev}\""));
        } else {
            args.push("-f".into());
            args.push("wasapi".into());
            args.push("-i".into());
            args.push(dev);
        }
    }

    // 滤镜：缩放 + 摄像头画中画
    let mut filters: Vec<String> = Vec::new();
    let mut vlabel = "0:v".to_string();
    if opts.width > 0 && opts.height > 0 {
        filters.push(format!("[{vlabel}]scale={}:{}[sv]", opts.width, opts.height));
        vlabel = "sv".into();
    }
    if cam_idx >= 0 {
        let base_w = if opts.width > 0 { opts.width } else { 1920 };
        let cw = (base_w / 4).max(1);
        filters.push(format!("[{cam_idx}:v]scale={cw}:-1[cam]"));
        filters.push(format!("[{vlabel}][cam]overlay=W-w-16:H-h-16[vout]"));
        vlabel = "vout".into();
    }
    let mut audio_maps: Vec<String> = Vec::new();
    if mic_idx >= 0 {
        audio_maps.push(format!("{mic_idx}:a"));
    }
    if sys_idx >= 0 {
        audio_maps.push(format!("{sys_idx}:a"));
    }
    let has_filter = !filters.is_empty();
    if has_filter {
        args.push("-filter_complex".into());
        args.push(filters.join(";"));
    }
    args.push("-map".into());
    args.push(if has_filter {
        format!("[{vlabel}]")
    } else {
        vlabel.clone()
    });
    for am in &audio_maps {
        args.push("-map".into());
        args.push(am.clone());
    }

    let (vc, vc_args) = pick_encoder(ffmpeg, inner);
    args.push("-c:v".into());
    args.push(vc.clone());
    for a in &vc_args {
        args.push(a.clone());
    }
    args.push("-force_key_frames".into());
    args.push("expr:eq(n,0)".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    if !audio_maps.is_empty() {
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    }
    args.push("-movflags".into());
    args.push("+faststart".into());

    let tmp = PathBuf::from(&inner.seg_dir)
        .join(format!("{}.seg{}.tmp.mp4", inner.base_name, inner.seg_index));
    inner.tmp_path = tmp.to_string_lossy().to_string();
    args.push("-y".into());
    args.push(inner.tmp_path.clone());

    println!("[recorder] ffmpeg command: {ffmpeg} {}", args.join(" "));

    let mut child = Command::new(ffmpeg)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 ffmpeg：{e}"))?;

    // 启动宽限：1.2s 内未异常退出即认为已开始
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let mut s = String::new();
            let mut b = [0u8; 1024];
            loop {
                match e.read(&mut b) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        s.push_str(&String::from_utf8_lossy(&b[..n]));
                        if s.len() > 8000 {
                            s = s[s.len() - 8000..].to_string();
                        }
                    }
                }
            }
            let _ = tx.send(s);
        });
        let status = wait_timeout(&mut child, Duration::from_millis(1200));
        if status.is_some() {
            // 立刻退出即启动失败
            let err = rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
            let _ = child.kill();
            let _ = child.wait();
            return Err(brief(&err, &vc));
        }
        // 否则认为正常，把读取线程留在后台（stderr 不再需要）
        drop(rx);
    }
    inner.child = Some(child);
    Ok(())
}

fn brief(err: &str, vc: &str) -> String {
    let lines: Vec<&str> = err
        .split('\n')
        .filter(|l| !l.trim().is_empty() && !l.contains("configuration:"))
        .collect();
    let tail = if lines.len() > 6 {
        &lines[lines.len() - 6..]
    } else {
        &lines[..]
    };
    format!(
        "ffmpeg 启动失败（编码器 {vc}）：{}",
        tail.join(" | ")
    )
}

// 终止当前分片：写 'q' 优雅退出 → 退出后把 .tmp.mp4 定稿为 finalPath
fn finalize_segment(inner: &mut Inner, final_path: &str) -> bool {
    let mut child = match inner.child.take() {
        Some(c) => c,
        None => return false,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }
    let tmp = inner.tmp_path.clone();
    let fp = final_path.to_string();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let status = child.wait();
        let ok = status.map(|s| s.success() || s.code().is_none()).unwrap_or(false);
        if ok {
            let _ = std::fs::rename(&tmp, &fp);
        }
        let _ = tx.send(ok);
    });
    rx.recv_timeout(Duration::from_secs(20))
        .unwrap_or(false)
}

// 分片拼接：优先流拷贝，失败退回重编码
fn concat_segments(inner: &Inner, ffmpeg: &str) -> SimpleResult {
    let list_path = PathBuf::from(&inner.seg_dir).join(format!("{}.concat.txt", inner.base_name));
    let list = inner
        .segments
        .iter()
        .map(|f| format!("file '{}'", f.replace('\\', "/")))
        .collect::<Vec<_>>()
        .join("\n");
    if std::fs::write(&list_path, list).is_err() {
        return SimpleResult {
            ok: false,
            error: "写入拼接列表失败".into(),
        };
    }
    let run = |extra: &[String]| -> bool {
        let mut args = vec![
            "-hide_banner".into(),
            "-y".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list_path.to_string_lossy().to_string(),
        ];
        args.extend(extra.iter().cloned());
        args.push(inner.out_path.clone());

        let (_, err) = run_capture(ffmpeg, &args, 30000);
        if !err.is_empty() {
            println!("[recorder] 拼接日志：{err}");
        }
        // run_capture 仅返回 (true, stderr)，无法判断是否成功退出；
        // 用文件存在性 + 大小判断更可靠
        std::path::Path::new(&inner.out_path).exists()
            && std::fs::metadata(&inner.out_path).map(|m| m.len()).unwrap_or(0) > 0
    };
    let copy_ok = run(&["-c".into(), "copy".into()]);
    let ok = if copy_ok {
        true
    } else {
        println!("[recorder] 流拷贝拼接失败，退回重新编码拼接");
        run(&[
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "23".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart".into(),
        ])
    };
    let _ = std::fs::remove_file(&list_path);
    SimpleResult {
        ok,
        error: if ok { String::new() } else { "拼接失败".into() },
    }
}

fn cleanup_segments(inner: &mut Inner) {
    for f in &inner.segments {
        let _ = std::fs::remove_file(f);
    }
    if !inner.tmp_path.is_empty() {
        let _ = std::fs::remove_file(&inner.tmp_path);
    }
    inner.segments.clear();
    inner.tmp_path.clear();
    inner.seg_index = -1;
}

// wasapi 电平监测：8kHz 单声道 s16le → 每 100ms 算 RMS → emit recorder:level
// 返回的 child 由调用方存入 inner.level_child，便于停止时清理（避免重复起进程）。
fn launch_level_monitor(app: AppHandle, ffmpeg: &str, dev: &str) -> Option<Child> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-hide_banner",
        "-f",
        "wasapi",
        "-i",
        dev,
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "s16le",
        "pipe:1",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return None,
    };
    emit_to_float(&app, "recorder:level", 0.0_f32);
    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => return None,
    };
    let app2 = app.clone();
    thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 3200];
        let mut recent: Vec<i16> = Vec::with_capacity(800);
        let mut last_emit = SystemTime::now();
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for i in (0..n).step_by(2) {
                        if i + 1 < n {
                            let s = i16::from_le_bytes([buf[i], buf[i + 1]]);
                            recent.push(s);
                            if recent.len() > 800 {
                                recent.drain(0..recent.len() - 800);
                            }
                        }
                    }
                    if last_emit.elapsed().unwrap_or(Duration::MAX) >= Duration::from_millis(100) {
                        last_emit = SystemTime::now();
                        let mut sum = 0.0f64;
                        for &s in &recent {
                            let v = s as f64 / 32768.0;
                            sum += v * v;
                        }
                        let rms = if recent.is_empty() {
                            0.0
                        } else {
                            (sum / recent.len() as f64).sqrt()
                        };
                        let level = (rms * 3.2).min(1.0) as f32;
                        emit_to_float(&app2, "recorder:level", level);
                    }
                }
            }
        }
    });
    Some(child)
}

fn stop_level_monitor(inner: &mut Inner) {
    if let Some(mut c) = inner.level_child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn emit_to_float<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        let _ = w.emit(event, payload);
    }
}

// 把本地时间戳格式化为 录制-YYYYMMDD-HHMMSS
fn stamp() -> String {
    let t = now_ms();
    let secs = t / 1000;
    let (y, mo, d, h, mi, s) = (
        (secs / 31_536_000) + 1970,
        ((secs % 31_536_000) / 2_592_000) + 1,
        ((secs % 2_592_000) / 86400) + 1,
        (secs % 86400) / 3600,
        (secs % 3600) / 60,
        secs % 60,
    );
    let p = |n: i64| format!("{n:02}");
    format!("{}{}{}-{}{}{}", y, p(mo), p(d), p(h), p(mi), p(s))
}

// 等待子进程退出，带超时（轮询 try_wait，避免跨线程持有 Child）
fn wait_timeout(child: &mut Child, timeout: Duration) -> Option<i32> {
    use std::time::Instant;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    return None;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
}

// ===== 命令实现 =====

#[tauri::command]
pub fn recorder_devices(app: AppHandle) -> DeviceList {
    let ffmpeg = find_ffmpeg(&app);
    list_devices(&ffmpeg)
}

#[tauri::command]
pub fn recorder_start(
    st: State<'_, RecorderState>,
    app: AppHandle,
    opts: RecordOptions,
) -> StartResult {
    let ffmpeg = find_ffmpeg(&app);
    let mut inner = st.inner.lock().unwrap();
    if inner.child.is_some() || inner.paused || !inner.segments.is_empty() {
        return StartResult {
            ok: false,
            error: "已有录制在进行中".into(),
            ..Default::default()
        };
    }
    let mut warnings: Vec<String> = Vec::new();
    let mut o = opts;

    // 开录前探测系统声音
    if o.system_audio {
        let devs = list_devices(&ffmpeg);
        if let Some((dev, is_dshow)) = resolve_system(&o, &devs) {
            let (ok, _silent, reason) = probe_system_audio(&ffmpeg, &dev, is_dshow);
            if !ok {
                warnings.push(format!(
                    "系统声音设备不可用（{reason}），本次不录制系统声音。"
                ));
                o.system_audio = false;
            }
        } else {
            warnings.push("未检测到可用的系统声音设备（环流 / 立体声混音），本次不录制系统声音。".into());
            o.system_audio = false;
        }
    }

    // 保存目录
    let home = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    let base_dir = if !o.save_dir.is_empty() && PathBuf::from(&o.save_dir).exists() {
        PathBuf::from(&o.save_dir)
    } else {
        home.join("Videos").join("局域网沟通广播")
    };
    let _ = std::fs::create_dir_all(&base_dir);
    let ts = stamp();
    inner.seg_dir = base_dir.to_string_lossy().to_string();
    inner.base_name = format!("录制-{ts}");
    inner.out_path = base_dir.join(format!("录制-{ts}.mp4")).to_string_lossy().to_string();
    inner.segments.clear();
    inner.seg_index = 0;
    inner.paused = false;
    inner.last_opts = Some(o.clone());

    match begin_segment(&ffmpeg, &mut inner, &o) {
        Ok(()) => {
            // 启动电平监测（wasapi 路径；失败静默跳过）
            if o.system_audio {
                let devs = list_devices(&ffmpeg);
                if let Some((dev, is_dshow)) = resolve_system(&o, &devs) {
                    if !is_dshow {
                        if let Some(c) = launch_level_monitor(app.clone(), &ffmpeg, &dev) {
                            inner.level_child = Some(c);
                        }
                    }
                }
            }
            StartResult {
                ok: true,
                warnings,
                ..Default::default()
            }
        }
        Err(e) => {
            cleanup_segments(&mut inner);
            StartResult {
                ok: false,
                error: e,
                warnings,
                ..Default::default()
            }
        }
    }
}

#[tauri::command]
pub fn recorder_pause(st: State<RecorderState>) -> SimpleResult {
    let mut inner = st.inner.lock().unwrap();
    if inner.child.is_none() || inner.paused {
        return SimpleResult {
            ok: false,
            error: "当前不在录制中".into(),
        };
    }
    inner.paused = true;
    let final_path =
        PathBuf::from(&inner.seg_dir).join(format!("{}.seg{}.mp4", inner.base_name, inner.seg_index));
    if finalize_segment(&mut inner, &final_path.to_string_lossy()) {
        inner.segments.push(final_path.to_string_lossy().to_string());
        SimpleResult {
            ok: true,
            error: String::new(),
        }
    } else {
        inner.paused = false;
        SimpleResult {
            ok: false,
            error: "暂停失败".into(),
        }
    }
}

#[tauri::command]
pub fn recorder_resume(st: State<RecorderState>, app: AppHandle) -> SimpleResult {
    let ffmpeg = find_ffmpeg(&app);
    let mut inner = st.inner.lock().unwrap();
    if !inner.paused {
        return SimpleResult {
            ok: false,
            error: "当前未在暂停状态".into(),
        };
    }
    let opts = match inner.last_opts.clone() {
        Some(o) => o,
        None => return SimpleResult { ok: false, error: "缺少录制参数".into() },
    };
    inner.paused = false;
    inner.seg_index += 1;
    match begin_segment(&ffmpeg, &mut inner, &opts) {
        Ok(()) => SimpleResult {
            ok: true,
            error: String::new(),
        },
        Err(e) => {
            inner.paused = true;
            SimpleResult { ok: false, error: e }
        }
    }
}

#[tauri::command]
pub fn recorder_stop(
    st: State<'_, RecorderState>,
    app: AppHandle,
) -> SimpleResult {
    let ffmpeg = find_ffmpeg(&app);
    let mut inner = st.inner.lock().unwrap();
    if inner.child.is_none() && !inner.paused && inner.segments.is_empty() {
        return SimpleResult {
            ok: false,
            error: "当前没有录制".into(),
        };
    }
    if inner.child.is_some() {
        let final_path = PathBuf::from(&inner.seg_dir)
            .join(format!("{}.seg{}.mp4", inner.base_name, inner.seg_index));
        if finalize_segment(&mut inner, &final_path.to_string_lossy()) {
            inner.segments.push(final_path.to_string_lossy().to_string());
        }
    }
    let result = if inner.segments.is_empty() {
        SimpleResult {
            ok: false,
            error: "没有可保存的录制内容".into(),
        }
    } else if inner.segments.len() == 1 {
        let only = inner.segments[0].clone();
        match std::fs::rename(&only, &inner.out_path) {
            Ok(()) => SimpleResult {
                ok: true,
                error: String::new(),
            },
            Err(e) => SimpleResult {
                ok: false,
                error: format!("{e}"),
            },
        }
    } else {
        concat_segments(&inner, &ffmpeg)
    };
    stop_level_monitor(&mut inner);
    if result.ok {
        cleanup_segments(&mut inner);
    }
    // 重置状态
    inner.segments.clear();
    inner.seg_index = -1;
    inner.paused = false;
    inner.last_opts = None;
    inner.out_path.clear();
    inner.tmp_path.clear();
    result
}

// 强制结束录制（应用退出前调用）：杀掉 ffmpeg，清掉半截文件
pub fn kill_recording(st: State<RecorderState>) {
    let mut inner = st.inner.lock().unwrap();
    if let Some(mut c) = inner.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    stop_level_monitor(&mut inner);
    cleanup_segments(&mut inner);
    inner.paused = false;
    inner.last_opts = None;
    inner.out_path.clear();
}

// ===== 悬浮控制球窗口 + 指令 / 状态中转 =====

#[tauri::command]
pub fn recorder_float_open(st: State<RecorderState>, app: AppHandle) -> SimpleResult {
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return SimpleResult {
            ok: true,
            error: String::new(),
        };
    }
    let mon = app.primary_monitor().ok().flatten();
    let (sx, sy, sw, _sh) = match mon {
        Some(m) => {
            let size = m.size();
            let pos = m.position();
            (pos.x, pos.y, size.width, size.height)
        }
        None => (0, 0, 1920, 1080),
    };
    let x = (sx + sw as i32 - FLOAT_W as i32 - 4).max(sx);
    let y = sy + 4;
    let builder = WebviewWindowBuilder::new(
        &app,
        FLOAT_LABEL,
        WebviewUrl::App("index.html?float=recorder".into()),
    )
    .title("录屏控制")
    .inner_size(FLOAT_W, FLOAT_H)
    .position(x as f64, y as f64)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(true);
    match builder.build() {
        Ok(w) => {
            // 关窗时清理电平
            w.on_window_event({
                let st2 = st.inner.clone();
                move |event| {
                    if matches!(event, WindowEvent::Destroyed) {
                        if let Some(mut g) = st2.lock().ok() {
                            stop_level_monitor(&mut g);
                        }
                    }
                }
            });
            SimpleResult {
                ok: true,
                error: String::new(),
            }
        }
        Err(e) => SimpleResult {
            ok: false,
            error: format!("{e}"),
        },
    }
}

#[tauri::command]
pub fn recorder_float_close(app: AppHandle) -> SimpleResult {
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        let _ = w.close();
    }
    SimpleResult {
        ok: true,
        error: String::new(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatCmd {
    #[serde(default)]
    pub action: String,
}

// 悬浮球按钮 → 转成 recorder:control 推给主窗口（store 据此驱动状态机）
#[tauri::command]
pub fn recorder_float_cmd(app: AppHandle, cmd: FloatCmd) -> SimpleResult {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("recorder:control", serde_json::json!({ "action": cmd.action }));
    }
    SimpleResult {
        ok: true,
        error: String::new(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatState {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub accumulated_ms: i64,
}

// 主窗口 store 调用来推送状态给悬浮球
#[tauri::command]
pub fn recorder_float_state(app: AppHandle, state: FloatState) -> SimpleResult {
    emit_to_float(
        &app,
        "recorder:float-state",
        serde_json::json!({ "state": state.state, "accumulatedMs": state.accumulated_ms }),
    );
    SimpleResult {
        ok: true,
        error: String::new(),
    }
}

// 拖动：渲染层只转发相对位移 dx/dy，主进程在真实位置上累加
#[tauri::command]
pub fn recorder_float_move_by(app: AppHandle, dx: f64, dy: f64) -> SimpleResult {
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        if let Ok(pos) = w.outer_position() {
            let nx = pos.x as f64 + dx;
            let ny = pos.y as f64 + dy;
            let _ = w.set_position(tauri::PhysicalPosition::new(nx as i32, ny as i32));
        }
    }
    SimpleResult {
        ok: true,
        error: String::new(),
    }
}

#[tauri::command]
pub fn recorder_float_move(app: AppHandle, x: i32, y: i32) -> SimpleResult {
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    SimpleResult {
        ok: true,
        error: String::new(),
    }
}

#[tauri::command]
pub fn recorder_float_pos(app: AppHandle) -> FloatPos {
    if let Some(w) = app.get_webview_window(FLOAT_LABEL) {
        if let Ok(pos) = w.outer_position() {
            return FloatPos {
                x: pos.x,
                y: pos.y,
            };
        }
    }
    FloatPos { x: 0, y: 0 }
}

#[tauri::command]
pub fn recorder_float_resize(_app: AppHandle, w: f64, h: f64) -> SimpleResult {
    if let Some(win) = _app.get_webview_window(FLOAT_LABEL) {
        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    }
    SimpleResult {
        ok: true,
        error: String::new(),
    }
}
