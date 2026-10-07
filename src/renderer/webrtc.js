// WebRTC 核心：方案 A（Mesh）
// 老师端对每个观看学生单独建立一条 RTCPeerConnection 推同一路屏幕流；
// 学生端只接收当前老师的流。信令通过已建立的聊天 WebSocket 通道转发。

// 屏幕广播画质档位：分辨率上限 + 编码码率上限。
// 码率才是真正决定带宽占用与延迟的指标，分辨率只是配合它降低编码压力。
// 桌面内容文字偏多，标清较糊，默认建议「高清」。
export const BROADCAST_QUALITY = {
  sd: {
    key: 'sd',
    label: '标清',
    desc: '约 854×480，省带宽',
    maxWidth: 854,
    maxHeight: 480,
    maxBitrate: 800000 // 800 kbps
  },
  hd: {
    key: 'hd',
    label: '高清',
    desc: '约 1280×720，推荐',
    maxWidth: 1280,
    maxHeight: 720,
    maxBitrate: 2500000 // 2.5 Mbps
  },
  origin: {
    key: 'origin',
    label: '原画',
    desc: '跟随屏幕原始分辨率，最清晰也最吃带宽',
    // 不给无限值：仍保留一个很高上限，避免极端分辨率给 WGC 造成过大压力
    maxWidth: 3840,
    maxHeight: 2160,
    maxBitrate: 8000000 // 8 Mbps
  }
}

// 可选帧率：帧率越低，编码压力与带宽占用越小，延迟越低
export const BROADCAST_FPS = [15, 30, 60]

export function getQualityProfile(key) {
  return BROADCAST_QUALITY[key] || BROADCAST_QUALITY.hd
}

// 跨进程（Electron IPC）传递时必须转成「普通对象」：
// RTCSessionDescription / RTCIceCandidate 的字段（type/sdp/candidate…）是
// Blink 内部的原型访问器，不是自有可枚举属性。经结构化克隆后会被丢成空对象 {}，
// 对端 setRemoteDescription 时便报 "Failed to parse SessionDescription"（SDP 为空）。
function plainSdp(desc) {
  if (!desc) return null
  return { type: desc.type, sdp: desc.sdp }
}
function plainCandidate(c) {
  if (!c) return null
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
    usernameFragment: c.usernameFragment
  }
}

// 老师端广播器
export class TeacherBroadcaster {
  constructor(sendSignal) {
    this.sendSignal = sendSignal
    this.stream = null
    this.peers = new Map() // studentId -> { pc }
    this.maxBitrate = BROADCAST_QUALITY.hd.maxBitrate
  }

  start(stream, maxBitrate) {
    this.stream = stream
    if (maxBitrate) this.maxBitrate = maxBitrate
  }

  addStudent(student) {
    // 学生每次打开观看窗口都会重新发 request。若这里还留着上一次的连接
    // （例如 leave 信号在路上丢了），必须先关掉重建，否则旧的 PeerConnection
    // 已随窗口销毁而失效，学生端会一直卡在「正在连接」。
    if (this.peers.has(student.id)) this.removeStudent(student.id)
    const pc = new RTCPeerConnection({ iceServers: [] })
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream))
    // 限制视频编码码率：这是决定带宽占用与延迟的关键
    this._applyBitrateToPc(pc)
    const peer = { pc, pendingIce: [], remoteSet: false }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(student.ip, {
          kind: 'ice',
          candidate: plainCandidate(e.candidate)
        })
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removeStudent(student.id)
      }
    }
    this.peers.set(student.id, peer)

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        this.sendSignal(student.ip, {
          kind: 'offer',
          sdp: plainSdp(pc.localDescription)
        })
      })
      .catch((err) => console.error('[broadcast] offer error', err))
  }

  // 对单条连接设置视频码率上限。
  // degradationPreference='maintain-framerate'：带宽不足时宁可降清晰度也要保帧率，
  // 画面更连贯，避免广播卡顿感。
  _applyBitrateToPc(pc) {
    for (const sender of pc.getSenders()) {
      const track = sender.track
      if (!track || track.kind !== 'video') continue
      try {
        const params = sender.getParameters()
        if (!params.encodings || !params.encodings.length) continue
        params.encodings[0].maxBitrate = this.maxBitrate
        params.degradationPreference = 'maintain-framerate'
        sender.setParameters(params).catch(() => {})
      } catch {
        /* 某些平台不支持动态调整，忽略即可 */
      }
    }
  }

  // 运行时整体调整码率（可随时调用，无需重新协商）
  applyBitrate(bps) {
    if (!bps) return
    this.maxBitrate = bps
    for (const { pc } of this.peers.values()) this._applyBitrateToPc(pc)
  }

  // 热切换视频源（改画质/帧率）：用 replaceTrack 换掉视频轨道，
  // peer 连接不断开、也不需要重新协商，正在观看的学生无感知。
  async replaceVideo(newStream) {
    const newVideo = newStream.getVideoTracks()[0]
    if (!newVideo) throw new Error('新采集流中没有视频轨道')
    const oldVideo = this.stream ? this.stream.getVideoTracks()[0] : null

    const jobs = []
    for (const { pc } of this.peers.values()) {
      const sender = pc
        .getSenders()
        .find((s) => s.track && s.track.kind === 'video')
      if (sender) jobs.push(sender.replaceTrack(newVideo).catch(() => {}))
    }
    await Promise.all(jobs)

    // 组装新流：新视频轨 + 保留原有音频轨（若开启过系统声音）
    const merged = new MediaStream([
      newVideo,
      ...(this.stream ? this.stream.getAudioTracks() : [])
    ])
    // 旧轨道最后再停，避免在 replaceTrack 完成前推流中断
    if (oldVideo) {
      try {
        oldVideo.stop()
      } catch {
        /* ignore */
      }
    }
    this.stream = merged
    return merged
  }

  handleAnswer(fromId, sdp) {
    const peer = this.peers.get(fromId)
    if (!peer || !sdp) return
    peer.pc
      .setRemoteDescription(sdp)
      .then(() => {
        peer.remoteSet = true
        // 远端描述就绪后，补加此前到达、被暂存的 ICE 候选
        this._flushIce(peer)
      })
      .catch((e) => console.error('[broadcast] setRemote(answer) error', e))
  }

  handleIce(fromId, candidate) {
    const peer = this.peers.get(fromId)
    if (!peer || !candidate) return
    // setRemoteDescription 之前调用 addIceCandidate 会抛错，先暂存
    if (!peer.remoteSet) {
      peer.pendingIce.push(candidate)
      return
    }
    peer.pc.addIceCandidate(candidate).catch((e) => console.error(e))
  }

  _flushIce(peer) {
    if (!peer || !peer.pendingIce || !peer.pendingIce.length) return
    const list = peer.pendingIce.splice(0)
    for (const c of list) {
      peer.pc.addIceCandidate(c).catch((e) => console.error(e))
    }
  }

  removeStudent(id) {
    const peer = this.peers.get(id)
    if (peer) {
      try {
        peer.pc.close()
      } catch {
        /* ignore */
      }
      this.peers.delete(id)
    }
  }

  stop() {
    for (const { pc } of this.peers.values()) {
      try {
        pc.close()
      } catch {
        /* ignore */
      }
    }
    this.peers.clear()
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
  }
}

// 学生端接收器
export class StudentReceiver {
  constructor(sendSignal, onStream) {
    this.sendSignal = sendSignal
    this.onStream = onStream
    this.pc = null
    this.teacherIp = null
    this.teacherId = null
    this.pendingIce = []
    this.remoteSet = false
  }

  handleOffer(fromId, fromIp, sdp) {
    this.teacherId = fromId
    this.teacherIp = fromIp
    this.pc = new RTCPeerConnection({ iceServers: [] })
    this.remoteSet = false
    this.pendingIce = []
    this.pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) this.onStream(e.streams[0])
    }
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(this.teacherIp, {
          kind: 'ice',
          candidate: plainCandidate(e.candidate)
        })
      }
    }
    this.pc
      .setRemoteDescription(sdp)
      .then(() => {
        this.remoteSet = true
        this._flushIce()
        return this.pc.createAnswer()
      })
      .then((answer) => this.pc.setLocalDescription(answer))
      .then(() => {
        this.sendSignal(this.teacherIp, {
          kind: 'answer',
          sdp: plainSdp(this.pc.localDescription)
        })
      })
      .catch((err) => console.error('[receive] answer error', err))
  }

  handleIce(candidate) {
    if (!candidate) return
    // 还没 setRemoteDescription，先暂存，等就绪后补加
    if (!this.pc || !this.remoteSet) {
      this.pendingIce.push(candidate)
      return
    }
    this.pc.addIceCandidate(candidate).catch((e) => console.error(e))
  }

  _flushIce() {
    if (!this.pc || !this.pendingIce.length) return
    const list = this.pendingIce.splice(0)
    for (const c of list) {
      this.pc.addIceCandidate(c).catch((e) => console.error(e))
    }
  }

  stop() {
    if (this.pc) {
      try {
        this.pc.close()
      } catch {
        /* ignore */
      }
      this.pc = null
    }
    this.pendingIce = []
    this.remoteSet = false
  }
}

// 屏幕捕获（Electron desktopCapturer 提供的源）
// Windows 上「单窗口」捕获走 WGC(Windows Graphics Capture)，窗口被最小化/遮挡、
// 或分辨率帧率过高时底层会报 ProcessFrame failed (0x80004005) 并复用旧帧（画面卡住）。
// 因此这里只设上限、绝不设下限：min 约束会让小于该尺寸的窗口直接采集失败。
export async function captureScreen(sourceId, opts = {}) {
  const { withAudio = false, quality = 'hd', frameRate = 30 } = opts
  const profile = getQualityProfile(quality)
  const mandatory = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
    maxFrameRate: frameRate
  }
  if (profile.maxWidth) mandatory.maxWidth = profile.maxWidth
  if (profile.maxHeight) mandatory.maxHeight = profile.maxHeight
  const constraints = {
    audio: withAudio
      ? { mandatory: { chromeMediaSource: 'desktop' } }
      : false,
    video: { mandatory }
  }
  return navigator.mediaDevices.getUserMedia(constraints)
}
