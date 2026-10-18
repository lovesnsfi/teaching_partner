// 自动更新（tauri-plugin-updater 接线）。
//
// 说明：真正的更新分发还需要签名私钥 + 更新服务器 / GitHub Release（见 TAURI_MIGRATION.md
// 路线图第 7 步）。本模块把 API 接到真实插件，并在「无更新源 / 未配置签名」时安全降级
// 为 update-not-available，保证界面不报错。后续补上 pubkey + endpoints 即可自动生效。

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> serde_json::Value {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            // 未配置更新源（无 pubkey / endpoints）：静默当作「已是最新」
            app.emit(
                "updater:event",
                serde_json::json!({ "channel": "update-not-available", "data": { "reason": format!("{e}") } }),
            )
            .ok();
            return serde_json::json!({ "available": false });
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let data = serde_json::json!({
                "version": update.version,
                "currentVersion": update.current_version,
                "date": update.date.map(|d| d.to_string()),
                "body": update.body
            });
            app.emit(
                "updater:event",
                serde_json::json!({ "channel": "update-available", "data": data }),
            )
            .ok();
            serde_json::json!({ "available": true, "version": update.version })
        }
        Ok(None) => {
            app.emit(
                "updater:event",
                serde_json::json!({ "channel": "update-not-available", "data": {} }),
            )
            .ok();
            serde_json::json!({ "available": false })
        }
        Err(e) => {
            app.emit(
                "updater:event",
                serde_json::json!({ "channel": "error", "data": { "message": format!("{e}") } }),
            )
            .ok();
            serde_json::json!({ "available": false, "error": format!("{e}") })
        }
    }
}

#[tauri::command]
pub fn updater_install(app: AppHandle) -> serde_json::Value {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return serde_json::json!({ "ok": false, "error": format!("{e}") });
        }
    };
    tauri::async_runtime::spawn(async move {
        if let Ok(Some(update)) = updater.check().await {
            let app2 = app.clone();
            let app3 = app.clone();
            match update
                .download_and_install(
                    move |chunk_length, content_length| {
                        let _ = app2.emit(
                            "updater:event",
                            serde_json::json!({
                                "channel": "download-progress",
                                "data": { "chunk": chunk_length, "total": content_length }
                            }),
                        );
                    },
                    move || {
                        let _ = app3.emit(
                            "updater:event",
                            serde_json::json!({ "channel": "update-downloaded", "data": {} }),
                        );
                    },
                )
                .await
            {
                Ok(()) => {
                    let _ = app.restart();
                }
                Err(e) => {
                    let _ = app.emit(
                        "updater:event",
                        serde_json::json!({ "channel": "error", "data": { "message": format!("{e}") } }),
                    );
                }
            }
        }
    });
    serde_json::json!({ "ok": true })
}
