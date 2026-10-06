<template>
  <div
    class="fixed inset-0 bg-black/30 grid place-items-center z-50"
    @click.self="$emit('close')"
  >
    <div class="bg-white rounded-2xl p-5 w-[360px] shadow-2xl">
      <div class="font-semibold text-[15px] text-slate-800 mb-3">新建群聊</div>
      <el-input
        v-model="name"
        placeholder="群名称"
        maxlength="24"
        show-word-limit
      />
      <div class="text-[12px] text-slate-400 mt-4 mb-2">
        选择成员（仅限当前在线设备）
      </div>
      <div class="max-h-[220px] overflow-auto">
        <el-checkbox-group v-model="selected">
          <div
            v-for="d in online"
            :key="d.id"
            class="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-50"
          >
            <el-checkbox :value="d.id" />
            <Avatar :avatar="d.avatar" :name="d.name" :size="28" />
            <span class="text-slate-700">{{ d.name }}</span>
            <span class="ml-auto text-[12px] text-slate-400">{{ d.ip }}</span>
          </div>
        </el-checkbox-group>
        <p v-if="!online.length" class="text-slate-400 text-[13px]">
          当前没有其它在线设备。
        </p>
      </div>
      <div class="flex justify-end gap-2 mt-5">
        <el-button @click="$emit('close')">取消</el-button>
        <el-button
          type="primary"
          :disabled="!selected.length"
          @click="confirm"
        >
          创建
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useStore } from '../store/index.js'
import Avatar from './Avatar.vue'

const store = useStore()
const emit = defineEmits(['close', 'create'])
const name = ref('')
const selected = ref([])
const online = computed(() =>
  store.devices.filter((d) => d.id !== store.self.id)
)

function confirm() {
  emit('create', { name: name.value, memberIds: [...selected.value] })
  emit('close')
}
</script>
