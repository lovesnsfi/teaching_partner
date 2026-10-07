<template>
  <div class="fixed inset-0 bg-black/40 grid place-items-center z-50">
    <!-- 固定高度：切换类别时窗体高度保持不变，内容超出则在右侧区内部滚动 -->
    <div
      class="bg-white rounded-2xl shadow-2xl w-[720px] h-[520px] max-h-[82vh] overflow-hidden flex flex-col"
    >
      <!-- 标题栏 -->
      <div
        class="px-5 py-3 border-b border-slate-200 flex items-center gap-2 flex-none"
      >
        <span class="font-semibold text-[15px] text-slate-800">设置</span>
        <el-button
          class="ml-auto"
          text
          size="small"
          title="关闭"
          @click="$emit('close')"
        >
          <el-icon><Close /></el-icon>
        </el-button>
      </div>

      <!-- 左右分栏：左侧类别，右侧具体设置项 -->
      <div class="flex flex-1 min-h-0">
        <!-- 左侧类别导航（Element Plus 菜单，自带选中态） -->
        <el-menu
          :default-active="activeTab"
          class="w-[168px] flex-none border-r border-slate-200 overflow-auto"
          @select="(key) => (activeTab = key)"
        >
          <el-menu-item index="profile">
            <el-icon><User /></el-icon>
            <span>个人资料</span>
          </el-menu-item>
          <el-menu-item index="network">
            <el-icon><Connection /></el-icon>
            <span>通信网卡</span>
          </el-menu-item>
          <el-menu-item index="broadcast">
            <el-icon><Monitor /></el-icon>
            <span>屏幕广播</span>
          </el-menu-item>
          <el-menu-item index="notify">
            <el-icon><Bell /></el-icon>
            <span>通知</span>
          </el-menu-item>
          <el-menu-item index="about">
            <el-icon><InfoFilled /></el-icon>
            <span>关于</span>
          </el-menu-item>
        </el-menu>

        <!-- 右侧设置项（固定高度内滚动，min-h-0 防止被内容撑开） -->
        <div class="flex-1 min-w-0 min-h-0 overflow-auto px-6 py-5">
          <!-- ============ 个人资料 ============ -->
          <div v-if="activeTab === 'profile'">
            <div class="mb-4">
              <div class="text-[15px] font-semibold text-slate-800">
                个人资料
              </div>
              <p class="text-[12px] text-slate-400 mt-0.5 leading-relaxed">
                设置昵称与头像，局域网内的同事将看到这些信息。
              </p>
            </div>

            <div
              class="flex items-center gap-4 p-3 rounded-xl border border-slate-200"
            >
              <Avatar
                :avatar="draftAvatar"
                :name="draftName || '我'"
                :size="56"
              />
              <div class="flex-1 min-w-0">
                <div class="text-[12px] text-slate-400 mb-1">昵称</div>
                <el-input
                  v-model="draftName"
                  maxlength="24"
                  show-word-limit
                  placeholder="请输入昵称"
                />
              </div>
            </div>

            <div class="text-[13px] font-semibold text-slate-500 mt-5 mb-3">
              头像
            </div>
            <div class="grid grid-cols-8 gap-2">
              <button
                v-for="a in avatarList"
                :key="a.id"
                class="rounded-full overflow-hidden border-2 transition"
                :class="
                  draftAvatar === 'asset:' + a.id
                    ? 'border-blue-500'
                    : 'border-transparent hover:border-slate-300'
                "
                @click="draftAvatar = 'asset:' + a.id"
              >
                <img :src="a.url" width="40" height="40" alt="" class="block" />
              </button>
            </div>
            <div class="flex items-center gap-2 mt-3">
              <el-button size="small" @click="pickLocal">
                <el-icon class="mr-1"><Picture /></el-icon>选择本地图片
              </el-button>
              <el-button
                size="small"
                :type="!draftAvatar ? 'primary' : 'default'"
                @click="draftAvatar = ''"
              >
                <el-icon class="mr-1"><User /></el-icon>使用文字头像
              </el-button>
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
          </div>

          <!-- ============ 通信网卡 ============ -->
          <div v-else-if="activeTab === 'network'">
            <div class="mb-4">
              <div class="text-[15px] font-semibold text-slate-800">
                通信网卡
              </div>
              <p class="text-[12px] text-slate-400 mt-0.5 leading-relaxed">
                选择用于局域网发现与通信的网卡（即与哪个局域网通信）。切换后会重新搜索该网段内的同事。
              </p>
            </div>

            <el-radio-group v-model="draftInterface" class="w-full block">
              <div class="space-y-2">
                <el-radio value="auto" class="card-radio">
                  <div class="min-w-0">
                    <div class="font-medium text-slate-800 text-[13px]">
                      自动（全部网卡）
                    </div>
                    <div class="text-[12px] text-slate-400">
                      在所有网卡上广播与监听
                    </div>
                  </div>
                </el-radio>
                <el-radio
                  v-for="it in interfaces"
                  :key="it.address"
                  :value="it.address"
                  class="card-radio"
                >
                  <div class="min-w-0">
                    <div class="font-medium text-slate-800 text-[13px]">
                      {{ it.name }}
                    </div>
                    <div class="text-[12px] text-slate-400">
                      {{ it.address }} · {{ it.netmask }}
                    </div>
                  </div>
                </el-radio>
              </div>
            </el-radio-group>

            <p v-if="!interfaces.length" class="text-slate-400 text-[13px]">
              未检测到可用网卡。
            </p>
          </div>

          <!-- ============ 屏幕广播 ============ -->
          <div v-else-if="activeTab === 'broadcast'">
            <div class="mb-4">
              <div class="text-[15px] font-semibold text-slate-800">
                屏幕广播
              </div>
              <p class="text-[12px] text-slate-400 mt-0.5 leading-relaxed">
                根据网络状况调整画质与帧率。局域网带宽有限、画面卡顿或延迟较高时，调低这两项效果最明显。
              </p>
            </div>

            <div class="text-[13px] font-semibold text-slate-500 mb-2">画质</div>
            <el-radio-group v-model="draftQuality" class="w-full block">
              <div class="space-y-2">
                <el-radio
                  v-for="q in qualities"
                  :key="q.key"
                  :value="q.key"
                  class="card-radio"
                >
                  <div class="min-w-0">
                    <div class="font-medium text-slate-800 text-[13px]">
                      {{ q.label }}
                    </div>
                    <div class="text-[12px] text-slate-400">{{ q.desc }}</div>
                  </div>
                </el-radio>
              </div>
            </el-radio-group>

            <div class="text-[13px] font-semibold text-slate-500 mt-5 mb-2">
              帧率
            </div>
            <el-radio-group v-model="draftFps">
              <el-radio-button
                v-for="f in fpsOptions"
                :key="f"
                :value="f"
                size="small"
              >
                {{ f }} 帧/秒
              </el-radio-button>
            </el-radio-group>
            <p class="text-[12px] text-slate-400 mt-2 leading-relaxed">
              演示动态视频可选 60 帧；看文档/课件 30 帧即可，网络差时可选 15 帧。
              正在广播时修改会即时生效，已观看的同事不会断开。
            </p>
          </div>

          <!-- ============ 通知 ============ -->
          <div v-else-if="activeTab === 'notify'">
            <div class="mb-4">
              <div class="text-[15px] font-semibold text-slate-800">通知</div>
              <p class="text-[12px] text-slate-400 mt-0.5 leading-relaxed">
                控制收到新消息时的提醒方式。
              </p>
            </div>

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
              <el-switch v-model="draftPlaySound" />
            </div>
          </div>

          <!-- ============ 关于 ============ -->
          <div v-else-if="activeTab === 'about'">
            <div class="mb-4">
              <div class="text-[15px] font-semibold text-slate-800">关于</div>
              <p class="text-[12px] text-slate-400 mt-0.5 leading-relaxed">
                版本信息与自动更新。程序启动后会自动检查更新，也可在此手动检查。
              </p>
            </div>

            <div
              class="flex items-center justify-between p-3 rounded-xl border border-slate-200"
            >
              <div class="pr-4">
                <div class="font-medium text-slate-800 text-[13px]">
                  当前版本
                </div>
                <div class="text-[12px] text-slate-400">
                  {{ appVersion || '加载中…' }}
                </div>
              </div>
              <el-button size="small" :loading="checking" @click="checkUpdate">
                <el-icon class="mr-1"><Refresh /></el-icon>检查更新
              </el-button>
            </div>

            <p class="text-[12px] text-slate-400 mt-2 leading-relaxed">
              新版本通过 GitHub 下载安装，更新过程不会丢失本地聊天记录与联系人。
            </p>
          </div>
        </div>
      </div>

      <!-- 底部操作栏（对所有类别统一保存） -->
      <div
        class="px-5 py-3 border-t border-slate-200 flex justify-end gap-2 flex-none"
      >
        <el-button @click="$emit('close')">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useStore } from '../store/index.js'
import { avatarList, loadAvatars } from '../avatars.js'
import { BROADCAST_QUALITY, BROADCAST_FPS } from '../webrtc.js'
import Avatar from './Avatar.vue'

const emit = defineEmits(['close'])
const store = useStore()

// 左侧类别导航（key 与右侧面板一一对应）
const activeTab = ref('profile')

const draftName = ref(store.self.name || '')
const draftAvatar = ref(store.self.avatar || '')
const draftInterface = ref(store.selectedInterface || 'auto')
const draftPlaySound = ref(store.playSound !== false)
const draftQuality = ref(store.broadcastQuality || 'hd')
const draftFps = ref(store.broadcastFps || 30)
const qualities = Object.values(BROADCAST_QUALITY)
const fpsOptions = BROADCAST_FPS
const interfaces = ref([])
const fileInput = ref(null)
const appVersion = ref('')
const checking = ref(false)

onMounted(async () => {
  try {
    const res = await window.api.getInterfaces()
    interfaces.value = res.list || []
    draftInterface.value = res.selected || 'auto'
  } catch {
    /* ignore */
  }
  try {
    appVersion.value = (await window.api.getAppVersion()) || ''
  } catch {
    /* ignore */
  }
})

async function checkUpdate() {
  if (!window.api || !window.api.checkForUpdates) return
  checking.value = true
  try {
    await window.api.checkForUpdates()
  } catch {
    /* ignore */
  } finally {
    checking.value = false
    // 关闭设置，露出 App.vue 中的全局更新提示弹窗
    emit('close')
  }
}

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
  try {
    await store.setBroadcastProfile({
      quality: draftQuality.value,
      fps: draftFps.value
    })
  } catch (e) {
    alert((e && e.message) || String(e))
  }
  emit('close')
}
</script>

<style scoped>
/* 把 el-radio 改造成「卡片式」选项：整体可点、两行文本、选中高亮 */
.card-radio {
  display: flex;
  align-items: flex-start;
  height: auto;
  width: 100%;
  margin-right: 0;
  padding: 10px 12px;
  border: 1px solid #e2e8f0; /* slate-200 */
  border-radius: 12px;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.card-radio:hover {
  background-color: #f8fafc; /* slate-50 */
}
.card-radio.is-checked {
  border-color: #2563eb; /* 主色 blue-600 */
  background-color: #eff6ff; /* blue-50 */
}
:deep(.card-radio .el-radio__input) {
  margin-top: 2px;
}
:deep(.card-radio .el-radio__label) {
  flex: 1;
  min-width: 0;
}
</style>
