<template>
  <section class="flex flex-col bg-white border-r border-slate-200 min-h-0">
    <div
      class="px-4 py-3 border-b border-slate-200 flex items-center gap-2 flex-none"
    >
      <span class="font-semibold text-slate-700">聊天</span>
      <span class="text-[13px] text-slate-400"
        >→ {{ store.activeName || '未选择' }}</span
      >
      <el-button
        v-if="store.isGroupActive"
        class="ml-auto"
        size="small"
        type="danger"
        plain
        @click="store.leaveGroup(store.activeChatId)"
      >
        <el-icon class="mr-1"><Remove /></el-icon>退群
      </el-button>
    </div>

    <div
      class="flex-1 overflow-auto p-4 space-y-3"
      ref="listEl"
      @scroll.passive="onScroll"
    >
      <!-- 顶部：更早消息的加载入口（虚拟窗口，聊天记录再长也不会一次性全渲染） -->
      <div v-if="hiddenCount > 0" class="flex justify-center pt-1 pb-2">
        <button
          class="load-more-btn"
          type="button"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{
            loadingMore
              ? '正在加载…'
              : `向上滚动加载更早的消息（还有 ${hiddenCount} 条）`
          }}
        </button>
      </div>
      <p
        v-else-if="totalCount > PAGE"
        class="text-center text-[11px] text-slate-300 py-1"
      >
        已加载全部 {{ totalCount }} 条消息
      </p>

      <div
        v-for="(m, i) in visibleMessages"
        :key="offset + i"
        class="flex flex-col"
        :class="m.mine ? 'items-end' : 'items-start'"
      >
        <div
          class="text-[11px] text-slate-400 mb-1 px-0.5 max-w-[80%] truncate"
          :class="m.mine ? 'text-right' : 'text-left'"
        >
          {{ m.mine ? '我' : m.fromName }} · {{ fmt(m.ts) }}
        </div>
        <div
          class="flex items-end gap-2 max-w-[80%]"
          :class="m.mine ? 'flex-row-reverse' : 'flex-row'"
        >
          <Avatar
            :avatar="m.mine ? store.self.avatar : m.fromAvatar"
            :name="m.mine ? store.self.name : m.fromName"
            :size="30"
          />
          <div
            class="min-w-0 flex flex-col"
            :class="m.mine ? 'items-end' : 'items-start'"
          >
            <!-- 贴纸：大表情 -->
            <div v-if="m.kind === 'sticker'" class="text-[40px] leading-none">
              {{ m.sticker }}
            </div>

            <!-- 文件 -->
            <div
              v-else-if="m.kind === 'file'"
              class="file-card"
              :class="m.mine ? 'mine' : 'peer'"
            >
              <span class="text-[22px] flex-none">📄</span>
              <div class="min-w-0 flex-1">
                <div
                  class="font-medium text-[13px] text-slate-800 truncate max-w-[190px]"
                >
                  {{ m.file?.name }}
                </div>
                <div class="text-[11px] text-slate-400">
                  {{ fmtSize(m.file?.size) }}
                  <template v-if="m.awaiting">· 待接收</template>
                  <template v-else-if="m.receiving"
                    >· 接收中 {{ recvPct(m.fileId) }}%</template
                  >
                  <template v-else-if="m.rejected">· 已拒绝</template>
                  <template v-else-if="m.waiting">· 等待对方接收…</template>
                  <template v-else-if="m.sending || sending(m.fileId)"
                    >· 发送中 {{ sendPct(m.fileId) }}%</template
                  >
                  <template v-else-if="m.file?.path">· 已完成</template>
                  <template v-else>· 未完成</template>
                </div>
                <!-- 传输进度条：仅在发送 / 接收过程中显示 -->
                <div
                  v-if="m.receiving || m.sending || sending(m.fileId)"
                  class="progress-track"
                >
                  <div
                    class="progress-fill"
                    :style="{
                      width:
                        (m.receiving ? recvPct(m.fileId) : sendPct(m.fileId)) + '%'
                    }"
                  ></div>
                </div>
              </div>

              <!-- 接收方：等待用户确认接收（另存为会先弹出保存对话框） -->
              <div
                v-if="m.awaiting"
                class="flex gap-1 ml-auto flex-none items-center"
              >
                <el-button
                  size="small"
                  type="primary"
                  @click="store.acceptFile(m.fileId, false)"
                >
                  接收
                </el-button>
                <el-button size="small" @click="store.acceptFile(m.fileId, true)">
                  另存为
                </el-button>
                <button
                  class="reject-btn"
                  type="button"
                  title="拒绝接收"
                  @click="store.rejectFile(m.fileId)"
                >
                  拒绝
                </button>
              </div>

              <!-- 已完成：打开 / 在文件夹中显示 -->
              <div
                v-else-if="m.file?.path && !m.receiving && !m.rejected"
                class="flex gap-1 ml-auto flex-none"
              >
                <el-button
                  size="small"
                  text
                  bg
                  title="打开文件"
                  @click="open(m.file.path)"
                >
                  打开
                </el-button>
                <el-button
                  size="small"
                  text
                  bg
                  title="在文件夹中显示"
                  @click="openFolder(m.file.path)"
                >
                  文件夹
                </el-button>
              </div>
            </div>

            <!-- 文本气泡 -->
            <div
              v-else
              class="max-w-full px-3 py-2 rounded-2xl text-[14px] leading-relaxed break-words"
              :class="
                m.mine
                  ? 'bg-blue-600 text-white rounded-br-sm'
                  : 'bg-slate-100 text-slate-800 rounded-bl-sm'
              "
            >
              {{ m.text }}
            </div>
          </div>
        </div>
      </div>
      <p
        v-if="!store.activeChatId"
        class="text-slate-400 text-[13px] leading-relaxed"
      >
        从左侧选择在线设备，或新建一个群聊开始沟通。
      </p>
    </div>

    <div
      class="relative px-1 py-1 border-t border-slate-200 flex-none bg-white"
      v-if="store.activeChatId"
      ref="composerEl"
    >
      <!-- 工具栏：表情 / 贴纸 / 文件（与下方输入框、发送按钮上下排列） -->
      <div class="flex items-center gap-1 mb-1">
        <el-tooltip content="表情" placement="top">
          <button
            class="tool-btn"
            :class="{ 'tool-btn-active': showPicker && pickerTab === 'emoji' }"
            type="button"
            @click="togglePicker('emoji')"
          >
            <el-icon><ChatRound /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="贴纸" placement="top">
          <button
            class="tool-btn"
            :class="{ 'tool-btn-active': showPicker && pickerTab === 'sticker' }"
            type="button"
            @click="togglePicker('sticker')"
          >
            <el-icon><PictureFilled /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="发送文件" placement="top">
          <button
            class="tool-btn"
            type="button"
            @click="store.sendFileFromPicker()"
          >
            <el-icon><Paperclip /></el-icon>
          </button>
        </el-tooltip>
      </div>

      <!-- 输入区：多行文本框（加高），发送按钮内嵌到右下角 -->
      <div class="relative mb-2">
        <el-input
          v-model="text"
          type="textarea"
          resize="none"
          size="large"
          @keydown.enter.exact="onEnter"
          placeholder="输入消息，回车发送（Shift+Enter 换行）"
          class="chat-textarea"
        />
        <el-button
          type="primary"
          class="send-btn absolute bottom-2 right-2"
          @click="send"
        >
          <el-icon class="mr-1"><Promotion /></el-icon>发送
        </el-button>
      </div>

      <EmojiPicker
        v-if="showPicker"
        :initial-tab="pickerTab"
        @pick-emoji="insertEmoji"
        @pick-sticker="sendSticker"
      />
    </div>
  </section>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useStore } from '../store/index.js'
import EmojiPicker from './EmojiPicker.vue'
import Avatar from './Avatar.vue'

const store = useStore()
const text = ref('')
const listEl = ref(null)
const composerEl = ref(null)
const showPicker = ref(false)
const pickerTab = ref('emoji')

// ===== 聊天记录渲染窗口 =====
// 一个会话最多缓存 400 条（见 store 的 MAX_MSG_PER_CONV），若一次性全部渲染，
// 每条消息又包含头像 + 气泡 + 文件卡片等 DOM，节点数会迅速膨胀，拖慢渲染与滚动。
// 因此只渲染最近 PAGE 条，向上滚动到顶部时再逐步加载更早的。
const PAGE = 30
const SCROLL_THRESHOLD = 48 // 距顶部多少像素内触发加载
const visibleCount = ref(PAGE)
const loadingMore = ref(false)

const totalCount = computed(() => store.activeMessages.length)
// 起始索引（用于生成稳定的 v-for key，避免 prepend 后 key 漂移）
const offset = computed(() => Math.max(0, totalCount.value - visibleCount.value))
const visibleMessages = computed(() => store.activeMessages.slice(offset.value))
const hiddenCount = computed(() => offset.value)

// 加载更早的一页。关键点：prepend 后要按「新增的高度差」回补 scrollTop，
// 否则视口会猛地跳到顶部，用户会失去原来的阅读位置。
async function loadMore() {
  if (loadingMore.value || hiddenCount.value <= 0) return
  loadingMore.value = true
  const el = listEl.value
  const prevHeight = el ? el.scrollHeight : 0
  const prevTop = el ? el.scrollTop : 0
  visibleCount.value = Math.min(totalCount.value, visibleCount.value + PAGE)
  await nextTick()
  if (el) {
    el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
  }
  loadingMore.value = false
}

function onScroll() {
  const el = listEl.value
  if (!el) return
  if (el.scrollTop <= SCROLL_THRESHOLD && hiddenCount.value > 0) {
    loadMore()
  }
}

function fmt(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
function fmtSize(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}
function send() {
  if (!text.value.trim()) return
  store.sendChat(text.value)
  text.value = ''
  showPicker.value = false
}
// 回车发送，Shift+Enter 换行；中文输入法组合过程中的回车不触发发送
function onEnter(e) {
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  send()
}
function togglePicker(tab) {
  pickerTab.value = tab || 'emoji'
  showPicker.value = true
}
function insertEmoji(e) {
  text.value += e
}
function sendSticker(s) {
  store.sendSticker(s)
  showPicker.value = false
}
function open(p) {
  if (p) window.api.openPath(p)
}
function openFolder(p) {
  if (p) window.api.openFolder(p)
}
function sending(fileId) {
  return !!store.fileSend[fileId] && store.fileSend[fileId].sending
}
function sendPct(fileId) {
  const f = store.fileSend[fileId]
  if (!f || !f.total) return 0
  return Math.min(100, Math.round((f.done / f.total) * 100))
}
function recvPct(fileId) {
  const f = store.fileRecv[fileId]
  if (!f || !f.total) return 0
  return Math.min(100, Math.round((f.received / f.total) * 100))
}

// 点击输入区（工具栏 + 输入框 + 选择面板）之外的任意区域时，关闭表情/贴纸面板
function onDocMouseDown(e) {
  if (!showPicker.value) return
  if (composerEl.value && !composerEl.value.contains(e.target)) {
    showPicker.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', onDocMouseDown, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown, true))

watch(
  () => store.activeMessages.length,
  async () => {
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  }
)

// 切换会话时重置渲染窗口，只显示该会话最近 PAGE 条
watch(
  () => store.activeChatId,
  async () => {
    visibleCount.value = PAGE
    loadingMore.value = false
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  }
)
</script>

<style scoped>
/* 顶部「加载更早消息」按钮 */
.load-more-btn {
  padding: 4px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #f8fafc;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.load-more-btn:hover:not(:disabled) {
  background: #eff6ff;
  color: #2563eb;
  border-color: #bfdbfe;
}
.load-more-btn:disabled {
  cursor: default;
  opacity: 0.7;
}
/* 文件消息卡片：发送方 / 接收方两种底色 */
.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 12px;
  max-width: 100%;
}
.file-card.mine {
  border-color: #bfdbfe; /* blue-200 */
  background: #eff6ff; /* blue-50 */
}
.file-card.peer {
  border-color: #e2e8f0; /* slate-200 */
  background: #f8fafc; /* slate-50 */
}
/* 文件传输进度条 */
.progress-track {
  margin-top: 6px;
  height: 4px;
  border-radius: 9999px;
  background: rgba(148, 163, 184, 0.35);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 9999px;
  background: #2563eb;
  transition: width 0.15s ease;
}
/* 「拒绝接收」按钮：轻量描边样式，避免与发送按钮抢视觉 */
.reject-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  background: #ffffff;
  color: #64748b;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;
}
.reject-btn:hover {
  border-color: #f43f5e;
  color: #e11d48;
}
/* 底部输入栏工具栏按钮：Element Plus 的 text/small 按钮偏小，
   这里改用自定义按钮做得更大更统一，提升可点性与观感。 */
.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}
.tool-btn:hover {
  background: #f1f5f9;
  color: #2563eb;
}
/* 面板展开时高亮对应的工具按钮 */
.tool-btn-active {
  background: #eff6ff;
  color: #2563eb;
}
.tool-btn :deep(.el-icon) {
  font-size: 20px;
}
/* 多行输入框：固定高度约 180px，并留出右下角「发送」按钮的位置 */
.chat-textarea :deep(.el-textarea__inner) {
  height: 130px;
  line-height: 1.6;
  border-radius: 12px;
  padding: 10px 12px 46px 12px;
}
/* 内嵌在输入框右下角的发送按钮 */
.send-btn {
  border-radius: 10px;
  box-shadow: 0 1px 4px rgba(37, 99, 235, 0.28);
}
</style>
