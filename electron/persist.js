import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const MAX_PER_CONV = 400

// 建表语句逐条执行，保证「原生 SQLite」与「WASM SQLite」两种后端行为一致
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
  'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(convId)'
]

/**
 * 创建本地持久化后端，按优先级依次尝试：
 *   1) better-sqlite3（原生 SQLite，性能最佳）—— 需针对 Electron ABI 编译（Windows 需 VS 生成工具）
 *   2) node-sqlite3-wasm（WebAssembly SQLite，零编译）—— Node/Electron 通用，推荐默认
 *   3) JSON 文件（最后兜底）
 * 三者对外接口完全一致，store 层无需感知差异。
 */
export async function createPersistence(userDataDir) {
  const dbFile = join(userDataDir, 'lan-chat.db')
  const reasons = []

  // 1) 原生 SQLite
  try {
    const db = await openNative(dbFile)
    console.log('[persist] 持久化后端：SQLite（better-sqlite3 原生）')
    return makeSqlite(db)
  } catch (e) {
    reasons.push('better-sqlite3: ' + ((e && e.message) || e))
  }

  // 2) WASM SQLite（免编译，Electron 场景首选）
  try {
    const db = await openWasm(dbFile)
    console.log('[persist] 持久化后端：SQLite（node-sqlite3-wasm，免编译）')
    return makeSqlite(db)
  } catch (e) {
    reasons.push('node-sqlite3-wasm: ' + ((e && e.message) || e))
  }

  // 3) JSON 兜底
  console.warn(
    '[persist] SQLite 均不可用，降级为 JSON 文件存储。原因：' + reasons.join(' | ')
  )
  return makeJson(join(userDataDir, 'lan-chat-data.json'))
}

function toArr(params) {
  if (params === undefined || params === null) return []
  return Array.isArray(params) ? params : [params]
}

// ---- 后端适配：把不同 SQLite 驱动统一成 exec/run/get/all/transaction ----

async function openNative(file) {
  const mod = await import('better-sqlite3')
  const Database = mod.default || mod
  const raw = new Database(file)
  raw.pragma('journal_mode = WAL')
  for (const sql of DDL) raw.exec(sql)
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params) => raw.prepare(sql).run(...toArr(params)),
    get: (sql, params) => raw.prepare(sql).get(...toArr(params)),
    all: (sql, params) => raw.prepare(sql).all(...toArr(params)),
    transaction: (fn) => raw.transaction(fn)()
  }
}

async function openWasm(file) {
  const mod = await import('node-sqlite3-wasm')
  // 该包是 CJS，用 ESM 动态导入时具名导出未必可用（实际挂载在 default 上），需兼容两种形态
  const lib = (mod && mod.default) || mod
  const Database = lib && lib.Database
  if (typeof Database !== 'function') {
    throw new Error('node-sqlite3-wasm 未导出 Database')
  }
  const raw = new Database(file)
  for (const sql of DDL) raw.run(sql)
  return {
    exec: (sql) => raw.run(sql),
    run: (sql, params) => raw.run(sql, toArr(params)),
    get: (sql, params) => raw.get(sql, toArr(params)),
    all: (sql, params) => raw.all(sql, toArr(params)),
    // WASM 版没有内置事务 API，用 BEGIN/COMMIT 手工实现
    transaction: (fn) => {
      raw.run('BEGIN')
      try {
        const r = fn()
        raw.run('COMMIT')
        return r
      } catch (e) {
        try {
          raw.run('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw e
      }
    }
  }
}

function safeParse(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback
  } catch {
    return fallback
  }
}

// 载入时统一规范化文件类消息：重启后视为已完成（不再显示"发送中/接收中"）
function normalizeFileMsg(m) {
  if (m && m.kind === 'file') {
    m.sending = false
    m.receiving = false
  }
  return m
}

function makeSqlite(db) {
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
      return { settings, groups, messages }
    },
    saveSettings(obj) {
      db.run('INSERT OR REPLACE INTO kv(key, value) VALUES(?, ?)', [
        'settings',
        JSON.stringify(obj || {})
      ])
    },
    replaceGroups(groups) {
      db.transaction(() => {
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
    appendMessage(m) {
      db.run(
        `INSERT INTO messages(convId, ts, fromId, fromName, fromAvatar, kind, text, sticker, fileId, fileJson, mine, receiving, sending)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
        ]
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
    }
  }
}

function makeJson(path) {
  function read() {
    if (!existsSync(path)) return { settings: {}, groups: [], messages: {} }
    return safeParse(readFileSync(path, 'utf8'), {
      settings: {},
      groups: [],
      messages: {}
    })
  }
  function write(data) {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      /* ignore */
    }
    writeFileSync(path, JSON.stringify(data), 'utf8')
  }
  return {
    load() {
      const d = read()
      const messages = {}
      for (const convId of Object.keys(d.messages || {})) {
        messages[convId] = (d.messages[convId] || []).map((m) =>
          normalizeFileMsg({ ...m })
        )
      }
      return {
        settings: d.settings || {},
        groups: d.groups || [],
        messages
      }
    },
    saveSettings(obj) {
      const d = read()
      d.settings = obj || {}
      write(d)
    },
    replaceGroups(groups) {
      const d = read()
      d.groups = groups || []
      write(d)
    },
    appendMessage(m) {
      const d = read()
      const arr = d.messages[m.convId] || (d.messages[m.convId] = [])
      arr.push({
        from: m.from,
        fromName: m.fromName,
        fromAvatar: m.fromAvatar,
        ts: m.ts,
        mine: m.mine,
        kind: m.kind,
        text: m.text,
        sticker: m.sticker,
        fileId: m.fileId,
        file: m.file,
        receiving: m.receiving,
        sending: m.sending
      })
      if (arr.length > MAX_PER_CONV) arr.splice(0, arr.length - MAX_PER_CONV)
      write(d)
    },
    updateMessage(p) {
      const d = read()
      const arr = d.messages[p.convId]
      if (arr) {
        const msg = arr.find((x) => x.fileId === p.fileId)
        if (msg) {
          msg.file = p.file
          msg.receiving = p.receiving
        }
      }
      write(d)
    }
  }
}
