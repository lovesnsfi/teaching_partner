<template>
  <section class="flex flex-col bg-white min-h-0">
    <div
      class="px-4 py-3 font-semibold border-b border-slate-200 flex items-center gap-2 text-slate-700 flex-none"
    >
      录屏
      <span class="text-[12px] font-normal text-slate-400"
        >屏幕 + 摄像头 + 声音 → 直接保存为 mp4（ffmpeg 单遍，低占用）</span
      >
    </div>

    <div class="flex-1 overflow-auto p-4">
      <div class="flex gap-4 h-full">
        <!-- 左列：配置 -->
        <div class="w-[300px] flex-none flex flex-col gap-3">
          <!-- 选择录制源 -->
          <div>
            <div class="text-[13px] font-medium text-slate-600 mb-1.5">
              录制范围
            </div>
            <el-select
              v-model="selectedSource"
              placeholder="选择屏幕或窗口"
              class="w-full"
              :disabled="recording"
            >
              <el-option
                v-for="s in store.sources"
                :key="s.id"
                :label="s.name"
                :value="s.id"
              />
            </el-select>
            <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">
              可选整个屏幕或某个窗口（ffmpeg 直接采集，不再经渲染层）。
            </p>
          </div>

          <!-- 采集开关 -->
          <div class="flex flex-col gap-2">
            <div
              class="flex items-center justify-between p-2.5 rounded-lg border border-slate-200"
            >
              <div class="pr-3">
                <div class="text-[13px] text-slate-700">麦克风</div>
                <div class="text-[11px] text-slate-400">录制解说人声</div>
              </div>
              <el-switch
                :model-value="store.recorder.mic"
                :disabled="recording"
                @change="(v) => setOpt('mic', v)"
              />
            </div>
            <div
              class="flex items-center justify-between p-2.5 rounded-lg border border-slate-200"
            >
              <div class="pr-3">
                <div class="text-[13px] text-slate-700">系统声音</div>
                <div class="text-[11px] text-slate-400">
                  ffmpeg 采集，比桌面采集器可靠
                </div>
              </div>
              <el-switch
                :model-value="store.recorder.systemAudio"
                :disabled="recording"
                @change="(v) => setOpt('systemAudio', v)"
              />
            </div>
            <div
              class="flex items-center justify-between p-2.5 rounded-lg border border-slate-200"
            >
              <div class="pr-3">
                <div class="text-[13px] text-slate-700">摄像头画中画</div>
                <div class="text-[11px] text-slate-400">叠加到画面右下角</div>
              </div>
              <el-switch
                :model-value="store.recorder.camera"
                :disabled="recording"
                @change="(v) => setOpt('camera', v)"
              />
            </div>
          </div>

          <!-- 保存位置 -->
          <div class="p-2.5 rounded-lg border border-slate-200">
            <div class="text-[13px] text-slate-700 mb-1">保存位置</div>
            <div class="text-[12px] text-slate-400 break-all leading-relaxed">
              {{ store.recorder.saveDir || '视频 / 局域网沟通广播' }}
            </div>
            <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">
              在「设置 → 录屏」中修改目录与设备。
            </p>
          </div>

          <!-- 最近文件 -->
          <div
            v-if="lastFile"
            class="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50"
          >
            <div class="text-[12px] font-medium text-emerald-700 mb-1">
              上次录制完成
            </div>
            <div
              class="text-[11px] text-slate-500 break-all leading-relaxed mb-2"
            >
              {{ lastFile }}
            </div>
            <div class="flex gap-2">
              <el-button size="small" @click="openFile(lastFile)">打开</el-button>
              <el-button size="small" @click="openFolderOf(lastFile)"
                >文件夹</el-button
              >
            </div>
          </div>
        </div>

        <!-- 右列：预览 -->
        <div class="flex-1 min-w-0 flex flex-col gap-3">
          <div class="grid grid-cols-2 gap-3 flex-1 min-h-0">
            <div
              class="rounded-xl overflow-hidden bg-black flex items-center justify-center relative"
            >
              <video
                ref="screenVideo"
                class="w-full h-full object-contain"
                muted
                playsinline
              ></video>
              <span
                v-if="!recording"
                class="absolute text-slate-400 text-[13px]"
                >屏幕预览</span
              >
              <span
                v-if="recording"
                class="absolute top-2 left-2 flex items-center gap-1 text-white text-[12px] bg-black/40 px-2 py-0.5 rounded"
              >
                <span class="w-2 h-2 rounded-full bg-rose-500"></span>{{ timer }}
              </span>
            </div>
            <div
              class="rounded-xl overflow-hidden bg-slate-900 flex items-center justify-center relative"
            >
              <video
                ref="camVideo"
                class="w-full h-full object-contain"
                muted
                playsinline
              ></video>
              <span
                v-if="!recording || !store.recorder.camera"
                class="absolute text-slate-400 text-[13px]"
                >摄像头预览</span
              >
              <span
                v-else
                class="absolute text-slate-300 text-[12px] bg-black/40 px-2 py-0.5 rounded"
                >录制中（由 ffmpeg 采集）</span
              >
            </div>
          </div>

          <!-- 系统声音提示 -->
          <div
            v-if="store.recorder.systemAudio && recorderDevices.audioLoopback.length === 0"
            class="text-[12px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5"
          >
            未检测到可用的系统声音设备。如需录制系统声音，请在 Windows
            「声音设置 → 更多声音设置 → 录制」中启用「立体声混音」或虚拟音频设备。
          </div>

          <!-- 控制条 -->
          <div class="flex items-center gap-2 flex-none">
            <el-button
              v-if="!recording"
              type="primary"
              :loading="processing"
              @click="start"
            >
              <el-icon class="mr-1"><VideoPlay /></el-icon>开始录制
            </el-button>
            <el-button
              v-else
              type="danger"
              :loading="processing"
              @click="stop"
            >
              <el-icon class="mr-1"><SwitchButton /></el-icon>停止并保存
            </el-button>
            <span v-if="recording" class="text-[13px] text-slate-500 ml-1"
              >录制中 {{ timer }}</span
            >
            <span v-if="processing" class="text-[13px] text-slate-400 ml-1"
              >正在定稿 mp4…</span
            >
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useStore } from '../store/index.js'
import { captureScreen } from '../webrtc.js'

const store = useStore()
const selectedSource = ref('')
const screenVideo = ref(null)
const camVideo = ref(null)

const recording = ref(false)
const processing = ref(false)
const lastFile = ref('')
const timer = ref('00:00')

const recorderDevices = computed(() => store.recorderDevices)

let screenStream = null
let camStream = null
let tickTimer = 0
let elapsed = 0

onMounted(async () => {
  try {
    const list = await store.loadSources()
    if (list && list.length) selectedSource.value = list[0].id
  } catch {
    /* ignore */
  }
  try {
    await store.loadRecorderDevices()
  } catch {
    /* ignore */
  }
  if (store.recorder.camera) startCamPreview()
})
onBeforeUnmount(() => cleanup())

function setOpt(key, val) {
  store.recorder[key] = val
  store._saveSettings()
  // 摄像头开关变化时同步预览
  if (key === 'camera') {
    if (val && !recording.value) startCamPreview()
    else stopCamPreview()
  }
}

function fmtTime(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
}
function startTimer() {
  elapsed = 0
  timer.value = '00:00'
  tickTimer = setInterval(() => {
    elapsed++
    timer.value = fmtTime(elapsed)
  }, 1000)
}
function stopTimer() {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = 0
}

// 把桌面采集器的源 id 翻译成 ffmpeg 采集参数
function parseSource(srcId, name) {
  if (srcId && srcId.startsWith('screen:')) {
    return { type: 'screen', index: parseInt(srcId.slice(7), 10) || 0 }
  }
  return { type: 'window', title: name || srcId }
}

// 摄像头预览（仅未录制时，避免与 ffmpeg dshow 抢占同一设备）
async function startCamPreview() {
  if (camStream) return
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } }
    })
    if (camVideo.value) {
      camVideo.value.srcObject = camStream
      await camVideo.value.play().catch(() => {})
    }
  } catch {
    /* ignore */
  }
}
function stopCamPreview() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop())
  camStream = null
  if (camVideo.value) camVideo.value.srcObject = null
}

async function start() {
  if (!selectedSource.value) {
    ElMessage.warning('请先选择要录制的屏幕或窗口')
    return
  }
  const src = store.sources.find((s) => s.id === selectedSource.value)
  const r = store.recorder
  processing.value = true
  try {
    // 屏幕预览（显示用，与 ffmpeg 采集互不冲突）
    screenStream = await captureScreen(selectedSource.value, { withAudio: false })
    if (screenVideo.value) {
      screenVideo.value.srcObject = screenStream
      await screenVideo.value.play().catch(() => {})
    }
    // 摄像头交给 ffmpeg 采集，这里释放预览设备避免抢占
    stopCamPreview()

    const res = await window.api.recorderStart({
      source: parseSource(selectedSource.value, src && src.name),
      fps: r.fps,
      width: r.width,
      height: r.height,
      mic: r.mic,
      micDevice: r.micDevice || '',
      systemAudio: r.systemAudio,
      systemDevice: r.systemDevice || '',
      camera: r.camera,
      cameraDevice: r.cameraDevice || '',
      saveDir: r.saveDir || ''
    })
    if (!res || !res.ok) {
      throw new Error((res && res.error) || '未知错误')
    }
    recording.value = true
    startTimer()
  } catch (e) {
    ElMessage.error('开始录制失败：' + ((e && e.message) || e))
    cleanup()
  } finally {
    processing.value = false
  }
}

async function stop() {
  processing.value = true
  try {
    const res = await window.api.recorderStop()
    if (res && res.ok) {
      lastFile.value = res.path
      ElMessage.success('录制完成：' + res.path)
    } else {
      ElMessage.error('保存失败：' + ((res && res.error) || '未知错误'))
    }
  } catch (e) {
    ElMessage.error('停止失败：' + ((e && e.message) || e))
  } finally {
    recording.value = false
    stopTimer()
    processing.value = false
    cleanup()
    if (store.recorder.camera) startCamPreview()
  }
}

function cleanup() {
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop())
  screenStream = null
  if (screenVideo.value) screenVideo.value.srcObject = null
  // 摄像头预览仅在未录制且开关开启时保留
  if (!recording.value && store.recorder.camera) {
    // 保持预览
  } else {
    stopCamPreview()
  }
}

function openFile(p) {
  if (p && window.api) window.api.openPath(p)
}
function openFolderOf(p) {
  if (p && window.api) window.api.openFolder(p)
}
</script>
