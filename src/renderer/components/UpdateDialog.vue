<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <div class="text-[13px] text-slate-600 leading-relaxed">
      <p v-if="channel === 'update-available' || channel === 'download-progress' || channel === 'checking'">
        发现新版本 <b class="text-blue-600">{{ data.version }}</b>，正在下载更新…
      </p>
      <p v-else-if="channel === 'update-downloaded'">
        新版本 <b class="text-blue-600">{{ data.version }}</b> 已下载完成，重启程序即可完成更新。
      </p>
      <p v-else-if="channel === 'update-not-available'">
        当前已是最新版本 <b>{{ data.version }}</b>。
      </p>
      <p v-else-if="channel === 'error'">
        更新检查出错：<span class="text-rose-600">{{ data.message }}</span>
      </p>
      <p v-else-if="channel === 'dev-skip'">
        当前为开发模式，不执行更新检查。
      </p>

      <!-- 下载进度 -->
      <div
        v-if="channel === 'download-progress' || channel === 'update-available'"
        class="mt-3"
      >
        <el-progress
          :percentage="Math.floor(data.percent || 0)"
          :stroke-width="12"
          :status="channel === 'update-downloaded' ? 'success' : undefined"
        />
        <div class="text-[12px] text-slate-400 mt-1 flex justify-between">
          <span>{{ formatSpeed(data.bytesPerSecond) }}</span>
          <span>{{ formatSize(data.transferred) }} / {{ formatSize(data.total) }}</span>
        </div>
      </div>

      <!-- 更新说明 -->
      <pre
        v-if="data.releaseNotes"
        class="release-notes"
      >{{ data.releaseNotes }}</pre>
    </div>

    <template #footer>
      <el-button
        v-if="channel === 'update-not-available' || channel === 'error' || channel === 'dev-skip'"
        @click="$emit('update:visible', false)"
        >知道了</el-button
      >
      <template v-else-if="channel === 'update-downloaded'">
        <el-button @click="$emit('update:visible', false)">稍后</el-button>
        <el-button type="primary" @click="$emit('install')">立即重启</el-button>
      </template>
      <el-button
        v-else
        @click="$emit('update:visible', false)"
        >关闭</el-button
      >
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  channel: { type: String, default: '' },
  data: { type: Object, default: () => ({}) }
})
defineEmits(['update:visible', 'install'])

const title = computed(() => {
  switch (props.channel) {
    case 'update-downloaded':
      return '更新已就绪'
    case 'error':
      return '更新失败'
    case 'update-not-available':
      return '已是最新版本'
    default:
      return '软件更新'
  }
})

function formatSize(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i]
}

function formatSpeed(bps) {
  if (!bps) return '0 B/s'
  return formatSize(bps) + '/s'
}
</script>

<style scoped>
.release-notes {
  margin: 12px 0 0;
  padding: 10px 12px;
  max-height: 160px;
  overflow: auto;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: #475569;
}
</style>
