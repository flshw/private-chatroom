/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom game transport. */
'use strict';
/*
 * PCGameClient — Guandan match state machine over the existing E2EE channel.
 * Every payload is a normal chat envelope with kind='game', so the server only
 * ever sees ciphertext. Dealing wraps each player's hand to their own ukPub.
 *
 * Roles: seat 0 (lowest sid) is the authoritative host for turn order; all
 * result validation also runs locally via PCGame so a peer cannot cheat on
 * card strength. Spectating is ONE target per observer, consent-based, and
 * arbitrated server-side (GAME_SPECTATE / _REPLY / _STATE): the server never
 * sees cards. When a watch is approved, the host wraps that target's hand to
 * the observer's ukPub inside the very same deal envelope.
 */
window.PCGameClient = (function () {
  var P = window.PCProtocol;

  /* Test partners: deterministic virtual seats so every client computes the
   * same roster. They are NOT server members and hold no keys — the host keeps
   * their hands in plaintext locally and drives their moves over the E2EE game
   * channel, so the server still sees ciphertext only. */
  var BOT_SIDS = ['bot_1', 'bot_2', 'bot_3'];
  var BOT_NICKS = ['🤖 牌手1', '🤖 牌手2', '🤖 牌手3'];

  function create(ctx) {
    var self = {};
    var config = ctx.config, mySid = ctx.mySid, uk = ctx.uk;
    var members = ctx.members;       // PCMembers module
    var sendGame = ctx.sendGame;      // (plaintextGameJson) => sendKind(json,'game')
    var sendControl = ctx.sendControl || function () {}; // raw server control frames
    var toast = ctx.toast || function () {};
    var onUpdate = ctx.onUpdate || function () {};
    var botsEnabled = !!ctx.bots;        // deluxe only; simple edition has none
    var botTimer = null;                 // scheduler for the local bot's next move
    var botThinkingMs = 1400;            // slower: give a human a clear window to tap 过牌/出牌 before the bot grabs the turn

    function isBotSid(sid) { return BOT_SIDS.indexOf(sid) !== -1; }
    function botNick(sid) { var i = BOT_SIDS.indexOf(sid); return i < 0 ? '机器人' : BOT_NICKS[i]; }
    function clearBotTimer() { if (botTimer) { clearTimeout(botTimer); botTimer = null; } }

    var state = {
      level: 15,                      // start at 2
      phase: 'idle',                  // idle|dealing|playing|finished
      seats: [],                      // [{sid,nickname,isMe}]
      players: null,                  // the four chosen sids (sorted) once a match is set
      played: [],                     // every played card, for the card counter
      mySeat: -1,
      hostSid: null,
      hand: [],                       // my cards
      table: null,                    // {cards, type, bySid}
      lastWinner: null,
      passes: 0,
      turn: null,
      finishOrder: [],
      roundNo: 0,
      spectator: false,               // true once MY watch request is approved
      spectate: [],                   // public spectator relations (all observers)
      myRelation: null,               // my relation as an observer (pending|approved)
      pendingForMe: null,             // a pending request where I am the target
      watchTargetSid: null,          // the one player I am watching
      targetHand: [],                // target's hand, decrypted for me as observer
      bots: [],                      // virtual bot seats [{sid,nickname,isBot,isMe:false,ukPub:null}]
      botHands: {},                  // HOST ONLY: botSid -> plaintext cards (never leaves host)
      log: []
    };

    // I am playing unless my own watch is approved. Being a watch target does
    // not remove me from the game.
    function isHost() { return state.hostSid === mySid && !state.spectator; }
    function seatOfSid(sid) {
      for (var i = 0; i < state.seats.length; i++) if (state.seats[i].sid === sid) return i;
      return -1;
    }
    function note(text) { state.log.push(text); if (state.log.length > 40) state.log.shift(); onUpdate(state); }

    /* Verified humans plus locally-injected bots. Bots fill the table up to
     * four while humans < 4, and disappear as real players arrive. Humans are
     * always ordered before bots so seat 0 (the deal host) is a real person. */
    function allRoster() {
      var humans = members.all().slice().sort(function (a, b) { return a.sid.localeCompare(b.sid); });
      var roster = humans.slice();
      // Bots are single-player TEST STANDS-INS: exactly one real member in the
      // room => fill three bots so a solo tester can play 4-seat Guandan. As
      // soon as a second human joins, ALL bots step aside for the real players.
      // While a match is live the bot set is frozen so a mid-round join cannot
      // shuffle the seated players; the change applies from the next match.
      var wantBots = botsEnabled && humans.length === 1;
      if ((state.phase === 'playing' || state.phase === 'dealing') && state.bots.length) {
        wantBots = true; // keep current bots until this round finishes
      }
      var next = [];
      if (wantBots) {
        for (var i = 0; i < BOT_SIDS.length; i++) {
          next.push({ sid: BOT_SIDS[i], nickname: BOT_NICKS[i],
            isBot: true, isMe: false, ukPub: null });
        }
      }
      state.bots = next;
      if (next.length) roster = roster.concat(next);
      return roster;
    }

    function poolMember(sid) {
      var m = members.get(sid);
      if (m) return m;
      for (var i = 0; i < state.bots.length; i++) if (state.bots[i].sid === sid) return state.bots[i];
      return null;
    }

    /* Recompute seats from verified member list + bots; lowest sid = host.
     * An approved observer does not take a seat; being watched does not. */
    function syncSeats() {
      var roster = allRoster();
      var pool = roster;
      if (state.players && state.players.length === 4) {
        pool = state.players.map(function (sid) { return poolMember(sid); }).filter(Boolean);
      }
      if (state.spectator) pool = pool.filter(function (m) { return m.sid !== mySid; });
      state.seats = pool.slice(0, 4).map(function (m) {
        return { sid: m.sid, nickname: m.nickname, isBot: !!m.isBot, isMe: m.sid === mySid };
      });
      state.mySeat = seatOfSid(mySid);
      state.hostSid = state.seats.length ? state.seats[0].sid : null;
      return state.seats.length;
    }

    /* The starter picks the other three players. Everyone applies the same
     * ordered seat list from the E2EE 'start' frame, so deals cannot diverge. */
    function setPlayers(ids) {
      if (!ids || ids.length !== 4) return false;
      var seen = {}, list = [];
      ids.forEach(function (sid) {
        if (!sid || seen[sid] || !poolMember(sid)) return;
        seen[sid] = true; list.push(sid);
      });
      if (list.length !== 4) return false;
      // Real humans first (lowest sid = deal host), then bots in fixed order.
      list.sort(function (a, b) {
        var ba = isBotSid(a) ? 1 : 0, bb = isBotSid(b) ? 1 : 0;
        return ba - bb || a.localeCompare(b);
      });
      state.players = list;
      syncSeats(); onUpdate(state);
      return true;
    }

    /* --- E2EE deal: build per-player encrypted hand, wrapped to each ukPub --- */
    async function buildDeal() {
      syncSeats();
      if (state.seats.length !== 4) { toast('需要 4 名玩家才能开局'); return null; }
      var deck = window.PCGame.makeDeck();
      var hands = window.PCGame.deal(deck);
      var wrapped = {};
      state.botHands = {};
      for (var i = 0; i < 4; i++) {
        var seat = state.seats[i];
        // Bot seats have no public key: the HOST keeps their cards in plaintext
        // locally and drives their moves. No bot hand ever leaves the host.
        if (seat.isBot) {
          state.botHands[seat.sid] = window.PCBots.sortedHand(hands[i], state.level, window.PCGame);
          continue;
        }
        var m = members.get(seat.sid);
        if (!m) return null;
        var K = window.PCCrypto.randomBytes(32);
        var plain = JSON.stringify({ hand: hands[i].map(function (c) { return { s: c.s, r: c.r, id: c.id }; }) });
        var enc = window.PCCrypto.aesEncrypt(K, 'deal|' + config.roomId + '|' + state.roundNo + '|' + seat.sid, plain);
        wrapped[seat.sid] = {
          wrap: window.PCCrypto.wrapKey(K, m.ukPub),
          iv: enc.iv, ct: enc.ct, tag: enc.tag
        };
      }
      // For every APPROVED watch, wrap that target's hand to the observer too,
      // so the observer sees only the one player they were allowed to watch.
      // The AAD binds round + target + observer, preventing cross-watch replay.
      for (var w = 0; w < state.spectate.length; w++) {
        var rel = state.spectate[w];
        if (rel.status !== 'approved' || !rel.targetSid || !rel.spectatorSid) continue;
        var tIdx = -1;
        for (var q = 0; q < 4; q++) if (state.seats[q].sid === rel.targetSid) { tIdx = q; break; }
        if (tIdx < 0) continue;
        var obsMember = members.get(rel.spectatorSid);
        if (!obsMember) continue;
        var wK = window.PCCrypto.randomBytes(32);
        var wPlain = JSON.stringify({ hand: hands[tIdx].map(function (c) { return { s: c.s, r: c.r, id: c.id }; }) });
        var wEnc = window.PCCrypto.aesEncrypt(wK,
          'deal|' + config.roomId + '|' + state.roundNo + '|' + rel.targetSid + '|' + rel.spectatorSid, wPlain);
        wrapped[rel.spectatorSid] = {
          wrap: window.PCCrypto.wrapKey(wK, obsMember.ukPub),
          iv: wEnc.iv, ct: wEnc.ct, tag: wEnc.tag
        };
      }
      return { kind: 'deal', round: state.roundNo, level: state.level, hands: wrapped,
        host: mySid, order: state.seats.map(function (s) { return s.sid; }),
        bots: state.seats.filter(function (s) { return s.isBot; }).map(function (s) { return s.sid; }),
        watchTargetOf: (function () {
          var m = {};
          for (var z = 0; z < state.spectate.length; z++) {
            var r = state.spectate[z];
            if (r.status === 'approved') m[r.spectatorSid] = r.targetSid;
          }
          return m;
        })()
      };
    }

    async function onDeal(msg) {
      state.roundNo = msg.round;
      state.level = msg.level;
      state.hostSid = msg.host;
      state.phase = 'playing';
      state.table = null; state.tablePattern = null; state.passes = 0;
      state.finishOrder = []; state.log = []; state.played = [];
      state.botHands = state.botHands || {};
      if (msg.order && msg.order.length === 4) state.players = msg.order.slice();
      syncSeats();
      if (state.spectator) {
        // Decrypt only the ONE hand I was approved to watch.
        var watchedSid = (msg.watchTargetOf && msg.watchTargetOf[mySid]) || state.watchTargetSid;
        var w = msg.hands && watchedSid && msg.hands[mySid];
        state.targetHand = [];
        if (w) {
          try {
            var wK = window.PCCrypto.unwrapKey(w.wrap, uk.privatePem);
            var wPlain = window.PCCrypto.aesDecrypt(wK,
              'deal|' + config.roomId + '|' + state.roundNo + '|' + watchedSid + '|' + mySid,
              w.iv, w.ct, w.tag);
            state.targetHand = window.PCGame.sortHand(JSON.parse(wPlain).hand, state.level);
            var tn = (state.seats.filter(function (s) { return s.sid === watchedSid; })[0] || {}).nickname || '玩家';
            note('旁观 ' + tn + ' 的手牌（' + state.targetHand.length + ' 张）· 打' + rankName(state.level));
          } catch (e) { note('目标手牌解封失败：' + e.message); }
        } else {
          note('新一局开始（旁观等待中）· 打' + rankName(state.level));
        }
        state.turn = msg.order && msg.order[0];
      } else if (msg.hands && msg.hands[mySid]) {
        var w = msg.hands[mySid];
        try {
          var K = window.PCCrypto.unwrapKey(w.wrap, uk.privatePem);
          var plain = window.PCCrypto.aesDecrypt(K,
            'deal|' + config.roomId + '|' + state.roundNo + '|' + mySid, w.iv, w.ct, w.tag);
          state.hand = window.PCGame.sortHand(JSON.parse(plain).hand, state.level);
          note('发牌完成，你拿到 ' + state.hand.length + ' 张 · 打' + rankName(state.level));
        } catch (e) { toast('手牌解封失败：' + e.message); }
      }
      state.turn = (msg.order && msg.order[0]) || state.turn;
      onUpdate(state);
      scheduleBot();
    }

    async function openDealForLate(msg) {
      // Late joiner/spectator who missed the deal: only host can resend private hand.
      if (msg.requestBy === mySid && isHost() && state.phase === 'playing') {
        var rebuilt = { kind: 'deal', round: state.roundNo, level: state.level,
          hands: {}, host: mySid, order: state.seats.map(function (s) { return s.sid; }) };
        var mine = state.hand.map(function (c) { return { s: c.s, r: c.r, id: c.id }; });
        var K = window.PCCrypto.randomBytes(32);
        var enc = window.PCCrypto.aesEncrypt(K, 'deal|' + config.roomId + '|' + state.roundNo + '|' + msg.requestBy,
          JSON.stringify({ hand: mine }));
        var m = members.get(msg.requestBy);
        if (m) {
          rebuilt.hands[msg.requestBy] = {
            wrap: window.PCCrypto.wrapKey(K, m.ukPub), iv: enc.iv, ct: enc.ct, tag: enc.tag
          };
          sendGame(rebuilt);
        }
      }
    }

    /* --- play / pass ---
     * play() is synchronous: validation + optimistic local repaint happen now,
     * and the authoritative state (table/turn/log) still arrives via the E2EE
     * broadcast's onPlay. Returning a boolean lets the UI clear the selection
     * in the SAME tick as the click — otherwise a fast second tap sees a stale
     * selection and reports "pick a card first" although the play went through. */
    function play(cardIds) {
      if (state.phase !== 'playing' || state.spectator) return false;
      if (state.turn !== mySid) { toast('还没轮到你'); return false; }
      var sel = state.hand.filter(function (c) { return cardIds.indexOf(c.id) !== -1; });
      if (!sel.length || sel.length !== cardIds.length) { toast('无效的选牌'); return false; }
      var pattern = window.PCGame.classify(sel, state.level);
      if (!pattern) { toast('这不是合法牌型'); return false; }
      if (!window.PCGame.canBeat(pattern, state.tablePattern, state.level)) {
        toast('压不过桌面上的牌'); return false;
      }
      var msg = { kind: 'play', round: state.roundNo, by: mySid,
        cards: sel.map(function (c) { return { s: c.s, r: c.r, id: c.id }; }),
        pattern: { type: pattern.type, rank: pattern.rank, len: pattern.len } };
      sendGame(msg);
      // Immediate visual acknowledgement: drop the played cards from the hand,
      // credit the counter, and repaint — no waiting for the E2EE round trip.
      // Turn/table/log are left to onPlay(broadcast) as the single source of truth.
      state.hand = state.hand.filter(function (c) { return cardIds.indexOf(c.id) === -1; });
      sel.forEach(function (c) {
        if (!state.played.some(function (p) { return p.id === c.id; })) state.played.push(c);
      });
      // Mirror the table locally so the play animation fires on the same tick
      // as the tap; the broadcast's onPlay applies the identical cards/signature.
      state.table = { cards: msg.cards, type: pattern.type, bySid: mySid };
      state.tablePattern = pattern;
      state.passes = 0;
      onUpdate(state);
      return true;
    }

    function pass() {
      if (state.phase !== 'playing' || state.spectator) return;
      if (state.turn !== mySid) { toast('还没轮到你'); return; }
      // Guandan leader must play, but never leave the button silently dead:
      // a tap on the lead gives an explicit hint instead of doing nothing.
      if (!state.table) { toast('你是本轮首位领出，请先出牌（或点「自动理牌」）'); return; }
      sendGame({ kind: 'pass', round: state.roundNo, by: mySid });
    }

    async function onPlay(msg) {
      var pattern = window.PCGame.classify(msg.cards, state.level) || msg.pattern;
      state.table = { cards: msg.cards, type: pattern && pattern.type, bySid: msg.by };
      state.tablePattern = pattern;
      state.passes = 0;
      (msg.cards || []).forEach(function (c) {
        if (!state.played.some(function (p) { return p.id === c.id; })) {
          state.played.push({ s: c.s, r: c.r, id: c.id });
        }
      });
      var seat = seatOfSid(msg.by);
      if (msg.by !== mySid) {
        state.hand = state.hand.filter(function (c) {
          return !(msg.cards || []).some(function (p) { return p.id === c.id; });
        });
      }
      var who = state.seats[seat] ? state.seats[seat].nickname : '玩家';
      note(who + ' 出 ' + cardsLabel(msg.cards, pattern));
      if (state.hand.length === 0 && state.finishOrder.indexOf(mySid) === -1) {
        state.finishOrder.push(mySid);
        note('你出完了！第 ' + state.finishOrder.length + ' 名');
        sendGame({ kind: 'finished', round: state.roundNo, by: mySid, order: state.finishOrder.slice() });
      }
      advanceTurn(msg.by);
    }

    function onPass(msg) {
      state.passes++;
      var seat = seatOfSid(msg.by);
      note((msg.by === mySid ? '你' : (state.seats[seat] ? state.seats[seat].nickname : '玩家')) + ' 过牌');
      if (state.passes >= state.seats.length - 1 - state.finishOrder.length) {
        // New trick led by last winner.
        state.table = null; state.tablePattern = null; state.passes = 0;
        note('新一轮，由 ' + (state.seats[seatOfSid(state.lastWinner)] || {}).nickname + ' 领出');
        state.turn = state.lastWinner || state.turn;
      } else {
        advanceTurn(msg.by);
      }
      onUpdate(state);
      scheduleBot();
    }

    function advanceTurn(fromSid) {
      var i = seatOfSid(fromSid);
      for (var n = 1; n <= state.seats.length; n++) {
        var cand = state.seats[(i + n) % state.seats.length];
        if (state.finishOrder.indexOf(cand.sid) === -1) { state.turn = cand.sid; break; }
      }
      state.lastWinner = fromSid;
      onUpdate(state);
      scheduleBot();
    }

    /* --- local bot driver (host only) ---
     * Only the deal host owns bot hands. When the turn lands on a bot seat, it
     * arranges/decides with PCBots and publishes the move through the SAME E2EE
     * game channel. Every player receives the broadcast and applies onPlay /
     * onPass, so seats, table and card counter stay in sync everywhere. */
    function scheduleBot() {
      clearBotTimer();
      if (!botsEnabled || !isHost() || state.phase !== 'playing' || state.spectator) return;
      var sid = state.turn;
      if (!sid || !isBotSid(sid)) return;
      if (!state.botHands || !state.botHands[sid] || !state.botHands[sid].length) return;
      botTimer = setTimeout(function () { botTimer = null; botStep(sid); }, botThinkingMs);
    }

    function botStep(sid) {
      // Re-validate after the think delay: state may have moved on.
      if (!isHost() || state.phase !== 'playing' || state.spectator || state.turn !== sid) return;
      var hand = state.botHands[sid];
      if (!hand || !hand.length) return;
      var move = null;
      try {
        move = window.PCBots.chooseMove({
          hand: hand, tablePattern: state.tablePattern || null, level: state.level
        }, window.PCGame);
      } catch (e) { move = null; }
      if (!move) {
        // Cannot beat the table -> pass (legal whenever there is a table).
        sendGame({ kind: 'pass', round: state.roundNo, by: sid });
        return;
      }
      var ids = {};
      move.cards.forEach(function (c) { ids[c.id] = true; });
      state.botHands[sid] = hand.filter(function (c) { return !ids[c.id]; });
      sendGame({ kind: 'play', round: state.roundNo, by: sid,
        cards: move.cards.map(function (c) { return { s: c.s, r: c.r, id: c.id }; }),
        pattern: { type: move.pattern.type, rank: move.pattern.rank, len: move.pattern.len },
        bot: true });
      // Bot finished its cards -> announce so team scoring can resolve.
      if (!state.botHands[sid].length) {
        var order = state.finishOrder.slice();
        if (order.indexOf(sid) === -1) order.push(sid);
        sendGame({ kind: 'finished', round: state.roundNo, by: sid, order: order });
      }
    }

    function rankName(r) {
      return ({ 15: '2', 14: 'A', 13: 'K', 12: 'Q', 11: 'J' })[r] || String(r);
    }
    /* Human-readable cards for the play log: e.g. "K♥", "对 7", "顺子 3-K".
     * Suits make each play concrete without flooding the one-line log. */
    function cardsLabel(cards, pattern) {
      if (!cards || !cards.length) return '';
      var SUIT = { S: '♠', H: '♥', C: '♣', D: '♦' };
      function one(c) {
        if (c.s === 'W') return c.r === 17 ? '大王' : '小王';
        return rankName(c.r) + (SUIT[c.s] || '');
      }
      // TYPE codes: 1单张 2对子 3三张 4三带二 5顺子 6三连对 7钢板
      //             8四带二 9炸弹 10同花顺 11王炸
      var type = pattern && pattern.type;
      if (cards.length === 1) return one(cards[0]);
      if (type === 11) return '王炸 🃏👑';
      if (type === 9 || type === 10) return (pattern.name || '炸弹') + ' ' + rankName(cards[0].r);
      // Runs: show rank span, e.g. "顺子 3-J".
      if (type === 5 || type === 6 || type === 7) {
        return (pattern.name || '顺子') + ' ' + rankName(cards[0].r) + '-' + rankName(cards[cards.length - 1].r);
      }
      // Pairs / triples / carry combos: name + each concrete card face.
      var faces = cards.map(one).join(' ');
      return (pattern && pattern.name ? pattern.name + ' ' : '') + faces;
    }

    function onFinished(msg) {
      state.finishOrder = msg.order.slice();
      if (state.finishOrder.length >= 2) {
        var team = state.seats.map(function (s, idx) { return idx % 2; });
        var order = state.finishOrder.map(function (sid) { return seatOfSid(sid); });
        if (order.length >= 2 && team[order[0]] === team[order[1]]) {
          var delta = window.PCGame.levelDelta(order, team);
          state.level = bumpLevel(state.level, delta);
          note('本队获胜，升 ' + delta + ' 级 → 打' + rankName(state.level));
        } else {
          note('对方领先，本局结束');
        }
        state.phase = 'finished';
      }
      onUpdate(state);
    }

    function bumpLevel(cur, delta) {
      var next = cur + delta;
      if (next > 14) next = 3 + ((next - 15) % 12); // wrap A->3 after passing A
      return next;
    }

    /* Receive a decrypted game payload from the chat E2EE layer. */
    function onMessage(msg) {
      switch (msg.kind) {
        case 'deal': onDeal(msg); break;
        case 'deal_request': openDealForLate(msg); break;
        case 'play': onPlay(msg); break;
        case 'pass': onPass(msg); break;
        case 'finished': onFinished(msg); break;
        case 'start':
          if (msg.players && !setPlayers(msg.players)) { toast('所选玩家已离线，请重新选择'); break; }
          if (isHost()) startMatch();
          break;
        case 'spectate_state': applySpectateState(msg); break;
        default: break;
      }
    }

    /* Public relations + my own relation from the authoritative server. */
    function applySpectateState(msg) {
      state.spectate = msg.spectate || [];
      state.myRelation = msg.self || null;
      // My identity as observer: approved => I watch; pending => not yet.
      var mine = null, pendingTarget = null;
      for (var i = 0; i < state.spectate.length; i++) {
        var r = state.spectate[i];
        if (state.myRelation && r.spectatorSid === state.myRelation.spectatorSid) mine = r;
        if (r.targetSid === mySid && r.status === 'pending') pendingTarget = r;
      }
      if (mine && mine.status === 'approved') {
        state.spectator = true;
        state.watchTargetSid = mine.targetSid;
      } else {
        state.spectator = false;
        state.watchTargetSid = null;
        state.targetHand = [];
      }
      state.pendingForMe = pendingTarget;
      syncSeats();
      onUpdate(state);
    }

    /* Observer requests to watch exactly one target (server enforces lock). */
    function requestSpectate(targetSid) {
      if (state.spectator || state.myRelation) {
        toast('你已锁定旁观一名玩家，无法更改或旁观其他人');
        return;
      }
      if (!targetSid || targetSid === mySid) { toast('请选择一名其他玩家'); return; }
      sendControl({ type: P.MSG.GAME_SPECTATE, gameId: 'main', targetSid: targetSid });
      toast('已提交旁观申请，等待对方同意');
    }

    /* The watched target answers a pending request. */
    function replySpectate(spectatorSid, accept) {
      if (!state.pendingForMe || state.pendingForMe.spectatorSid !== spectatorSid) {
        toast('没有待处理的旁观申请'); return;
      }
      sendControl({ type: P.MSG.GAME_SPECTATE_REPLY, gameId: 'main',
        spectatorSid: spectatorSid, accept: !!accept });
    }

    async function startMatch() {
      if (!isHost()) { toast('只有房主可以开局'); return; }
      if (state.spectator) { toast('旁观者不能开局'); return; }
      var built = await buildDeal();
      if (!built) return;
      sendGame(built);
      note('房主已洗牌发牌');
    }

    function requestStart(players) { sendGame({ kind: 'start', players: players || null }); }
    function requestDeal() { sendGame({ kind: 'deal_request', requestBy: mySid }); }

    /* Auto-arrange my hand using the Guandan grouping strategy (bombs first,
     * straights/double-straights, triples, pairs, singles; big to small inside
     * each family). Only the display order of the local hand changes — card
     * ids and E2EE game data are untouched. */
    function autoArrange() {
      if (!window.PCBots || !window.PCGame) return false;
      var view = state.spectator ? state.targetHand : state.hand;
      if (!view || !view.length) return false;
      var arranged = window.PCBots.sortedHand(view, state.level, window.PCGame);
      if (state.spectator) state.targetHand = arranged;
      else state.hand = arranged;
      note('已自动理牌：同类牌归堆，炸弹/顺子在前');
      onUpdate(state);
      return true;
    }

    self.state = state;
    self.onMessage = onMessage;
    self.syncSeats = syncSeats;
    self.setPlayers = setPlayers;
    self.startMatch = startMatch;
    self.requestStart = requestStart;
    self.requestDeal = requestDeal;
    self.autoArrange = autoArrange;
    self.play = play;
    self.pass = pass;
    self.requestSpectate = requestSpectate;
    self.replySpectate = replySpectate;
    self.spectateCandidates = function () {
      var watched = {};
      for (var i = 0; i < state.spectate.length; i++) watched[state.spectate[i].targetSid] = true;
      return members.all().filter(function (m) {
        return m.sid !== mySid && !watched[m.sid];
      }).map(function (m) { return { sid: m.sid, nickname: m.nickname }; });
    };
    self.targetNickname = function (sid) {
      var s = state.seats.filter(function (x) { return x.sid === sid; })[0];
      return s ? s.nickname : '玩家';
    };
    self.rankName = rankName;
    self.cardsLabel = cardsLabel;
    self.botsEnabled = botsEnabled;
    self.isBotSid = isBotSid;
    self.botNick = botNick;
    self.roster = allRoster;      // real members + auto-filled bots (for seat picker)
    return self;
  }

  return { create: create };
})();
