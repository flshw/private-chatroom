/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Embedded sql.js database. Every messages/files row holds ciphertext only —
 * the server has no key that could decrypt application content. Sensitive
 * credential material (joinToken plaintext, private keys, content keys) is
 * never written here: only HMAC digests and public keys live in the columns.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { DATA_DIR, FILES_DIR } = require('./paths');

const DB_FILE = path.join(DATA_DIR, 'private-chat.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  quota_rooms INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  max_members INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  join_token_hash TEXT NOT NULL,
  config_digest TEXT NOT NULL,
  room_pub_key TEXT NOT NULL,
  room_priv_ref TEXT NOT NULL,
  sig_count INTEGER NOT NULL DEFAULT 1,
  revoke_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rooms_expiry ON rooms(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id, status);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender_session TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  tag TEXT NOT NULL,
  wraps_json TEXT NOT NULL,
  sender_pub TEXT NOT NULL,
  sig TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  tag TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_room ON files(room_id, expires_at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  room_id TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

class Database {
  constructor(logger) {
    this.db = null;
    this.logger = logger || (() => {});
    this.dirty = false;
    this.flushTimer = null;
  }

  async init() {
    const SQL = await initSqlJs({ locateFile: f => path.join(__dirname, '..', '..', 'vendor', f) });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(FILES_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      try { this.db = new SQL.Database(fs.readFileSync(DB_FILE)); }
      catch (e) { this.logger('数据库损坏，已重建: ' + e.message); this.db = new SQL.Database(); }
    } else {
      this.db = new SQL.Database();
    }
    this.db.run(SCHEMA);
    return this;
  }

  markDirty() {
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (!this.db || !this.dirty) return;
    const bytes = Buffer.from(this.db.export());
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
    this.dirty = false;
  }

  close() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
    if (this.db) this.db.close();
    this.db = null;
  }

  /* Run a statement with positional/named params. */
  run(sql, params) {
    this.db.run(sql, params || []);
    this.markDirty();
  }

  all(sql, params) {
    const res = this.db.exec(sql, params || []);
    if (!res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map(row => {
      const o = {};
      cols.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
  }

  get(sql, params) {
    const rows = this.all(sql, params);
    return rows[0] || null;
  }

  meta(k, v) {
    if (v === undefined) {
      const row = this.get('SELECT v FROM meta WHERE k=?', [k]);
      return row ? row.v : null;
    }
    this.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, String(v)]);
    return v;
  }

  /* ---------- typed accessors ---------- */
  userByUsername(username) { return this.get('SELECT * FROM users WHERE username=? COLLATE NOCASE', [username]); }
  userById(id) { return this.get('SELECT * FROM users WHERE id=?', [id]); }
  createUser(u) {
    this.run('INSERT INTO users(id,username,password_hash,salt,quota_rooms,created_at) VALUES(?,?,?,?,?,?)',
      [u.id, u.username, u.passwordHash, u.salt, u.quotaRooms, u.createdAt]);
  }
  createSession(sid, userId, expiresAt) {
    this.run('INSERT INTO sessions(sid,user_id,expires_at) VALUES(?,?,?)', [sid, userId, expiresAt]);
  }
  session(sid) { return this.get('SELECT * FROM sessions WHERE sid=?', [sid]); }
  deleteSession(sid) { this.run('DELETE FROM sessions WHERE sid=?', [sid]); }
  purgeSessions(now) { this.run('DELETE FROM sessions WHERE expires_at<=?', [now]); }

  room(id) { return this.get('SELECT * FROM rooms WHERE id=?', [id]); }
  roomsByOwner(ownerId) { return this.all('SELECT * FROM rooms WHERE owner_id=? ORDER BY created_at DESC', [ownerId]); }
  activeRooms() { return this.all("SELECT * FROM rooms WHERE status IN ('issued','active')"); }
  roomsNeedingCleanup(now) {
    return this.all("SELECT * FROM rooms WHERE status IN ('issued','active','destroying') AND expires_at<=?", [now]);
  }
  createRoom(r) {
    this.run(`INSERT INTO rooms(id,owner_id,name,status,ttl_seconds,max_members,created_at,issued_at,expires_at,
      join_token_hash,config_digest,room_pub_key,room_priv_ref,sig_count)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.ownerId, r.name, r.status, r.ttlSeconds, r.maxMembers, r.createdAt, r.issuedAt, r.expiresAt,
        r.joinTokenHash, r.configDigest, r.roomPubKey, r.roomPrivRef, r.sigCount || 1]);
  }
  setRoomStatus(id, status) { this.run('UPDATE rooms SET status=? WHERE id=?', [status, id]); }
  revokeRoom(id, at) { this.run('UPDATE rooms SET revoke_at=?, status=? WHERE id=?', [at, 'revoked', id]); }
  reissueRoom(id, patch) {
    this.run(`UPDATE rooms SET join_token_hash=?, config_digest=?, room_pub_key=?, room_priv_ref=?,
      sig_count=sig_count+1, issued_at=?, expires_at=?, status='issued', revoke_at=NULL WHERE id=?`,
      [patch.joinTokenHash, patch.configDigest, patch.roomPubKey, patch.roomPrivRef,
        patch.issuedAt, patch.expiresAt, id]);
  }

  addMessage(m) {
    this.run(`INSERT INTO messages(room_id,seq,sender_session,ts,kind,iv,ct,tag,wraps_json,sender_pub,sig,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.roomId, m.seq, m.senderSession, m.ts, m.kind, m.iv, m.ct, m.tag,
        m.wrapsJson, m.senderPub, m.sig, m.expiresAt]);
  }
  nextSeq(roomId) {
    const row = this.get('SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE room_id=?', [roomId]);
    return row ? row.n : 1;
  }
  messagesSince(roomId, seq, expiresAt) {
    return this.all('SELECT * FROM messages WHERE room_id=? AND seq>? AND expires_at>? ORDER BY seq LIMIT 200',
      [roomId, seq, expiresAt]);
  }

  addFile(f) {
    this.run('INSERT INTO files(id,room_id,size,iv,ct,tag,blob_path,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      [f.id, f.roomId, f.size, f.iv, f.ct, f.tag, f.blobPath, f.expiresAt]);
  }
  file(id) { return this.get('SELECT * FROM files WHERE id=?', [id]); }

  audit(event, roomId, ts) {
    this.run('INSERT INTO audit(event,room_id,ts) VALUES(?,?,?)', [event, roomId || null, ts || Date.now()]);
  }

  /* Full cascade delete of a room's content + ciphertext. */
  destroyRoom(id) {
    const files = this.all('SELECT blob_path FROM files WHERE room_id=?', [id]);
    for (const f of files) {
      try { if (f.blob_path && fs.existsSync(f.blob_path)) fs.unlinkSync(f.blob_path); }
      catch (e) { this.logger('删除文件失败: ' + e.message); }
    }
    this.run('DELETE FROM files WHERE room_id=?', [id]);
    this.run('DELETE FROM messages WHERE room_id=?', [id]);
    this.run('DELETE FROM rooms WHERE id=?', [id]);
  }
}

module.exports = { Database, DB_FILE };
