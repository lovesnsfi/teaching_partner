<script setup>
import { computed } from 'vue'
import { avatarSrc, colorForName } from '../avatars.js'

const props = defineProps({
  // 头像值：
  //   '' / null              -> 文字头像（昵称首字/首汉字）
  //   'asset:<id>'           -> 打包内置头像（assets/avatar 下）
  //   'data:image/...'       -> 用户本地上传的自定义头像
  avatar: { type: [String, Object], default: '' },
  name: { type: String, default: '' },
  size: { type: Number, default: 36 },
  // 是否在线：false 时图片加灰度滤镜、文字头像用灰色背景（用于联系人离线态）
  online: { type: Boolean, default: true }
})

// 离线时文字头像使用的中性灰背景
const offlineBg = '#94a3b8'

const isCJK = (ch) => /[㐀-䶿一-鿿가-힯豈-﫿]/.test(ch)

const initial = computed(() => {
  const n = (props.name || '').trim()
  if (!n) return '?'
  const ch = Array.from(n)[0]
  return isCJK(ch) ? ch : ch.toUpperCase()
})

const bg = computed(() => (props.online ? colorForName(props.name || '?') : offlineBg))

// avatarSrc 会读取响应式的 avatarList，列表加载完成后会自动重新解析
const src = computed(() => avatarSrc(props.avatar))
</script>

<template>
  <span
    class="rounded-full overflow-hidden grid place-items-center font-semibold text-white flex-none shrink-0"
    :class="online ? '' : 'opacity-60'"
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
      :style="online ? {} : { filter: 'grayscale(1)' }"
    />
    <span
      v-else
      class="select-none leading-none"
      :style="{ fontSize: Math.round(size * 0.42) + 'px' }"
      >{{ initial }}</span
    >
  </span>
</template>
