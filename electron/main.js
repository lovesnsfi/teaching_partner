import { app, BrowserWindow, desktopCapturer, ipcMain, dialog, shell, Menu, Tray } from 'electron'
import { join, extname, basename } from 'node:path'
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  createWriteStream,
  mkdirSync,
  renameSync,
  existsSync,
  statSync,
  readdirSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  LanDiscovery,
  getLanIp,
  getSelectedIp,
  setSelectedIp,
  listInterfaces
} from './lan.js'
import { Signaling } from './signaling.js'
import { getAppIcon } from './icon.js'
import { createPersistence } from './persist.js'
import { setupAutoUpdater } from './updater.js'

// CJS 环境下 __dirname 为内置全局，无需自行定义
const DIST = join(__dirname, '../renderer')
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL

const SIGNAL_PORT = 41235
const CHUNK_SIZE = 24 * 1024 // base64 前的二进制分片大小

let win = null
let tray = null
let forceQuit = false
const trayIcon = getAppIcon()
const SELF_ID = randomUUID()
let myName = '用户-' + SELF_ID.slice(0, 4)
let myAvatar = ''
let discovery = null
let signaling = null
let persist = null // 本地持久化后端（SQLite 或 JSON 文件）

// 允许 Electron 在无用户手势时自动播放音频（收到新消息的提示音）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 窗口捕获稳定性：Chromium 会把被遮挡/不可见的窗口判定为"无需绘制"，
// 导致 Windows Graphics Capture 单窗口取帧失败
// (wgc_capture_session: ProcessFrame failed, using existing frame: 0x80004005)。
// 关闭该遮挡优化，使被遮挡的窗口仍可正常采集。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// 文件接收状态：fileId -> { stream, tmp, received, total, convId, groupId, fromName, name, size, mime }
const fileRecv = new Map()

// 定位打包内置头像目录：dev 在 app.getAppPath()/assets/avatar，
// 打包后由 extraResources 放在 resources/assets/avatar。
function avatarDir() {
  const candidates = [
    join(app.getAppPath(), 'assets', 'avatar'),
    join(__dirname, '../../assets/avatar'),
    join(__dirname, '../assets/avatar'),
    join(process.resourcesPath || '', 'assets', 'avatar')
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p) && statSync(p).isDirectory()) return p
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return null
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: '局域网沟通广播',
    frame: false, // 无边框窗口，标题栏由 Web 自绘
    icon: trayIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (RENDERER_DEV_URL) win.loadURL(RENDERER_DEV_URL)
  else win.loadFile(join(DIST, 'index.html'))
  // 关闭时不真正退出，而是最小化到托盘（仅托盘菜单「退出」才真正退出）
  win.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      if (win) {
        win.setSkipTaskbar(true)
        win.hide()
      }
    }
  })
  win.on('closed', () => {
    win = null
  })
}

// 从托盘恢复窗口
function showWindow() {
  if (!win) createWindow()
  win.setSkipTaskbar(false)
  win.show()
  win.focus()
}

function selfInfo() {
  return {
    id: SELF_ID,
    name: myName,
    ip: getLanIp(),
    port: SIGNAL_PORT,
    avatar: myAvatar
  }
}

// 文件名去重：若已存在则追加 (n)
function uniqueName(dir, name) {
  const ext = extname(name)
  const base = basename(name, ext)
  let candidate = join(dir, name)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${base} (${n})${ext}`)
    n++
  }
  return candidate
}

// 接收端：处理文件分片，边收边写临时文件，收齐后落盘到下载目录
function handleFileMessage(msg) {
  if (msg.action !== 'chunk') return
  let rec = fileRecv.get(msg.fileId)
  if (!rec) {
    const tmp = join(app.getPath('temp'), `lanfile-${msg.fileId}.part`)
    rec = {
      stream: createWriteStream(tmp),
      tmp,
      received: 0,
      total: msg.total || 1,
      convId: msg.convId,
      groupId: msg.groupId,
      fromName: msg.fromName || '对方',
      name: msg.name,
      size: msg.size,
      mime: msg.mime
    }
    fileRecv.set(msg.fileId, rec)
    if (win) {
      win.webContents.send('lan:file-offer', {
        fileId: msg.fileId,
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        convId: msg.convId,
        groupId: msg.groupId,
        fromName: rec.fromName,
        fromAvatar: msg.fromAvatar || ''
      })
    }
  }
  rec.stream.write(Buffer.from(msg.data, 'base64'))
  rec.received++
  if (win) {
    win.webContents.send('lan:file-progress', {
      fileId: msg.fileId,
      received: rec.received,
      total: rec.total
    })
  }
  if (rec.received >= rec.total) {
    rec.stream.end(() => {
      const dir = join(app.getPath('downloads'), '局域网沟通广播')
      mkdirSync(dir, { recursive: true })
      const finalPath = uniqueName(dir, msg.name)
      try {
        renameSync(rec.tmp, finalPath)
      } catch {
        /* 跨盘符 rename 失败兜底：直接读临时文件复制 */
        try {
          const buf = readFileSync(rec.tmp)
          writeFileSync(finalPath, buf)
          unlinkSync(rec.tmp)
        } catch {
          /* ignore */
        }
      }
      fileRecv.delete(msg.fileId)
      if (win) {
        win.webContents.send('lan:file-done', {
          fileId: msg.fileId,
          name: msg.name,
          size: msg.size,
          path: finalPath,
          convId: msg.convId,
          groupId: msg.groupId,
          fromName: rec.fromName,
          ts: Date.now()
        })
      }
    })
  }
}

// 发送端：读文件 -> base64 分片 -> 逐个目标 IP 发送（同连接内连续发送）
async function sendFileToIps(ips, file, fileId, convId, groupId, onProgress) {
  let buf
  try {
    buf = readFileSync(file.path)
  } catch {
    return
  }
  const total = Math.max(1, Math.ceil(buf.length / CHUNK_SIZE))
  const mk = (i) => ({
    type: 'file',
    action: 'chunk',
    fileId,
    convId,
    groupId,
    name: file.name,
    size: file.size,
    mime: file.mime,
    from: SELF_ID,
    fromName: myName,
    fromAvatar: myAvatar,
    index: i,
    total,
    data: buf.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).toString('base64')
  })
  const payloads = []
  for (let i = 0; i < total; i++) payloads.push(mk(i))
  const grand = total * ips.length
  let done = 0
  if (win) {
    win.webContents.send('lan:file-send-start', {
      fileId,
      convId,
      groupId,
      name: file.name,
      size: file.size
    })
  }
  for (const ip of ips) {
    await signaling.sendChunks(ip, payloads, () => {
      done++
      if (onProgress) onProgress(fileId, done, grand)
    })
  }
  for (const ip of ips) {
    signaling.send(ip, {
      type: 'file',
      action: 'done',
      fileId,
      convId,
      groupId,
      name: file.name
    })
  }
  if (win) win.webContents.send('lan:file-send-done', { fileId, convId })
}

app.whenReady().then(async () => {
  // 去掉 Electron 自带菜单栏
  Menu.setApplicationMenu(null)

  // 初始化本地持久化（SQLite 优先，未安装则 JSON 文件降级）
  persist = await createPersistence(app.getPath('userData'))

  // 自动更新：传入窗口 getter（窗口可由托盘恢复重建，故用函数取值）
  setupAutoUpdater(() => win)

  createWindow()

  // 系统托盘：最小化后驻留右下角，仅右键菜单「退出」真正退出
  tray = new Tray(trayIcon)
  tray.setToolTip('局域网沟通广播')
  tray.on('click', () => showWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          forceQuit = true
          if (discovery) discovery.destroy()
          if (signaling) signaling.destroy()
          app.quit()
        }
      }
    ])
  )

  const self = {
    id: SELF_ID,
    name: myName,
    port: SIGNAL_PORT,
    role: 'user',
    avatar: myAvatar
  }

  // 1) 局域网发现
  discovery = new LanDiscovery(self)
  discovery.on('update', (list) => {
    if (win) win.webContents.send('lan:devices', list)
  })
  discovery.on('error', (err) => console.error('[lan] error', err))

  // 2) 聊天 + 信令服务
  signaling = new Signaling(self)
  signaling.on('message', (msg) => {
    if (!win) return
    if (msg.type === 'chat') win.webContents.send('lan:chat', msg)
    else if (msg.type === 'signal') win.webContents.send('lan:signal', msg)
    else if (msg.type === 'group') win.webContents.send('lan:group', msg)
    else if (msg.type === 'file') handleFileMessage(msg)
  })
  signaling.on('error', (err) => console.error('[signal] error', err))

  // 3) renderer -> main IPC 桥接
  ipcMain.handle('self:info', () => selfInfo())

  // 当前应用版本号（设置「关于」页展示用），取自 package.json 的 version
  ipcMain.handle('getAppVersion', () => app.getVersion())

  ipcMain.handle('self:setName', (_, name) => {
    if (typeof name === 'string' && name.trim()) {
      myName = name.trim().slice(0, 24)
      if (discovery) discovery.self.name = myName
    }
    return myName
  })

  ipcMain.handle('self:setAvatar', (_, avatar) => {
    myAvatar = avatar || ''
    if (discovery) discovery.self.avatar = myAvatar
    return myAvatar
  })

  // 读取打包内置头像目录（assets/avatar），返回 [{ id, url }]，
  // url 为 base64 data URI，可直接用于 <img src>。
  // 取值语义：avatar 字符串用 "asset:<id>" 形式，网络/存储只传小 id，
  // 渲染时再本地解析成图片，避免 UDP 广播包被大体积 base64 撑爆。
  ipcMain.handle('get:avatars', () => {
    const dir = avatarDir()
    if (!dir) return []
    let files = []
    try {
      files = readdirSync(dir)
    } catch {
      return []
    }
    const EXT_MIME = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp'
    }
    // 按文件头（magic bytes）判定真实 MIME：用户放入的文件可能出现
    // 「扩展名与内容不符」的情况（例如 a17.jpeg 实际是 WebP 内容），
    // 仅靠扩展名会把错误的 MIME 发给浏览器，导致图片无法渲染。
    // 这里优先用文件头判定，扩展名仅作为回退。
    function detectMime(f, buf) {
      const h = buf.slice(0, 12)
      // JPEG: FF D8 FF
      if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg'
      // PNG: 89 50 4E 47
      if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'image/png'
      // WebP: 'RIFF' .... 'WEBP'
      if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
          h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return 'image/webp'
      // GIF: 'GIF8'
      if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return 'image/gif'
      // 回退：扩展名（含 a16.jpeg_webp 这类复合后缀按 _webp 处理）
      const lower = f.toLowerCase()
      if (lower.endsWith('_webp')) return 'image/webp'
      const ext = extname(lower)
      if (EXT_MIME[ext]) return EXT_MIME[ext]
      return null
    }
    const list = []
    for (const f of files) {
      const lower = f.toLowerCase()
      // 仅处理图片类文件（含 a16.jpeg_webp 这种复合后缀）
      if (!/\.(jpe?g|png|webp|gif)$/.test(lower) && !lower.endsWith('_webp')) continue
      try {
        const buf = readFileSync(join(dir, f))
        const mime = detectMime(f, buf)
        if (!mime) continue
        const ext = extname(lower)
        const id = basename(f, ext)
        list.push({ id, url: `data:${mime};base64,${buf.toString('base64')}` })
      } catch {
        /* 跳过读取失败的文件 */
      }
    }
    list.sort((a, b) => a.id.localeCompare(b.id))
    return list
  })

  // 读取提示音文件并返回 base64 data URI，renderer 用它播放新消息提示音
  let soundUriCache = null
  ipcMain.handle('get:sound', () => {
    if (soundUriCache) return soundUriCache
    const candidates = [
      join(app.getAppPath(), 'assets', 'sound', 'message.mp3'),
      join(__dirname, '../../assets/sound/message.mp3'),
      join(__dirname, '../assets/sound/message.mp3')
    ]
    for (const p of candidates) {
      try {
        if (existsSync(p)) {
          const b64 = readFileSync(p).toString('base64')
          soundUriCache = 'data:audio/mpeg;base64,' + b64
          return soundUriCache
        }
      } catch {
        /* 尝试下一个候选路径 */
      }
    }
    return null
  })

  // ===== 本地持久化接口（聊天记录 + 设置 + 联系人，SQLite / JSON 文件）=====
  ipcMain.handle('db:load', () => {
    try {
      return persist
        ? persist.load()
        : { settings: {}, groups: [], messages: {}, contacts: [] }
    } catch {
      return { settings: {}, groups: [], messages: {}, contacts: [] }
    }
  })
  ipcMain.handle('db:saveSettings', (_, obj) => {
    try {
      if (persist) persist.saveSettings(obj)
    } catch {
      /* ignore */
    }
  })
  ipcMain.handle('db:replaceGroups', (_, groups) => {
    try {
      if (persist) persist.replaceGroups(groups || [])
    } catch {
      /* ignore */
    }
  })
  ipcMain.handle('db:replaceContacts', (_, list) => {
    try {
      if (persist) persist.replaceContacts(list || [])
    } catch {
      /* ignore */
    }
  })
  ipcMain.handle('db:appendMessage', (_, m) => {
    try {
      if (persist) persist.appendMessage(m)
    } catch {
      /* ignore */
    }
  })
  ipcMain.handle('db:updateMessage', (_, p) => {
    try {
      if (persist) persist.updateMessage(p)
    } catch {
      /* ignore */
    }
  })

  // 列出网卡 + 当前选择（设置界面用）
  ipcMain.handle('get:interfaces', () => ({
    list: listInterfaces(),
    selected: getSelectedIp() || 'auto'
  }))

  // 切换用于通信的网卡：重新绑定发现与信令服务
  ipcMain.handle('set:interface', (_, ip) => {
    setSelectedIp(ip)
    try {
      if (discovery) discovery.rebind()
    } catch (e) {
      console.error('[lan] rebind error', e)
    }
    try {
      if (signaling) signaling.rebind(getSelectedIp() || '0.0.0.0')
    } catch (e) {
      console.error('[signal] rebind error', e)
    }
    if (win) win.webContents.send('lan:devices', discovery ? discovery.list() : [])
    return getSelectedIp() || 'auto'
  })

  ipcMain.handle('get:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 200, height: 120 }
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
    }))
  })

  // 发送聊天 / 群聊消息
  ipcMain.on('send:chat', (_, { targetIp, payload }) => {
    if (signaling && targetIp && payload) {
      signaling.send(targetIp, { ...payload, ts: payload.ts || Date.now() })
    }
  })

  ipcMain.on('send:signal', (_, { targetIp, payload }) => {
    if (signaling && targetIp && payload) {
      signaling.send(targetIp, { type: 'signal', payload, ts: Date.now() })
    }
  })

  // 发送文件（main 负责分片）
  ipcMain.on('send:file', (_, spec) => {
    if (!signaling || !spec || !spec.ips || !spec.ips.length || !spec.file) return
    sendFileToIps(
      spec.ips,
      spec.file,
      spec.fileId,
      spec.convId,
      spec.groupId || null,
      (fileId, done, total) => {
        if (win) win.webContents.send('lan:file-send-progress', { fileId, done, total })
      }
    )
  })

  // 选择文件（返回本地 path 与元数据）
  ipcMain.handle('pick:file', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择要发送的文件'
    })
    if (res.canceled || !res.filePaths.length) return null
    const p = res.filePaths[0]
    try {
      const st = statSync(p)
      return { path: p, name: basename(p), size: st.size, mime: '' }
    } catch {
      return null
    }
  })

  ipcMain.handle('open:path', (_, p) => {
    try {
      shell.openPath(p)
    } catch {
      /* ignore */
    }
  })

  ipcMain.handle('open:folder', (_, p) => {
    try {
      shell.showItemInFolder(p)
    } catch {
      /* ignore */
    }
  })

  // 窗口控制：最小化 / 关闭 都只是隐藏到托盘，不退出
  ipcMain.on('window:minimize', () => {
    if (win) {
      win.setSkipTaskbar(true)
      win.hide()
    }
  })
  ipcMain.on('window:maximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => {
    if (win) {
      win.setSkipTaskbar(true)
      win.hide()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 托盘常驻：窗口关闭（隐藏）时不退出，保持 LAN 服务与托盘继续运行
})
