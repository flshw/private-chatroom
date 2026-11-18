/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Crypto interoperability verification — the single most important test.
 * Loads the REAL inlined browser crypto stack (forge.min.js + crypto.js +
 * members.js via a VM sandbox) and checks it interoperates with the server's
 * Node crypto implementation:
 *   - config block: Node signs, browser verifies
 *   - RK member list: Node signs, browser triple-verifies
 *   - UK self-signature: browser signs, Node verifies
 *   - message: browser builds (AES-GCM + per-member RSA-OAEP + RSA-PSS),
 *     Node verifies wraps/signature, another browser member unwraps/decrypts
 *   - tampering / wrong key / stale version are all rejected
 *
 *   node tools/verify-pc-crypto.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'shared', 'protocol.js'));
const { KeyStore } = require(path.join(ROOT, 'server', 'src', 'keys.js'));

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}

/* --- Browser sandbox: load the very same inline scripts the client uses --- */
const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
function load(file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
}
load('vendor/forge.min.js');       // sets window.forge
sandbox.PCProtocol = P;             // protocol constants (server canonical)
load('client/src/crypto.js');      // sets window.PCCrypto
load('client/src/members.js');     // sets window.PCMembers
const PCCrypto = sandbox.PCCrypto;
const PCMembers = sandbox.PCMembers;

const keyStore = new KeyStore(() => {}).init();
const canonical = P.canonicalJSON;

(async () => {
  console.log('=== 私密聊天 · 加密互通验证 ===\n');

  check('内联 forge 加密栈可用', PCCrypto.available());
  check('canonicalJSON 协议常量就绪', typeof P.canonicalJSON === 'function' && typeof P.signedPart === 'function');
  check('HTTP 文件上传上限覆盖 8 MiB 密文的 base64 膨胀',
    P.LIMITS.MAX_HTTP_BODY_BYTES > P.LIMITS.MAX_FILE_BYTES * 4 / 3);

  /* --- 1. config signature: Node signs, browser verifies --- */
  const config = {
    v: P.PROTOCOL_VERSION, roomId: 'r_test1234567890ab', name: '测试房间',
    joinToken: 'a'.repeat(64), roomPubKey: '', serverPubKey: keyStore.ssk.publicKeyPem,
    issuedAt: Date.now(), expiresAt: Date.now() + 3600000, maxMembers: 6,
    clientVersion: P.PC_RELEASE_VERSION
  };
  const configSig = keyStore.signConfig(config, canonical);
  check('配置块签名：Node 签发 → 浏览器验签通过', PCCrypto.verifySig(config, configSig, config.serverPubKey) === true);
  const tampered = Object.assign({}, config, { maxMembers: 99 });
  check('篡改配置后验签失败', PCCrypto.verifySig(tampered, configSig, config.serverPubKey) === false);

  const otherKp = nodeCrypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  check('替换 SSK 公钥后代签失败', PCCrypto.verifySig(config, configSig, otherKp.publicKey) === false);

  /* --- 2. Generate two member keys in the browser --- */
  const alice = PCCrypto.generateUK();
  const bob = PCCrypto.generateUK();
  check('成员 UK 为 RSA-2048 且私钥为 PEM',
    /BEGIN (RSA )?PRIVATE KEY/.test(alice.privatePem) && /BEGIN PUBLIC KEY/.test(alice.publicPem));
  check('不同成员公钥不同', alice.publicPem !== bob.publicPem);

  /* --- 3. UK self-signature: browser signs, Node verifies --- */
  const clientTime = Date.now();
  const selfObj = { roomId: config.roomId, ukPub: alice.publicPem, nickname: '阿明', clientTime };
  const selfSigBrowser = PCCrypto.sign(selfObj, alice.privatePem);
  let selfNodeOk = false;
  try {
    selfNodeOk = nodeCrypto.verify('sha256', Buffer.from(canonical(selfObj), 'utf8'), {
      key: alice.publicPem, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, Buffer.from(selfSigBrowser, 'base64'));
  } catch (e) {}
  check('成员自签名：浏览器签发 → Node 验签通过', selfNodeOk);

  /* --- 4. RK member list: Node signs, browser triple-verifies --- */
  const rk = keyStore.createRoomKey(config.roomId);
  const bobSelfObj = { roomId: config.roomId, ukPub: bob.publicPem, nickname: '小雨', clientTime };
  const memberList = {
    version: 1, roomId: config.roomId,
    members: [
      { sid: 's_alice', nickname: '阿明', ukPub: alice.publicPem, selfSig: selfSigBrowser, clientTime },
      { sid: 's_bob', nickname: '小雨', ukPub: bob.publicPem,
        selfSig: PCCrypto.sign(bobSelfObj, bob.privatePem), clientTime }
    ]
  };
  const listSig = keyStore.signMemberList(memberList, config.roomId, rk.ref, canonical);
  PCMembers.reset();
  const listApplyOk = await PCMembers.apply(memberList, listSig, rk.publicKeyPem);
  check('成员公钥清单：RK 签名 + 逐条自签名 + version 校验通过', listApplyOk === true);
  const staleOk = await PCMembers.apply(Object.assign({}, memberList, { version: 1 }), listSig, rk.publicKeyPem);
  check('旧版本成员清单被拒绝（防重放）', staleOk === false);
  const badList = JSON.parse(JSON.stringify(memberList));
  badList.version = 2;
  badList.members[1].ukPub = otherKp.publicKey; // substituted key, selfSig no longer matches
  const badOk = await PCMembers.verifyList(badList, listSig, rk.publicKeyPem);
  check('成员公钥被替换后清单校验失败', badOk === false);
  check('安全码为 4-4 格式短码', /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(PCMembers.safetyCode()));

  /* --- 5. Full message: browser builds, Node validates, Bob decrypts --- */
  const plaintext = '你好，这是一条端到端加密消息 🔒';
  const frame = PCCrypto.buildMessage(plaintext, {
    config, mySid: 's_alice', seq: 1, serverTs: Date.now(), kind: 'text',
    members: [
      { sid: 's_alice', ukPub: alice.publicPem },
      { sid: 's_bob', ukPub: bob.publicPem }
    ],
    uk: alice
  });
  check('消息 wraps 覆盖全体成员',
    Object.keys(frame.envelope.wraps).sort().join(',') === 's_alice,s_bob');
  let msgSigOk = false;
  try {
    msgSigOk = nodeCrypto.verify('sha256', Buffer.from(canonical(P.signedPart(frame.envelope)), 'utf8'), {
      key: frame.senderPub, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, Buffer.from(frame.sig, 'base64'));
  } catch (e) {}
  check('消息签名：浏览器签发 → Node 验签通过', msgSigOk);
  check('服务端仅有公钥与密文封装（无内容密钥字段）',
    !('K' in frame) && !('key' in frame) && !!frame.envelope.wraps.s_bob);
  check('接收方 Bob 解封装 + 解密 + 验签得到原文',
    PCCrypto.openMessage(frame.envelope, frame.sig, frame.senderPub, 's_bob', bob.privatePem, alice.publicPem) === plaintext);
  check('发送方 Alice 可用自己的私钥回读',
    PCCrypto.openMessage(frame.envelope, frame.sig, frame.senderPub, 's_alice', alice.privatePem, alice.publicPem) === plaintext);
  check('服务端用错误私钥无法解封装 Bob 的密钥',
    (function () { try { PCCrypto.unwrapKey(frame.envelope.wraps.s_bob, alice.privatePem); return false; } catch (e) { return true; } })());

  /* --- 6. Tamper / AAD --- */
  const tamperedEnv = JSON.parse(JSON.stringify(frame.envelope));
  tamperedEnv.ct = PCCrypto.b64('\x01\x02\x03');
  let decryptFail = false;
  try { PCCrypto.openMessage(tamperedEnv, frame.sig, frame.senderPub, 's_bob', bob.privatePem, alice.publicPem); }
  catch (e) { decryptFail = true; }
  check('篡改密文后解密失败', decryptFail);
  const replEnv = JSON.parse(JSON.stringify(frame.envelope));
  replEnv.ts = replEnv.ts + 1; // changes AAD but sig was over old ts
  check('AAD/时序篡改导致签名失效',
    PCCrypto.verifySig(P.signedPart(replEnv), frame.sig, alice.publicPem) === false);

  /* --- 7. Binary file/voice payload roundtrip --- */
  const fileKey = PCCrypto.randomBytes(32);
  const fileAad = 'file|' + config.roomId + '|123456';
  const fileBytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255, 65, 0, 66]);
  const fileEnc = PCCrypto.aesEncryptBytes(fileKey, fileAad, fileBytes);
  const filePlain = PCCrypto.aesDecryptBytes(fileKey, fileAad, fileEnc.iv, fileEnc.ct, fileEnc.tag);
  check('二进制文件密文可无损往返', !!filePlain &&
    typeof filePlain.length === 'number' && filePlain.length === fileBytes.length &&
    Array.from(fileBytes).every((b, i) => b === filePlain[i]),
    '长度=' + (filePlain && filePlain.length) + '，实际=' + (filePlain && Array.from(filePlain).join(',')));
  let fileTamperFail = false;
  try { PCCrypto.aesDecryptBytes(fileKey, fileAad + 'x', fileEnc.iv, fileEnc.ct, fileEnc.tag); }
  catch (e) { fileTamperFail = true; }
  check('文件 AAD 篡改导致 GCM 认证失败', fileTamperFail);

  /* --- 8. RTC signaling payload is wrapped to the target member --- */
  const signalText = JSON.stringify({ kind: 'offer', sdp: { type: 'offer', sdp: 'v=0...' } });
  const rtcKey = PCCrypto.randomBytes(32);
  const rtcAad = 'rtc|' + config.roomId;
  const rtcEnc = PCCrypto.aesEncrypt(rtcKey, rtcAad, signalText);
  const rtcWrap = PCCrypto.wrapKey(rtcKey, bob.publicPem);
  const rtcUnwrapped = PCCrypto.unwrapKey(rtcWrap, bob.privatePem);
  check('RTC 信令按目标公钥封装且仅目标可解',
    rtcUnwrapped === rtcKey &&
    PCCrypto.aesDecrypt(rtcUnwrapped, rtcAad, rtcEnc.iv, rtcEnc.ct, rtcEnc.tag) === signalText);
  let rtcWrongKeyFail = false;
  try { PCCrypto.unwrapKey(rtcWrap, alice.privatePem); } catch (e) { rtcWrongKeyFail = true; }
  check('非目标成员无法解封装 RTC 信令', rtcWrongKeyFail);

  /* --- 9. Reissue rotates RK: old RK destroyed --- */
  const rk2 = keyStore.createRoomKey(config.roomId);
  check('重新签发产生不同的 RK 公钥', rk2.publicKeyPem !== rk.publicKeyPem);
  keyStore.deleteRoomKey(config.roomId, rk.ref);
  check('旧 RK 私钥销毁后不可再签发', keyStore.roomPrivateKey(config.roomId, rk.ref) === null);

  /* --- 10. Built single-file client must inline every runtime module --- */
  const built = fs.readFileSync(path.join(ROOT, 'client/dist/private-chat.template.html'), 'utf8');
  const required = [
    ['PC 协议', 'root.PCProtocol = api'],
    ['配置校验 PCConfig', 'window.PCConfig = (function'],
    ['加密 PCCrypto', 'window.PCCrypto = (function'],
    ['成员表 PCMembers', 'window.PCMembers = (function'],
    ['网络 PCNet', 'window.PCNet = function'],
    ['导出 PCExport', 'window.PCExport = (function'],
    ['媒体 PCMedia', 'window.PCMedia = function'],
    ['启动入口 boot()', 'boot();']
  ];
  required.forEach(function (pair) {
    check('单文件客户端已内联 ' + pair[0], built.indexOf(pair[1]) !== -1);
  });
  /* Constructors must be invoked with `new`; a bare call returns undefined and
   * breaks net.start/media at runtime (the "reading 'start'" failure). */
  check('PCNet 使用 new 构造', built.indexOf('new window.PCNet(') !== -1 &&
    built.indexOf('= window.PCNet(') === -1);
  check('PCMedia 使用 new 构造', built.indexOf('new window.PCMedia(') !== -1 &&
    built.indexOf('= window.PCMedia(') === -1);

  /* --- 11. Deluxe template + Guandan engine --- */
  const deluxe = fs.readFileSync(path.join(ROOT, 'client/dist/private-chat-deluxe.template.html'), 'utf8');
  ['掼蛋引擎 PCGame', '游戏客户端 PCGameClient', '3D 引擎 PC3D', '豪华版UI PCDeluxe',
   '游戏面板 game-panel'].forEach(function (pair) {
    const marker = Array.isArray(pair) ? pair[1] : ({
      '掼蛋引擎 PCGame': 'root.PCGame = api',
      '游戏客户端 PCGameClient': 'window.PCGameClient = (function',
      '3D 引擎 PC3D': 'window.PC3D = (function',
      '豪华版UI PCDeluxe': 'window.PCDeluxe = (function',
      '游戏面板 game-panel': 'id="game-panel"'
    })[pair];
    check('豪华版已内联 ' + pair, deluxe.indexOf(marker) !== -1);
  });
  check('豪华版无外部资源', !/<script[^>]+src=/i.test(deluxe) && !/<link[^>]+href=/i.test(deluxe));
  // Regression guards for browser-only bugs caught during deluxe QA.
  check('safetyCode 作为同步值使用（无 .then 误用）',
    deluxe.indexOf('PCMembers.safetyCode().then') === -1);
  check('3D 场景在豪华版初始化（PC3D.init 有调用）',
    /PC3D[^\n]*\.init\(\)/.test(deluxe));
  check('游戏初始化判断使用 PCDeluxe.bind（非不存在的 init）',
    deluxe.indexOf('PCDeluxe && window.PCDeluxe.bind') !== -1);
  // v23: spectator + video features removed, full-duplex audio voice present.
  check('旁观功能已移除（无旁观按钮/选择器/候选接口；协议保留兼容常量）',
    deluxe.indexOf('id="btn-spectate"') === -1 &&
    deluxe.indexOf('spectate-picker') === -1 &&
    deluxe.indexOf('spectateCandidates') === -1 &&
    deluxe.indexOf('game.replySpectate') === -1);
  check('视频通话已移除（无视频按钮/画中画/视频遮罩）',
    deluxe.indexOf('id="btn-video"') === -1 &&
    deluxe.indexOf('pip-video') === -1 &&
    deluxe.indexOf('video-overlay') === -1);
  check('全双工语音自动接听与纯音频约束',
    deluxe.indexOf('VOICE-AUTOJOIN') !== -1 &&
    deluxe.indexOf('video: false') !== -1);
  check('手牌选择器已改为 .pcard（不再覆盖登录 .card）',
    deluxe.indexOf('.pcard{width:44px') !== -1 &&
    deluxe.indexOf('.card{width:44px') === -1 &&
    deluxe.indexOf("d.className = 'pcard'") !== -1);
  check('3D 画布使用高优先级 fixed 定位（不遮挡聊天/游戏）',
    deluxe.indexOf('#chat>#scene3d{position:fixed') !== -1);
  check('F5 刷新自动恢复会话（localStorage 密钥，两版通用）',
    deluxe.indexOf('var nick = savedNickname();') !== -1 &&
    deluxe.indexOf('if (cached && nick)') !== -1 &&
    deluxe.indexOf('localStorage.setItem(ukStoreKey(roomId)') !== -1 &&
    deluxe.indexOf('indexedDB.open') === -1);
  check('两版均提供退出房间按钮与清理流程',
    built.indexOf('id="btn-exit"') !== -1 &&
    deluxe.indexOf('id="btn-exit"') !== -1 &&
    built.indexOf('function leaveRoom()') !== -1 &&
    built.indexOf("clearNickname(); clearUK(state.config.roomId);") !== -1);
  check('机器人补位（仅单人时创建3个，第二真人进入即退出）',
    deluxe.indexOf("BOT_SIDS = ['bot_1', 'bot_2', 'bot_3']") !== -1 &&
    deluxe.indexOf('humans.length === 1') !== -1 &&
    deluxe.indexOf('root.PCBots = api') !== -1 &&
    deluxe.indexOf('function botStep(sid)') !== -1);
  check('机器人手牌仅存房主本地（不经 E2EE 广播机器人手牌）',
    deluxe.indexOf('state.botHands[seat.sid] = window.PCBots.sortedHand') !== -1 &&
    deluxe.indexOf('bots: state.seats.filter') !== -1);
  check('游戏按钮按 4 人门槛启用', deluxe.indexOf('membersList.length >= 4') !== -1);
  check('开局必须选择另外 3 名玩家并指定对家',
    deluxe.indexOf('game.requestStart([mySid].concat(picked), partner);') !== -1 &&
    deluxe.indexOf("picked.length !== 3") !== -1);
  check('选人改为弹窗并在开局后关闭',
    deluxe.indexOf('id="game-setup-mask"') !== -1 &&
    deluxe.indexOf('function showSetup(open)') !== -1 &&
    deluxe.indexOf('showSetup(false);') !== -1);
  check('4人全选/超过4人随机选3人',
    deluxe.indexOf('function autoPick()') !== -1 &&
    deluxe.indexOf('membersList.length === 4') !== -1 &&
    deluxe.indexOf('Math.random()') !== -1);
  check('出牌/过牌按钮位于面板底部',
    deluxe.indexOf('class="game-bottom"') !== -1 &&
    deluxe.indexOf('id="btn-game-play"') > deluxe.indexOf('class="game-bottom"'));
  check('记牌器按已出牌实时扣减',
    deluxe.indexOf('id="card-counter"') !== -1 &&
    deluxe.indexOf('state.played.push(') !== -1 &&
    deluxe.indexOf('renderCounter(st)') !== -1);
  /* Guandan engine behaviour is covered by tools/test-guandan.js. */
  const hubSrc = fs.readFileSync(path.join(ROOT, 'server', 'src', 'hub.js'), 'utf8');
  check('消息 seq 按发送会话校验（多人首条不再误判重放）',
    hubSrc.indexOf('this.seqBySid.get(session.sid)') !== -1 &&
    hubSrc.indexOf('this.db.nextSeq(roomId)') === -1);

  console.log('\n=== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ===');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
