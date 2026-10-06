<script setup>
import { computed } from 'vue'
import { builtinSrc, colorForName } from '../avatars.js'

const props = defineProps({
  // 头像值：'' / null（文字头像）| 'data:image/...'（本地图片）| 'builtin:b0'（内置）
  // 也可为对象 { type:'builtin', id } | { type:'custom', data }
  avatar: { type: [String, Object], default: '' },
  name: { type: String, default: '' },
  size: { type: Number, default: 36 }
})

const isCJK = (ch) => /[㐀-䶿一-鿿가-힯豈-﫿]/.test(ch)

const initial = computed(() => {
  const n = (props.name || '').trim()
  if (!n) return '?'
  const ch = Array.from(n)[0]
  return isCJK(ch) ? ch : ch.toUpperCase()
})

const bg = computed(() => colorForName(props.name || '?'))

const src = computed(() => {
  const a = props.avatar
  if (!a) return null
  if (typeof a === 'string') {
    if (a.startsWith('data:')) return a
    if (a.startsWith('builtin:')) return builtinSrc(a.slice(8)) || null
    return null
  }
  if (a && a.type === 'builtin') return builtinSrc('b' + a.id) || null
  if (a && a.type === 'custom' && a.data) return a.data
  return null
})
</script>

<template>
  <span
    class="rounded-full overflow-hidden grid place-items-center font-semibold text-white flex-none shrink-0"
    :style="{
      width: size + 'px',
      height: size + 'px',
      background: src ? 'transparent' : bg
    }"
  >
    <img
      v-if="src"
      :src="src"
      :width="size"
      :height="size"
      alt=""
      class="w-full h-full object-cover block"
    />
    <span
      v-else
      class="select-none leading-none"
      :style="{ fontSize: Math.round(size * 0.42) + 'px' }"
      >{{ initial }}</span
    >
  </span>
</template>
