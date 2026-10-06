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
      <button
        class="no-drag ml-auto bg-white/15 hover:bg-white/25 border border-white/30 text-white rounded-lg px-3 py-1.5 flex items-center gap-1.5"
        title="设置"
        @click="showSettings = true"
      >
        <span class="text-[15px] leading-none">⚙</span> 设置
      </button>
      <div class="no-drag flex items-center gap-1">
        <button
          class="win-btn"
          title="最小化到托盘"
          @click="onMinimize"
        >
          &#8211;
        </button>
        <button
          class="win-btn"
          title="最大化 / 还原"
          @click="onToggleMax"
        >
          &#9744;
        </button>
        <button
          class="win-btn win-close"
          title="关闭（最小化到托盘）"
          @click="onClose"
        >
          &#10005;
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
