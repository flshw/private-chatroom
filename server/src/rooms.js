/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * Room control plane: apply (auto-approve), issue via the issuer, reissue,
 * revoke, dissolve, and the TTL-driven destruction cascade. A room's life is
 * a first-class citizen: every data row carries expires_at and there is a
 * single idempotent destruction path.
 */
const nodeCrypto = require('crypto');
const P = require('./protocol');
const { config } = require('./paths');

const SENSITIVE_WORDS = ['admin', 'root', '系统', '官方', '客服', '管理员'];

class Rooms {
  constructor(db, keyStore, issuer, accounts, hub, logger) {
    this.db = db;
    this.keys = keyStore;
    this.issuer = issuer;
    this.accounts = accounts;
    this.hub = hub;
    this.logger = logger || (() => {});
    this.serverSecret = this.keys.serverSecret();
  }

  validateApply(body) {
    const name = String(body.name || '').trim();
    if (!name || name.length > P.LIMITS.MAX_ROOM_NAME_CHARS) {
      throw Object.assign(new Error('房间名须为 1–40 字符'), { status: 400 });
    }
    if (/[<>\r\n"']/.test(name)) throw Object.assign(new Error('房间名含非法字符'), { status: 400 });
    const lower = name.toLowerCase();
    if (SENSITIVE_WORDS.some(w => lower.indexOf(w) !== -1)) {
      throw Object.assign(new Error('房间名含保留词'), { status: 400 });
    }
    const rawTtl = body.ttlSeconds;
    const ttl = rawTtl === undefined || rawTtl === null || rawTtl === ''
      ? P.LIMITS.DEFAULT_TTL_SECONDS : Number(rawTtl);
    if (!Number.isInteger(ttl) || ttl < P.LIMITS.MIN_TTL_SECONDS || ttl > P.LIMITS.MAX_TTL_SECONDS) {
      throw Object.assign(new Error('生命期须在 60–259200 秒之间'), { status: 400 });
    }
    const maxMembers = body.maxMembers === undefined ? P.LIMITS.DEFAULT_MAX_MEMBERS : Number(body.maxMembers);
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > config.hardMaxMembers) {
      throw Object.assign(new Error('人数上限须在 2–' + config.hardMaxMembers + ' 之间'), { status: 400 });
    }
    return { name, ttlSeconds: ttl, maxMembers };
  }

  /* Apply → auto-approve → issue, in one logical operation. */
  apply(user, body) {
    const v = this.validateApply(body);
    const active = this.accounts.activeRoomCount(user.id);
    if (active >= (user.quota_rooms || config.maxRoomsPerUser)) {
      throw Object.assign(new Error('活跃房间已达配额上限'), { status: 403 });
    }
    const roomId = 'r_' + nodeCrypto.randomBytes(P.LIMITS.ROOM_ID_BYTES).toString('hex');
    const now = Date.now();
    const meta = {
      roomId, name: v.name, ttlSeconds: v.ttlSeconds, maxMembers: v.maxMembers,
      issuedAt: now, expiresAt: now + v.ttlSeconds * 1000
    };
    const edition = body.edition === 'deluxe' ? 'deluxe' : 'lite';
    // One credential for the room; both editions (download + QR) reuse it.
    const built = this.issuer.build(meta, this.serverSecret, edition);
    const other = this.issuer.build(meta, this.serverSecret,
      edition === 'deluxe' ? 'lite' : 'deluxe', built.creds);
    this.db.createRoom({
      id: roomId, ownerId: user.id, name: v.name, status: 'issued',
      ttlSeconds: v.ttlSeconds, maxMembers: v.maxMembers,
      createdAt: now, issuedAt: now, expiresAt: meta.expiresAt,
      joinTokenHash: built.joinTokenHash, configDigest: built.configDigest,
      roomPubKey: built.roomPubKey, roomPrivRef: built.roomPrivRef, sigCount: 1
    });
    this.db.audit('room_issued', roomId, now);
    const htmlByEdition = {};
    htmlByEdition[edition] = built.html;
    htmlByEdition[edition === 'deluxe' ? 'lite' : 'deluxe'] = other.html;
    const qr = this.shares ? this.shares.publish(roomId, htmlByEdition) : null;
    this.logger('房间已签发: ' + roomId + ' (' + v.name + ')');
    return { roomId, expiresAt: meta.expiresAt, filename: built.filename, html: built.html, qr };
  }

  listByOwner(userId) {
    const now = Date.now();
    return this.db.roomsByOwner(userId).map(r => ({
      roomId: r.id, name: r.name, status: r.status,
      createdAt: r.created_at, issuedAt: r.issued_at, expiresAt: r.expires_at,
      remainSeconds: Math.max(0, Math.floor((r.expires_at - now) / 1000)),
      maxMembers: r.max_members, sigCount: r.sig_count,
      clientUrl: config.apiPrefix + '/rooms/' + r.id + '/client'
    }));
  }

  /* Current share links for a room, shown only to its owner in the portal. */
  shareLinks(userId, roomId) {
    const room = this.db.room(roomId);
    if (!room || room.owner_id !== userId) throw Object.assign(new Error('房间不存在'), { status: 404 });
    if (!this.shares) return { lite: null, deluxe: null };
    const out = { lite: null, deluxe: null };
    this.shares.codesByRoom(roomId).forEach(row => {
      out[row.edition] = config.publicPrefix + '/s/' + row.code;
    });
    return out;
  }

  /* Download (re)issued client. Reissue rotates joinToken AND RK pair. */
  issueClient(user, roomId, edition) {
    const room = this.db.room(roomId);
    if (!room || room.owner_id !== user.id) throw Object.assign(new Error('房间不存在'), { status: 404 });
    if (room.status === 'destroyed' || room.status === 'destroying') {
      throw Object.assign(new Error('房间已销毁'), { status: 410 });
    }
    const now = Date.now();
    if (room.expires_at <= now) {
      this.destroy(roomId, 'expired');
      throw Object.assign(new Error('房间已到期'), { status: 410 });
    }
    const meta = {
      roomId, name: room.name, maxMembers: room.max_members,
      issuedAt: now, expiresAt: room.expires_at
    };
    const built = this.issuer.build(meta, this.serverSecret, edition);
    const other = this.issuer.build(meta, this.serverSecret,
      edition === 'deluxe' ? 'lite' : 'deluxe', built.creds);
    // Old RK private key and token are invalidated immediately.
    this.keys.deleteRoomKey(roomId, room.room_priv_ref);
    this.db.reissueRoom(roomId, {
      joinTokenHash: built.joinTokenHash, configDigest: built.configDigest,
      roomPubKey: built.roomPubKey, roomPrivRef: built.roomPrivRef,
      issuedAt: now, expiresAt: meta.expiresAt
    });
    const htmlByEdition = {};
    htmlByEdition[edition] = built.html;
    htmlByEdition[edition === 'deluxe' ? 'lite' : 'deluxe'] = other.html;
    const qr = this.shares ? this.shares.publish(roomId, htmlByEdition) : null;
    if (this.hub) this.hub.kickAll(roomId, 'reissued');
    this.db.audit('room_reissued', roomId, now);
    this.logger('房间重新签发: ' + roomId);
    return { filename: built.filename, html: built.html, qr };
  }

  revoke(user, roomId) {
    const room = this.db.room(roomId);
    if (!room || room.owner_id !== user.id) throw Object.assign(new Error('房间不存在'), { status: 404 });
    this.db.revokeRoom(roomId, Date.now());
    if (this.shares) this.shares.revoke(roomId);
    this.keys.deleteRoomKey(roomId, room.room_priv_ref);
    // Purge ciphertext immediately — a revoked room must not keep old
    // messages/files forever (they were never touched by the expiry sweeper).
    this.db.purgeRoomContent(roomId);
    if (this.hub) this.hub.kickAll(roomId, 'revoked');
    this.db.audit('room_revoked', roomId, Date.now());
    return { ok: true };
  }

  dissolve(user, roomId) {
    const room = this.db.room(roomId);
    if (!room || room.owner_id !== user.id) throw Object.assign(new Error('房间不存在'), { status: 404 });
    return this.destroy(roomId, 'dissolved');
  }

  /* Single idempotent destruction path. */
  destroy(roomId, reason) {
    const room = this.db.room(roomId);
    if (!room) return { ok: true, reason };
    if (this.hub) this.hub.broadcastExpired(roomId, reason || 'expired');
    this.db.setRoomStatus(roomId, 'destroying');
    this.db.destroyRoom(roomId);
    if (this.shares) this.shares.revoke(roomId);
    this.keys.deleteRoomKey(roomId, room.room_priv_ref);
    if (this.hub) this.hub.clearRoom(roomId);
    this.db.audit('room_destroyed', roomId, Date.now());
    this.logger('房间已销毁: ' + roomId + ' (' + reason + ')');
    return { ok: true, reason };
  }

  sweepExpired() {
    const now = Date.now();
    const due = this.db.roomsNeedingCleanup(now);
    for (const r of due) this.destroy(r.id, 'expired');
    return due.length;
  }

  /* Public directory: only issued/active, unexpired, non-revoked rooms.
   * Deliberately omits roomId prefix hash material, owner, tokens, keys,
   * signatures, message/file counts and anything that identifies a member. */
  publicList() {
    const now = Date.now();
    return this.db.activeRooms()
      .filter(r => r.expires_at > now && !r.revoke_at)
      .sort((a, b) => b.created_at - a.created_at)
      .map(r => ({
        name: r.name,
        status: r.status,
        remainSeconds: Math.max(0, Math.floor((r.expires_at - now) / 1000)),
        maxMembers: r.max_members,
        onlineCount: this.hub ? this.hub.onlineCount(r.id) : 0
      }));
  }

  /* Non-sensitive status for client self-check. No session required. */
  status(roomId) {
    const room = this.db.room(roomId);
    const now = Date.now();
    if (!room || room.status === 'destroyed' || room.revoke_at) {
      return { ok: false, status: 'invalid', serverTime: now };
    }
    return {
      ok: true, status: room.status, serverTime: now,
      expiresAt: room.expires_at, remainSeconds: Math.max(0, Math.floor((room.expires_at - now) / 1000))
    };
  }
}

module.exports = { Rooms };
