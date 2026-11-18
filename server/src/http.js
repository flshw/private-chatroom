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
      if (size > P.LIMITS.MAX_HTTP_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
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
  const { accounts, rooms, hub, db, keyStore, logger, connLog, shares, adminAuth } = options;
  const trace = connLog || (() => {});
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
    /* Static vendor assets (QR generator for the portal). */
    if (pathname === PUB + '/vendor/qrcode.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'vendor', 'qrcode.js'));
    }
    /* Share-code entry: a QR scan opens the signed client HTML INLINE (not as
     * a download), so any browser joins the room directly. The code is a bearer
     * capability equivalent to the downloaded file; it is revoked on reissue
     * or room destruction, and rejected once the room expires. */
    const shareMatch = pathname.match(new RegExp('^' + PUB + '/s/([A-Za-z0-9_-]+)/?$'));
    if (shareMatch && shares) {
      const found = shares.resolve(shareMatch[1]);
      if (!found) {
        return sendText(res, 404,
          '<!doctype html><meta charset="utf-8"><title>链接已失效</title>' +
          '<h2>分享链接已失效</h2><p>房间可能已重新签发、到期或销毁，请向房主索取新的二维码。</p>',
          'text/html; charset=utf-8');
      }
      return sendText(res, 200, found.html, 'text/html; charset=utf-8');
    }
    /* Online room URL is informational only in v0.1. Passing joinToken in a
     * query string would leak it through history/referrer/logs, and serving
     * the bare template would hand out a client without a signed config. */
    const onlineMatch = pathname.match(new RegExp('^' + PUB + '/p/([A-Za-z0-9_]+)/?$'));
    if (onlineMatch) {
      const roomId = onlineMatch[1];
      const room = db.room(roomId);
      if (!room || room.status === 'destroyed' || room.status === 'destroying') {
        return sendText(res, 404, '房间不存在或已销毁');
      }
      return sendText(res, 200,
        '<!doctype html><meta charset="utf-8"><title>私密聊天</title><h2>请使用下载好的专属客户端进入房间</h2>' +
        '<p>为防止准入凭证经浏览器历史、Referer 或日志泄露，v0.1 不在网址中传递进入凭证。' +
        '请向发起人索取专属 HTML 文件，双击打开后填写昵称即可进入。</p>',
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
        const ip = clientIp(req);
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
    /* Public read-only directory of live rooms. No session, no credentials,
     * no identifiers or keys — just enough to see what is open right now. */
    if (pathname === API + '/rooms/public' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, rooms: rooms.publicList(), serverTime: Date.now() });
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
          'X-PC-Room-Id': built.roomId,
          'Cache-Control': 'no-store, private'
        }, CORS));
        return res.end(built.html);
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    let m;
    m = pathname.match(new RegExp('^' + API + '/rooms/([A-Za-z0-9_]+)/client$'));
    if (m && req.method === 'GET') {
      // Reissue is a state-changing GET (rotates joinToken + kicks members).
      // Block cross-site navigation/top-level fetches using the browser's
      // Sec-Fetch-Site header when present — a low-friction CSRF mitigation
      // that keeps the <a download> flow working for same-site portals.
      const fsSite = req.headers['sec-fetch-site'];
      if (fsSite && fsSite !== 'same-origin' && fsSite !== 'same-site') {
        return sendJson(res, 403, { ok: false, error: '拒绝跨站重签发请求' });
      }
      const user = requireUser();
      if (!user) return sendJson(res, 401, { ok: false, error: '需要登录' });
      try {
        const edition = url.searchParams.get('edition') === 'deluxe' ? 'deluxe' : 'lite';
        const built = rooms.issueClient(user, m[1], edition);
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
    /* Owner-only share links (QR codes) for a room. */
    m = pathname.match(new RegExp('^' + API + '/rooms/([A-Za-z0-9_]+)/shares$'));
    if (m && req.method === 'GET') {
      const user = requireUser();
      if (!user) return sendJson(res, 401, { ok: false, error: '需要登录' });
      try { return sendJson(res, 200, Object.assign({ ok: true }, rooms.shareLinks(user.id, m[1]))); }
      catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
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

    /* ---- admin console auth (separate from chat accounts) ---- */
    function adminSid(req, url) {
      const cookie = String(req.headers.cookie || '');
      const m = cookie.match(/(?:^|;\s*)pc_admin_sid=([a-f0-9]{64})/i);
      return (m && m[1]) || '';
    }
    function requireAdminSession(req, url) {
      const sess = adminAuth ? adminAuth.session(adminSid(req, url)) : null;
      if (!sess) {
        const err = new Error('请先登录管理后台'); err.status = 401; throw err;
      }
      if (adminAuth.status().mustChange && pathname !== API + '/admin/password') {
        const err = new Error('首次登录请先修改口令'); err.status = 403; throw err;
      }
      return sess;
    }
    function setAdminCookie(sid, maxAgeSec) {
      const secure = (config.tlsCert || config.serverUrl.startsWith('https://')) ? '; Secure' : '';
      res.setHeader('Set-Cookie', 'pc_admin_sid=' + sid +
        '; Path=/; HttpOnly; SameSite=Strict' + secure + '; Max-Age=' + maxAgeSec);
    }
    // Only accept state-changing admin POSTs from same-origin pages. With
    // SameSite=Strict cookies this is defence-in-depth against CSRF.
    function checkAdminOrigin(req) {
      const origin = req.headers.origin;
      if (!origin) return; // non-browser clients (curl/scripts) allowed
      let host = req.headers.host || '';
      let ok = false;
      try {
        const u = new URL(origin);
        ok = u.host === host || u.host === new URL(config.serverUrl).host;
      } catch (e) { ok = false; }
      if (!ok) { const err = new Error('来源校验失败'); err.status = 403; throw err; }
    }

    if (pathname === API + '/admin/status' && req.method === 'GET') {
      if (!adminAuth) return sendJson(res, 503, { ok: false, error: '管理后台未启用' });
      const sess = adminAuth.session(adminSid(req, url));
      return sendJson(res, 200, Object.assign({}, adminAuth.status(), {
        authenticated: !!sess, sid: sess ? sess.sid : null
      }));
    }
    if (pathname === API + '/admin/login' && req.method === 'POST') {
      try {
        checkAdminOrigin(req);
        const b = await readJson(req);
        const sess = adminAuth.loginPassword(clientIp(req), b.password);
        setAdminCookie(sess.sid, Math.floor((sess.expiresAt - Date.now()) / 1000));
        return sendJson(res, 200, { ok: true, mustChange: adminAuth.status().mustChange });
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    if (pathname === API + '/admin/login-key' && req.method === 'POST') {
      try {
        checkAdminOrigin(req);
        const b = await readJson(req);
        const sess = adminAuth.loginKey(clientIp(req), b.key);
        setAdminCookie(sess.sid, Math.floor((sess.expiresAt - Date.now()) / 1000));
        return sendJson(res, 200, { ok: true, mustChange: adminAuth.status().mustChange });
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    if (pathname === API + '/admin/logout' && req.method === 'POST') {
      try { adminAuth.logout(adminSid(req, url)); } catch (e) {}
      res.setHeader('Set-Cookie', 'pc_admin_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === API + '/admin/password' && req.method === 'POST') {
      try {
        checkAdminOrigin(req);
        requireAdminSession(req, url);
        const b = await readJson(req);
        adminAuth.changePassword(b.oldPassword, b.newPassword);
        return sendJson(res, 200, { ok: true, mustChange: false });
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    if (pathname === API + '/admin/key' && req.method === 'POST') {
      try {
        checkAdminOrigin(req);
        requireAdminSession(req, url);
        const key = adminAuth.createKey();
        return sendJson(res, 200, { ok: true, key,
          note: '请立即下载保存，此密钥仅显示一次；重新生成会使旧密钥失效。' });
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    if (pathname === API + '/admin/key/revoke' && req.method === 'POST') {
      try {
        checkAdminOrigin(req);
        requireAdminSession(req, url);
        return sendJson(res, 200, adminAuth.revokeKey());
      } catch (e) { return sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }

    /* ---- admin rooms (reserved; no approval queue by design) ---- */
    if (pathname === API + '/admin/rooms' && req.method === 'GET') {
      // Backward compatibility: the legacy PC_ADMIN_TOKEN header still works
      // for scripts; browser clients use the HttpOnly admin session cookie.
      const legacy = req.headers['x-pc-admin-token'] || '';
      const legacyOk = legacy && process.env.PC_ADMIN_TOKEN && legacy === process.env.PC_ADMIN_TOKEN;
      if (!legacyOk) {
        try { requireAdminSession(req, url); }
        catch (e) { return sendJson(res, e.status || 403, { ok: false, error: e.message }); }
      }
      const now = Date.now();
      const rows = db.all("SELECT * FROM rooms WHERE status!='destroyed' ORDER BY created_at DESC");
      const out = rows.map(r => {
        const online = hub.onlineCount ? hub.onlineCount(r.id) : (hub.byRoom && hub.byRoom.has(r.id) ? hub.byRoom.get(r.id).size : 0);
        return {
          roomId: r.id, name: r.name, status: r.status,
          ownerId: r.owner_id, ttlSeconds: r.ttl_seconds, maxMembers: r.max_members,
          createdAt: r.created_at, expiresAt: r.expires_at,
          remainSeconds: Math.max(0, Math.floor((r.expires_at - now) / 1000)),
          onlineCount: online,
          revoked: !!r.revoke_at
        };
      });
      const s = hub.stats();
      return sendJson(res, 200, { ok: true, rooms: out,
        stats: { total: out.length, onlineClients: s.clients, activeRooms: s.rooms,
          pendingCleanup: db.all("SELECT COUNT(*) AS n FROM rooms WHERE status IN ('issued','active') AND expires_at<=?", [now])[0].n },
        serverTime: now });
    }
    m = pathname.match(new RegExp('^' + API + '/admin/rooms/([A-Za-z0-9_]+)/destroy$'));
    if (m && req.method === 'POST') {
      const legacy = req.headers['x-pc-admin-token'] || '';
      const legacyOk = legacy && process.env.PC_ADMIN_TOKEN && legacy === process.env.PC_ADMIN_TOKEN;
      try {
        if (!legacyOk) { checkAdminOrigin(req); requireAdminSession(req, url); }
        return sendJson(res, 200, Object.assign({ ok: true }, rooms.destroy(m[1], 'admin')));
      } catch (e) { return sendJson(res, e.status || 403, { ok: false, error: e.message }); }
    }

    return sendText(res, 404, '404 Not Found');
  });

  const wss = new WebSocketServer({ server, path: config.wsPath, maxPayload: P.LIMITS.MAX_FRAME_BYTES });
  const MAX_WS_CONNECTIONS = (typeof config.maxWsConnections === 'number' && config.maxWsConnections > 0)
    ? config.maxWsConnections : 200;
  wss.on('connection', ws => {
    // Bound total sockets: an unauthenticated attacker could otherwise open
    // unlimited connections (no JOIN needed) and exhaust memory/FDs.
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      trace('WS-REJECT limit=' + MAX_WS_CONNECTIONS + ' size=' + wss.clients.size);
      try { ws.close(1013, 'server busy'); } catch (e) {}
      return;
    }
    const session = {
      ws,
      joined: false, roomId: null, sid: null, nickname: null, ukPub: null, selfSig: null,
      isAlive: true,
      send(obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { /* noop */ } },
      touch() { this.isAlive = true; },
      error(code, note) { this.send({ type: P.MSG.ERROR, code, note }); }
    };
    hub.attach(session);
    ws._session = session;
    ws.on('pong', () => session.touch());
    ws.on('message', raw => {
      try { hub.handle(session, JSON.parse(raw.toString())); }
      catch (e) { trace('BAD-JSON id=' + (session.connId || '?') + ' err=' + e.message); session.error(P.ERR.BAD_ENVELOPE, 'JSON 解析失败'); }
    });
    ws.on('close', (code, reason) => {
      trace('WS-CLOSE id=' + (session.connId || '?') +
        ' code=' + code + ' reason=' + String(reason || '').slice(0, 40) + ' sid=' + (session.sid || '-'));
      hub.detach(session);
    });
    ws.on('error', e => trace('WS-ERROR id=' + (session.connId || '?') + ' err=' + (e && e.message ? e.message : '?')));
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      /* Read/write the SAME object that the pong handler touches (session),
       * NOT ws. Previously this used ws.isAlive while pong set session.isAlive,
       * so no pong ever cleared the flag and every socket was terminated on the
       * 2nd tick (~50s) regardless of liveness — a forced reconnect loop. */
      const session = ws._session;
      if (session && session.isAlive === false) {
        trace('HEARTBEAT-KILL id=' + (session.connId || '?') + ' (no pong for ' + P.LIMITS.HEARTBEAT_MS + 'ms)');
        try { ws.terminate(); } catch (e) { /* noop */ } continue;
      }
      if (session) session.isAlive = false;
      try { ws.ping(); } catch (e) { /* noop */ }
    }
    db.purgeSessions(Date.now());
    if (hub.sweepMaps) hub.sweepMaps(Date.now());
  }, P.LIMITS.HEARTBEAT_MS);

  return { server, wss, heartbeat };
}

/* Client IP for rate limiting. X-Forwarded-For is honoured ONLY when a
 * trusted reverse proxy is explicitly configured, otherwise any client could
 * spoof the header and bypass login throttling. */
function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return String(req.socket.remoteAddress || '');
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
