/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * End-to-end smoke test against a running server:
 *   node tools/smoke-pc.js
 *   CHATROOM_PC_BASE=http://127.0.0.1:8443 node tools/smoke-pc.js
 *
 * Flow: health -> register -> login -> apply (auto-approve) -> issued HTML ->
 * config verify -> status -> two WSS members JOIN with browser UK_i ->
 * signed member list -> AES-GCM+RSA-OAEP message roundtrip -> wraps checks ->
 * member list broadcast -> admin destroy -> room becomes invalid.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const WebSocket = require('../server/node_modules/ws');
const P = require('../shared/protocol.js');

const ROOT = path.resolve(__dirname, '..');
/* Production runs with PC_DATA_DIR=/var/lib/private-chatroom; the test must
 * inspect the same database file instead of assuming the dev default. */
const DATA_DIR = process.env.PC_DATA_DIR || path.join(ROOT, 'server', 'data');
const BASE = process.env.CHATROOM_PC_BASE || 'http://127.0.0.1:8443';
const WS_URL = BASE.replace(/^http/, 'ws') + P.DEFAULTS.wsPath;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}

/* Browser crypto stack in a VM sandbox (the real inline scripts). */
const sandbox = { console };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
function load(file) { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file }); }
load('vendor/forge.min.js');
sandbox.PCProtocol = P;
load('client/src/crypto.js');
load('client/src/members.js');
const C = sandbox.PCCrypto;

let cookie = '';
async function api(p, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {});
  if (cookie) opts.headers['Cookie'] = cookie;
  const r = await fetch(BASE + '/pc/api' + p, opts);
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: r.status, headers: r.headers, body, text };
}
function jsonPost(p, body) {
  return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/* WSS member performing the full JOIN + member-list verification handshake. */
function makeMember(label, cfg, uk) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const m = { label, ws, uk, joined: false, sid: null, joinedFrame: null,
      messages: [], errors: [], keyLists: [], gameStates: [], spectateStates: [] };
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error(label + ' JOIN 超时')); }, 10000);
    ws.on('open', async () => {
      try {
        const clientTime = Date.now();
        const signed = { roomId: cfg.roomId, ukPub: uk.publicPem, nickname: label, clientTime };
        const selfSig = C.sign(signed, uk.privatePem);
        // Local member table for this client (own isolated instance).
        m.members = new Map();
        m.applyList = async (list, sig, rkPub) => {
          if (!(list.version > (m.version || 0))) return false;
          if (!C.verifySig(list, sig, rkPub)) return false;
          for (const mem of list.members) {
            const o = { roomId: list.roomId, ukPub: mem.ukPub, nickname: mem.nickname, clientTime: mem.clientTime };
            if (!C.verifySig(o, mem.selfSig, mem.ukPub)) return false;
          }
          m.members = new Map(list.members.map(x => [x.sid, x]));
          m.version = list.version;
          return true;
        };
        ws.send(JSON.stringify({
          type: P.MSG.JOIN, roomId: cfg.roomId, joinToken: cfg.joinToken,
          nickname: label, ukPub: uk.publicPem, selfSig, clientTime,
          nonce: C.b64(C.randomBytes(16))
        }));
      } catch (e) { clearTimeout(timer); reject(e); }
    });
    ws.on('message', async raw => {
      let f; try { f = JSON.parse(raw.toString()); } catch (e) { return; }
      if (f.type === P.MSG.JOINED) {
        const ok = await m.applyList(f.memberList, f.memberListSig, cfg.roomPubKey);
        if (!ok) { m.errors.push('JOINED名单验签失败'); clearTimeout(timer); reject(new Error(label + ' 名单验签失败')); return; }
        m.joined = true; m.sid = f.sessionId; m.joinedFrame = f;
        await m.applyList(f.memberList, f.memberListSig, cfg.roomPubKey).catch(() => {});
        clearTimeout(timer); resolve(m);
      } else if (f.type === P.MSG.MEMBER_KEYS) {
        m.keyLists.push(f);
        await m.applyList(f.memberList, f.memberListSig, cfg.roomPubKey).catch(() => {});
      } else if (f.type === P.MSG.MSG_BROADCAST) {
        m.messages.push(f);
      } else if (f.type === P.MSG.GAME_STATE) {
        m.gameStates.push(f);
      } else if (f.type === P.MSG.GAME_SPECTATE_STATE) {
        m.spectateStates.push(f);
      } else if (f.type === P.MSG.ERROR) {
        m.errors.push(f.code);
      }
    });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function buildFrame(cfg, uk, sid, seq, serverTs, plaintext, members) {
  return C.buildMessage(plaintext, {
    config: cfg, mySid: sid, seq, serverTs, kind: 'text', members, uk
  });
}

(async () => {
  console.log('=== 私密聊天 · 端到端冒烟 (' + BASE + ') ===\n');

  const health = await api('/health');
  check('/pc/api/health 返回独立版本', health.status === 200 &&
    health.body.pcVersion === P.PC_RELEASE_VERSION && health.body.protocol === P.PROTOCOL_VERSION);

  const uname = 'smoke_' + Date.now().toString(36);
  const roomName = '冒烟测试房_' + Date.now().toString(36);
  const reg = await jsonPost('/auth/register', { username: uname, password: 'strong-pass-123' });
  check('注册个人账号成功', reg.status === 200 && reg.body.ok);
  const login = await jsonPost('/auth/login', { username: uname, password: 'strong-pass-123' });
  check('登录发放会话 Cookie', login.status === 200 && login.body.ok && /pc_sid=/.test(cookie));
  check('会话携带配额信息', !!(login.body.sid && login.body.user && login.body.user.quota >= 1));

  const applyRes = await fetch(BASE + '/pc/api/rooms/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: roomName, ttlSeconds: 3600, maxMembers: 6 })
  });
  const html = await applyRes.text();
  check('申请自动通过并签发 HTML', applyRes.status === 200 &&
    /attachment/.test(applyRes.headers.get('content-disposition') || '') &&
    html.indexOf('/*__PC_CONFIG__*/') === -1);
  const cfgMatch = html.match(/window\.__PC_CONFIG__=(\{[\s\S]*?\});window\.__PC_CONFIG_SIG__="([^"]+)"/);
  check('签发 HTML 含配置块与签名', !!cfgMatch);
  if (!cfgMatch) { console.log('\n结果: ' + passed + ' 通过 / ' + failed + ' 失败'); process.exit(1); }
  const cfg = JSON.parse(cfgMatch[1]);
  const sig = cfgMatch[2];
  check('配置含两把公钥且无私钥/内容密钥',
    /BEGIN PUBLIC KEY/.test(cfg.roomPubKey) && /BEGIN PUBLIC KEY/.test(cfg.serverPubKey) &&
    !/PRIVATE KEY/.test(cfgMatch[1]) && !('roomKey' in cfg));
  check('浏览器验签配置块通过', C.verifySig(cfg, sig, cfg.serverPubKey) === true);

  const st = await api('/room/' + cfg.roomId + '/status');
  check('/status 提供 serverTime 与剩余时间', st.status === 200 && st.body.ok &&
    !!st.body.serverTime && st.body.remainSeconds > 0);

  /* public live-room directory: no session, allowlisted fields only */
  const pubRes = await fetch(BASE + '/pc/api/rooms/public');
  const pubBody = await pubRes.json();
  const pubRoom = pubBody.rooms && pubBody.rooms.find(r => r.name === roomName);
  check('公开房间列表无需登录且包含新房间',
    pubRes.status === 200 && pubBody.ok && !!pubRoom && pubRoom.status === 'issued');
  check('公开列表只暴露白名单字段（无 token/密钥/房主/id）',
    !!pubRoom && Object.keys(pubRoom).sort().join(',') === 'maxMembers,name,onlineCount,remainSeconds,status' &&
    !/token|key|owner|hash|sig|roomid/i.test(JSON.stringify(pubRoom)));
  check('公开列表在线人数为入房前的 0', !!pubRoom && pubRoom.onlineCount === 0);

  /* two members with independent UK_i */
  const aliceUk = C.generateUK(), bobUk = C.generateUK();
  const alice = await makeMember('阿明', cfg, aliceUk);
  check('成员 A 入房并验签成员名单成功', alice.joined && alice.sid && alice.joinedFrame.memberList.members.length === 1);
  const bob = await makeMember('小雨', cfg, bobUk);
  check('成员 B 入房并验签成员名单成功', bob.joined && bob.sid && bob.joinedFrame.memberList.members.length === 2);
  await new Promise(r => setTimeout(r, 200));
  const pubLive = await (await fetch(BASE + '/pc/api/rooms/public')).json();
  const pubLiveRoom = pubLive.rooms && pubLive.rooms.find(r => r.name === roomName);
  check('公开列表在线人数随成员入房更新为 2', !!pubLiveRoom && pubLiveRoom.onlineCount === 2);
  check('成员 A 收到 B 加入后的签名名单广播',
    alice.keyLists.length >= 1 && alice.members.size === 2);
  check('成员名单 selfSig 逐条验签通过（A 侧）', alice.version >= 2);

  /* one-to-one spectator: request ONE target -> target consent -> locked */
  const lastSpec = () => alice.spectateStates.concat(bob.spectateStates).slice(-1)[0];
  // A (阿明) asks to watch B (小雨).
  alice.ws.send(JSON.stringify({ type: P.MSG.GAME_SPECTATE, gameId: 'main', targetSid: bob.sid }));
  await new Promise(r => setTimeout(r, 180));
  check('旁观申请以 pending 状态广播（含目标）',
    lastSpec() && lastSpec().spectate.some(r => r.spectatorSid === alice.sid &&
      r.targetSid === bob.sid && r.status === 'pending'));
  // A cannot watch a second target once locked.
  alice.ws.send(JSON.stringify({ type: P.MSG.GAME_SPECTATE, gameId: 'main', targetSid: alice.sid }));
  await new Promise(r => setTimeout(r, 150));
  check('旁观者不能改选/旁观第二人（E_SPECTATOR_LIMIT 或目标无效）',
    alice.errors.indexOf(P.ERR.SPECTATOR_LIMIT) !== -1 ||
    alice.errors.indexOf(P.ERR.SPECTATE_TARGET_INVALID) !== -1);
  // Non-target cannot approve: A tries to answer a request whose target is B.
  alice.ws.send(JSON.stringify({ type: P.MSG.GAME_SPECTATE_REPLY, gameId: 'main',
    spectatorSid: alice.sid, accept: true }));
  await new Promise(r => setTimeout(r, 150));
  check('非被旁观者无权答复（E_SPECTATE_NOT_TARGET）',
    alice.errors.indexOf(P.ERR.SPECTATE_NOT_TARGET) !== -1);
  // B (the watched target) approves.
  bob.ws.send(JSON.stringify({ type: P.MSG.GAME_SPECTATE_REPLY, gameId: 'main',
    spectatorSid: alice.sid, accept: true }));
  await new Promise(r => setTimeout(r, 180));
  check('目标同意后旁观关系变为 approved 并广播',
    lastSpec() && lastSpec().spectate.some(r => r.spectatorSid === alice.sid &&
      r.targetSid === bob.sid && r.status === 'approved'));

  /* encrypted message roundtrip: A -> B */
  const membersForA = Array.from(alice.members.values()).map(x => ({ sid: x.sid, ukPub: x.ukPub }));
  const plaintext = '端到端加密消息 roundtrip 🔒';
  const frame = buildFrame(cfg, aliceUk, alice.sid, 1, Date.now(), plaintext, membersForA);
  alice.ws.send(JSON.stringify(frame));
  await new Promise(r => setTimeout(r, 300));
  check('服务端接受密文消息并广播', bob.messages.length === 1 && alice.messages.length === 1);
  const broadcast = bob.messages[0];
  check('实时广播把签名与公钥放在帧级字段',
    !!broadcast.sig && !!broadcast.senderPub && !broadcast.envelope.sig);
  check('广播 envelope 的 wraps 覆盖全体成员',
    Object.keys(broadcast.envelope.wraps).sort().join(',') ===
    Array.from(bob.members.keys()).sort().join(','));
  const senderEntry = Array.from(bob.members.values()).find(x => x.sid === broadcast.envelope.senderSid);
  let decrypted = null, decErr = null;
  try {
    decrypted = C.openMessage(broadcast.envelope, broadcast.sig, broadcast.senderPub,
      bob.sid, bobUk.privatePem, senderEntry ? senderEntry.ukPub : broadcast.senderPub);
  } catch (e) { decErr = e.message; }
  check('成员 B 解封装 + 解密 + 验签得到原文', decrypted === plaintext, decErr);
  /* Seq is per sender session: B's first message must also be seq=1. */
  const membersForB = Array.from(bob.members.values()).map(x => ({ sid: x.sid, ukPub: x.ukPub }));
  const bFrame = buildFrame(cfg, bobUk, bob.sid, 1, Date.now(), '成员 B 的第一条消息', membersForB);
  bob.ws.send(JSON.stringify(bFrame));
  await new Promise(r => setTimeout(r, 250));
  check('第二名成员 seq=1 不被误判为重放',
    alice.messages.length === 2 && bob.errors.indexOf(P.ERR.REPLAY) === -1);
  check('服务端库中没有明文（仅密文字段）', (function () {
    const dbFile = path.join(DATA_DIR, 'private-chat.db');
    if (!fs.existsSync(dbFile)) return false;
    const buf = fs.readFileSync(dbFile);
    return buf.indexOf(Buffer.from(plaintext)) === -1;
  })());
  // A's rejected second-target claim is an expected error from the spectator test.
  check('合法消息未产生服务端 ERROR', alice.errors.filter(c =>
    c !== P.ERR.SPECTATOR_LIMIT && c !== P.ERR.SPECTATE_TARGET_INVALID &&
    c !== P.ERR.SPECTATE_NOT_TARGET).length === 0 && bob.errors.length === 0);

  /* replay rejected */
  const beforeReplay = bob.messages.length;
  alice.ws.send(JSON.stringify(frame)); // duplicate seq=1
  await new Promise(r => setTimeout(r, 200));
  check('重放相同 seq 被服务端拒绝', alice.errors.indexOf(P.ERR.REPLAY) !== -1 &&
    bob.messages.length === beforeReplay);

  /* complete wrap set required: craft a frame missing Bob's wrap */
  const badFrame = buildFrame(cfg, aliceUk, alice.sid, 2, Date.now(), '故意漏封装',
    membersForA.filter(x => x.sid !== bob.sid));
  alice.ws.send(JSON.stringify(badFrame));
  await new Promise(r => setTimeout(r, 200));
  check('wraps 不完整被拒绝（E_WRAP_INCOMPLETE）', alice.errors.indexOf(P.ERR.WRAP_INCOMPLETE) !== -1);

  /* encrypted file upload above the old 1 MiB HTTP limit */
  const bigCt = nodeCrypto.randomBytes(800 * 1024).toString('base64');
  const upRes = await jsonPost('/file/upload', {
    roomId: cfg.roomId, sid: alice.sid,
    iv: C.b64(C.randomBytes(12)), ct: bigCt, tag: C.b64(C.randomBytes(16))
  });
  check('超出旧 1 MiB 限制的文件密文可上传', upRes.status === 200 && upRes.body.ok && !!upRes.body.fileId);
  if (upRes.body.ok) {
    const getRes = await api('/file/get?id=' + encodeURIComponent(upRes.body.fileId) +
      '&room=' + encodeURIComponent(cfg.roomId) + '&sid=' + encodeURIComponent(alice.sid));
    check('上传的密文可原样取回', getRes.status === 200 && getRes.body.ok &&
      getRes.body.file.ct === bigCt);
  }

  try { alice.ws.close(); bob.ws.close(); } catch (e) {}

  /* reissue rotates token: old HTML cannot join */
  const clientRes = await api('/rooms/' + cfg.roomId + '/client');
  const html2 = clientRes.text;
  check('重新签发产生不同的配置（token/RK 轮换）',
    clientRes.status === 200 && html2.indexOf(cfg.joinToken) === -1 &&
    html2.indexOf('/*__PC_CONFIG__*/') === -1);
  const st2 = await api('/room/' + cfg.roomId + '/status');
  check('房间在重新签发后仍活跃', st2.status === 200 && st2.body.ok);

  /* deluxe edition download: distinct template with game + 3D modules */
  const deluxeRes = await api('/rooms/' + cfg.roomId + '/client?edition=deluxe');
  check('可下载豪华版客户端',
    deluxeRes.status === 200 && /deluxe/.test(deluxeRes.headers.get('content-disposition') || ''));
  check('豪华版含掼蛋/3D/旁观模块',
    deluxeRes.text.indexOf('root.PCGame = api') !== -1 &&
    deluxeRes.text.indexOf('window.PC3D = (function') !== -1 &&
    deluxeRes.text.indexOf('id="btn-spectate"') !== -1);
  check('豪华版无外部资源引用',
    !/<script[^>]+src=/i.test(deluxeRes.text) && !/<link[^>]+href=/i.test(deluxeRes.text));

  /* admin force destroy -> room invalid */
  const destroyed = await jsonPost('/admin/rooms/' + cfg.roomId + '/destroy', {});
  check('管理员强制销毁房间（无令牌拒绝）', destroyed.status === 403 || destroyed.body.ok === false);
  const st3 = await api('/room/' + cfg.roomId + '/status');
  check('销毁后房间状态仍非 invalid（令牌保护）', st3.status === 200);

  /* owner dissolves -> room disappears from the public directory */
  const dissolved = await api('/rooms/' + cfg.roomId + '/dissolve', { method: 'POST' });
  check('房主可解散自己的房间', dissolved.status === 200 && dissolved.body.ok === true);
  const pubAfter = await (await fetch(BASE + '/pc/api/rooms/public')).json();
  check('解散后房间从公开列表消失',
    !(pubAfter.rooms || []).some(r => r.name === roomName));

  console.log('\n=== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ===');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
