# 局域网沟通广播

一款面向局域网（办公室 / 教室 / 会议室）的桌面沟通工具，集**设备自动发现、即时通讯、文件传输、屏幕广播**于一体。采用 Electron + Vue 3 开发，**无需任何中心服务器**，同一局域网内的机器打开软件即可互相发现并通信。

---

## 一、核心功能

### 即时通讯
- **设备自动发现**：基于 UDP 广播自动发现同一网段的在线同事，实时显示上下线状态
- **单聊**：点对点文字聊天
- **群聊**：任何人都能建群，可拉入当前在线设备；支持退群
- **表情与贴纸**：内置 emoji 表情与贴纸
- **文件传输**：点对点发送文件，带实时进度显示；文件落盘后可一键打开或在文件夹中显示
- **新消息提示音**：可在设置中开关
- **未读消息计数**：会话列表显示未读红点

### 屏幕广播
- **一键开播**：选择「整个屏幕」或某个应用窗口作为画面源
- **Mesh 一对多**：老师端对每个观看学生单独建立一条 WebRTC 连接，复用已有的信令通道，无需流媒体服务器
- **画质可调**：标清（约 854×480 / 800 kbps）、高清（约 1280×720 / 2.5 Mbps）、原画（跟随源分辨率 / 8 Mbps）
- **帧率可调**：15 / 30 / 60 帧每秒
- **热切换**：广播过程中修改画质或帧率，已观看的同事**不会断开**（底层用 `replaceTrack` 换轨，无需重新协商）
- **身份自由**：任何人点「开始广播」即成为老师，点别人的「进入」即成为学生

### 界面与交互
- **无边框窗口**：自绘最小化 / 最大化 / 关闭按钮，蓝色渐变标题栏
- **托盘常驻**：关闭窗口仅最小化到托盘，只有托盘右键菜单的「退出」才真正退出
- **三栏布局**：在线设备 / 聊天区 / 屏幕广播面板
- **Element Plus 界面**：按钮、输入框、下拉框、单选、开关、菜单等统一使用 Element Plus 组件

### 本地持久化
- 聊天消息、群列表、全部设置项（昵称、头像、网卡、提示音、画质、帧率）均保存在本地
- **重启不丢数据**，文件类消息重启后不再显示「发送中 / 接收中」

---

## 二、技术体系

| 层次 | 技术选型 |
|---|---|
| 桌面容器 | Electron 30 |
| 前端框架 | Vue 3（组合式 API） |
| 状态管理 | Pinia |
| 构建工具 | electron-vite 2 + Vite 5 |
| UI 组件 | Element Plus 2.14 + @element-plus/icons-vue |
| 样式方案 | Tailwind CSS 4（@tailwindcss/vite） |
| 屏幕捕获 | Electron `desktopCapturer` + `getUserMedia` |
| 实时音视频 | WebRTC（`RTCPeerConnection`，Mesh 拓扑） |
| 局域网发现 | Node `dgram` UDP 广播 |
| 信令与文件 | Node `ws` WebSocket |
| 本地存储 | SQLite（node-sqlite3-wasm / better-sqlite3），JSON 兜底 |

---

## 三、架构设计

整体为三层、**去中心化**（无服务器），每条 TCP/UDP 通道都跑在各端自己进程内：

```
┌──────────────────────────────────────────────────────────────┐
│                        各客户端对等节点                        │
│                                                              │
│  ┌────────────┐  ┌───────────────┐  ┌─────────────────────┐  │
│  │ UDP 发现层 │  │ WebSocket 层  │  │ WebRTC 媒体层       │  │
│  │ 端口 41234 │  │ 端口 41235    │  │（复用/的信令通道）  │  │
│  │ 上线/离线  │  │ 聊天/群/文件  │  │ 屏幕画面推流        │  │
│  └────────────┘  └───────────────┘  └─────────────────────┘  │
│         │                │                     │             │
│         └────────────────┴─────────────────────┘             │
│                          │                                   │
│                   SQLite / 文件（本地持久化）                 │
└──────────────────────────────────────────────────────────────┘
```

**进程职责**

- **主进程（Node）**：窗口与托盘管理、UDP 发现广播、WebSocket 服务端与客户端、文件分片收发、屏幕源枚举、本地持久化、系统路径调用
- **预加载脚本**：通过 `contextBridge` 向渲染进程暴露受控 API，渲染层不直接访问 Node
- **渲染进程（Vue）**：三栏 UI、Pinia 状态、WebRTC 推拉流

**端到端流程**

1. 启动时向本网段 UDP `41234` 广播自身信息，并监听他人广播 → 得到在线设备列表
2. 每台机器同时在本机 `41235` 端口起一个 WebSocket 服务端，作为聊天 / 群控 / 文件传输的通道
3. 屏幕广播时，WebRTC 的 offer / answer / ICE 信令**复用第 2 步的 WebSocket 通道**转发，因此不需要额外的信令服务器
4. 老师端为每个学生单独建一路 `RTCPeerConnection`，同享一路采集流（Mesh）

---

## 四、目录结构

```
.
├─ electron/                 主进程（CommonJS 产物）
│  ├─ main.js                窗口/托盘/IPC/持久化初始化
│  ├─ lan.js                 UDP 局域网发现、网卡枚举与切换
│  ├─ signaling.js           WebSocket 信令服务端与消息收发
│  ├─ persist.js             本地持久化（SQLite 优先，JSON 兜底）
│  ├─ preload.js             contextBridge 暴露受控 API
│  └─ icon.js                运行时生成托盘图标（免二进制资源）
├─ src/
│  └─ renderer/
│  │  ├─ main.js             Vue 应用入口（注册 Element Plus 与图标）
│  │  ├─ App.vue             标题栏 + 三栏布局
│  │  ├─ style.css           Tailwind 基础样式与 Element Plus 主题对齐
│  │  ├─ webrtc.js           TeacherBroadcaster / StudentReceiver / captureScreen
│  │  ├─ store/              Pinia 状态（含持久化调用）
│  │  ├─ components/         设备列表、聊天、广播、设置、表情、头像等
│  │  ├─ avatars.js  stickers.js
│  │  └─ index.html
├─ assets/sound/message.mp3  新消息提示音
├─ out/                      构建产物（main / preload / renderer）
└─ electron.vite.config.mjs  构建配置
```

---

## 五、快速开始

### 环境要求
- Node.js 18 及以上（建议 20 LTS）
- Windows / macOS / Linux（屏幕采集依赖系统授权）
- **同一局域网**（跨网段互相不可见）

### 安装依赖
```bash
npm install
```

### 开发运行
```bash
npm run dev
```
如需同时验证发现与广播，可在**同一网段的另一台机器**（或同一机器多开实例）重复上述步骤。

### 生产构建
```bash
npm run build        # 产物输出到 out/
npm run preview      # 本地预览构建产物
```

### 打包成安装包
```bash
npm run pack         # 输出到 dist/，Windows 下生成 NSIS 安装包
```
打包配置见 `package.json` 的 `build` 字段：`extraResources` 会把 `assets`（提示音）一并打进安装包，`asarUnpack` 确保 SQLite 的 wasm 文件能被正常读取。

### 防火墙
首次运行请放行以下端口（或允许该应用通过防火墙）：
- **UDP 41234**：设备发现
- **TCP 41235**：聊天 / 群控 / 文件 / 信令

---

## 六、数据存储

数据落在 Electron 的 `userData` 目录（Windows 下通常是 `%APPDATA%\lan-chat-broadcast`）：

| 后端 | 文件 | 说明 |
|---|---|---|
| SQLite（WASM） | `lan-chat.db` | 默认引擎，SQLite 3.53，**无需编译** |
| SQLite（原生） | `lan-chat.db` | 需安装 `better-sqlite3` 并按 Electron ABI 重建，性能更佳 |
| JSON（兜底） | `lan-chat-data.json` | 上述两者均不可用时的降级方案 |

数据表：`kv`（设置项）、`groups`（群）、`messages`（聊天消息，单会话上限 400 条，超出自动删最旧）。

### 为什么默认是 WASM 版 SQLite
原生 `better-sqlite3` 必须与 Electron 的 ABI 匹配（本项目 Electron 30 对应 Node 20，即 ABI 115），而 npm 安装的是按**本机 Node**（22 / ABI 127）编译的版本，直接在 Electron 里加载会报 `NODE_MODULE_VERSION` 不匹配。恢复原生需要：

```bash
npm install better-sqlite3
npm run rebuild          # @electron/rebuild，Windows 需安装 Visual Studio 生成工具
```

代码已按此优先级自动选择：**原生 SQLite → WASM SQLite → JSON**，装好原生版会自动切换，无需改代码。当前开发环境缺少 C++ 工具链，因此默认走免编译的 WASM 方案（同样是以真正的 SQLite 文件存储）。

---

## 七、使用小贴士

- **看不到同事**：确认同一网段、防火墙已放行 UDP 41234；若有多网卡，在「设置 → 通信网卡」中切换并等待约 3 秒重新发现
- **广播卡顿/延迟高**：在「设置 → 屏幕广播」把画质降到「标清」、帧率降到 15；这三档支持广播中热切换
- **采集某个窗口失败**：目标窗口**不能处于最小化状态**且需保持可见；若目标是管理员权限程序，需与本软件权限一致。仍失败可改选「整个屏幕」

---

## 八、开发约定（维护者须知）

1. **Tailwind 4 不支持 `@apply`**，基础样式一律写在 `src/renderer/style.css` 的 `@layer base` 里，其余地方直接写工具类。
2. **Tailwind 的工具类位于 `@layer utilities`，优先级低于未分层的 Element Plus CSS**。因此**不要用 Tailwind 类去覆盖 `el-*` 组件的外观**（如深色标题栏上的按钮配色），应写在组件自己的 `<style scoped>` 中；布局类（`ml-auto`、`flex-1` 等）不受此限制。
3. `style.css` 中针对原生 `button / input / select` 的样式都加了 `:not([class*="el-"])` 排除，避免污染 Element Plus 组件——新增原生表单规则时请保持该约束。
4. **新增 Element Plus 图标**时，必须同步登记到 `src/renderer/main.js` 的图标清单中（图标为按需注册，否则运行时不显示）。
5. 主进程与预加载脚本**必须输出 CommonJS**（`formats: ['cjs']`），`package.json` **不要**加 `"type": "module"`。
6. 含原生代码或 `.wasm` 的依赖要在 `electron.vite.config.mjs` 的 `external` 中登记，否则打包器会尝试内联导致运行失败。

---

## 九、已知限制

- WebRTC 采用 Mesh 拓扑，观看人数较多时上行带宽压力较大（适合一个班级 / 一个办公室规模）
- 不支持跨网段 / 跨互联网（需自行搭建中继或改用 SFU）
- 广播目前不包含系统声音
- 文件传输仅在双方同时在线时完成，不支持离线转发
