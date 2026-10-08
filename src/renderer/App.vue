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
      <el-button
        class="no-drag ml-auto header-btn"
        size="small"
        title="设置"
        @click="showSettings = true"
      >
        <el-icon class="mr-1"><Setting /></el-icon>设置
      </el-button>
      <div class="no-drag flex items-center gap-1">
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
    <main class="flex-1 grid grid-cols-[260px_1fr_360px] min-h-0">
      <DeviceList />
      <ChatPanel />
      <BroadcastView />
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
import { ref, reactive, onMounted } from 'vue'
import { useStore } from './store/index.js'
import { loadAvatars } from './avatars.js'
import DeviceList from './components/DeviceList.vue'
import ChatPanel from './components/ChatPanel.vue'
import BroadcastView from './components/BroadcastView.vue'
import SettingsModal from './components/SettingsModal.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import Avatar from './components/Avatar.vue'

const store = useStore()
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
})

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
</style>
