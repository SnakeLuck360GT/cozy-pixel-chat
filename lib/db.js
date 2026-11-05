// SQLite through Node's built-in driver, so there's nothing to compile on
// the server. Chat writes a row for every message, read marker and reaction,
// which a JSON file can't keep up with.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',      -- owner, admin or member
  avatar TEXT,                              -- key of an attachments row
  prefs TEXT NOT NULL DEFAULT '{}',         -- theme, font, sounds
  created INTEGER NOT NULL,
  last_seen INTEGER,
  invited_by TEXT,
  signup_ip TEXT,
  terms_version TEXT,
  terms_at INTEGER,
  terms_ip TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  expires INTEGER,
  uses_left INTEGER NOT NULL,
  used_by TEXT NOT NULL DEFAULT '[]'
);

-- kind is 'dm' (exactly two people, one per pair), 'group', or 'server'
-- (like a group, with a picture and an invite link anyone can join with).
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL,
  dm_key TEXT UNIQUE,
  created INTEGER NOT NULL,
  created_by INTEGER,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined INTEGER NOT NULL,
  last_read INTEGER NOT NULL DEFAULT 0,     -- id of the newest message they've seen
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

-- kind is 'text', 'system' (theme changes, people joining) or 'call'.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '',
  reply_to INTEGER,
  meta TEXT,
  created INTEGER NOT NULL,
  edited INTEGER,
  deleted INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);

-- Uploaded before the message is sent, so message_id is empty until then.
-- Avatars use kind 'avatar' and never get a message.
CREATE TABLE IF NOT EXISTS attachments (
  key TEXT PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- image, video, audio, voice, file, avatar
  meta TEXT,
  ip TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);

-- One reaction per person per message, like Instagram.
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- Stickers people have uploaded, shared with everyone.
CREATE TABLE IF NOT EXISTS stickers (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,                        -- the attachments row with the image
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first release, for databases made before them.
const ADDED_COLUMNS = [
  ["messages", "pinned", "INTEGER"],
  ["messages", "pinned_by", "INTEGER"],
  ["conversations", "icon", "TEXT"],
  ["users", "bio", "TEXT NOT NULL DEFAULT ''"],
  ["users", "pronouns", "TEXT NOT NULL DEFAULT ''"],
  ["users", "status", "TEXT NOT NULL DEFAULT ''"],
  ["users", "banner", "TEXT"],
  ["users", "color", "TEXT NOT NULL DEFAULT ''"],
  ["users", "badges", "TEXT NOT NULL DEFAULT '[]'"],
  ["conversations", "invite", "TEXT"],
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  const statements = new Map();
  const prepare = (sql) => {
    let statement = statements.get(sql);
    if (!statement) statements.set(sql, (statement = db.prepare(sql)));
    return statement;
  };

  return {
    get: (sql, ...params) => prepare(sql).get(...params),
    all: (sql, ...params) => prepare(sql).all(...params),
    run(sql, ...params) {
      const { changes, lastInsertRowid } = prepare(sql).run(...params);
      return { changes: Number(changes), id: Number(lastInsertRowid) };
    },
    // Everything inside happens or nothing does.
    transaction(work) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => db.close(),
  };
}

// Removes an account and what only made sense with it: their messages and
// files, one-to-one chats with them, and groups left with nobody in them.
// Returns the file keys to delete from disk and the chats that went.
export function deleteUser(db, userId) {
  return db.transaction(() => {
    const dms = db.all(
      "SELECT c.id FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE c.kind = 'dm' AND m.user_id = ?",
      userId,
    ).map((r) => r.id);
    db.run("DELETE FROM members WHERE user_id = ?", userId);
    const emptied = db.all(
      "SELECT id FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id)",
    ).map((r) => r.id);
    const gone = JSON.stringify([...new Set([...dms, ...emptied])]);
    const keys = db.all(
      `SELECT key FROM attachments WHERE user_id = ?
         OR message_id IN (SELECT id FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)))`,
      userId, gone,
    ).map((r) => r.key);
    db.run("DELETE FROM attachments WHERE key IN (SELECT value FROM json_each(?))", JSON.stringify(keys));
    db.run("DELETE FROM conversations WHERE id IN (SELECT value FROM json_each(?))", gone);
    db.run("DELETE FROM messages WHERE user_id = ?", userId);
    db.run("DELETE FROM stickers WHERE user_id = ?", userId);
    db.run("DELETE FROM users WHERE id = ?", userId);
    return { keys, conversations: JSON.parse(gone) };
  });
}
