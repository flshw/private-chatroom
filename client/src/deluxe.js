/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom deluxe UI glue. */
'use strict';
/*
 * PCDeluxe — deluxe-edition UI controller. Loaded only in the deluxe template.
 * Bridges the shared app.js hooks to the Guandan game, 3D scene, live voice
 * and draggable PiP video. The simple edition never loads this file.
 */
window.PCDeluxe = (function () {
  var game = null, ctx = null, voiceOn = false, selected = {};
  var membersList = [], mySid = null, picked = [], setupOpen = false;
  var spread = false; // false = stacked by rank (default), true = flat
  var lastTableSig = ''; // signature of the last rendered table, for play animation
  var $ = function (id) { return document.getElementById(id); };

  function bind(o) {
    game = o.game; ctx = o.app;
    mySid = (ctx && ctx.state && ctx.state.mySid) || null;
    if (window.PC3D) {
      if (!window.PC3D.available()) window.PC3D.init();
      // Static backdrop only — no drifting cards/particle animation loop.
      if (window.PC3D.available()) {
        if (window.PC3D.renderStatic) window.PC3D.renderStatic();
        else window.PC3D.start();
      }
    }
    syncSeats();
  }

  /* Game button stays locked until the room has at least four people. */
  function onMembers(list, sid) {
    membersList = list || [];
    if (sid) mySid = sid;
    picked = picked.filter(function (s) {
      return membersList.some(function (m) { return m.sid === s; });
    });
    var btn = $('btn-game');
    if (btn) {
      var enough = membersList.length >= 4;
      btn.disabled = !enough;
      btn.title = enough ? '选择另外 3 名玩家后开局' :
        ('房间内至少 4 人才能开局（当前 ' + membersList.length + ' 人）');
    }
    if (setupOpen) renderSetup();
  }

  function watcherMap() {
    var out = {};
    ((game && game.state.spectate) || []).forEach(function (r) {
      if (r.status === 'approved') out[r.spectatorSid] = true;
    });
    return out;
  }

  function showSetup(open) {
    setupOpen = !!open;
    var box = $('game-setup'), mask = $('game-setup-mask');
    if (box) box.classList.toggle('hidden', !setupOpen);
    if (mask) mask.classList.toggle('hidden', !setupOpen);
    if (setupOpen) renderSetup();
  }

  /* 4 in room -> pick the other three; more than 4 -> random three. */
  function autoPick() {
    var watching = watcherMap();
    var cands = membersList.filter(function (m) {
      return m.sid !== mySid && !watching[m.sid];
    }).map(function (m) { return m.sid; });
    if (membersList.length === 4) {
      picked = cands.slice(0, 3);
    } else if (membersList.length > 4) {
      for (var i = cands.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = cands[i]; cands[i] = cands[j]; cands[j] = tmp;
      }
      picked = cands.slice(0, 3);
    } else {
      picked = [];
    }
  }

  /* Exactly one other seat per click, up to three. */
  function togglePick(sid) {
    var i = picked.indexOf(sid);
    if (i >= 0) picked.splice(i, 1);
    else {
      if (picked.length >= 3) { if (ctx) ctx.toast('只能选择另外 3 名玩家'); return; }
      picked.push(sid);
    }
    renderSetup();
  }

  function renderSetup() {
    var box = $('player-picks');
    if (!box) return;
    box.innerHTML = '';
    var watching = watcherMap();
    membersList.forEach(function (m) {
      if (m.sid === mySid || watching[m.sid]) return;
      var on = picked.indexOf(m.sid) >= 0;
      var b = document.createElement('button');
      b.className = 'player-chip' + (on ? ' on' : '');
      b.textContent = (on ? '✓ ' : '') + m.nickname;
      b.onclick = function () { togglePick(m.sid); };
      box.appendChild(b);
    });
    var btn = $('btn-game-start');
    if (btn) btn.textContent = '开局（' + picked.length + '/3）';
  }

  function syncSeats() {
    if (!game) return;
    game.syncSeats();
    renderGame(game.state);
  }

  var RANK_LABEL = ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' });

  function cardEl(c, sel, onClick) {
    var d = document.createElement('div');
    d.className = 'pcard' + ((c.s === 'H' || c.s === 'D') ? ' red' : '') + (sel ? ' sel' : '');
    var r = RANK_LABEL[c.r] || c.r;
    var suit = c.s === 'W' ? (c.r === 17 ? '👑' : '🃏') : ({ S: '♠', H: '♥', C: '♣', D: '♦' })[c.s];
    // Corner pip (rank + suit) in the top-left, like a real poker card. When
    // cards are fanned vertically each card's corner stays visible, so the
    // player can read the suit of an individual card and tap just that card.
    var corner = document.createElement('span');
    corner.className = 'pip';
    var cr = document.createElement('b'); cr.textContent = r;
    var cs = document.createElement('i'); cs.textContent = suit;
    corner.appendChild(cr); corner.appendChild(cs);
    var big = document.createElement('span'); big.className = 'suit'; big.textContent = suit;
    d.appendChild(corner); d.appendChild(big);
    d.dataset.id = c.id;
    d.title = r + suit;
    if (onClick) { d.style.cursor = 'pointer'; d.addEventListener('click', onClick); }
    return d;
  }

  /* Order the hand the way a player reads it (理牌): strongest rank first —
   * jokers, level card/2, A, K … 3 — same-rank cards stacked together.
   * Uses the engine's deterministic sortHandForView. */
  function arrangedOrder(cards, st) {
    if (window.PCGame && window.PCGame.sortHandForView && cards.length) {
      return window.PCGame.sortHandForView(cards, st.level);
    }
    return cards.slice().sort(function (a, b) {
      return (b.s === 'W' ? 100 + b.r : b.r) - (a.s === 'W' ? 100 + a.r : a.r);
    });
  }

  /* Render my (or observed target's) hand.
   * Default: same-rank cards are fanned VERTICALLY (each card steps down and
   * right a little) so every card's rank+suit corner stays readable and each
   * card can be tapped INDIVIDUALLY — selecting a pair/triple is done by
   * tapping the specific cards you want, not a whole-group toggle.
   * `spread` flattens every card in a single row. Observers get a read-only hand. */
  function renderHand(hand, shown, st) {
    // Rebuilding innerHTML resets scrollLeft to 0. On a phone the fan is
    // wider than the screen, so selecting a card near the end would snap the
    // hand back to the start. Preserve the scroll offset across re-renders.
    var prevScroll = hand.scrollLeft;
    hand.innerHTML = '';
    if (!shown.length) return;
    var readonly = !!st.spectator;
    var ordered = arrangedOrder(shown, st);
    // Group by rank in the arranged order.
    var groups = [], byRank = {};
    ordered.forEach(function (c) {
      var key = c.r;
      if (!byRank[key]) { byRank[key] = { rank: c.r, cards: [] }; groups.push(byRank[key]); }
      byRank[key].cards.push(c);
    });
    function toggleOne(c) {
      return readonly ? null : function (e) {
        if (e) e.stopPropagation();
        selected[c.id] = !selected[c.id];
        renderGame(game.state);
      };
    }
    groups.forEach(function (g) {
      if (spread || g.cards.length === 1) {
        g.cards.forEach(function (c) {
          hand.appendChild(cardEl(c, !readonly && !!selected[c.id], toggleOne(c)));
        });
        return;
      }
      // Vertical fan: each card offset down/right just enough to expose its
      // top-left rank+suit pip, so a player can read and tap a single card.
      var stack = document.createElement('div');
      stack.className = 'pcard-stack';
      // Footprint must match the CURRENT card size. Cards shrink on portrait
      // phones (36x52 / 8/18) and again on short landscape screens (30x44 /
      // 6/12); desktop numbers here would leave big gaps and waste the little
      // vertical room a landscape phone has. Keep these in sync with the CSS
      // media queries (max-width:720px and orientation:landscape+max-height).
      var cardW = 44, cardH = 62, stepX = 10, stepY = 22;
      if (window.matchMedia) {
        if (window.matchMedia('(orientation:landscape) and (max-height:520px)').matches) {
          cardW = 30; cardH = 44; stepX = 6; stepY = 12;
        } else if (window.matchMedia('(max-width:720px)').matches) {
          cardW = 36; cardH = 52; stepX = 8; stepY = 18;
        }
      }
      // Reserve the fanned footprint so cards don't overflow the hand row.
      stack.style.width = (cardW + stepX * (g.cards.length - 1)) + 'px';
      stack.style.height = (cardH + stepY * (g.cards.length - 1)) + 'px';
      // z-index rises with row so lower cards' pips are not covered.
      g.cards.forEach(function (c, i) {
        var el = cardEl(c, !readonly && !!selected[c.id], toggleOne(c));
        el.style.setProperty('--i', String(i));
        el.style.zIndex = String(i + 1);
        stack.appendChild(el);
      });
      stack.title = (RANK_LABEL[g.rank] || g.rank) + ' × ' + g.cards.length + '（点单张牌可选/取消）';
      hand.appendChild(stack);
    });
    // Restore the horizontal scroll offset captured above so tapping a card
    // does not yank the fan back to its beginning.
    if (prevScroll) hand.scrollLeft = prevScroll;
  }

  /* Two decks: each ordinary rank appears eight times, each joker twice.
   * The counter subtracts played cards plus the cards this client can see. */
  function renderCounter(st) {
    var box = $('card-counter');
    if (!box || !window.PCGame) return;
    var counts = {}, order = [];
    window.PCGame.makeDeck().forEach(function (c) {
      if (counts[c.r] === undefined) { counts[c.r] = 0; order.push(c.r); }
      counts[c.r]++;
    });
    var known = (st.played || []).concat(st.spectator ? (st.targetHand || []) : (st.hand || []));
    known.forEach(function (c) { if (counts[c.r] !== undefined) counts[c.r]--; });
    box.innerHTML = '';
    var title = document.createElement('span');
    title.className = 'cc-title'; title.textContent = '记牌器 · 剩余';
    box.appendChild(title);
    order.sort(function (a, b) { return a - b; }).forEach(function (r) {
      var el = document.createElement('span');
      el.className = 'cc-rank' + (counts[r] <= 0 ? ' zero' : '');
      var label = ({ 15: '2', 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 16: '小王', 17: '大王' })[r] || String(r);
      el.textContent = label + ' ';
      var b = document.createElement('b'); b.textContent = Math.max(0, counts[r]);
      el.appendChild(b);
      box.appendChild(el);
    });
  }

  function renderGame(st) {
    var seats = $('game-seats'), table = $('game-table'), hand = $('my-hand'), log = $('game-log');
    if (!seats || !table || !hand) return;
    if (!$('game-panel') || $('game-panel').classList.contains('hidden')) return;
    if (st.phase === 'playing' || st.phase === 'dealing' || st.spectator) showSetup(false);
    renderCounter(st);
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
    // Table (last play). Animate only when the play actually CHANGES; ordinary
    // re-renders (turn highlight, note, timer) keep the same signature so cards
    // already on the table do not replay the animation.
    var tSig = (st.table && st.table.cards && st.table.cards.length)
      ? (st.table.bySid || '') + '|' + st.table.cards.map(function (c) { return c.id; }).join(',')
      : '';
    // Rebuild the table ONLY when the play changes. Leaving the DOM untouched
    // on ordinary re-renders (or when the broadcast echoes the same cards) lets
    // the play-in animation finish instead of being wiped mid-flight.
    if (tSig !== lastTableSig) {
      lastTableSig = tSig;
      table.innerHTML = '';
      if (st.table && st.table.cards && st.table.cards.length) {
        st.table.cards.forEach(function (c) {
          var el = cardEl(c, false);
          el.classList.add('play-in');
          table.appendChild(el);
        });
      } else {
        var tip = document.createElement('div'); tip.className = 'tip';
        tip.textContent = st.spectator ? '旁观中 · 等待玩家出牌' : (st.phase === 'idle' ? '点击「开局」开始' : '新一轮 · 请领出');
        table.appendChild(tip);
      }
    }
    // My hand — observers see the ONE target's hand (read-only), players see own.
    var shown = st.spectator ? (st.targetHand || []) : (st.hand || []);
    renderHand(hand, shown, st);
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
    var inPlay = st.phase === 'playing' && !st.spectator;
    var btnPlay = $('btn-game-play'), btnPass = $('btn-game-pass');
    if (btnPlay) btnPlay.disabled = !myTurn;
    // Keep 过牌 clickable for the whole match: a grey button that ignores taps
    // is read as "broken". Clicking off-turn / on the lead now yields a clear
    // toast from game.pass(). A dimmed style still hints when it is not ready.
    if (btnPass) {
      btnPass.disabled = !inPlay;
      btnPass.classList.toggle('muted', !myTurn || !st.table);
    }
    var btnStart = $('btn-game-start');
    if (btnStart) btnStart.classList.toggle('hidden', st.phase === 'playing' || st.spectator);
    if (log) { log.innerHTML = ''; st.log.slice(-12).forEach(function (t) {
      var d = document.createElement('div'); d.textContent = t; log.appendChild(d);
    }); log.scrollTop = log.scrollHeight; }
  }

  function toggleGame() {
    var p = $('game-panel'); if (!p) return;
    var btn = $('btn-game');
    if (btn && btn.disabled) {
      if (ctx) ctx.toast('房间内至少 4 人才能开启掼蛋');
      return;
    }
    var opening = p.classList.contains('hidden');
    p.classList.toggle('hidden');
    if (opening) {
      syncSeats();
      if (game && !game.state.spectator &&
          (game.state.phase === 'idle' || game.state.phase === 'finished')) {
        autoPick();
        showSetup(true);
      } else {
        showSetup(false);
      }
      if (game) renderGame(game.state);
    }
  }

  function onPlayClick() {
    var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
    if (!ids.length) { ctx.toast('先点选要出的牌'); return; }
    // play() is synchronous and repaints optimistically (incl. the table play
    // animation); clear the selection in the same tick so a second tap cannot
    // re-send. No extra renderGame here — it would wipe the animation DOM.
    var ok = game.play(ids);
    if (ok) selected = {};
  }

  function onPassClick() { game.pass(); }

  function onArrangeClick() {
    if (!game) return;
    if (game.state.spectator) { ctx.toast('旁观模式不能整理手牌'); return; }
    if (!game.autoArrange || !game.autoArrange()) ctx.toast('暂无可整理的手牌');
    else renderGame(game.state);
  }
  function onSpreadClick() {
    spread = !spread;
    var b = $('btn-game-spread');
    if (b) b.textContent = spread ? '⊞ 堆叠' : '↔ 平铺';
    if (game) renderGame(game.state);
  }

  function onStartClick() {
    if (!game) return;
    if (picked.length !== 3) { if (ctx) ctx.toast('请先选择另外 3 名玩家'); return; }
    var watching = watcherMap();
    var ok = picked.every(function (s) {
      return s !== mySid && !watching[s] && membersList.some(function (m) { return m.sid === s; });
    });
    if (!ok) { if (ctx) ctx.toast('所选玩家已离线或正在旁观，请重新选择'); renderSetup(); return; }
    // Close the picker immediately; the deal frame will render the next round.
    showSetup(false);
    // Everyone applies the same seat list; only the selected host deals.
    game.requestStart([mySid].concat(picked));
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

  /* PiP video drag. Uses Pointer Events so the SAME handler works for mouse,
   * pen and touch — a mouse-only implementation left the small window
   * completely undraggable on phones, where it covered the play/pass row. */
  function initPiPDrag() {
    var box = $('pip-video'), head = $('pip-head');
    if (!box || !head) return;
    var dragging = false, ox = 0, oy = 0;
    function down(e) {
      // Let the close button work; never start a drag from it.
      if (e.target && (e.target.id === 'btn-pip-close' || e.target.tagName === 'BUTTON')) return;
      dragging = true;
      var r = box.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      box.style.right = 'auto'; box.style.bottom = 'auto'; box.style.top = r.top + 'px';
      if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (_) {} }
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      var maxX = Math.max(0, window.innerWidth - box.offsetWidth);
      var maxY = Math.max(0, window.innerHeight - 56);
      box.style.left = Math.max(0, Math.min(maxX, e.clientX - ox)) + 'px';
      box.style.top = Math.max(0, Math.min(maxY, e.clientY - oy)) + 'px';
      e.preventDefault();
    }
    function up() { dragging = false; }
    head.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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

  /* ---- Bot diagnostics panel: refresh / copy / download the trace ---- */
  function openDiag() {
    var p = $('diag-panel');
    if (!p) return;
    p.classList.remove('hidden');
    refreshDiag();
  }
  function closeDiag() {
    var p = $('diag-panel');
    if (p) p.classList.add('hidden');
  }
  function diagTextSafe() {
    if (!game || typeof game.diagText !== 'function') return '（诊断功能不可用：游戏引擎未初始化）';
    try { return game.diagText(); } catch (e) { return '（读取诊断日志失败：' + (e && e.message ? e.message : e) + '）'; }
  }
  function refreshDiag() {
    var body = $('diag-body');
    if (body) body.textContent = diagTextSafe();
  }
  function copyDiag() {
    var text = diagTextSafe();
    var done = function (ok) { ctx && ctx.toast(ok ? '诊断日志已复制到剪贴板' : '复制失败，请长按日志手动全选'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
    } catch (e) { done(false); }
  }
  function downloadDiag() {
    var text = diagTextSafe();
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '掼蛋机器人诊断日志-' + Date.now() + '.txt';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      ctx && ctx.toast('诊断日志已下载');
    } catch (e) { ctx && ctx.toast('下载失败，请使用复制功能'); }
  }

  function wire() {
    $('btn-game') && $('btn-game').addEventListener('click', toggleGame);
    $('btn-game-start') && $('btn-game-start').addEventListener('click', onStartClick);
    $('btn-game-play') && $('btn-game-play').addEventListener('click', onPlayClick);
    $('btn-game-pass') && $('btn-game-pass').addEventListener('click', onPassClick);
    $('btn-game-arrange') && $('btn-game-arrange').addEventListener('click', onArrangeClick);
    $('btn-game-spread') && $('btn-game-spread').addEventListener('click', onSpreadClick);
    $('btn-game-diag') && $('btn-game-diag').addEventListener('click', openDiag);
    $('btn-diag-close') && $('btn-diag-close').addEventListener('click', closeDiag);
    $('btn-diag-refresh') && $('btn-diag-refresh').addEventListener('click', refreshDiag);
    $('btn-diag-copy') && $('btn-diag-copy').addEventListener('click', copyDiag);
    $('btn-diag-download') && $('btn-diag-download').addEventListener('click', downloadDiag);
    $('btn-spectate') && $('btn-spectate').addEventListener('click', requestSpectate);
    $('btn-setup-close') && $('btn-setup-close').addEventListener('click', function () { showSetup(false); });
    $('game-setup-mask') && $('game-setup-mask').addEventListener('click', function () { showSetup(false); });
    $('btn-voice-live') && $('btn-voice-live').addEventListener('click', toggleVoice);
    $('btn-pip-close') && $('btn-pip-close').addEventListener('click', pipClear);
    initPiPDrag();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  return {
    bind: bind, onMembers: onMembers, onGameState: onGameState, onSpectateState: onSpectateState, renderGame: renderGame,
    pipAddVideo: pipAddVideo, pipClear: pipClear,
    selectCard: function (id) { selected[id] = !selected[id]; },
    _selected: function () { return selected; }
  };
})();
