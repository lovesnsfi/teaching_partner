// 头像系统：使用 assets/avatar 目录下的打包内置头像（图片），
// 取代原先自绘的 SVG 头像。
//
// 设计要点：
// - 头像图片由主进程读取成 base64 后通过 getAvatars() 下发给渲染进程，
//   列表存于响应式 avatarList，可在界面里挑选。
// - 网络（UDP 广播）与本地存储只保存「asset:<id>」这样的小字符串，
//   渲染时再由 avatarSrc() 本地解析成图片地址，避免大体积 base64 撑爆
//   广播包或数据库。
// - 仍兼容用户「选择本地图片」上传的自定义头像（以 data: 开头的内联图）。

import { ref } from 'vue'

// 打包内置头像列表：[{ id, url }]，url 为可直接用于 <img src> 的 data URI
export const avatarList = ref([])

// 启动时从主进程拉取头像列表；多次调用安全（幂等）。
export async function loadAvatars() {
  try {
    const list = await window.api.getAvatars()
    avatarList.value = list || []
  } catch {
    avatarList.value = []
  }
  return avatarList.value
}

// 将头像值解析为可用于 <img src> 的地址；返回 null 表示应使用文字头像。
// 取值语义：
//   '' / null             -> 文字头像
//   'asset:<id>'          -> 打包内置头像（按 id 本地查找）
//   'data:image/...'      -> 用户本地上传的自定义头像
//   其它（如旧的 builtin: 标记）-> 降级为文字头像
export function avatarSrc(value) {
  if (!value || typeof value !== 'string') return null
  if (value.startsWith('data:')) return value
  if (value.startsWith('asset:')) {
    const id = value.slice(6)
    const f = avatarList.value.find((x) => x.id === id)
    return f ? f.url : null
  }
  return null
}

// 文字头像背景色：基于名字做稳定哈希，保证同一人颜色一致
const TEXT_COLORS = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316' // orange
]
export function colorForName(name) {
  const n = (name || '').trim()
  if (!n) return '#94a3b8'
  let h = 0
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0
  return TEXT_COLORS[h % TEXT_COLORS.length]
}
