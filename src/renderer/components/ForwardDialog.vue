<template>
  <el-dialog
    :model-value="visible"
    title="转发图片"
    width="440px"
    :close-on-click-modal="true"
    @update:model-value="close($event)"
  >
    <div class="text-[13px] text-slate-600">
      <div class="flex items-center gap-2 mb-3">
        <el-input
          v-model="kw"
          size="small"
          clearable
          placeholder="搜索联系人或群聊"
        />
      </div>

      <div class="list-scroll">
        <el-checkbox-group v-model="selected" class="w-full">
          <label
            v-for="t in targets"
            :key="t.id"
            class="target-row"
          >
            <el-checkbox :value="t.id" />
            <span
              class="w-8 h-8 rounded-full grid place-items-center text-[13px] flex-none"
              :class="t.kind === 'group' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-600'"
            >
              {{ t.kind === 'group' ? '群' : (t.name || '?').slice(0, 1) }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="font-medium text-slate-800 truncate">{{ t.name }}</div>
              <div class="text-[11px] text-slate-400 truncate">
                {{ t.kind === 'group' ? `${t.members} 人` : t.ip }}
              </div>
            </div>
          </label>
        </el-checkbox-group>

        <p v-if="!targets.length" class="text-slate-400 text-[13px] py-4 text-center">
          {{ kw ? '没有匹配的联系人' : '当前没有可转发的在线联系人' }}
        </p>
      </div>
    </div>

    <template #footer>
      <span class="text-[12px] text-slate-400 mr-auto self-center">
        已选 {{ selected.length }} 个
      </span>
      <el-button @click="close(false)">取消</el-button>
      <el-button type="primary" :disabled="!selected.length" @click="submit">
        转发
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  store: { type: Object, required: true }
})
const emit = defineEmits(['update:visible', 'submit'])

const kw = ref('')
const selected = ref([])

// 只能转发给「当前在线」的联系人 —— 离线设备无法建立连接
const targets = computed(() => {
  const q = kw.value.trim().toLowerCase()
  const list = []
  for (const d of props.store.devices) {
    if (d.id === props.store.self.id) continue
    list.push({
      id: d.id,
      name: d.name || '',
      ip: d.ip || '',
      kind: 'device'
    })
  }
  for (const g of props.store.groups) {
    list.push({
      id: g.id,
      name: g.name || '未命名群',
      members: (g.members || []).length,
      kind: 'group'
    })
  }
  if (!q) return list
  return list.filter(
    (t) =>
      (t.name || '').toLowerCase().includes(q) || (t.ip || '').toLowerCase().includes(q)
  )
})

// 每次打开重置上一次的勾选，避免误转发
watch(
  () => props.visible,
  (v) => {
    if (v) {
      selected.value = []
      kw.value = ''
    }
  }
)

function close(v) {
  emit('update:visible', v !== false)
}
function submit() {
  if (!selected.value.length) return
  emit('submit', selected.value.slice())
}
</script>

<style scoped>
.list-scroll {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 4px;
}
.target-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.target-row:hover {
  background: #f8fafc;
}
</style>