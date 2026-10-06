// WebRTC 核心：方案 A（Mesh）
// 老师端对每个观看学生单独建立一条 RTCPeerConnection 推同一路屏幕流；
// 学生端只接收当前老师的流。信令通过已建立的聊天 WebSocket 通道转发。

// 老师端广播器
export class TeacherBroadcaster {
  constructor(sendSignal) {
    this.sendSignal = sendSignal
    this.stream = null
    this.peers = new Map() // studentId -> { pc }
  }

  start(stream) {
    this.stream = stream
  }

  addStudent(student) {
    if (this.peers.has(student.id)) return
    const pc = new RTCPeerConnection({ iceServers: [] })
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream))
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(student.ip, { kind: 'ice', candidate: e.candidate })
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removeStudent(student.id)
      }
    }
    this.peers.set(student.id, { pc })

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        this.sendSignal(student.ip, {
          kind: 'offer',
          sdp: pc.localDescription
        })
      })
      .catch((err) => console.error('[broadcast] offer error', err))
  }

  handleAnswer(fromId, sdp) {
    const peer = this.peers.get(fromId)
    if (peer) peer.pc.setRemoteDescription(sdp).catch((e) => console.error(e))
  }

  handleIce(fromId, candidate) {
    const peer = this.peers.get(fromId)
    if (peer && candidate) {
      peer.pc.addIceCandidate(candidate).catch((e) => console.error(e))
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
  }

  handleOffer(fromId, fromIp, sdp) {
    this.teacherId = fromId
    this.teacherIp = fromIp
    this.pc = new RTCPeerConnection({ iceServers: [] })
    this.pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) this.onStream(e.streams[0])
    }
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(this.teacherIp, {
          kind: 'ice',
          candidate: e.candidate
        })
      }
    }
    this.pc.setRemoteDescription(sdp)
      .then(() => this.pc.createAnswer())
      .then((answer) => this.pc.setLocalDescription(answer))
      .then(() => {
        this.sendSignal(this.teacherIp, {
          kind: 'answer',
          sdp: this.pc.localDescription
        })
      })
      .catch((err) => console.error('[receive] answer error', err))
  }

  handleIce(candidate) {
    if (this.pc && candidate) {
      this.pc.addIceCandidate(candidate).catch((e) => console.error(e))
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
  }
}

// 屏幕捕获（Electron desktopCapturer 提供的源）
export async function captureScreen(sourceId, withAudio = false) {
  const constraints = {
    audio: withAudio
      ? { mandatory: { chromeMediaSource: 'desktop' } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
      }
    }
  }
  return navigator.mediaDevices.getUserMedia(constraints)
}
