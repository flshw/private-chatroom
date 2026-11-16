/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * HTTP control-plane + static hosting. All endpoints under /pc/api/*.
 * CORS is open by design but `Origin: null` is not trusted: joinToken is the
 * sole admission credential. File endpoints carry ciphertext only.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('./protocol');
const { PUBLIC_DIR, ADMIN_DIR, config } = require('./paths');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-PC-SID',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, CORS));
  res.end(body);
}
function sendText(res, status, text, type, extra) {
  const body = Buffer.from(String(text));
  res.writeHead(status, Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, CORS, extra || {}));
  res.end(body);
}
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, '404 Not Found: ' + path.basename(file));
    const ext = path.extname(file).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    res.writeHead(200, Object.assign({
      'Content-Type': types[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    }, CORS));
    res.end(buf);
  });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > P.LIMITS.MAX_FRAME_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function redirect(res, location) {
  res.writeHead(301, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function makeServer(handler) {
  if (config.tlsCert && config.tlsKey && fs.existsSync(config.tlsCert) && fs.existsSync(config.tlsKey)) {
    try {
      return https.createServer({
        cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey)
      }, handler);
    } catch (e) { console.error('[pc] TLS 加载失败，回退 HTTP: ' + e.message); }
  }
  return http.createServer(handler);
}

function createHttpServer(options) {
  const { accounts, rooms, hub, db, keyStore, logger } = options;
  const API = config.apiPrefix;
  const PUB = config.publicPrefix;
  const server = makeServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch (e) { pathname = String(req.url || '/').split('?')[0]; }
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    /* ---- static portal / online client entry ---- */
    if (pathname === '/' || pathname === PUB || pathname === PUB + '/' || pathname === '/Pchat/index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === PUB + '/admin' || pathname === PUB + '/admin/') {
      return sendFile(res, path.join(ADMIN_DIR, 'index.html'));
    }
    /* Online HTTPS entry for a room: serves the same baked client template.
     * A real issued client is downloaded at /pc/api/rooms/:id/client; this
     * route is a convenience for the `roomUrl` baked into config. */
    const onlineMatch = pathname.match(new RegExp('^' + PUB + '/p/([A-Za-z0-9_]+)/?$'));
    if (onlineMatch) {
      const roomId = onlineMatch[1];
      const token = url.searchParams.get('t') || '';
      // Serve a freshly issued client only if the requester proves admission.
      // Without a valid token, return the portal with a hint instead of the client.
      const room = db.room(roomId);
      if (!room) return sendText(res, 404, '房间不存在或已销毁');
      if (token) return sendFile(res, require('./paths').TEMPLATE_FILE);
      return sendText(res, 200,
        '<!doctype html><meta charset="utf-8"><title>私密聊天</title><h2>请使用下载好的专属客户端进入房间</h2>' +
        '<p>在线入口需要访问凭证。请向发起人索取专属 HTML 文件，双击打开后即可进入。</p>',
        'text/html; charset=utf-8');
    }

    /* ---- health ---- */
    if (pathname === API + '/health') {
      const s = hub.stats();
      const due = db.all("SELECT COUNT(*) AS n FROM rooms WHERE status IN ('issued','active') AND expires_at<=?", [Date.now()]);
      return sendJson(res, 200, {
        ok: true, pcVersion: P.PC_RELEASE_VERSION, protocol: P.PROTOCOL_VERSION,
        rooms: s.rooms, clients: s.clients, pendingCleanup: due[0] ? due[0].n : 0,
        ts: Date.now()
      });
    }

    /* ---- auth ---- */
    if (pathname === API + '/auth/register' && req.method === 'POST') {
      try {
        const b = await readJson(req);
        const user = accounts.register(b.username, b.password);
        return sendJson(res, 200, { ok: true, user });
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    if (pathname === API + '/auth/login' && req.method === 'POST') {
      try {
        const b = await readJson(req);
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
        const sess = accounts.login(ip, b.username, b.password);
        // HttpOnly + SameSite=Lax cookie; Secure only when served over HTTPS.
        const secure = config.tlsCert ? '; Secure' : '';
        const maxAge = P.LIMITS.SESSION_TTL_SECONDS;
        res.setHeader('Set-Cookie',
          'pc_sid=' + sess.sid + '; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=' + maxAge);
        return sendJson(res, 200, Object.assign({ ok: true }, sess));
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    if (pathname === API + '/auth/logout' && req.method === 'POST') {
      accounts.logout(sidOf(req, url));
      res.setHeader('Set-Cookie', 'pc_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }

    /* ---- session helper for owner-only endpoints ---- */
    const requireUser = () => accounts.sessionUser(sidOf(req, url));

    /* ---- rooms ---- */
    if (pathname === API + '/rooms' && req.method === 'GET') {
      const user = requireUser();
      if (!user) return sendJson(res, 401, { ok: false, error: '需要登录' });
      return sendJson(res, 200, { ok: true, rooms: rooms.listByOwner(user.id) });
    }
    if (pathname === API + '/rooms/apply' && req.method === 'POST') {
      const user = requireUser();
      if (!user) return sendJson(res, 401, { ok: false, error: '需要登录' });
      try {
        const b = await readJson(req);
        const built = rooms.apply(user, b);
        res.writeHead(200, Object.assign({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + built.filename + '"',
          'Cache-Control': 'no-store, private'
        }, CORS));
        return res.end(built.html);
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    let m;
    m = pathname.match(new RegExp('^' + API + '/rooms/([A-Za-z0-9_]+)/client$'));
    if (m && req.method === 'GET') {
      const user = requireUser();
      if (!user) return sendJson(res, 401, { ok: false, error: '需要登录' });
      try {
        const built = rooms.issueClient(user, m[1]);
        res.writeHead(200, Object.assign({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + built.filename + '"',
          'Cache-Control': 'no-store, private'
        }, CORS));
        return res.end(built.html);
      } catch (e) {
        logger('重新签发失败: ' + require('util').inspect(e, { depth: 3 }));
        return sendJson(res, e.status || 400, { ok: false, error: e.message });
      }
    }
    m = pathname.match(new RegExp('^' + API + '/rooms/([A-Za-z0-9_]+)/(dissolve|revoke)$'));
    if (m && req.method === 'POST') {
      const user = requireUser();
      if (!user) return sendJson(res, 401, { ok: false, error: '需要登录' });
      try {
        const result = m[2] === 'dissolve' ? rooms.dissolve(user, m[1]) : rooms.revoke(user, m[1]);
        return sendJson(res, 200, Object.assign({ ok: true }, result));
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    m = pathname.match(new RegExp('^' + API + '/room/([A-Za-z0-9_]+)/status$'));
    if (m && req.method === 'GET') return sendJson(res, 200, rooms.status(m[1]));

    /* ---- encrypted file transfer (ciphertext only) ---- */
    if (pathname === API + '/file/upload' && req.method === 'POST') {
      try {
        const b = await readJson(req);
        const roomId = String(b.roomId || '');
        const sid = String(b.sid || '');
        const s = findSession(hub, roomId, sid);
        if (!s) return sendJson(res, 403, { ok: false, error: '会话无效' });
        const room = db.room(roomId);
        if (!room || room.expires_at <= Date.now()) return sendJson(res, 403, { ok: false, error: '房间无效' });
        const iv = String(b.iv || ''), ct = String(b.ct || ''), tag = String(b.tag || '');
        const bytes = Buffer.from(ct, 'base64');
        if (bytes.length > P.LIMITS.MAX_FILE_BYTES) return sendJson(res, 413, { ok: false, error: '文件过大' });
        const id = 'f_' + nodeCrypto.randomBytes(12).toString('hex');
        const blobPath = path.join(require('./paths').FILES_DIR, id + '.bin');
        fs.writeFileSync(blobPath, bytes, { mode: 0o600 });
        db.addFile({ id, roomId, size: bytes.length, iv, ct, tag, blobPath, expiresAt: room.expires_at });
        return sendJson(res, 200, { ok: true, fileId: id });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (pathname === API + '/file/get' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const roomId = url.searchParams.get('room') || '';
      const sid = url.searchParams.get('sid') || '';
      if (!findSession(hub, roomId, sid)) return sendJson(res, 403, { ok: false, error: '会话无效' });
      const f = db.file(id);
      if (!f || f.room_id !== roomId) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      let ct = f.ct;
      if (!ct && f.blob_path && fs.existsSync(f.blob_path)) ct = fs.readFileSync(f.blob_path).toString('base64');
      return sendJson(res, 200, { ok: true, file: { id: f.id, size: f.size, iv: f.iv, ct, tag: f.tag } });
    }

    /* ---- admin (reserved; no approval queue by design) ---- */
    if (pathname === API + '/admin/rooms' && req.method === 'GET') {
      const token = req.headers['x-pc-admin-token'] || url.searchParams.get('adminToken') || '';
      if (!token || token !== (process.env.PC_ADMIN_TOKEN || '')) {
        return sendJson(res, 403, { ok: false, error: '无权操作' });
      }
      const now = Date.now();
      const rows = db.all("SELECT id,name,status,expires_at FROM rooms WHERE status!='destroyed' ORDER BY created_at DESC");
      return sendJson(res, 200, { ok: true, rooms: rows.map(r => ({
        roomId: r.id, name: r.name, status: r.status, expiresAt: r.expires_at,
        remainSeconds: Math.max(0, Math.floor((r.expires_at - now) / 1000))
      })) });
    }
    m = pathname.match(new RegExp('^' + API + '/admin/rooms/([A-Za-z0-9_]+)/destroy$'));
    if (m && req.method === 'POST') {
      // Controlled by an admin token header; local-only in v0.1 deployment.
      const token = req.headers['x-pc-admin-token'] || url.searchParams.get('adminToken') || '';
      if (!token || token !== (process.env.PC_ADMIN_TOKEN || '')) {
        return sendJson(res, 403, { ok: false, error: '无权操作' });
      }
      return sendJson(res, 200, Object.assign({ ok: true }, rooms.destroy(m[1], 'admin')));
    }

    return sendText(res, 404, '404 Not Found');
  });

  const wss = new WebSocketServer({ server, path: config.wsPath, maxPayload: P.LIMITS.MAX_FRAME_BYTES });
  wss.on('connection', ws => {
    const session = {
      ws,
      joined: false, roomId: null, sid: null, nickname: null, ukPub: null, selfSig: null,
      isAlive: true,
      send(obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { /* noop */ } },
      touch() { this.isAlive = true; },
      error(code, note) { this.send({ type: P.MSG.ERROR, code, note }); }
    };
    hub.attach(session);
    ws.on('pong', () => session.touch());
    ws.on('message', raw => {
      try { hub.handle(session, JSON.parse(raw.toString())); }
      catch (e) { session.error(P.ERR.BAD_ENVELOPE, 'JSON 解析失败'); }
    });
    ws.on('close', () => hub.detach(session));
    ws.on('error', () => { /* handled by close */ });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) { /* noop */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* noop */ }
    }
    db.purgeSessions(Date.now());
  }, P.LIMITS.HEARTBEAT_MS);

  return { server, wss, heartbeat };
}

function sidOf(req, url) {
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/(?:^|;\s*)pc_sid=([a-f0-9]+)/i);
  return (m && m[1]) || req.headers['x-pc-sid'] || url.searchParams.get('sid') || '';
}
function findSession(hub, roomId, sid) {
  const map = hub.byRoom && hub.byRoom.get(roomId);
  return map ? map.get(sid) : null;
}

module.exports = { createHttpServer, sidOf };
