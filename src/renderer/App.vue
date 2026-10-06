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
        >{{ store.self.name }} · {{ store.self.ip }}</span
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
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useStore } from './store/index.js'
import DeviceList from './components/DeviceList.vue'
import ChatPanel from './components/ChatPanel.vue'
import BroadcastView from './components/BroadcastView.vue'
import SettingsModal from './components/SettingsModal.vue'
import Avatar from './components/Avatar.vue'

const store = useStore()
const showSettings = ref(false)

onMounted(() => {
  store.init()
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
