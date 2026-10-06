<template>
  <section class="flex flex-col bg-white min-h-0">
    <div
      class="px-4 py-3 font-semibold border-b border-slate-200 flex items-center gap-2 text-slate-700 flex-none"
    >
      屏幕广播
    </div>
    <div class="flex-1 overflow-auto p-4">
      <!-- 学生端：已加入某位老师的广播 -->
      <div v-if="store.broadcast.role === 'student'">
        <p class="text-slate-500 text-[13px] leading-relaxed">
          以<strong class="text-slate-700">学生</strong>身份加入老师的广播。
        </p>

        <div v-if="store.broadcast.invitingTeachers.length">
          <div class="font-medium text-[13px] text-slate-700 mb-2">
            老师正在广播：
          </div>
          <div
            v-for="t in store.broadcast.invitingTeachers"
            :key="t.id"
            class="flex items-center gap-2.5 p-2.5 border border-slate-200 rounded-xl mb-2"
          >
            <span class="w-2 h-2 rounded-full bg-amber-600 flex-none"></span>
            <div class="min-w-0">
              <div class="font-medium text-slate-800">{{ t.name }}</div>
              <div class="text-[12px] text-slate-400">{{ t.ip }}</div>
            </div>
            <el-button type="primary" class="ml-auto" @click="join(t)">
              <el-icon class="mr-1"><Right /></el-icon>进入
            </el-button>
          </div>
        </div>
        <p v-else class="text-slate-400 text-[13px] leading-relaxed">
          暂无老师开播。等待邀请，或点击下方「开始广播」自己开播。
        </p>

        <div
          class="bg-slate-900 rounded-2xl overflow-hidden aspect-video flex items-center justify-center text-slate-400 mt-3 relative"
        >
          <video
            ref="studentVideo"
            autoplay
            playsinline
            class="w-full h-full object-contain bg-black"
          ></video>
          <span v-if="!store.broadcast.teacherStream" class="absolute"
            >未连接到老师</span
          >
        </div>

        <div class="flex gap-2 mt-3">
          <el-button type="danger" @click="leave">
            <el-icon class="mr-1"><SwitchButton /></el-icon>离开广播
          </el-button>
        </div>
      </div>

      <!-- 老师端 / 未开播：提供开播入口 -->
      <div v-else>
        <p class="text-slate-500 text-[13px] leading-relaxed">
          以<strong class="text-slate-700">老师</strong>身份广播你的屏幕。
        </p>

        <div class="mt-3 flex gap-2 items-center">
          <el-select
            v-model="selectedSource"
            class="flex-1 min-w-0"
            placeholder="选择要分享的画面"
            :disabled="store.broadcast.teacherActive"
          >
            <el-option
              v-for="s in store.sources"
              :key="s.id"
              :label="s.name"
              :value="s.id"
            />
          </el-select>
          <el-button
            v-if="!store.broadcast.teacherActive"
            type="primary"
            class="flex-none"
            :loading="busy"
            :disabled="!selectedSource"
            @click="start"
          >
            <el-icon class="mr-1"><VideoCamera /></el-icon>开始广播
          </el-button>
          <el-button
            v-else
            type="danger"
            class="flex-none"
            @click="stop"
          >
            <el-icon class="mr-1"><VideoPause /></el-icon>停止广播
          </el-button>
        </div>

        <p class="text-[12px] text-slate-400 mt-2 leading-relaxed">
          当前 {{ qualityLabel }} · {{ store.broadcastFps }} 帧/秒，卡顿或延迟高时可在「设置」中调低。
        </p>

        <!-- 未开播时也可加入其它老师正在进行的广播 -->
        <div
          v-if="!store.broadcast.teacherActive && store.broadcast.invitingTeachers.length"
          class="mt-4"
        >
          <div class="font-medium text-[13px] text-slate-700 mb-2">
            其它老师正在广播（可加入）：
          </div>
          <div
            v-for="t in store.broadcast.invitingTeachers"
            :key="t.id"
            class="flex items-center gap-2.5 p-2.5 border border-slate-200 rounded-xl mb-2"
          >
            <span class="w-2 h-2 rounded-full bg-amber-600 flex-none"></span>
            <div class="min-w-0">
              <div class="font-medium text-slate-800">{{ t.name }}</div>
              <div class="text-[12px] text-slate-400">{{ t.ip }}</div>
            </div>
            <el-button type="primary" class="ml-auto" @click="join(t)">
              <el-icon class="mr-1"><Right /></el-icon>进入
            </el-button>
          </div>
        </div>

        <p
          v-if="store.broadcast.teacherActive"
          class="text-slate-500 text-[13px] mt-3"
        >
          正在向
          <strong class="text-slate-700">{{
            store.broadcast.studentCount
          }}</strong>
          名学生推流（Mesh 一对多）。
        </p>

        <div
          class="bg-slate-900 rounded-2xl overflow-hidden aspect-video flex items-center justify-center text-slate-400 mt-3 relative"
        >
          <video
            ref="teacherVideo"
            autoplay
            playsinline
            muted
            class="w-full h-full object-contain bg-black"
          ></video>
          <span v-if="!store.broadcast.localStream" class="absolute"
            >未开始广播</span
          >
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, watch, onMounted, computed } from 'vue'
import { useStore } from '../store/index.js'
import { getQualityProfile } from '../webrtc.js'

const store = useStore()
const teacherVideo = ref(null)
const studentVideo = ref(null)
const selectedSource = ref('')
const busy = ref(false)

// 当前画质档位说明（含码率上限），用于在面板上直观展示
const qualityLabel = computed(() => {
  const p = getQualityProfile(store.broadcastQuality)
  return `${p.label}（${Math.round(p.maxBitrate / 1000)} kbps 上限）`
})

onMounted(async () => {
  try {
    const sources = await store.loadSources()
    const screen = sources.find((s) => s.id.startsWith('screen')) || sources[0]
    if (screen) selectedSource.value = screen.id
  } catch (e) {
    console.error('load sources failed', e)
  }
  if (store.broadcast.localStream && teacherVideo.value)
    teacherVideo.value.srcObject = store.broadcast.localStream
  if (store.broadcast.teacherStream && studentVideo.value)
    studentVideo.value.srcObject = store.broadcast.teacherStream
})

async function start() {
  if (!selectedSource.value) return
  busy.value = true
  try {
    await store.startBroadcast(selectedSource.value)
  } catch (e) {
    const raw = e && e.message ? e.message : String(e)
    alert(
      '开始广播失败：' +
        raw +
        '\n\n采集单个窗口时请确保：\n' +
        '· 目标窗口未被最小化，且保持可见；\n' +
        '· 目标窗口没有被关闭；\n' +
        '· 若目标是管理员权限的程序，请调整两端运行权限一致。\n' +
        '若仍失败，可改选「整个屏幕」重试。'
    )
  } finally {
    busy.value = false
  }
}

function stop() {
  store.stopBroadcast()
}

function join(t) {
  store.joinBroadcast(t)
}

function leave() {
  store.leaveBroadcast()
}

watch(
  () => store.broadcast.localStream,
  (s) => {
    if (teacherVideo.value) teacherVideo.value.srcObject = s
  }
)
watch(
  () => store.broadcast.teacherStream,
  (s) => {
    if (studentVideo.value) studentVideo.value.srcObject = s
  }
)
</script>
