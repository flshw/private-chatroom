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

  /* --- 7. Reissue rotates RK: old RK destroyed --- */
  const rk2 = keyStore.createRoomKey(config.roomId);
  check('重新签发产生不同的 RK 公钥', rk2.publicKeyPem !== rk.publicKeyPem);
  keyStore.deleteRoomKey(config.roomId, rk.ref);
  check('旧 RK 私钥销毁后不可再签发', keyStore.roomPrivateKey(config.roomId, rk.ref) === null);

  console.log('\n=== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ===');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
