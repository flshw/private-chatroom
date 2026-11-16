/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
/*
 * Private Chatroom shared protocol constants — CANONICAL SOURCE.
 * Independent from the main ChatRoom project: PC_* namespace, version 1.
 * UMD-style so the same file works in Node.js (CommonJS) and in the browser.
 * tools/build-client.js inlines it and syncs a byte-identical copy to
 * server/src/protocol.js so that server/ alone is a deployable unit.
 *
 * SECURITY CONTRACT (do not weaken):
 *   The server only ever sees public keys and ciphertext. There is no shared
 *   room key, no content key on the server, and no private key outside the
 *   member browsers. Every message uses a fresh K_msg, wrapped per member.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PROTOCOL_VERSION = 1;
  var PC_RELEASE_VERSION = '0.1.0';

  /* WebSocket message types — deliberately distinct from the main project. */
  var MSG = {
    JOIN: 'join',                       // C→S  {roomId, joinToken, nickname, ukPub, selfSig, clientTime, nonce}
    JOINED: 'joined',                   // S→C  {sessionId, serverTime, expiresAt, memberList, memberListSig, history[]}
    MEMBER_KEYS: 'member_keys',         // S→*  {memberList, memberListSig, version}
    MSG: 'msg',                         // C→S  {envelope, sig, senderPub}
    MSG_BROADCAST: 'msg_broadcast',     // S→*  above + fromSession
    RTC_SIGNAL: 'rtc_signal',           // ↔    {to, encryptedSignal}
    ROOM_EXPIRED: 'room_expired',       // S→C  {reason}
    ERROR: 'error',                     // S→C  {code, note?}
    PING: 'ping',
    PONG: 'pong'
  };

  /* Error codes. Room-invalid deliberately collapses not-found/expired/bad
   * token so a caller cannot enumerate rooms. */
  var ERR = {
    ROOM_INVALID: 'E_ROOM_INVALID',
    ROOM_FULL: 'E_ROOM_FULL',
    REPLAY: 'E_REPLAY',
    RATE_LIMIT: 'E_RATE_LIMIT',
    SIG_INVALID: 'E_SIG_INVALID',
    WRAP_INCOMPLETE: 'E_WRAP_INCOMPLETE',
    KEY_INVALID: 'E_KEY_INVALID',
    BAD_VERSION: 'E_BAD_VERSION',
    BAD_ENVELOPE: 'E_BAD_ENVELOPE',
    NOT_AUTHENTICATED: 'E_NOT_AUTHENTICATED',
    EXPIRED: 'E_EXPIRED',
    INTERNAL: 'E_INTERNAL'
  };

  /* Limits. Tuned for N ≤ 20 members with per-member RSA-OAEP wrapping. */
  var LIMITS = {
    MAX_FRAME_BYTES: 1 << 20,           // 1 MiB per WS frame
    MAX_HTTP_BODY_BYTES: 12 * 1024 * 1024, // base64 file upload envelope
    MAX_MSG_BYTES: 256 * 1024,          // plaintext text message ceiling
    MAX_FILE_BYTES: 8 * 1024 * 1024,    // 8 MiB ciphertext blob
    MAX_NICKNAME_CHARS: 24,
    MAX_ROOM_NAME_CHARS: 40,
    DEFAULT_TTL_SECONDS: 86400,         // 24 hours (Q-04 default)
    MAX_TTL_SECONDS: 259200,            // 72 hours hard ceiling
    MIN_TTL_SECONDS: 60,
    DEFAULT_MAX_MEMBERS: 6,
    HARD_MAX_MEMBERS: 20,
    QUOTA_ROOMS_PER_USER: 3,
    SESSION_TTL_SECONDS: 7 * 24 * 3600,
    HEARTBEAT_MS: 25000,
    CLOCK_TOLERANCE_MS: 5 * 60 * 1000,  // serverTime correction keeps skew in check
    IV_BYTES: 12,
    TAG_BYTES: 16,
    KEY_BYTES: 32,
    RSA_BITS: 2048,
    TOKEN_BYTES: 32,
    ROOM_ID_BYTES: 16,
    SID_BYTES: 16
  };

  /* Defaults used both by the apply form and the server validator. */
  var DEFAULTS = {
    publicPrefix: '/Pchat',
    apiPrefix: '/pc/api',
    wsPath: '/pc/ws',
    statusPath: '/pc/api/room',
    serverUrl: 'https://flshw.online'
  };

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    PC_RELEASE_VERSION: PC_RELEASE_VERSION,
    MSG: MSG,
    ERR: ERR,
    LIMITS: LIMITS,
    DEFAULTS: DEFAULTS,
    /* The signed part of an envelope. `meta` is display-only and excluded so
     * that stored/replayed envelopes verify byte-for-byte on every client.
     * Both server and browser MUST use this exact projection for RSA-PSS. */
    signedPart: function (e) {
      var out = {};
      ['v', 'roomId', 'senderSid', 'seq', 'ts', 'kind', 'iv', 'ct', 'tag', 'wraps']
        .forEach(function (k) { out[k] = e[k]; });
      return out;
    },
    /* Canonical JSON: recursively sort object keys. Both config signature and
     * message signature depend on byte-for-byte agreement between browser and
     * server, so this function is intentionally dependency-free and shared. */
    canonicalJSON: function canonicalJSON(value) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
      var keys = Object.keys(value).sort();
      return '{' + keys.map(function (k) {
        return JSON.stringify(k) + ':' + canonicalJSON(value[k]);
      }).join(',') + '}';
    }
  };
});
