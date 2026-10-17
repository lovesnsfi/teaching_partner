// 录屏采集/编码模块（ffmpeg 主进程单遍方案）。
//
// 相比早期「渲染层 MediaRecorder 录 webm → 主进程再转 mp4」的实现，本方案：
//   - 屏幕用 gdigrab / ddagrab（桌面复制 API，GPU 直采，CPU 极低）采集；
//   - 摄像头用 dshow 视频设备；
//   - 麦克风用 dshow 音频输入，系统声音用 wasapi loopback（比 Chromium
//     desktopCapturer 的 withAudio 在 Windows 上可靠得多）；
//   - 摄像头画中画用 ffmpeg overlay 滤镜叠加；麦克风与系统声音分成两条独立音轨（各编一条 AAC）；
//   - 视频只编码一次：H264（N 卡走 h264_nvenc 硬加速，否则 libx264），
//     直接写成最终 mp4，边录边落盘，不占用大块内存。
//
// 暂停 / 继续：采用「分片录制」。暂停时把当前分片定稿为 .segN.mp4，继续时开一条
// 新的 ffmpeg 录下一段；停止时再把这些分片 concat 拼成一份最终 mp4（每个分片首帧
// 强制关键帧，保证拼接无缝；流拷贝失败时自动退回重新编码拼接）。
//
// ffmpeg 依赖在调用时才动态导入，避免未安装时拖垮整个应用启动。
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import { join } from 'node:path'
import { rename, mkdir } from 'node:fs/promises'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'

let _ffmpegPath = null
let _ddagrab = null
let _nvenc = null
let _nvencNewPreset = false // true 表示支持 p1-p7 新 preset（新版 ffmpeg），否则用旧版 fast/constqp
let _featuresChecked = false
let _encoder = null // 探测后选定的编码器 { vc, args }

// 当前 ffmpeg 子进程（仅在「正在录制」时存在；暂停时无进程）
let _proc = null
let _tmpPath = null
let _outPath = null
let _devicesCache = null

// ===== 分片（暂停 / 继续）相关状态 =====
let _paused = false // 是否已暂停（暂停时无 _proc，但录制会话仍在进行）
let _lastOpts = null // 暂停时缓存的录制参数，继续时复用
let _segDir = '' // 保存目录
let _baseName = '' // 文件名主干部（如 录制-20261017-203400）
let _segments = [] // 已定稿的分片路径数组（.segN.mp4）
let _segIndex = -1 // 当前正在录制的分片序号

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

// ===== 设备解析 / 系统声音可用性探测 / 音量电平监测 =====

// 解析本次要用的麦克风设备（空=自动选第一个输入设备）
function resolveMicDevice(opts, devs) {
  if (!opts || !opts.mic) return null
  const dev = opts.micDevice || devs.audioInput[0]
  return dev ? { dev } : null
}

// 解析本次要用的系统声音设备：优先 wasapi loopback，其次 dshow「立体声混音」。
// 返回 { dev, isDshow }；isDshow=true 表示该设备其实是 dshow 输入（老版 ffmpeg 无 wasapi）。
function resolveSystemDevice(opts, devs) {
  if (!opts || !opts.systemAudio) return null
  const dev = opts.systemDevice || devs.audioLoopback[0]
  if (!dev) return null
  const micDev = opts.mic ? opts.micDevice || devs.audioInput[0] : null
  // 与麦克风同一个设备则不重复打开（避免 dshow 抢占导致启动失败）
  if (dev === micDev) return null
  const isDshow = devs.audioInput.includes(dev)
  return { dev, isDshow }
}

// 用与正式录制完全相同的采集方式短采一小段，验证系统声音设备是否真的能打开、
// 是否有信号。返回 { ok, silent?, reason?, maxVolume? }。
// ok=false 表示设备打不开（这才是"不可用"，应提示用户而不是录出静音）；
// ok=true 但 silent=true 表示设备能开、当前却没信号（系统可能只是没在放声音），仍继续录。
async function probeSystemAudio(sys) {
  if (!sys) return { ok: false, reason: '未选择系统声音设备' }
  const p = await ffmpegPath()
  const inputArgs = sys.isDshow
    ? ['-f', 'dshow', '-i', `audio="${sys.dev}"`]
    : ['-f', 'wasapi', '-i', sys.dev]
  const args = [
    '-hide_banner',
    ...inputArgs,
    '-t', '0.6',
    '-af', 'volumedetect',
    '-f', 'null',
    '-'
  ]
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let proc
    try {
      proc = spawn(p, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      return done({ ok: false, reason: (e && e.message) || String(e) })
    }
    let err = ''
    proc.stderr.on('data', (d) => {
      err += d.toString()
      if (err.length > 8000) err = err.slice(-8000)
    })
    proc.on('error', (e) => done({ ok: false, reason: (e && e.message) || String(e) }))
    proc.on('exit', (code) => {
      if (code === 0 || code === null) {
        const m = err.match(/max_volume:\s*(-?[\d.]+)\s*dB/)
        const maxV = m ? parseFloat(m[1]) : -91
        done({ ok: true, silent: maxV <= -91, maxVolume: maxV })
      } else {
        done({ ok: false, reason: briefError(err) || '设备打开失败' })
      }
    })
    // 兜底超时：8s
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      done({ ok: false, reason: '探测超时' })
    }, 8000)
  })
}

// ===== 系统音量电平监测（驱动悬浮球波形随真实音量跳动）=====
// 起一个低采样率(8kHz 单声道)的 wasapi 环流采集进程，把 PCM 喂给 Node 算 RMS，
// 通过回调以 ~10Hz 抛出 0..1 的电平。仅 wasapi 支持与录制进程并发环流；
// dshow「立体声混音」无法并发打开，故该路径跳过（悬浮球回退模拟动画）。
let _levelProc = null
let _levelBuf = Buffer.alloc(0)
let _levelCb = null
let _levelTimer = null

export function onLevel(cb) {
  _levelCb = cb
}

function startLevelMonitor(sys) {
  stopLevelMonitor()
  if (!sys || sys.isDshow) return
  ;(async () => {
    const p = await ffmpegPath()
    const args = [
      '-hide_banner',
      '-f', 'wasapi',
      '-i', sys.dev,
      '-ac', '1',
      '-ar', '8000',
      '-f', 's16le',
      'pipe:1'
    ]
    let proc
    try {
      proc = spawn(p, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return
    }
    _levelProc = proc
    proc.on('error', () => {
      _levelProc = null
    })
    proc.on('exit', () => {
      if (_levelProc === proc) _levelProc = null
      if (_levelTimer) {
        clearInterval(_levelTimer)
        _levelTimer = null
      }
    })
    proc.stdout.on('data', (d) => {
      // 只保留最近 ~400ms，避免内存无谓增长
      _levelBuf = Buffer.concat([_levelBuf, d])
      if (_levelBuf.length > 6400) _levelBuf = _levelBuf.slice(-3200)
    })
    _levelTimer = setInterval(() => {
      if (!_levelProc || !_levelCb) return
      const n = _levelBuf.length
      if (n < 2) return
      // 取最近 1600 字节（100ms）算 RMS，降低延迟
      const chunk = n > 1600 ? _levelBuf.slice(n - 1600) : _levelBuf
      let sum = 0
      let cnt = 0
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        const s = chunk.readInt16LE(i) / 32768
        sum += s * s
        cnt++
      }
      if (!cnt) return
      const rms = Math.sqrt(sum / cnt)
      const level = Math.min(1, rms * 3.2) // 适度增益，让轻柔的声音也可见
      try {
        _levelCb(level)
      } catch {
        /* ignore */
      }
    }, 100)
  })()
}

function stopLevelMonitor() {
  if (_levelTimer) {
    clearInterval(_levelTimer)
    _levelTimer = null
  }
  if (_levelProc) {
    try {
      _levelProc.kill()
    } catch {
      /* ignore */
    }
    _levelProc = null
  }
  _levelBuf = Buffer.alloc(0)
}

// 真正拉起一条 ffmpeg 子进程，录制一个分片（.tmp.mp4）。
// 分片文件名 / 保存目录 / 最终文件名在 startRecording 里确定，这里只负责「采 + 编 + 落盘」。
async function _beginSegment(opts) {
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
  const mic = resolveMicDevice(opts, devs)
  if (mic) {
    micIdx = next++
    args.push('-f', 'dshow', '-i', `audio="${mic.dev}"`)
  }

  // 系统声音（可选）：优先 wasapi loopback；若该设备其实是 dshow 输入
  // （老版 ffmpeg 没有 wasapi，只能靠「立体声混音」这类 dshow 设备），则用 dshow 采集
  let sysIdx = -1
  const sys = resolveSystemDevice(opts, devs)
  if (sys) {
    sysIdx = next++
    if (sys.isDshow) {
      args.push('-f', 'dshow', '-i', `audio="${sys.dev}"`)
    } else {
      args.push('-f', 'wasapi', '-i', sys.dev)
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

  // ---- 音频：麦克风 / 系统声音分成两条独立音轨（后期可分别调音量）----
  // 不再 amix 合流；分别 -map 成两条输出流，各编一条 AAC。
  // 映射顺序固定为先麦克风、后系统声音，故最终 mp4 中：音轨 0 = 麦克风，音轨 1 = 系统声音。
  const audioMaps = [] // 原始输入流规格，如 '1:a'
  if (micIdx >= 0) audioMaps.push(`${micIdx}:a`)
  if (sysIdx >= 0) audioMaps.push(`${sysIdx}:a`)

  const hasFilter = filters.length > 0
  if (hasFilter) args.push('-filter_complex', filters.join(';'))
  args.push('-map', hasFilter ? `[${vlabel}]` : vlabel)
  for (const am of audioMaps) args.push('-map', am)

  // ---- 编码：开录前先实编一帧验证过硬件编码器真的可用，避免开录瞬间失败 ----
  const enc = await pickEncoder(p)
  const vc = enc.vc
  args.push('-c:v', vc, ...enc.args)
  // 每个分片首帧强制关键帧（n=0），保证 concat 流拷贝拼接时各分片可独立解码、衔接无缝
  args.push('-force_key_frames', 'expr:eq(n,0)')
  args.push('-pix_fmt', 'yuv420p')
  if (audioMaps.length) args.push('-c:a', 'aac', '-b:a', '192k')
  args.push('-movflags', '+faststart')

  // ---- 输出：当前分片写入 .tmp.mp4，暂停 / 停止时再定稿 / 拼接 ----
  _tmpPath = join(_segDir, `${_baseName}.seg${_segIndex}.tmp.mp4`)
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
        const logPath = join(_segDir, 'ffmpeg-错误日志.txt')
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
      return _beginSegment(opts)
    }
    throw err
  })
}

// 停止当前正在录制的分片：向 ffmpeg 写 'q' 优雅退出，退出后把 .tmp.mp4 定稿为 finalPath。
// 返回 Promise<boolean> 是否成功定稿。
function stopCurrent(finalPath) {
  return new Promise((resolve) => {
    const proc = _proc
    if (!proc) return resolve(false)
    _proc = null
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      resolve(ok)
    }
    proc.on('exit', (code) => {
      if (code === 0 || code === null) {
        rename(_tmpPath, finalPath)
          .then(() => finish(true))
          .catch(() => finish(false))
      } else {
        finish(false)
      }
    })
    try {
      proc.stdin.write('q')
    } catch {
      /* ignore */
    }
    // 兜底：20s 仍未退出则判定失败
    setTimeout(() => finish(false), 20000)
  })
}

// 把若干分片拼接为最终 mp4：优先流拷贝（快、不重编码）；失败则退回重新编码拼接。
async function concatSegments() {
  const p = await ffmpegPath()
  const listPath = join(_segDir, `${_baseName}.concat.txt`)
  const list = _segments.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n')
  try {
    writeFileSync(listPath, list, 'utf8')
  } catch (e) {
    return { ok: false, error: String(e) }
  }
  const run = (extra) =>
    new Promise((resolve) => {
      const args = [
        '-hide_banner',
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        ...extra,
        _outPath
      ]
      const proc = spawn(p, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let errBuf = ''
      proc.stderr.on('data', (d) => {
        errBuf += d.toString()
        if (errBuf.length > 8000) errBuf = errBuf.slice(-8000)
      })
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        try {
          unlinkSync(listPath)
        } catch {
          /* ignore */
        }
        resolve(ok ? { ok: true, path: _outPath } : { ok: false, error: briefError(errBuf) })
      }
      proc.on('exit', (code) => {
        if (code === 0 || code === null) finish(true)
        else finish(false)
      })
      // 拼接通常秒级完成，给 30s 兜底
      setTimeout(() => finish(false), 30000)
    })
  const copy = await run(['-c', 'copy'])
  if (copy.ok) return copy
  // 流拷贝拼接失败（极少见：分片首帧仍非关键帧、或音视频参数不完全一致），
  // 退回重新编码拼接，保证一定能出片（代价是慢一点）。
  console.log('[recorder] 分片流拷贝拼接失败，退回重新编码拼接')
  return run([
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart'
  ])
}

function cleanupSegments() {
  for (const f of _segments) {
    try {
      unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
}

// 开始录制。opts: { source:{type:'screen'|'window', index?, title?}, fps,
//   width, height, mic, micDevice, systemAudio, systemDevice, camera, cameraDevice,
//   saveDir }
export async function startRecording(opts = {}) {
  if (isActive()) throw new Error('已有录制在进行中')
  const o = { ...opts } // 浅拷贝：探测后若要关闭系统声音，只改副本，不写回上层 store 配置
  const warnings = []
  // 开录前探测系统声音是否真的可用，避免录出一条静音音轨
  if (o.systemAudio) {
    const devs = await listAvDevices()
    const sys = resolveSystemDevice(o, devs)
    if (!sys) {
      warnings.push('未检测到可用的系统声音设备（环流 / 立体声混音），本次不录制系统声音。')
      o.systemAudio = false
    } else {
      const pr = await probeSystemAudio(sys)
      if (pr && pr.ok === false) {
        warnings.push(`系统声音设备不可用（${pr.reason || '无法打开'}），本次不录制系统声音。`)
        o.systemAudio = false
      }
      // pr.ok===true（即使当前静音）仍保留：系统可能稍后才播放声音
    }
  }
  const baseDir =
    o.saveDir && existsSync(o.saveDir)
      ? o.saveDir
      : join(os.homedir(), 'Videos', '局域网沟通广播')
  await mkdir(baseDir, { recursive: true }).catch(() => {})
  const ts = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const stamp = `${ts.getFullYear()}${p2(ts.getMonth() + 1)}${p2(
    ts.getDate()
  )}-${p2(ts.getHours())}${p2(ts.getMinutes())}${p2(ts.getSeconds())}`
  _segDir = baseDir
  _baseName = `录制-${stamp}`
  _outPath = join(baseDir, `${_baseName}.mp4`)
  _segments = []
  _segIndex = 0
  _paused = false
  _lastOpts = o
  await _beginSegment(o)
  // 启动系统音量电平监测（驱动悬浮球波形随真实音量跳动）；仅 wasapi 路径生效，
  // 失败 / 不支持并发环流时静默跳过，不影响录制。
  try {
    const devs2 = await listAvDevices()
    startLevelMonitor(resolveSystemDevice(o, devs2))
  } catch {
    /* ignore */
  }
  return { ok: true, warnings }
}

// 暂停录制：把当前分片定稿，ffmpeg 子进程退出；继续时再开新分片。
// 注意：暂停后 _proc 为 null，但 _paused=true、_segments 已有内容，录制会话仍视为进行中。
export async function pauseRecording() {
  if (!_proc || _paused) return { ok: false, error: '当前不在录制中' }
  _paused = true
  const idx = _segIndex
  const finalPath = join(_segDir, `${_baseName}.seg${idx}.mp4`)
  const ok = await stopCurrent(finalPath)
  if (ok) {
    _segments.push(finalPath)
    return { ok: true }
  }
  _paused = false
  return { ok: false, error: '暂停失败' }
}

// 继续录制：开启下一个分片（复用暂停时缓存的参数）。
export async function resumeRecording() {
  if (!_paused) return { ok: false, error: '当前未在暂停状态' }
  if (!_lastOpts) return { ok: false, error: '缺少录制参数' }
  _paused = false
  _segIndex += 1
  try {
    return await _beginSegment(_lastOpts)
  } catch (e) {
    _paused = true
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 停止录制：定稿当前分片 → 把全部分片拼接成最终 mp4 → 清理分片。
// 返回 { ok, path }（path 为最终 mp4 路径）。
export async function stopRecording() {
  if (!isActive()) return { ok: false, error: '当前没有录制' }
  // 若仍在录制（未暂停），先把当前分片定稿
  if (_proc) {
    const idx = _segIndex
    const finalPath = join(_segDir, `${_baseName}.seg${idx}.mp4`)
    const ok = await stopCurrent(finalPath)
    if (ok) _segments.push(finalPath)
  }
  if (_segments.length === 0) {
    return { ok: false, error: '没有可保存的录制内容' }
  }
  let result
  if (_segments.length === 1) {
    try {
      await rename(_segments[0], _outPath)
      result = { ok: true, path: _outPath }
    } catch (e) {
      result = { ok: false, error: String(e) }
    }
  } else {
    result = await concatSegments()
  }
  if (result && result.ok) cleanupSegments()
  // 无论成败都重置状态，避免下一次 startRecording 误判「已有录制」
  _segments = []
  _segIndex = -1
  _paused = false
  _lastOpts = null
  _outPath = null
  _tmpPath = null
  stopLevelMonitor()
  return result || { ok: false, error: '未知错误' }
}

export function isRecording() {
  return !!_proc
}

// 「录制会话是否进行中」：正在录制、已暂停、或有已定稿分片，都算进行中。
// 退出确认 / 停止 IPC 的判定用这个，避免暂停状态下误判为「没在录」。
export function isActive() {
  return !!_proc || _paused || _segments.length > 0
}

export function isPaused() {
  return _paused
}

// 强制结束录制（更新安装前调用）：立刻杀掉 ffmpeg 进程，不做定稿 / 不拼接 / 不 rename，
// 并清掉已落盘的分片，避免残留半截 mp4。
// 应用退出时若留着 ffmpeg 子进程，它会继续占用磁盘并写出一个残缺的 mp4。
export function killRecording() {
  if (_proc) {
    try {
      _proc.kill()
    } catch {
      /* ignore */
    }
    _proc = null
  }
  // 清掉已定稿的分片与正在写的临时文件
  for (const f of _segments) {
    try {
      unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
  if (_tmpPath) {
    try {
      unlinkSync(_tmpPath)
    } catch {
      /* ignore */
    }
  }
  _segments = []
  _segIndex = -1
  _paused = false
  _lastOpts = null
  _tmpPath = null
  _outPath = null
  stopLevelMonitor()
  return true
}
