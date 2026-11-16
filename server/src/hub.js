/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Data plane. Handles WSS sessions and forwards ciphertext only.
 * It NEVER decrypts: validation is structural + signature + wrap-set checks,
 * then store ciphertext and broadcast. The server holds public keys only.
 *
 * JOIN flow: verify joinToken digest / status / TTL / capacity, register the
 * member's self-signed UK_pub, assign a sid, sign the full member list with
 * RK_priv (version monotonic), send JOINED and broadcast MEMBER_KEYS.
 */
const nodeCrypto = require('crypto');
const P = require('./protocol');

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }

class Hub {
  constructor(options) {
    this.db = options.db;
    this.keys = options.keys;
    this.rooms = options.rooms;   // Rooms instance (for status / destroy)
    this.canonical = options.canonicalJSON;
    this.logger = options.logger || (() => {});
    this.serverSecret = options.serverSecret || this.keys.serverSecret();
    this.sessions = new Set();
    this.byRoom = new Map();      // roomId -> Map<sid, session>
    this.memberVersion = new Map(); // roomId -> integer, monotonic
    this.rate = new Map();        // sid -> {count, windowAt}
    /* Message seq is per SENDER SESSION, not per room. Each member starts at
     * seq=1 when they JOIN (including an F5 reconnect with a fresh sid). */
    this.seqBySid = new Map();    // sid -> last accepted seq
    /* One-to-one spectator relations. Each observer (keyed by ukPub, stable
     * across reconnects) watches exactly ONE target player and needs that
     * target's consent. Once created the target is locked for the room's
     * lifetime — the observer cannot switch or add another target. The server
     * only arbitrates identity/consent; it never sees any cards. */
    this.spectators = new Map();  // roomId -> Map<spectatorUkPub, relation>
  }

  attach(session) {
    this.sessions.add(session);
    session.isAlive = true;
    return session;
  }

  detach(session) {
    this.sessions.delete(session);
    if (session.roomId && session.sid) {
      const room = this.byRoom.get(session.roomId);
      if (room) {
        room.delete(session.sid);
        this.seqBySid.delete(session.sid);
        if (room.size === 0) this.byRoom.delete(session.roomId);
        else this.broadcastMemberKeys(session.roomId);
      }
    }
  }

  roomMap(roomId) {
    if (!this.byRoom.has(roomId)) this.byRoom.set(roomId, new Map());
    return this.byRoom.get(roomId);
  }

  clearRoom(roomId) {
    const room = this.byRoom.get(roomId);
    if (room) for (const sid of room.keys()) this.seqBySid.delete(sid);
    this.byRoom.delete(roomId);
    this.memberVersion.delete(roomId);
    this.spectators.delete(roomId);
  }

  kickAll(roomId, reason) {
    const room = this.byRoom.get(roomId);
    if (room) for (const s of room.values()) s.send({
      type: P.MSG.ROOM_EXPIRED, reason: reason || 'reissued'
    });
  }

  broadcastExpired(roomId, reason) {
    const room = this.byRoom.get(roomId);
    if (room) for (const s of room.values()) s.send({
      type: P.MSG.ROOM_EXPIRED, reason: reason || 'expired'
    });
  }

  error(session, code, note) {
    session.send({ type: P.MSG.ERROR, code, note: note || undefined });
  }

  /* Build the signed member-public-key list for a room. */
  memberList(roomId) {
    const room = this.byRoom.get(roomId);
    const members = [];
    if (room) {
      for (const [sid, s] of room.entries()) {
        members.push({ sid, nickname: s.nickname, ukPub: s.ukPub,
          selfSig: s.selfSig, clientTime: s.clientTime });
      }
    }
    members.sort((a, b) => a.sid.localeCompare(b.sid));
    return { version: this.memberVersion.get(roomId) || 1, roomId, members };
  }

  broadcastMemberKeys(roomId) {
    const dbRoom = this.db.room(roomId);
    if (!dbRoom) return;
    const version = (this.memberVersion.get(roomId) || 1) + 1;
    this.memberVersion.set(roomId, version);
    const list = this.memberList(roomId);
    list.version = version;
    let sig;
    try { sig = this.keys.signMemberList(list, roomId, dbRoom.room_priv_ref, this.canonical); }
    catch (e) { this.logger('成员清单签名失败: ' + e.message); return; }
    const room = this.byRoom.get(roomId);
    if (room) for (const s of room.values()) {
      s.send({ type: P.MSG.MEMBER_KEYS, memberList: list, memberListSig: sig, version });
    }
  }

  handle(session, frame) {
    if (!frame || typeof frame !== 'object' || !frame.type) {
      return this.error(session, P.ERR.BAD_ENVELOPE);
    }
    if (frame.type === P.MSG.PING) { session.send({ type: P.MSG.PONG, ts: frame.ts || Date.now() }); return; }
    if (frame.type === P.MSG.JOIN) return this.onJoin(session, frame);
    if (!session.joined) return this.error(session, P.ERR.NOT_AUTHENTICATED);
    if (frame.type === P.MSG.MSG) return this.onMessage(session, frame);
    if (frame.type === P.MSG.RTC_SIGNAL) return this.onRtc(session, frame);
    if (frame.type === P.MSG.GAME_SPECTATE) return this.onSpectate(session, frame);
    if (frame.type === P.MSG.GAME_SPECTATE_REPLY) return this.onSpectateReply(session, frame);
    return this.error(session, P.ERR.BAD_ENVELOPE);
  }

  onJoin(session, f) {
    if (session.joined) return; // ignore duplicate joins
    const roomId = String(f.roomId || '');
    const room = this.db.room(roomId);
    const now = Date.now();
    // Deliberately uniform error: no room enumeration.
    const invalid = () => this.error(session, P.ERR.ROOM_INVALID);
    if (!room || ['destroyed', 'destroying', 'revoked'].indexOf(room.status) !== -1) return invalid();
    if (room.expires_at <= now) {
      this.rooms.destroy(roomId, 'expired');
      return invalid();
    }
    const tokenHash = this.keys.tokenHash(this.serverSecret, String(f.joinToken || ''));
    if (tokenHash !== room.join_token_hash) return invalid();

    const nickname = String(f.nickname || '').trim().slice(0, P.LIMITS.MAX_NICKNAME_CHARS);
    if (!nickname) return this.error(session, P.ERR.BAD_ENVELOPE);
    const ukPub = String(f.ukPub || '');
    const selfSig = String(f.selfSig || '');
    if (ukPub.length < 100 || selfSig.length < 50) return this.error(session, P.ERR.KEY_INVALID);
    // Verify the member's self-signature: RSA-PSS(UK_priv, canonical({roomId,ukPub,nickname,clientTime}))
    const signedObj = { roomId, ukPub, nickname, clientTime: f.clientTime };
    let selfOk = false;
    try {
      selfOk = nodeCrypto.verify('sha256', Buffer.from(this.canonical(signedObj), 'utf8'), {
        key: ukPub, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST
      }, Buffer.from(selfSig, 'base64'));
    } catch (e) { selfOk = false; }
    if (!selfOk) return this.error(session, P.ERR.SIG_INVALID);

    const map = this.roomMap(roomId);
    if (map.size >= room.max_members) return this.error(session, P.ERR.ROOM_FULL);

    // Accept. Assign a random sid that is not a member of this room yet.
    let sid;
    do { sid = 's_' + nodeCrypto.randomBytes(P.LIMITS.SID_BYTES).toString('hex'); }
    while (map.has(sid));

    session.joined = true;
    session.roomId = roomId;
    session.sid = sid;
    session.nickname = nickname;
    session.ukPub = ukPub;
    session.selfSig = selfSig;
    session.clientTime = f.clientTime;
    map.set(sid, session);
    this.seqBySid.set(sid, 0);
    this.db.setRoomStatus(roomId, 'active');
    this.db.audit('member_joined', roomId, now);

    const list = this.memberList(roomId);
    const sig = this.keys.signMemberList(list, roomId, room.room_priv_ref, this.canonical);
    // History: ciphertext only, for same-session members who reconnect.
    const history = this.db.messagesSince(roomId, 0, now)
      .map(m => this.messageEnvelope(m));
    session.send({
      type: P.MSG.JOINED,
      sessionId: sid, serverTime: now, expiresAt: room.expires_at,
      memberList: list, memberListSig: sig, history,
      spectate: this.publicSpectators(roomId)
    });
    this.broadcastMemberKeys(roomId);
  }

  messageEnvelope(m) {
    return {
      v: P.PROTOCOL_VERSION, roomId: m.room_id, senderSid: m.sender_session,
      seq: m.seq, ts: m.ts, kind: m.kind,
      iv: m.iv, ct: m.ct, tag: m.tag,
      wraps: JSON.parse(m.wraps_json), meta: null,
      sig: m.sig, senderPub: m.sender_pub
    };
  }

  /* Rate limit: simple fixed window per sid. */
  allow(session) {
    const now = Date.now();
    let r = this.rate.get(session.sid);
    if (!r || now - r.windowAt >= 1000) { r = { count: 0, windowAt: now }; this.rate.set(session.sid, r); }
    r.count++;
    return r.count <= 20;
  }

  onMessage(session, f) {
    if (!this.allow(session)) return this.error(session, P.ERR.RATE_LIMIT);
    const e = f.envelope;
    if (!e || typeof e !== 'object') return this.error(session, P.ERR.BAD_ENVELOPE);
    const roomId = session.roomId;
    const room = this.db.room(roomId);
    if (!room || room.expires_at <= Date.now()) return this.error(session, P.ERR.ROOM_INVALID);
    if (e.roomId !== roomId || e.senderSid !== session.sid) return this.error(session, P.ERR.BAD_ENVELOPE);
    if (e.v !== P.PROTOCOL_VERSION) return this.error(session, P.ERR.BAD_VERSION);
    // Strictly increasing seq PER SENDER SESSION. A room-global counter made
    // every second member's first message fail with E_REPLAY.
    const expected = (this.seqBySid.get(session.sid) || 0) + 1;
    if (e.seq !== expected) return this.error(session, P.ERR.REPLAY);
    // Clock tolerance using server-corrected time.
    if (Math.abs(Number(e.ts) - Date.now()) > P.LIMITS.CLOCK_TOLERANCE_MS) {
      return this.error(session, P.ERR.REPLAY);
    }
    // Sender public key must match the registered one.
    const senderPub = String(f.senderPub || '');
    if (senderPub !== session.ukPub) return this.error(session, P.ERR.KEY_INVALID);
    // wraps must cover exactly the current member set — prevents excluding someone.
    const wraps = e.wraps;
    if (!wraps || typeof wraps !== 'object' || Array.isArray(wraps)) {
      return this.error(session, P.ERR.WRAP_INCOMPLETE);
    }
    const map = this.byRoom.get(roomId) || new Map();
    const sids = Array.from(map.keys()).sort().join('\u0001');
    const wrapSids = Object.keys(wraps).sort().join('\u0001');
    if (sids !== wrapSids) return this.error(session, P.ERR.WRAP_INCOMPLETE);
    // Verify sender's RSA-PSS signature over canonical(envelope).
    let sigOk = false;
    try {
      sigOk = nodeCrypto.verify('sha256', Buffer.from(this.canonical(P.signedPart(e)), 'utf8'), {
        key: senderPub, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST
      }, Buffer.from(String(f.sig || ''), 'base64'));
    } catch (err) { sigOk = false; }
    if (!sigOk) return this.error(session, P.ERR.SIG_INVALID);

    const ts = Date.now();
    const m = {
      roomId, seq: e.seq, senderSession: session.sid, ts: e.ts,
      kind: String(e.kind || 'text').slice(0, 16),
      iv: String(e.iv), ct: String(e.ct), tag: String(e.tag),
      wrapsJson: JSON.stringify(wraps), senderPub, sig: String(f.sig),
      expiresAt: room.expires_at
    };
    // Best-effort size guards (base64 fields already bounded by WS frame limit).
    if (!m.iv || !m.ct || !m.tag) return this.error(session, P.ERR.BAD_ENVELOPE);
    this.db.addMessage(m);
    this.seqBySid.set(session.sid, e.seq);
    const broadcast = Object.assign({}, e, { fromSession: session.sid });
    delete broadcast.sig;
    delete broadcast.senderPub;
    const out = { type: P.MSG.MSG_BROADCAST, envelope: broadcast, sig: f.sig, senderPub };
    for (const s of map.values()) s.send(out);
  }

  onRtc(session, f) {
    // Server forwards only; the payload is expected to be RSA-OAEP wrapped to
    // the target member, so SDP/IP never appears in plaintext here.
    const to = String(f.to || '');
    const room = this.byRoom.get(session.roomId);
    if (!room || !room.has(to)) return this.error(session, P.ERR.BAD_ENVELOPE);
    room.get(to).send({
      type: P.MSG.RTC_SIGNAL, from: session.sid,
      encryptedSignal: String(f.encryptedSignal || '').slice(0, P.LIMITS.MAX_FRAME_BYTES)
    });
  }

  /* --- One-to-one spectator relations (consent required, target locked) ---
   * An observer requests to watch ONE specific player (targetSid). The target
   * must explicitly accept. Once a relation exists for an observer (keyed by
   * ukPub) its target is locked for the room's lifetime: no switching, no
   * second target. Reconnect (new sid) with the same ukPub restores the same
   * relation. The server arbitrates identity + consent only; never cards. */
  spectateMap(roomId) {
    if (!this.spectators.has(roomId)) this.spectators.set(roomId, new Map());
    return this.spectators.get(roomId);
  }

  onSpectate(session, frame) {
    if (!session.joined) return this.error(session, P.ERR.NOT_AUTHENTICATED);
    const roomId = session.roomId;
    const gameId = String(frame.gameId || 'main').slice(0, 32);
    const targetSid = String(frame.targetSid || '');
    const room = this.byRoom.get(roomId);
    if (!room) return this.error(session, P.ERR.SPECTATE_TARGET_INVALID);
    const map = this.spectateMap(roomId);

    // Existing relation for this observer: locked to its target. A reconnect
    // (no/equal targetSid) refreshes the sid; naming a DIFFERENT target is a
    // forbidden switch and must be rejected.
    for (const rel of map.values()) {
      if (rel.spectatorUkPub === session.ukPub) {
        if (targetSid && targetSid !== rel.targetSid) {
          return this.error(session, P.ERR.SPECTATOR_LIMIT);
        }
        rel.spectatorSid = session.sid;      // reconnect keeps the same locked target
        if (rel.status === 'approved') session.spectator = true;
        session.send({ type: P.MSG.GAME_SPECTATE_STATE, gameId,
          spectate: this.publicSpectators(roomId), self: this.publicRelation(rel) });
        return;
      }
    }
    // Already watching someone (as the target of another? no) — observers are
    // limited to one relation. A player who is themselves being watched may
    // still observe another only if they have no relation as observer.
    if (targetSid === session.sid || !room.has(targetSid)) {
      return this.error(session, P.ERR.SPECTATE_TARGET_INVALID);
    }
    // Target must not already be watched by a different observer (one target ->
    // at most one watcher keeps the "cannot be replaced" property simple).
    for (const rel of map.values()) {
      if (rel.targetSid === targetSid) return this.error(session, P.ERR.SPECTATE_TARGET_INVALID);
    }
    const target = room.get(targetSid);
    const rel = {
      spectatorUkPub: session.ukPub, spectatorSid: session.sid,
      spectatorNickname: session.nickname,
      targetSid, targetUkPub: target.ukPub, targetNickname: target.nickname,
      status: 'pending', createdAt: Date.now(), gameId
    };
    map.set(session.ukPub, rel);
    this.db.audit('spectate_request', roomId, Date.now());
    this.logger('旁观申请: ' + session.nickname + ' -> ' + target.nickname + ' (待同意)');
    this.broadcastSpectate(roomId, gameId);
  }

  onSpectateReply(session, frame) {
    if (!session.joined) return this.error(session, P.ERR.NOT_AUTHENTICATED);
    const roomId = session.roomId;
    const gameId = String(frame.gameId || 'main').slice(0, 32);
    const spectatorSid = String(frame.spectatorSid || '');
    const accept = frame.accept === true;
    const map = this.spectators.get(roomId);
    if (!map) return this.error(session, P.ERR.SPECTATE_NO_REQUEST);
    let found = null;
    for (const rel of map.values()) if (rel.spectatorSid === spectatorSid) { found = rel; break; }
    if (!found || found.status !== 'pending') return this.error(session, P.ERR.SPECTATE_NO_REQUEST);
    // Only the watched target may answer (matched by ukPub, stable on reconnect).
    if (found.targetUkPub !== session.ukPub) return this.error(session, P.ERR.SPECTATE_NOT_TARGET);
    if (!accept) {
      map.delete(found.spectatorUkPub); // declined: observer may request another target
      this.db.audit('spectate_declined', roomId, Date.now());
      this.logger('旁观被拒: ' + found.targetNickname + ' 拒绝 ' + found.spectatorNickname);
      const obs = this.byRoom.get(roomId) && this.byRoom.get(roomId).get(found.spectatorSid);
      if (obs) obs.send({ type: P.MSG.ERROR, code: 'E_SPECTATE_DECLINED' });
    } else {
      found.status = 'approved';
      found.approvedAt = Date.now();
      const obs = this.byRoom.get(roomId) && this.byRoom.get(roomId).get(found.spectatorSid);
      if (obs) obs.spectator = true;
      this.db.audit('spectate_approved', roomId, Date.now());
      this.logger('旁观已同意: ' + found.targetNickname + ' 允许 ' + found.spectatorNickname);
    }
    this.broadcastSpectate(roomId, gameId);
  }

  broadcastSpectate(roomId, gameId) {
    const room = this.byRoom.get(roomId);
    if (!room) return;
    const frame = { type: P.MSG.GAME_SPECTATE_STATE, gameId, spectate: this.publicSpectators(roomId) };
    for (const s of room.values()) s.send(frame);
    // Also tell each observer its own relation (incl. pending target / self flag).
    for (const rel of this.spectateMap(roomId).values()) {
      const obs = room.get(rel.spectatorSid);
      if (obs) obs.send({ type: P.MSG.GAME_SPECTATE_STATE, gameId,
        spectate: this.publicSpectators(roomId), self: this.publicRelation(rel) });
    }
  }

  publicSpectators(roomId) {
    const map = this.spectators.get(roomId);
    if (!map) return [];
    return Array.from(map.values()).map(rel => this.publicRelation(rel));
  }

  publicRelation(rel) {
    return {
      spectatorSid: rel.spectatorSid, spectatorNickname: rel.spectatorNickname,
      targetSid: rel.targetSid, targetNickname: rel.targetNickname,
      status: rel.status, gameId: rel.gameId,
      claimedAt: rel.claimedAt, approvedAt: rel.approvedAt || null
    };
  }

  onlineCount(roomId) {
    const map = this.byRoom.get(roomId);
    return map ? map.size : 0;
  }

  stats() {
    let clients = 0;
    for (const m of this.byRoom.values()) clients += m.size;
    return { ok: true, clients, rooms: this.byRoom.size, version: P.PC_RELEASE_VERSION };
  }
}

module.exports = { Hub };
