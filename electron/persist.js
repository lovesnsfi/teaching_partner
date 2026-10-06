import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const MAX_PER_CONV = 400

// 创建本地持久化后端：
//   优先 SQLite（better-sqlite3）：kv(设置) / groups(群) / messages(聊天) 三张表
//   若 better-sqlite3 未安装，则自动降级为 userData 下的 JSON 文件（同为"本地持久化存储方案"）
// 两者对外接口完全一致，store 层无需感知差异。
export async function createPersistence(userDataDir) {
  try {
    const mod = await import('better-sqlite3')
    const Database = mod.default || mod
    const db = new Database(join(userDataDir, 'lan-chat.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT, ownerId TEXT, members TEXT, createdAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        convId TEXT NOT NULL,
        ts INTEGER,
        fromId TEXT,
        fromName TEXT,
        fromAvatar TEXT,
        kind TEXT,
        text TEXT,
        sticker TEXT,
        fileId TEXT,
        fileJson TEXT,
        mine INTEGER,
        receiving INTEGER,
        sending INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(convId);
    `)
    console.log('[persist] 使用 SQLite 存储 (better-sqlite3)')
    return makeSqlite(db)
  } catch (e) {
    console.warn(
      '[persist] 未检测到 better-sqlite3，降级为 JSON 文件存储:',
      (e && e.message) || e
    )
    return makeJson(join(userDataDir, 'lan-chat-data.json'))
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
  const getSettings = db.prepare('SELECT value FROM kv WHERE key=?')
  const setSettings = db.prepare(
    'INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)'
  )
  const allGroups = db.prepare('SELECT * FROM groups')
  const insGroup = db.prepare(
    'INSERT OR REPLACE INTO groups(id,name,ownerId,members,createdAt) VALUES(?,?,?,?,?)'
  )
  const delGroups = db.prepare('DELETE FROM groups')
  const allMsgs = db.prepare('SELECT * FROM messages ORDER BY id ASC')
  const insMsg = db.prepare(
    `INSERT INTO messages(convId,ts,fromId,fromName,fromAvatar,kind,text,sticker,fileId,fileJson,mine,receiving,sending)
     VALUES(@convId,@ts,@fromId,@fromName,@fromAvatar,@kind,@text,@sticker,@fileId,@fileJson,@mine,@receiving,@sending)`
  )
  const countMsg = db.prepare(
    'SELECT COUNT(*) AS c FROM messages WHERE convId=?'
  )
  const delMsg = db.prepare(
    'DELETE FROM messages WHERE convId=? AND id IN (SELECT id FROM messages WHERE convId=? ORDER BY id ASC LIMIT ?)'
  )
  const updMsg = db.prepare(
    'UPDATE messages SET fileJson=?, receiving=? WHERE convId=? AND fileId=?'
  )

  return {
    load() {
      const sRow = getSettings.get('settings')
      const settings = sRow ? safeParse(sRow.value, {}) : {}
      const groups = allGroups.all().map((r) => ({
        id: r.id,
        name: r.name,
        ownerId: r.ownerId,
        members: safeParse(r.members, [])
      }))
      const messages = {}
      for (const r of allMsgs.all()) {
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
      setSettings.run('settings', JSON.stringify(obj || {}))
    },
    replaceGroups(groups) {
      const tx = db.transaction((gs) => {
        delGroups.run()
        for (const g of gs) {
          insGroup.run(
            g.id,
            g.name,
            g.ownerId,
            JSON.stringify(g.members || []),
            g.createdAt || Date.now()
          )
        }
      })
      tx(groups || [])
    },
    appendMessage(m) {
      insMsg.run({
        convId: m.convId,
        ts: m.ts || Date.now(),
        fromId: m.from || '',
        fromName: m.fromName || '',
        fromAvatar: m.fromAvatar || '',
        kind: m.kind || 'text',
        text: m.text || null,
        sticker: m.sticker || null,
        fileId: m.fileId || null,
        fileJson: m.file ? JSON.stringify(m.file) : null,
        mine: m.mine ? 1 : 0,
        receiving: m.receiving ? 1 : 0,
        sending: m.sending ? 1 : 0
      })
      // 单会话条数上限，超出删最旧
      const c = countMsg.get(m.convId).c
      if (c > MAX_PER_CONV) {
        delMsg.run(m.convId, m.convId, c - MAX_PER_CONV)
      }
    },
    updateMessage(p) {
      updMsg.run(
        JSON.stringify(p.file || null),
        p.receiving ? 1 : 0,
        p.convId,
        p.fileId
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
