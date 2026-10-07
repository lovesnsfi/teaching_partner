<template>
  <aside class="flex flex-col bg-white border-r border-slate-200 min-h-0">
    <!-- 分段标签：联系人 / 群聊。分成两个 tab 是为了联系人很多时，
         群聊区不会被长列表顶到下面看不见。 -->
    <div class="flex border-b border-slate-200 flex-none px-2 pt-1.5">
      <button class="tab-btn" :class="{ active: tab === 'contacts' }" @click="tab = 'contacts'">
        联系人
        <span class="tab-badge">{{ store.contactList.length }}</span>
        <span v-if="contactUnread" class="tab-unread">{{ contactUnread }}</span>
      </button>
      <button class="tab-btn" :class="{ active: tab === 'groups' }" @click="tab = 'groups'">
        群聊
        <span class="tab-badge">{{ store.groups.length }}</span>
        <span v-if="groupUnread" class="tab-unread">{{ groupUnread }}</span>
      </button>
    </div>

    <!-- ============ 联系人 Tab ============ -->
    <template v-if="tab === 'contacts'">
      <div class="px-3 py-2 border-b border-slate-100 flex-none">
        <el-input
          v-model="search"
          size="small"
          clearable
          placeholder="搜索昵称 / 电脑设备名 / IP"
        />
      </div>
      <div class="px-3 py-1.5 text-[11px] text-slate-400 border-b border-slate-100 flex-none">
        在线 {{ store.onlineContactCount }} / 共 {{ store.contactList.length }}
      </div>

      <div class="flex-1 overflow-auto p-3 space-y-2">
        <div
          v-for="c in filteredContacts"
          :key="c.id"
          data-contact-item
          @click="store.setActiveChat(c.id)"
          @contextmenu.prevent="openMenu(c, $event)"
          class="flex items-center gap-2.5 p-2.5 border rounded-xl cursor-pointer transition-colors"
          :class="
            c.id === store.activeChatId
              ? 'border-blue-500 bg-blue-50'
              : 'border-slate-200 hover:bg-slate-50'
          "
        >
          <Avatar :avatar="c.avatar" :name="c.name" :size="36" :online="c.online" />
          <div class="min-w-0">
            <div class="font-medium text-slate-800 truncate flex items-center gap-1.5">
              {{ c.name }}
              <span
                class="w-1.5 h-1.5 rounded-full flex-none"
                :class="c.online ? 'bg-emerald-500' : 'bg-slate-300'"
              ></span>
            </div>
            <div class="text-[12px] text-slate-400 truncate">
              <!-- 电脑设备名是稳定标识，昵称/IP 都可改，这里优先展示设备名 -->
              <span v-if="c.host" class="text-slate-500">{{ c.host }}</span>
              <span v-if="c.host && (c.online || c.ip)"> · </span>
              <span>{{ c.online ? c.ip + ':' + c.port : '离线' }}</span>
            </div>
          </div>
          <span
            v-if="c.role === 'teacher'"
            class="ml-1 text-[11px] text-white bg-amber-600 rounded-md px-1.5 py-0.5 flex-none"
            >老师</span
          >
          <span
            v-if="store.unread[c.id]"
            class="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[11px] grid place-items-center flex-none"
            >{{ store.unread[c.id] }}</span
          >
        </div>

        <p
          v-if="store.contactList.length && !filteredContacts.length"
          class="text-slate-400 text-[13px] px-1 py-2"
        >
          没有匹配「{{ search }}」的联系人。
        </p>

        <p
          v-if="!store.contactList.length"
          class="text-slate-400 text-[13px] leading-relaxed px-1"
        >
          正在扫描局域网…<br />确保同网段，并放行 UDP 41234（发现）/ 41235（信令）。<br />
          上线过的小伙伴会自动出现在这里。
        </p>
      </div>
    </template>

    <!-- ============ 群聊 Tab ============ -->
    <template v-else>
      <div class="flex-1 overflow-auto p-3 space-y-2">
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

        <p v-if="!store.groups.length" class="text-slate-400 text-[13px] px-1 leading-relaxed">
          还没有群聊，点下方「新建群聊」拉人建群。
        </p>
      </div>

      <!-- 新建按钮固定在底部，不随列表滚动 -->
      <div class="px-3 py-2 border-t border-slate-100 flex-none">
        <el-button type="primary" class="w-full" @click="showModal = true">
          <el-icon class="mr-1"><Plus /></el-icon>新建群聊
        </el-button>
      </div>
    </template>

    <!-- 右键离线联系人弹出的删除菜单 -->
    <div
      v-if="menu.visible"
      class="fixed z-[9999] bg-white border border-slate-200 rounded-lg shadow-lg py-1 text-[13px] text-slate-700 min-w-[168px]"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div class="px-3 pb-1 pt-0.5 text-[11px] text-slate-400 truncate">
        {{ menu.label }}
      </div>
      <div class="my-1 border-t border-slate-100"></div>
      <button
        class="block w-full text-left px-3 py-1.5 hover:bg-rose-50 hover:text-rose-600"
        @click="deleteContact"
      >
        删除联系人并清除聊天记录
      </button>
    </div>

    <GroupModal v-if="showModal" @close="showModal = false" @create="onCreate" />
  </aside>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useStore } from '../store/index.js'
import GroupModal from './GroupModal.vue'
import Avatar from './Avatar.vue'

const store = useStore()
const showModal = ref(false)
// 当前所在标签页：'contacts' 联系人 | 'groups' 群聊
const tab = ref('contacts')

// 两个 tab 各自的未读总数，方便在标签上提示
const contactUnread = computed(() =>
  store.contactList.reduce((sum, c) => sum + (store.unread[c.id] || 0), 0)
)
const groupUnread = computed(() =>
  store.groups.reduce((sum, g) => sum + (store.unread[g.id] || 0), 0)
)

// 右键菜单状态（仅离线联系人可触发，在线联系人右键会直接收起菜单）
const menu = reactive({ visible: false, x: 0, y: 0, id: null, label: '' })

// 在离线联系人上右键 → 弹出删除菜单
function openMenu(c, e) {
  if (c.online) {
    // 在线联系人不可删除：顺手把已展开的菜单收起
    closeMenu()
    return
  }
  menu.id = c.id
  // 菜单里显示是哪一位，避免列表里多个同名/离线项时删错
  menu.label = [c.name || '未命名', c.host].filter(Boolean).join(' · ')
  // 贴近鼠标，并做边界翻转，避免菜单跑到窗口外
  const w = 176
  const h = 76
  menu.x = Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8))
  menu.y = Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8))
  menu.visible = true
}
function closeMenu() {
  menu.visible = false
  menu.id = null
  menu.label = ''
}
// 删除是不可逆的（聊天记录一并清除），必须二次确认
async function deleteContact() {
  const id = menu.id
  const label = menu.label
  closeMenu()
  if (!id) return
  try {
    await ElMessageBox.confirm(
      `确定删除「${label}」吗？\n\n` +
        '· 该联系人会从左侧列表移除；\n' +
        '· 与该联系人的全部聊天记录会一并清除，且无法恢复；\n' +
        '· 对方之后重新上线时仍会出现在列表中（设备还是同一台），但历史记录不再显示。',
      '删除联系人',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    // 用户点了取消
    return
  }
  store.deleteContact(id)
}
// 点击别处时关闭菜单
function onDocClick() {
  if (menu.visible) closeMenu()
}
// 在别处右键时关闭菜单。
// 注意：事件会先在联系人条目上触发 openMenu，再冒泡到 document。
// 若这里不区分来源，就会把刚打开的菜单立刻关掉（旧版本正是因为这个 bug
// 导致右键菜单从来没真正显示出来）。
function onDocContextMenu(e) {
  if (e.target && e.target.closest && e.target.closest('[data-contact-item]')) {
    return
  }
  if (menu.visible) closeMenu()
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('contextmenu', onDocContextMenu)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('contextmenu', onDocContextMenu)
})

// 联系人搜索：按昵称 / 电脑设备名 / IP 地址过滤（都不区分大小写、子串匹配）
const search = ref('')
const filteredContacts = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.contactList
  return store.contactList.filter(
    (c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.host || '').toLowerCase().includes(q) ||
      (c.ip || '').toLowerCase().includes(q)
  )
})

function onCreate({ name, memberIds }) {
  store.createGroup(name, memberIds)
  tab.value = 'groups'
}
</script>

<style scoped>
/* 顶部分段标签：联系人 / 群聊 */
.tab-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 12px 10px;
  border: none;
  background: transparent;
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s ease;
}
.tab-btn:hover {
  color: #475569;
}
.tab-btn.active {
  color: #2563eb;
  border-bottom-color: #2563eb;
}
/* 标签上的总数（灰色小圆角块） */
.tab-badge {
  min-width: 18px;
  height: 17px;
  padding: 0 5px;
  border-radius: 9999px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 11px;
  font-weight: 400;
  display: inline-grid;
  place-items: center;
}
.tab-btn.active .tab-badge {
  background: #dbeafe;
  color: #2563eb;
}
/* 未读消息数（红点角标） */
.tab-unread {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 9999px;
  background: #e11d48;
  color: #fff;
  font-size: 11px;
  font-weight: 400;
  display: inline-grid;
  place-items: center;
}
</style>
