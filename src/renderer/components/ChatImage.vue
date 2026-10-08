<template>
  <div class="chat-img">
    <!-- 图片预览：点开看大图 -->
    <div
      v-if="dataUrl"
      class="chat-img-frame"
      :class="{ mine }"
      @click="$emit('preview', dataUrl, name)"
      @contextmenu.prevent="$emit('contextmenu', $event)"
    >
      <img :src="dataUrl" :alt="name || '图片'" class="chat-img-el" />
      <div class="chat-img-mask">
        <el-icon><ZoomIn /></el-icon>
      </div>
    </div>

    <!-- 读取中 -->
    <div v-else-if="loading" class="chat-img-box">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>图片加载中…</span>
    </div>

    <!-- 读不出来（文件被删 / 过大）时的兜底 -->
    <div v-else class="chat-img-box chat-img-fallback">
      <el-icon><PictureFilled /></el-icon>
      <span>{{ name || '图片' }} 无法预览</span>
      <el-button size="small" text bg @click="open">在文件夹中查看</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ZoomIn, Loading, PictureFilled } from '@element-plus/icons-vue'

const props = defineProps({
  path: { type: String, default: '' },
  name: { type: String, default: '' },
  mine: { type: Boolean, default: false }
})
defineEmits(['preview', 'contextmenu'])

// 图片走本地文件 + data URI 显示（渲染层有 contextIsolation，读不到磁盘），
// 按需向主进程要一次，避免一次性把所有历史图片都转成 base64 撑爆内存。
const dataUrl = ref('')
const loading = ref(true)

onMounted(async () => {
  if (!props.path) {
    loading.value = false
    return
  }
  try {
    dataUrl.value = (await window.api.getFileDataUrl(props.path)) || ''
  } catch {
    dataUrl.value = ''
  } finally {
    loading.value = false
  }
})

function open() {
  if (props.path) window.api.openFolder(props.path)
}
</script>

<style scoped>
.chat-img-frame {
  position: relative;
  display: inline-block;
  max-width: 280px;
  border-radius: 12px;
  overflow: hidden;
  cursor: zoom-in;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  line-height: 0;
}
.chat-img-el {
  display: block;
  max-width: 100%;
  max-height: 320px;
  width: auto;
  height: auto;
  object-fit: contain;
}
.chat-img-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0);
  color: #fff;
  opacity: 0;
  transition: opacity 0.15s ease, background-color 0.15s ease;
}
.chat-img-frame:hover .chat-img-mask {
  opacity: 1;
  background: rgba(15, 23, 42, 0.32);
}
.chat-img-mask :deep(.el-icon) {
  font-size: 28px;
}
.chat-img-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #f8fafc;
  color: #94a3b8;
  font-size: 12px;
  min-width: 140px;
}
.chat-img-fallback {
  flex-wrap: wrap;
}
</style>