import { defineStore } from 'pinia'
import {
  TeacherBroadcaster,
  StudentReceiver,
  captureScreen,
  getQualityProfile
} from '../webrtc.js'

// WebRTC 实例放模块级，避免被 Vue 响应式代理导致异常
let broadcaster = null
let receiver = null

function makeSendSignal() {
  return (ip, payload) => window.api.sendSignal(ip, payload)
}

const MAX_MSG_PER_CONV = 400

export const useStore = defineStore('app', {
  state: () => {
    return {
      self: { id: '', name: '', ip: '', port: 0, avatar: '' },
      selectedInterface: 'auto',
      playSound: true, // 新消息提示音，默认开启（持久化于本地存储）
      soundUri: null, // 提示音 data URI，init 时从主进程加载
      devices: [],
      // 联系人：持久化的全量列表（含离线联系人在内，凡上线过的都会出现）。
      // 与 devices（仅当前在线的临时列表）不同，contacts 跨重启保留。
      contacts: [],
      activeChatId: null,
      messages: {}, // convId(deviceId 或 groupId) -> [{...}]，落库于主进程
      groups: [], // [{ id, name, ownerId, members:[ids] }]
      unread: {}, // convId -> 未读条数
      fileSend: {}, // fileId -> { done, total, name, sending }
      fileRecv: {}, // fileId -> { received, total, name }
      broadcast: {
        role: null,
        localStream: null,
        teacherStream: null,
        teacherActive: false,
        teacherInfo: null,
        invitingTeachers: [],
        studentCount: 0,
        sourceId: null // 当前正在采集的源，广播中切画质/帧率需要复用它
      },
      sources: [],
      broadcastQuality: 'hd', // 屏幕广播画质：sd 标清 | hd 高清 | origin 原画
      broadcastFps: 30, // 屏幕广播帧率：15 | 30 | 60
      status: 'init'
    }
  },
  getters: {
    activeDevice(state) {
      return state.devices.find((d) => d.id === state.activeChatId) || null
    },
    activeGroup(state) {
      if (!state.activeChatId || !state.activeChatId.startsWith('group:'))
        return null
      return state.groups.find((g) => g.id === state.activeChatId) || null
    },
    isGroupActive(state) {
      return !!state.activeChatId && state.activeChatId.startsWith('group:')
    },
    activeName(state) {
      if (state.activeChatId && state.activeChatId.startsWith('group:')) {
        const g = state.groups.find((x) => x.id === state.activeChatId)
        return g ? g.name : '群聊'
      }
      const d = state.devices.find((x) => x.id === state.activeChatId)
      return d ? d.name : ''
    },
    activeMessages(state) {
      return state.messages[state.activeChatId] || []
    },
    // 联系人视图：合并「持久化联系人」与「当前在线设备」，
    // 标记 online 状态并按「在线优先 → 离线按最近在线时间倒序」排序。
    // 离线联系人（曾上线但现在不在 devices 中）依然显示，头像置灰。
    contactList(state) {
      const online = new Map(state.devices.map((d) => [d.id, d]))
      const list = (state.contacts || []).map((c) => ({
        id: c.id,
        name: c.name || '',
        avatar: c.avatar || '',
        ip: c.ip || '',
        port: c.port || 0,
        role: c.role || 'user',
        firstSeen: c.firstSeen || 0,
        lastOnline: c.lastOnline || 0,
        online: online.has(c.id)
      }))
      list.sort((a, b) => {
        // 当前在线的始终排在最前面
        if (a.online !== b.online) return a.online ? -1 : 1
        // 同段内：在线按昵称，离线按最近在线时间倒序
        if (a.online) return (a.name || '').localeCompare(b.name || '')
        return (b.lastOnline || 0) - (a.lastOnline || 0)
      })
      return list
    },
    // 当前在线联系人数（等于 devices 长度）
    onlineContactCount(state) {
      return state.devices.length
    },
    // 群成员名字列表（用于群头展示）
    activeGroupMemberNames(state) {
      if (!state.activeChatId || !state.activeChatId.startsWith('group:'))
        return []
      const g = state.groups.find((x) => x.id === state.activeChatId)
      if (!g) return []
      return g.members.map((id) => {
        if (id === state.self.id) return state.self.name + '(我)'
        const d = state.devices.find((x) => x.id === id)
        return d ? d.name : id.slice(0, 6)
      })
    }
  },
  actions: {
    // 仅持久化设置项（群与消息由各自的增量接口落库）
    _saveSettings() {
      try {
        window.api.dbSaveSettings({
          playSound: this.playSound,
          avatar: this.self.avatar,
          name: this.self.name,
          selectedInterface: this.selectedInterface,
          broadcastQuality: this.broadcastQuality,
          broadcastFps: this.broadcastFps
        })
      } catch {
        /* ignore */
      }
    },
    // 持久化群列表（整表替换，简单可靠）
    _persistGroups() {
      this._saveSettings()
      try {
        window.api.dbReplaceGroups(this.groups)
      } catch {
        /* ignore */
      }
    },
    // 将当前在线设备并入联系人表（新增或更新），并持久化。
    // 离线联系人不会被删除，仅当重新上线时刷新其 lastOnline / 资料。
    _mergeContacts(onlineList) {
      const now = Date.now()
      const map = new Map((this.contacts || []).map((c) => [c.id, c]))
      for (const d of onlineList || []) {
        if (!d || !d.id) continue
        const prev = map.get(d.id)
        map.set(d.id, {
          id: d.id,
          name: d.name || '',
          avatar: d.avatar || '',
          ip: d.ip || '',
          port: d.port || 0,
          role: d.role || 'user',
          firstSeen: prev ? prev.firstSeen : now,
          lastOnline: now
        })
      }
      this.contacts = [...map.values()]
      this._persistContacts()
    },
    // 增量落库：把合并后的联系人全量写回本地存储
    _persistContacts() {
      try {
        window.api.dbReplaceContacts(this.contacts)
      } catch {
        /* ignore */
      }
    },
    // 增量落库：新消息推入内存数组并写入本地存储（SQLite / JSON）
    _appendMsg(convId, msg) {
      const arr = this.messages[convId] || (this.messages[convId] = [])
      arr.push(msg)
      if (arr.length > MAX_MSG_PER_CONV) arr.splice(0, arr.length - MAX_MSG_PER_CONV)
      try {
        window.api.dbAppendMessage({ ...msg, convId })
      } catch {
        /* ignore */
      }
    },
    // 文件消息落盘完成后更新本地存储中的对应记录
    _updateMsg(convId, fileId, file, receiving) {
      try {
        window.api.dbUpdateMessage({ convId, fileId, file, receiving: !!receiving })
      } catch {
        /* ignore */
      }
    },
    _bumpUnread(convId) {
      if (this.activeChatId !== convId) {
        this.unread[convId] = (this.unread[convId] || 0) + 1
      }
    },
    async init() {
      if (this.status !== 'init') return
      // 从本地持久化（SQLite 或 JSON 文件）载入设置/群/消息
      let dbData = { settings: {}, groups: [], messages: {} }
      try {
        dbData = await window.api.dbLoad()
      } catch {
        /* ignore */
      }
      const s = dbData.settings || {}
      // 先还原到主进程（网卡 / 头像 / 昵称）
      if (s.selectedInterface && s.selectedInterface !== 'auto') {
        try {
          await window.api.setInterface(s.selectedInterface)
        } catch {
          /* ignore */
        }
      }
      if (s.avatar) {
        try {
          await window.api.setAvatar(s.avatar)
        } catch {
          /* ignore */
        }
      }
      if (s.name) {
        try {
          await window.api.setName(s.name)
        } catch {
          /* ignore */
        }
      }
      // 拉取主进程（已含还原后的头像/昵称/IP）
      this.self = await window.api.getSelf()
      // 本地 UI 状态
      if (typeof s.playSound === 'boolean') this.playSound = s.playSound
      // 广播画质 / 帧率（校验合法性，防止旧数据或非预期值）
      if (['sd', 'hd', 'origin'].includes(s.broadcastQuality)) {
        this.broadcastQuality = s.broadcastQuality
      }
      if ([15, 30, 60].includes(Number(s.broadcastFps))) {
        this.broadcastFps = Number(s.broadcastFps)
      }
      this.selectedInterface = s.selectedInterface || 'auto'
      this.groups = dbData.groups || []
      this.messages = dbData.messages || {}
      // 载入持久化联系人（含历史离线联系人），作为左侧「联系人」列表的基底
      this.contacts = dbData.contacts || []
      window.api.onDevices((list) => {
        this.devices = list
        // 设备（在线）变化时，并入持久化联系人并落库，离线者保留不删
        this._mergeContacts(list)
      })
      window.api.onChat((msg) => this.receiveChat(msg))
      window.api.onSignal((msg) => this.receiveSignal(msg))
      window.api.onGroup((msg) => this.receiveGroup(msg))
      window.api.onFileOffer((m) => this.receiveFileOffer(m))
      window.api.onFileProgress((m) => this.receiveFileProgress(m))
      window.api.onFileDone((m) => this.receiveFileDone(m))
      window.api.onFileSendStart((m) => {
        this.fileSend[m.fileId] = {
          done: 0,
          total: 0,
          name: m.name,
          sending: true
        }
      })
      window.api.onFileSendProgress((m) => {
        if (this.fileSend[m.fileId]) {
          this.fileSend[m.fileId].done = m.done
          this.fileSend[m.fileId].total = m.total
        }
      })
      window.api.onFileSendDone((m) => {
        if (this.fileSend[m.fileId]) this.fileSend[m.fileId].sending = false
        // 把对应本地消息标记为完成
        const arr = this.messages[m.convId]
        if (arr) {
          const msg = arr.find((x) => x.fileId === m.fileId && x.mine)
          if (msg) msg.sending = false
        }
      })
      this.status = 'ready'
      // 加载提示音（base64 data URI），用于新消息播放
      try {
        this.soundUri = await window.api.getSound()
      } catch {
        /* ignore */
      }
    },
    async setName(name) {
      this.self.name = await window.api.setName(name)
      this._saveSettings()
    },
    setPlaySound(val) {
      this.playSound = !!val
      this._saveSettings()
    },
    // 播放新消息提示音；受 playSound 开关与 soundUri 是否存在控制
    playNotify() {
      if (!this.playSound || !this.soundUri) return
      try {
        const a = new Audio(this.soundUri)
        a.volume = 0.6
        const p = a.play()
        if (p && p.catch) p.catch(() => {})
      } catch {
        /* 忽略自动播放被拦截等情况 */
      }
    },
    async setAvatar(avatar) {
      this.self.avatar = avatar || ''
      this._saveSettings()
      await window.api.setAvatar(this.self.avatar)
    },
    async setInterface(ip) {
      this.selectedInterface = ip || 'auto'
      this._saveSettings()
      await window.api.setInterface(this.selectedInterface)
      // 界面 IP 随网卡变化而更新
      this.self = { ...this.self, ...(await window.api.getSelf()) }
    },
    async refreshSelf() {
      const info = await window.api.getSelf()
      this.self = { ...this.self, ...info }
    },
    setActiveChat(id) {
      this.activeChatId = id
      this.unread[id] = 0
    },
    // 取群内成员当前在线 IP（排除自己）
    _memberIps(group) {
      if (!group) return []
      const ips = []
      for (const mid of group.members) {
        if (mid === this.self.id) continue
        const d = this.devices.find((x) => x.id === mid)
        if (d && d.ip) ips.push(d.ip)
      }
      return ips
    },
    // 通用发送：根据当前会话是设备还是群，决定发给谁
    _dispatch(kind, extra) {
      const id = this.activeChatId
      if (!id) return
      const isGroup = id.startsWith('group:')
      const group = isGroup ? this.groups.find((g) => g.id === id) : null
      const ts = Date.now()
      const payload = {
        type: 'chat',
        convId: id,
        toKind: isGroup ? 'group' : 'peer',
        groupId: isGroup ? id : null,
        kind,
        ts,
        fromAvatar: this.self.avatar,
        ...extra
      }
      if (isGroup) {
        const ips = this._memberIps(group)
        for (const ip of ips) window.api.sendChat(ip, payload)
      } else {
        const dev = this.devices.find((d) => d.id === id)
        if (dev) window.api.sendChat(dev.ip, payload)
      }
      this._appendMsg(id, {
        from: this.self.id,
        fromName: this.self.name,
        fromAvatar: this.self.avatar,
        ts,
        mine: true,
        kind,
        ...extra
      })
    },
    sendChat(text) {
      const t = (text || '').trim()
      if (!t) return
      this._dispatch('text', { text: t })
    },
    sendSticker(code) {
      if (!code) return
      this._dispatch('sticker', { sticker: code })
    },
    // 选择文件并发送（群则群发）
    async sendFileFromPicker() {
      const id = this.activeChatId
      if (!id) return
      const file = await window.api.pickFile()
      if (!file) return
      const isGroup = id.startsWith('group:')
      const group = isGroup ? this.groups.find((g) => g.id === id) : null
      const ips = isGroup
        ? this._memberIps(group)
        : (() => {
            const d = this.devices.find((x) => x.id === id)
            return d ? [d.ip] : []
          })()
      if (!ips.length) return
      const fileId =
        (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
        'f-' + Date.now()
      this.fileSend[fileId] = { done: 0, total: 0, name: file.name, sending: true }
      window.api.sendFile({
        fileId,
        ips,
        convId: id,
        groupId: isGroup ? id : null,
        file
      })
      this._appendMsg(id, {
        from: this.self.id,
        fromName: this.self.name,
        ts: Date.now(),
        mine: true,
        kind: 'file',
        fileId,
        file: { name: file.name, size: file.size, mime: file.mime, path: file.path },
        sending: true
      })
    },
    receiveChat(msg) {
      const convId = msg.toKind === 'group' ? msg.groupId : msg.from
      if (!convId) return
      this._appendMsg(convId, {
        from: msg.from,
        fromName: msg.fromName || '对方',
        fromAvatar: msg.fromAvatar || '',
        ts: msg.ts || Date.now(),
        mine: false,
        kind: msg.kind || 'text',
        text: msg.text,
        sticker: msg.sticker
      })
      this._bumpUnread(convId)
      this.playNotify()
    },
    // 群管理消息
    receiveGroup(msg) {
      if (!msg || !msg.action) return
      if (msg.action === 'create') {
        const g = msg.group
        if (g && !this.groups.find((x) => x.id === g.id)) {
          this.groups.push({
            id: g.id,
            name: g.name,
            ownerId: g.ownerId,
            members: g.members || []
          })
          this._bumpUnread(g.id)
          this._persistGroups()
        }
      } else if (msg.action === 'invite') {
        const g = this.groups.find((x) => x.id === msg.groupId)
        if (g && !g.members.includes(msg.memberId)) {
          g.members.push(msg.memberId)
          this._persistGroups()
        }
      } else if (msg.action === 'leave') {
        const g = this.groups.find((x) => x.id === msg.groupId)
        if (g) {
          g.members = g.members.filter((m) => m !== msg.memberId)
          this._persistGroups()
        }
      }
    },
    // 自己建群
    createGroup(name, memberIds) {
      const id = 'group:' + (window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : 'g-' + Date.now())
      const group = {
        id,
        name: (name || '群聊').trim().slice(0, 24),
        ownerId: this.self.id,
        members: [this.self.id, ...memberIds]
      }
      this.groups.push(group)
      this.setActiveChat(id)
      // 通知每位被邀请成员
      for (const mid of memberIds) {
        const d = this.devices.find((x) => x.id === mid)
        if (d && d.ip) {
          window.api.sendChat(d.ip, {
            type: 'group',
            action: 'create',
            group: { ...group, members: [...group.members] },
            convId: id,
            ts: Date.now()
          })
        }
      }
      this._persistGroups()
      return id
    },
    // 退群：从本地移除并通知其余成员
    leaveGroup(groupId) {
      const g = this.groups.find((x) => x.id === groupId)
      if (!g) return
      const others = g.members.filter((m) => m !== this.self.id)
      for (const mid of others) {
        const d = this.devices.find((x) => x.id === mid)
        if (d && d.ip) {
          window.api.sendChat(d.ip, {
            type: 'group',
            action: 'leave',
            groupId,
            memberId: this.self.id,
            ts: Date.now()
          })
        }
      }
      this.groups = this.groups.filter((x) => x.id !== groupId)
      if (this.activeChatId === groupId) this.activeChatId = null
      this._persistGroups()
    },
    // 文件接收事件
    receiveFileOffer(m) {
      this.fileRecv[m.fileId] = {
        received: 0,
        total: m.total || 0,
        name: m.name
      }
      const convId = m.convId || m.groupId
      if (!convId) return
      this._appendMsg(convId, {
        from: '?',
        fromName: m.fromName || '对方',
        fromAvatar: m.fromAvatar || '',
        ts: Date.now(),
        mine: false,
        kind: 'file',
        fileId: m.fileId,
        file: { name: m.name, size: m.size, mime: m.mime },
        receiving: true
      })
      this._bumpUnread(convId)
      this.playNotify()
    },
    receiveFileProgress(m) {
      if (this.fileRecv[m.fileId]) this.fileRecv[m.fileId].received = m.received
    },
    receiveFileDone(m) {
      const convId = m.convId || m.groupId
      const arr = this.messages[convId]
      if (arr) {
        const msg = arr.find((x) => x.fileId === m.fileId)
        if (msg) {
          msg.file = { name: m.name, size: m.size, mime: m.mime, path: m.path }
          msg.receiving = false
        }
      }
      if (this.fileRecv[m.fileId]) this.fileRecv[m.fileId].done = true
      this._updateMsg(convId, m.fileId, { name: m.name, size: m.size, mime: m.mime, path: m.path }, false)
    },
    loadSources() {
      return window.api.getSources().then((s) => {
        this.sources = s
        return s
      })
    },
    getBroadcaster() {
      if (!broadcaster) broadcaster = new TeacherBroadcaster(makeSendSignal())
      return broadcaster
    },
    getReceiver() {
      if (!receiver) {
        receiver = new StudentReceiver(makeSendSignal(), (stream) => {
          this.broadcast.teacherStream = stream
        })
      }
      return receiver
    },
    // 监听采集轨道结束：目标窗口被关闭 / 权限失效时 WGC 会结束该轨道，
    // 这里兜底自动停播，避免残留 capture session 反复抛 ProcessFrame failed。
    _watchStreamEnd(stream) {
      stream.getVideoTracks().forEach((t) => {
        t.addEventListener('ended', () => {
          if (this.broadcast.localStream === stream) this.stopBroadcast()
        })
      })
    },
    startBroadcast(sourceId) {
      if (!sourceId) return
      const profile = getQualityProfile(this.broadcastQuality)
      return captureScreen(sourceId, {
        quality: this.broadcastQuality,
        frameRate: this.broadcastFps
      }).then((stream) => {
        this._watchStreamEnd(stream)
        this.broadcast.role = 'teacher'
        this.broadcast.sourceId = sourceId
        this.broadcast.localStream = stream
        this.broadcast.teacherActive = true
        this.getBroadcaster().start(stream, profile.maxBitrate)
        for (const d of this.devices) {
          if (d.id !== this.self.id)
            window.api.sendSignal(d.ip, { kind: 'invite' })
        }
      })
    },
    // 调整广播画质 / 帧率。
    // · 未在广播：仅保存设置，下次开播生效。
    // · 正在广播：码率即时生效；分辨率/帧率变化则重新采集，再用 replaceTrack 热切换，
    //   与学生已建立的连接不断开、无需重新协商，观看者无感知。
    async setBroadcastProfile({ quality, fps } = {}) {
      const qChanged = quality && quality !== this.broadcastQuality
      const fChanged = fps && Number(fps) !== this.broadcastFps
      if (!qChanged && !fChanged) return
      if (qChanged) this.broadcastQuality = quality
      if (fChanged) this.broadcastFps = Number(fps)
      this._saveSettings()
      if (!this.broadcast.teacherActive) return

      // 码率可随时调整
      this.getBroadcaster().applyBitrate(getQualityProfile(this.broadcastQuality).maxBitrate)
      if (!this.broadcast.sourceId) return
      try {
        const stream = await captureScreen(this.broadcast.sourceId, {
          quality: this.broadcastQuality,
          frameRate: this.broadcastFps
        })
        const merged = await this.getBroadcaster().replaceVideo(stream)
        this._watchStreamEnd(merged)
        this.broadcast.localStream = merged
      } catch (e) {
        throw new Error('切换画质失败：' + ((e && e.message) || e))
      }
    },
    stopBroadcast() {
      if (broadcaster) broadcaster.stop()
      if (this.broadcast.localStream) {
        this.broadcast.localStream.getTracks().forEach((t) => t.stop())
      }
      for (const d of this.devices) {
        if (d.id !== this.self.id)
          window.api.sendSignal(d.ip, { kind: 'bye' })
      }
      this.broadcast.localStream = null
      this.broadcast.teacherActive = false
      this.broadcast.studentCount = 0
      this.broadcast.sourceId = null
      this.broadcast.role = null
      broadcaster = null
    },
    joinBroadcast(teacher) {
      this.broadcast.role = 'student'
      this.broadcast.teacherInfo = teacher
      this.broadcast.invitingTeachers = this.broadcast.invitingTeachers.filter(
        (t) => t.id !== teacher.id
      )
      window.api.sendSignal(teacher.ip, { kind: 'request' })
    },
    leaveBroadcast() {
      if (receiver) receiver.stop()
      receiver = null
      this.broadcast.role = null
      this.broadcast.teacherStream = null
      this.broadcast.teacherInfo = null
    },
    receiveSignal(msg) {
      const { payload, from, fromName, _from } = msg
      if (!payload || !payload.kind) return
      switch (payload.kind) {
        case 'invite':
          if (this.broadcast.role !== 'teacher') {
            const info = { id: from, name: fromName, ip: _from }
            if (!this.broadcast.invitingTeachers.find((t) => t.id === from)) {
              this.broadcast.invitingTeachers.push(info)
            }
          }
          break
        case 'request':
          if (this.broadcast.role === 'teacher') {
            this.getBroadcaster().addStudent({ id: from, ip: _from })
            this.broadcast.studentCount = this.getBroadcaster().peers.size
          }
          break
        case 'offer':
          if (this.broadcast.role === 'student') {
            this.getReceiver().handleOffer(from, _from, payload.sdp)
          }
          break
        case 'answer':
          if (this.broadcast.role === 'teacher') {
            this.getBroadcaster().handleAnswer(from, payload.sdp)
          }
          break
        case 'ice':
          if (this.broadcast.role === 'teacher') {
            this.getBroadcaster().handleIce(from, payload.candidate)
          } else if (this.broadcast.role === 'student') {
            this.getReceiver().handleIce(payload.candidate)
          }
          break
        case 'bye':
          if (this.broadcast.role === 'student') {
            this.leaveBroadcast()
          }
          break
      }
    }
  }
})
