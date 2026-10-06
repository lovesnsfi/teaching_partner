<template>
  <div
    class="fixed inset-0 bg-black/40 grid place-items-center z-50"
    @click.self="$emit('close')"
  >
    <div
      class="bg-white rounded-2xl shadow-2xl w-[440px] max-h-[88vh] overflow-hidden flex flex-col"
    >
      <div
        class="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2 flex-none"
      >
        <span class="font-semibold text-[15px] text-slate-800">设置</span>
        <button
          class="ml-auto text-slate-400 hover:text-slate-600 text-[18px] leading-none"
          @click="$emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="px-5 py-4 overflow-auto space-y-6">
        <!-- 个人资料 -->
        <section>
          <div class="text-[13px] font-semibold text-slate-500 mb-3">个人资料</div>
          <div class="flex items-center gap-4">
            <Avatar :avatar="draftAvatar" :name="draftName || '我'" :size="56" />
            <div class="flex-1">
              <div class="text-[12px] text-slate-400 mb-1">昵称</div>
              <input
                v-model="draftName"
                maxlength="24"
                placeholder="请输入昵称"
                class="w-full"
              />
            </div>
          </div>
        </section>

        <!-- 头像选择 -->
        <section>
          <div class="text-[13px] font-semibold text-slate-500 mb-3">头像</div>
          <div class="grid grid-cols-8 gap-2">
            <button
              v-for="a in builtins"
              :key="a.id"
              class="rounded-full overflow-hidden border-2 transition"
              :class="
                draftAvatar === 'builtin:' + a.id
                  ? 'border-blue-500'
                  : 'border-transparent hover:border-slate-300'
              "
              @click="draftAvatar = 'builtin:' + a.id"
            >
              <img :src="a.data" width="40" height="40" alt="" class="block" />
            </button>
          </div>
          <div class="flex items-center gap-2 mt-3">
            <button class="text-[12px]" @click="pickLocal">选择本地图片</button>
            <button
              class="text-[12px]"
              :class="!draftAvatar ? 'text-blue-600' : 'text-slate-500'"
              @click="draftAvatar = ''"
            >
              使用文字头像
            </button>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="onFile"
            />
          </div>
          <p class="text-[12px] text-slate-400 mt-2 leading-relaxed">
            未选择内置/本地头像时，将用昵称的首字（或首汉字）生成文字头像。
          </p>
        </section>

        <!-- 网络 -->
        <section>
          <div class="text-[13px] font-semibold text-slate-500 mb-1">
            通信网卡
          </div>
          <p class="text-[12px] text-slate-400 mb-3 leading-relaxed">
            选择用于局域网发现与通信的网卡（即与哪个局域网通信）。
          </p>
          <div class="space-y-2">
            <label
              class="flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer transition"
              :class="
                draftInterface === 'auto'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:bg-slate-50'
              "
            >
              <input
                type="radio"
                name="iface"
                :value="'auto'"
                v-model="draftInterface"
                class="w-4 h-4"
              />
              <div class="min-w-0">
                <div class="font-medium text-slate-800 text-[13px]">
                  自动（全部网卡）
                </div>
                <div class="text-[12px] text-slate-400">
                  在所有网卡上广播与监听
                </div>
              </div>
            </label>

            <label
              v-for="it in interfaces"
              :key="it.address"
              class="flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer transition"
              :class="
                draftInterface === it.address
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:bg-slate-50'
              "
            >
              <input
                type="radio"
                name="iface"
                :value="it.address"
                v-model="draftInterface"
                class="w-4 h-4"
              />
              <div class="min-w-0">
                <div class="font-medium text-slate-800 text-[13px]">
                  {{ it.name }}
                </div>
                <div class="text-[12px] text-slate-400">
                  {{ it.address }} · {{ it.netmask }}
                </div>
              </div>
            </label>

            <p v-if="!interfaces.length" class="text-slate-400 text-[13px]">
              未检测到可用网卡。
            </p>
          </div>
        </section>

        <!-- 通知 -->
        <section>
          <div class="text-[13px] font-semibold text-slate-500 mb-3">通知</div>
          <div
            class="flex items-center justify-between p-3 rounded-xl border border-slate-200"
          >
            <div class="pr-4">
              <div class="font-medium text-slate-800 text-[13px]">
                新消息播放提示音
              </div>
              <div class="text-[12px] text-slate-400">
                收到文字、表情或文件等新消息时播放提示音
              </div>
            </div>
            <button
              type="button"
              class="relative w-11 h-6 rounded-full transition-colors flex-none"
              :class="draftPlaySound ? 'bg-blue-600' : 'bg-slate-300'"
              @click="draftPlaySound = !draftPlaySound"
            >
              <span
                class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
                :class="draftPlaySound ? 'translate-x-5' : 'translate-x-0'"
              ></span>
            </button>
          </div>
        </section>
      </div>

      <div class="px-5 py-3 border-t border-slate-200 flex justify-end gap-2 flex-none">
        <button @click="$emit('close')">取消</button>
        <button class="primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useStore } from '../store/index.js'
import { BUILTIN_AVATARS } from '../avatars.js'
import Avatar from './Avatar.vue'

const emit = defineEmits(['close'])
const store = useStore()

const builtins = BUILTIN_AVATARS
const draftName = ref(store.self.name || '')
const draftAvatar = ref(store.self.avatar || '')
const draftInterface = ref(store.selectedInterface || 'auto')
const draftPlaySound = ref(store.playSound !== false)
const interfaces = ref([])
const fileInput = ref(null)

onMounted(async () => {
  try {
    const res = await window.api.getInterfaces()
    interfaces.value = res.list || []
    draftInterface.value = res.selected || 'auto'
  } catch {
    /* ignore */
  }
})

function pickLocal() {
  if (fileInput.value) fileInput.value.click()
}

function onFile(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = () => {
      const size = 128
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      // 以封面方式裁剪为正方形
      const s = Math.min(img.width, img.height)
      const sx = (img.width - s) / 2
      const sy = (img.height - s) / 2
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size)
      draftAvatar.value = canvas.toDataURL('image/png')
    }
    img.src = reader.result
  }
  reader.readAsDataURL(file)
  e.target.value = ''
}

async function save() {
  const name = draftName.value.trim()
  if (name) await store.setName(name)
  await store.setAvatar(draftAvatar.value)
  await store.setInterface(draftInterface.value)
  store.setPlaySound(draftPlaySound.value)
  emit('close')
}
</script>
