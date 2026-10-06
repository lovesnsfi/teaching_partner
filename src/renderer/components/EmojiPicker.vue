<template>
  <div
    class="absolute bottom-full mb-2 left-3 right-3 z-30 bg-white border border-slate-200 rounded-2xl shadow-xl p-2.5"
  >
    <div class="flex gap-1 mb-2">
      <button
        :class="
          tab === 'emoji'
            ? 'bg-blue-50 text-blue-700 border-blue-200'
            : 'border-transparent'
        "
        class="px-2 py-1 text-[12px] rounded-lg border"
        @click="tab = 'emoji'"
      >
        表情
      </button>
      <button
        :class="
          tab === 'sticker'
            ? 'bg-blue-50 text-blue-700 border-blue-200'
            : 'border-transparent'
        "
        class="px-2 py-1 text-[12px] rounded-lg border"
        @click="tab = 'sticker'"
      >
        贴纸
      </button>
    </div>
    <div
      v-if="tab === 'emoji'"
      class="grid grid-cols-10 gap-1 max-h-[170px] overflow-auto"
    >
      <button
        v-for="e in emojis"
        :key="e"
        :title="'插入 ' + e"
        @click="$emit('pick-emoji', e)"
        class="text-[20px] leading-none p-1 rounded-lg hover:bg-slate-100"
      >
        {{ e }}
      </button>
    </div>
    <div v-else class="grid grid-cols-10 gap-1 max-h-[170px] overflow-auto">
      <button
        v-for="s in stickers"
        :key="s"
        :title="'发送贴纸 ' + s"
        @click="$emit('pick-sticker', s)"
        class="text-[30px] leading-none p-1 rounded-lg hover:bg-slate-100"
      >
        {{ s }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { EMOJIS, STICKERS } from '../stickers.js'

const props = defineProps({ initialTab: { type: String, default: 'emoji' } })
defineEmits(['pick-emoji', 'pick-sticker'])
const emojis = EMOJIS
const stickers = STICKERS
const tab = ref(props.initialTab)
watch(
  () => props.initialTab,
  (v) => {
    tab.value = v
  }
)
</script>
