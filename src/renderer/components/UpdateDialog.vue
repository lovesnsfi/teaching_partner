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

      <!-- 最后更新时间（新版本发布于何时） -->
      <div
        v-if="releaseDateText"
        class="mt-2 text-[12px] text-slate-400 flex items-center gap-1.5"
      >
        <span>最后更新</span>
        <span class="text-slate-500">{{ releaseDateText }}</span>
      </div>

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

      <!-- 当前使用的更新源（国内网络下可能自动切到加速通道） -->
      <div v-if="feedName" class="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
        <span>更新源</span>
        <span class="text-slate-500">{{ feedName }}</span>
        <span v-if="data.feed && data.feed.total > 1" class="text-slate-300">
          （第 {{ data.feed.index + 1 }}/{{ data.feed.total }} 个可用源）
        </span>
      </div>

      <p
        v-if="channel === 'update-downloaded'"
        class="mt-3 text-[12px] text-slate-400 leading-relaxed"
      >
        现在重启立即生效；若选择「稍后」，程序会在你下次退出时自动完成安装。点「关闭程序并更新」后本程序会自动关闭并静默完成安装，无需手动操作。
      </p>
    </div>

    <template #footer>
      <el-button
        v-if="channel === 'update-not-available' || channel === 'error' || channel === 'dev-skip'"
        @click="$emit('update:visible', false)"
        >知道了</el-button
      >
      <template v-else-if="channel === 'update-downloaded'">
        <el-button @click="$emit('update:visible', false)">稍后</el-button>
        <el-button type="primary" @click="$emit('install')">
          关闭程序并更新
        </el-button>
      </template>
      <template v-else>
        <el-button @click="$emit('update:visible', false)">关闭</el-button>
        <el-button type="primary" @click="$emit('background')">
          后台下载
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  channel: { type: String, default: '' },
  data: { type: Object, default: () => ({}) }
})
defineEmits(['update:visible', 'install', 'background'])

// 「最后更新」：新版本的发布时间
const releaseDateText = computed(() => {
  const d = props.data.releaseDate
  if (!d) return ''
  const t = new Date(d)
  if (Number.isNaN(t.getTime())) return String(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
})

// 更新源名称：由主进程在切换源时通过 'feed' 事件推送，也随各事件附带
const feedName = ref('')
watch(
  () => props.data.feed,
  (f) => {
    if (f && f.name) feedName.value = f.name
  },
  { immediate: true, deep: true }
)

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
