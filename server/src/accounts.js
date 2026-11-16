/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Personal accounts & sessions. This is NOT the main project's admin RSA
 * channel — it is a normal username/password account system for room owners.
 * Passwords are salted + scrypt hashed; sessions are random 32-byte sids in
 * an HttpOnly + Secure + SameSite=Lax cookie, with a 7-day TTL.
 */
const nodeCrypto = require('crypto');
const P = require('./protocol');
const { config } = require('./paths');

const SCRYPT_KEYLEN = 64;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;

function hashPassword(password, salt) {
  return nodeCrypto.scryptSync(String(password), Buffer.from(salt, 'hex'), SCRYPT_KEYLEN).toString('hex');
}

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return nodeCrypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}

class Accounts {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger || (() => {});
    this.failures = new Map(); // key -> {count, firstAt}
  }

  validateUsername(username) {
    const u = String(username || '').trim();
    if (u.length < 3 || u.length > 32) return '用户名长度须为 3–32 字符';
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(u)) return '用户名仅支持字母、数字、下划线、连字符与中文';
    return null;
  }

  validatePassword(password) {
    const p = String(password || '');
    if (p.length < 8 || p.length > 128) return '口令长度须为 8–128 字符';
    return null;
  }

  register(username, password) {
    const name = String(username || '').trim();
    let err = this.validateUsername(name) || this.validatePassword(password);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    if (this.db.userByUsername(name)) throw Object.assign(new Error('用户名已存在'), { status: 409 });
    const salt = nodeCrypto.randomBytes(16).toString('hex');
    const id = 'u_' + nodeCrypto.randomBytes(12).toString('hex');
    this.db.createUser({
      id, username: name, salt,
      passwordHash: hashPassword(password, salt),
      quotaRooms: config.maxRoomsPerUser || P.LIMITS.QUOTA_ROOMS_PER_USER,
      createdAt: Date.now()
    });
    this.logger('新用户注册: ' + name);
    return { id, username: name };
  }

  loginKey(ip, username) { return (ip || '') + '|' + String(username || '').toLowerCase(); }

  login(ip, username, password) {
    const key = this.loginKey(ip, username);
    const now = Date.now();
    const rec = this.failures.get(key);
    if (rec && now - rec.firstAt < LOGIN_WINDOW_MS && rec.count >= LOGIN_MAX_FAILS) {
      throw Object.assign(new Error('登录失败次数过多，请 10 分钟后再试'), { status: 429 });
    }
    const user = this.db.userByUsername(username);
    const ok = user && timingSafeEqualHex(user.password_hash, hashPassword(password, user.salt));
    if (!ok) {
      const f = this.failures.get(key) || { count: 0, firstAt: now };
      if (now - f.firstAt >= LOGIN_WINDOW_MS) { f.count = 0; f.firstAt = now; }
      f.count++;
      this.failures.set(key, f);
      throw Object.assign(new Error('用户名或口令错误'), { status: 401 });
    }
    this.failures.delete(key);
    const sid = nodeCrypto.randomBytes(32).toString('hex');
    const expiresAt = now + P.LIMITS.SESSION_TTL_SECONDS * 1000;
    this.db.createSession(sid, user.id, expiresAt);
    return { sid, expiresAt, user: { id: user.id, username: user.username, quota: user.quota_rooms } };
  }

  sessionUser(sid) {
    if (!sid) return null;
    const s = this.db.session(sid);
    if (!s) return null;
    if (s.expires_at <= Date.now()) { this.db.deleteSession(sid); return null; }
    return this.db.userById(s.user_id);
  }

  logout(sid) { if (sid) this.db.deleteSession(sid); }

  /* Count a user's non-destroyed rooms for quota enforcement. */
  activeRoomCount(userId) {
    return this.db.all("SELECT COUNT(*) AS n FROM rooms WHERE owner_id=? AND status IN ('issued','active')", [userId])
      .map(r => r.n)[0] || 0;
  }
}

module.exports = { Accounts, hashPassword };
