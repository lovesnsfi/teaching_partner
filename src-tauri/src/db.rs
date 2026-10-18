// 本地持久化（SQLite via rusqlite）：群 / 消息 / 联系人。
// 复刻自 electron/persist.js 的表结构与读写逻辑（设置项仍走前端的 plugin-store）。
// 用阻塞式 rusqlite，Connection 包在 Mutex 里经 Tauri State 共享。

use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::{json, Map, Value};
use tauri::State;

const MAX_PER_CONV: i64 = 400;

pub struct DbState {
    pub conn: Mutex<Connection>,
}

fn ddl() -> &'static [&'static str] {
    &[
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)",
        "CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, ownerId TEXT, members TEXT, createdAt INTEGER)",
        "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, convId TEXT NOT NULL, ts INTEGER, fromId TEXT, fromName TEXT, fromAvatar TEXT, kind TEXT, text TEXT, sticker TEXT, fileId TEXT, fileJson TEXT, mine INTEGER, receiving INTEGER, sending INTEGER)",
        "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(convId)",
        "CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, ip TEXT, port INTEGER, role TEXT, host TEXT, firstSeen INTEGER, lastOnline INTEGER)",
    ]
}

pub fn open(db_path: &std::path::Path) -> Result<DbState, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    for sql in ddl() {
        conn.execute(sql, [])?;
    }
    Ok(DbState {
        conn: Mutex::new(conn),
    })
}

// ---- 读取辅助 ----
fn vstr(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|s| s.to_string())
}
fn vbool(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
fn vnum(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64())
}

// 消息行 -> 前端消息对象（对齐 persist.js load 的形状；文件类消息重启后视为已完成）
fn row_to_msg(
    conv_id: &str,
    ts: i64,
    from_id: &str,
    from_name: &str,
    from_avatar: &str,
    kind: &str,
    text: &str,
    sticker: &str,
    file_id: &str,
    file_json: &str,
    mine: bool,
    receiving: bool,
    sending: bool,
) -> Value {
    let mut m = Map::new();
    m.insert("convId".into(), json!(conv_id));
    m.insert("from".into(), json!(from_id));
    m.insert("fromName".into(), json!(from_name));
    m.insert("fromAvatar".into(), json!(from_avatar));
    m.insert("ts".into(), json!(ts));
    m.insert("kind".into(), json!(kind));
    if !text.is_empty() {
        m.insert("text".into(), json!(text));
    }
    if !sticker.is_empty() {
        m.insert("sticker".into(), json!(sticker));
    }
    if !file_id.is_empty() {
        m.insert("fileId".into(), json!(file_id));
    }
    if !file_json.is_empty() {
        if let Ok(f) = serde_json::from_str::<Value>(file_json) {
            m.insert("file".into(), f);
        }
    }
    // 文件类消息重启后清理中间态
    let (mut receiving, mut sending) = (receiving, sending);
    if kind == "file" {
        receiving = false;
        sending = false;
    }
    m.insert("mine".into(), json!(mine));
    m.insert("receiving".into(), json!(receiving));
    m.insert("sending".into(), json!(sending));
    Value::Object(m)
}

#[tauri::command]
pub fn db_load_domain(db: State<'_, DbState>) -> Value {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return json!({ "groups": [], "messages": {}, "contacts": [] }),
    };

    // groups
    let mut groups: Vec<Value> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, ownerId, members, createdAt FROM groups",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        }) {
            for g in rows.flatten() {
                let members: Value =
                    serde_json::from_str::<Value>(&g.3).unwrap_or_else(|_| json!([]));
                groups.push(json!({
                    "id": g.0,
                    "name": g.1,
                    "ownerId": g.2,
                    "members": members,
                    "createdAt": g.4,
                }));
            }
        }
    }

    // messages（按会话分组，按 id 升序）
    let mut messages: Map<String, Value> = Map::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT convId, ts, fromId, fromName, fromAvatar, kind, text, sticker, fileId, fileJson, mine, receiving, sending FROM messages ORDER BY id ASC",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, i64>(11)?,
                r.get::<_, i64>(12)?,
            ))
        }) {
            for row in rows.flatten() {
                let msg = row_to_msg(
                    &row.0,
                    row.1,
                    &row.2,
                    row.3.as_deref().unwrap_or(""),
                    row.4.as_deref().unwrap_or(""),
                    row.5.as_deref().unwrap_or("text"),
                    row.6.as_deref().unwrap_or(""),
                    row.7.as_deref().unwrap_or(""),
                    row.8.as_deref().unwrap_or(""),
                    row.9.as_deref().unwrap_or(""),
                    row.10 != 0,
                    row.11 != 0,
                    row.12 != 0,
                );
                messages
                    .entry(row.0.clone())
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .map(|a| a.push(msg));
            }
        }
    }

    // contacts
    let mut contacts: Vec<Value> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, avatar, ip, port, role, host, firstSeen, lastOnline FROM contacts",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
            ))
        }) {
            for c in rows.flatten() {
                contacts.push(json!({
                    "id": c.0,
                    "name": c.1.unwrap_or_default(),
                    "avatar": c.2.unwrap_or_default(),
                    "ip": c.3.unwrap_or_default(),
                    "port": c.4,
                    "role": c.5.unwrap_or_else(|| "user".into()),
                    "host": c.6.unwrap_or_default(),
                    "firstSeen": c.7,
                    "lastOnline": c.8,
                }));
            }
        }
    }

    json!({ "groups": groups, "messages": messages, "contacts": contacts })
}

#[tauri::command]
pub fn db_replace_groups(db: State<'_, DbState>, groups: Value) -> bool {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let _ = conn.execute("BEGIN", []);
    let _ = conn.execute("DELETE FROM groups", []);
    if let Some(arr) = groups.as_array() {
        for g in arr {
            let members = g
                .get("members")
                .map(|m| m.to_string())
                .unwrap_or_else(|| "[]".to_string());
            let _ = conn.execute(
                "INSERT OR REPLACE INTO groups(id, name, ownerId, members, createdAt) VALUES (?, ?, ?, ?, ?)",
                rusqlite::params![
                    vstr(g, "id").unwrap_or_default(),
                    vstr(g, "name").unwrap_or_default(),
                    vstr(g, "ownerId").unwrap_or_default(),
                    members,
                    vnum(g, "createdAt").unwrap_or_else(|| now_ms()),
                ],
            );
        }
    }
    let _ = conn.execute("COMMIT", []);
    true
}

#[tauri::command]
pub fn db_replace_contacts(db: State<'_, DbState>, list: Value) -> bool {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let _ = conn.execute("BEGIN", []);
    let _ = conn.execute("DELETE FROM contacts", []);
    if let Some(arr) = list.as_array() {
        for c in arr {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO contacts(id, name, avatar, ip, port, role, host, firstSeen, lastOnline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    vstr(c, "id").unwrap_or_default(),
                    vstr(c, "name").unwrap_or_default(),
                    vstr(c, "avatar").unwrap_or_default(),
                    vstr(c, "ip").unwrap_or_default(),
                    vnum(c, "port").unwrap_or(0),
                    vstr(c, "role").unwrap_or_else(|| "user".into()),
                    vstr(c, "host").unwrap_or_default(),
                    vnum(c, "firstSeen").unwrap_or_else(|| now_ms()),
                    vnum(c, "lastOnline").unwrap_or_else(|| now_ms()),
                ],
            );
        }
    }
    let _ = conn.execute("COMMIT", []);
    true
}

#[tauri::command]
pub fn db_append_message(db: State<'_, DbState>, m: Value) -> bool {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let file_json = m.get("file").map(|f| f.to_string()).unwrap_or_default();
    let res = conn.execute(
        "INSERT INTO messages(convId, ts, fromId, fromName, fromAvatar, kind, text, sticker, fileId, fileJson, mine, receiving, sending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            vstr(&m, "convId").unwrap_or_default(),
            vnum(&m, "ts").unwrap_or_else(|| now_ms()),
            vstr(&m, "from").unwrap_or_default(),
            vstr(&m, "fromName").unwrap_or_default(),
            vstr(&m, "fromAvatar").unwrap_or_default(),
            vstr(&m, "kind").unwrap_or_else(|| "text".into()),
            vstr(&m, "text").unwrap_or_default(),
            vstr(&m, "sticker").unwrap_or_default(),
            vstr(&m, "fileId").unwrap_or_default(),
            file_json,
            if vbool(&m, "mine") { 1 } else { 0 },
            if vbool(&m, "receiving") { 1 } else { 0 },
            if vbool(&m, "sending") { 1 } else { 0 },
        ],
    );
    if res.is_err() {
        return false;
    }
    // 单会话条数上限：超出删最旧
    let conv = vstr(&m, "convId").unwrap_or_default();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE convId = ?",
            rusqlite::params![conv],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if count > MAX_PER_CONV {
        let _ = conn.execute(
            "DELETE FROM messages WHERE convId = ? AND id IN (SELECT id FROM messages WHERE convId = ? ORDER BY id ASC LIMIT ?)",
            rusqlite::params![conv, conv, count - MAX_PER_CONV],
        );
    }
    true
}

#[tauri::command]
pub fn db_update_message(db: State<'_, DbState>, p: Value) -> bool {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let file_json = p.get("file").map(|f| f.to_string()).unwrap_or_else(|| "null".into());
    let receiving = if vbool(&p, "receiving") { 1 } else { 0 };
    let res = conn.execute(
        "UPDATE messages SET fileJson = ?, receiving = ? WHERE convId = ? AND fileId = ?",
        rusqlite::params![
            file_json,
            receiving,
            vstr(&p, "convId").unwrap_or_default(),
            vstr(&p, "fileId").unwrap_or_default(),
        ],
    );
    res.is_ok()
}

#[tauri::command]
pub fn db_delete_messages(db: State<'_, DbState>, conv_id: String) -> i64 {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return 0,
    };
    conn.execute(
        "DELETE FROM messages WHERE convId = ?",
        rusqlite::params![conv_id],
    )
    .map(|n| n as i64)
    .unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
