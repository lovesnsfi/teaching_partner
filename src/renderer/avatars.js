// 内置头像：用 SVG 生成的彩色笑脸，无需任何二进制图片资源
// 既能离线使用，又便于局域网内直接以 data URI 形式同步给其它终端

const COLORS = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316'  // orange
]

function svgFace(bg) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'>` +
    `<rect width='96' height='96' rx='48' fill='${bg}'/>` +
    `<circle cx='36' cy='40' r='6' fill='#ffffff'/>` +
    `<circle cx='60' cy='40' r='6' fill='#ffffff'/>` +
    `<path d='M32 58 Q48 72 64 58' stroke='#ffffff' stroke-width='5' fill='none' stroke-linecap='round'/>` +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

export const BUILTIN_AVATARS = COLORS.map((c, i) => ({
  id: 'b' + i,
  color: c,
  data: svgFace(c)
}))

export function builtinSrc(id) {
  const b = BUILTIN_AVATARS.find((x) => x.id === id)
  return b ? b.data : null
}

// 文字头像背景色：基于名字做稳定哈希，保证同一人颜色一致
const TEXT_COLORS = COLORS
export function colorForName(name) {
  const n = (name || '').trim()
  if (!n) return '#94a3b8'
  let h = 0
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0
  return TEXT_COLORS[h % TEXT_COLORS.length]
}
