// 屏幕广播：复刻 electron/main.js 的观看窗口管理与信令路由。
//
// 流程（与 Electron 版一致）：
//   · 学生端主窗口调 broadcast_open(info) → 创建独立观看窗口
//     （index.html?broadcast=1&tid&tip&tname），由 BroadcastWindow.vue
//     自行完成「request → offer → answer → ice」的 WebRTC 握手；
//   · 信令路由：握手类（offer/ice/bye）发给观看窗口（若开着），
//     其余（invite/request/leave）始终发给主窗口；
//   · 观看窗口被关（用户点 X 或调 broadcast_close）→ 通知主窗口
//     lan:broadcast-closed{reason}，区分「学生自己关窗」与「老师停播」。
//
// 与 Electron 版的差异：老师端采集不走 desktopCapturer（WebView2 无此扩展），
// 改用标准 getDisplayMedia（系统原生选择器），见 renderer/webrtc.js captureScreen。

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// 观看窗口的固定 label（capabilities 里按此 label 授权）
pub const VIEWER_LABEL: &str = "broadcast-viewer";
const MAIN_LABEL: &str = "main";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub ip: String,
    #[serde(default)]
    pub name: String,
}

/// 观看窗口状态：记录当前开着的观看窗口 label（None 表示未开）。
pub struct BroadcastState {
    app: AppHandle,
    viewer_label: Arc<Mutex<Option<String>>>,
}

impl BroadcastState {
    pub fn new(app: AppHandle) -> Self {
        BroadcastState {
            app,
            viewer_label: Arc::new(Mutex::new(None)),
        }
    }

    /// 打开观看窗口；已开则仅显示并聚焦（与 Electron 一致）
    pub fn open(&self, info: BroadcastInfo) -> bool {
        {
            let guard = self.viewer_label.lock().unwrap();
            if let Some(label) = guard.as_ref() {
                if let Some(w) = self.app.get_webview_window(label) {
                    let _ = w.show();
                    let _ = w.set_focus();
                    return true;
                }
            }
        }
        // 通过 query 把老师信息带进渲染层（前端 BroadcastWindow.vue 读 location.search）
        let url = format!(
            "index.html?broadcast=1&tid={}&tip={}&tname={}",
            qenc(&info.id),
            qenc(&info.ip),
            qenc(&info.name)
        );
        let title = if info.name.trim().is_empty() {
            "屏幕广播".to_string()
        } else {
            format!("{} 的屏幕广播", info.name)
        };
        let viewer_label = self.viewer_label.clone();
        let app_for_hook = self.app.clone();
        let win = match WebviewWindowBuilder::new(
            &self.app,
            VIEWER_LABEL,
            WebviewUrl::App(url.into()),
        )
        .title(title)
        .inner_size(1280.0, 740.0)
        .min_inner_size(640.0, 420.0)
        .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[broadcast] 创建观看窗口失败：{e}");
                return false;
            }
        };
        *self.viewer_label.lock().unwrap() = Some(VIEWER_LABEL.to_string());
        // 用户点 X 关闭时：清理 label 并通知主窗口（broadcast_close 主动关窗时
        // label 已被 take，不会重复通知）。该闭包只带事件不带窗口，故把 AppHandle 捕获进来。
        win.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let mut guard = viewer_label.lock().unwrap();
                if guard.take().is_some() {
                    drop(guard);
                    if let Some(main) = app_for_hook.get_webview_window(MAIN_LABEL) {
                        let _ = main.emit(
                            "lan:broadcast-closed",
                            json!({ "reason": "closed" }),
                        );
                    }
                }
            }
        });
        true
    }

    /// 关闭观看窗口并同步状态给主窗口。
    /// reason: 'closed'（学生手动关窗，默认） | 'teacher-stopped'（老师停播） | 'leave'（主动离开）
    pub fn close(&self, reason: &str) {
        let label = { self.viewer_label.lock().unwrap().take() };
        if let Some(l) = label {
            if let Some(w) = self.app.get_webview_window(&l) {
                let _ = w.close();
            }
        }
        // 窗口已不存在也要同步，否则主窗口会一直以为窗口还开着
        if let Some(main) = self.app.get_webview_window(MAIN_LABEL) {
            let _ = main.emit(
                "lan:broadcast-closed",
                json!({ "reason": if reason.is_empty() { "closed" } else { reason } }),
            );
        } else {
            let _ = self.app.emit(
                "lan:broadcast-closed",
                json!({ "reason": if reason.is_empty() { "closed" } else { reason } }),
            );
        }
    }

    /// 信令路由：offer/ice/bye 给观看窗口（若开着），其余给主窗口。
    /// 无观看窗时一切回落主窗口（老师端 / 学生未开窗时由主窗口处理）。
    pub fn route_signal(&self, msg: &Value) {
        let kind = msg
            .pointer("/payload/kind")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if matches!(kind, "offer" | "ice" | "bye") {
            let label = self.viewer_label.lock().unwrap().clone();
            if let Some(l) = label {
                if let Some(w) = self.app.get_webview_window(&l) {
                    let _ = w.emit("lan:signal", msg.clone());
                    return;
                }
            }
        }
        if let Some(main) = self.app.get_webview_window(MAIN_LABEL) {
            let _ = main.emit("lan:signal", msg.clone());
        } else {
            let _ = self.app.emit("lan:signal", msg.clone());
        }
    }
}

/// query 参数百分号编码（名称可能含空格 / 中文 / 特殊字符）
fn qenc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ===== Tauri 命令 =====

#[tauri::command]
pub fn broadcast_open(bs: State<'_, BroadcastState>, info: BroadcastInfo) -> bool {
    bs.open(info)
}

#[tauri::command]
pub fn broadcast_close(bs: State<'_, BroadcastState>, reason: Option<String>) {
    bs.close(reason.as_deref().unwrap_or("closed"))
}
