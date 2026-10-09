import { autoUpdater } from 'electron-updater'
import { app, ipcMain } from 'electron'
import https from 'node:https'

// 自动下载：发现新版本后立即开始下载（配合下面的进度/完成事件给 UI 反馈）
autoUpdater.autoDownload = true
// 退出时若已下载完成则自动安装（用户选「稍后」时，下次程序退出自动装）
autoUpdater.autoInstallOnAppQuit = true

const GH_RELEASES = 'https://github.com/lovesnsfi/teaching_partner/releases/latest/download'

// ============================================================================
// 更新源（**按数组顺序尝试**，第一个可用的即被采用）
// ----------------------------------------------------------------------------
// 用的是 electron-updater 的 generic provider：它直接读取
//   <url>/latest.yml          （版本清单，含文件 sha512 与大小）
//   <url>/<安装包名>.exe       （安装包与 blockmap）
// 相比 github provider 需要解析 GitHub 网页 / Atom 源，这种方式更简单也更稳
// （之前就因为 Atom + Accept 头不匹配被 GitHub 判为 406 而失败）。
//
// 末尾的 releases/latest/download 是 GitHub 官方给的「最新版本」固定别名，
// 每次发版不用改地址。
//
// ★ 顺序：镜像优先、GitHub 兜底。
//   国内直连 GitHub 经常长时间无响应，放第一位会把每次检查都拖慢；
//   镜像不通（挂了就换域名）时再自动回落到官方地址。
//
// ★ 自建源（最稳）：你之前提到有带公网 IP 的 fnos 服务器，把 Release 里的
//   三个文件（exe / exe.blockmap / latest.yml）传上去，然后把下面这行加到
//   数组最前面即可全网走自己的通道：
//     { name: '自建服务器', url: 'https://你的域名/局域网沟通广播' }
// ============================================================================
const UPDATE_FEEDS = [
  { name: 'ghfast 加速', url: 'https://ghfast.top/' + GH_RELEASES },
  { name: 'GitHub 直连', url: GH_RELEASES }
]

// 探测单个源是否可用：只请求 latest.yml（几百字节），带超时。
// electron-updater 本身没有可配的请求超时，镜像被墙时会长时间挂起，
// 所以先用短超时快速探一遍，直接选中可用源，避免干等。
const PROBE_TIMEOUT = 4000
function probeFeed(url) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    try {
      const req = https.get(url + '/latest.yml', { timeout: PROBE_TIMEOUT }, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 400
        res.resume()
        finish(ok)
      })
      req.on('timeout', () => {
        req.destroy()
        finish(false)
      })
      req.on('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

// 按顺序探测，选中第一个可用的源；全都不通则保持当前源，交由错误流程上报
async function pickAvailableFeed() {
  for (let i = 0; i < UPDATE_FEEDS.length; i++) {
    if (await probeFeed(UPDATE_FEEDS[i].url)) {
      if (i !== feedIndex) applyFeed(i, '自动选择可用源')
      return UPDATE_FEEDS[i]
    }
    console.log(`[updater] 源不可用，跳过：${UPDATE_FEEDS[i].name}`)
  }
  return null
}

// 主窗口引用由 main.js 通过 getter 注入，便于窗口被重建（托盘恢复）后仍能推送事件
let winGetter = () => null

// 本次检查是否由用户手动触发。
// 自动检查（启动后延迟执行）失败通常是因为纯内网无外网、源不可达等，
// 这类失败不应打扰用户，只写控制台；手动点「检查更新」时才弹窗告知原因。
let manualCheck = false

// 当前使用的更新源下标；retrying 用于保证「一次检查最多切一次源」，避免死循环
let feedIndex = 0
let retrying = false

// 把更新事件统一通过该 channel 发送到渲染层，payload = { channel, data }
function send(channel, data) {
  const w = winGetter()
  if (w && !w.isDestroyed()) {
    w.webContents.send('updater:event', { channel, data })
  }
}

function feedInfo() {
  const f = UPDATE_FEEDS[feedIndex] || { name: '-', url: '' }
  return { name: f.name, url: f.url, index: feedIndex, total: UPDATE_FEEDS.length }
}

// 切换更新源：setFeedURL 传字符串即等价于 generic provider + 该 url
function applyFeed(index, reason) {
  feedIndex = Math.max(0, Math.min(index, UPDATE_FEEDS.length - 1))
  const f = UPDATE_FEEDS[feedIndex]
  autoUpdater.setFeedURL(f.url)
  console.log(
    `[updater] 更新源：${f.name}${reason ? '（' + reason + '）' : ''} -> ${f.url}`
  )
  send('feed', feedInfo())
  return f
}

// 尝试切到下一个源；没有下一个可用时返回 false
function switchToNextFeed() {
  if (feedIndex + 1 >= UPDATE_FEEDS.length) return false
  applyFeed(feedIndex + 1, '上一个源不可用，自动切换')
  return true
}

// GitHub Releases 的 releaseNotes 可能是字符串，也可能是
// [{ version, note }] 数组，这里归一化为纯文本便于展示。
function normalizeNotes(notes) {
  if (!notes) return ''
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : n.note || n.version || ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(notes)
}

export function setupAutoUpdater(getter) {
  if (typeof getter === 'function') winGetter = getter

  // 指定更新源（必须在第一次 checkForUpdates 之前）
  applyFeed(0)

  // ---- 事件转发 ----
  autoUpdater.on('checking-for-update', () => {
    retrying = false
    send('checking', { feed: feedInfo() })
  })

  autoUpdater.on('update-available', (info) => {
    retrying = false
    send('update-available', {
      version: info.version,
      releaseNotes: normalizeNotes(info.releaseNotes),
      releaseDate: info.releaseDate || null,
      feed: feedInfo()
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    retrying = false
    // 「没有新版本」在启动时的自动检查里属于常态，不该弹窗打扰用户，
    // 只写控制台即可；用户主动点「检查更新」时给明确的「已是最新版本」反馈。
    if (!manualCheck) {
      console.log(`[updater] 当前已是最新版本：${info.version}`)
      return
    }
    send('update-not-available', { version: info.version, feed: feedInfo() })
  })

  autoUpdater.on('download-progress', (p) => {
    send('download-progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
      feed: feedInfo()
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    retrying = false
    send('update-downloaded', {
      version: info.version,
      releaseNotes: normalizeNotes(info.releaseNotes),
      releaseDate: info.releaseDate || null,
      feed: feedInfo()
    })
  })

  autoUpdater.on('error', (e) => {
    const message = (e && e.message) || String(e)
    // 本轮已经切过一次源仍然失败 → 不再继续切，直接按结果收尾
    if (retrying) {
      retrying = false
      reportFailure(message)
      return
    }
    if (switchToNextFeed()) {
      retrying = true
      console.warn('[updater] 当前源不可用，切换后重试：', message)
      runCheck().catch(() => {
        /* 失败信息由 error 事件统一处理 */
      })
      return
    }
    reportFailure(message)
  })

  function reportFailure(message) {
    if (!manualCheck) {
      // 自动检查失败：静默处理，不弹窗（内网无外网等属正常情况）
      console.warn('[updater] 自动检查更新失败（已忽略）:', message)
      return
    }
    send('error', { message, feed: feedInfo() })
  }

  // 统一入口：先快速探测可用源，再交给 electron-updater 正式检查。
// 这样「镜像不通 → GitHub 兜底」的切换在几秒内完成，而不是等一次长超时。
async function runCheck() {
  await pickAvailableFeed()
  return autoUpdater.checkForUpdates()
}

// ---- 渲染层主动触发的 IPC ----
  ipcMain.handle('updater:check', async () => {
    // 开发模式（npm run dev）没有发布版本，跳过检查避免无意义报错
    if (!app.isPackaged) {
      send('dev-skip', {})
      return { skipped: true }
    }
    manualCheck = true
    retrying = false
    try {
      await runCheck()
      return { ok: true }
    } catch (e) {
      // 失败信息已由上面的 error 事件统一上报，这里只把结果回给调用方，避免重复弹窗
      return { error: (e && e.message) || String(e) }
    } finally {
      // 事件在 await 期间同步抛出，稍后再复位，确保 error 处理器读到 manualCheck=true
      setTimeout(() => {
        manualCheck = false
      }, 0)
    }
  })

  ipcMain.handle('updater:quit-install', () => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (e) {
      send('error', { message: (e && e.message) || String(e) })
    }
  })

  // 打包状态下，启动后延迟自动检查一次（不打扰启动，也避免频繁请求远端）
  if (app.isPackaged) {
    setTimeout(() => {
      runCheck().catch(() => {
        /* 失败静默：网络不可达、限流等都不应影响正常使用 */
      })
    }, 10000)
  }
}
