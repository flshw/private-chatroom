/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom member keys. */
'use strict';
/*
 * Member public-key table with three-way verification (T-11 mitigation):
 *   1) RK_pub verifies the whole memberList signature (memberListSig)
 *   2) each entry's ukPub verifies its own selfSig
 *   3) version must strictly increase (reject replayed/stale lists)
 * Any failure => refuse the list, keep the previous trusted table.
 */
window.PCMembers = (function () {
  var table = new Map();   // sid -> {sid, nickname, ukPub, selfSig}
  var version = 0;
  var epoch = null;        // server process epoch; change => version baseline resets

  function reset() { table = new Map(); version = 0; epoch = null; }

  function all() {
    return Array.from(table.values());
  }
  function get(sid) { return table.get(sid) || null; }
  function count() { return table.size; }

  async function verifyList(memberList, memberListSig, roomPubKeyPem) {
    if (!memberList || !Array.isArray(memberList.members)) return false;
    // A server restart resets memberVersion to 1. If the (RK-signed) epoch
    // changed, compare versions against 0 so the fresh low version is accepted
    // — otherwise online clients would reject every list and lock up until F5.
    // Lists without epoch are treated as legacy (strict check). NOTE: we only
    // COMPUTE the baseline here; apply() commits epoch/version after signatures
    // verify, so a forged list cannot poison our version state.
    var baseVersion = version;
    if (memberList.epoch != null && memberList.epoch !== epoch) baseVersion = 0;
    // 3) monotonic version
    if (!(memberList.version > baseVersion)) return false;
    // 1) RK signature over canonical memberList
    var listOk = false;
    try { listOk = await PCCrypto.verifySig(memberList, memberListSig, roomPubKeyPem); }
    catch (e) { listOk = false; }
    if (!listOk) return false;
    // 2) each self signature
    for (var i = 0; i < memberList.members.length; i++) {
      var m = memberList.members[i];
      var signed = { roomId: memberList.roomId, ukPub: m.ukPub, nickname: m.nickname, clientTime: m.clientTime };
      var ok = false;
      try { ok = await PCCrypto.verifySig(signed, m.selfSig, m.ukPub); }
      catch (e) { ok = false; }
      if (!ok) return false;
    }
    return true;
  }

  async function apply(memberList, memberListSig, roomPubKeyPem) {
    var ok = await verifyList(memberList, memberListSig, roomPubKeyPem);
    if (!ok) return false;
    table = new Map();
    for (var i = 0; i < memberList.members.length; i++) {
      var m = memberList.members[i];
      table.set(m.sid, { sid: m.sid, nickname: m.nickname, ukPub: m.ukPub, selfSig: m.selfSig });
    }
    version = memberList.version;
    if (memberList.epoch != null) epoch = memberList.epoch;
    return true;
  }

  /* Safety code: short hash of sorted public keys for offline comparison. */
  function safetyCode() {
    var pubs = all().map(function (m) { return m.ukPub; }).sort().join('');
    var md = window.forge.md.sha256.create();
    md.update(pubs, 'utf8');
    var hex = md.digest().toHex().slice(0, 8).toUpperCase();
    return hex.match(/.{1,4}/g).join('-');
  }

  return { reset: reset, all: all, get: get, count: count, apply: apply,
    verifyList: verifyList, safetyCode: safetyCode, version: function () { return version; } };
})();
