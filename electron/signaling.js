import { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

const SIGNAL_PORT = 41235
const SEND_TIMEOUT = 2500

// 聊天 + WebRTC 信令服务：既是 server（被动接收）也是 client（主动推送）
// 关键点：复用同一条 WebSocket 通道作为 WebRTC 信令，无需独立信令服务器
export class Signaling extends EventEmitter {
  constructor(self, host) {
    super()
    this.self = self // { id, name, port }
    this.host = host || '0.0.0.0'
    this._start()
  }

  _start() {
    this.wss = new WebSocketServer({ port: SIGNAL_PORT, host: this.host })

    this.wss.on('connection', (ws, req) => {
      const ip = (req.socket.remoteAddress || '').replace('::ffff:', '')
      ws.on('message', (data) => {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        if (!msg || typeof msg.type !== 'string') return
        this.emit('message', { ...msg, _from: ip })
      })
    })
    this.wss.on('error', (err) => this.emit('error', err))
  }

  // 切换网卡：重新监听新 host（'0.0.0.0' 表示全部网卡）
  rebind(host) {
    this.host = host || '0.0.0.0'
    try {
      this.wss.close(() => this._start())
    } catch {
      this._start()
    }
  }


  // 主动给目标 IP 发送一条消息（临时连接，发送后关闭）
  send(targetIp, payload) {
    return new Promise((resolve) => {
      const url = `ws://${targetIp}:${SIGNAL_PORT}`
      let ws
      try {
        ws = new WebSocket(url)
      } catch {
        return resolve(false)
      }
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        resolve(ok)
      }
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            ...payload,
            from: this.self.id,
            fromName: this.self.name
          })
        )
        finish(true)
      })
      ws.on('error', () => finish(false))
      setTimeout(() => finish(false), SEND_TIMEOUT)
    })
  }

  // 在单一连接内连续发送多条 payload（用于文件分片），onProgress 每发一片回调一次
  sendChunks(targetIp, payloads, onProgress) {
    return new Promise((resolve) => {
      if (!payloads || !payloads.length) return resolve(true)
      const url = `ws://${targetIp}:${SIGNAL_PORT}`
      let ws
      try {
        ws = new WebSocket(url)
      } catch {
        return resolve(false)
      }
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        resolve(ok)
      }
      ws.on('open', () => {
        let i = 0
        const sendNext = () => {
          if (i >= payloads.length) return finish(true)
          ws.send(
            JSON.stringify({
              ...payloads[i],
              from: this.self.id,
              fromName: this.self.name
            })
          )
          i++
          if (onProgress) onProgress(i, payloads.length)
          // 让出事件循环，保证分片被对端接收并刷新进度
          setImmediate(sendNext)
        }
        sendNext()
      })
      ws.on('error', () => finish(false))
      setTimeout(() => finish(false), SEND_TIMEOUT * Math.max(2, payloads.length))
    })
  }

  destroy() {
    try {
      this.wss.close()
    } catch {
      /* ignore */
    }
  }
}
