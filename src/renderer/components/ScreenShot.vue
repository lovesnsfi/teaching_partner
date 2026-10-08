<template>
  <div
    class="shot-root"
    :class="{ 'has-sel': hasSel }"
    :style="{ cursor }"
    @mousedown="onDown"
    @dblclick="onDblClick"
    @dragstart.prevent
  >
    <!-- 底图：刚才抓到的整屏截图。
         draggable=false 很关键：否则浏览器会对 <img> 启动原生拖拽，
         吞掉 mousemove，导致选区调整时失控（会跳到左上角）。 -->
    <img
      v-if="img"
      :src="img.dataUrl"
      class="shot-bg"
      draggable="false"
      :width="img.width"
      :height="img.height"
    />

    <!-- 已框选的区域：亮边框 + 四周压暗 + 8 个调节手柄 -->
    <div
      v-if="hasSel"
      class="shot-sel"
      :style="{
        left: sel.x + 'px',
        top: sel.y + 'px',
        width: sel.width + 'px',
        height: sel.height + 'px'
      }"
    >
      <span class="shot-size">{{ sel.width }} × {{ sel.height }}</span>
      <span
        v-for="h in HANDLES"
        :key="h"
        class="shot-handle"
        :class="'h-' + h"
        :style="handleStyle(h)"
      ></span>
    </div>

    <!-- 首次拖动时跟随鼠标的放大预览 -->
    <div
      v-if="mode === 'new' && img"
      class="shot-magnifier"
      :style="magnifierStyle"
    >
      <div
        class="shot-mag-img"
        :style="{
          backgroundImage: `url(${img.dataUrl})`,
          backgroundSize: img.width + 'px ' + img.height + 'px'
        }"
      ></div>
      <div class="shot-mag-label">{{ sel.width }} × {{ sel.height }}</div>
    </div>

    <!-- 底部操作条 -->
    <div class="shot-bar">
      <template v-if="hasSel">
        <span class="shot-tip shot-tip-ok">
          {{ sel.width }} × {{ sel.height }} · 拖动可移动，边框手柄可缩放，双击确认
        </span>
        <button class="shot-btn" type="button" @click="cancel">取消 (Esc)</button>
        <button class="shot-btn shot-btn-primary" type="button" @click="confirm">
          完成 (Enter)
        </button>
      </template>
      <span v-else class="shot-tip">按住鼠标左键拖动，选择要截图的区域</span>
    </div>

    <div v-if="!img" class="shot-loading">正在准备截图…</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'

const img = ref(null)
const sel = reactive({ x: 0, y: 0, width: 0, height: 0 })
const hasSel = ref(false)
const mode = ref('') // '' | 'new' | 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const cursor = ref('crosshair')

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const HANDLE_CURSOR = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize'
}
const MIN = 4
const HIT = 5 // 手柄命中容差(px)

let startX = 0
let startY = 0
let anchor = null // { x, y, orig }

const maxX = () => (img.value ? img.value.width : window.innerWidth)
const maxY = () => (img.value ? img.value.height : window.innerHeight)
// 安全夹紧：即使 hi < lo 也不会把值推到 0（那正是"选区跳到左上角"的成因）
const clamp = (v, max) => Math.max(0, Math.min(v, Math.max(0, max)))
const clampRange = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)))

// 手柄中心点坐标（用于命中测试与定位）
function handlePos(name) {
  const { x, y, width: w, height: h } = sel
  const cx = x + w / 2
  const cy = y + h / 2
  switch (name) {
    case 'nw':
      return { x, y }
    case 'n':
      return { x: cx, y }
    case 'ne':
      return { x: x + w, y }
    case 'e':
      return { x: x + w, y: cy }
    case 'se':
      return { x: x + w, y: y + h }
    case 's':
      return { x: cx, y: y + h }
    case 'sw':
      return { x, y: y + h }
    case 'w':
      return { x, y: cy }
    default:
      return { x: cx, y: cy }
  }
}
function handleStyle(name) {
  const p = handlePos(name)
  return { left: p.x - 4 + 'px', top: p.y - 4 + 'px' }
}
function hitHandle(x, y) {
  for (const h of HANDLES) {
    const p = handlePos(h)
    if (Math.abs(x - p.x) <= HIT && Math.abs(y - p.y) <= HIT) return h
  }
  return ''
}
function insideSel(x, y) {
  return (
    x >= sel.x && x <= sel.x + sel.width && y >= sel.y && y <= sel.y + sel.height
  )
}

const MAG_W = 200
const MAG_H = 120
const magnifierStyle = computed(() => {
  const m = 14
  let left = startX + m
  let top = startY + m
  if (left + MAG_W > maxX()) left = startX - MAG_W - m
  if (top + MAG_H + 22 > maxY()) top = startY - MAG_H - 22 - m
  return { left: Math.max(0, left) + 'px', top: Math.max(0, top) + 'px' }
})

function onDown(e) {
  if (!img.value || e.button !== 0) return
  // 无论走哪个分支都要阻止默认行为，否则会触发原生图片拖拽 / 文本选中，
  // mousemove 随之丢失，选区调整就会失控
  e.preventDefault()
  const x = clamp(e.clientX, maxX())
  const y = clamp(e.clientY, maxY())

  // 已有选区：先判断是否点在手柄上（缩放），再判断是否在选区内（移动）
  if (hasSel.value) {
    const h = hitHandle(x, y)
    if (h) {
      mode.value = h
      anchor = { x, y, orig: { ...sel } }
      return
    }
    if (insideSel(x, y)) {
      mode.value = 'move'
      anchor = { x, y, orig: { ...sel } }
      return
    }
  }

  // 在选区外按下 = 重新框选
  mode.value = 'new'
  startX = x
  startY = y
  sel.x = x
  sel.y = y
  sel.width = 0
  sel.height = 0
  hasSel.value = false
}

function onMove(e) {
  if (!img.value) return
  // 关键防护：只在「确实还有按键按下」时才跟随鼠标。
  // 若某个 mouseup 没被收到（比如在窗口外松开），mode 会残留，
  // 此后任意一次鼠标移动都会把选区拽走 —— 这正是"点一下就跳"的成因。
  if (mode.value && (e.buttons & 1) === 0) {
    resetDrag()
    return
  }
  const x = clamp(e.clientX, maxX())
  const y = clamp(e.clientY, maxY())

  if (!mode.value) {
    // 仅更新鼠标样式
    if (!hasSel.value) {
      cursor.value = 'crosshair'
    } else {
      const h = hitHandle(x, y)
      cursor.value = h
        ? HANDLE_CURSOR[h]
        : insideSel(x, y)
          ? 'move'
          : 'crosshair'
    }
    return
  }

  if (mode.value === 'new') {
    sel.x = Math.min(startX, x)
    sel.y = Math.min(startY, y)
    sel.width = Math.abs(x - startX)
    sel.height = Math.abs(y - startY)
    if (sel.width >= MIN && sel.height >= MIN) hasSel.value = true
    return
  }

  if (mode.value === 'move') {
    const dx = x - anchor.x
    const dy = y - anchor.y
    const o = anchor.orig
    sel.x = clampRange(o.x + dx, 0, maxX() - o.width)
    sel.y = clampRange(o.y + dy, 0, maxY() - o.height)
    sel.width = o.width
    sel.height = o.height
    return
  }

  // 按手柄调整对应边（一律以按下时的原始矩形为基准，避免累计误差）
  const o = anchor.orig
  const dx = x - anchor.x
  const dy = y - anchor.y
  if (mode.value.includes('w')) {
    const nx = clampRange(o.x + dx, 0, o.x + o.width - MIN)
    sel.x = nx
    sel.width = o.width - (nx - o.x)
  }
  if (mode.value.includes('e')) {
    sel.width = clampRange(x - o.x, MIN, maxX() - o.x)
  }
  if (mode.value.includes('n')) {
    const ny = clampRange(o.y + dy, 0, o.y + o.height - MIN)
    sel.y = ny
    sel.height = o.height - (ny - o.y)
  }
  if (mode.value.includes('s')) {
    sel.height = clampRange(y - o.y, MIN, maxY() - o.y)
  }
}

// 统一的拖拽复位：任何「按键已松开 / 窗口失焦 / 光标离开」都走这里，
// 杜绝 mode 残留导致后续 mousemove 继续改写选区
function resetDrag() {
  if (!mode.value) return
  mode.value = ''
  anchor = null
  // 误触产生的极小选区直接丢弃
  if (!hasSel.value) {
    sel.width = 0
    sel.height = 0
  }
}

// 在选区内双击 = 完成截图
function onDblClick(e) {
  if (hasSel.value && insideSel(e.clientX, e.clientY)) confirm()
}

function confirm() {
  if (!hasSel.value) return
  window.api.confirmShot({
    x: sel.x,
    y: sel.y,
    width: sel.width,
    height: sel.height
  })
}

function cancel() {
  window.api.cancelShot()
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    confirm()
  }
}

onMounted(async () => {
  try {
    img.value = await window.api.getShotImage()
  } catch {
    img.value = null
  }
  window.addEventListener('mousemove', onMove)
  // 用捕获阶段监听 mouseup / blur：即使在窗口外松开也能收到，避免 mode 残留
  window.addEventListener('mouseup', resetDrag, true)
  window.addEventListener('blur', resetDrag)
  document.addEventListener('mouseleave', resetDrag)
  window.addEventListener('keydown', onKey)
  window.addEventListener('contextmenu', prevent)
})

function prevent(e) {
  e.preventDefault()
}

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', resetDrag, true)
  window.removeEventListener('blur', resetDrag)
  document.removeEventListener('mouseleave', resetDrag)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('contextmenu', prevent)
})
</script>

<style scoped>
.shot-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  background: rgba(0, 0, 0, 0.45);
}
.shot-root.has-sel {
  /* 有选区后改由 .shot-sel 的大范围 box-shadow 负责压暗，
     这样选区内部才是「挖空」的清晰区域 */
  background: transparent;
}
.shot-bg {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  -webkit-user-drag: none;
  user-select: none;
}
/* 用超大 spread 的 box-shadow 把选区以外全部压暗（阴影不会覆盖元素自身区域） */
.shot-sel {
  position: fixed;
  border: 1px solid #22d3ee;
  pointer-events: none;
  box-sizing: border-box;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
}
.shot-size {
  position: absolute;
  left: 0;
  top: -22px;
  background: #22d3ee;
  color: #083344;
  font-size: 12px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 4px;
  white-space: nowrap;
}
/* 8 个缩放手柄 */
.shot-handle {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #22d3ee;
  border: 1px solid #083344;
  box-sizing: border-box;
}
.h-nw,
.h-se {
  cursor: nwse-resize;
}
.h-ne,
.h-sw {
  cursor: nesw-resize;
}
.h-n,
.h-s {
  cursor: ns-resize;
}
.h-e,
.h-w {
  cursor: ew-resize;
}
/* 放大镜 */
.shot-magnifier {
  position: fixed;
  border: 1px solid #22d3ee;
  background: #0f172a;
  border-radius: 6px;
  overflow: hidden;
  pointer-events: none;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
}
.shot-mag-img {
  width: 200px;
  height: 120px;
  background-repeat: no-repeat;
}
.shot-mag-label {
  font-size: 11px;
  color: #e2e8f0;
  text-align: center;
  padding: 2px 0;
  background: #0f172a;
}
/* 底部操作条 */
.shot-bar {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  font-size: 13px;
  white-space: nowrap;
}
.shot-tip-ok {
  color: #67e8f9;
}
.shot-btn {
  border: none;
  border-radius: 9999px;
  padding: 5px 14px;
  font-size: 13px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.14);
  color: #e2e8f0;
}
.shot-btn:hover {
  background: rgba(255, 255, 255, 0.24);
}
.shot-btn-primary {
  background: #0891b2;
  color: #fff;
}
.shot-btn-primary:hover {
  background: #06a6ca;
}
.shot-loading {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  color: #e2e8f0;
  font-size: 14px;
}
</style>