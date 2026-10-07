import { contextBridge, ipcRenderer } from 'electron'

// 安全桥接层：仅暴露白名单 API，contextIsolation 开启
const api = {
  getSelf: () => ipcRenderer.invoke('self:info'),
  setName: (name) => ipcRenderer.invoke('self:setName', name),
  setAvatar: (avatar) => ipcRenderer.invoke('self:setAvatar', avatar),
  // 获取新消息提示音（base64 data URI），renderer 端用于播放
  getSound: () => ipcRenderer.invoke('get:sound'),
  // 获取打包内置头像列表 [{ id, url }]，url 为 base64 data URI
  getAvatars: () => ipcRenderer.invoke('get:avatars'),
  // 本地持久化（SQLite / JSON 文件，由主进程选择后端）
  dbLoad: () => ipcRenderer.invoke('db:load'),
  dbSaveSettings: (obj) => ipcRenderer.invoke('db:saveSettings', obj),
  // 删除某会话的全部消息（删除联系人时同步清理聊天记录）
  dbDeleteMessages: (convId) => ipcRenderer.invoke('db:deleteMessages', convId),
  dbReplaceGroups: (groups) => ipcRenderer.invoke('db:replaceGroups', groups),
  dbReplaceContacts: (list) => ipcRenderer.invoke('db:replaceContacts', list),
  dbAppendMessage: (m) => ipcRenderer.invoke('db:appendMessage', m),
  dbUpdateMessage: (p) => ipcRenderer.invoke('db:updateMessage', p),
  // 网卡列表与切换（用于选择局域网）
  getInterfaces: () => ipcRenderer.invoke('get:interfaces'),
  setInterface: (ip) => ipcRenderer.invoke('set:interface', ip),
  getSources: () => ipcRenderer.invoke('get:sources'),
  // 发送聊天 / 群聊消息（payload 已含会话信息）
  sendChat: (targetIp, payload) =>
    ipcRenderer.send('send:chat', { targetIp, payload }),
  sendSignal: (targetIp, payload) =>
    ipcRenderer.send('send:signal', { targetIp, payload }),
  // 发送文件：主进程只发出「传输请求」，等对方确认接收后再真正分片发送
  // spec = { fileId, ips, convId, groupId, file }
  sendFile: (spec) => ipcRenderer.send('send:file', spec),
  // 接收方确认 / 拒绝接收（accept 传 { fileId, saveAs:true } 会先弹「另存为」）
  acceptFile: (spec) => ipcRenderer.invoke('file:accept', spec),
  rejectFile: (spec) => ipcRenderer.invoke('file:reject', spec),
  // 学生端屏幕广播：独立观看窗口 打开 / 关闭 / 被关闭通知
  // close 传 reason：'closed' 学生手动关窗（保留学生身份）| 'teacher-stopped' 老师停播 | 'leave' 主动离开
  openBroadcastWindow: (info) => ipcRenderer.invoke('broadcast:open', info),
  closeBroadcastWindow: (reason) => ipcRenderer.invoke('broadcast:close', reason),
  onBroadcastClosed: (cb) =>
    ipcRenderer.on('lan:broadcast-closed', (_e, p) => cb(p || {})),
  // 选择文件，返回 { path, name, size, mime } 或 null
  pickFile: () => ipcRenderer.invoke('pick:file'),
  // 打开文件 / 在资源管理器定位
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  // 窗口控制（无边框自绘标题栏）：最小化/关闭都是隐藏到托盘，最大化/还原切换
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  // 订阅类
  onDevices: (cb) => ipcRenderer.on('lan:devices', (_e, list) => cb(list)),
  // 主动拉取当前已发现设备列表（init 时消除监听器注册时序导致的漏存）
  getDeviceList: () => ipcRenderer.invoke('discovery:list'),
  // 自动更新：获取版本、手动检查、安装、接收更新事件
  getAppVersion: () => ipcRenderer.invoke('getAppVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-install'),
  onUpdateEvent: (cb) => ipcRenderer.on('updater:event', (_e, payload) => cb(payload)),
  onChat: (cb) => ipcRenderer.on('lan:chat', (_e, msg) => cb(msg)),
  onSignal: (cb) => ipcRenderer.on('lan:signal', (_e, msg) => cb(msg)),
  onGroup: (cb) => ipcRenderer.on('lan:group', (_e, msg) => cb(msg)),
  onFileOffer: (cb) => ipcRenderer.on('lan:file-offer', (_e, m) => cb(m)),
  onFileProgress: (cb) => ipcRenderer.on('lan:file-progress', (_e, m) => cb(m)),
  onFileDone: (cb) => ipcRenderer.on('lan:file-done', (_e, m) => cb(m)),
  // 发送方：对方已拒绝接收该文件
  onFileRejected: (cb) => ipcRenderer.on('lan:file-rejected', (_e, m) => cb(m)),
  onFileSendStart: (cb) =>
    ipcRenderer.on('lan:file-send-start', (_e, m) => cb(m)),
  onFileSendProgress: (cb) =>
    ipcRenderer.on('lan:file-send-progress', (_e, m) => cb(m)),
  onFileSendDone: (cb) =>
    ipcRenderer.on('lan:file-send-done', (_e, m) => cb(m))
}

contextBridge.exposeInMainWorld('api', api)
