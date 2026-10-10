<template>
  <div class="flex flex-col h-full">
    <header
      class="drag-region relative flex items-center gap-3 px-5 h-14 bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md flex-none select-none"
    >
      <span class="font-bold text-[15px] tracking-wide">局域网沟通广播</span>
      <Avatar
        :avatar="store.self.avatar"
        :name="store.self.name || '我'"
        :size="30"
        class="no-drag"
      />
      <span class="text-white/80 text-[13px]"
        >{{ store.self.name }} · {{ store.self.host || store.self.ip }}</span
      >
      <div class="no-drag ml-auto flex items-center gap-1">
        <button
          class="win-btn"
          title="最小化到托盘"
          @click="onMinimize"
        >
          <el-icon><Minus /></el-icon>
        </button>
        <button
          class="win-btn"
          title="最大化 / 还原"
          @click="onToggleMax"
        >
          <el-icon><FullScreen /></el-icon>
        </button>
        <button
          class="win-btn win-close"
          title="关闭（最小化到托盘）"
          @click="onClose"
        >
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </header>
    <main class="flex-1 flex min-h-0">
      <!-- 左侧主导航：聊天 / 广播 / 设置 -->
      <nav
        class="w-[64px] flex-none bg-slate-50 border-r border-slate-200 flex flex-col items-center py-3 gap-2 select-none"
      >
        <button
          class="nav-btn"
          :class="{ active: currentTab === 'chat' }"
          title="聊天"
          @click="currentTab = 'chat'"
        >
          <el-icon><ChatRound /></el-icon>
          <span class="nav-label">聊天</span>
        </button>
        <button
          class="nav-btn"
          :class="{ active: currentTab === 'broadcast' }"
          title="广播"
          @click="currentTab = 'broadcast'"
        >
          <el-icon><Monitor /></el-icon>
          <span class="nav-label">广播</span>
        </button>
        <button
          class="nav-btn"
          :class="{ active: currentTab === 'record' }"
          title="录屏"
          @click="currentTab = 'record'"
        >
          <el-icon><VideoCamera /></el-icon>
          <span class="nav-label">录屏</span>
        </button>
        <button
          class="nav-btn mt-auto"
          title="设置"
          @click="showSettings = true"
        >
          <el-icon><Setting /></el-icon>
          <span class="nav-label">设置</span>
        </button>
      </nav>

      <!-- 主内容区：聊天 / 广播 / 录屏 三视图切换 -->
      <div class="flex-1 min-h-0 flex">
        <template v-if="currentTab === 'chat'">
          <DeviceList class="w-[260px] flex-none" />
          <ChatPanel class="flex-1 min-w-0" />
        </template>
        <BroadcastView
          v-else-if="currentTab === 'broadcast'"
          class="flex-1 min-w-0"
        />
        <RecorderView v-else class="flex-1 min-w-0" />
      </div>
    </main>

    <SettingsModal v-if="showSettings" @close="showSettings = false" />

    <!-- 全局更新提示弹窗（自动检查 / 手动检查的结果都在此展示） -->
    <UpdateDialog
      v-model:visible="update.visible"
      :channel="update.channel"
      :data="update.data"
      @install="installUpdate"
      @background="backgroundUpdate"
    />
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import { useStore } from './store/index.js'
import { loadAvatars } from './avatars.js'
import DeviceList from './components/DeviceList.vue'
import ChatPanel from './components/ChatPanel.vue'
import BroadcastView from './components/BroadcastView.vue'
import RecorderView from './components/RecorderView.vue'
import SettingsModal from './components/SettingsModal.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import Avatar from './components/Avatar.vue'

const store = useStore()
const currentTab = ref('chat')
const showSettings = ref(false)

// 自动更新弹窗状态：由主进程经 preload 推送的 updater:event 驱动
const update = reactive({ visible: false, channel: '', data: {} })
// 用户是否选择了「后台下载」：选了就静默下载，下载进度不再弹窗打扰，
// 等下载完成再统一提示「已就绪，可重启」。
const bgDownload = ref(false)
// 仅这些事件会驱动更新弹窗切换内容
const VISIBLE_CHANNELS = [
  'update-available',
  'download-progress',
  'update-downloaded',
  'update-not-available',
  'error',
  'dev-skip'
]
function onUpdateEvent(payload) {
  if (!payload) return
  // 'feed' 只是「当前更新源变了」的旁路通知，不参与弹窗内容，
  // 若也覆盖 channel 会把正在显示的弹窗清空
  if (payload.channel === 'feed') {
    update.data = { ...update.data, feed: payload.data }
    return
  }
  update.channel = payload.channel
  update.data = payload.data || {}
  if (!VISIBLE_CHANNELS.includes(payload.channel)) return
  // 新一轮更新：重置「后台下载」标记
  if (payload.channel === 'update-available') bgDownload.value = false
  // 已经在后台下载时，下载进度不再反复弹窗；但「已完成」必须提示
  if (payload.channel === 'download-progress' && bgDownload.value) return
  update.visible = true
}
// 用户点「后台下载」：收起弹窗，下载继续在后台进行
function backgroundUpdate() {
  bgDownload.value = true
  update.visible = false
}
function installUpdate() {
  if (window.api) window.api.quitAndInstall()
}

onMounted(() => {
  store.init()
  loadAvatars()
  if (window.api && window.api.onUpdateEvent) {
    window.api.onUpdateEvent(onUpdateEvent)
  }
  // 广播状态只存在于渲染层，上报给主进程用于「退出前确认」
  reportBroadcast()
  watch(
    () => store.broadcast.teacherActive,
    () => reportBroadcast()
  )
})

function reportBroadcast() {
  if (window.api && window.api.reportActivity) {
    window.api.reportActivity('broadcast', !!store.broadcast.teacherActive)
  }
}

function onMinimize() {
  if (window.api) window.api.windowMinimize()
}
function onToggleMax() {
  if (window.api) window.api.windowMaximize()
}
function onClose() {
  if (window.api) window.api.windowClose()
}
</script>

<style scoped>
/* 深色渐变标题栏上的按钮：Element Plus 默认配色不适用，需在此覆盖。
   注意：Tailwind v4 的工具类位于 @layer utilities，优先级低于未分层的
   Element Plus 组件样式，因此覆盖组件外观要用 scoped 而不是工具类 class。 */
.header-btn {
  background-color: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
  color: #ffffff;
}
.header-btn:hover,
.header-btn:focus {
  background-color: rgba(255, 255, 255, 0.25);
  border-color: rgba(255, 255, 255, 0.4);
  color: #ffffff;
}
/* 自定义窗口控制按钮内的图标尺寸对齐 */
.win-btn :deep(.el-icon) {
  font-size: 15px;
}

/* 左侧主导航按钮 */
.nav-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 52px;
  height: 52px;
  border-radius: 12px;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.nav-btn:hover {
  background: #f1f5f9;
  color: #2563eb;
}
.nav-btn.active {
  background: #eff6ff;
  color: #2563eb;
}
.nav-btn :deep(.el-icon) {
  font-size: 22px;
  line-height: 1;
}
.nav-label {
  font-size: 11px;
  line-height: 1;
}
</style>
