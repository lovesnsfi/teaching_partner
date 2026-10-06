<template>
  <aside class="flex flex-col bg-white border-r border-slate-200 min-h-0">
    <div
      class="px-4 py-3 font-semibold border-b border-slate-200 flex items-center gap-2 text-slate-700 flex-none"
    >
      在线设备
      <span class="ml-auto text-[12px] font-normal text-slate-400">{{
        store.devices.length
      }}</span>
    </div>

    <div class="flex-1 overflow-auto p-3 space-y-2">
      <div
        v-for="d in store.devices"
        :key="d.id"
        @click="store.setActiveChat(d.id)"
        class="flex items-center gap-2.5 p-2.5 border rounded-xl cursor-pointer transition-colors"
        :class="
          d.id === store.activeChatId
            ? 'border-blue-500 bg-blue-50'
            : 'border-slate-200 hover:bg-slate-50'
        "
      >
        <Avatar :avatar="d.avatar" :name="d.name" :size="36" />
        <div class="min-w-0">
          <div class="font-medium text-slate-800 truncate">{{ d.name }}</div>
          <div class="text-[12px] text-slate-400 truncate">
            {{ d.ip }}:{{ d.port }}
          </div>
        </div>
        <span
          v-if="d.role === 'teacher'"
          class="ml-1 text-[11px] text-white bg-amber-600 rounded-md px-1.5 py-0.5 flex-none"
          >老师</span
        >
        <span
          v-if="store.unread[d.id]"
          class="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[11px] grid place-items-center flex-none"
          >{{ store.unread[d.id] }}</span
        >
      </div>

      <p
        v-if="!store.devices.length"
        class="text-slate-400 text-[13px] leading-relaxed px-1"
      >
        正在扫描局域网…<br />确保同网段，并放行 UDP 41234（发现）/ 41235（信令）。
      </p>

      <div
        class="flex items-center gap-2 mt-4 mb-2 text-[12px] text-slate-400 pt-2 border-t border-slate-100"
      >
        群聊
        <span>({{ store.groups.length }})</span>
        <button class="primary ml-auto text-[12px] px-2 py-0.5" @click="showModal = true">
          ＋ 新建
        </button>
      </div>

      <div
        v-for="g in store.groups"
        :key="g.id"
        @click="store.setActiveChat(g.id)"
        class="flex items-center gap-2.5 p-2.5 border rounded-xl cursor-pointer transition-colors"
        :class="
          g.id === store.activeChatId
            ? 'border-blue-500 bg-blue-50'
            : 'border-slate-200 hover:bg-slate-50'
        "
      >
        <span
          class="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 grid place-items-center text-[18px] flex-none"
          >💬</span
        >
        <div class="min-w-0">
          <div class="font-medium text-slate-800 truncate">{{ g.name }}</div>
          <div class="text-[12px] text-slate-400 truncate">
            {{ g.members.length }} 人
          </div>
        </div>
        <span
          v-if="store.unread[g.id]"
          class="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[11px] grid place-items-center flex-none"
          >{{ store.unread[g.id] }}</span
        >
      </div>

      <p v-if="!store.groups.length" class="text-slate-400 text-[13px] px-1">
        还没有群聊，点「新建」拉人建群。
      </p>
    </div>

    <GroupModal v-if="showModal" @close="showModal = false" @create="onCreate" />
  </aside>
</template>

<script setup>
import { ref } from 'vue'
import { useStore } from '../store/index.js'
import GroupModal from './GroupModal.vue'
import Avatar from './Avatar.vue'

const store = useStore()
const showModal = ref(false)

function onCreate({ name, memberIds }) {
  store.createGroup(name, memberIds)
}
</script>
