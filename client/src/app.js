/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom client app. */
'use strict';
/* UI state machine: self-check -> nickname -> UK generation -> chat.
 * UK private key is persisted in IndexedDB and reused across reloads; it is
 * wiped on room expiry or explicit leave. Expired rooms disable input and
 * clear local plaintext. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    config: null, offsetMs: 0, uk: null, mySid: null,
    seq: 0, serverTs: 0, joined: false, messages: [], expired: false
  };
  var net = null, media = null, countdown = null, game = null;

  function show(id) {
    ['boot', 'gate', 'chat'].forEach(function (x) { $(x).classList.toggle('hidden', x !== id); });
  }
  function status(id, text, kind) {
    var el = $(id);
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function toast(text) {
    var t = $('toast');
    t.textContent = text; t.classList.remove('hidden');
    clearTimeout(t._timer); t._timer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }
  function now() { return Date.now() + state.offsetMs; }
  function fmtRemain(sec) {
    sec = Math.max(0, sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* --- IndexedDB: persist UK private key per room, never upload it --- */
  var DB_NAME = 'pc_keys';
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('uk')) db.createObjectStore('uk');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function loadUK(roomId) {
    try {
      var db = await openDb();
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction('uk', 'readonly');
        var req = tx.objectStore('uk').get(roomId);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    } catch (e) { return null; }
  }
  async function saveUK(roomId, uk) {
    try {
      var db = await openDb();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction('uk', 'readwrite');
        tx.objectStore('uk').put(uk, roomId);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (e) { /* noop */ }
  }
  async function clearUK(roomId) {
    try {
      var db = await openDb();
      await new Promise(function (resolve) {
        var tx = db.transaction('uk', 'readwrite');
        tx.objectStore('uk').delete(roomId);
        tx.oncomplete = function () { resolve(); };
      });
    } catch (e) { /* noop */ }
    try { localStorage.removeItem('pc_msgs_' + roomId); } catch (e) { /* noop */ }
  }

  /* --- boot --- */
  async function boot() {
    show('boot');
    if (!PCCrypto.available()) {
      status('boot-status', '加密组件未能加载，文件可能不完整。请重新下载客户端，或通过在线入口打开。', 'err');
      return;
    }
    var result = await PCConfig.load();
    if (!result.ok) { status('boot-status', result.error, 'err'); return; }
    state.config = result.config;
    state.offsetMs = result.offsetMs;
    state.serverTs = now();
    $('gate-room').textContent = state.config.name || '私密聊天';
    document.title = (state.config.name || '私密聊天') + ' · 私密聊天';
    updateGateMeta();
    show('gate');
    // Preload a persisted UK for this room (refresh reuse).
    var cached = await loadUK(state.config.roomId);
    if (cached) state.uk = cached;
  }

  function updateGateMeta() {
    var remain = Math.max(0, Math.floor((state.config.expiresAt - now()) / 1000));
    $('gate-remain').textContent = '剩余 ' + fmtRemain(remain);
    $('gate-count').textContent = (state.config.maxMembers || '—') + ' 人上限';
  }

  /* --- enter: generate (or reuse) UK, self-sign, JOIN --- */
  async function enter() {
    var nickname = $('nickname').value.trim();
    if (!nickname) { status('gate-status', '请输入昵称', 'err'); return; }
    status('gate-status', '正在准备本机密钥…');
    try {
      if (!state.uk) {
        state.uk = await PCCrypto.generateUK();
        await saveUK(state.config.roomId, state.uk);
      }
      var clientTime = now();
      var signed = {
        roomId: state.config.roomId, ukPub: state.uk.publicPem,
        nickname: nickname, clientTime: clientTime
      };
      var selfSig = await PCCrypto.sign(signed, state.uk.privatePem);
      status('gate-status', '正在连接服务器…');
      var frame = {
        type: PCProtocol.MSG.JOIN,
        roomId: state.config.roomId, joinToken: state.config.joinToken,
        nickname: nickname, ukPub: state.uk.publicPem, selfSig: selfSig,
        clientTime: clientTime, nonce: PCCrypto.b64(PCCrypto.randomBytes(16))
      };
      net = new window.PCNet({
        config: state.config,
        onOpen: function () { status('gate-status', '已连接，正在校验成员身份…', 'ok'); },
        onClose: function () { if (!state.expired) toast('连接中断，正在重连…'); },
        onError: function (m) { status('gate-status', m, 'err'); },
        onFrame: onFrame
      });
      net.start(frame);
    } catch (e) {
      status('gate-status', '进入失败：' + e.message, 'err');
    }
  }

  async function onFrame(f) {
    if (f.type === PCProtocol.MSG.JOINED) {
      var ok = await PCMembers.apply(f.memberList, f.memberListSig, state.config.roomPubKey);
      if (!ok) { status('gate-status', '成员身份校验失败，已拒绝进入', 'err'); net.close(); return; }
      state.mySid = f.sessionId;
      state.serverTs = f.serverTime;
      state.offsetMs = f.serverTime - Date.now();
      state.joined = true;
      state.seq = 0;
      enterChat();
      if (game && f.spectator) game.onMessage({ kind: 'spectator', spectator: f.spectator });
      // Render history (ciphertext) that this member can decrypt.
      (f.history || []).forEach(renderEnvelope);
      updateMembersUI();
      startCountdown(f.expiresAt);
    } else if (f.type === PCProtocol.MSG.MEMBER_KEYS) {
      var ok2 = await PCMembers.apply(f.memberList, f.memberListSig, state.config.roomPubKey);
      if (!ok2) { toast('成员身份校验失败，已忽略该名单'); return; }
      updateMembersUI();
    } else if (f.type === PCProtocol.MSG.MSG_BROADCAST) {
      renderEnvelope(f.envelope, f.sig, f.senderPub);
    } else if (f.type === PCProtocol.MSG.RTC_SIGNAL) {
      if (media) media.handleSignal(f.from, f.encryptedSignal);
    } else if (f.type === PCProtocol.MSG.GAME_STATE) {
      if (game) game.onMessage({ kind: 'spectator', spectator: f.spectator });
      if (window.PCDeluxe && window.PCDeluxe.onGameState) window.PCDeluxe.onGameState(f);
    } else if (f.type === PCProtocol.MSG.ROOM_EXPIRED) {
      handleExpiry();
    } else if (f.type === PCProtocol.MSG.ERROR) {
      handleServerError(f);
    }
  }

  function handleServerError(f) {
    var codes = PCProtocol.ERR;
    var map = {};
    map[codes.ROOM_INVALID] = '房间无效或凭证已吊销';
    map[codes.ROOM_FULL] = '房间人数已满';
    map[codes.REPLAY] = '消息时序校验失败，请刷新重连';
    map[codes.RATE_LIMIT] = '发送过于频繁，请稍候';
    map[codes.SIG_INVALID] = '签名校验失败';
    map[codes.WRAP_INCOMPLETE] = '成员密钥表不同步，请稍候';
    map[codes.KEY_INVALID] = '密钥校验失败';
    var msg = map[f.code] || ('服务器错误：' + f.code);
    if (!state.joined) status('gate-status', msg, 'err');
    else toast(msg);
    if (f.code === codes.ROOM_INVALID) handleExpiry();
  }

  async function renderEnvelope(env, frameSig, frameSenderPub) {
    // Live broadcasts put sig/senderPub on the frame; stored history keeps
    // them inside the envelope. Accept both shapes.
    var envSig = frameSig || env.sig;
    var envSenderPub = frameSenderPub || env.senderPub;
    var sender = PCMembers.get(env.senderSid);
    var senderPub = sender ? sender.ukPub : envSenderPub;
    var mySid = state.mySid;
    var text;
    try {
      text = await PCCrypto.openMessage(env, envSig, envSenderPub, mySid,
        state.uk.privatePem, senderPub);
    } catch (e) {
      if (e.message === '本条消息未向我封装') return; // not addressed to me (e.g., late joiner history)
      text = '[无法解密的消息：' + e.message + ']';
    }
    // Game payloads ride the same E2EE channel but are routed to the game
    // engine instead of the chat transcript (deluxe edition only).
    if (env.kind === 'game') {
      try { if (game) game.onMessage(JSON.parse(text)); } catch (e) { /* ignore malformed game frame */ }
      return;
    }
    var mine = env.senderSid === state.mySid;
    state.messages.push({
      ts: env.ts, who: sender ? sender.nickname : (env.meta && env.meta.nickname) || '成员',
      text: text, mine: mine
    });
    appendMessage(state.messages[state.messages.length - 1], env.kind, text);
  }

  function appendMessage(msg, kind, text) {
    var div = document.createElement('div');
    div.className = 'msg' + (msg.mine ? ' me' : '');
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = msg.who + ' · ' + new Date(msg.ts).toLocaleTimeString();
    var body = document.createElement('div');
    body.className = 'text';
    if (kind === 'file') {
      try {
        var meta = JSON.parse(text);
        body.className = 'file';
        var a = document.createElement('a');
        a.href = '#'; a.textContent = '📎 ' + (meta.name || '文件');
        a.onclick = function (e) {
          e.preventDefault();
          if (media) media.receiveFile(meta).catch(function (err) { toast('下载失败：' + err.message); });
        };
        body.appendChild(a);
      } catch (e) { body.textContent = '[文件消息解析失败]'; }
    } else {
      body.textContent = text;
    }
    div.appendChild(who); div.appendChild(body);
    var box = $('messages');
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function updateMembersUI() {
    $('member-count').textContent = PCMembers.count() + '/' + (state.config.maxMembers || '—') + ' 人';
    var list = $('members-list');
    list.innerHTML = '';
    PCMembers.all().forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'member';
      var name = document.createElement('span');
      name.textContent = (m.nickname || '成员') + (m.sid === state.mySid ? '（我）' : '');
      var badge = document.createElement('span');
      badge.className = 'badge'; badge.textContent = '✓';
      badge.title = '公钥已验签';
      row.appendChild(name); row.appendChild(badge);
      list.appendChild(row);
    });
    try { $('safety-code').textContent = '安全码 ' + PCMembers.safetyCode(); } catch (e) {}
  }

  async function sendText() {
    if (!state.joined || state.expired) return;
    var input = $('input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { await sendKind(text, 'text'); }
    catch (e) { toast('发送失败：' + e.message); }
  }

  async function sendKind(plaintext, kind) {
    state.seq += 1;
    state.serverTs = now();
    var members = PCMembers.all().map(function (m) { return { sid: m.sid, ukPub: m.ukPub }; });
    var frame = await PCCrypto.buildMessage(plaintext, {
      config: state.config, mySid: state.mySid, seq: state.seq, serverTs: state.serverTs,
      kind: kind, members: members, uk: state.uk
    });
    net.send(frame);
  }

  function enterChat() {
    show('chat');
    $('room-name').textContent = state.config.name || '私密聊天';
    media = new window.PCMedia({
      config: state.config, net: net,
      mySid: state.mySid, uk: state.uk,
      members: PCMembers,
      toast: toast,
      sendKind: sendKind,
      onRemoteTrack: onRemoteTrack,
      onLocalStream: onLocalStream,
      onCallEnd: onCallEnd
    });
    // Deluxe edition: initialise Guandan engine + UI. Simple edition is a no-op.
    if (window.PCGameClient && window.PCDeluxe && window.PCDeluxe.bind) {
      game = window.PCGameClient.create({
        config: state.config, mySid: state.mySid, uk: state.uk, members: PCMembers,
        sendGame: function (obj) { return sendKind(JSON.stringify(obj), 'game'); },
        toast: toast,
        onUpdate: function (st) { if (window.PCDeluxe.renderGame) window.PCDeluxe.renderGame(st, game); }
      });
      window.PCDeluxe.bind({ game: game, app: { net: net, media: media, state: state,
        sendKind: sendKind, toast: toast } });
    }
  }

  function startCountdown(expiresAt) {
    if (countdown) clearInterval(countdown);
    function tick() {
      var remain = Math.floor((expiresAt - now()) / 1000);
      $('remain').textContent = fmtRemain(remain);
      if (remain <= 0) handleExpiry();
    }
    tick();
    countdown = setInterval(tick, 1000);
  }

  function handleExpiry() {
    if (state.expired) return;
    state.expired = true;
    toast('房间已到期或解散，聊天已锁定');
    if (countdown) clearInterval(countdown);
    if (net) net.close();
    if (media && media.inCall()) media.hangup();
    $('input').disabled = true;
    $('btn-send').disabled = true;
    clearUK(state.config.roomId).then(function () { /* local plaintext cleared */ });
  }

  function isDeluxe() { return !!(window.PCDeluxe && window.PCDeluxe.pipAddVideo); }
  function onLocalStream(stream) {
    if (isDeluxe()) { window.PCDeluxe.pipAddVideo('video-local', stream, true); return; }
    var grid = $('video-grid');
    grid.innerHTML = '';
    var v = document.createElement('video');
    v.srcObject = stream; v.autoplay = true; v.muted = true; v.playsInline = true;
    grid.appendChild(v);
    $('video-overlay').classList.remove('hidden');
  }
  function onRemoteTrack(sid, stream) {
    if (isDeluxe()) { window.PCDeluxe.pipAddVideo('video-' + sid, stream, false); return; }
    var grid = $('video-grid');
    var v = document.createElement('video');
    v.id = 'video-' + sid; v.srcObject = stream; v.autoplay = true; v.playsInline = true;
    grid.appendChild(v);
    $('video-overlay').classList.remove('hidden');
  }
  function onCallEnd() {
    if (isDeluxe()) { window.PCDeluxe.pipClear(); return; }
    $('video-overlay').classList.add('hidden'); $('video-grid').innerHTML = '';
  }

  /* --- wire events --- */
  $('btn-enter').addEventListener('click', enter);
  $('nickname').addEventListener('keydown', function (e) { if (e.key === 'Enter') enter(); });
  $('btn-send').addEventListener('click', sendText);
  $('input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendText(); });
  $('btn-members').addEventListener('click', function () { $('members-panel').classList.toggle('hidden'); });
  $('btn-export').addEventListener('click', function () { PCExport.run(state.config.name, state.messages); });
  $('btn-attach').addEventListener('click', function () { $('file-input').click(); });
  $('file-input').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (f && media) media.sendFile(f).catch(function (err) { toast('发送失败：' + err.message); });
    e.target.value = '';
  });
  $('btn-voice').addEventListener('click', function () { if (media) media.recordVoice(); });
  $('btn-video').addEventListener('click', function () { if (media) media.startCall(); });
  $('btn-hangup').addEventListener('click', function () { if (media) media.hangup(); });

  boot();
})();
