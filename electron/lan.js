import dgram from 'node:dgram'
import os from 'node:os'
import { EventEmitter } from 'node:events'

const DISCOVERY_PORT = 41234
const BROADCAST_INTERVAL = 3000
const HEARTBEAT_TIMEOUT = 12000
// 退出告别包：UDP 可能丢包，连发几遍确保对方一定收到
const BYE_REPEAT = 3
const BYE_INTERVAL = 60

// 用户选定的通信网卡 IP（null 表示自动/全部网卡）
let selectedIp = null

export function setSelectedIp(ip) {
  selectedIp = ip && ip !== 'auto' ? ip : null
}
export function getSelectedIp() {
  return selectedIp
}

// 默认局域网 IPv4（优先私有网段），仅在未手动指定网卡时使用
function getDefaultLanIp() {
  const ifaces = os.networkInterfaces()
  const candidates = []
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && typeof iface.address === 'string') {
        candidates.push(iface.address)
      }
    }
  }
  const privateIp = candidates.find((ip) =>
    /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(ip)
  )
  return privateIp || candidates[0] || '127.0.0.1'
}

// 当前对外宣告使用的 IP：手动指定优先，否则自动
export function getLanIp() {
  if (selectedIp) return selectedIp
  return getDefaultLanIp()
}

// 列出所有非内部的 IPv4 网卡，供设置界面选择
export function listInterfaces() {
  const ifaces = os.networkInterfaces()
  const out = []
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({
          name,
          address: iface.address,
          netmask: iface.netmask,
          mac: iface.mac,
          cidr: iface.cidr
        })
      }
    }
  }
  return out
}

// 根据 IPv4 地址与子网掩码计算广播地址
function computeBroadcast(address, netmask) {
  if (!address || !netmask) return '255.255.255.255'
  const a = address.split('.').map(Number)
  const m = netmask.split('.').map(Number)
  const b = a.map((x, i) => (x | (~m[i] & 255)) & 255)
  return b.join('.')
}

// 取某 IP 所在子网的广播地址（用于定向广播，避免 255.255.255.255 全网卡泛洪）
export function getBroadcastFor(ip) {
  if (!ip) return '255.255.255.255'
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && iface.address === ip) {
        return computeBroadcast(ip, iface.netmask)
      }
    }
  }
  return '255.255.255.255'
}

// 局域网设备发现：UDP 广播宣告 + 接收邻居广播 + 心跳超时清理
export class LanDiscovery extends EventEmitter {
  constructor(self) {
    super()
    this.self = self // { id, name, port, role, avatar }
    this.devices = new Map() // id -> { id, name, ip, port, role, avatar, lastSeen }
    this.bindIp = getSelectedIp() || '0.0.0.0'
    this._start()
  }

  _start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo))
    this.socket.on('error', (err) => this.emit('error', err))

    const doBind = () => {
      this.socket.bind(DISCOVERY_PORT, this.bindIp, () => {
        try {
          this.socket.setBroadcast(true)
        } catch {
          /* ignore */
        }
        this._announce()
        this._interval = setInterval(() => this._announce(), BROADCAST_INTERVAL)
        this._cleanup = setInterval(() => this._purge(), BROADCAST_INTERVAL)
        this.emit('ready')
      })
    }

    // 绑定失败时（端口占用/地址无效）稍后重试，避免崩溃
    this.socket.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        setTimeout(doBind, 800)
      }
    })

    doBind()
  }

  _announce() {
    const myIp = getLanIp()
    const payload = Buffer.from(
      JSON.stringify({
        type: 'hello',
        id: this.self.id,
        // host：电脑设备名。本软件定位是「一台电脑一个实例」，主机名比昵称/IP 更适合
        // 作为“这台电脑”的可读标识（昵称和 IP 都可能被用户改动）。
        host: this.self.host || os.hostname(),
        name: this.self.name,
        port: this.self.port,
        ip: myIp,
        role: this.self.role || 'user',
        avatar: this.self.avatar || ''
      })
    )
    const target = this.bindIp && this.bindIp !== '0.0.0.0'
      ? getBroadcastFor(this.bindIp)
      : '255.255.255.255'
    this.socket.send(payload, 0, payload.length, DISCOVERY_PORT, target, (err) => {
      if (err) this.emit('error', err)
    })
  }

  _onMessage(msg, rinfo) {
    let data
    try {
      data = JSON.parse(msg.toString())
    } catch {
      return
    }
    if (!data || !data.id) return
    if (data.id === this.self.id) return

    // 对方主动告别（正常退出）：立刻置为离线，不用干等 12s 心跳超时。
    // 这是「一方退出，其他电脑马上显示离线」的关键。
    if (data.type === 'bye') {
      if (this.devices.delete(data.id)) {
        this.emit('update', this.list())
      }
      return
    }

    if (data.type !== 'hello') return

    const ip = rinfo.address
    const host = data.host || ''
    const existing = this.devices.get(data.id)
    if (!existing) {
      this.devices.set(data.id, {
        id: data.id,
        name: data.name,
        host,
        ip,
        port: data.port,
        role: data.role,
        avatar: data.avatar || '',
        lastSeen: Date.now()
      })
      this.emit('update', this.list())
    } else {
      existing.lastSeen = Date.now()
      if (
        existing.ip !== ip ||
        existing.name !== data.name ||
        existing.port !== data.port ||
        existing.host !== host ||
        existing.avatar !== (data.avatar || '')
      ) {
        existing.ip = ip
        existing.name = data.name
        existing.host = host
        existing.port = data.port
        existing.role = data.role
        existing.avatar = data.avatar || ''
        this.emit('update', this.list())
      }
    }
  }

  // 广播下线通告：告诉所有邻居「我走了」，让它们立即把我标为离线
  _sendBye(onDone) {
    const finish = () => {
      if (typeof onDone === 'function') onDone()
    }
    // 捕获当前 socket 引用：回调里用局部变量关闭，
    // 避免期间 rebind() 换了新 socket 之后误关掉新的那个
    const sock = this.socket
    if (!sock || this._byeSent) return finish()
    this._byeSent = true
    const payload = Buffer.from(JSON.stringify({ type: 'bye', id: this.self.id }))
    const target =
      this.bindIp && this.bindIp !== '0.0.0.0'
        ? getBroadcastFor(this.bindIp)
        : '255.255.255.255'
    let sent = 0
    const sendOnce = () => {
      // 补发到点或 socket 已不可用时停止
      if (sent >= BYE_REPEAT || sock.destroyed) return finish()
      try {
        sock.send(
          payload,
          0,
          payload.length,
          DISCOVERY_PORT,
          target,
          (err) => {
            if (err) return finish()
            sent++
            if (sent < BYE_REPEAT) {
              setTimeout(sendOnce, BYE_INTERVAL)
            } else {
              finish()
            }
          }
        )
      } catch {
        finish()
      }
    }
    sendOnce()
  }

  _purge() {
    const now = Date.now()
    let changed = false
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > HEARTBEAT_TIMEOUT) {
        this.devices.delete(id)
        changed = true
      }
    }
    if (changed) this.emit('update', this.list())
  }

  list() {
    return [...this.devices.values()]
  }

  // 切换网卡：清空已发现设备，重新绑定到新 IP
  rebind() {
    this.bindIp = getSelectedIp() || '0.0.0.0'
    clearInterval(this._interval)
    clearInterval(this._cleanup)
    this.devices = new Map()
    try {
      this.socket.close(() => this._start())
    } catch {
      this._start()
    }
    this.emit('update', this.list())
  }

  destroy() {
    clearInterval(this._interval)
    clearInterval(this._cleanup)
    // 先把「我下线了」广播出去（连发数遍防丢包），发完再关 socket，
    // 这样对方电脑能立刻把联系人置为离线，而不是等满 12s 心跳超时。
    this._sendBye(() => {
      const sock = this.socket
      try {
        if (sock) sock.close()
      } catch {
        /* ignore */
      }
    })
  }
}
