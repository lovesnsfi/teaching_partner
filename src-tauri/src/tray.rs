// 系统托盘（Tauri 核心 tray API）+ 退出确认。
//
// · 创建托盘图标 + 菜单（显示主窗口 / 退出）。
// · 标题栏「关闭」按钮 = 最小化到托盘（隐藏主窗口，见 tauri-api.js 的 windowClose）。
// · 托盘「退出」= 经 app:request-quit 事件交给主窗口：若正在广播 / 录制，前端弹确认框，
//   确认后才真正退出（app_quit 会先强制结束录制再 exit）。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::recorder::RecorderState;

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("缺少默认窗口图标");

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("局域网沟通广播")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                // 交给主窗口做退出确认（有活动则弹确认框）
                let _ = app.emit("app:request-quit", ());
            }
            _ => {}
        })
        .build(app)?;

    // 必须 keep alive，否则托盘图标会被销毁
    app.manage(tray);
    Ok(())
}

// 托盘「退出」/ 前端确认后调用：先强制结束录制，再真正退出
#[tauri::command]
pub fn app_quit(app: AppHandle, st: State<RecorderState>) {
    crate::recorder::kill_recording(st);
    app.exit(0);
}

// 托盘「退出」菜单：把决定权交给主窗口（做活动检测 + 确认框）
#[tauri::command]
pub fn app_request_quit(app: AppHandle) {
    let _ = app.emit("app:request-quit", ());
}
