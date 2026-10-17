<template>
  <div class="float-root">
    <div
      class="wrap"
      :class="{ expanded: hovered }"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
    >
      <!-- 悬停展开的操作面板（位于小球左侧，向左展开） -->
      <div class="panel" :class="{ show: hovered }">
        <button
          class="act"
          :title="mode === 'paused' ? '继续录制' : '暂停录制'"
          @click="onTogglePause"
        >
          <svg v-if="mode === 'recording'" class="icon" viewBox="0 0 24 24">
            <rect x="7" y="5" width="3.5" height="14" rx="1.2" />
            <rect x="13.5" y="5" width="3.5" height="14" rx="1.2" />
          </svg>
          <svg v-else class="icon" viewBox="0 0 24 24">
            <path d="M7 5.5l12 6.5-12 6.5V5.5z" />
          </svg>
        </button>

        <button
          class="act"
          :class="{ recording: mode === 'recording' }"
          title="停止并保存"
          @click="onStop"
        >
          <svg class="icon" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="2.5" />
          </svg>
        </button>

        <button class="act" title="屏幕标注" @click="onAnnotate">
          <svg class="icon" viewBox="0 0 24 24">
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
          </svg>
        </button>
      </div>

      <!-- 小圆球：可拖动；内部为声音波形 + 录制时长；固定在窗口右侧 -->
      <div
        class="ball"
        :class="[mode, { pulse: mode === 'recording' }]"
        @pointerdown="onDragStart"
      >
        <div class="ball-bg"></div>
        <svg class="wave" :class="{ live }" viewBox="0 0 48 28" aria-hidden="true">
          <rect
            v-for="(bar, i) in bars"
            :key="i"
            :x="bar.x"
            :y="14 - bar.h / 2"
            :width="bar.w"
            :height="bar.h"
            rx="1.5"
            :style="barStyle(bar)"
          />
        </svg>
        <span v-if="showTime" class="time">{{ saving ? '保存中' : timeText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

// 当前状态：recording 录制中 / paused 已暂停 / saving 正在保存
const mode = ref('recording')
const saving = ref(false)
const hovered = ref(false)

// 计时：累计已录毫秒 + 当前这段的起始时间；与 RecorderView 用同一套公式，避免漂移
const accMs = ref(0)
const runStart = ref(0)
let paused = false
const timeText = ref('00:00')

let tick = 0
let wave = 0
function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const sec = total % 60
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
}
function tickFn() {
  // 尚未收到主窗口的初始状态（runStart 仍是 0）：先不计时，
  // 否则会把 Unix 纪元毫秒当成起点，显示成一串巨大数字。
  if (!paused && !runStart.value) return
  const t = accMs.value + (paused ? 0 : Date.now() - runStart.value)
  timeText.value = fmt(t)
}

function applyState(payload) {
  if (!payload) return
  if (payload.state === 'saving') {
    saving.value = true
    mode.value = 'saving'
    return
  }
  saving.value = false
  mode.value = payload.state
  accMs.value = payload.accumulatedMs || 0
  if (payload.state === 'recording') {
    paused = false
    runStart.value = Date.now()
  } else if (payload.state === 'paused') {
    paused = true
  }
  tickFn()
}

function onState(payload) {
  applyState(payload)
}

// 悬停展开 / 收起：只切换 CSS，不再 resize 窗口，避免重排导致的跳动循环
function onEnter() {
  hovered.value = true
}
function onLeave() {
  if (dragging) return // 拖动中不要收起，避免面板闪烁
  hovered.value = false
}

// 拖动小球移动整个悬浮窗（JS 实现，才能与悬停面板共存）
// 关键点：渲染层只转发鼠标的相对位移 dx/dy，由主进程在自己的真实位置上累加并 clamp。
// 全程不读 window.screenX（透明无边框窗口上会滞后/失真），也不算绝对坐标，
// 因此无累积偏移、无竞态；贴边后回拉能立刻跟手（无死区）。
let dragging = false
let lastX = 0
let lastY = 0
function onDragStart(e) {
  dragging = true
  lastX = e.screenX
  lastY = e.screenY
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
}
function onDragMove(e) {
  if (!dragging) return
  const dx = e.screenX - lastX
  const dy = e.screenY - lastY
  lastX = e.screenX
  lastY = e.screenY
  if (window.api && window.api.recorderFloatMoveBy) {
    window.api.recorderFloatMoveBy(dx, dy)
  }
}
function onDragEnd() {
  dragging = false
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
}

// 指令：暂停 / 继续 / 停止 / 标注
function onTogglePause() {
  const action = mode.value === 'paused' ? 'resume' : 'pause'
  if (window.api && window.api.recorderFloatCmd) {
    window.api.recorderFloatCmd({ action })
  }
}
function onStop() {
  if (window.api && window.api.recorderFloatCmd) {
    window.api.recorderFloatCmd({ action: 'stop' })
  }
}
function onAnnotate() {
  if (window.api && window.api.recorderFloatCmd) {
    window.api.recorderFloatCmd({ action: 'annotate' })
  }
}

// 声音波形条：12 根，高度/动画参数随机，录制时波动更快
// 声音波形条：12 根。base 高度统一，实际高度由 scaleY 决定——
// 有真实电平时用 JS 驱动（随系统音量跳动），无信号时回退到 CSS 模拟动画。
const bars = Array.from({ length: 12 }, (_, i) => {
  const c = (i - 5.5) / 5.5 // -1..1，中间高、两边低，更像真实波形
  const delay = Math.round(Math.random() * -1200)
  const dur = 600 + Math.round(Math.random() * 500)
  return {
    x: 2 + i * 4,
    w: 2.2,
    h: 14,
    shape: 0.55 + 0.45 * (1 - Math.abs(c)), // 中间条更高
    k: 0.6 + Math.random() * 0.8, // 每条的个体差异
    delay,
    dur
  }
})

// 真实系统音量电平（来自主进程电平监测）；dispLevel 为平滑后的显示值
const sysLevel = ref(0)
const dispLevel = ref(0)
const live = ref(false) // 是否正在用真实电平驱动（无信号则回退模拟动画）
let lastLevelAt = 0

function barStyle(b) {
  const s = {
    animationDelay: b.delay + 'ms',
    animationDuration: b.dur + 'ms'
  }
  // 有真实信号时用 JS  transform 覆盖高度；无信号交给 CSS 动画
  if (live.value) {
    const v = 0.12 + dispLevel.value * b.shape * b.k * 1.25
    s.transform = 'scaleY(' + Math.min(1.5, Math.max(0.12, v)).toFixed(3) + ')'
  }
  return s
}

const showTime = computed(() => mode.value === 'recording' || mode.value === 'saving')

onMounted(() => {
  // 关键：悬浮窗是透明窗口，但全局 style.css 给 body 设了 slate 背景，
  // 会整块透出一个矩形。这里只在本窗口内把背景置透明，不影响主窗口。
  try {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const app = document.getElementById('app')
    if (app) app.style.background = 'transparent'
  } catch {
    /* ignore */
  }
  if (window.api && window.api.onFloatState) window.api.onFloatState(onState)
  // 挂载后主动向主窗口请求一次当前状态：补回「开始录制」时可能丢失的初始推送，
  // 确保 runStart 被正确初始化，否则首次计时会把纪元毫秒当起点。
  if (window.api && window.api.recorderFloatCmd) {
    window.api.recorderFloatCmd({ action: 'sync' })
  }
  // 订阅真实系统音量电平：驱动波形；超过 1s 没有新电平即认为无信号、回退模拟动画
  if (window.api && window.api.onRecorderLevel) {
    window.api.onRecorderLevel((v) => {
      lastLevelAt = Date.now()
      sysLevel.value = Math.max(0, Math.min(1, Number(v) || 0))
    })
  }
  tick = setInterval(tickFn, 250)
  // 波形平滑循环：每 50ms 向目标电平靠近，并维护 live 状态
  wave = setInterval(() => {
    live.value = Date.now() - lastLevelAt < 1000
    dispLevel.value += (sysLevel.value - dispLevel.value) * 0.3
    if (dispLevel.value < 0.001) dispLevel.value = 0
  }, 50)
})

onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
  if (wave) clearInterval(wave)
})
</script>

<style scoped>
.float-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 4px;
  box-sizing: border-box;
  -webkit-user-select: none;
  user-select: none;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  background: transparent;
}

.wrap {
  display: flex;
  align-items: center;
  gap: 0;
}

.ball {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  flex: 0 0 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  color: #fff;
  overflow: hidden;
  box-shadow:
    0 4px 14px rgba(0, 132, 255, 0.4),
    inset 0 1px 1px rgba(255, 255, 255, 0.4);
}
.ball:active {
  cursor: grabbing;
}
.ball-bg {
  position: absolute;
  inset: 0;
  background: linear-gradient(160deg, #4facfe 0%, #00c6fb 55%, #007cf0 100%);
  border-radius: 50%;
}
.ball.pulse .ball-bg {
  animation: breathe 2.4s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.12); }
}

/* 声音波形：作为球内背景层，录制时波动更快 */
.wave {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 38px;
  height: 22px;
  fill: rgba(255, 255, 255, 0.5);
}
.wave rect {
  transform-origin: center;
  animation-name: wave;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
/* 有真实系统音量电平时，关闭模拟动画，改由 JS 按音量设置 transform（见 barStyle） */
.wave.live rect {
  animation: none;
}
.ball.recording .wave rect {
  animation-duration: 0.5s !important;
  fill: rgba(255, 255, 255, 0.85);
}
.ball.paused .wave rect {
  animation-name: wave-slow;
  fill: rgba(255, 255, 255, 0.55);
}
@keyframes wave {
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1.15); }
}
@keyframes wave-slow {
  0%, 100% { transform: scaleY(0.5); }
  50% { transform: scaleY(0.8); }
}

/* 录制时长：居中、清晰、mm:ss */
.time {
  position: relative;
  z-index: 1;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

/* 悬停展开的操作面板：位于小球左侧，向左展开。
   收起时彻底无尺寸、无背景，避免残留矩形；按钮靠右锚定（贴近小球），
   展开时 max-width 增大、左侧被裁切的内容逐步露出，视觉上向左侧延展。 */
.panel {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0;
  margin: 0;
  background: transparent;
  border-radius: 30px;
  opacity: 0;
  max-width: 0;
  overflow: hidden;
  pointer-events: none;
  transition:
    opacity 0.22s ease,
    max-width 0.28s ease,
    padding 0.28s ease,
    background 0.22s ease,
    box-shadow 0.22s ease;
}
.panel.show {
  opacity: 1;
  max-width: 210px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  pointer-events: auto;
}

.act {
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: #6b7280;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.12s ease;
}
.act:hover {
  background: rgba(0, 0, 0, 0.07);
  transform: translateY(-1px);
}
.act.recording:hover {
  background: rgba(225, 29, 72, 0.12);
}

.icon {
  width: 24px;
  height: 24px;
  fill: currentColor;
}
.icon.play { fill: #22c55e; }
.icon.stop { fill: #9ca3af; }
.act.recording .icon.stop { fill: #e11d48; }
.icon.pen { fill: #6b7280; }
</style>
