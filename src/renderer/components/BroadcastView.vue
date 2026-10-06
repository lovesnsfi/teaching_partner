<template>
  <section class="flex flex-col bg-white min-h-0">
    <div
      class="px-4 py-3 font-semibold border-b border-slate-200 flex items-center gap-2 text-slate-700 flex-none"
    >
      屏幕广播
    </div>
    <div class="flex-1 overflow-auto p-4">
      <!-- 学生端 -->
      <div v-if="store.broadcast.role !== 'teacher'">
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
            <button class="primary ml-auto" @click="join(t)">进入</button>
          </div>
        </div>
        <p v-else class="text-slate-400 text-[13px] leading-relaxed">
          暂无老师开播。等待邀请，或让老师点击「开始屏幕广播」。
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

        <div class="flex gap-2 mt-3" v-if="store.broadcast.role === 'student'">
          <button class="danger" @click="leave">离开广播</button>
        </div>
      </div>

      <!-- 老师端 -->
      <div v-else>
        <p class="text-slate-500 text-[13px] leading-relaxed">
          以<strong class="text-slate-700">老师</strong>身份广播你的屏幕。
        </p>

        <div class="flex gap-2 mt-3">
          <select v-model="selectedSource" class="flex-1">
            <option v-for="s in store.sources" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </div>

        <div class="flex gap-2 mt-3">
          <button
            class="primary"
            @click="start"
            :disabled="busy || !selectedSource"
          >
            开始屏幕广播
          </button>
          <button
            class="danger"
            @click="stop"
            v-if="store.broadcast.teacherActive"
          >
            停止
          </button>
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
import { ref, watch, onMounted } from 'vue'
import { useStore } from '../store/index.js'

const store = useStore()
const teacherVideo = ref(null)
const studentVideo = ref(null)
const selectedSource = ref('')
const busy = ref(false)

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
    alert('开始广播失败：' + (e && e.message ? e.message : e))
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
