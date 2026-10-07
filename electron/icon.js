import { nativeImage, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 定位打包内置图标 assets/ico/app.ico：
//  - dev：app.getAppPath()/assets/ico/app.ico
//  - 打包后：extraResources 把 assets 拷贝到 resources/assets
function resolveIconPath() {
  const candidates = [
    join(app.getAppPath(), 'assets', 'ico', 'app.ico'),
    join(process.resourcesPath || '', 'assets', 'ico', 'app.ico'),
    join(__dirname, '../../assets/ico/app.ico'),
    join(__dirname, '../assets/ico/app.ico')
  ]
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) return p
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return null
}

// 应用图标（托盘 / 窗口标题栏 / 任务栏）。
// 优先使用 assets/ico/app.ico；文件缺失时降级为内置生成的蓝圆 PNG，避免崩溃。
export function getAppIcon() {
  const p = resolveIconPath()
  if (p) {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  }
  return createFallbackIcon()
}

// ===== 兜底：纯代码生成蓝底白心圆形 PNG（仅在找不到 app.ico 时启用）=====

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

// 将 RGBA 缓冲编码为合法 PNG（无外部依赖）
function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // 每行过滤字节
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = deflateSync(raw)
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function createFallbackIcon(size = 64) {
  const buf = Buffer.alloc(size * size * 4)
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = a
  }
  const cx = size / 2
  const cy = size / 2
  const rOuter = size * 0.42
  const rInner = size * 0.2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= rOuter) set(x, y, 37, 99, 235) // blue-600
      if (d <= rInner) set(x, y, 255, 255, 255) // 白心
    }
  }
  return nativeImage.createFromBuffer(encodePNG(size, size, buf))
}
