import { join } from 'node:path'

const MAX_PER_CONV = 400

// 建表语句逐条执行
const DDL = [
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)',
  `CREATE TABLE IF NOT EXISTS groups (
     id TEXT PRIMARY KEY, name TEXT, ownerId TEXT, members TEXT, createdAt INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     convId TEXT NOT NULL,
     ts INTEGER, fromId TEXT, fromName TEXT, fromAvatar TEXT,
     kind TEXT, text TEXT, sticker TEXT,
     fileId TEXT, fileJson TEXT,
     mine INTEGER, receiving INTEGER, sending INTEGER
   )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(convId)',
  `CREATE TABLE IF NOT EXISTS contacts (
     id TEXT PRIMARY KEY,
     name TEXT,
     avatar TEXT,
     ip TEXT,
     port INTEGER,
     role TEXT,
     host TEXT,
     firstSeen INTEGER,
     lastOnline INTEGER
   )`
]

// 旧版本数据库里 contacts 表缺列，用 ALTER TABLE 幂等补齐
const CONTACT_COLUMNS = [
  { name: 'host', type: 'TEXT' },
  { name: 'firstSeen', type: 'INTEGER' },
  { name: 'lastOnline', type: 'INTEGER' },
  { name: 'avatar', type: 'TEXT' },
  { name: 'port', type: 'INTEGER' },
  { name: 'role', type: 'TEXT' }
]

function safeParse(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback
  } catch {
    return fallback
  }
}

// node-sqlite3-wasm 的 run/get/all 都能直接接受数组参数，这里统一把
// null/undefined 归一化为空数组，避免驱动对 undefined 的处理差异
function params(p) {
  if (p === undefined || p === null) return []
  return Array.isArray(p) ? p : [p]
}

// 载入时统一规范化文件类消息：重启后视为已完成（不再显示"发送中/接收中"，
// 也不再残留「等待对方接收 / 待接收」这类已经失效的中间态）
function normalizeFileMsg(m) {
  if (m && m.kind === 'file') {
    m.sending = false
    m.receiving = false
    m.waiting = false
    m.awaiting = false
  }
  return m
}

/**
 * 创建本地持久化后端：node-sqlite3-wasm（WebAssembly SQLite，零编译）。
 * 选择它的原因：Electron 内置 Node 的 ABI 与原生 sqlite 插件不兼容，
 * 原生驱动需要按 Electron 版本重新编译才能加载；WASM 版本不受 ABI 影响，
 * 打包后开箱即用。
 *
 * 该函数失败时**会抛异常**，由调用方决定如何提示用户 —— 绝不能静默降级，
 * 否则会出现"聊天记录/联系人/设置看起来正常，实际每次重启都丢"的假象。
 */
export async function createPersistence(userDataDir) {
  const dbFile = join(userDataDir, 'lan-chat.db')
  console.log('[persist] 数据库文件：', dbFile)

  const mod = await import('node-sqlite3-wasm')
  // 该包是 CJS，用 ESM 动态导入时具名导出未必可用（实际挂载在 default 上）
  const lib = (mod && mod.default) || mod
  const Database = lib && lib.Database
  if (typeof Database !== 'function') {
    throw new Error('node-sqlite3-wasm 未导出 Database')
  }

  const db = new Database(dbFile)
  for (const sql of DDL) db.run(sql)

  // 补齐旧库缺失的列（幂等）
  try {
    const have = new Set((db.all('PRAGMA table_info(contacts)') || []).map((r) => r.name))
    for (const c of CONTACT_COLUMNS) {
      if (!have.has(c.name)) {
        db.run(`ALTER TABLE contacts ADD COLUMN ${c.name} ${c.type}`)
      }
    }
  } catch (e) {
    console.warn('[persist] contacts 表列检查失败（不影响使用）：', (e && e.message) || e)
  }

  console.log('[persist] 持久化后端：SQLite（node-sqlite3-wasm）')

  // WASM 版没有内置事务 API，用 BEGIN/COMMIT 手工实现
  const transaction = (fn) => {
    db.run('BEGIN')
    try {
      const r = fn()
      db.run('COMMIT')
      return r
    } catch (e) {
      try {
        db.run('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw e
    }
  }

  return {
    load() {
      const sRow = db.get('SELECT value FROM kv WHERE key = ?', ['settings'])
      const settings = sRow ? safeParse(sRow.value, {}) : {}
      const groups = db.all('SELECT * FROM groups').map((r) => ({
        id: r.id,
        name: r.name,
        ownerId: r.ownerId,
        members: safeParse(r.members, [])
      }))
      const messages = {}
      const rows = db.all('SELECT * FROM messages ORDER BY id ASC')
      for (const r of rows) {
        const arr = messages[r.convId] || (messages[r.convId] = [])
        arr.push(
          normalizeFileMsg({
            from: r.fromId,
            fromName: r.fromName,
            fromAvatar: r.fromAvatar || '',
            ts: r.ts,
            mine: !!r.mine,
            kind: r.kind,
            text: r.text || undefined,
            sticker: r.sticker || undefined,
            fileId: r.fileId || undefined,
            file: r.fileJson ? safeParse(r.fileJson, null) : undefined,
            receiving: !!r.receiving,
            sending: !!r.sending
          })
        )
      }
      const contacts = db.all('SELECT * FROM contacts').map((r) => ({
        id: r.id,
        name: r.name || '',
        avatar: r.avatar || '',
        ip: r.ip || '',
        port: r.port || 0,
        role: r.role || 'user',
        host: r.host || '',
        firstSeen: r.firstSeen || 0,
        lastOnline: r.lastOnline || 0
      }))
      console.log(
        `[persist] 已载入：联系人 ${contacts.length} 个 / 群 ${groups.length} 个 / 会话 ${Object.keys(messages).length} 个`
      )
      return { settings, groups, messages, contacts }
    },

    saveSettings(obj) {
      db.run('INSERT OR REPLACE INTO kv(key, value) VALUES(?, ?)', [
        'settings',
        JSON.stringify(obj || {})
      ])
    },

    replaceGroups(groups) {
      transaction(() => {
        db.run('DELETE FROM groups')
        for (const g of groups || []) {
          db.run(
            'INSERT OR REPLACE INTO groups(id, name, ownerId, members, createdAt) VALUES(?, ?, ?, ?, ?)',
            [
              g.id,
              g.name,
              g.ownerId,
              JSON.stringify(g.members || []),
              g.createdAt || Date.now()
            ]
          )
        }
      })
    },

    replaceContacts(list) {
      transaction(() => {
        db.run('DELETE FROM contacts')
        for (const c of list || []) {
          db.run(
            'INSERT OR REPLACE INTO contacts(id, name, avatar, ip, port, role, host, firstSeen, lastOnline) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              c.id,
              c.name || '',
              c.avatar || '',
              c.ip || '',
              c.port || 0,
              c.role || 'user',
              c.host || '',
              c.firstSeen || Date.now(),
              c.lastOnline || Date.now()
            ]
          )
        }
      })
    },

    appendMessage(m) {
      db.run(
        `INSERT INTO messages(convId, ts, fromId, fromName, fromAvatar, kind, text, sticker, fileId, fileJson, mine, receiving, sending)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params([
          m.convId,
          m.ts || Date.now(),
          m.from || '',
          m.fromName || '',
          m.fromAvatar || '',
          m.kind || 'text',
          m.text || null,
          m.sticker || null,
          m.fileId || null,
          m.file ? JSON.stringify(m.file) : null,
          m.mine ? 1 : 0,
          m.receiving ? 1 : 0,
          m.sending ? 1 : 0
        ])
      )
      // 单会话条数上限，超出删最旧
      const row = db.get('SELECT COUNT(*) AS c FROM messages WHERE convId = ?', [
        m.convId
      ])
      const c = row ? row.c : 0
      if (c > MAX_PER_CONV) {
        db.run(
          `DELETE FROM messages
           WHERE convId = ? AND id IN (
             SELECT id FROM messages WHERE convId = ? ORDER BY id ASC LIMIT ?
           )`,
          [m.convId, m.convId, c - MAX_PER_CONV]
        )
      }
    },

    updateMessage(p) {
      db.run(
        'UPDATE messages SET fileJson = ?, receiving = ? WHERE convId = ? AND fileId = ?',
        [JSON.stringify(p.file || null), p.receiving ? 1 : 0, p.convId, p.fileId]
      )
    },

    // 删除某个会话的全部消息（右键删除联系人时同步调用）
    deleteMessages(convId) {
      if (!convId) return 0
      db.run('DELETE FROM messages WHERE convId = ?', [convId])
      return db.get('SELECT changes() AS c').c
    }
  }
}
