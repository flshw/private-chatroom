/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom crypto core. */
'use strict';
/*
 * Client-side cryptographic core, built on the inlined forge library.
 *
 * Why forge instead of WebCrypto: a single WebCrypto RSA key pair cannot be
 * used for both RSA-OAEP (wrapping) and RSA-PSS (signing) — the usages are
 * mutually exclusive, and Node's WebCrypto lacks RSASSA-PSS entirely. The
 * main project already validated forge<->Node crypto interoperability for
 * PSS, OAEP and AES-GCM, and forge is already inlined in this template, so
 * using it keeps file:// operation self-contained and cross-verified.
 *
 * All private keys and content keys live only in this browser. The server
 * never receives a private key or a content key.
 *   UK_i     RSA-2048 member key, generated locally on entering a room
 *   K_msg    fresh AES-256 key per message, wrapped per member with RSA-OAEP
 *   AES-GCM  12B IV + 16B tag, AAD binds room/sender/seq/ts/kind
 *   RSA-PSS  sign canonical(envelope), verify self-sigs + member list sig
 */
window.PCCrypto = (function () {
  var forge = window.forge;
  var root = window;

  function oaepOptions() {
    return { md: forge.md.sha256.create(), mgf1: { md: forge.md.sha256.create() } };
  }
  function pssOptions() {
    return forge.pss.create({
      md: forge.md.sha256.create(),
      mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
      saltLength: 32
    });
  }

  function available() { return !!(forge && forge.pki && forge.md && forge.pss); }
  function randomBytes(n) { return forge.random.getBytesSync(n); }
  function b64(str) { return forge.util.encode64(str); }
  function unb64(str) { return forge.util.decode64(str); }
  function bufToHex(str) { return forge.util.bytesToHex(str).toLowerCase(); }

  function publicKeyPem(key) { return forge.pki.publicKeyToPem(key); }
  function privateKeyPem(key) { return forge.pki.privateKeyToPem(key); }
  function pemToPublic(pem) { return forge.pki.publicKeyFromPem(pem); }
  function pemToPrivate(pem) { return forge.pki.privateKeyFromPem(pem); }

  /* Generate a member RSA-2048 key pair. Returns PEM strings + spki b64. */
  function generateUK() {
    var kp = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    var pubPem = publicKeyPem(kp.publicKey);
    var privPem = privateKeyPem(kp.privateKey);
    var pubDer = forge.asn1.toDer(forge.pki.publicKeyToAsn1(kp.publicKey)).getBytes();
    return { privatePem: privPem, publicPem: pubPem, pubB64: b64(pubDer), kp: kp };
  }

  function importPublic(pemOrB64, usages) {
    if (/BEGIN PUBLIC KEY/.test(pemOrB64)) return pemToPublic(pemOrB64);
    var der = forge.util.decode64(pemOrB64);
    return forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(der));
  }
  function importPrivate(pem) { return pemToPrivate(pem); }
  function importVerifyKey(pemOrB64) { return importPublic(pemOrB64, ['verify']); }

  /* RSA-PSS-SHA256 sign over canonical JSON bytes. */
  function sign(canonicalObj, privatePem) {
    var md = forge.md.sha256.create();
    md.update(root.PCProtocol.canonicalJSON(canonicalObj), 'utf8');
    return b64(pemToPrivate(privatePem).sign(md, pssOptions()));
  }
  function verifySig(canonicalObj, sigB64, pubKeyOrPem) {
    try {
      var key = typeof pubKeyOrPem === 'string' ? importVerifyKey(pubKeyOrPem) : pubKeyOrPem;
      var md = forge.md.sha256.create();
      md.update(root.PCProtocol.canonicalJSON(canonicalObj), 'utf8');
      return key.verify(md.digest().bytes(), unb64(sigB64), pssOptions());
    } catch (e) { return false; }
  }

  /* AES-256-GCM encrypt/decrypt. keyRaw is a forge binary string (32 bytes). */
  function aesEncrypt(keyRaw, aadString, plaintextStr) {
    var iv = randomBytes(12);
    var cipher = forge.cipher.createCipher('AES-GCM', keyRaw);
    cipher.start({ iv: iv, tagLength: 128, additionalData: forge.util.createBuffer(aadString, 'utf8') });
    cipher.update(forge.util.createBuffer(plaintextStr, 'utf8'));
    if (!cipher.finish()) throw new Error('AES-GCM 加密失败');
    return { iv: b64(iv), ct: b64(cipher.output.getBytes()), tag: b64(cipher.mode.tag.getBytes()) };
  }
  function aesDecrypt(keyRaw, aadString, ivB64, ctB64, tagB64) {
    var decipher = forge.cipher.createDecipher('AES-GCM', keyRaw);
    decipher.start({
      iv: unb64(ivB64), tagLength: 128,
      tag: forge.util.createBuffer(unb64(tagB64)),
      additionalData: forge.util.createBuffer(aadString, 'utf8')
    });
    decipher.update(forge.util.createBuffer(unb64(ctB64)));
    if (!decipher.finish()) throw new Error('GCM 认证失败');
    return decipher.output.toString('utf8');
  }

  /* Binary-safe variants for file/voice and RTC signaling payloads.
   * The plain aesEncrypt/aesDecrypt above stay UTF-8 text APIs so that the
   * message protocol and all existing signatures remain byte-identical. */
  function bytesToBinary(bytes) {
    if (typeof bytes === 'string') return bytes;
    var arr = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
    var out = '', chunk = 0x8000;
    for (var i = 0; i < arr.length; i += chunk) {
      out += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return out;
  }
  function binaryToBytes(binary) {
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
    return out;
  }
  function aesEncryptBytes(keyRaw, aadString, bytes) {
    var iv = randomBytes(12);
    var cipher = forge.cipher.createCipher('AES-GCM', keyRaw);
    cipher.start({ iv: iv, tagLength: 128, additionalData: forge.util.createBuffer(aadString, 'utf8') });
    cipher.update(forge.util.createBuffer(bytesToBinary(bytes)));
    if (!cipher.finish()) throw new Error('AES-GCM 加密失败');
    return { iv: b64(iv), ct: b64(cipher.output.getBytes()), tag: b64(cipher.mode.tag.getBytes()) };
  }
  function aesDecryptBytes(keyRaw, aadString, ivB64, ctB64, tagB64) {
    var decipher = forge.cipher.createDecipher('AES-GCM', keyRaw);
    decipher.start({
      iv: unb64(ivB64), tagLength: 128,
      tag: forge.util.createBuffer(unb64(tagB64)),
      additionalData: forge.util.createBuffer(aadString, 'utf8')
    });
    decipher.update(forge.util.createBuffer(unb64(ctB64)));
    if (!decipher.finish()) throw new Error('GCM 认证失败');
    return binaryToBytes(decipher.output.getBytes());
  }

  /* RSA-OAEP wrap/unwrap a 32-byte content key. */
  function wrapKey(keyRaw, pubB64) {
    var key = importPublic(pubB64, ['encrypt']);
    return b64(key.encrypt(keyRaw, 'RSA-OAEP', oaepOptions()));
  }
  function unwrapKey(wrapB64, privatePem) {
    return pemToPrivate(privatePem).decrypt(unb64(wrapB64), 'RSA-OAEP', oaepOptions());
  }

  /* The full send-side protocol. members: [{sid, ukPub(PEM)}], me included. */
  function buildMessage(plaintextStr, ctx) {
    var config = ctx.config, sid = ctx.mySid, seq = ctx.seq, serverTs = ctx.serverTs;
    var kind = ctx.kind || 'text';
    var K = randomBytes(32);
    var aad = config.roomId + '|' + sid + '|' + seq + '|' + serverTs + '|' + kind;
    var enc = aesEncrypt(K, aad, plaintextStr);
    var wraps = {};
    for (var i = 0; i < ctx.members.length; i++) {
      var m = ctx.members[i];
      wraps[m.sid] = wrapKey(K, m.ukPub);
    }
    var envelope = {
      v: root.PCProtocol.PROTOCOL_VERSION, roomId: config.roomId, senderSid: sid,
      seq: seq, ts: serverTs, kind: kind,
      iv: enc.iv, ct: enc.ct, tag: enc.tag, wraps: wraps, meta: null
    };
    var sig = sign(root.PCProtocol.signedPart(envelope), ctx.uk.privatePem);
    return { type: root.PCProtocol.MSG.MSG, envelope: envelope, sig: sig, senderPub: ctx.uk.publicPem };
  }

  /* Receive-side: unwrap K_msg with my private key, decrypt, verify signature. */
  function openMessage(envelope, sig, senderPub, mySid, ukPrivatePem, senderUkPub) {
    if (!envelope.wraps || !envelope.wraps[mySid]) throw new Error('本条消息未向我封装');
    var K = unwrapKey(envelope.wraps[mySid], ukPrivatePem);
    var aad = envelope.roomId + '|' + envelope.senderSid + '|' + envelope.seq + '|' + envelope.ts + '|' + envelope.kind;
    var plain = aesDecrypt(K, aad, envelope.iv, envelope.ct, envelope.tag);
    var verifyWith = senderUkPub || senderPub;
    if (!verifySig(root.PCProtocol.signedPart(envelope), sig, verifyWith)) {
      throw new Error('消息签名校验失败');
    }
    return plain;
  }

  return {
    available: available, randomBytes: randomBytes, b64: b64, unb64: unb64, bufToHex: bufToHex,
    generateUK: generateUK, sign: sign, verifySig: verifySig,
    aesEncrypt: aesEncrypt, aesDecrypt: aesDecrypt,
    aesEncryptBytes: aesEncryptBytes, aesDecryptBytes: aesDecryptBytes,
    bytesToBinary: bytesToBinary, binaryToBytes: binaryToBytes,
    wrapKey: wrapKey, unwrapKey: unwrapKey,
    buildMessage: buildMessage, openMessage: openMessage,
    importPublic: importPublic, importPrivate: importPrivate, importVerifyKey: importVerifyKey,
    publicKeyPem: publicKeyPem, privateKeyPem: privateKeyPem,
    pemToPublic: pemToPublic, pemToPrivate: pemToPrivate
  };
})();
