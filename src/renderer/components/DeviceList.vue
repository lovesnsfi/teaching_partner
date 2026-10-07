<template>
  <aside class="flex flex-col bg-white border-r border-slate-200 min-h-0">
    <div
      class="px-4 py-3 font-semibold border-b border-slate-200 flex items-center gap-2 text-slate-700 flex-none"
    >
      联系人
      <span class="ml-auto text-[12px] font-normal text-slate-400"
        >在线 {{ store.onlineContactCount }} / 共
        {{ store.contactList.length }}</span
      >
    </div>

    <div class="px-3 py-2 border-b border-slate-100 flex-none">
      <el-input
        v-model="search"
        size="small"
        clearable
        placeholder="搜索昵称或 IP 地址"
      />
    </div>

    <div class="flex-1 overflow-auto p-3 space-y-2">
      <div
        v-for="c in filteredContacts"
        :key="c.id"
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
            {{ c.online ? c.ip + ':' + c.port : '离线' }}
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

      <!-- 右键离线联系人弹出的删除菜单 -->
      <div
        v-if="menu.visible"
        class="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 text-[13px] text-slate-700 min-w-[120px]"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @click.stop
      >
        <button
          class="block w-full text-left px-3 py-1.5 hover:bg-rose-50 hover:text-rose-600"
          @click="deleteContact"
        >
          删除联系人
        </button>
      </div>

      <div
        class="flex items-center gap-2 mt-4 mb-2 text-[12px] text-slate-400 pt-2 border-t border-slate-100"
      >
        群聊
        <span>({{ store.groups.length }})</span>
        <el-button
          type="primary"
          size="small"
          class="ml-auto"
          @click="showModal = true"
        >
          <el-icon class="mr-1"><Plus /></el-icon>新建
        </el-button>
      </div>

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

      <p v-if="!store.groups.length" class="text-slate-400 text-[13px] px-1">
        还没有群聊，点「新建」拉人建群。
      </p>
    </div>

    <GroupModal v-if="showModal" @close="showModal = false" @create="onCreate" />
  </aside>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useStore } from '../store/index.js'
import GroupModal from './GroupModal.vue'
import Avatar from './Avatar.vue'

const store = useStore()
const showModal = ref(false)

// 右键菜单状态（仅离线联系人可触发，在线联系人忽略）
const menu = reactive({ visible: false, x: 0, y: 0, id: null })

function openMenu(c, e) {
  if (c.online) return // 在线联系人不可删除
  menu.id = c.id
  menu.x = e.clientX
  menu.y = e.clientY
  menu.visible = true
}
function closeMenu() {
  menu.visible = false
  menu.id = null
}
function deleteContact() {
  if (menu.id) store.deleteContact(menu.id)
  closeMenu()
}
// 点击别处或右键别处时关闭菜单
function onDocClick() {
  if (menu.visible) closeMenu()
}
function onDocContextMenu() {
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

// 联系人搜索：按昵称或 IP 地址过滤（不区分大小写、子串匹配）
const search = ref('')
const filteredContacts = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return store.contactList
  return store.contactList.filter(
    (c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.ip || '').toLowerCase().includes(q)
  )
})

function onCreate({ name, memberIds }) {
  store.createGroup(name, memberIds)
}
</script>
