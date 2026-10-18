// 框选截屏：1:1 复刻 electron/main.js 的流程。
//
// 流程：隐藏主窗口 → xcap 抓取鼠标所在显示器整屏（物理像素）→ 全屏透明框选层
//      （?screenshot=1，ScreenShot.vue）→ 用户确认后按选区裁剪（选区是逻辑像素，
//      乘显示器缩放换算成物理像素）、写系统剪贴板、落盘 PNG、回传主窗口。
//
// 与 Electron 版的差异：
//   · 抓屏用 xcap（WGC，失败回退 GDI），不用 desktopCapturer；
//   · 剪贴板用 tauri-plugin-clipboard-manager（Rust 侧写，无前端手势依赖）；
//   · 底图以 PNG dataUrl 传给框选层（与 Electron 一致），选区坐标换算由 Rust 做。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use xcap::Monitor;

pub const SHOT_LABEL: &str = "shot-overlay";
const MAIN_LABEL: &str = "main";

/// 已抓取的整屏图（物理像素 RGBA）+ 换算所需的显示器信息
struct Captured {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    /// 显示器逻辑尺寸（框选层 <img> 的显示尺寸 = 选区坐标空间）
    logical_w: u32,
    logical_h: u32,
    /// 显示器缩放（物理 / 逻辑）
    scale: f32,
    /// 整屏 PNG（缓存，避免每次取底图都重新编码）
    png: Vec<u8>,
}

#[derive(Default)]
pub struct ShotState {
    captured: Arc<Mutex<Option<Captured>>>,
    overlay_label: Arc<Mutex<Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectInput {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotBeginResult {
    pub ok: bool,
    #[serde(default)]
    pub reason: String,
}

impl ShotBeginResult {
    fn err(reason: &str) -> Self {
        ShotBeginResult {
            ok: false,
            reason: reason.to_string(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotImageResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotConfirmResult {
    pub ok: bool,
    #[serde(default)]
    pub reason: String,
    /// 剪贴板是否写入成功（失败时前端可提示用户手动复制）
    #[serde(default)]
    pub clipboard: bool,
}

impl ShotState {
    pub fn new() -> Self {
        ShotState::default()
    }

    fn close_overlay(&self, app: &AppHandle) {
        let label = { self.overlay_label.lock().unwrap().take() };
        if let Some(l) = label {
            if let Some(w) = app.get_webview_window(&l) {
                let _ = w.close();
            }
        }
        self.captured.lock().unwrap().take();
    }

    /// 开始截屏：抓图 + 拉起全屏框选层
    pub async fn begin(&self, app: &AppHandle) -> ShotBeginResult {
        self.close_overlay(app);

        // 1) 鼠标所在显示器（找不到就用主显示器）
        let cursor = app
            .get_webview_window(MAIN_LABEL)
            .and_then(|w| w.cursor_position().ok());
        let monitor = match pick_monitor(cursor) {
            Some(m) => m,
            None => return ShotBeginResult::err("找不到可截取的显示器"),
        };
        let mw = monitor.width().unwrap_or(0);
        let mh = monitor.height().unwrap_or(0);
        if mw == 0 || mh == 0 {
            return ShotBeginResult::err("显示器尺寸异常");
        }
        let scale = monitor.scale_factor().unwrap_or(1.0).max(0.1);
        let logical_w = (mw as f32 / scale).round().max(1.0) as u32;
        let logical_h = (mh as f32 / scale).round().max(1.0) as u32;
        let origin_x = monitor.x().unwrap_or(0);
        let origin_y = monitor.y().unwrap_or(0);

        // 2) 先隐藏主窗口再抓图，否则会把聊天界面一起拍进去
        let main_was_visible = app
            .get_webview_window(MAIN_LABEL)
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false);
        if let Some(w) = app.get_webview_window(MAIN_LABEL) {
            let _ = w.hide();
        }
        // 本命令是 async（跑在 worker 线程），主线程事件循环可正常处理 hide；
        // 这里只阻塞当前 worker，不影响主线程
        std::thread::sleep(Duration::from_millis(260));

        // 3) 抓屏（物理像素）
        let img = match monitor.capture_image() {
            Ok(i) => i,
            Err(e) => {
                restore_main(app, main_was_visible);
                return ShotBeginResult::err(&format!(
                    "当前环境不支持屏幕截取（远程桌面 / 虚拟机常见）：{e}"
                ));
            }
        };
        let width = img.width();
        let height = img.height();

        // 4) 编码 PNG（底图 dataUrl + 后续裁剪都基于它）
        let mut png: Vec<u8> = Vec::new();
        {
            use xcap::image::{codecs::png::PngEncoder, ImageEncoder};
            if let Err(e) =
                PngEncoder::new(&mut png).write_image(
                    img.as_raw(),
                    width,
                    height,
                    xcap::image::ExtendedColorType::Rgba8,
                )
            {
                restore_main(app, main_was_visible);
                return ShotBeginResult::err(&format!("PNG 编码失败：{e}"));
            }
        }

        // 5) 恢复主窗口（不等框选层创建，避免主窗消失太久）
        restore_main(app, main_was_visible);

        // 6) 记录抓取结果
        *self.captured.lock().unwrap() = Some(Captured {
            rgba: img.into_raw(),
            width,
            height,
            logical_w,
            logical_h,
            scale,
            png,
        });

        // 7) 全屏透明框选层（逻辑像素定位 / 尺寸）
        let label_arc = self.overlay_label.clone();
        let win = match WebviewWindowBuilder::new(
            app,
            SHOT_LABEL,
            WebviewUrl::App("index.html?screenshot=1".into()),
        )
        .title("截屏")
        .inner_size(logical_w as f64, logical_h as f64)
        .position((origin_x as f32 / scale) as f64, (origin_y as f32 / scale) as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(true)
        .build()
        {
            Ok(w) => w,
            Err(e) => {
                self.captured.lock().unwrap().take();
                return ShotBeginResult::err(&format!("创建框选层失败：{e}"));
            }
        };
        *self.overlay_label.lock().unwrap() = Some(SHOT_LABEL.to_string());
        // 框选层被直接销毁（如 Alt+F4）时清理状态，避免残留整屏缓冲
        let captured_arc = self.captured.clone();
        win.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                label_arc.lock().unwrap().take();
                captured_arc.lock().unwrap().take();
            }
        });
        ShotBeginResult {
            ok: true,
            reason: String::new(),
        }
    }

    /// 框选层取底图：整屏 PNG dataUrl + 逻辑尺寸
    pub fn image(&self) -> Option<ShotImageResult> {
        let cap = self.captured.lock().unwrap();
        let cap = cap.as_ref()?;
        Some(ShotImageResult {
            data_url: format!("data:image/png;base64,{}", BASE64.encode(&cap.png)),
            width: cap.logical_w,
            height: cap.logical_h,
        })
    }

    /// 确认选区：裁剪 → 写剪贴板 → 落盘 → 回传主窗口 → 关框选层
    pub fn confirm(&self, app: &AppHandle, rect: RectInput) -> ShotConfirmResult {
        let cap = { self.captured.lock().unwrap().take() };
        let cap = match cap {
            Some(c) => c,
            None => {
                return ShotConfirmResult {
                    ok: false,
                    reason: "截图已失效，请重新开始".to_string(),
                    clipboard: false,
                }
            }
        };
        // 选区是逻辑像素，换算成物理像素并夹紧（与 Electron 的 sx/sy 换算同理）
        let scale = cap.scale as f64;
        let x = f2i(rect.x * scale).clamp(0, cap.width as i64 - 1);
        let y = f2i(rect.y * scale).clamp(0, cap.height as i64 - 1);
        let w = f2i(rect.width * scale).clamp(1, cap.width as i64 - x);
        let h = f2i(rect.height * scale).clamp(1, cap.height as i64 - y);
        if w <= 0 || h <= 0 {
            self.close_overlay(app);
            return ShotConfirmResult {
                ok: false,
                reason: "选区无效".to_string(),
                clipboard: false,
            };
        }

        // 裁剪 RGBA 子矩形
        let mut sub = vec![0u8; (w * h * 4) as usize];
        let row_len = (w * 4) as usize;
        for row in 0..h {
            let src = ((y + row) * cap.width as i64 + x) as usize * 4;
            let dst = (row * w) as usize * 4;
            sub[dst..dst + row_len].copy_from_slice(&cap.rgba[src..src + row_len]);
        }

        // PNG 编码
        let mut png: Vec<u8> = Vec::new();
        {
            use xcap::image::{codecs::png::PngEncoder, ImageEncoder};
            if let Err(e) = PngEncoder::new(&mut png).write_image(
                &sub,
                w as u32,
                h as u32,
                xcap::image::ExtendedColorType::Rgba8,
            ) {
                self.close_overlay(app);
                return ShotConfirmResult {
                    ok: false,
                    reason: format!("PNG 编码失败：{e}"),
                    clipboard: false,
                };
            }
        }

        // 落盘（临时目录，供「顺便发送」等功能使用）
        let dir = std::env::temp_dir().join("lan-shot");
        let _ = std::fs::create_dir_all(&dir);
        let name = format!("screenshot-{}.png", now_ms());
        let fp = dir.join(&name);
        let _ = std::fs::write(&fp, &png);

        // 写系统剪贴板（RGBA，arboard 在 Windows 上自行转 BGRA）
        let clip_ok = app
            .clipboard()
            .write_image(&tauri::image::Image::new(
                sub.as_slice(),
                w as u32,
                h as u32,
            ))
            .is_ok();

        // 关框选层并回传主窗口：按需求只放剪贴板，不自动发送
        self.close_overlay(app);
        if let Some(main) = app.get_webview_window(MAIN_LABEL) {
            let _ = main.emit(
                "shot:result",
                json!({
                    "ok": true,
                    "file": {
                        "path": fp.to_string_lossy(),
                        "name": name,
                        "size": png.len(),
                        "mime": "image/png"
                    }
                }),
            );
        }
        ShotConfirmResult {
            ok: true,
            reason: String::new(),
            clipboard: clip_ok,
        }
    }

    /// 取消：关框选层、清状态
    pub fn cancel(&self, app: &AppHandle) {
        self.close_overlay(app);
    }
}

fn f2i(v: f64) -> i64 {
    if !v.is_finite() {
        return 0;
    }
    v.round() as i64
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn restore_main(app: &AppHandle, was_visible: bool) {
    if !was_visible {
        return;
    }
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.show();
    }
}

/// 鼠标所在显示器；cursor 为 None（取不到）时用主显示器
fn pick_monitor(cursor: Option<tauri::PhysicalPosition<f64>>) -> Option<Monitor> {
    if let Some(p) = cursor {
        if let Ok(m) = Monitor::from_point(p.x as i32, p.y as i32) {
            return Some(m);
        }
    }
    Monitor::all().ok().and_then(|list| {
        list.into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| Monitor::all().ok().and_then(|l| l.into_iter().next()))
    })
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn shot_begin(
    st: State<'_, ShotState>,
    app: AppHandle,
) -> Result<ShotBeginResult, String> {
    Ok(st.begin(&app).await)
}

#[tauri::command]
pub fn shot_image(st: State<'_, ShotState>) -> Option<ShotImageResult> {
    st.image()
}

#[tauri::command]
pub fn shot_confirm(
    st: State<'_, ShotState>,
    app: AppHandle,
    rect: RectInput,
) -> ShotConfirmResult {
    st.confirm(&app, rect)
}

#[tauri::command]
pub fn shot_cancel(st: State<'_, ShotState>, app: AppHandle) {
    st.cancel(&app)
}

/// 把本地图片文件复制到系统剪贴板（替代 JS 的 navigator.clipboard.write，
/// WebView2 上更可靠）。支持 png/jpg/gif/bmp/webp。
#[tauri::command]
pub fn image_copy(app: AppHandle, path: String) -> bool {
    if path.is_empty() {
        return false;
    }
    let img = match xcap::image::open(&path) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[shot] 打开图片失败 {path}: {e}");
            return false;
        }
    };
    let rgba = img.to_rgba8();
    app.clipboard()
        .write_image(&tauri::image::Image::new(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
        ))
        .is_ok()
}
