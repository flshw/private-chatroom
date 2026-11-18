/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Admin console authentication — deliberately separate from chat accounts.
 *
 * - One operator credential: scrypt-salted password, hash-only on disk.
 * - Optional high-entropy login key (sha256 hash-only on disk), downloadable
 *   once; later used instead of the password.
 * - HttpOnly / SameSite=Strict session cookies, persisted so a service restart
 *   does not kick the operator out.
 * - Per-IP failure throttling for both password and key login.
 *
 * The stored file lives in DATA_DIR (never in git, never in the chat DB).
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { DATA_DIR } = require('./paths');

const AUTH_FILE = path.join(DATA_DIR, 'admin-auth.json');
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const KEY_PREFIX = 'pcadm_';

function scryptHash(password, saltHex) {
  return nodeCrypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex');
}
function sha256(s) { return nodeCrypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEq(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return ba.length === bb.length && nodeCrypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}
function randomHex(n) { return nodeCrypto.randomBytes(n).toString('hex'); }

class AdminAuth {
  constructor(logger) {
    this.logger = logger || (() => {});
    this.state = null;
    this.failures = new Map();  // key -> {count, firstAt}
    this.flushTimer = null;
  }

  init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(AUTH_FILE)) {
      try {
        this.state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      } catch (e) {
        const bak = AUTH_FILE + '.corrupt-' + Date.now();
        try { fs.copyFileSync(AUTH_FILE, bak); } catch (_) {}
        this.logger('⚠ 管理员凭证文件损坏，已备份并重置: ' + e.message);
        this.state = null;
      }
    }
    if (!this.state || !this.state.password || !this.state.password.salt || !this.state.password.hash) {
      // FIRST RUN: adopt PC_ADMIN_INITIAL_PASSWORD (operator-supplied) or mint a
      // random one and stash it in a root-readable file for the operator.
      const fromEnv = process.env.PC_ADMIN_INITIAL_PASSWORD || '';
      const initial = fromEnv || (KEY_PREFIX.slice(0, 2) + randomHex(12));
      const salt = randomHex(16);
      this.state = {
        v: 1,
        password: { salt, hash: scryptHash(initial, salt) },
        keyHash: null,
        mustChange: true,
        createdAt: Date.now(),
        changedAt: null,
        sessions: {}
      };
      this.flush();
      if (!fromEnv) {
        const initFile = path.join(DATA_DIR, 'admin-initial-password.txt');
        fs.writeFileSync(initFile, initial + '\n', { mode: 0o600 });
        this.logger('管理员初始口令已生成: ' + initFile);
      } else {
        this.logger('管理员初始口令已从环境变量初始化');
      }
      this.logger('管理员控制台已启用，首次登录须修改口令');
    }
    if (!this.state.sessions) this.state.sessions = {};
    this._purgeSessions();
    return this;
  }

  flush() {
    if (!this.state) return;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const tmp = AUTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE);
  }
  close() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flush();
  }
  _touch() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 200);
  }
  _purgeSessions() {
    const now = Date.now();
    let changed = false;
    for (const sid of Object.keys(this.state.sessions)) {
      if (this.state.sessions[sid] <= now) { delete this.state.sessions[sid]; changed = true; }
    }
    if (changed) this._touch();
  }

  _failKey(ip, method) { return String(ip || '') + '|' + method; }
  _checkThrottle(ip, method) {
    const key = this._failKey(ip, method);
    const rec = this.failures.get(key);
    const now = Date.now();
    if (rec && now - rec.firstAt < FAIL_WINDOW_MS && rec.count >= MAX_FAILS) {
      const err = new Error('失败次数过多，请 10 分钟后再试'); err.status = 429; throw err;
    }
    if (rec && now - rec.firstAt >= FAIL_WINDOW_MS) this.failures.delete(key);
  }
  _recordFail(ip, method) {
    const key = this._failKey(ip, method);
    const now = Date.now();
    const rec = this.failures.get(key) || { count: 0, firstAt: now };
    if (now - rec.firstAt >= FAIL_WINDOW_MS) { rec.count = 0; rec.firstAt = now; }
    rec.count++;
    this.failures.set(key, rec);
  }
  _clearFail(ip, method) { this.failures.delete(this._failKey(ip, method)); }

  /* --- password --- */
  loginPassword(ip, password) {
    this._checkThrottle(ip, 'password');
    const ok = safeEq(scryptHash(password, this.state.password.salt), this.state.password.hash);
    if (!ok) {
      this._recordFail(ip, 'password');
      const err = new Error('口令错误'); err.status = 401; throw err;
    }
    this._clearFail(ip, 'password');
    return this._issueSession();
  }

  changePassword(oldPassword, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) {
      const err = new Error('新口令长度须为 10–128 字符'); err.status = 400; throw err;
    }
    if (!safeEq(scryptHash(oldPassword, this.state.password.salt), this.state.password.hash)) {
      const err = new Error('当前口令错误'); err.status = 401; throw err;
    }
    const salt = randomHex(16);
    this.state.password = { salt, hash: scryptHash(newPassword, salt) };
    this.state.mustChange = false;
    this.state.changedAt = Date.now();
    this._touch();
    this.logger('管理员口令已修改');
    return { ok: true };
  }

  /* --- login key --- */
  hasKey() { return !!this.state.keyHash; }

  /* Generate a fresh key; the plaintext is returned ONCE and the old key is
   * invalidated immediately. */
  createKey() {
    const key = KEY_PREFIX + nodeCrypto.randomBytes(32).toString('base64url');
    this.state.keyHash = sha256(key);
    this._touch();
    this.logger('管理员登录密钥已重新生成，旧密钥已作废');
    return key;
  }

  loginKey(ip, key) {
    this._checkThrottle(ip, 'key');
    const ok = this.state.keyHash && safeEq(sha256(key), this.state.keyHash);
    if (!ok) {
      this._recordFail(ip, 'key');
      const err = new Error('登录密钥无效'); err.status = 401; throw err;
    }
    this._clearFail(ip, 'key');
    // Key login implies the operator already completed first-run setup.
    if (this.state.mustChange) { this.state.mustChange = false; this._touch(); }
    return this._issueSession();
  }

  revokeKey() { this.state.keyHash = null; this._touch(); return { ok: true }; }

  /* --- sessions --- */
  _issueSession() {
    const sid = randomHex(32);
    this.state.sessions[sid] = Date.now() + SESSION_TTL_MS;
    this._touch();
    return { sid, expiresAt: this.state.sessions[sid] };
  }
  session(sid) {
    if (!sid) return null;
    this._purgeSessions();
    const exp = this.state.sessions[sid];
    if (!exp || exp <= Date.now()) return null;
    return { sid, expiresAt: exp };
  }
  logout(sid) {
    if (sid && this.state.sessions[sid]) { delete this.state.sessions[sid]; this._touch(); }
    return { ok: true };
  }
  logoutAll() { this.state.sessions = {}; this._touch(); return { ok: true }; }

  /* --- status snapshot (never leaks hashes or plaintext) --- */
  status() {
    return {
      ok: true,
      mustChange: !!this.state.mustChange,
      hasKey: this.hasKey(),
      changedAt: this.state.changedAt,
      sessionCount: Object.keys(this.state.sessions).length
    };
  }
}

module.exports = { AdminAuth, AUTH_FILE, SESSION_TTL_MS };
