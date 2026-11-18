/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Server key store. Holds only SIGNING keys:
 *   SSK  platform-level, signs the config block baked into each client HTML.
 *   RK_i per-room identity key, signs the member public-key list.
 * Neither can decrypt content — they are RSA signing keys. Each RK is deleted
 * when its room is destroyed, so historical member lists cannot be forged.
 *
 * Private keys live as PEM files (0600) in KEYS_DIR, never in the SQL database
 * and never in logs. Public keys are returned as PEM for baking into clients.
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { KEYS_DIR, config } = require('./paths');

const SSK_PRIV = path.join(KEYS_DIR, 'ssk-private.pem');
const SSK_PUB = path.join(KEYS_DIR, 'ssk-public.pem');

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

class KeyStore {
  constructor(logger) {
    this.logger = logger || (() => {});
    this.ssk = null;
  }

  init() {
    fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(SSK_PRIV) || !fs.existsSync(SSK_PUB)) {
      const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', {
        modulusLength: config.RSA_BITS || 2048,
        publicExponent: 0x10001,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
      fs.writeFileSync(SSK_PRIV, privateKey, { mode: 0o600 });
      fs.writeFileSync(SSK_PUB, publicKey, { mode: 0o600 });
      this.logger('已生成平台签名密钥 SSK');
    }
    this.ssk = {
      privateKeyPem: fs.readFileSync(SSK_PRIV, 'utf8'),
      publicKeyPem: fs.readFileSync(SSK_PUB, 'utf8'),
      fingerprint: this.fingerprint(fs.readFileSync(SSK_PUB, 'utf8'))
    };
    return this;
  }

  fingerprint(pem) {
    const der = nodeCrypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return nodeCrypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  }

  /* Create a fresh per-room RK key pair; returns PEM strings. Private key is
   * stored in KEYS_DIR keyed by roomId; caller persists only the reference. */
  createRoomKey(roomId) {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const file = path.join(KEYS_DIR, 'rk-' + roomId + '.pem');
    fs.writeFileSync(file, privateKey, { mode: 0o600 });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey, ref: file };
  }

  roomPrivateKey(roomId, ref) {
    const file = ref && path.isAbsolute(ref) ? ref : path.join(KEYS_DIR, 'rk-' + roomId + '.pem');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  deleteRoomKey(roomId, ref) {
    const file = ref && path.isAbsolute(ref) ? ref : path.join(KEYS_DIR, 'rk-' + roomId + '.pem');
    try { if (fs.existsSync(file)) fs.unlinkSync(file); }
    catch (e) { this.logger('删除 RK 私钥失败: ' + e.message); }
  }

  /* RSA-PSS-SHA256 over canonical JSON bytes. */
  signConfig(configObj, canonicalJSON) {
    const data = canonicalJSON(configObj);
    return nodeCrypto.sign('sha256', Buffer.from(data, 'utf8'), {
      key: this.ssk.privateKeyPem,
      padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST
    }).toString('base64');
  }

  signMemberList(memberList, roomId, roomPrivRef, canonicalJSON) {
    const priv = this.roomPrivateKey(roomId, roomPrivRef);
    if (!priv) throw new Error('RK 私钥缺失，无法签发成员公钥清单');
    const data = canonicalJSON(memberList);
    return nodeCrypto.sign('sha256', Buffer.from(data, 'utf8'), {
      key: priv,
      padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST
    }).toString('base64');
  }

  /* HMAC digest for joinToken — plaintext is never stored. */
  tokenHash(serverSecret, token) {
    return nodeCrypto.createHmac('sha256', serverSecret).update(token).digest('hex');
  }

  serverSecret() {
    const file = path.join(KEYS_DIR, 'server-secret');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, nodeCrypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    return fs.readFileSync(file, 'utf8').trim();
  }

  /* encrypt/decrypt short secrets (e.g. share codes) with a key derived from
   * the server secret. AES-256-GCM; DB-only leaks cannot recover the plaintext
   * bearer codes without also stealing the key file. */
  encryptSecret(plain) {
    const key = nodeCrypto.createHash('sha256').update(this.serverSecret()).digest();
    const iv = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
  }
  decryptSecret(blob) {
    if (!blob || blob.indexOf(':') === -1) return ''; // legacy plaintext row
    const key = nodeCrypto.createHash('sha256').update(this.serverSecret()).digest();
    const [ivB64, tagB64, ctB64] = blob.split(':');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
  }
}

module.exports = { KeyStore, b64u };
