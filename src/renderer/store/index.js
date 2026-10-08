import { defineStore } from 'pinia'
import { TeacherBroadcaster, captureScreen, getQualityProfile } from '../webrtc.js'

// WebRTC 实例放模块级，避免被 Vue 响应式代理导致异常。
// 说明：学生端的接收器不在这里 —— 它运行在独立的「屏幕广播」观看窗口
// （见 components/BroadcastWindow.vue），主窗口只负责控制与状态展示。
let broadcaster = null

function makeSendSignal() {
  return (ip, payload) => window.api.sendSignal(ip, payload)
}

const MAX_MSG_PER_CONV = 400

export const useStore = defineStore('app', {
  state: () => {
    return {
      self: { id: '', host: '', name: '', ip: '', port: 0, avatar: '' },
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
        // 独立观看窗口当前是否开着。学生手动关掉窗口后仍保持 role='student'，
        // 这样主窗口右栏能继续显示该老师并提供「重新打开观看窗口」。
        viewerOpen: false,
        invitingTeachers: [],
        studentCount: 0,
        sourceId: null // 当前正在采集的源，广播中切画质/帧率需要复用它
      },
      sources: [],
      broadcastQuality: 'hd', // 屏幕广播画质：sd 标清 | hd 高清 | origin 原画
      broadcastFps: 30, // 屏幕广播帧率：15 | 30 | 60
      lastShot: null, // 最近一次框选截屏生成的图片文件（已在剪贴板中）
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
      // 排除自己：正常情况下发现层已过滤，但历史脏数据里可能存有自己的旧 ID
      const list = (state.contacts || [])
        .filter((c) => c.id !== state.self.id)
        .map((c) => ({
          id: c.id,
          host: c.host || '',
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
      const list = onlineList || []
      // 在线设备是权威数据：先把「同一台电脑的历史分身」剔除 —— 判定依据是
      // 设备 ID / 主机名(host) / IP，**刻意不使用昵称**：昵称随时可改，不能当身份。
      const onlineIds = new Set(list.map((d) => d && d.id).filter(Boolean))
      const onlineHosts = new Set(
        list.map((d) => ((d && d.host) || '').trim().toLowerCase()).filter(Boolean)
      )
      const onlineIps = new Set(list.map((d) => d && d.ip).filter(Boolean))
      const kept = (this.contacts || []).filter((c) => {
        if (!c || !c.id) return false
        if (onlineIds.has(c.id)) return true
        const h = (c.host || '').trim().toLowerCase()
        if (h && onlineHosts.has(h)) return false
        if (c.ip && onlineIps.has(c.ip)) return false
        return true
      })
      const map = new Map(kept.map((c) => [c.id, c]))
      for (const d of list) {
        if (!d || !d.id) continue
        const prev = map.get(d.id)
        map.set(d.id, {
          id: d.id,
          host: d.host || (prev && prev.host) || '',
          name: d.name || (prev && prev.name) || '',
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
    // 登记 / 更新单个联系人。已存在时只补充「之前为空」的字段，
    // 避免用空值覆盖掉 UDP 发现拿到的真实资料。
    _upsertContact(info) {
      if (!info || !info.id) return
      const now = Date.now()
      const list = this.contacts || []
      const idx = list.findIndex((c) => c.id === info.id)
      if (idx >= 0) {
        const prev = list[idx]
        this.contacts.splice(idx, 1, {
          ...prev,
          host: info.host || prev.host || '',
          name: info.name || prev.name || '',
          avatar: info.avatar || prev.avatar || '',
          ip: info.ip || prev.ip || '',
          port: info.port || prev.port || 0,
          role: info.role || prev.role || 'user',
          lastOnline: info.online === false ? prev.lastOnline : now
        })
      } else {
        this.contacts.push({
          id: info.id,
          host: info.host || '',
          name: info.name || '',
          avatar: info.avatar || '',
          ip: info.ip || '',
          port: info.port || 0,
          role: info.role || 'user',
          firstSeen: now,
          lastOnline: now
        })
      }
      this._persistContacts()
    },
    // 清理历史重复联系人。
    // 早期版本设备 ID 每次启动都变，导致同一台电脑在 contacts 表里堆积多条记录。
    // 归并只认「主机名 / IP」这类机器特征，**不认昵称** —— 昵称是用户可改的属性：
    // 两个人可能同名，同一个人也可能改昵称，都不能用来判断是不是同一台电脑。
    _dedupeContacts() {
      const list = (this.contacts || []).filter((c) => c && c.id)
      // 合并时保留信息更全、且最近在线的那条
      const better = (a, b) => {
        const score = (x) => (x.ip ? 2 : 0) + (x.avatar ? 1 : 0) + (x.host ? 1 : 0)
        const sa = score(a)
        const sb = score(b)
        if (sa !== sb) return sa > sb ? a : b
        return (a.lastOnline || 0) >= (b.lastOnline || 0) ? a : b
      }
      const merged = new Map() // key -> contact
      const order = []
      const put = (key, c) => {
        if (!key) {
          order.push(c)
          return
        }
        if (!merged.has(key)) {
          merged.set(key, c)
          order.push(c)
        } else {
          const old = merged.get(key)
          const keep = better(old, c)
          const idx = order.indexOf(old)
          if (idx >= 0) order[idx] = keep
          merged.set(key, keep)
        }
      }
      // 第一轮：同一台电脑（主机名相同）——这是最可靠的机器特征
      for (const c of list) put(c.host ? 'h:' + c.host.trim().toLowerCase() : null, c)
      // 第二轮：没有主机名的旧数据，退而用 IP 归并（同一时刻同一 IP 基本就是同一台机器）
      for (const c of order) {
        if (!c.host && c.ip) put('ip:' + c.ip, c)
      }

      const before = list.length
      this.contacts = order
      if (before !== order.length) {
        console.log(`[store] 联系人去重：${before} → ${order.length}`)
        this._persistContacts()
      }
    },
    // 自愈回填：contacts 表为空（例如该功能是后期新增的）时，从历史聊天记录里
    // 把「曾经聊过的人」恢复成联系人。消息表里有 fromId / fromName / fromAvatar，
    // 唯独没有 IP，离线状态下显示为「离线」；等对方再次上线，UDP 发现会补全 IP。
    // 注：用户删除联系人时会同步删掉该会话的消息，所以被删的人不会被这里复活。
    _backfillContactsFromMessages() {
      // 仅在联系人完全为空时回填，避免每次启动都翻历史消息
      if ((this.contacts || []).length) return
      const known = new Set((this.contacts || []).map((c) => c.id))
      const candidates = new Map()
      for (const convId of Object.keys(this.messages || {})) {
        for (const m of this.messages[convId] || []) {
          const id = m && m.from
          if (!id || id === this.self.id || known.has(id)) continue
          const prev = candidates.get(id)
          if (!prev) {
            candidates.set(id, {
              id,
              name: m.fromName || '',
              avatar: m.fromAvatar || '',
              ts: m.ts || 0
            })
          } else if (m.ts && m.ts > prev.ts) {
            prev.name = m.fromName || prev.name
            prev.avatar = m.fromAvatar || prev.avatar
            prev.ts = m.ts
          }
        }
      }
      if (!candidates.size) return
      for (const c of candidates.values()) {
        this._upsertContact({ id: c.id, name: c.name, avatar: c.avatar })
      }
      console.log('[store] 已从聊天记录回填联系人：', candidates.size)
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
    // 按 fileId 找到对应的文件消息卡片并打补丁（发送方 / 接收方通用）
    _patchFileMsg(fileId, patch) {
      if (!fileId) return
      for (const convId of Object.keys(this.messages)) {
        const msg = (this.messages[convId] || []).find((x) => x.fileId === fileId)
        if (msg) {
          Object.assign(msg, patch)
          return msg
        }
      }
      return null
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
      // contacts 表为空时，从历史聊天记录回填，避免"聊过的人用完就没了"
      this._backfillContactsFromMessages()
      // 早期版本设备 ID 不稳定会堆积同名重复项，这里统一归并
      this._dedupeContacts()
      window.api.onDevices((list) => {
        this.devices = list
        // 设备（在线）变化时，并入持久化联系人并落库，离线者保留不删
        this._mergeContacts(list)
      })
      // 主动拉取一次当前已发现设备并合并：消除「初始发现事件早于
      // onDevices 监听器注册」导致联系人漏存、在线状态漏标的时序问题
      try {
        const initial = await window.api.getDeviceList()
        if (Array.isArray(initial) && initial.length) {
          this.devices = initial
          this._mergeContacts(initial)
        }
      } catch {
        /* ignore */
      }
      window.api.onChat((msg) => this.receiveChat(msg))
      window.api.onSignal((msg) => this.receiveSignal(msg))
      window.api.onGroup((msg) => this.receiveGroup(msg))
      window.api.onFileOffer((m) => this.receiveFileOffer(m))
      window.api.onFileIncoming((m) => this.receiveFileIncoming(m))
      window.api.onFileProgress((m) => this.receiveFileProgress(m))
      window.api.onFileDone((m) => this.receiveFileDone(m))
      window.api.onFileSendStart((m) => {
        this.fileSend[m.fileId] = {
          done: 0,
          total: 0,
          name: m.name,
          sending: true,
          waiting: false
        }
        // 对方已确认接收 → 卡片从「等待对方接收」切到「发送中」
        this._patchFileMsg(m.fileId, { waiting: false, sending: true })
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
        this._patchFileMsg(m.fileId, { waiting: false, sending: false })
      })
      // 对方拒绝接收本端发出的文件
      window.api.onFileRejected((m) => {
        if (this.fileSend[m.fileId]) this.fileSend[m.fileId].sending = false
        this._patchFileMsg(m.fileId, { waiting: false, sending: false, rejected: true })
      })
      // 对方在接收途中主动取消，发送方需停止剩余分片
      window.api.onFileCancelled((m) => this.receiveFileCancelled(m))
      // 框选截屏完成（结果由主进程从独立的框选层窗口回传）
      window.api.onShotResult((m) => this.handleShotResult(m))
      // 独立观看窗口被关闭。
      // 关键：只有「老师停播 / 主动离开」才退出学生身份；
      // 学生自己关掉观看窗口时保留 role / teacherInfo，右栏继续显示该老师，
      // 并提供「重新打开观看窗口」，否则关一次窗口就再也加不回去了。
      window.api.onBroadcastClosed((p) => {
        const reason = (p && p.reason) || 'closed'
        this.broadcast.viewerOpen = false
        if (reason === 'teacher-stopped' || reason === 'leave') {
          this.broadcast.role = null
          this.broadcast.teacherStream = null
          this.broadcast.teacherInfo = null
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
    // 手动删除一个联系人（仅允许删除离线联系人，见 DeviceList 右键菜单约束）。
    // 删除后落库；若该联系人之后再次上线，_mergeContacts 会重新并入，属预期行为。
    // 删除离线联系人 = 清除与该设备的会话记录。
    // 联系人身份本身绑定的是「设备」（稳定的机器 ID + 主机名），所以对方之后
    // 重新上线时会被 UDP 发现重新并入列表，只是不再带有历史聊天记录。
    deleteContact(id) {
      if (!id) return
      // 在线联系人不可删除：对方此刻就在列表里，删掉会立刻又被并回来。
      // UI 已经拦了一层，这里再兜底一次，避免菜单状态过期导致误删。
      if ((this.devices || []).some((d) => d.id === id)) return
      // 1) 从联系人列表移除
      this.contacts = (this.contacts || []).filter((c) => c.id !== id)
      this._persistContacts()
      // 2) 同步清除与该联系人的全部聊天记录（内存 + 本地库）
      this.messages = { ...this.messages, [id]: [] }
      this.unread[id] = 0
      window.api.dbDeleteMessages(id)
      if (this.activeChatId === id) this.activeChatId = null
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
    // 选择图片并发送。
    // 传输仍走文件通道（分片 + 对方确认 + 进度），但消息带 image/* 的 mime，
    // 渲染层据此内联显示为图片而不是文件卡片。
    async sendImageFromPicker() {
      const id = this.activeChatId
      if (!id) return
      const file = await window.api.pickImage()
      if (!file) return
      this._sendFileToConversation(id, file)
    },

    async sendFileFromPicker() {
      const id = this.activeChatId
      if (!id) return
      const file = await window.api.pickFile()
      if (!file) return
      this._sendFileToConversation(id, file)
    },

    // 框选截屏：主进程隐藏主窗口抓底图 → 全屏框选层 → 裁剪后写入剪贴板。
    // 按需求**不自动发送**，用户自行粘贴到聊天框。
    async beginScreenshot() {
      const r = await window.api.beginScreenshot()
      if (!r || !r.ok) {
        return { ok: false, reason: (r && r.reason) || '截屏失败' }
      }
      return { ok: true }
    },

    // 最近一次框选截屏产生的图片文件（已放入剪贴板），供「顺便发送」等功能取用
    handleShotResult(m) {
      if (m && m.ok && m.file) this.lastShot = m.file
    },

    // 发送一个已就绪的图片文件（如 Ctrl+V 粘贴截图得到的临时文件）
    sendImageFile(file) {
      const id = this.activeChatId
      if (!id || !file) return
      this._sendFileToConversation(id, file)
    },

    // 接收过程中主动取消：停止接收，删除半截文件，并通知发送方停发
    async cancelReceive(fileId) {
      if (!fileId) return false
      const r = await window.api.cancelReceive(fileId)
      if (!r || !r.ok) return false
      this._patchFileMsg(fileId, { receiving: false, awaiting: false, cancelled: true })
      delete this.fileRecv[fileId]
      return true
    },

    // 对方在传输途中取消接收
    receiveFileCancelled(m) {
      if (!m || !m.fileId) return
      if (this.fileSend[m.fileId]) this.fileSend[m.fileId].sending = false
      this._patchFileMsg(m.fileId, { sending: false, waiting: false, cancelled: true })
    },

    // 转发图片给选中的联系人 / 群（可多选，每人各发一份）
    forwardImage(file, ids) {
      const list = Array.isArray(ids) ? ids : [ids]
      if (!file || !list.length) return 0
      let n = 0
      for (const id of list) {
        if (id.startsWith('group:')) {
          const g = this.groups.find((x) => x.id === id)
          const ips = this._memberIps(g)
          if (!ips.length) continue
          this._dispatchFile(id, id, ips, file, true)
          n++
        } else {
          const dev = this.devices.find((d) => d.id === id)
          if (!dev || !dev.ip) continue
          this._dispatchFile(id, null, [dev.ip], file, true)
          n++
        }
      }
      return n
    },

    // 把一个已选中的文件/图片发给当前会话（群则群发）
    _sendFileToConversation(id, file) {
      const isGroup = id.startsWith('group:')
      const group = isGroup ? this.groups.find((g) => g.id === id) : null
      const ips = isGroup
        ? this._memberIps(group)
        : (() => {
            const d = this.devices.find((x) => x.id === id)
            return d ? [d.ip] : []
          })()
      this._dispatchFile(id, isGroup ? id : null, ips, file)
    },

    // 真正发起一次文件/图片传输（正常发送与转发共用）
    // forwarded=true 时消息上标注「转发的图片」
    _dispatchFile(convId, groupId, ips, file, forwarded = false) {
      if (!ips || !ips.length || !file) return
      const fileId =
        (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
        'f-' + Date.now()
      // 图片不需要对方确认，直接开传；其余文件仍走「等确认」流程
      const direct = String(file.mime || '').startsWith('image/')
      this.fileSend[fileId] = {
        done: 0,
        total: 0,
        name: file.name,
        sending: direct,
        waiting: !direct
      }
      window.api.sendFile({
        fileId,
        ips,
        convId,
        groupId,
        direct,
        file
      })
      this._appendMsg(convId, {
        from: this.self.id,
        fromName: this.self.name,
        ts: Date.now(),
        mine: true,
        kind: 'file',
        fileId,
        file: { name: file.name, size: file.size, mime: file.mime, path: file.path },
        waiting: !direct,
        sending: direct,
        forwarded
      })
    },
    receiveChat(msg) {
      const convId = msg.toKind === 'group' ? msg.groupId : msg.from
      if (!convId) return
      // 收到消息即证明对方此刻在线，顺手登记为联系人（UDP 发现漏掉时的兜底）
      if (msg.from && msg.from !== this.self.id) {
        this._upsertContact({
          id: msg.from,
          name: msg.fromName || '',
          avatar: msg.fromAvatar || '',
          ip: msg._from || ''
        })
      }
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
    // 收到对端的文件传输请求：先展示卡片，等用户点「接收 / 另存为」才开始接收
    receiveFileOffer(m) {
      this.fileRecv[m.fileId] = {
        received: 0,
        total: m.total || 0,
        name: m.name
      }
      // 会话键：群聊用 groupId；单聊用「发送方设备 id」（不能直接用对端传来的 convId，
      // 那是「对端的会话键」，单聊时等于本端 id，会落到本端自己的会话桶里）
      const convId = m.groupId || m.from || m.convId
      if (!convId) return
      this._appendMsg(convId, {
        from: m.from || '?',
        fromName: m.fromName || '对方',
        fromAvatar: m.fromAvatar || '',
        ts: Date.now(),
        mine: false,
        kind: 'file',
        fileId: m.fileId,
        file: { name: m.name, size: m.size, mime: m.mime },
        awaiting: true, // 等待本端确认接收
        receiving: false
      })
      this._bumpUnread(convId)
      this.playNotify()
    },
    // 文件数据开始到达。
// 两种情况：
//   1) 普通文件 —— offer 阶段已在聊天区建了「待接收」卡片，这里只切成「接收中」；
//   2) 图片等免确认直传 —— 根本没有 offer 事件，需要在这里即时新建消息，
//      否则接收方界面会一直没有任何反应。
    receiveFileIncoming(m) {
      const convId = m.groupId || m.from || m.convId
      if (!convId) return
      const arr = this.messages[convId] || []
      const exist = arr.find((x) => x.fileId === m.fileId)
      if (exist) {
        exist.awaiting = false
        exist.receiving = true
        return
      }
      this.fileRecv[m.fileId] = {
        received: 0,
        total: m.total || 0,
        name: m.name
      }
      this._appendMsg(convId, {
        from: m.from || '?',
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
      const f = this.fileRecv[m.fileId]
      if (f) {
        f.received = m.received
        if (m.total) f.total = m.total
      }
    },
    receiveFileDone(m) {
      const convId = m.groupId || m.from || m.convId
      const arr = this.messages[convId]
      if (arr) {
        const msg = arr.find((x) => x.fileId === m.fileId)
        if (msg) {
          msg.file = { name: m.name, size: m.size, mime: m.mime, path: m.path }
          msg.receiving = false
          msg.awaiting = false
          msg.rejected = false
        }
      }
      if (this.fileRecv[m.fileId]) this.fileRecv[m.fileId].done = true
      this._updateMsg(convId, m.fileId, { name: m.name, size: m.size, mime: m.mime, path: m.path }, false)
    },
    // 接收方同意接收。saveAs=true 时先弹出「另存为」对话框选择保存位置，
    // 用户取消则不发送 accept（对方仍处于「等待接收」状态）。
    async acceptFile(fileId, saveAs = false) {
      const r = await window.api.acceptFile({ fileId, saveAs: !!saveAs })
      if (!r || !r.ok) return false
      this._patchFileMsg(fileId, { awaiting: false, receiving: true, rejected: false })
      return true
    },
    // 接收方拒绝接收：通知对方，并把卡片标记为「已拒绝」
    rejectFile(fileId) {
      window.api.rejectFile({ fileId })
      this._patchFileMsg(fileId, { awaiting: false, receiving: false, rejected: true })
      delete this.fileRecv[fileId]
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
    // 加入老师的广播：画面单独开一个独立窗口播放（不在主窗口右侧挤小画面）。
    // 完整的 WebRTC 握手（request → offer → answer → ice）由该窗口自行完成。
    joinBroadcast(teacher) {
      this.broadcast.role = 'student'
      this.broadcast.teacherInfo = teacher
      this.broadcast.viewerOpen = true
      this.broadcast.invitingTeachers = this.broadcast.invitingTeachers.filter(
        (t) => t.id !== teacher.id
      )
      if (window.api.openBroadcastWindow) {
        window.api.openBroadcastWindow({
          id: teacher.id,
          name: teacher.name,
          ip: teacher.ip
        })
      }
    },
    // 重新打开观看窗口（用户手动关掉后想再看）。老师端的旧连接已在窗口关闭时
    // 通过 leave 信号清理，这里再发一次 request 会拿到一条全新的 PeerConnection。
    reopenBroadcastWindow() {
      const t = this.broadcast.teacherInfo
      if (t && window.api.openBroadcastWindow) {
        this.broadcast.viewerOpen = true
        window.api.openBroadcastWindow({ id: t.id, name: t.name, ip: t.ip })
      }
    },
    leaveBroadcast() {
      if (window.api.closeBroadcastWindow) window.api.closeBroadcastWindow('leave')
      this.broadcast.role = null
      this.broadcast.teacherStream = null
      this.broadcast.teacherInfo = null
      this.broadcast.viewerOpen = false
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
        case 'leave':
          // 学生关掉了观看窗口：移除该连接，否则 peers 里残留僵尸连接，
          // 学生再次进入时 addStudent 会直接 return，导致新窗口连不上画面。
          if (this.broadcast.role === 'teacher') {
            this.getBroadcaster().removeStudent(from)
            this.broadcast.studentCount = this.getBroadcaster().peers.size
          }
          break
        case 'offer':
          // 学生端的 offer / ice 已在主进程被路由到独立观看窗口
          // （components/BroadcastWindow.vue），主窗口只处理老师端逻辑。
          break
        case 'answer':
          if (this.broadcast.role === 'teacher') {
            this.getBroadcaster().handleAnswer(from, payload.sdp)
          }
          break
        case 'ice':
          if (this.broadcast.role === 'teacher') {
            this.getBroadcaster().handleIce(from, payload.candidate)
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
