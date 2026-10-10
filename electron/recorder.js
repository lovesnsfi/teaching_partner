// 录屏采集/编码模块（ffmpeg 主进程单遍方案）。
//
// 相比早期「渲染层 MediaRecorder 录 webm → 主进程再转 mp4」的实现，本方案：
//   - 屏幕用 gdigrab / ddagrab（桌面复制 API，GPU 直采，CPU 极低）采集；
//   - 摄像头用 dshow 视频设备；
//   - 麦克风用 dshow 音频输入，系统声音用 wasapi loopback（比 Chromium
//     desktopCapturer 的 withAudio 在 Windows 上可靠得多）；
//   - 摄像头画中画用 ffmpeg overlay 滤镜叠加，麦克风+系统声音用 amix 混音；
//   - 视频只编码一次：H264（N 卡走 h264_nvenc 硬加速，否则 libx264），
//     直接写成最终 mp4，边录边落盘，不占用大块内存。
//
// ffmpeg 依赖在调用时才动态导入，避免未安装时拖垮整个应用启动。
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import { join } from 'node:path'
import { rename, mkdir } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

let _ffmpegPath = null
let _ddagrab = null
let _nvenc = null
let _nvencNewPreset = false // true 表示支持 p1-p7 新 preset（新版 ffmpeg），否则用旧版 fast/constqp
let _featuresChecked = false
let _encoder = null // 探测后选定的编码器 { vc, args }

let _proc = null
let _tmpPath = null
let _outPath = null
let _devicesCache = null

async function ffmpegPath() {
  if (_ffmpegPath) return _ffmpegPath
  const installer = await import('@ffmpeg-installer/ffmpeg')
  _ffmpegPath = installer.default.path
  return _ffmpegPath
}

// 探测本机 ffmpeg 能力：是否支持 ddagrab（桌面复制，低 CPU）与 h264_nvenc（N 卡硬加速）
function checkFeatures(p) {
  if (_featuresChecked) return
  _featuresChecked = true
  try {
    const d = execSync(`"${p}" -hide_banner -devices`, {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString()
    _ddagrab = /ddagrab/.test(d)
  } catch {
    _ddagrab = false
  }
  try {
    const e = execSync(`"${p}" -hide_banner -encoders`, {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString()
    _nvenc = /h264_nvenc/.test(e)
  } catch {
    _nvenc = false
  }
  // 探测 NVENC 支持的 preset 风格，避免老版 ffmpeg 不认识 p4 / cq 等参数
  if (_nvenc) {
    try {
      const h = execSync(`"${p}" -hide_banner -h encoder=h264_nvenc`, {
        stdio: ['ignore', 'pipe', 'ignore']
      }).toString()
      _nvencNewPreset = /\bp4\b/.test(h)
    } catch {
      _nvencNewPreset = false
    }
  }
}

// 用一段 0.1s 的合成视频试编一帧，验证编码器在这台机器上真的能用。
// 关键：ffmpeg -encoders 里列出 h264_nvenc ≠ 真能用（没有 N 卡 / 驱动不匹配时会失败），
// 所以必须实编一帧才能确定，否则开录瞬间才炸。
function probeEncoder(p, vc, vcArgs) {
  try {
    const r = spawnSync(
      p,
      [
        '-hide_banner',
        '-f', 'lavfi',
        '-i', 'color=c=black:s=640x480:d=0.1',
        '-c:v', vc,
        ...vcArgs,
        '-f', 'null',
        '-'
      ],
      { stdio: 'ignore', timeout: 15000, windowsHide: true }
    )
    return r.status === 0
  } catch {
    return false
  }
}

// 选定本次录制使用的编码器：优先硬件加速，逐个试编验证，最后兜底 libx264
async function pickEncoder(p) {
  if (_encoder) return _encoder
  const nvencArgs = _nvencNewPreset
    ? ['-preset', 'p4', '-rc', 'vbr', '-cq', '23']
    : ['-preset', 'fast', '-rc', 'constqp', '-qp', '23']
  const candidates = []
  if (_nvenc) candidates.push({ vc: 'h264_nvenc', args: nvencArgs })
  candidates.push({ vc: 'h264_qsv', args: ['-preset', 'veryfast'] })
  candidates.push({ vc: 'h264_amf', args: ['-quality', 'balanced'] })
  candidates.push({ vc: 'libx264', args: ['-preset', 'veryfast', '-crf', '23'] })

  for (const c of candidates) {
    if (probeEncoder(p, c.vc, c.args)) {
      console.log(`[recorder] 编码器探测通过：${c.vc}`)
      _encoder = c
      return _encoder
    }
    console.log(`[recorder] 编码器不可用，跳过：${c.vc}`)
  }
  // 理论上到不了这里；真到不了就强制 libx264
  _encoder = { vc: 'libx264', args: ['-preset', 'veryfast', '-crf', '23'] }
  return _encoder
}

// 把 ffmpeg 的 stderr 收拾成能看的短信息：砍掉版本/编译参数横幅，只留末尾几行
function briefError(errBuf) {
  const lines = String(errBuf).split(/\r?\n/)
  // 丢掉 banner 与 configuration 行（它们能占掉上千字符）
  const ci = lines.findIndex((l) => l.includes('configuration:'))
  const cleaned = (ci >= 0 ? lines.slice(ci + 1) : lines).filter((l) =>
    l.trim()
  )
  const tail = cleaned.slice(-6)
  return (tail.length ? tail : cleaned.slice(-3)).join(' | ')
}

// 枚举音视频设备：视频(dshow)、麦克风输入(dshow)、系统声音(wasapi loopback)
export async function listAvDevices() {
  if (_devicesCache) return _devicesCache
  const p = await ffmpegPath()
  const video = []
  const audioInput = []
  const audioLoopback = []
  try {
    const out = execSync(
      `"${p}" -hide_banner -list_devices true -f dshow -i dummy`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString()
    let section = ''
    for (const l of out.split('\n')) {
      // 注意：不同版本 ffmpeg 的段落标题不同：
      // 新版是 "DirectShow audio capture devices"，老版是 "DirectShow audio devices"
      if (/DirectShow video devices/.test(l)) section = 'v'
      else if (/DirectShow audio/.test(l)) section = 'a'
      else {
        const m = l.match(/"([^"]+)"/)
        if (m) {
          if (section === 'v') video.push(m[1])
          else if (section === 'a') audioInput.push(m[1])
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const out = execSync(`"${p}" -hide_banner -list_devices true -f wasapi -i ""`, {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString()
    for (const l of out.split('\n')) {
      const m = l.match(/"([^"]+)"/)
      if (m) audioLoopback.push(m[1])
    }
  } catch {
    /* ignore */
  }
  // 老版 ffmpeg 不带 wasapi（无法 loopback 抓系统声音），
  // 此时退而求其次：在 dshow 音频设备里找「立体声混音 / Stereo Mix / What U Hear」这类设备。
  if (!audioLoopback.length) {
    const pat = /混音|stereo\s*mix|what\s*u\s*hear|wave\s*out|loopback|speakers?/i
    for (const d of audioInput) {
      if (pat.test(d)) audioLoopback.push(d)
    }
  }
  _devicesCache = { video, audioInput, audioLoopback }
  return _devicesCache
}

// 开始录制。opts: { source:{type:'screen'|'window', index?, title?}, fps,
//   width, height, mic, micDevice, systemAudio, systemDevice, camera, cameraDevice,
//   saveDir }
export async function startRecording(opts = {}) {
  if (_proc) throw new Error('已有录制在进行中')
  const p = await ffmpegPath()
  checkFeatures(p)
  const fps = opts.fps || 30
  const args = []

  // 0: 屏幕 / 窗口
  if (opts.source && opts.source.type === 'window') {
    args.push('-f', 'gdigrab', '-framerate', String(fps), '-i', `title=${opts.source.title}`)
  } else if (_ddagrab) {
    const idx = opts.source && typeof opts.source.index === 'number' ? opts.source.index : 0
    args.push('-f', 'lavfi', '-i', `ddagrab=output=${idx}:framerate=${fps}`)
  } else {
    args.push('-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop')
  }

  // 后续输入依次编号
  let next = 1
  const devs = await listAvDevices()

  // 1: 摄像头（可选）
  let camIdx = -1
  if (opts.camera) {
    const dev = opts.cameraDevice || devs.video[0]
    if (dev) {
      camIdx = next++
      args.push('-f', 'dshow', '-i', `video="${dev}"`)
    }
  }

  // 麦克风（可选）
  let micIdx = -1
  if (opts.mic) {
    const dev = opts.micDevice || devs.audioInput[0]
    if (dev) {
      micIdx = next++
      args.push('-f', 'dshow', '-i', `audio="${dev}"`)
    }
  }

  // 系统声音（可选）：优先 wasapi loopback；若该设备其实是 dshow 输入
  // （老版 ffmpeg 没有 wasapi，只能靠「立体声混音」这类 dshow 设备），则用 dshow 采集
  let sysIdx = -1
  if (opts.systemAudio) {
    const dev = opts.systemDevice || devs.audioLoopback[0]
    const micDev = opts.mic ? opts.micDevice || devs.audioInput[0] : null
    // 与麦克风是同一个设备时不重复打开，避免 dshow 抢占导致启动失败
    if (dev && dev !== micDev) {
      sysIdx = next++
      if (devs.audioInput.includes(dev)) {
        args.push('-f', 'dshow', '-i', `audio="${dev}"`)
      } else {
        args.push('-f', 'wasapi', '-i', dev)
      }
    }
  }

  // ---- 滤镜图：分辨率缩放 + 摄像头画中画 ----
  // 注意：只有真正建了 filter_complex 时才能用 [label] 形式映射输出；
  // 没有滤镜时必须映射裸流规格（如 0:v），否则 ffmpeg 会报
  // "Output with label '0:v' does not exist in any defined filter graph"。
  const filters = []
  let vlabel = '0:v' // 裸流规格；有滤镜后改为滤镜图内的输出标签名
  if (opts.width && opts.height) {
    filters.push(`[${vlabel}]scale=${opts.width}:${opts.height}[sv]`)
    vlabel = 'sv'
  }
  if (camIdx >= 0) {
    const baseW = opts.width || 1920
    const cw = Math.round(baseW / 4)
    filters.push(`[${camIdx}:v]scale=${cw}:-1[cam]`)
    filters.push(`[${vlabel}][cam]overlay=W-w-16:H-h-16[vout]`)
    vlabel = 'vout'
  }

  // ---- 音频混音 ----
  const aIns = []
  if (micIdx >= 0) aIns.push(`${micIdx}:a`)
  if (sysIdx >= 0) aIns.push(`${sysIdx}:a`)
  let alabel = null
  if (aIns.length === 2) {
    filters.push(
      `[${aIns[0]}][${aIns[1]}]amix=inputs=2:duration=longest[aout]`
    )
    alabel = 'aout'
  } else if (aIns.length === 1) {
    alabel = aIns[0]
  }

  const hasFilter = filters.length > 0
  if (hasFilter) args.push('-filter_complex', filters.join(';'))
  args.push('-map', hasFilter ? `[${vlabel}]` : vlabel)
  if (alabel) args.push('-map', hasFilter ? `[${alabel}]` : alabel)

  // ---- 编码：开录前先实编一帧验证过硬件编码器真的可用，避免开录瞬间失败 ----
  const enc = await pickEncoder(p)
  const vc = enc.vc
  args.push('-c:v', vc, ...enc.args)
  args.push('-pix_fmt', 'yuv420p')
  if (alabel) args.push('-c:a', 'aac', '-b:a', '192k')
  args.push('-movflags', '+faststart')

  // ---- 输出：先写临时文件，停止后 rename 为最终 mp4 ----
  const baseDir =
    opts.saveDir && existsSync(opts.saveDir)
      ? opts.saveDir
      : join(os.homedir(), 'Videos', '局域网沟通广播')
  await mkdir(baseDir, { recursive: true }).catch(() => {})
  const ts = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const stamp = `${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(
    ts.getDate()
  )}-${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}`
  _outPath = join(baseDir, `录制-${stamp}.mp4`)
  _tmpPath = join(baseDir, `录制-${stamp}.tmp.mp4`)
  args.push('-y', _tmpPath)

  // 调试用：把完整命令行打印到主进程控制台，方便排错
  console.log('[recorder] ffmpeg command:', p, args.join(' '))

  const promise = new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn(p, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      return reject(e)
    }
    _proc = proc
    let errBuf = ''
    proc.stderr.on('data', (d) => {
      errBuf += d.toString()
      // 内存不会无限增长：只保留最后 8000 字符
      if (errBuf.length > 8000) errBuf = errBuf.slice(-8000)
    })
    proc.on('error', (e) => {
      _proc = null
      reject(e)
    })
    // 启动宽限：1.2s 内未异常退出即认为已正常开始
    const kick = setTimeout(() => resolve({ ok: true }), 1200)
    proc.on('exit', (code) => {
      if (_proc === proc && code !== null && code !== 0) {
        clearTimeout(kick)
        _proc = null
        // 完整 stderr 落盘，方便事后查因；界面只显示精简后的关键几行
        const logPath = join(baseDir, 'ffmpeg-错误日志.txt')
        try {
          writeFileSync(
            logPath,
            `命令：${p} ${args.join(' ')}\n\n${errBuf}`,
            'utf8'
          )
        } catch {
          /* ignore */
        }
        console.error('[recorder] ffmpeg 启动失败，完整日志：' + logPath)
        reject(
          new Error(
            `ffmpeg 启动失败（编码器 ${vc}）：${briefError(errBuf)}｜详见 ${logPath}`
          )
        )
      }
    })
  })

  return promise.catch(async (err) => {
    // 硬件编码器在真实录制时仍失败（如分辨率/驱动限制），自动降级到 libx264 重试一次
    if (vc !== 'libx264') {
      console.log('[recorder] 编码器 ' + vc + ' 录制启动失败，降级到 libx264：', err.message)
      _encoder = { vc: 'libx264', args: ['-preset', 'veryfast', '-crf', '23'] }
      return startRecording(opts)
    }
    throw err
  })
}

// 停止录制：向 ffmpeg 标准输入写入 'q' 优雅退出，结束后把临时文件改名为最终 mp4
export async function stopRecording() {
  if (!_proc) throw new Error('当前没有录制')
  const proc = _proc
  _proc = null
  return new Promise((resolve) => {
    let done = false
    const finish = (ok, error) => {
      if (done) return
      done = true
      if (ok && _tmpPath && _outPath) {
        rename(_tmpPath, _outPath)
          .then(() => resolve({ ok: true, path: _outPath }))
          .catch((e) => resolve({ ok: false, error: String(e) }))
      } else {
        resolve({ ok: false, error: error || '未知错误' })
      }
    }
    proc.on('exit', (code) => {
      if (code === 0 || code === null) finish(true)
      else finish(false, 'ffmpeg 退出码 ' + code)
    })
    try {
      proc.stdin.write('q')
    } catch {
      /* ignore */
    }
    // 兜底：20s 仍未退出则判定失败
    setTimeout(() => finish(false, '停止超时'), 20000)
  })
}

export function isRecording() {
  return !!_proc
}

// 强制结束录制（更新安装前调用）：立刻杀掉 ffmpeg 进程，不做定稿、不 rename。
// 应用退出时若留着 ffmpeg 子进程，它会继续占用磁盘并写出一个残缺的 mp4。
export function killRecording() {
  if (!_proc) return false
  const proc = _proc
  _proc = null
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  _tmpPath = null
  _outPath = null
  return true
}
