/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Share links — QR codes that open the online client directly.
 *
 * A share code is a high-entropy bearer capability. It maps (via SHA-256) to a
 * cached, already-signed client HTML for a room+edition. The plaintext code is
 * ONLY carried in the QR/URL; the server stores just its digest and the HTML is
 * cached under that digest. Presenting the code is equivalent to presenting a
 * downloaded client file (both carry the same joinToken) — that is the point of
 * sharing. Rotating a room (reissue) or destroying it invalidates old codes.
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { SHARES_DIR, config } = require('./paths');

function sha256(s) { return nodeCrypto.createHash('sha256').update(String(s)).digest('hex'); }
function codePath(hash) { return path.join(SHARES_DIR, hash + '.html'); }

class Shares {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger || (() => {});
    if (!fs.existsSync(SHARES_DIR)) fs.mkdirSync(SHARES_DIR, { recursive: true });
  }

  /* Replace any existing share codes for a room with a fresh lite+deluxe pair.
   * htmlByEdition: { lite: '<html>', deluxe: '<html>' }. Returns URLs. */
  publish(roomId, htmlByEdition) {
    this.revoke(roomId); // rotate: previous QR codes stop working immediately
    const now = Date.now();
    const out = {};
    ['lite', 'deluxe'].forEach(edition => {
      const html = htmlByEdition[edition];
      if (!html) return;
      const code = nodeCrypto.randomBytes(18).toString('base64url'); // 144-bit
      const hash = sha256(code);
      fs.writeFileSync(codePath(hash), html, { mode: 0o600 });
      this.db.addShare(hash, code, roomId, edition, now);
      out[edition] = {
        code: code,
        path: config.publicPrefix + '/s/' + code,
        url: config.serverUrl.replace(/\/$/, '') + config.publicPrefix + '/s/' + code
      };
    });
    return out;
  }

  /* Resolve a presented code to cached HTML if the room is still joinable. */
  resolve(code) {
    const hash = sha256(code);
    const row = this.db.shareByHash(hash);
    if (!row) return null;
    const room = this.db.room(row.room_id);
    const now = Date.now();
    if (!room || ['destroyed', 'destroying', 'revoked'].indexOf(room.status) !== -1) return null;
    if (room.expires_at <= now || room.revoke_at) return null;
    const file = codePath(hash);
    if (!fs.existsSync(file)) return null;
    return { roomId: row.room_id, edition: row.edition, html: fs.readFileSync(file, 'utf8') };
  }

  /* Delete all share codes + cached HTML for a room. */
  revoke(roomId) { return this.db.deleteSharesByRoom(roomId); }
}

module.exports = { Shares, sha256 };
