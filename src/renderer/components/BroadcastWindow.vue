<template>
  <div class="bw-root">
    <!-- 顶部信息条：老师名称 + 连接状态 + 全屏 / 关闭 -->
    <div class="bw-bar">
      <span class="bw-dot" :class="hasStream ? 'on' : 'off'"></span>
      <span class="bw-title">{{ teacherName }} 的屏幕广播</span>
      <span class="bw-status">{{ statusText }}</span>
      <div class="bw-actions">
        <button
          class="bw-btn"
          type="button"
          :title="isFullscreen ? '退出全屏' : '全屏'"
          @click="toggleFullscreen"
        >
          <el-icon><FullScreen /></el-icon>
        </button>
        <button class="bw-btn bw-close" type="button" title="关闭" @click="close">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>

    <!-- 画面舞台：视频按比例居中铺满，尽量放大显示老师屏幕 -->
    <div class="bw-stage">
      <video ref="videoEl" autoplay playsinline class="bw-video"></video>
      <div v-if="!hasStream" class="bw-cover">
        <p class="bw-cover-title">正在连接 {{ teacherName }} 的屏幕广播…</p>
        <p class="bw-cover-sub">
          若长时间无画面，请确认与老师处于同一网段，且防火墙已放行 UDP 41234 /
          TCP 41235 与 WebRTC 媒体端口。
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { FullScreen, Close } from '@element-plus/icons-vue'
import { StudentReceiver } from '../webrtc.js'

// 老师信息由主进程通过 query 参数注入（见 electron/main.js createBroadcastWindow）
const params = new URLSearchParams(location.search)
const teacherId = params.get('tid') || ''
const teacherIp = params.get('tip') || ''
const teacherName = params.get('tname') || '老师'

const videoEl = ref(null)
const hasStream = ref(false)
const isFullscreen = ref(false)

const statusText = computed(() => (hasStream.value ? '画面已连接' : '连接中…'))

let receiver = null
// 本窗口是否已向老师发出「退出」信号，避免重复发送
let leaveSent = false

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen().catch(() => {})
}

function onFsChange() {
  isFullscreen.value = !!document.fullscreenElement
}

// reason: 'closed' 学生手动关窗 | 'teacher-stopped' 老师停播
function close(reason = 'closed') {
  notifyLeave()
  if (window.api && window.api.closeBroadcastWindow) {
    window.api.closeBroadcastWindow(reason)
  } else {
    window.close()
  }
}

// 通知老师本端已退出，让老师移除这条 PeerConnection（否则老师端会残留僵尸连接，
// 再次进入时 addStudent 会因 peers 里已存在而直接 return，导致新窗口一直连不上）
function notifyLeave() {
  if (leaveSent || !teacherIp) return
  leaveSent = true
  try {
    window.api.sendSignal(teacherIp, { kind: 'leave' })
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  document.title = `${teacherName} 的屏幕广播`
  // 本窗口自行完成学生端的完整握手：request → offer → answer → ice
  receiver = new StudentReceiver(
    (ip, payload) => window.api.sendSignal(ip, payload),
    (stream) => {
      hasStream.value = true
      if (videoEl.value) videoEl.value.srcObject = stream
    }
  )
  // offer / ice / bye 由主进程路由到本窗口（见 main.js 的 signaling.on('message')）
  window.api.onSignal((msg) => {
    const payload = msg && msg.payload
    if (!payload || !payload.kind) return
    if (payload.kind === 'offer') {
      receiver.handleOffer(msg.from, msg._from, payload.sdp)
    } else if (payload.kind === 'ice') {
      receiver.handleIce(payload.candidate)
    } else if (payload.kind === 'bye') {
      // 老师停止广播：关闭本窗口
      hasStream.value = false
      close('teacher-stopped')
    }
  })
  // 向老师发起推流请求
  if (teacherIp) window.api.sendSignal(teacherIp, { kind: 'request' })
  document.addEventListener('fullscreenchange', onFsChange)
  // 窗口关闭时彻底断开 PeerConnection，避免老师端残留连接
  window.addEventListener('beforeunload', () => {
    notifyLeave()
    if (receiver) receiver.stop()
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFsChange)
  notifyLeave()
  if (receiver) {
    receiver.stop()
    receiver = null
  }
})
</script>

<style scoped>
.bw-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0b1220;
  color: #e2e8f0;
}
.bw-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px;
  flex: none;
  background: #111827;
  border-bottom: 1px solid #1f2937;
}
.bw-dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  flex: none;
}
.bw-dot.on {
  background: #22c55e;
}
.bw-dot.off {
  background: #f59e0b;
}
.bw-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bw-status {
  font-size: 12px;
  color: #94a3b8;
}
.bw-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.bw-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #e2e8f0;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.bw-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
.bw-close:hover {
  background: #e11d48;
}
.bw-btn :deep(.el-icon) {
  font-size: 16px;
}
.bw-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000000;
  overflow: hidden;
}
.bw-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000000;
}
.bw-cover {
  position: absolute;
  padding: 0 40px;
  text-align: center;
}
.bw-cover-title {
  font-size: 15px;
  color: #cbd5e1;
  margin: 0;
}
.bw-cover-sub {
  font-size: 12px;
  color: #64748b;
  margin: 10px 0 0;
  line-height: 1.7;
}
</style>
