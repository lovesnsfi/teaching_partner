<template>
  <section
    class="relative flex flex-col bg-white border-r border-slate-200 min-h-0"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
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
        <!-- 头像 + 内容：顶部对齐。
             早前用 items-end 让短文本气泡的头像贴着最后一行，但遇到图片、
             文件卡片这类高内容时头像会被顶到最下方，与上方昵称时间脱节，
             视觉上非常突兀，因此统一改为顶部对齐。 -->
        <div
          class="flex items-start gap-2 max-w-[80%]"
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

            <!-- 文件 / 图片（图片带 image/* mime，内联直接显示） -->
            <div
              v-else-if="m.kind === 'file' && isImageMsg(m) && !isPending(m)"
              class="flex"
              :class="m.mine ? 'justify-end' : 'justify-start'"
            >
              <ChatImage
                :path="m.file?.path"
                :name="m.file?.name"
                :mine="m.mine"
                @preview="openPreview"
                @contextmenu="openImgMenu(m, $event)"
              />
            </div>

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
                  <template v-if="m.cancelled"
                    >· {{ m.mine ? '对方已取消接收' : '已取消接收' }}</template
                  >
                  <template v-else-if="m.awaiting">· 待接收</template>
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

              <!-- 接收中：可随时中断（删除半截文件并通知发送方停发） -->
              <button
                v-if="m.receiving"
                class="reject-btn flex-none"
                type="button"
                title="取消接收"
                @click="cancelReceive(m.fileId)"
              >
                取消
              </button>

              <!-- 接收方：等待用户确认接收（另存为会先弹出保存对话框） -->
              <div
                v-else-if="m.awaiting"
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
        <el-tooltip content="框选截屏（拖动选择区域，复制并发送）" placement="top">
          <button
            class="tool-btn"
            type="button"
            :disabled="shooting"
            @click="takeScreenshot"
          >
            <el-icon><Camera /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="发送图片（也可直接 Ctrl+V 粘贴）" placement="top">
          <button
            class="tool-btn"
            type="button"
            @click="pickImages()"
          >
            <el-icon><Picture /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="发送文件" placement="top">
          <button
            class="tool-btn"
            type="button"
            @click="pickFiles()"
          >
            <el-icon><Paperclip /></el-icon>
          </button>
        </el-tooltip>
      </div>

      <!-- 复合输入框：工具栏在上，附件栏与文本区同在一个圆角容器内，更像钉钉/飞书的输入体验 -->
      <div class="composer-box">
        <!-- 待发送附件栏：选文件 / 拖拽文件后先暂存于此，点「发送」才真正发起传输 -->
        <div v-if="pending.length" class="attach-zone">
          <div
            v-for="(a, i) in pending"
            :key="a.id"
            class="attach-item"
            :class="{ 'is-image': a.isImage }"
          >
            <img v-if="a.isImage && a.thumb" :src="a.thumb" class="attach-thumb" alt="" />
            <span v-else class="attach-file-icon">📄</span>
            <div class="attach-meta">
              <div class="attach-name" :title="a.name">{{ a.name }}</div>
              <div class="attach-size">{{ fmtSize(a.size) }}</div>
            </div>
            <button
              class="attach-del"
              type="button"
              title="移除"
              @click="removePending(i)"
            >
              ×
            </button>
          </div>
        </div>

        <!-- 多行文本框，发送按钮内嵌到右下角 -->
        <div class="relative">
          <el-input
            v-model="text"
            type="textarea"
            resize="none"
            size="large"
            @keydown.enter.exact="onEnter"
            placeholder="输入消息，回车发送（Shift+Enter 换行；可直接粘贴截图）"
            class="chat-textarea"
            @paste="onPaste"
          />
          <el-button
            type="primary"
            class="send-btn absolute bottom-2 right-2"
            @click="send"
          >
            <el-icon class="mr-1"><Promotion /></el-icon>发送
          </el-button>
        </div>
      </div>

      <EmojiPicker
        v-if="showPicker"
        :initial-tab="pickerTab"
        @pick-emoji="insertEmoji"
        @pick-sticker="sendSticker"
      />
    </div>

    <!-- 图片右键菜单：复制 / 转发 / 另存为 -->
    <div
      v-if="imgMenu.visible"
      class="fixed z-[9999] bg-white border border-slate-200 rounded-lg shadow-lg py-1 text-[13px] text-slate-700 min-w-[132px]"
      :style="{ left: imgMenu.x + 'px', top: imgMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div class="px-3 pb-1 pt-0.5 text-[11px] text-slate-400 truncate">
        {{ imgMenu.name }}
      </div>
      <div class="my-1 border-t border-slate-100"></div>
      <button class="img-menu-item" type="button" @click="doCopyImage">
        复制
      </button>
      <button class="img-menu-item" type="button" @click="openForward">
        转发图片
      </button>
      <button class="img-menu-item" type="button" @click="doSaveImage">
        另存为
      </button>
    </div>

    <!-- 转发图片：选择联系人（可多选） -->
    <ForwardDialog
      v-if="showForward"
      :visible="showForward"
      :store="store"
      @update:visible="showForward = $event"
      @submit="doForward"
    />

    <!-- 图片大图预览 -->
    <div
      v-if="previewSrc"
      class="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-6"
      @click="previewSrc = ''"
    >
      <img
        :src="previewSrc"
        :alt="previewName"
        class="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
      />
      <div
        class="absolute top-4 right-5 text-white text-[13px] px-3 py-1 rounded bg-white/15"
      >
        {{ previewName }} · 点击空白处关闭
      </div>
    </div>
    <!-- 拖拽文件到聊天窗口时显示的提示遮罩（pointer-events:none，不拦截 drop） -->
    <div v-if="dragActive" class="drag-overlay">
      <div class="drag-overlay-inner">
        <div class="drag-overlay-icon">📥</div>
        <div class="drag-overlay-text">松开发送文件</div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useStore } from '../store/index.js'
import EmojiPicker from './EmojiPicker.vue'
import Avatar from './Avatar.vue'
import ChatImage from './ChatImage.vue'
import ForwardDialog from './ForwardDialog.vue'

const store = useStore()
const text = ref('')

// ===== 待发送附件（选文件 / 拖拽后暂存，点「发送」才真正发起传输）=====
const pending = ref([])
const dragActive = ref(false)
let dragDepth = 0

function makeAttachment(f) {
  if (!f || !f.path) return null
  const isImage = String(f.mime || '').startsWith('image/')
  const att = {
    id:
      (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
      'a-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    name: f.name || '未命名文件',
    size: f.size || 0,
    mime: f.mime || '',
    path: f.path,
    isImage,
    // 图片异步取缩略图（与 ChatImage 一致，走本地 data URI）；非图片用 null 标记
    thumb: isImage ? '' : null
  }
  if (isImage) {
    window.api
      .getFileDataUrl(f.path)
      .then((d) => {
        att.thumb = d || ''
      })
      .catch(() => {
        att.thumb = ''
      })
  }
  return att
}

function addFiles(files) {
  if (!store.activeChatId) {
    ElMessage.warning('请先选择要发送的对象')
    return
  }
  const arr = Array.isArray(files) ? files : Array.from(files || [])
  let added = 0
  for (const f of arr) {
    const att = makeAttachment(f)
    if (att) {
      pending.value.push(att)
      added++
    }
  }
  if (added > 0 && arr.length > added) ElMessage.warning('已忽略无法识别的文件')
}

// 工具栏「文件」按钮：可多选，加入待发送
async function pickFiles() {
  const files = await window.api.pickFile()
  addFiles(files)
}
// 工具栏「图片」按钮：可多选，加入待发送（图片仍内联显示）
async function pickImages() {
  const files = await window.api.pickImage()
  addFiles(files)
}
function removePending(i) {
  pending.value.splice(i, 1)
}

// 拖拽文件到聊天窗口：dragenter/leave 用计数配对，避免子元素穿插导致遮罩闪烁
function onDragEnter() {
  dragDepth++
  dragActive.value = true
}
function onDragOver() {
  dragActive.value = true
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragActive.value = false
}
function onDrop(e) {
  dragDepth = 0
  dragActive.value = false
  const dt = e.dataTransfer
  if (!dt) return
  // 只处理带本地路径的文件（Electron 拖放才有 path），忽略纯文本拖拽
  const local = Array.from(dt.files || []).filter((f) => f && f.path)
  addFiles(local)
}
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

// ===== 图片 =====
// 文件消息带 image/* 的 mime 时，渲染为内联图片而不是文件卡片
function isImageMsg(m) {
  return !!(m && m.file && String(m.file.mime || '').startsWith('image/'))
}
// 传输未完成（等待确认 / 收发中 / 被拒 / 已取消）时先显示进度卡片，完成后才显示图片
function isPending(m) {
  return !!(
    m.awaiting ||
    m.receiving ||
    m.rejected ||
    m.cancelled ||
    m.waiting ||
    m.sending ||
    sending(m.fileId)
  )
}
const previewSrc = ref('')
const previewName = ref('')
function openPreview(src, name) {
  previewSrc.value = src
  previewName.value = name || ''
}

// ===== 截屏 =====
const shooting = ref(false)
async function takeScreenshot() {
  if (shooting.value) return
  shooting.value = true
  try {
    const r = await store.beginScreenshot()
    if (r && r.ok) {
      ElMessage.success('已打开框选截屏：按住左键拖动选区，双击或回车完成')
    } else if (r && r.reason) {
      ElMessage.error(r.reason)
    }
  } catch {
    ElMessage.error('截屏失败')
  } finally {
    // 框选是异步流程（选区确认后才结束），这里先恢复按钮可用状态
    setTimeout(() => {
      shooting.value = false
    }, 800)
  }
}

// ===== 传输中取消接收 =====
async function cancelReceive(fileId) {
  const ok = await store.cancelReceive(fileId)
  if (ok) ElMessage.info('已取消接收')
}

// ===== 图片右键菜单（复制 / 转发 / 另存为）=====
const imgMenu = reactive({ visible: false, x: 0, y: 0, msg: null, name: '' })
const showForward = ref(false)

function openImgMenu(m, e) {
  if (!m || !m.file || !m.file.path) return
  imgMenu.msg = m
  imgMenu.name = m.file.name || '图片'
  imgMenu.x = Math.max(8, Math.min(e.clientX, window.innerWidth - 150))
  imgMenu.y = Math.max(8, Math.min(e.clientY, window.innerHeight - 150))
  imgMenu.visible = true
}
function closeImgMenu() {
  imgMenu.visible = false
  imgMenu.msg = null
}

async function doCopyImage() {
  const m = imgMenu.msg
  closeImgMenu()
  if (!m) return
  const ok = await window.api.copyImage(m.file.path)
  if (ok) ElMessage.success('图片已复制到剪贴板')
  else ElMessage.error('复制失败')
}

async function doSaveImage() {
  const m = imgMenu.msg
  closeImgMenu()
  if (!m) return
  const r = await window.api.saveImageAs({ path: m.file.path, name: m.file.name })
  if (r && r.ok) ElMessage.success('图片已保存')
  else if (r && r.canceled) ElMessage.info('已取消保存')
  else ElMessage.error('保存失败')
}

function openForward() {
  imgMenu.visible = false
  showForward.value = true
}
function doForward(ids) {
  const m = imgMenu.msg
  showForward.value = false
  if (!m || !m.file || !m.file.path) return
  const n = store.forwardImage(
    { path: m.file.path, name: m.file.name, size: m.file.size, mime: m.file.mime },
    ids
  )
  imgMenu.msg = null
  if (n > 0) ElMessage.success(`已转发给 ${n} 个会话`)
  else ElMessage.warning('没有可转发的在线联系人')
}

// 直接粘贴截图（Ctrl+V）：把剪贴板里的图片落到临时文件，再走文件通道发送
async function onPaste(e) {
  const items = (e.clipboardData && e.clipboardData.items) || []
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const blob = it.getAsFile()
      if (!blob) continue
      e.preventDefault()
      if (!store.activeChatId) {
        ElMessage.warning('请先选择要发送的对象')
        return
      }
      try {
        const file = await window.api.saveClipboardImage(blob, it.type)
        if (!file) {
          ElMessage.error('图片保存失败')
          return
        }
        store.sendImageFile(file)
      } catch {
        ElMessage.error('图片发送失败')
      }
      return
    }
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
  const id = store.activeChatId
  if (!id) return
  const hasText = !!text.value.trim()
  const hasFiles = pending.value.length > 0
  if (!hasText && !hasFiles) return
  // 文字与附件各自成一条消息先后发出（现有消息模型为单 kind，无法混排于一条）
  if (hasText) {
    store.sendChat(text.value)
    text.value = ''
  }
  for (const att of pending.value) {
    store._sendFileToConversation(id, att)
  }
  pending.value = []
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
onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true)
  // 框选截屏完成：图片已在剪贴板，这里只提示，不自动发送
  window.api.onShotResult((m) => {
    store.handleShotResult(m)
    if (m && m.ok) ElMessage.success('截图已复制到剪贴板，可直接粘贴到聊天框发送')
  })
})
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
    pending.value = [] // 切换会话时清空待发送附件，避免发错人
    await nextTick()
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  }
)
</script>

<style scoped>
/* 图片右键菜单项 */
.img-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: #334155;
  font-size: 13px;
  cursor: pointer;
}
.img-menu-item:hover {
  background: #f1f5f9;
}
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
/* 复合输入框容器：工具栏在上，附件栏与文本区在同一边框内 */
.composer-box {
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  background: #ffffff;
  padding: 6px;
  margin-bottom: 8px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.composer-box:focus-within {
  border-color: #bfdbfe;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.06);
}
/* 多行输入框：固定高度约 180px，并留出右下角「发送」按钮的位置 */
.chat-textarea :deep(.el-textarea__inner) {
  height: 130px;
  line-height: 1.6;
  border-radius: 10px;
  padding: 10px 12px 46px 12px;
  border: none;
  box-shadow: none;
  background: transparent;
}
.chat-textarea :deep(.el-textarea__inner:focus) {
  box-shadow: none;
}
/* 内嵌在输入框右下角的发送按钮 */
.send-btn {
  border-radius: 10px;
  box-shadow: 0 1px 4px rgba(37, 99, 235, 0.28);
}
/* 待发送附件栏：位于复合输入框内部上方，允许换行；整体高度固定，超出竖向滚动，避免撑高输入框 */
.attach-zone {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  padding: 4px 4px 6px;
  max-height: 112px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
}
.attach-zone::-webkit-scrollbar {
  width: 5px;
}
.attach-zone::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 3px;
}
.attach-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  max-width: 230px;
  padding: 6px 8px 6px 6px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}
.attach-item.is-image {
  padding: 4px;
}
.attach-thumb {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  object-fit: cover;
  flex: none;
  background: #e2e8f0;
}
.attach-file-icon {
  font-size: 22px;
  flex: none;
  line-height: 1;
}
.attach-meta {
  min-width: 0;
  flex: 1;
}
.attach-name {
  font-size: 12px;
  color: #334155;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.attach-size {
  font-size: 11px;
  color: #94a3b8;
}
.attach-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  padding: 0;
  background: #e2e8f0;
  color: #64748b;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.attach-del:hover {
  background: #fecdd3;
  color: #e11d48;
}
/* 拖拽文件提示遮罩 */
.drag-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(37, 99, 235, 0.08);
  border: 2px dashed #2563eb;
  pointer-events: none;
  border-radius: 8px;
}
.drag-overlay-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 28px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.92);
  color: #2563eb;
  box-shadow: 0 6px 24px rgba(37, 99, 235, 0.18);
}
.drag-overlay-icon {
  font-size: 40px;
  line-height: 1;
}
.drag-overlay-text {
  font-size: 15px;
  font-weight: 600;
}
</style>
