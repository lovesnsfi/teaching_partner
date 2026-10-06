<template>
  <section class="flex flex-col bg-white border-r border-slate-200 min-h-0">
    <div
      class="px-4 py-3 border-b border-slate-200 flex items-center gap-2 flex-none"
    >
      <span class="font-semibold text-slate-700">聊天</span>
      <span class="text-[13px] text-slate-400"
        >→ {{ store.activeName || '未选择' }}</span
      >
      <button
        v-if="store.isGroupActive"
        class="ml-auto text-[12px] px-2 py-0.5 text-rose-600 border-rose-200 hover:bg-rose-50"
        @click="store.leaveGroup(store.activeChatId)"
      >
        退群
      </button>
    </div>

    <div class="flex-1 overflow-auto p-4 space-y-3" ref="listEl">
      <div
        v-for="(m, i) in store.activeMessages"
        :key="i"
        class="flex flex-col"
        :class="m.mine ? 'items-end' : 'items-start'"
      >
        <div
          class="flex items-end gap-2 max-w-full"
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
              class="flex items-center gap-2 p-2.5 border rounded-xl max-w-[80%]"
              :class="
                m.mine ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'
              "
            >
              <span class="text-[22px] flex-none">📄</span>
              <div class="min-w-0">
                <div class="font-medium text-[13px] text-slate-800 truncate max-w-[160px]">
                  {{ m.file?.name }}
                </div>
                <div class="text-[11px] text-slate-400">
                  {{ fmtSize(m.file?.size) }}
                  <template v-if="m.receiving"
                    >· 接收中 {{ recvPct(m.fileId) }}%</template
                  >
                  <template v-else-if="m.sending || sending(m.fileId)"
                    >· 发送中 {{ sendPct(m.fileId) }}%</template
                  >
                  <template v-else>· 已完成</template>
                </div>
              </div>
              <div
                class="flex gap-2 ml-auto flex-none"
                v-if="m.file?.path && !m.receiving"
              >
                <button @click="open(m.file.path)">打开</button>
                <button @click="openFolder(m.file.path)">文件夹</button>
              </div>
            </div>

            <!-- 文本气泡 -->
            <div
              v-else
              class="max-w-[75%] px-3 py-2 rounded-2xl text-[14px] leading-relaxed break-words"
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

        <div class="text-[11px] text-slate-400 mt-1">
          {{ m.mine ? '我' : m.fromName }} · {{ fmt(m.ts) }}
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
      class="relative flex items-center gap-1 p-2.5 border-t border-slate-200 flex-none"
      v-if="store.activeChatId"
    >
      <span
        class="w-8 h-8 grid place-items-center text-[16px] rounded-lg hover:bg-slate-100 cursor-pointer select-none"
        title="表情"
        @click="togglePicker('emoji')"
        >😊</span
      >
      <span
        class="w-8 h-8 grid place-items-center text-[16px] rounded-lg hover:bg-slate-100 cursor-pointer select-none"
        title="贴纸"
        @click="togglePicker('sticker')"
        >🖼️</span
      >
      <span
        class="w-8 h-8 grid place-items-center text-[16px] rounded-lg hover:bg-slate-100 cursor-pointer select-none"
        title="发送文件"
        @click="store.sendFileFromPicker()"
        >📎</span
      >
      <input
        v-model="text"
        @keyup.enter="send"
        placeholder="输入消息，回车发送"
        class="flex-1"
      />
      <button class="primary" @click="send">发送</button>
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
import { ref, watch, nextTick } from 'vue'
import { useStore } from '../store/index.js'
import EmojiPicker from './EmojiPicker.vue'
import Avatar from './Avatar.vue'

const store = useStore()
const text = ref('')
const listEl = ref(null)
const showPicker = ref(false)
const pickerTab = ref('emoji')

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

watch(
  () => store.activeMessages.length,
  async () => {
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  }
)
</script>
