/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom deluxe UI glue. */
'use strict';
/*
 * PCDeluxe — deluxe-edition UI controller. Loaded only in the deluxe template.
 * Bridges the shared app.js hooks to the Guandan game, 3D scene, live voice
 * and draggable PiP video. The simple edition never loads this file.
 */
window.PCDeluxe = (function () {
  var game = null, ctx = null, selected = {};
  var membersList = [], mySid = null, picked = [], setupOpen = false;
  var partnerPick = null;   // sid of chosen 对家 (teammate)
  var spread = false; // false = stacked by rank (default), true = flat (v24: set by 平铺 cycle mode)
  var marqueeOn = true; // v24: box-select is ALWAYS on (button removed)
  var lastTableSig = ''; // signature of the last rendered table, for play animation
  var settleShownFor = null; // round number whose settlement panel is currently shown
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
    if (partnerPick && picked.indexOf(partnerPick) === -1) partnerPick = null;
    var btn = $('btn-game');
    if (btn) {
      var enough = membersList.length >= 4;
      btn.disabled = !enough;
      btn.title = enough ? '选择另外 3 名玩家后开局' :
        ('房间内至少 4 人才能开局（当前 ' + membersList.length + ' 人）');
    }
    if (setupOpen) renderSetup();
  }

  /* Spectator feature removed (v23): nobody watches anybody. Kept as a no-op
   * so seat auto-pick logic stays simple and stable. */
  function watcherMap() { return {}; }

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
    partnerPick = picked.length >= 2 ? picked[1] : null;
  }

  /* Exactly one other seat per click, up to three. */
  function togglePick(sid) {
    var i = picked.indexOf(sid);
    if (i >= 0) picked.splice(i, 1);
    else {
      if (picked.length >= 3) { if (ctx) ctx.toast('只能选择另外 3 名玩家'); return; }
      picked.push(sid);
    }
    if (partnerPick && picked.indexOf(partnerPick) === -1) partnerPick = null;
    renderSetup();
  }

  function togglePartner(sid) {
    if (picked.indexOf(sid) === -1) return;
    partnerPick = (partnerPick === sid) ? null : sid;
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
    // Partner picker: only the three chosen players can be 对家.
    var pbox = $('partner-picks');
    if (pbox) {
      pbox.innerHTML = '';
      var effective = partnerPick || picked[1];
      picked.forEach(function (sid) {
        var m = membersList.filter(function (x) { return x.sid === sid; })[0];
        var b = document.createElement('button');
        b.className = 'partner-chip' + (effective === sid ? ' on' : '');
        b.textContent = (effective === sid ? '✓ 对家 · ' : '') + ((m && m.nickname) || sid);
        b.onclick = function () { togglePartner(sid); };
        pbox.appendChild(b);
      });
      if (!picked.length) {
        var hint = document.createElement('span');
        hint.className = 'setup-title'; hint.textContent = '请先选择玩家';
        pbox.appendChild(hint);
      }
    }
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
    // v24: when a 理牌 scheme is active, render by its combos (see renderHand),
    // so simply preserve the order the scheme produced.
    if (st && st.arrangeGroups && st.arrangeGroups.length && cards.length) return cards.slice();
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
    var readonly = false; // spectator feature removed — everyone plays their own hand
    var ordered = arrangedOrder(shown, st);
    // v24: when a 理牌 scheme is active, group cards by the scheme's combos
    // (labelled stacks: 炸弹/顺子/同花顺…); otherwise group by rank as before.
    var groups = [], byRank = {};
    if (st && st.arrangeGroups && st.arrangeGroups.length) {
      var byId = {};
      ordered.forEach(function (c) { byId[c.id] = c; });
      st.arrangeGroups.forEach(function (ag) {
        var cs = [];
        ag.ids.forEach(function (id) { if (byId[id]) { cs.push(byId[id]); delete byId[id]; } });
        if (cs.length) groups.push({ rank: cs[0].r, label: ag.name, cards: cs });
      });
      // Safety: any card not covered by a scheme group still gets shown.
      ordered.forEach(function (c) {
        if (byId[c.id]) { groups.push({ rank: c.r, label: '', cards: [c] }); delete byId[c.id]; }
      });
    } else {
      ordered.forEach(function (c) {
        var key = c.r;
        if (!byRank[key]) { byRank[key] = { rank: c.r, label: '', cards: [] }; groups.push(byRank[key]); }
        byRank[key].cards.push(c);
      });
    }
    function toggleOne(c) {
      return readonly ? null : function (e) {
        if (e) e.stopPropagation();
        selected[c.id] = !selected[c.id];
        renderGame(game.state);
      };
    }
    function allGroupSelected(g) {
      return g.cards.every(function (c) { return !!selected[c.id]; });
    }
    function toggleGroup(g) {
      if (readonly) return;
      var on = !allGroupSelected(g);
      g.cards.forEach(function (c) { selected[c.id] = on; });
      renderGame(game.state);
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
      stack.title = (g.label ? g.label + ' · ' : '') +
        (RANK_LABEL[g.rank] || g.rank) + ' × ' + g.cards.length + '（点单张牌可选/取消）';
      // v24: show the scheme's combo name (炸弹/顺子/同花顺…) when 理牌 is active.
      if (g.label) {
        var lab = document.createElement('span');
        lab.className = 'stack-label';
        lab.textContent = g.label;
        stack.appendChild(lab);
      }
      // "全选" under each same-rank stack: tap to select/deselect the whole
      // group in one action (the user asked for a per-group select-all).
      if (!readonly) {
        var allBtn = document.createElement('button');
        allBtn.className = 'stack-all';
        allBtn.textContent = allGroupSelected(g) ? '取消全选' : '全选 ×' + g.cards.length;
        allBtn.onclick = function (e) { if (e) e.stopPropagation(); toggleGroup(g); };
        stack.appendChild(allBtn);
      }
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
    var known = (st.played || []).concat(st.hand || []);
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

  /* Settlement overlay: four ranks (大科/二科/二拉/大拉) + confirm-to-continue.
   * Shown once per round; rebuilt only when the round number changes so the
   * user's reading isn't interrupted by unrelated re-renders. */
  function renderSettle(st) {
    var box = $('game-settle'), mask = $('game-settle-mask');
    if (!box || !mask) return;
    var show = st.phase === 'finished' && !!st.result;
    if (!show) {
      box.classList.add('hidden'); mask.classList.add('hidden');
      settleShownFor = null;
      return;
    }
    box.classList.remove('hidden'); mask.classList.remove('hidden');
    if (settleShownFor === st.roundNo) return; // already painted this round
    settleShownFor = st.roundNo;
    var res = st.result;
    var title = $('settle-title');
    if (title) title.textContent = '🏁 第 ' + (res.round || st.roundNo) + ' 局结算 · 打 ' + game.rankName(res.levelAfter);
    var sub = $('settle-sub');
    if (sub) {
      var partnerName = (st.seats.filter(function (s) { return s.sid === res.partnerSid; })[0] || {}).nickname || '对家';
      sub.textContent = (res.win ? '🎉 本队获胜 · 升 ' + res.delta + ' 级 → 打 ' + game.rankName(res.levelAfter)
        : '对方领先 · 打 ' + game.rankName(res.levelAfter)) +
        ' · 对家 ' + partnerName + ' · 下一局打 ' + game.rankName(res.levelAfter);
    }
    var list = $('settle-ranks');
    if (list) {
      list.innerHTML = '';
      (res.ranks || []).forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'settle-row' + (r.isMe ? ' me' : '');
        var b = document.createElement('span'); b.className = 'badge-rank'; b.textContent = r.title;
        var who = document.createElement('span'); who.className = 'who';
        who.textContent = r.nickname + (r.isMe ? '（我）' : '');
        var tag = document.createElement('span'); tag.className = 'tag' + (r.teammate ? ' mate' : '');
        tag.textContent = r.teammate ? '本队' : '对方';
        row.appendChild(b); row.appendChild(who); row.appendChild(tag);
        list.appendChild(row);
      });
    }
    var next = $('btn-settle-next');
    if (next) {
      var host = game.mySid && st.hostSid === game.mySid();
      next.textContent = host ? '确认 · 开始第 ' + ((res.round || st.roundNo) + 1) + ' 局（打 ' + game.rankName(res.levelAfter) + '）'
        : '等待房主开始下一局';
      next.disabled = !host;
    }
  }

  function renderGame(st) {
    var seats = $('game-seats'), table = $('game-table'), hand = $('my-hand'), log = $('game-log');
    if (!seats || !table || !hand) return;
    if (!$('game-panel') || $('game-panel').classList.contains('hidden')) return;
    if (st.phase === 'playing' || st.phase === 'dealing') showSetup(false);
    renderCounter(st);
    // Seats — each player has a DISTINCT position showing their nickname,
    // remaining card count (highlighted when < 10) and their last play THIS
    // trick. This makes "谁出了什么" readable without guessing from one pile.
    seats.innerHTML = '';
    for (var i = 0; i < 4; i++) {
      var s = st.seats[i];
      var el = document.createElement('div');
      el.className = 'seat' + (s && s.isMe ? ' me' : '') + (st.turn && s && st.turn === s.sid ? ' turn' : '');
      var nm = document.createElement('div');
      var role = '';
      if (s && st.partnerSid === s.sid) role = ' · 对家';
      nm.textContent = s ? (s.nickname + (s.isMe ? '（我）' : '') + role) : '空位';
      var cnt = document.createElement('div'); cnt.className = 'cnt';
      if (s && st.phase !== 'idle' && st.phase !== 'dealing') {
        var left = (game && game.remainingOf) ? game.remainingOf(s.sid) : null;
        if (left === 0) { cnt.textContent = '出完'; cnt.classList.add('out'); }
        else if (left !== null && left < 10) { cnt.textContent = '剩 ' + left + ' 张'; cnt.classList.add('low'); }
        else cnt.textContent = left !== null ? (left + ' 张') : '·';
      } else {
        cnt.textContent = s ? (st.phase === 'dealing' ? '发牌中' : '·') : '—';
      }
      el.appendChild(nm); el.appendChild(cnt);
      // Per-seat last play (compact face labels) so each position is distinct.
      var sp = document.createElement('div'); sp.className = 'seat-play';
      var play = st.seatPlays && st.seats[i] ? st.seatPlays[s.sid] : null;
      if (play && play.cards && play.cards.length) {
        var lab = document.createElement('span'); lab.className = 'sp-label';
        lab.textContent = (play.pattern && (play.pattern.name || play.pattern.type)) || '出';
        sp.appendChild(lab);
        play.cards.forEach(function (c) {
          var cc = document.createElement('span'); cc.className = 'sp-card' +
            ((c.s === 'H' || c.s === 'D') ? ' red' : '');
          cc.textContent = (RANK_LABEL[c.r] || c.r) + (c.s === 'W' ? '' : ({ S: '♠', H: '♥', C: '♣', D: '♦' }[c.s] || ''));
          sp.appendChild(cc);
        });
      } else if (play && play.passed) {
        var ps = document.createElement('span'); ps.className = 'sp-pass'; ps.textContent = '过';
        sp.appendChild(ps);
      }
      el.appendChild(sp);
      seats.appendChild(el);
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
        tip.textContent = st.phase === 'idle' ? '点击「开局」开始' : '新一轮 · 请领出';
        table.appendChild(tip);
      }
    }
    // My hand
    var shown = st.hand || [];
    renderHand(hand, shown, st);
    // Level / turn
    var lv = $('game-level'); if (lv) lv.textContent = '打 ' + game.rankName(st.level) + ' · 第 ' + (st.roundNo || 1) + ' 局';
    var myTurn = st.turn === ctx.state.mySid;
    var inPlay = st.phase === 'playing';
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
    if (btnStart) btnStart.classList.toggle('hidden', st.phase === 'playing' || st.phase === 'finished');
    if (log) { log.innerHTML = ''; st.log.slice(-12).forEach(function (t) {
      var d = document.createElement('div'); d.textContent = t; log.appendChild(d);
    }); log.scrollTop = log.scrollHeight; }
    renderSettle(st);
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
      if (game && game.state.phase === 'idle') {
        autoPick();
        showSetup(true);
      } else {
        // finished phase is handled by the settlement overlay, not the picker
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

  /* v25: one short-labelled button cycles 平铺 → 堆叠 → 火力 → 少手 → back.
   * The engine performs the reorder and reports label + spread; the button
   * mirrors it with a compact label so it keeps a normal (equal-width) size. */
  function onArrangeClick() {
    if (!game) return;
    var r = game.autoArrange && game.autoArrange();
    if (!r) { ctx.toast('暂无可整理的手牌'); return; }
    spread = !!r.spread;
    var b = $('btn-game-arrange');
    if (b) {
      b.textContent = r.label;
      b.title = '当前：' + r.label.replace(/^\S+\s/, '') + ' · 点击循环：平铺→堆叠→火力→少手';
    }
    renderGame(game.state);
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
    // The chosen 对家 is passed so seat2 (opposite) becomes the teammate.
    var partner = partnerPick || picked[1];
    game.requestStart([mySid].concat(picked), partner);
  }

  function onGameState(f) { /* public turn/seat state already rendered via game.onUpdate */ }

  /* --- full-duplex live voice (audio-only). Auto-answer lives in media.js. --- */
  function toggleVoice() {
    if (!window.PCMedia || !ctx || !ctx.media) return;
    if (!ctx.media.inCall()) {
      ctx.media.startVoice();
      var b = $('btn-voice-live'); if (b) b.classList.add('on');
    } else {
      ctx.media.hangup();
      var b2 = $('btn-voice-live'); if (b2) b2.classList.remove('on');
      ctx.toast('语音通话已关闭');
    }
  }

  /* Small status chip in the top bar during a live voice call (no video). */
  function pipShowStatus(on) {
    var b = $('btn-voice-live');
    if (b) { b.classList.toggle('on', !!on); b.textContent = on ? '🎧 通话中' : '🎧 全双工语音'; }
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

  /* ---- Drag box-select (画框多选) over the hand row ----
   * Pointer Events cover mouse+touch. When active, dragging on empty hand
   * space draws a rectangle; cards whose CENTER falls inside are selected.
   * Tapping an individual card still toggles it (handled by cardEl onClick). */
  function initMarquee() {
    var hand = $('my-hand');
    if (!hand) return;
    var dragging = false, pending = false, sx = 0, sy = 0, rect = null;
    var DRAG_TH = 6; // px: below this it's a tap (card selects itself), above = marquee

    function inside(boxEl, x, y) {
      return boxEl && x >= boxEl.left && x <= boxEl.right && y >= boxEl.top && y <= boxEl.bottom;
    }
    /* Convert a pointer's viewport coords to coords inside #my-hand's CONTENT
     * box. The marquee is absolutely positioned inside #my-hand (which is
     * position:relative), so its left/top are content coords and MUST include
     * scrollLeft/scrollTop — otherwise the box appears offset from the cards
     * whenever the hand has been scrolled (the "框选区不在纸牌区" symptom). */
    function local(e) {
      var r = hand.getBoundingClientRect();
      return {
        x: e.clientX - r.left + hand.scrollLeft,
        y: e.clientY - r.top + hand.scrollTop,
        maxX: hand.scrollWidth,
        maxY: hand.scrollHeight
      };
    }
    function down(e) {
      if (!marqueeOn || !game) return;
      // Buttons keep their own click behaviour. Cards are ALLOWED as a drag
      // start: we only begin the marquee past DRAG_TH, so a plain tap still
      // selects that single card via cardEl's own click handler.
      if (e.target && (e.target.closest && e.target.closest('button'))) return;
      var p = local(e);
      sx = p.x; sy = p.y;
      pending = true; dragging = false;
      e.preventDefault(); // stop native drag/scroll from stealing the gesture
    }
    function move(e) {
      if (!pending) return;
      var p = local(e);
      var cx = Math.max(0, Math.min(p.maxX, p.x));
      var cy = Math.max(0, Math.min(p.maxY, p.y));
      if (!dragging) {
        if (Math.abs(cx - sx) < DRAG_TH && Math.abs(cy - sy) < DRAG_TH) return;
        // Crossed the threshold: create the box anchored at the start point.
        dragging = true;
        rect = document.createElement('div'); rect.className = 'hand-marquee';
        rect.style.left = Math.min(sx, cx) + 'px'; rect.style.top = Math.min(sy, cy) + 'px';
        rect.style.width = Math.abs(cx - sx) + 'px'; rect.style.height = Math.abs(cy - sy) + 'px';
        hand.appendChild(rect);
      }
      rect.style.left = Math.min(sx, cx) + 'px';
      rect.style.top = Math.min(sy, cy) + 'px';
      rect.style.width = Math.abs(cx - sx) + 'px';
      rect.style.height = Math.abs(cy - sy) + 'px';
      e.preventDefault();
    }
    function up() {
      // A plain tap (never crossed the threshold) is left to cardEl's click
      // handler so single-card select/deselect still works while 框选 is on.
      if (!pending) return;
      pending = false;
      if (!dragging) return;
      dragging = false;
      if (rect) {
        var box = rect.getBoundingClientRect();
        if (rect.parentNode) rect.parentNode.removeChild(rect);
        rect = null;
        var cards = hand.querySelectorAll('.pcard[data-id]');
        for (var i = 0; i < cards.length; i++) {
          var c = cards[i], cr = c.getBoundingClientRect();
          if (inside(box, cr.left + cr.width / 2, cr.top + cr.height / 2)) {
            selected[c.dataset.id] = true;
          }
        }
        if (game) renderGame(game.state);
      }
    }
    hand.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    // v24: box-select is permanently enabled — no on/off button.
    hand.classList.add('marquee-on');
  }

  function onSettleNext() {
    if (!game) return;
    game.nextRound(); // host redeals; non-host sees "等待房主" and just waits
  }

  function wire() {
    $('btn-game') && $('btn-game').addEventListener('click', toggleGame);
    $('btn-game-start') && $('btn-game-start').addEventListener('click', onStartClick);
    $('btn-game-play') && $('btn-game-play').addEventListener('click', onPlayClick);
    $('btn-game-pass') && $('btn-game-pass').addEventListener('click', onPassClick);
    $('btn-game-arrange') && $('btn-game-arrange').addEventListener('click', onArrangeClick);
    // v24: 平铺/框选 buttons removed — 平铺 is a 理牌 cycle mode, 框选 always on.
    $('btn-game-diag') && $('btn-game-diag').addEventListener('click', openDiag);
    $('btn-diag-close') && $('btn-diag-close').addEventListener('click', closeDiag);
    $('btn-diag-refresh') && $('btn-diag-refresh').addEventListener('click', refreshDiag);
    $('btn-diag-copy') && $('btn-diag-copy').addEventListener('click', copyDiag);
    $('btn-diag-download') && $('btn-diag-download').addEventListener('click', downloadDiag);
    $('btn-setup-close') && $('btn-setup-close').addEventListener('click', function () { showSetup(false); });
    $('game-setup-mask') && $('game-setup-mask').addEventListener('click', function () { showSetup(false); });
    $('btn-settle-next') && $('btn-settle-next').addEventListener('click', onSettleNext);
    $('btn-settle-close') && $('btn-settle-close').addEventListener('click', function () {
      var b = $('game-settle'), m = $('game-settle-mask');
      if (b) b.classList.add('hidden'); if (m) m.classList.add('hidden');
    });
    $('game-settle-mask') && $('game-settle-mask').addEventListener('click', function () {
      var b = $('game-settle'); if (b) b.classList.add('hidden'); this.classList.add('hidden');
    });
    $('btn-voice-live') && $('btn-voice-live').addEventListener('click', toggleVoice);
    initMarquee();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  return {
    bind: bind, onMembers: onMembers, onGameState: onGameState, renderGame: renderGame,
    pipShowStatus: pipShowStatus,
    selectCard: function (id) { selected[id] = !selected[id]; },
    _selected: function () { return selected; }
  };
})();
