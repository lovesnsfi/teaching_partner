# Electron → Tauri 迁移（分支 `tauri_dev`）

本文件记录迁移现状、运行方式与路线图。Electron 原代码在本分支**原样保留**（`electron/`、`electron.vite.config.mjs`、electron 相关脚本），可随时切回 `dev` 分支。

## 架构
- 前端：继续用现有 Vue3 + Element Plus + Tailwind + Pinia（`src/renderer/`，几乎未改）。
- 后端：新增 `src-tauri/`（Tauri v2 + Rust）。能力分两类：能用官方插件在 JS 侧搞定的（设置持久化、self 信息、窗口控制、文件选择、读文件、打开链接、版本号）尽量走插件；需要原生/后台能力的（局域网发现与传输、SQLite、录屏 ffmpeg、广播信令、截屏、自动更新、托盘）以 Rust 命令（`#[tauri::command]`）实现，集中在 `discovery.rs`/`db.rs`/`filexfer.rs`/`broadcast.rs`/`screenshot.rs`/`recorder.rs`/`updater.rs`/`tray.rs`。
- 桥接：`src/renderer/tauri-api.js` 依据 `electron/preload.js` 的契约构建 `window.api`，仅在 Tauri 环境注入（检测 `window.__TAURI_INTERNALS__`）。
- 构建：`vite.config.mjs` 把 `src/renderer` 构建到 `dist/`；`src-tauri/tauri.conf.json` 的 `frontendDist` 指向 `../dist`。

## 已真实实现
- 设置持久化（`tauri-plugin-store`，**重启保留**——即此前"重启丢失"要验证的能力）。
- self 信息（设备 id / 昵称 / 头像，plugin-store；并带动启动 Rust 发现）。
- **局域网发现（Rust `discovery.rs`）**：UDP 41234 广播 hello / 12s 心跳 / 退出 bye，协议与 Electron 版一致；`onDevices`、`getDeviceList`、`getInterfaces`、`setInterface` 已真实化。
- **消息 / 群 / 联系人持久化（Rust `db.rs`，rusqlite）**：复刻 persist.js 表结构；单会话 400 条上限、文件消息重启清理中间态。设置项仍走 plugin-store。
- **聊天 / 群 / 信令传输（Rust TCP 41235，换行分隔 JSON）**：`sendChat`/`sendSignal`→`signal_send`（发送方带 from/fromName，临时连接发一条即关）；服务端按 `type` 路由 `chat→lan:chat`、`group→lan:group`、`signal→lan:signal`；每条入站消息补 `_from`（对端 IP，前端联系人/信令/广播依赖）。与 Electron 版差异：用朴素 TCP 而非 WebSocket（Tauri 版两端均 Rust，自洽）。
- **文件传输（Rust `filexfer.rs`）**：offer/accept/reject/chunk/done/cancel 全协议；24KB base64 分片、发送/接收进度、接收确认/拒绝/取消、图片免确认直传、收齐后落盘「下载/局域网沟通广播」或「另存为」路径；发送进度分母随已确认目标数动态增长。
- **剪贴板图片落盘 / 图片另存为**（Rust，绕开 fs 插件 scope 限制）；`copyImage` 用 WebView2 ClipboardItem（尽力而为）。
- **屏幕广播（Rust `broadcast.rs` + 前端 `webrtc.js` 适配）**：`broadcast_open/broadcast_close` 创建/关闭独立观看窗口（label `broadcast-viewer`，URL 带 `?broadcast=1&tid&tip&tname`，前端 BroadcastWindow.vue 自行完成 request→offer→answer→ice 握手）；信令路由 offer/ice/bye→观看窗口（若开着）、invite/request/leave→主窗口；观看窗被关时回 `lan:broadcast-closed{reason}` 给主窗口。老师端采集：WebView2 无 desktopCapturer，`captureScreen` 在 Tauri 下改走标准 `getDisplayMedia`（系统原生选择器，质量约束用 ideal）。
- 窗口最小化 / 最大化 / 关闭（Tauri 窗口 API）。
- 文件选择（dialog）、读取文件为 data URL（fs）、打开外部链接（opener）、应用版本号。
- 所有 `on*` 事件用 `listen` 注册（接口可用）。

## 已真实实现（续）
- **框选截屏（Rust `screenshot.rs` + xcap + 剪贴板插件）**：`shot_begin` 用 xcap 抓鼠标所在显示器整屏（物理像素，WGC/回退 GDI）→ 隐藏主窗 → 拉起全屏透明无边框框选层（`shot-overlay`，URL `?screenshot=1`，前端 `ScreenShot.vue` 框选）；`shot_image` 回传整屏 PNG dataUrl + 逻辑尺寸；`shot_confirm` 按选区（逻辑像素×缩放换算物理像素）裁剪 → 写系统剪贴板（`tauri-plugin-clipboard-manager`，无前端手势依赖）→ 落盘 `temp/lan-shot` → 经 `shot:result` 事件回传主窗口；`shot_cancel` 关层清状态。适配层 `tauri-api.js` 的 `beginScreenshot/getShotImage/confirmShot/cancelShot` 已接真实命令；另含 `image_copy`（把本地图片文件写剪贴板，替代 WebView2 上不稳的 `navigator.clipboard.write`）。
- **录屏（Rust `recorder.rs` 起 ffmpeg，单遍方案）**：`recorder_start` 枚举设备 → 探测系统声音可用性（volumedetect 短采，不可用则本次不录并告警）→ 起 ffmpeg 抓屏（ddagrab/gdigrab/窗口 title）+ 麦克风(dshow) + 系统声音(wasapi loopback) 双音轨 + 可选摄像头画中画；编码器优先 h264_nvenc（实测通过才用）否则 libx264，直接写 mp4。暂停/继续用分片（首帧强制关键帧），停止时 concat 拼接（流拷贝，失败退回重编码）。`recorder_devices` 枚举设备；`recorder_pause/resume/stop` 控制。`recorder-float` 悬浮控制球窗（`?float=recorder`，248×80 透明无边框，位于右上角）：`recorder_float_open/close/cmd/state/move/move_by/pos/resize`；悬浮球按钮 → `recorder_float_cmd` → Rust 转 `recorder:control` 推主窗（store 驱动状态机）；状态经 `recorder_float_state` 回推悬浮球，系统音量经 `recorder:level` 推回悬浮球波形。主窗销毁时 `kill_recording` 强杀 ffmpeg 防残留。
- **自动更新（Rust `updater.rs` + `tauri-plugin-updater`）**：`updater_check`/`updater_install` 接真实插件并转发 `updater:event`（update-available / download-progress / update-downloaded / error）给既有 `UpdateDialog`；「无更新源 / 未配置签名」时安全降级为 `update-not-available`，不报错。真正分发还需签名私钥 + 更新服务器（见下「已知待办」）。
- **系统托盘 + 退出确认（Rust `tray.rs`）**：核心 tray API 建托盘图标 + 菜单（显示主窗口 / 退出）；标题栏「关闭」= 最小化到托盘（`windowClose` 改 `hide`）；托盘「退出」经 `app:request-quit` 交给主窗，正在广播/录制时弹确认框（App.vue `handleQuitRequest`），确认后 `app_quit` 先强杀录制再 `app.exit`。标题栏加 `data-tauri-drag-region` 实现无边框拖动。

## 迁移期占位（安全桩：返回默认值、不崩溃；后续用 Rust 补齐）
- 提示音效、内置头像列表（`getSound`/`getAvatars`）。
- `openPath`/`openFolder`（现返回 false；文件管理可经 fs 插件按需补）。
- `reportActivity`（现返回 undefined；退出确认已改用 store 状态直接判定，不依赖此上报）。

## 如何运行
1. 装环境（一次性，Windows）：Rust（默认 MSVC 目标）+ VS2022 Build Tools 的"使用 C++ 的桌面开发"负载 + WebView2（Win10/11 一般自带）。
2. 仓库根目录：`npm install`。
3. 开发运行：`npm run tauri:dev`（首次编译 Rust 依赖需几分钟）。
4. 打包：先 `npx tauri icon assets/ico/app.ico` 生成图标到 `src-tauri/icons`，再 `npm run tauri:build`。

## 已知待办 / 注意
- 环境已就绪：Rust 1.99.1(msvc) + MSVC 14.51 + WinSDK 10.0.26100 + WebView2 + Tauri 2.12.4 / tauri-plugin-updater 2.14.0；`cargo build`（src-tauri）与 `npm run build:web` 均已通过，无警告。
- 主窗为无边框（`decorations:false`）：标题栏已加 `data-tauri-drag-region`，可正常拖动。
- **ffmpeg 分发**：Rust 侧 `find_ffmpeg` 依次尝试 `resource_dir/binaries/ffmpeg-<target>.exe` → `ffmpeg.exe` → `bin/ffmpeg.exe` → PATH 上的 `ffmpeg`。开发 / 打包前需把 `ffmpeg.exe` 放到 `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`（并在 `tauri.conf.json` 的 `bundle.externalBin` 登记），或在机器 PATH 上提供 ffmpeg。尚未内置 ffmpeg 二进制。
- **自动更新真正生效需**：① `tauri signer generate` 生成密钥对；② `tauri.conf.json` 的 **`plugins.updater`**（不是 `bundle.updater`——Tauri v2.7+ 已把 updater 配置移到顶层 `plugins`）填 `pubkey` 与 `endpoints`（更新清单地址，如 GitHub Release / 自建）；③ 打包时 `bundle.createUpdaterArtifacts:true` 走 CI 签名。当前 `plugins.updater` 为占位（`pubkey` 填了默认开发公钥、`endpoints: []` 为空），构建通过；未配置有效端点时 `updater_check` 安全降级为 `update-not-available`，界面不报错。
- 权限集中在 `src-tauri/capabilities/default.json`；若运行报某权限缺失，按 Tauri 提示补对应 `allow-*`。
- 录屏已用 Rust 起 ffmpeg，沿用 gdigrab/ddagrab/wasapi/dshow 命令行走势，与 Electron 版采集方式一致。

## 迁移路线图（建议顺序）
1. ~~局域网发现 + 设备列表~~ ✅ 已完成（Rust `discovery.rs`，阻塞 socket + 线程）。
2. ~~聊天 / 信令传输 + 消息 / 群 / 联系人持久化~~ ✅ 已完成（`db.rs` rusqlite + `discovery.rs` 内 TCP 41235 信令；sendChat/sendSignal 已通，chat/group 消息收发可用）。
3. ~~文件传输（发送 / 接收 / 进度 / 取消）~~ ✅ 已完成（`filexfer.rs`：全协议 + 剪贴板图片落盘 + 图片另存为）。← 刚完成
4. ~~屏幕广播（信令走后端；画面采集仍在渲染层）~~ ✅ 已完成（`broadcast.rs`：观看窗口 + 信令路由；`getDisplayMedia` 采集）。
5. ~~框选截屏（xcap 抓屏 + 全屏框选覆盖窗 + 剪贴板）~~ ✅ 已完成（`screenshot.rs`：xcap 抓屏、`shot-overlay` 框选层、裁剪写剪贴板落盘、`shot:result` 回传）。
6. ~~录屏（Rust 起 ffmpeg + 悬浮球窗 + 系统音量电平）~~ ✅ 已完成（`recorder.rs`：ffmpeg 单遍、双音轨、分片暂停/继续、concat 拼接、wasapi 电平；`recorder-float` 悬浮球 + `recorder:control`/`float-state`/`level` 事件链）。
7. ~~自动更新（接线 `tauri-plugin-updater`）~~ ✅ 已接线（`updater.rs`：check/install + `updater:event` 转发；真正分发待签名私钥 + 更新服务器）。
8. ~~托盘 / 退出确认 / 标题栏拖动~~ ✅ 已完成（`tray.rs`：托盘菜单；关闭=最小化到托盘、托盘退出走确认；`App.vue` 加 `data-tauri-drag-region`）。
