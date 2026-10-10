import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  dialog,
  shell,
  Menu,
  Tray,
  clipboard,
  nativeImage,
  screen
} from 'electron'
import { join, extname, basename } from 'node:path'
import os from 'node:os'
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
  listAvDevices,
  startRecording,
  stopRecording,
  isRecording
} from './recorder.js'
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
// 本机设备 ID：必须跨重启保持稳定！
// 若每次启动都换新 ID，对端会认为「你」变成了一台全新设备，旧的那条记录会永久
// 残留在双方联系人表里 —— 表现为联系人列表出现大量同名重复项。
// 因此启动时从 userData 目录读写一个固定 ID（见 loadOrCreateSelfId）。
let SELF_ID = ''
let myName = ''
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

// ===== 文件传输状态 =====
// 接收中：fileId -> { stream, tmp, destPath, received, total, convId, groupId, fromName, name, size, mime }
// 接收方中途取消的记录 fileId（发送方据此停发剩余分片）
const cancelledFiles = new Set()
const fileRecv = new Map()
// 发送端：已发出「传输请求」、等待对方确认的文件 fileId -> spec
//   spec = { fileId, ips, file, convId, groupId, granted:Set<ip>, rejectedCount }
const pendingOut = new Map()
// 接收端：收到的「传输请求」（等待本端确认接收）fileId -> info
const pendingIn = new Map()
// 接收端：用户在「另存为」中预先选定的落盘路径 fileId -> absolutePath
const preRecvDest = new Map()
// 发送进度累计：fileId -> { perIp, granted, done }
const sendState = new Map()

// ===== 学生端「屏幕广播」独立观看窗口 =====
let broadcastWin = null
// 观看窗口关闭的原因，随 'closed' 事件一并传给主窗口（见 createBroadcastWindow）
let closeReason = ''

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

// 学生端「屏幕广播」独立观看窗口。
// 主窗口只做控制（谁在播、加入 / 离开），老师画面在这里单独开一个大窗展示，
// 避免挤在右侧小面板里细节看不清。
// 注意：学生端的 WebRTC 握手（offer / ice / bye）都路由到这个窗口处理。
function createBroadcastWindow(info = {}) {
  if (broadcastWin && !broadcastWin.isDestroyed()) {
    broadcastWin.show()
    broadcastWin.focus()
    return broadcastWin
  }
  broadcastWin = new BrowserWindow({
    width: 1280,
    height: 740,
    minWidth: 640,
    minHeight: 420,
    title: info.name ? `${info.name} 的屏幕广播` : '屏幕广播',
    icon: trayIcon,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // 通过 query 把老师信息带进渲染层，供窗口自行完成「请求推流 → 收流」的握手
  const query = {
    broadcast: '1',
    tid: info.id || '',
    tip: info.ip || '',
    tname: info.name || ''
  }
  if (RENDERER_DEV_URL) {
    const url = new URL(RENDERER_DEV_URL)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    broadcastWin.loadURL(url.toString())
  } else {
    broadcastWin.loadFile(join(DIST, 'index.html'), { query })
  }
  broadcastWin.on('closed', () => {
    broadcastWin = null
    // 通知主窗口：区分「学生自己关掉了观看窗口」与「老师停播」——
    // 前者要保留学生身份（主窗口仍显示「重新打开观看窗口」），后者才彻底退出。
    if (win) win.webContents.send('lan:broadcast-closed', { reason: closeReason })
    closeReason = ''
  })
  return broadcastWin
}

// reason: 'closed'（学生手动关窗，默认） | 'teacher-stopped'（老师停播） | 'leave'（主动离开广播）
function closeBroadcastWindow(reason = 'closed') {
  const w = broadcastWin
  if (!w || w.isDestroyed()) {
    // 窗口已不存在也要把状态同步给主窗口，否则主窗口会一直以为窗口还开着
    broadcastWin = null
    if (win) win.webContents.send('lan:broadcast-closed', { reason })
    return
  }
  closeReason = reason
  broadcastWin = null
  try {
    w.close()
  } catch {
    /* ignore */
  }
}

function selfInfo() {
  return {
    id: SELF_ID,
    // host：电脑设备名，作为“这台电脑”的稳定可读标识（与昵称、IP 无关）
    host: os.hostname(),
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

// 根据扩展名推断 MIME（聊天内联显示图片、判断文件卡片形态都要用）
const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}
function mimeOf(p) {
  const ext = extname(p || '').replace(/^\./, '').toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

// 接收端：处理文件相关消息。
// 与旧实现的关键差异：对端先发 offer（仅元信息），本端弹「接收 / 另存为」，
// 用户确认后回 accept，对端才开始分片传输 —— 避免未经同意就被灌文件。
function handleFileMessage(msg) {
  const fromIp = msg._from

  // 会话 id 归一化：本端 messages 以「对端设备 id」（单聊）或 groupId（群聊）为键。
  // 对端发来的 convId 是「对端的会话键」——单聊时它等于本端设备 id，若直接使用会把
  // 文件卡片写进本端自己的会话桶，对方界面上什么都看不到。这里统一改正：
  //   群聊 -> groupId；单聊 -> 发送方设备 id（msg.from），兜底用来源 IP。
  if (msg.groupId) {
    msg.convId = msg.groupId
  } else if (msg.from) {
    msg.convId = msg.from
  }

  // 1) 传输请求：登记待确认状态，交给渲染层询问用户
  if (msg.action === 'offer') {
    pendingIn.set(msg.fileId, {
      fileId: msg.fileId,
      convId: msg.convId,
      groupId: msg.groupId || null,
      name: msg.name,
      size: msg.size,
      mime: msg.mime,
      total: msg.total || 0,
      fromIp,
      from: msg.from,
      fromName: msg.fromName || '对方'
    })
    if (win) {
      win.webContents.send('lan:file-offer', {
        fileId: msg.fileId,
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        total: msg.total || 0,
        convId: msg.convId,
        groupId: msg.groupId || null,
        from: msg.from,
        fromName: msg.fromName || '对方',
        fromAvatar: msg.fromAvatar || '',
        awaiting: true
      })
    }
    return
  }

  // 2) 对方同意接收：开始真正的分片传输
  if (msg.action === 'accept') {
    startFileTransfer(msg.fileId, fromIp)
    return
  }

  // 3) 对方拒绝接收
  if (msg.action === 'reject') {
    const spec = pendingOut.get(msg.fileId)
    if (!spec) return
    spec.rejectedCount = (spec.rejectedCount || 0) + 1
    // 所有目标都拒绝且无人同意 → 通知发送方「对方已拒绝」
    if (spec.granted.size === 0 && spec.rejectedCount >= spec.ips.length) {
      pendingOut.delete(msg.fileId)
      sendState.delete(msg.fileId)
      if (win) {
        win.webContents.send('lan:file-rejected', {
          fileId: msg.fileId,
          convId: spec.convId,
          groupId: spec.groupId
        })
      }
    }
    return
  }

  // 4) 接收方中途取消：立刻停止发送剩余分片
  if (msg.action === 'cancel') {
    cancelledFiles.add(msg.fileId)
    // 稍后清理，避免同 fileId 长期残留
    setTimeout(() => cancelledFiles.delete(msg.fileId), 60000)
    if (win) {
      win.webContents.send('lan:file-cancelled', {
        fileId: msg.fileId,
        convId: msg.convId || (pendingOut.get(msg.fileId) || {}).convId
      })
    }
    return
  }

  if (msg.action !== 'chunk') return

  let rec = fileRecv.get(msg.fileId)
  if (!rec) {
    // 「另存为」时用户已选定目标路径，直接写入该路径；
    // 否则先写临时文件，全部收齐后再挪到「下载/局域网沟通广播」目录。
    const destPath = preRecvDest.get(msg.fileId) || null
    const tmp = join(app.getPath('temp'), `lanfile-${msg.fileId}.part`)
    rec = {
      stream: createWriteStream(destPath || tmp),
      tmp,
      destPath,
      // 记录来源，接收方取消时要据此通知发送方停发
      fromIp: msg._from,
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
    preRecvDest.delete(msg.fileId)
    // 通知渲染层「文件开始到达」。
    // 普通文件此前已通过 lan:file-offer 在聊天区建过卡片，这里只需把状态从
    // 「待接收」切到「接收中」；而图片等免确认直传的场景没有 offer 事件，
    // 就靠这条通知在聊天区即时新建消息 —— 否则接收方界面会毫无反应。
    if (win) {
      win.webContents.send('lan:file-incoming', {
        fileId: msg.fileId,
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        total: msg.total || 1,
        convId: msg.convId,
        groupId: msg.groupId,
        from: msg.from,
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
      let finalPath = rec.destPath
      if (!finalPath) {
        const dir = join(app.getPath('downloads'), '局域网沟通广播')
        mkdirSync(dir, { recursive: true })
        finalPath = uniqueName(dir, msg.name)
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
      }
      fileRecv.delete(msg.fileId)
      if (win) {
        win.webContents.send('lan:file-done', {
          fileId: msg.fileId,
          name: msg.name,
          size: msg.size,
          mime: msg.mime || mimeOf(finalPath),
          path: finalPath,
          convId: msg.convId,
          groupId: msg.groupId,
          from: msg.from,
          fromName: rec.fromName,
          ts: Date.now()
        })
      }
    })
  }
}

// 免确认直发（图片）：不等对方点「接收」，立即开始分片传输。
// 接收端在收到第一片时会自行补出消息（见 handleFileMessage 里的 lan:file-incoming）。
async function directSend(spec) {
  const perIp = Math.max(1, Math.ceil((spec.file.size || 0) / CHUNK_SIZE))
  // 仍登记到 pendingOut：便于 startFileTransfer / reject 等既有逻辑复用同一份结构
  pendingOut.set(spec.fileId, {
    fileId: spec.fileId,
    ips: spec.ips,
    file: spec.file,
    convId: spec.convId,
    groupId: spec.groupId || null,
    granted: new Set(spec.ips),
    rejectedCount: 0
  })
  sendState.set(spec.fileId, { perIp, granted: spec.ips.length, done: 0 })
  if (win) {
    win.webContents.send('lan:file-send-start', {
      fileId: spec.fileId,
      convId: spec.convId,
      groupId: spec.groupId,
      name: spec.file.name,
      size: spec.file.size
    })
  }
  await sendFileToIps(
    spec.ips,
    spec.file,
    spec.fileId,
    spec.convId,
    spec.groupId || null
  )
  pendingOut.delete(spec.fileId)
  sendState.delete(spec.fileId)
  if (win) {
    win.webContents.send('lan:file-send-done', {
      fileId: spec.fileId,
      convId: spec.convId
    })
  }
}

// 发送端：把待发文件登记为「待确认」，并给每个目标发一条只含元信息的传输请求。
// 真正的数据要等对方回 accept（见 startFileTransfer）才发送。
function queueFileSend(spec) {
  const perIp = Math.max(1, Math.ceil((spec.file.size || 0) / CHUNK_SIZE))
  pendingOut.set(spec.fileId, {
    fileId: spec.fileId,
    ips: spec.ips,
    file: spec.file,
    convId: spec.convId,
    groupId: spec.groupId || null,
    granted: new Set(),
    rejectedCount: 0
  })
  sendState.set(spec.fileId, { perIp, granted: 0, done: 0 })
  for (const ip of spec.ips) {
    signaling.send(ip, {
      type: 'file',
      action: 'offer',
      fileId: spec.fileId,
      convId: spec.convId,
      groupId: spec.groupId || null,
      name: spec.file.name,
      size: spec.file.size,
      mime: spec.file.mime,
      total: perIp,
      from: SELF_ID,
      fromName: myName,
      fromAvatar: myAvatar
    })
  }
}

// 收到对端 accept 后：为该目标启动传输（群发场景下各自确认、各自启动）
async function startFileTransfer(fileId, ip) {
  const spec = pendingOut.get(fileId)
  if (!spec || !ip) return
  if (spec.granted.has(ip)) return
  spec.granted.add(ip)
  const st = sendState.get(fileId)
  if (st) st.granted = spec.granted.size
  // 首个目标确认时通知渲染层：文件从「等待对方接收」转为「发送中」
  if (spec.granted.size === 1 && win) {
    win.webContents.send('lan:file-send-start', {
      fileId,
      convId: spec.convId,
      groupId: spec.groupId,
      name: spec.file.name,
      size: spec.file.size
    })
  }
  await sendFileToIps([ip], spec.file, fileId, spec.convId, spec.groupId)
  if (spec.granted.size >= spec.ips.length) {
    pendingOut.delete(fileId)
    sendState.delete(fileId)
    if (win) win.webContents.send('lan:file-send-done', { fileId, convId: spec.convId })
  }
}

// 发送端底层：读文件 -> base64 分片 -> 逐个目标 IP 发送（同连接内连续发送）
async function sendFileToIps(ips, file, fileId, convId, groupId) {
  let buf
  try {
    buf = readFileSync(file.path)
  } catch {
    return false
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
  for (const ip of ips) {
    await signaling.sendChunks(ip, payloads, () => {
      const st = sendState.get(fileId)
      if (!st) return
      st.done++
      if (win) {
        win.webContents.send('lan:file-send-progress', {
          fileId,
          done: st.done,
          // 分母随「已确认接收」的目标数动态增长，保证最终能到 100%
          total: Math.max(1, st.perIp * Math.max(1, st.granted))
        })
      }
    }, () => cancelledFiles.has(fileId))
  }
  // 接收方已取消：不再发「传输完成」，直接结束
  if (cancelledFiles.has(fileId)) return false
  // 通知接收端：本次传输的分片已全部发出
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
  return true
}

// 读取或创建本机稳定设备 ID（持久化到 userData/self-id.txt）
function loadOrCreateSelfId(userDataDir) {
  const f = join(userDataDir, 'self-id.txt')
  try {
    if (existsSync(f)) {
      const v = readFileSync(f, 'utf8').trim()
      if (v) return v
    }
  } catch {
    /* ignore */
  }
  const id = randomUUID()
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(f, id, 'utf8')
  } catch (e) {
    console.warn('[id] 无法写入 self-id.txt，本次将使用临时 ID：', (e && e.message) || e)
  }
  return id
}

app.whenReady().then(async () => {
  // 去掉 Electron 自带菜单栏
  Menu.setApplicationMenu(null)

  // 本机稳定设备 ID + 默认昵称（必须在建发现/信令服务之前就绪）
  SELF_ID = loadOrCreateSelfId(app.getPath('userData'))
  myName = '用户-' + SELF_ID.slice(0, 4)
  console.log('[id] 本机设备 ID：', SELF_ID)

  // 初始化本地持久化（node-sqlite3-wasm 单后端）。
  // 失败时不静默降级 —— 直接弹窗告知用户，否则会出现
  // 「聊天记录 / 联系人 / 设置看着正常，实际每次重启都丢」的假象。
  try {
    persist = await createPersistence(app.getPath('userData'))
  } catch (e) {
    const reason = (e && e.message) || String(e)
    console.error('[persist] 初始化失败：', reason)
    dialog.showErrorBox(
      '本地数据初始化失败',
      [
        '无法打开本地数据库，聊天记录、联系人和设置将无法保存。',
        '',
        `原因：${reason}`,
        '',
        '数据库文件：',
        join(app.getPath('userData'), 'lan-chat.db'),
        '',
        '请确认该目录可写；若文件已损坏，可将其改名备份后重新启动',
        '（注意：改名后历史数据将不再显示）。',
      ].join('\n')
    )
  }

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
    if (msg.type === 'file') {
      // 文件消息与窗口是否存在无关，先处理以免主窗口隐藏时丢包
      handleFileMessage(msg)
      return
    }
    if (msg.type === 'signal') {
      const kind = msg.payload && msg.payload.kind
      // 学生端的 WebRTC 握手（offer / ice / bye）交给独立观看窗口处理
      if (
        broadcastWin &&
        !broadcastWin.isDestroyed() &&
        ['offer', 'ice', 'bye'].includes(kind)
      ) {
        broadcastWin.webContents.send('lan:signal', msg)
      } else if (win) {
        win.webContents.send('lan:signal', msg)
      }
      return
    }
    if (!win) return
    if (msg.type === 'chat') win.webContents.send('lan:chat', msg)
    else if (msg.type === 'group') win.webContents.send('lan:group', msg)
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

  // ===== 录屏：ffmpeg 主进程单遍采集 + 编码 =====
  // 列出可用音视频设备（视频/麦克风/系统声音），供设置页与录制选择
  ipcMain.handle('recorder:devices', async () => {
    try {
      return await listAvDevices()
    } catch (e) {
      return { video: [], audioInput: [], audioLoopback: [], error: String(e) }
    }
  })

  // 开始录制。opts 见 recorder.js startRecording
  ipcMain.handle('recorder:start', async (_, opts) => {
    try {
      return await startRecording(opts || {})
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
  })

  // 停止录制，返回最终 mp4 路径
  ipcMain.handle('recorder:stop', async () => {
    try {
      if (!isRecording()) return { ok: false, error: '当前没有录制' }
      return await stopRecording()
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
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
      if (persist) {
        persist.replaceContacts(list || [])
        console.log(`[persist] 已写入联系人 ${(list || []).length} 个`)
      } else {
        console.warn('[persist] replaceContacts 失败：持久化后端尚未就绪')
      }
    } catch (e) {
      // 这里不能静默吞掉——否则联系人写不进去时界面毫无察觉，很难排查
      console.error('[persist] replaceContacts 出错：', (e && e.message) || e)
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

  // 删除某会话的全部消息（右键删除联系人时同步清理聊天记录）
  ipcMain.handle('db:deleteMessages', (_, convId) => {
    try {
      if (persist) return persist.deleteMessages(convId)
    } catch (e) {
      console.error('[persist] deleteMessages 出错：', (e && e.message) || e)
    }
    return 0
  })

  // 供 renderer 主动拉取当前已发现的设备列表（消除「初始发现事件早于
  // onDevices 监听器注册」导致联系人漏存/漏标在线的问题）
  ipcMain.handle('discovery:list', () => {
    try {
      return discovery ? discovery.list() : []
    } catch {
      return []
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

  // 发送文件：此处只发出「传输请求」，等对方确认接收后才真正分片发送
  ipcMain.on('send:file', (_, spec) => {
    if (!signaling || !spec || !spec.ips || !spec.ips.length || !spec.file) return
    // 图片等 direct 内容不需要对方确认，直接分片发送；
    // 普通文件仍走「发请求 → 等确认」流程
    if (spec.direct) {
      directSend(spec)
      return
    }
    queueFileSend(spec)
  })

  // 接收方确认接收（saveAs=true 时先弹出「另存为」选择落盘位置）
  ipcMain.handle('file:accept', async (_, { fileId, saveAs } = {}) => {
    const info = pendingIn.get(fileId)
    if (!info) return { ok: false }
    if (saveAs) {
      const res = await dialog.showSaveDialog(win, {
        title: '另存为',
        defaultPath: info.name || 'download'
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      preRecvDest.set(fileId, res.filePath)
    }
    pendingIn.delete(fileId)
    if (signaling && info.fromIp) {
      signaling.send(info.fromIp, { type: 'file', action: 'accept', fileId })
    }
    return { ok: true }
  })

  // 接收方拒绝接收
  ipcMain.handle('file:reject', (_, { fileId } = {}) => {
    const info = pendingIn.get(fileId)
    if (info && signaling && info.fromIp) {
      signaling.send(info.fromIp, { type: 'file', action: 'reject', fileId })
    }
    pendingIn.delete(fileId)
    preRecvDest.delete(fileId)
    return { ok: true }
  })

  // 学生端屏幕广播：独立观看窗口的打开 / 关闭
  ipcMain.handle('broadcast:open', (_, info) => {
    createBroadcastWindow(info || {})
    return true
  })
  ipcMain.handle('broadcast:close', (_, reason) => {
    closeBroadcastWindow(reason || 'closed')
    return true
  })

  // 选择文件（可多选），返回 [{ path, name, size, mime }]，未选返回 []
  ipcMain.handle('pick:file', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要发送的文件'
    })
    if (res.canceled || !res.filePaths.length) return []
    return res.filePaths
      .map((p) => {
        try {
          const st = statSync(p)
          return { path: p, name: basename(p), size: st.size, mime: mimeOf(p) }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  })

  // 选择文件夹（录屏保存目录）
  ipcMain.handle('pick:folder', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择录屏保存目录'
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

  // 保存剪贴板里的图片（Ctrl+V 粘贴截图）到临时目录，返回 { path, name, size, mime }
  ipcMain.handle('save:clipboardImage', async (_, dataUrl, mime) => {
    try {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const buf = Buffer.from(base64, 'base64')
      if (!buf.length) return null
      const type = (mime && String(mime).startsWith('image/') && mime) || 'image/png'
      const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png'
      const dir = join(app.getPath('temp'), 'lan-clipboard')
      mkdirSync(dir, { recursive: true })
      const name = `paste-${Date.now()}.${ext}`
      const p = join(dir, name)
      writeFileSync(p, buf)
      return { path: p, name, size: buf.length, mime: type }
    } catch (e) {
      console.error('[image] 保存剪贴板图片失败：', (e && e.message) || e)
      return null
    }
  })

  // 选择图片（可多选），聊天内联显示，返回 [{ path, name, size, mime }]，未选返回 []
  ipcMain.handle('pick:image', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '图片',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
        }
      ],
      title: '选择要发送的图片'
    })
    if (res.canceled || !res.filePaths.length) return []
    return res.filePaths
      .map((p) => {
        try {
          const st = statSync(p)
          return { path: p, name: basename(p), size: st.size, mime: mimeOf(p) }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  })

  // 读取已落盘的图片并转成 data URI，供渲染层 <img> 直接显示
  ipcMain.handle('get:fileDataUrl', async (_, p) => {
    try {
      if (!p) return null
      // 防御：超大图片转 baseURI 会占用大量内存，超过 24MB 直接不转
      const st = statSync(p)
      if (st.size > 24 * 1024 * 1024) return null
      const buf = readFileSync(p)
      return `data:${mimeOf(p)};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // 接收方取消接收：停止写盘、删除半截临时文件，并通知发送方停发剩余分片
  ipcMain.handle('file:cancelReceive', (_, { fileId } = {}) => {
    try {
      const rec = fileRecv.get(fileId)
      if (rec) {
        try {
          rec.stream.end()
        } catch {
          /* ignore */
        }
        try {
          rec.stream.destroy()
        } catch {
          /* ignore */
        }
        // 「另存为」指定的路径还没写完也要清掉
        const partial = rec.destPath || rec.tmp
        try {
          if (partial && existsSync(partial)) unlinkSync(partial)
        } catch {
          /* ignore */
        }
        fileRecv.delete(fileId)
        // 通知发送方停止发送
        if (rec.fromIp && signaling) {
          signaling.send(rec.fromIp, { type: 'file', action: 'cancel', fileId })
        }
      }
      pendingIn.delete(fileId)
      preRecvDest.delete(fileId)
      return { ok: true }
    } catch (e) {
      console.error('[file] 取消接收失败：', (e && e.message) || e)
      return { ok: false }
    }
  })

  // 把图片复制到系统剪贴板
  ipcMain.handle('img:copy', (_, p) => {
    try {
      if (!p || !existsSync(p)) return false
      const img = nativeImage.createFromPath(p)
      if (img.isEmpty()) return false
      clipboard.writeImage(img)
      return true
    } catch (e) {
      console.error('[image] 复制到剪贴板失败：', (e && e.message) || e)
      return false
    }
  })

  // 图片「另存为」：弹出保存对话框并复制到指定位置
  ipcMain.handle('img:saveAs', async (_, { path: src, name } = {}) => {
    try {
      if (!src || !existsSync(src)) return { ok: false }
      const res = await dialog.showSaveDialog(win, {
        title: '保存图片',
        defaultPath: name || basename(src)
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      writeFileSync(res.filePath, readFileSync(src))
      return { ok: true, path: res.filePath }
    } catch (e) {
      console.error('[image] 另存为失败：', (e && e.message) || e)
      return { ok: false }
    }
  })

// ===== 框选截屏 =====
// 流程：隐藏主窗口 → 抓取鼠标所在显示器整屏 → 用一个全屏透明窗口做框选层
//      → 用户确认后按选区裁剪、写入剪贴板、可选发回主窗口。
let shotWin = null
let shotSource = null // { path, width, height, displayId }

function closeShotWindow() {
  const w = shotWin
  shotWin = null
  if (w && !w.isDestroyed()) {
    try {
      w.destroy()
    } catch {
      /* ignore */
    }
  }
}

// 恢复主窗口（截屏前会隐藏，否则会被拍进去）
async function restoreMainWindow() {
  if (win && !win.isDestroyed()) {
    try {
      if (!win.isVisible()) win.showInactive()
    } catch {
      /* ignore */
    }
  }
}

ipcMain.handle('shot:begin', async () => {
  try {
    closeShotWindow()
      const pt = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay()
    const b = display.bounds
    // 先隐藏主窗口再抓图，否则会把聊天界面一起拍进去
    const wasVisible = win && !win.isDestroyed() && win.isVisible()
    if (wasVisible) win.hide()
    await new Promise((r) => setTimeout(r, 260))
    const ratio = Math.min(1, 2560 / b.width, 1440 / b.height)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(b.width * ratio), height: Math.round(b.height * ratio) }
    })
    const src =
      sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) {
      if (wasVisible) win.showInactive()
      return { ok: false, reason: '当前环境不支持屏幕截取（远程桌面 / 虚拟机常见）' }
    }
    const png = src.thumbnail.toPNG()
    const dir = join(app.getPath('temp'), 'lan-shot')
    mkdirSync(dir, { recursive: true })
    const p2 = (n) => String(n).padStart(2, '0')
    const d = new Date()
    const fp = join(
      dir,
      `shot-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`
    )
    writeFileSync(fp, png)
    shotSource = {
      path: fp,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      // 遮罩层 / 鼠标坐标用的是「显示器尺寸」，
      // 而落盘 PNG 可能被 ratio 缩小过，裁剪时必须换算回 PNG 像素坐标
      width: b.width,
      height: b.height,
      pngWidth: src.thumbnail.getSize().width,
      pngHeight: src.thumbnail.getSize().height
    }
    if (wasVisible) win.showInactive()

    // 全屏透明框选层
    shotWin = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizableHint: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    shotWin.setAlwaysOnTop(true, 'screen-saver')
    shotWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    const query = { screenshot: '1' }
    if (RENDERER_DEV_URL) {
      const url = new URL(RENDERER_DEV_URL)
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
      shotWin.loadURL(url.toString())
    } else {
      shotWin.loadFile(join(DIST, 'index.html'), { query })
    }
    shotWin.on('closed', () => {
      shotWin = null
      shotSource = null
    })
    return { ok: true }
  } catch (e) {
    console.error('[shot] 开始截屏失败：', (e && e.message) || e)
    await restoreMainWindow()
    return { ok: false, reason: (e && e.message) || String(e) }
  }
})

// 框选层向主进程取那张「底图」
ipcMain.handle('shot:image', () => {
  if (!shotSource) return null
  return { dataUrl: shotSource.dataUrl, width: shotSource.width, height: shotSource.height }
})

// 确认选区：裁剪 → 写剪贴板 → 可选发回主窗口
ipcMain.handle('shot:confirm', (_, rect) => {
  try {
    if (!shotSource || !rect) return { ok: false }
    // 选区坐标是显示器尺寸下的值，PNG 可能是缩放后的，必须按比例换算并夹紧，
    // 否则会裁到越界区域（表现为选区跑位/空白）
    const sx = (shotSource.pngWidth || shotSource.width) / shotSource.width
    const sy = (shotSource.pngHeight || shotSource.height) / shotSource.height
    const full = nativeImage.createFromPath(shotSource.path)
    const pw = full.getSize().width || shotSource.width
    const ph = full.getSize().height || shotSource.height
    const x = Math.max(0, Math.min(Math.round(rect.x * sx), pw - 1))
    const y = Math.max(0, Math.min(Math.round(rect.y * sy), ph - 1))
    const w = Math.max(1, Math.min(Math.round(rect.width * sx), pw - x))
    const h = Math.max(1, Math.min(Math.round(rect.height * sy), ph - y))
    const img = full.crop({ x, y, width: w, height: h })
    if (img.isEmpty()) return { ok: false, reason: '选区无效' }
    clipboard.writeImage(img)
    const png = img.toPNG()
    const dir = join(app.getPath('temp'), 'lan-shot')
    mkdirSync(dir, { recursive: true })
    const p2 = (n) => String(n).padStart(2, '0')
    const d = new Date()
    const name = `screenshot-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`
    const fp = join(dir, name)
    writeFileSync(fp, png)
    closeShotWindow()
    // 结果回传给主窗口：按需求**只放剪贴板，不自动发送**，
    // 用户可自行粘贴到聊天框；这里带上 file 供后续「顺便发送」之类功能使用。
    if (win && !win.isDestroyed()) {
      win.webContents.send('shot:result', {
        ok: true,
        file: { path: fp, name, size: png.length, mime: 'image/png' }
      })
    }
    return { ok: true }
  } catch (e) {
    console.error('[shot] 截屏确认失败：', (e && e.message) || e)
    return { ok: false, reason: (e && e.message) || String(e) }
  }
})

ipcMain.handle('shot:cancel', () => {
  closeShotWindow()
  return { ok: true }
})

// 用系统默认浏览器打开外部链接（作者主页等）。
// 做协议白名单校验：只允许 https，避免渲染层被诱导打开本地文件等危险协议。
  ipcMain.handle('shell:openExternal', async (_, url) => {
    try {
      const u = String(url || '')
      if (!/^https:\/\//i.test(u)) {
        console.warn('[shell] 拒绝打开非 https 链接：', u)
        return false
      }
      await shell.openExternal(u)
      return true
    } catch (e) {
      console.error('[shell] 打开外部链接失败：', (e && e.message) || e)
      return false
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
