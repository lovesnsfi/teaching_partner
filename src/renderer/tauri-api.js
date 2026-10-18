// ===== window.api 适配层（Electron → Tauri）=====
//
// 目的：让现有 Vue 前端里大量 window.api.xxx 调用，在 Tauri 环境下继续可用。
// 只在 Tauri 环境注入（检测 window.__TAURI_INTERNALS__）；Electron 环境下由 preload 提供，这里不动。
//
// 迁移策略：
//   · 能用 Tauri 插件在 JS 侧搞定的（设置持久化、self 信息、窗口控制、文件选择、
//     读取文件、版本号等）→ 直接真实实现；
//   · 需要原生/后台能力的（局域网发现与传输、录屏、广播信令、截屏、自动更新等）
//     → 先做"安全桩"：返回合理默认值、不抛异常，保证界面能加载；后续按模块用 Rust 补齐。
//
// 契约来源：electron/preload.js（本分支保留作对照）。

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getVersion } from '@tauri-apps/api/app'
import { Store } from '@tauri-apps/plugin-store'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { openUrl } from '@tauri-apps/plugin-opener'

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// 迁移期占位：打一次警告并返回安全默认值，避免界面因缺方法崩溃
const _warned = new Set()
function todo(name, ret) {
  return (...args) => {
    if (!_warned.has(name)) {
      _warned.add(name)
      console.warn(`[tauri-api] "${name}" 尚未迁移到 Tauri，返回占位值`, args)
    }
    return typeof ret === 'function' ? ret(...args) : ret
  }
}

// ---- plugin-store（设置 / self 信息持久化）----
let _store = null
async function store() {
  if (!_store) _store = await Store.load('app.dat')
  return _store
}

function rid() {
  try {
    if (crypto && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    /* ignore */
  }
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// ---- 局域网发现：把 self 带给 Rust 启动；昵称/头像变更时同步过去 ----
let _discoveryStarted = false
function ensureDiscovery(id, name, avatar) {
  if (_discoveryStarted || !id) return
  _discoveryStarted = true
  invoke('discovery_start', { id, name, avatar, role: 'user' }).catch((e) =>
    console.warn('[tauri-api] discovery_start 失败', e)
  )
}
async function pushSelf(s) {
  try {
    const name = (await s.get('selfName')) || ''
    const avatar = (await s.get('selfAvatar')) || ''
    await invoke('discovery_update_self', { name, avatar })
  } catch {
    /* ignore */
  }
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav'
}
function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''))
  return m ? m[1].toLowerCase() : ''
}
function bytesToDataUrl(bytes, mime) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(bin)}`
}
function baseName(p) {
  const s = String(p || '').replace(/\\/g, '/')
  return s.slice(s.lastIndexOf('/') + 1)
}

if (isTauri()) {
  const win = () => getCurrentWindow()

  window.api = {
    // ---- self 信息（plugin-store 持久化；并带动启动 Rust 侧发现）----
    getSelf: async () => {
      const s = await store()
      let id = await s.get('selfId')
      if (!id) {
        id = rid()
        await s.set('selfId', id)
      }
      const name = (await s.get('selfName')) || '我'
      const avatar = (await s.get('selfAvatar')) || ''
      ensureDiscovery(id, name, avatar)
      return { id, name, avatar, ip: '', host: '' }
    },
    setName: async (name) => {
      const s = await store()
      await s.set('selfName', name || '')
      pushSelf(s)
      return true
    },
    setAvatar: async (avatar) => {
      const s = await store()
      await s.set('selfAvatar', avatar || '')
      pushSelf(s)
      return true
    },

    // ---- 内置资源（迁移期占位：暂不发音效 / 不给内置头像）----
    getSound: todo('getSound', ''),
    getAvatars: todo('getAvatars', []),

    // ---- 持久化：设置项走 plugin-store；群/消息/联系人走 Rust SQLite ----
    dbLoad: async () => {
      const s = await store()
      let domain = { groups: [], messages: {}, contacts: [] }
      try {
        domain = (await invoke('db_load_domain')) || domain
      } catch (e) {
        console.warn('[tauri-api] db_load_domain 失败', e)
      }
      return {
        settings: (await s.get('settings')) || {},
        groups: domain.groups || [],
        messages: domain.messages || {},
        contacts: domain.contacts || []
      }
    },
    dbSaveSettings: async (obj) => {
      const s = await store()
      await s.set('settings', obj || {})
      return true
    },
    dbReplaceGroups: (groups) => invoke('db_replace_groups', { groups }),
    dbReplaceContacts: (list) => invoke('db_replace_contacts', { list }),
    dbAppendMessage: (m) => invoke('db_append_message', { m }),
    dbUpdateMessage: (p) => invoke('db_update_message', { p }),
    dbDeleteMessages: (convId) =>
      invoke('db_delete_messages', { conv_id: String(convId) }),

    // ---- 网卡（Rust：列出非回环 IPv4 + 当前选择）----
    getInterfaces: () => invoke('interfaces'),
    setInterface: async (ip) => {
      const s = await store()
      await s.set('selectedInterface', ip || 'auto')
      try {
        return await invoke('set_interface', { ip: ip || 'auto' })
      } catch (e) {
        console.warn('[tauri-api] set_interface 失败', e)
        return ip || 'auto'
      }
    },
    // 广播选源：见下方「屏幕广播」节的 getSources（WebView2 无 desktopCapturer）

    // ---- 窗口控制（Tauri 窗口 API）----
    windowMinimize: () => win().minimize(),
    windowMaximize: async () => {
      const w = win()
      if (await w.isMaximized()) await w.unmaximize()
      else await w.maximize()
    },
    // 标题栏「关闭」= 最小化到托盘（应用继续在后台运行，托盘图标可再次唤起）
    windowClose: () => win().hide(),

    // ---- 文件选择（dialog 插件）----
    pickFile: async () => {
      const r = await openDialog({ multiple: true })
      if (!r) return []
      const arr = Array.isArray(r) ? r : [r]
      return arr.map((p) => ({ path: p, name: baseName(p), size: 0, mime: '' }))
    },
    pickImage: async () => {
      const r = await openDialog({
        multiple: true,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
      })
      if (!r) return []
      const arr = Array.isArray(r) ? r : [r]
      return arr.map((p) => ({ path: p, name: baseName(p), size: 0, mime: MIME[extOf(p)] || '' }))
    },
    pickFolder: async () => {
      const r = await openDialog({ directory: true })
      return typeof r === 'string' ? r : ''
    },

    // ---- 读取本地文件为 data URI（供 <img> 显示；fs 插件，限应用目录内）----
    getFileDataUrl: async (p) => {
      try {
        const bytes = await readFile(p)
        return bytesToDataUrl(bytes, MIME[extOf(p)] || 'application/octet-stream')
      } catch (e) {
        console.warn('[tauri-api] getFileDataUrl 失败', p, e)
        return ''
      }
    },

    // ---- 打开外部链接（opener 插件；失败不抛）----
    openExternal: async (url) => {
      try {
        await openUrl(url)
        return true
      } catch (e) {
        console.warn('[tauri-api] openExternal 失败', url, e)
        return false
      }
    },
    openPath: todo('openPath', false),
    openFolder: todo('openFolder', false),

    // ---- 剪贴板 / 图片保存（Rust：临时目录落盘 / 另存为复制）----
    // 走 Rust 而非 JS fs 插件：临时/下载等目录不在 fs 插件默认 scope 内
    saveClipboardImage: (dataUrl, mime) =>
      invoke('clipboard_image_save', { dataUrl, mime }).catch((e) => {
        console.warn('[tauri-api] clipboard_image_save 失败', e)
        return null
      }),
    // 复制图片到系统剪贴板（WebView2 支持 ClipboardItem 图片；不支持时返回 false）
    copyImage: async (p) => {
      try {
        if (!p || typeof ClipboardItem === 'undefined') return false
        const bytes = await readFile(p)
        const mime = MIME[extOf(p)] || 'image/png'
        const blob = new Blob([bytes], { type: mime })
        await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
        return true
      } catch (e) {
        console.warn('[tauri-api] copyImage 失败', p, e)
        return false
      }
    },
    saveImageAs: async ({ path: src, name } = {}) => {
      try {
        if (!src) return { ok: false }
        return await invoke('image_save_as', { src, name })
      } catch (e) {
        console.warn('[tauri-api] image_save_as 失败', e)
        return { ok: false }
      }
    },

    // ---- 版本 / 自动更新（tauri-plugin-updater）----
    getAppVersion: async () => {
      try {
        return await getVersion()
      } catch {
        return '0.0.0'
      }
    },
    checkForUpdates: () =>
      invoke('updater_check').catch(() => ({ available: false })),
    quitAndInstall: () => invoke('updater_install').catch(() => ({ ok: false })),

    // ---- 活动上报 + 退出确认（托盘「退出」走确认流程）----
    reportActivity: todo('reportActivity', undefined),
    // 托盘「退出」菜单 / 标题栏关闭：向主窗口请求退出（由 store 决定是否需要确认）
    requestQuit: () => invoke('app_request_quit').catch(() => {}),
    // 退出确认通过后真正退出（先强制结束录制）
    appQuit: () => invoke('app_quit').catch(() => {}),
    onRequestQuit: (cb) =>
      listen('app:request-quit', (e) => cb(e.payload)),

    // ---- 局域网：设备列表（Rust 发现）；事件 onDevices 已监听 'lan:devices' ----
    getDeviceList: () => invoke('discovery_list'),
    sendChat: (ip, payload) => invoke('signal_send', { ip, payload }),
    sendSignal: (ip, payload) =>
      invoke('signal_send', { ip, payload: { type: 'signal', ...(payload || {}) } }),
    // ---- 局域网：文件传输（Rust filexfer：offer/accept/reject/chunk/cancel）----
    sendFile: (spec) => invoke('file_send', { spec }),
    acceptFile: async ({ fileId, saveAs } = {}) => {
      try {
        return await invoke('file_accept', { fileId, saveAs: !!saveAs })
      } catch (e) {
        console.warn('[tauri-api] file_accept 失败', e)
        return { ok: false, error: String((e && e.message) || e) }
      }
    },
    rejectFile: (fileId) => invoke('file_reject', { fileId }),
    cancelReceive: (fileId) => invoke('file_cancel_receive', { fileId }),

    // ---- 录屏（Rust 起 ffmpeg：recorder.rs 管理子进程 / 分片 / 电平）----
    // 流程：recorderStart 起 ffmpeg 抓屏+双音轨 → 拉起 recorder-float 悬浮球窗；
    // 悬浮球按钮 → recorder_float_cmd → Rust 转 recorder:control 推主窗（store 驱动状态机）；
    // 状态经 recorder_float_state 推回悬浮球，系统音量经 recorder:level 推回悬浮球波形。
    recorderDevices: () =>
      invoke('recorder_devices').catch(() => ({
        video: [],
        audioInput: [],
        audioLoopback: []
      })),
    recorderStart: (opts) =>
      invoke('recorder_start', { opts: opts || {} }).catch((e) => ({
        ok: false,
        error: String((e && e.message) || e)
      })),
    recorderStop: () =>
      invoke('recorder_stop').catch((e) => ({
        ok: false,
        error: String((e && e.message) || e)
      })),
    recorderPause: () =>
      invoke('recorder_pause').catch((e) => ({
        ok: false,
        error: String((e && e.message) || e)
      })),
    recorderResume: () =>
      invoke('recorder_resume').catch((e) => ({
        ok: false,
        error: String((e && e.message) || e)
      })),
    recorderFloatOpen: () => invoke('recorder_float_open').catch(() => ({ ok: true })),
    recorderFloatClose: () => invoke('recorder_float_close').catch(() => ({ ok: true })),
    recorderFloatCmd: (cmd) =>
      invoke('recorder_float_cmd', { cmd: cmd || {} }).catch(() => ({ ok: true })),
    recorderFloatState: (state) =>
      invoke('recorder_float_state', { state: state || {} }).catch(() => ({ ok: true })),
    recorderFloatMove: (x, y) =>
      invoke('recorder_float_move', { x, y }).catch(() => ({ ok: true })),
    recorderFloatMoveBy: (dx, dy) =>
      invoke('recorder_float_move_by', { dx, dy }).catch(() => ({ ok: true })),
    recorderFloatPos: () => invoke('recorder_float_pos').catch(() => ({ x: 0, y: 0 })),
    recorderFloatResize: (w, h) =>
      invoke('recorder_float_resize', { w, h }).catch(() => ({ ok: true })),

    // ---- 屏幕广播（Rust：观看窗口创建/关闭 + 信令路由）----
    openBroadcastWindow: (info) =>
      invoke('broadcast_open', { info: info || {} }).catch((e) => {
        console.warn('[tauri-api] broadcast_open 失败', e)
        return false
      }),
    closeBroadcastWindow: (reason) =>
      invoke('broadcast_close', { reason: reason || 'closed' }).catch(() => {}),
    // 老师端选源：WebView2 没有 desktopCapturer，改用标准 getDisplayMedia
    // （点「开始广播」时弹系统原生选择器）。这里给一个占位源，
    // id 以 'screen' 开头以兼容前端自动选择逻辑（见 BroadcastView.vue）。
    getSources: async () => [
      { id: 'screen:0', name: '屏幕 / 应用窗口（开始广播时由系统选择器选择）' }
    ],

    // ---- 框选截屏（Rust：shot_begin / shot_image / shot_confirm / shot_cancel）----
    // 流程：beginScreenshot 抓屏并拉起全屏框选层（?screenshot=1 的轻量窗口）；
    // 框选层 onMounted 时调 getShotImage 取底图；确认/取消分别走 confirmShot/cancelShot。
    // 选区确认后 Rust 裁剪→写剪贴板→落盘，并经 'shot:result' 事件回传主窗口。
    beginScreenshot: () =>
      invoke('shot_begin').catch((e) => {
        console.warn('[tauri-api] shot_begin 失败', e)
        return { ok: false, reason: String((e && e.message) || e) }
      }),
    getShotImage: () => invoke('shot_image').catch(() => null),
    confirmShot: (rect) =>
      invoke('shot_confirm', { rect: rect || {} }).catch((e) => {
        console.warn('[tauri-api] shot_confirm 失败', e)
        return { ok: false, reason: String((e && e.message) || e) }
      }),
    cancelShot: () =>
      invoke('shot_cancel').catch((e) => {
        console.warn('[tauri-api] shot_cancel 失败', e)
        return { ok: false, reason: String((e && e.message) || e) }
      }),

    // ---- 事件订阅：用 listen 注册（迁移期这些事件不会触发，但接口保持可用）----
    onDevices: (cb) => listen('lan:devices', (e) => cb(e.payload)),
    onChat: (cb) => listen('lan:chat', (e) => cb(e.payload)),
    onSignal: (cb) => listen('lan:signal', (e) => cb(e.payload)),
    onGroup: (cb) => listen('lan:group', (e) => cb(e.payload)),
    onFileOffer: (cb) => listen('lan:file-offer', (e) => cb(e.payload)),
    onFileIncoming: (cb) => listen('lan:file-incoming', (e) => cb(e.payload)),
    onFileProgress: (cb) => listen('lan:file-progress', (e) => cb(e.payload)),
    onFileDone: (cb) => listen('lan:file-done', (e) => cb(e.payload)),
    onFileRejected: (cb) => listen('lan:file-rejected', (e) => cb(e.payload)),
    onFileSendStart: (cb) => listen('lan:file-send-start', (e) => cb(e.payload)),
    onFileSendProgress: (cb) => listen('lan:file-send-progress', (e) => cb(e.payload)),
    onFileSendDone: (cb) => listen('lan:file-send-done', (e) => cb(e.payload)),
    onFileCancelled: (cb) => listen('lan:file-cancelled', (e) => cb(e.payload)),
    onShotResult: (cb) => listen('shot:result', (e) => cb(e.payload)),
    onBroadcastClosed: (cb) => listen('lan:broadcast-closed', (e) => cb(e.payload || {})),
    onUpdateEvent: (cb) => listen('updater:event', (e) => cb(e.payload)),
    onRecorderControl: (cb) => listen('recorder:control', (e) => cb(e.payload || {})),
    onFloatState: (cb) => listen('recorder:float-state', (e) => cb(e.payload || {})),
    onRecorderLevel: (cb) => listen('recorder:level', (e) => cb(e.payload))
  }
}
