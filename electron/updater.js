import { autoUpdater } from 'electron-updater'
import { app, ipcMain } from 'electron'

// 自动下载：发现新版本后立即开始下载（配合下面的进度/完成事件给 UI 反馈）
autoUpdater.autoDownload = true
// 退出时若已下载完成则自动安装（用户选「稍后」时，下次程序退出自动装）
autoUpdater.autoInstallOnAppQuit = true

// 主窗口引用由 main.js 通过 getter 注入，便于窗口被重建（托盘恢复）后仍能推送事件
let winGetter = () => null

// 把更新事件统一通过该 channel 发送到渲染层，payload = { channel, data }
function send(channel, data) {
  const w = winGetter()
  if (w && !w.isDestroyed()) {
    w.webContents.send('updater:event', { channel, data })
  }
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

  // ---- 事件转发 ----
  autoUpdater.on('checking-for-update', () => send('checking', {}))

  autoUpdater.on('update-available', (info) => {
    send('update-available', {
      version: info.version,
      releaseNotes: normalizeNotes(info.releaseNotes),
      releaseDate: info.releaseDate || null
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    send('update-not-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (p) => {
    send('download-progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send('update-downloaded', {
      version: info.version,
      releaseNotes: normalizeNotes(info.releaseNotes)
    })
  })

  autoUpdater.on('error', (e) => {
    send('error', { message: (e && e.message) || String(e) })
  })

  // ---- 渲染层主动触发的 IPC ----
  ipcMain.handle('updater:check', async () => {
    // 开发模式（npm run dev）没有发布版本，跳过检查避免无意义报错
    if (!app.isPackaged) {
      send('dev-skip', {})
      return { skipped: true }
    }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (e) {
      send('error', { message: (e && e.message) || String(e) })
      return { error: (e && e.message) || String(e) }
    }
  })

  ipcMain.handle('updater:quit-install', () => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (e) {
      send('error', { message: (e && e.message) || String(e) })
    }
  })

  // 打包状态下，启动后延迟自动检查一次（不打扰启动，也避免频繁请求 GitHub）
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {
        /* 失败静默：网络不可达、限流等都不应影响正常使用 */
      })
    }, 10000)
  }
}
