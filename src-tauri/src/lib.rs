// teaching_partner · Tauri 后端入口
//
// 设计原则（迁移期）：Rust 端尽量"薄"——能力交给 Tauri 官方插件，在 JS 适配层
// （src/renderer/tauri-api.js）里调用；Rust 只负责装配插件、窗口与需要原生的模块。
// 后续需要原生能力时（局域网发现/传输、录屏、广播信令、截屏、自动更新等），
// 再按模块逐步把对应逻辑以 Rust 命令 / 后台任务的形式补进来。

mod db;
mod discovery;
mod filexfer;
mod broadcast;
mod screenshot;
mod recorder;
mod updater;
mod tray;

use std::sync::{Arc, Mutex};

use discovery::SelfInput;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 本地 SQLite（群 / 消息 / 联系人）
            match app.path().app_config_dir() {
                Ok(dir) => {
                    let db_path = dir.join("lan-chat.db");
                    match db::open(&db_path) {
                        Ok(state) => {
                            app.manage(state);
                            println!("[db] 已打开 {db_path:?}");
                        }
                        Err(e) => eprintln!("[db] 打开失败 {db_path:?}: {e}"),
                    }
                }
                Err(e) => eprintln!("[db] 取 app_config_dir 失败: {e}"),
            }

            // 局域网：文件传输状态 + 发现状态（共享同一份 self_info）
            let self_info = Arc::new(Mutex::new(SelfInput::default()));
            let file_router =
                Arc::new(filexfer::FileInner::new(app.handle().clone(), self_info.clone()));
            app.manage(file_router.clone());
            app.manage(discovery::Discovery::new(
                app.handle().clone(),
                self_info,
                file_router,
            ));

            // 屏幕广播：观看窗口管理 + 信令路由
            app.manage(broadcast::BroadcastState::new(app.handle().clone()));

            // 框选截屏状态（抓取的整屏图 + 框选层 label）
            app.manage(screenshot::ShotState::new());

            // 录屏状态（ffmpeg 子进程 + 分片 + 电平监测进程）
            app.manage(recorder::RecorderState::new());

            // 主窗口销毁时强制结束录制，避免 ffmpeg 残留占用磁盘
            if let Some(main) = app.get_webview_window("main") {
                let apph = app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        recorder::kill_recording(apph.state::<recorder::RecorderState>());
                    }
                });
            }

            // 系统托盘（图标 + 菜单：显示主窗口 / 退出）
            if let Err(e) = tray::setup_tray(app.handle()) {
                eprintln!("[tray] 初始化失败：{e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 持久化（SQLite）
            db::db_load_domain,
            db::db_replace_groups,
            db::db_replace_contacts,
            db::db_append_message,
            db::db_update_message,
            db::db_delete_messages,
            // 局域网发现 + 信令传输
            discovery::interfaces,
            discovery::set_interface,
            discovery::discovery_start,
            discovery::discovery_list,
            discovery::discovery_update_self,
            discovery::discovery_stop,
            discovery::signal_send,
            // 文件传输
            filexfer::file_send,
            filexfer::file_accept,
            filexfer::file_reject,
            filexfer::file_cancel_receive,
            filexfer::clipboard_image_save,
            filexfer::image_save_as,
            // 屏幕广播
            broadcast::broadcast_open,
            broadcast::broadcast_close,
            // 框选截屏
            screenshot::shot_begin,
            screenshot::shot_image,
            screenshot::shot_confirm,
            screenshot::shot_cancel,
            screenshot::image_copy,
            // 录屏
            recorder::recorder_devices,
            recorder::recorder_start,
            recorder::recorder_stop,
            recorder::recorder_pause,
            recorder::recorder_resume,
            recorder::recorder_float_open,
            recorder::recorder_float_close,
            recorder::recorder_float_cmd,
            recorder::recorder_float_state,
            recorder::recorder_float_move_by,
            recorder::recorder_float_pos,
            recorder::recorder_float_resize,
            recorder::recorder_float_move,
            // 自动更新（tauri-plugin-updater）
            updater::updater_check,
            updater::updater_install,
            // 托盘 / 退出确认
            tray::app_quit,
            tray::app_request_quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
