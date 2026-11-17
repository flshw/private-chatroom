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
  var entering = false;
  var chatReady = false;   // true once game/media/UI are initialised (survives WSS reconnect)
  /* SEQ SEND QUEUE — the bot emits PLAY and FINISHED inside the SAME tick on its
   * last card (see gameclient.botStep). Both called sendKind() concurrently;
   * both read the same `state.seq + 1` before either committed, so the server
   * saw two frames with the SAME seq and rejected one with E_REPLAY — exactly
   * the "⚠ 消息时序错乱(REPLAY)" in the log at 22:12:03/22:12:09, which dropped
   * a bot's FINISHED and left the round stuck. Serialising through a promise
   * chain makes seq allocation strictly one-at-a-time; the next send only
   * starts after the previous frame is handed to the socket (seq committed).
   */
  var sendQueue = Promise.resolve();
  function enqueueSend(task) {
    var run = sendQueue.then(task, task);
    sendQueue = run.catch(function () {}); // keep the chain alive after a rejected send
    return run;
  }

  /* Deluxe keeps the session across F5: UK lives in IndexedDB, nickname here. */
  function nickKey() { return 'pc_nick_' + state.config.roomId; }
  function savedNickname() { try { return localStorage.getItem(nickKey()) || ''; } catch (e) { return ''; } }
  function saveNickname(n) { try { localStorage.setItem(nickKey(), n); } catch (e) {} }
  function clearNickname() { try { localStorage.removeItem(nickKey()); } catch (e) {} }

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

  /* --- localStorage: persist UK private key per room, never upload it ---
   * The client is a local single file (file://). In Chromium, IndexedDB.open()
   * on a file:// origin can stay pending forever, and the forge key object
   * returned by generateUK() cannot be structured-cloned (DataCloneError).
   * Both made the UK never persist, so F5 fell back to the login gate.
   * Plain PEM strings in localStorage work everywhere and are enough: every
   * crypto call reimports the PEM and never uses the cached kp object. */
  function ukStoreKey(roomId) { return 'pc_uk_' + roomId; }
  async function loadUK(roomId) {
    try {
      var raw = localStorage.getItem(ukStoreKey(roomId));
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.privatePem || !obj.publicPem) return null;
      return { privatePem: obj.privatePem, publicPem: obj.publicPem, pubB64: obj.pubB64 || '' };
    } catch (e) { return null; }
  }
  async function saveUK(roomId, uk) {
    try {
      localStorage.setItem(ukStoreKey(roomId), JSON.stringify({
        privatePem: uk.privatePem, publicPem: uk.publicPem, pubB64: uk.pubB64 || ''
      }));
    } catch (e) { /* storage disabled: the session survives until refresh only */ }
  }
  async function clearUK(roomId) {
    try { localStorage.removeItem(ukStoreKey(roomId)); } catch (e) { /* noop */ }
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
    // F5 re-enters with the same local key + nickname, no gate click.
    var nick = savedNickname();
    if (cached && nick) {
      $('nickname').value = nick;
      status('gate-status', '正在恢复房间会话…');
      enter();
      return;
    }
    $('nickname').focus();
  }

  function updateGateMeta() {
    var remain = Math.max(0, Math.floor((state.config.expiresAt - now()) / 1000));
    $('gate-remain').textContent = '剩余 ' + fmtRemain(remain);
    $('gate-count').textContent = (state.config.maxMembers || '—') + ' 人上限';
  }

  /* --- enter: generate (or reuse) UK, self-sign, JOIN --- */
  async function enter() {
    if (entering) return;
    var nickname = $('nickname').value.trim();
    if (!nickname) { status('gate-status', '请输入昵称', 'err'); $('nickname').focus(); return; }
    entering = true;
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
        onDiag: function (tag, detail) {
          // Feed connection-layer events into the same diagnosis timeline so
          // "重连后卡死" can be correlated with the server's conn-*.log.
          if (game && typeof game.noteDiag === 'function') {
            game.noteDiag(tag + (detail ? ' | ' + detail : ''));
          }
        },
        onFrame: onFrame
      });
      net.start(frame);
    } catch (e) {
      entering = false;
      status('gate-status', '进入失败：' + e.message, 'err');
    }
  }

  async function onFrame(f) {
    if (f.type === PCProtocol.MSG.JOINED) {
      entering = false;
      var ok = await PCMembers.apply(f.memberList, f.memberListSig, state.config.roomPubKey);
      if (!ok) { status('gate-status', '成员身份校验失败，已拒绝进入', 'err'); net.close(); return; }
      var prevSid = state.mySid;                 // may be old sid on a reconnect
      var resumedMatch = chatReady && game && game.state && game.state.phase === 'playing';
      state.mySid = f.sessionId;
      state.serverTs = f.serverTime;
      state.offsetMs = f.serverTime - Date.now();
      state.joined = true;
      state.seq = 0;
      saveNickname($('nickname').value.trim());
      enterChat(prevSid);
      if (game && f.spectate) game.onMessage({ kind: 'spectate_state', spectate: f.spectate });
      // Render history (ciphertext) that this member can decrypt. On a WSS
      // reconnect we keep the live in-memory match (sid already migrated), so
      // replaying historical game frames would rewind phase/turn and re-inject
      // OLD sids — skip them. A fresh F5 (no local match) still replays them.
      (f.history || []).forEach(function (env) { renderEnvelope(env, null, null, resumedMatch); });
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
      if (window.PCDeluxe && window.PCDeluxe.onGameState) window.PCDeluxe.onGameState(f);
    } else if (f.type === PCProtocol.MSG.GAME_SPECTATE_STATE) {
      if (game) game.onMessage({ kind: 'spectate_state', spectate: f.spectate, self: f.self });
      if (window.PCDeluxe && window.PCDeluxe.onSpectateState) window.PCDeluxe.onSpectateState(f);
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
    if (console.warn) console.warn('[PCDIAG] SERVER-ERROR code=' + f.code + ' msg=' + msg + ' localSeq=' + state.seq);
    // Surface seq desync loudly: the old build only toasted briefly, so a bot
    // freeze caused by E_REPLAY looked like "机器人不出牌" with no clue.
    if (f.code === codes.REPLAY && state.joined) {
      try {
        if (game && typeof game.noteDiag === 'function') {
          game.noteDiag('⚠ 消息时序错乱(REPLAY)·请点诊断查看');
        }
      } catch (_) {}
      toast('消息时序错乱，请记录诊断日志后刷新重连');
    }
    if (!state.joined) { entering = false; status('gate-status', msg, 'err'); }
    else toast(msg);
    if (f.code === codes.ROOM_INVALID) handleExpiry();
  }

  async function renderEnvelope(env, frameSig, frameSenderPub, skipGameHistory) {
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
      // On a WSS reconnect the live match is preserved in memory. Historical
      // game frames carry the PRE-reconnect sids and would rewind the state
      // machine (re-deal / reset turn / stale host), so ignore them here.
      if (skipGameHistory) return;
      // Never silently swallow a game frame again: a malformed/undecryptable
      // echo used to vanish here, so the sender's turn never advanced. Log it.
      try {
        if (game && typeof game.diagText === 'function' && console.info) {
          console.info('[PCDIAG] GAME-FRAME-IN sender=' + env.senderSid + ' seq=' + env.seq);
        }
        if (game) game.onMessage(JSON.parse(text));
        else if (console.warn) console.warn('[PCDIAG] GAME-FRAME-DROP: game engine not initialised');
      } catch (e) {
        if (console.warn) console.warn('[PCDIAG] GAME-FRAME-MALFORMED: ' + (e && e.message ? e.message : e));
      }
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
    if (window.PCDeluxe && window.PCDeluxe.onMembers) {
      // Deluxe seat picker sees the auto-filled bot roster (real members +
      // local bots) so a solo tester can start a 4-seat Guandan match.
      var roster = game && game.roster ? game.roster() : PCMembers.all();
      window.PCDeluxe.onMembers(roster, state.mySid);
    }
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

  function sendKind(plaintext, kind) {
    return enqueueSend(function () { return sendKindNow(plaintext, kind); });
  }

  async function sendKindNow(plaintext, kind) {
    /* ROOT-CAUSE FIX (bot "not playing" freeze):
     * seq was incremented optimistically BEFORE send, but net.send() silently
     * returns false when the WebSocket is not OPEN (reconnecting). One message
     * lost in that window bumps the local seq while the server never receives
     * it; from then on EVERY message's seq is off-by-one, the server rejects all
     * of them with E_REPLAY, and no broadcast echo returns. The bot turn then
     * sticks forever and the watchdog's re-sends are all rejected too.
     * Fix: require an OPEN socket first; if build/send fails, ROLL BACK seq so
     * the next attempt reuses the same seq and stays in lockstep with server. */
    if (!net || typeof net.connected === 'function' && !net.connected()) {
      var e0 = new Error('连接未就绪，消息未发送');
      if (console.warn) console.warn('[PCDIAG] SEND-SKIP websocket not OPEN, seq not consumed');
      throw e0;
    }
    var usedSeq = state.seq + 1;
    state.serverTs = now();
    var members = PCMembers.all().map(function (m) { return { sid: m.sid, ukPub: m.ukPub }; });
    var frame;
    try {
      frame = await PCCrypto.buildMessage(plaintext, {
        config: state.config, mySid: state.mySid, seq: usedSeq, serverTs: state.serverTs,
        kind: kind, members: members, uk: state.uk
      });
    } catch (e) {
      if (console.warn) console.warn('[PCDIAG] SEND-BUILD-ERR seq=' + usedSeq + ' ' + (e && e.message));
      throw e; // seq NOT consumed
    }
    if (!net.send(frame)) {
      if (console.warn) console.warn('[PCDIAG] SEND-FAIL websocket send returned false, seq rolled back from ' + usedSeq);
      throw new Error('消息发送失败（连接中断）'); // seq NOT consumed
    }
    state.seq = usedSeq; // commit only after a successful hand-off to the socket
    if (console.info && kind === 'game') console.info('[PCDIAG] SENT game seq=' + usedSeq);
  }

  function enterChat(prevSid) {
    show('chat');
    $('room-name').textContent = state.config.name || '私密聊天';

    /* Reconnect: the engine/UI already exist. Do NOT rebuild them — that used
     * to reset phase to idle and throw away hands, turn and botHands, so a
     * match could never be resumed after a reconnect. Instead translate the
     * old sid to the freshly assigned one and repaint. */
    if (chatReady && game) {
      if (prevSid && prevSid !== state.mySid && typeof game.updateMySid === 'function') {
        game.updateMySid(state.mySid);
      }
      if (window.PCDeluxe && window.PCDeluxe.onMembers) {
        window.PCDeluxe.onMembers(game.roster ? game.roster() : PCMembers.all(), state.mySid);
      }
      if (window.PCDeluxe && window.PCDeluxe.renderGame) window.PCDeluxe.renderGame(game.state, game);
      if (game && typeof game.noteDiag === 'function') {
        game.noteDiag('RECONNECT-RESUME prevSid=' + (prevSid || '-') + ' newSid=' + state.mySid +
          ' phase=' + game.state.phase + ' turn=' + game.state.turn);
      }
      return;
    }

    media = new window.PCMedia({
      config: state.config, net: net,
      mySid: state.mySid, uk: state.uk,
      members: PCMembers,
      toast: toast,
      sendKind: sendKind,
      onRemoteTrack: onRemoteTrack,
      onLocalStream: onLocalStream,
      onCallEnd: onCallEnd,
      /* Mic button gives immediate, unmistakable feedback: pending (dimmed),
       * recording (red pulse + label), or idle. Previously a tap looked dead. */
      onRecordState: function (state) {
        var b = $('btn-voice'); if (!b) return;
        b.classList.toggle('recording', state === true);
        b.classList.toggle('rec-pending', state === 'pending');
        b.textContent = state === true ? '⏹' : '🎤';
        b.title = state === true ? '点击结束录音并加密发送' : '录制语音条（端到端加密）';
      }
    });
    // Deluxe edition: initialise Guandan engine + UI. Simple edition is a no-op.
    if (window.PCGameClient && window.PCDeluxe && window.PCDeluxe.bind) {
      game = window.PCGameClient.create({
        config: state.config, mySid: state.mySid, uk: state.uk, members: PCMembers,
        bots: isDeluxe(),   // deluxe auto-fills up to 4 seats with local bots for testing
        sendGame: function (obj) { return sendKind(JSON.stringify(obj), 'game'); },
        sendControl: function (frame) { if (net) net.send(frame); },
        toast: toast,
        onUpdate: function (st) { if (window.PCDeluxe.renderGame) window.PCDeluxe.renderGame(st, game); }
      });
      window.PCDeluxe.bind({ game: game, app: { net: net, media: media, state: state,
        sendKind: sendKind, toast: toast } });
    }
    chatReady = true;
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
    clearNickname();
    clearUK(state.config.roomId).then(function () { /* local plaintext cleared */ });
  }

  /* Voluntary leave: wipe local credentials so a refresh will NOT auto-rejoin,
   * tear down every transport, and return to the nickname gate. */
  function leaveRoom() {
    if (!state.joined && !entering) { show('gate'); return; }
    if (!window.confirm('确定退出当前聊天室吗？\n退出后本机密钥会被清除，下次进入需重新输入昵称。')) return;
    state.expired = false;
    if (countdown) { clearInterval(countdown); countdown = null; }
    if (media) { try { if (media.inCall()) media.hangup(); } catch (e) {} media = null; }
    if (window.PCDeluxe && window.PCDeluxe.pipClear) window.PCDeluxe.pipClear();
    if (net) { net.close(); net = null; }
    game = null;
    chatReady = false;
    state.joined = false; state.mySid = null; state.seq = 0; state.uk = null;
    state.messages = []; entering = false;
    $('messages').innerHTML = '';
    $('input').value = ''; $('input').disabled = false; $('btn-send').disabled = false;
    var gp = $('game-panel'); if (gp) gp.classList.add('hidden');
    var mp = $('members-panel'); if (mp) mp.classList.add('hidden');
    $('nickname').value = '';
    clearNickname(); clearUK(state.config.roomId);
    show('gate');
    $('nickname').focus();
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
  $('btn-exit').addEventListener('click', leaveRoom);

  boot();
})();
