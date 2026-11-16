/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom deluxe UI glue. */
'use strict';
/*
 * PCDeluxe — deluxe-edition UI controller. Loaded only in the deluxe template.
 * Bridges the shared app.js hooks to the Guandan game, 3D scene, live voice
 * and draggable PiP video. The simple edition never loads this file.
 */
window.PCDeluxe = (function () {
  var game = null, ctx = null, voiceOn = false, selected = {};
  var $ = function (id) { return document.getElementById(id); };

  function bind(o) {
    game = o.game; ctx = o.app;
    if (window.PC3D) {
      if (!window.PC3D.available()) window.PC3D.init();
      if (window.PC3D.available()) window.PC3D.start();
    }
    syncSeats();
  }

  function syncSeats() {
    if (!game) return;
    game.syncSeats();
    renderGame(game.state);
  }

  function cardEl(c, sel) {
    var d = document.createElement('div');
    d.className = 'pcard' + ((c.s === 'H' || c.s === 'D') ? ' red' : '') + (sel ? ' sel' : '');
    var r = ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '', 17: '' })[c.r] || c.r;
    var suit = c.s === 'W' ? (c.r === 17 ? '👑' : '🃏') : ({ S: '♠', H: '♥', C: '♣', D: '♦' })[c.s];
    var top = document.createElement('span'); top.textContent = r;
    var bot = document.createElement('span'); bot.className = 'suit'; bot.textContent = suit;
    d.appendChild(top); d.appendChild(bot);
    d.dataset.id = c.id;
    return d;
  }

  function renderGame(st) {
    var seats = $('game-seats'), table = $('game-table'), hand = $('my-hand'), log = $('game-log');
    if (!seats || !table || !hand) return;
    if (!$('game-panel') || $('game-panel').classList.contains('hidden')) return;
    // Seats
    seats.innerHTML = '';
    for (var i = 0; i < 4; i++) {
      var s = st.seats[i];
      var el = document.createElement('div');
      el.className = 'seat' + (s && s.isMe ? ' me' : '') + (st.turn && s && st.turn === s.sid ? ' turn' : '');
      var nm = document.createElement('div');
      nm.textContent = s ? (s.nickname + (s.isMe ? '（我）' : '')) : '空位';
      var cnt = document.createElement('div'); cnt.className = 'cnt';
      cnt.textContent = s ? (st.phase === 'dealing' ? '发牌中' : '·') : '—';
      el.appendChild(nm); el.appendChild(cnt); seats.appendChild(el);
    }
    // Table (last play)
    table.innerHTML = '';
    if (st.table && st.table.cards) {
      st.table.cards.forEach(function (c) { table.appendChild(cardEl(c, false)); });
    } else {
      var tip = document.createElement('div'); tip.className = 'tip';
      tip.textContent = st.spectator ? '旁观中 · 等待玩家出牌' : (st.phase === 'idle' ? '点击「开局」开始' : '新一轮 · 请领出');
      table.appendChild(tip);
    }
    // My hand — observers see the ONE target's hand (read-only), players see own.
    hand.innerHTML = '';
    var shown = st.spectator ? (st.targetHand || []) : (st.hand || []);
    if (shown.length) {
      shown.forEach(function (c) {
        var card = cardEl(c, !st.spectator && !!selected[c.id]);
        if (st.spectator) card.style.cursor = 'default';
        hand.appendChild(card);
      });
    }
    // Level / turn / spectator note
    var lv = $('game-level'); if (lv) lv.textContent = '打 ' + game.rankName(st.level) + ' · 第 ' + (st.roundNo || 1) + ' 局';
    var note = $('spectator-note');
    if (note) {
      var texts = [];
      if (st.spectator && st.watchTargetSid) {
        var tn = (st.seats.filter(function (s) { return s.sid === st.watchTargetSid; })[0] || {}).nickname || '玩家';
        texts.push('👁 你正在旁观：' + tn + ' 的手牌（只看这一人，不可更改）');
      }
      if (st.pendingForMe) {
        texts.push('🔔 ' + (st.pendingForMe.spectatorNickname || '有人') + ' 请求旁观你的手牌');
      }
      if (texts.length) { note.classList.remove('hidden'); note.innerHTML = texts.join('<br>'); }
      else note.classList.add('hidden');
    }
    // Consent buttons for a pending request targeting me.
    renderConsent(st);
    var myTurn = !st.spectator && st.turn === ctx.state.mySid;
    var btnPlay = $('btn-game-play'), btnPass = $('btn-game-pass');
    if (btnPlay) btnPlay.disabled = !myTurn;
    if (btnPass) btnPass.disabled = !myTurn || !st.table;
    var btnStart = $('btn-game-start');
    if (btnStart) btnStart.classList.toggle('hidden', st.phase === 'playing' || st.spectator);
    if (log) { log.innerHTML = ''; st.log.slice(-12).forEach(function (t) {
      var d = document.createElement('div'); d.textContent = t; log.appendChild(d);
    }); log.scrollTop = log.scrollHeight; }
  }

  function toggleGame() {
    var p = $('game-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) syncSeats();
  }

  function onPlayClick() {
    var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
    if (!ids.length) { ctx.toast('先点选要出的牌'); return; }
    game.play(ids).then(function () { selected = {}; });
  }

  function onPassClick() { game.pass(); }

  function onStartClick() {
    // Host authority: everyone sends a 'start', host alone actually deals.
    game.requestStart();
  }

  /* Choose exactly ONE player to watch. Once locked by the server it cannot
   * be changed, so show a clear pick-list with a confirm. */
  function requestSpectate() {
    if (!game) return;
    if (game.state.myRelation) {
      ctx.toast('你已锁定旁观一名玩家，无法更改或旁观其他人');
      return;
    }
    var cands = game.spectateCandidates();
    if (!cands.length) { ctx.toast('当前没有其他可旁观的玩家'); return; }
    var box = $('spectate-picker') || (function () {
      var e = document.createElement('div'); e.id = 'spectate-picker';
      e.className = 'spectate-picker hidden';
      document.body.appendChild(e); return e;
    })();
    box.innerHTML = '';
    var title = document.createElement('div'); title.className = 'pk-title';
    title.textContent = '选择旁观对象（选定后不可更改，需对方同意）';
    box.appendChild(title);
    cands.forEach(function (c) {
      var b = document.createElement('button'); b.className = 'tool-btn';
      b.textContent = '👁 ' + c.nickname;
      b.onclick = function () {
        game.requestSpectate(c.sid);
        box.classList.add('hidden');
      };
      box.appendChild(b);
    });
    var cancel = document.createElement('button'); cancel.className = 'tool-btn pk-cancel';
    cancel.textContent = '取消';
    cancel.onclick = function () { box.classList.add('hidden'); };
    box.appendChild(cancel);
    box.classList.remove('hidden');
  }

  /* Draw consent buttons when someone asks to watch MY hand. */
  function renderConsent(st) {
    var panel = $('game-panel'); if (!panel) return;
    var box = $('spectate-consent') || (function () {
      var e = document.createElement('div'); e.id = 'spectate-consent';
      e.className = 'spectate-consent hidden'; panel.appendChild(e); return e;
    })();
    box.innerHTML = '';
    if (!st.pendingForMe) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var q = document.createElement('div'); q.className = 'ask';
    q.textContent = '🔔 ' + (st.pendingForMe.spectatorNickname || '有人') + ' 请求旁观你的手牌';
    box.appendChild(q);
    var yes = document.createElement('button'); yes.className = 'tool-btn'; yes.textContent = '同意';
    yes.onclick = function () { game.replySpectate(st.pendingForMe.spectatorSid, true); };
    var no = document.createElement('button'); no.className = 'tool-btn'; no.textContent = '拒绝';
    no.onclick = function () { game.replySpectate(st.pendingForMe.spectatorSid, false); };
    box.appendChild(yes); box.appendChild(no);
  }

  function onGameState(f) { /* public turn/seat state already rendered via game.onUpdate */ }

  function onSpectateState(f) { if (game) game.onMessage({ kind: 'spectate_state', spectate: f.spectate, self: f.self }); }

  /* --- full-duplex live voice: reuse WebRTC mesh, audio-only, always on --- */
  function toggleVoice() {
    if (!window.PCMedia || !ctx) return;
    if (!voiceOn) {
      // Reuse media module's call machinery but flag live voice in toast.
      ctx.media.startCall(true);
      voiceOn = true;
      var b = $('btn-voice-live'); if (b) b.classList.add('on');
      ctx.toast('全双工语音已开启（可持续对话）');
    } else {
      ctx.media.hangup();
      voiceOn = false;
      var b2 = $('btn-voice-live'); if (b2) b2.classList.remove('on');
      ctx.toast('语音已关闭');
    }
  }

  /* --- PiP video drag --- */
  function initPiPDrag() {
    var box = $('pip-video'), head = $('pip-head');
    if (!box || !head) return;
    var dragging = false, ox = 0, oy = 0;
    head.addEventListener('mousedown', function (e) {
      dragging = true;
      var r = box.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      box.style.right = 'auto'; box.style.bottom = 'auto';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, e.clientX - ox)) + 'px';
      box.style.top = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - oy)) + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = false; });
  }

  /* Video streams: mirror app.js overlay into the PiP body instead of fullscreen. */
  function pipAddVideo(id, stream, muted) {
    var body = $('pip-body'); if (!body) return;
    var empty = $('pip-empty'); if (empty) empty.remove();
    var old = $(id); if (old) old.remove();
    var v = document.createElement('video');
    v.id = id; v.srcObject = stream; v.autoplay = true; v.playsInline = true; v.muted = !!muted;
    body.appendChild(v);
    $('pip-video').classList.remove('hidden');
  }
  function pipClear() {
    var body = $('pip-body'); if (body) body.innerHTML = '<div id="pip-empty" class="pip-empty">开启语音/视频后显示画面</div>';
    if ($('pip-video')) $('pip-video').classList.add('hidden');
  }

  function wire() {
    $('btn-game') && $('btn-game').addEventListener('click', toggleGame);
    $('btn-game-start') && $('btn-game-start').addEventListener('click', onStartClick);
    $('btn-game-play') && $('btn-game-play').addEventListener('click', onPlayClick);
    $('btn-game-pass') && $('btn-game-pass').addEventListener('click', onPassClick);
    $('btn-spectate') && $('btn-spectate').addEventListener('click', requestSpectate);
    $('btn-voice-live') && $('btn-voice-live').addEventListener('click', toggleVoice);
    $('btn-pip-close') && $('btn-pip-close').addEventListener('click', pipClear);
    initPiPDrag();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  return {
    bind: bind, onGameState: onGameState, onSpectateState: onSpectateState, renderGame: renderGame,
    pipAddVideo: pipAddVideo, pipClear: pipClear,
    selectCard: function (id) { selected[id] = !selected[id]; },
    _selected: function () { return selected; }
  };
})();
