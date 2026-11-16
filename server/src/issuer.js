/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Client issuer — the core of this project.
 * On issue: generate roomId + joinToken + a fresh RK key pair, assemble a
 * signed config block that contains TWO PUBLIC KEYS (RK_pub, SSK_pub) and the
 * join token, then bake it into the template. No content key, no private key,
 * no symmetric room key is ever produced here.
 */
const fs = require('fs');
const nodeCrypto = require('crypto');
const P = require('./protocol');
const { TEMPLATE_FILE, DELUXE_TEMPLATE_FILE, config } = require('./paths');

function safeJs(s) { return String(s).replace(/<\/script/gi, '<\\/script'); }

/* Strip characters that could break filenames or HTTP headers. */
function cleanFilename(name) {
  /* HTTP header values must be ASCII; keep a short latin/sanitised token. */
  const cleaned = String(name || 'room').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return cleaned || 'room';
}

class Issuer {
  constructor(db, keyStore, canonicalJSON, logger) {
    this.db = db;
    this.keys = keyStore;
    this.canonical = canonicalJSON;
    this.logger = logger || (() => {});
    this.templates = {}; // edition -> html
  }

  loadTemplate(edition) {
    edition = edition === 'deluxe' ? 'deluxe' : 'lite';
    if (!this.templates[edition]) {
      const file = edition === 'deluxe' ? DELUXE_TEMPLATE_FILE : TEMPLATE_FILE;
      if (!fs.existsSync(file)) {
        throw new Error('客户端模板不存在，请先运行 node tools/build-client.js');
      }
      const tpl = fs.readFileSync(file, 'utf8');
      if (tpl.indexOf('__PC_CONFIG__') === -1) {
        throw new Error('客户端模板缺少 __PC_CONFIG__ 占位符');
      }
      this.templates[edition] = tpl;
    }
    return this.templates[edition];
  }

  /* Build the signed config block for a room and bake a one-shot HTML string.
   * Returns { html, filename, config, configSig, configDigest, joinToken,
   *           roomPubKey, roomPrivRef, creds }.
   * `creds` may be passed to reuse an existing joinToken + RK pair so that two
   * editions (download + share QR) share ONE admission credential. Caller
   * decides whether to persist room metadata (issue vs reissue). */
  build(roomMeta, serverSecret, edition, creds) {
    const template = this.loadTemplate(edition);
    const isDeluxe = edition === 'deluxe';
    const roomId = roomMeta.roomId;
    const joinToken = creds ? creds.joinToken
      : nodeCrypto.randomBytes(P.LIMITS.TOKEN_BYTES).toString('hex');
    const rk = creds ? creds.rk : this.keys.createRoomKey(roomId);
    const configObj = {
      v: P.PROTOCOL_VERSION,
      serverUrl: config.serverUrl,
      roomUrl: config.publicPrefix + '/p/' + roomId,
      wsUrl: config.wsPath,
      roomId: roomId,
      name: roomMeta.name,
      joinToken: joinToken,
      roomPubKey: rk.publicKeyPem,      // RK_pub — verifies member list signature
      serverPubKey: this.keys.ssk.publicKeyPem, // SSK_pub — verifies config signature
      issuedAt: roomMeta.issuedAt,
      expiresAt: roomMeta.expiresAt,
      maxMembers: roomMeta.maxMembers,
      clientVersion: P.PC_RELEASE_VERSION,
      edition: isDeluxe ? 'deluxe' : 'lite'
    };
    const sig = this.keys.signConfig(configObj, this.canonical);
    const digest = nodeCrypto.createHash('sha256')
      .update(this.canonical(configObj) + sig).digest('hex');
    const injected =
      'window.__PC_CONFIG__=' + JSON.stringify(configObj) + ';' +
      'window.__PC_CONFIG_SIG__=' + JSON.stringify(sig) + ';';
    const html = template.replace('/*__PC_CONFIG__*/', () => safeJs(injected));
    if (html.indexOf('/*__PC_CONFIG__*/') !== -1) throw new Error('配置块注入失败');
    const filename = 'private-chat-' + cleanFilename(roomMeta.name) + '-' + roomId.slice(0, 8) +
      (isDeluxe ? '-deluxe' : '') + '.html';
    return {
      html, filename, config: configObj, configSig: sig, configDigest: digest,
      joinToken, joinTokenHash: this.keys.tokenHash(serverSecret, joinToken),
      roomPubKey: rk.publicKeyPem, roomPrivRef: rk.ref,
      creds: { joinToken, rk }
    };
  }
}

module.exports = { Issuer, safeJs, cleanFilename };
