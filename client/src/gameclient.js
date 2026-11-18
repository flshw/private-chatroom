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
    var onUpdateRaw = ctx.onUpdate || function () {};
    /* UI rendering must never be able to abort game-state progression. onPlay
     * calls note() (which calls onUpdate -> PCDeluxe.renderGame) BEFORE it
     * advances the turn; a thrown DOM/render error there used to abort the
     * function so the turn never advanced and bots froze. Wrap the callback so
     * a rendering fault is contained while state keeps moving. */
    var renderWarned = false;
    var onUpdate = function (st) {
      try { onUpdateRaw(st); }
      catch (e) {
        if (!renderWarned) { renderWarned = true; try { toast('界面刷新异常，牌局继续进行'); } catch (_) {} }
        if (typeof console !== 'undefined' && console.warn) console.warn('[PCGame] render error contained:', e);
      }
    };
    var botsEnabled = !!ctx.bots;        // deluxe only; simple edition has none
    var botTimer = null;                 // scheduler for the local bot's next move
    var botThinkMs = 1400;               // slower: give a human a clear window to tap 过牌/出牌 before the bot grabs the turn
    var botWatchdog = null;              // safety net: re-drive a bot if its move never advances the turn
    var BOT_WATCHDOG_MS = 5000;          // > botThinkMs + one E2EE round trip; only fires on a stuck turn
    var arrangeMode = 0;                 // v24: 0/1 = 两种理牌方案, 2 = 平铺(点数序)

    /* --- Bot behaviour diagnostics ---------------------------------------
     * A separate, timestamped trace of the whole bot driver: scheduling,
     * decisions, E2EE sends (incl. async buildMessage rejections, which a plain
     * try/catch CANNOT see because sendGame returns a Promise), broadcast echoes
     * and turn advancement. Kept out of state.log so it never floods the chat,
     * and exportable via diagText() for the user to paste back to us. */
    var DIAG_MAX = 400;
    var diagLog = [];
    function dlog(tag, detail) {
      var now = new Date();
      var ts = now.toTimeString().slice(0, 8) + '.' + ('00' + now.getMilliseconds()).slice(-3);
      diagLog.push('[' + ts + '] ' + tag + (detail === undefined || detail === null ? '' : ' | ' + detail));
      if (diagLog.length > DIAG_MAX) diagLog.shift();
      if (typeof console !== 'undefined' && console.info) console.info('[PCDIAG] ' + tag, detail === undefined ? '' : detail);
    }
    function botHandSizes() {
      var out = {};
      Object.keys(state.botHands || {}).forEach(function (k) { out[k] = (state.botHands[k] || []).length; });
      return JSON.stringify(out);
    }
    function diagText() {
      var head = [
        '=== 掼蛋机器人诊断日志 ===',
        '时间 ' + new Date().toLocaleString(),
        '我=' + mySid + ' 房主=' + state.hostSid + ' 我是否房主=' + isHost(),
        '阶段=' + state.phase + ' 局=' + state.roundNo + ' 级=' + rankName(state.level) +
          ' 两队级=' + state.teamLevel.map(rankName).join('/') + ' 上局胜队=' + state.winnerTeam,
        '座位=' + JSON.stringify(state.seats.map(function (s) { return (s.sid || '') + (s.isBot ? '(bot)' : ''); })),
        '当前回合=' + state.turn + ' 机器人手牌=' + botHandSizes(),
        '对家=' + (state.partnerSid || '-') + ' 我的座位=' + state.mySeat,
        '完成次序=' + JSON.stringify(state.finishOrder) + ' 桌面牌=' + (state.tablePattern ? (state.tablePattern.name || state.tablePattern.type) : '无'),
        '机器人开关=' + botsEnabled + ' 旁观=' + state.spectator,
        '------------------------------'
      ];
      return head.concat(diagLog).join('\n');
    }

    function isBotSid(sid) { return BOT_SIDS.indexOf(sid) !== -1; }
    function botNick(sid) { var i = BOT_SIDS.indexOf(sid); return i < 0 ? '机器人' : BOT_NICKS[i]; }
    function clearBotTimer() {
      if (botTimer) { clearTimeout(botTimer); botTimer = null; }
      if (botWatchdog) { clearTimeout(botWatchdog); botWatchdog = null; }
    }

    var state = {
      level: 15,                      // level currently being played (rank value; 15=2, 14=A)
      teamLevel: [15, 15],            // [team0, team1] — each team's own level (seat parity)
      winnerTeam: null,               // which team won the last round (sets next deal level)
      pendingTributeOrder: null,      // last round finish order (seat idx) for next deal's 进贡
      seasonCleared: false,           // true once a team passes A (通关)
      phase: 'idle',                  // idle|dealing|playing|finished
      seats: [],                      // [{sid,nickname,isMe}]
      players: null,                  // the four chosen sids (sorted) once a match is set
      played: [],                     // every played card, for the card counter
      mySeat: -1,
      hostSid: null,
      partnerSid: null,             // 对家 (teammate) chosen at deal time
      hand: [],                       // my cards
      arrangeGroups: null,            // v24: current 理牌 scheme's labelled combos
      table: null,                    // {cards, type, bySid}
      lastWinner: null,
      passes: 0,
      _myPassPending: 0,            // count of my local passes awaiting their echo
      turn: null,
      finishOrder: [],
      result: null,                 // settlement snapshot once all ranks are known
      seatPlays: {},                // sid -> {cards, pattern} — last play THIS trick, per seat
      playedBySeat: {},             // sid -> count of cards played (for low-card display)
      roundNo: 1,                   // 1-based; incremented by nextRound()
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
    /* Next seat still holding cards (not finished) after fromSid, in turn order.
     * Guandan: when the trick winner has already emptied their hand, the lead
     * MUST pass to the next active player. Letting the lead land on a finished
     * (cardless) seat deadlocks the table — nobody can play and the bots have
     * no hand to drive, which is exactly "过牌后无人出牌". */
    function nextActiveSid(fromSid) {
      var i = seatOfSid(fromSid);
      if (i < 0) return null;
      for (var n = 1; n <= state.seats.length; n++) {
        var cand = state.seats[(i + n) % state.seats.length];
        if (state.finishOrder.indexOf(cand.sid) === -1) return cand.sid;
      }
      return null;
    }

    /* Guandan "接风" (lead hand-off): when the player who took the last trick
     * has emptied their hand, the NEXT lead does NOT go to the player on their
     * right — it passes to their PARTNER (the seat directly opposite, i+2),
     * provided the partner still has cards. Only if the partner has also
     * finished do we fall back to the next active seat. Team is seat parity
     * (0&2 vs 1&3), so the partner is always (seat+2)%4. */
    function leadAfterWinner(winnerSid) {
      var i = seatOfSid(winnerSid);
      if (i < 0 || state.seats.length !== 4) return nextActiveSid(winnerSid);
      var partner = state.seats[(i + 2) % 4];
      if (partner && state.finishOrder.indexOf(partner.sid) === -1) return partner.sid;
      return nextActiveSid(winnerSid); // partner finished too -> next active seat
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

    /* The starter picks the other three players AND optionally names one of
     * them 对家 (partner). Everyone applies the SAME ordered seat list from the
     * E2EE 'start' frame, so deals cannot diverge. Seat order is
     *   [host(seat0), opp(seat1), partner(seat2), opp(seat3)]
     * so team-by-parity (0&2 vs 1&3) matches the chosen partnership.
     * `partnerSid` is authoritative from the host; if absent, seat 2 is used. */
    function setPlayers(ids, partnerSid) {
      if (!ids || ids.length !== 4) return false;
      var seen = {}, list = [];
      ids.forEach(function (sid) {
        if (!sid || seen[sid] || !poolMember(sid)) return;
        seen[sid] = true; list.push(sid);
      });
      if (list.length !== 4) return false;
      var hostSid = list[0];
      var partner = partnerSid && seen[partnerSid] && partnerSid !== hostSid ? partnerSid : null;
      var rest = list.slice(1).filter(function (s) { return s !== partner; });
      // seat1 / seat3 = the two opponents; partner sits opposite at seat2.
      var ordered = [hostSid];
      if (partner) {
        ordered.push(rest[0] || null, partner, rest[1] || null);
      } else {
        ordered = ordered.concat(rest);
      }
      ordered = ordered.filter(Boolean);
      if (ordered.length !== 4) return false;
      state.players = ordered;
      state.partnerSid = partner || ordered[2];
      syncSeats(); onUpdate(state);
      return true;
    }

    /* --- E2EE deal: build per-player encrypted hand, wrapped to each ukPub --- */
    async function buildDeal() {
      syncSeats();
      if (state.seats.length !== 4) { toast('需要 4 名玩家才能开局'); return null; }
      var deck = window.PCGame.makeDeck();
      var hands = window.PCGame.deal(deck);
      // 进贡/还贡/抗贡: the host sees all four plaintext hands at deal time,
      // so tribute is resolved centrally and consistently for everyone. The
      // transformed hands are what actually get wrapped and played.
      var tributeInfo = { events: [], resisted: false, firstSeat: null };
      if (state.pendingTributeOrder && state.pendingTributeOrder.length === 4) {
        var tr = window.PCGame.applyTribute(hands, state.pendingTributeOrder,
          state.seats.map(function (s, i) { return i % 2; }), state.level);
        hands = tr.hands;
        tributeInfo = { events: tr.events, resisted: tr.resisted, firstSeat: tr.firstSeat };
        dlog('TRIBUTE', JSON.stringify(tr.events) + ' firstSeat=' + tr.firstSeat);
      }
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
        partner: state.partnerSid,
        teamLevel: state.teamLevel.slice(), winnerTeam: state.winnerTeam,
        tribute: tributeInfo,
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
      dlog('DEAL', 'round=' + msg.round + ' host=' + msg.host + ' order=' + JSON.stringify(msg.order) +
        ' myHand=' + (mySid && msg.hands && msg.hands[mySid] ? 'wrapped' : 'none'));
      state.roundNo = msg.round;
      state.level = msg.level;
      if (Array.isArray(msg.teamLevel) && msg.teamLevel.length === 2) {
        state.teamLevel = msg.teamLevel.slice();
      } else if (state.teamLevel[0] !== state.level || state.teamLevel[1] !== state.level) {
        state.teamLevel = [state.level, state.level];  // legacy deal: seed both teams
      }
      if (msg.winnerTeam != null) state.winnerTeam = msg.winnerTeam;
      state.seasonCleared = false;
      state.hostSid = msg.host;
      // 进贡 display + first-lead from the resolved tribute (host computed it).
      var firstSeat = 0;
      if (msg.tribute) {
        firstSeat = (msg.tribute.firstSeat != null) ? msg.tribute.firstSeat : 0;
        try {
          var ev = msg.tribute.events || [];
          if (msg.tribute.resisted) note('🛡 对方持双大王，抗贡成功！本局不进贡');
          else if (ev.length) {
            var lines = ev.map(function (e) {
              var fromN = state.seats[e.from] ? state.seats[e.from].nickname : ('座' + e.from);
              var toN = state.seats[e.to] ? state.seats[e.to].nickname : ('座' + e.to);
              return fromN + (e.action === 'tribute' ? ' 进贡 ' : ' 还贡 ') +
                toN + ' ' + cardShort(e.card);
            });
            note('🎁 进贡：' + lines.join('；'));
          }
        } catch (e) {}
      }
      state.pendingTributeOrder = null;  // consumed by this deal
      state.phase = 'playing';
      state.table = null; state.tablePattern = null; state.passes = 0;
      state.lastWinner = null; state._myPassPending = 0;
      state.finishOrder = []; state.log = []; state.played = [];
      state.result = null; state.seatPlays = {}; state.playedBySeat = {};   // fresh round
      state.arrangeGroups = null; arrangeMode = 0;   // reset 理牌 cycle each deal
      if (msg.partner) state.partnerSid = msg.partner;
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
            state.targetHand = window.PCGame.sortHandForView(JSON.parse(wPlain).hand, state.level);
            var tn = (state.seats.filter(function (s) { return s.sid === watchedSid; })[0] || {}).nickname || '玩家';
            note('旁观 ' + tn + ' 的手牌（' + state.targetHand.length + ' 张）· 打' + rankName(state.level));
          } catch (e) { note('目标手牌解封失败：' + e.message); }
        } else {
          note('新一局开始（旁观等待中）· 打' + rankName(state.level));
        }
        state.turn = (msg.tribute && msg.tribute.firstSeat != null)
          ? (msg.order[msg.tribute.firstSeat] || msg.order[0])
          : (msg.order && msg.order[0]);
      } else if (msg.hands && msg.hands[mySid]) {
        var w = msg.hands[mySid];
        try {
          var K = window.PCCrypto.unwrapKey(w.wrap, uk.privatePem);
          var plain = window.PCCrypto.aesDecrypt(K,
            'deal|' + config.roomId + '|' + state.roundNo + '|' + mySid, w.iv, w.ct, w.tag);
          state.hand = window.PCGame.sortHandForView(JSON.parse(plain).hand, state.level);
          note('发牌完成，你拿到 ' + state.hand.length + ' 张 · 打' + rankName(state.level));
        } catch (e) { toast('手牌解封失败：' + e.message); }
      }
      state.turn = (msg.tribute && msg.tribute.firstSeat != null)
        ? (msg.order[msg.tribute.firstSeat] || (msg.order && msg.order[0]))
        : ((msg.order && msg.order[0]) || state.turn);
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
      var handBefore = state.hand.slice();
      var playedBefore = state.played.slice();
      var bySeatBefore = state.playedBySeat[mySid] || 0;
      var tableBefore = state.table, tablePatBefore = state.tablePattern;
      var seatPlayBefore = state.seatPlays[mySid];
      var passesBefore = state.passes, winnerBefore = state.lastWinner;
      // Send through sendDiag so an async rejection (dropped WSS / E_REPLAY)
      // restores the optimistic state — otherwise this client desyncs forever.
      sendDiag(msg, 'PLAY by ' + mySid + ' ' + sel.length + ' cards', function () {
        state.hand = handBefore;
        state.played = playedBefore;
        state.playedBySeat[mySid] = bySeatBefore;
        state.table = tableBefore; state.tablePattern = tablePatBefore;
        if (seatPlayBefore === undefined) delete state.seatPlays[mySid];
        else state.seatPlays[mySid] = seatPlayBefore;
        state.passes = passesBefore; state.lastWinner = winnerBefore;
        toast('出牌未送达，已撤销本地出牌，请重试');
        onUpdate(state);
      });
      // Immediate visual acknowledgement: drop the played cards from the hand,
      // credit the counter, and repaint — no waiting for the E2EE round trip.
      // Turn/table/log are left to onPlay(broadcast) as the single source of truth.
      state.hand = state.hand.filter(function (c) { return cardIds.indexOf(c.id) === -1; });
      state.playedBySeat[mySid] = (state.playedBySeat[mySid] || 0) + sel.length;
      sel.forEach(function (c) {
        if (!state.played.some(function (p) { return p.id === c.id; })) state.played.push(c);
      });
      // Mirror the table locally so the play animation fires on the same tick
      // as the tap; the broadcast's onPlay applies the identical cards/signature.
      state.table = { cards: msg.cards, type: pattern.type, bySid: mySid };
      state.tablePattern = pattern;
      state.seatPlays[mySid] = { cards: msg.cards.slice(), pattern: pattern };
      state.passes = 0;
      state.lastWinner = mySid;   // a real play (not a pass) owns the trick
      onUpdate(state);
      return true;
    }

    function pass() {
      if (state.phase !== 'playing' || state.spectator) return false;
      if (state.turn !== mySid) { toast('还没轮到你'); return false; }
      // Guandan leader must play, but never leave the button silently dead:
      // a tap on the lead gives an explicit hint instead of doing nothing.
      if (!state.table) { toast('你是本轮首位领出，请先出牌（或点「自动理牌」）'); return false; }
      // Optimistic local feedback — the play path already repaints on the same
      // tick; pass() used to wait for the full E2EE round-trip so a tap looked
      // dead. Apply locally now and ignore our own echo (signature guard) so
      // `passes` is never counted twice.
      // Snapshot before the optimistic apply so a rejected send can restore it.
      var pendingBefore = state._myPassPending;
      var passesBefore = state.passes;
      var turnBefore = state.turn, tableBefore = state.table;
      var tablePatBefore = state.tablePattern, seatPlaysBefore = Object.assign({}, state.seatPlays);
      state._myPassPending++;
      applyPass(mySid);
      sendDiag({ kind: 'pass', round: state.roundNo, by: mySid },
        'PASS by ' + mySid, function () {
          state._myPassPending = pendingBefore;
          state.passes = passesBefore;
          state.turn = turnBefore; state.table = tableBefore; state.tablePattern = tablePatBefore;
          state.seatPlays = seatPlaysBefore;
          toast('过牌未送达，已撤销本地过牌，请重试');
          onUpdate(state);
        });
      return true;
    }

    /* Apply one pass to the local state. Shared by the optimistic local pass
     * and by onPass() for other players' broadcasts. */
    function applyPass(by) {
      state.passes++;
      dlog('APPLY-PASS', 'by=' + by + ' passes=' + state.passes + '/' + (state.seats.length - 1 - state.finishOrder.length));
      state.seatPlays[by] = { cards: [], passed: true };   // show 过 at this seat
      var seat = seatOfSid(by);
      try { note((by === mySid ? '你' : (state.seats[seat] ? state.seats[seat].nickname : '玩家')) + ' 过牌'); } catch (e) {}
      if (state.passes >= state.seats.length - 1 - state.finishOrder.length) {
        // New trick led by the player who actually PLAYED last (lastWinner),
        // never by the last passer. lastWinner is updated only on play().
        state.table = null; state.tablePattern = null; state.passes = 0;
        state.seatPlays = {};   // new trick: clear each seat's displayed play
        var leadSid = state.lastWinner || by;
        // If that winner has already emptied their hand, GUANDAN "接风" gives
        // the lead to their PARTNER (opposite seat), not the next player on the
        // right. leadAfterWinner handles the partner-finished fallback.
        if (state.finishOrder.indexOf(leadSid) !== -1) {
          leadSid = leadAfterWinner(leadSid) || by;
          try { note('对家接风 · 由 ' + ((state.seats[seatOfSid(leadSid)] || {}).nickname || '玩家') + ' 领出'); } catch (e) {}
        } else {
          try {         note('新一轮，由 ' + ((state.seats[seatOfSid(leadSid)] || {}).nickname || '玩家') + ' 领出'); } catch (e) {}
        }
        dlog('NEW-TRICK', 'lead=' + leadSid + ' (lastWinner=' + state.lastWinner + ')');
        state.turn = leadSid;
      } else {
        advanceTurn(by);
      }
      onUpdate(state);
      scheduleBot();
    }

    async function onPlay(msg) {
      dlog('ECHO-PLAY', 'by=' + msg.by + ' bot=' + (!!msg.bot) + ' cards=' +
        ((msg.cards || []).length) + ' round=' + msg.round + ' | turn before=' + state.turn);
      // Apply the authoritative state defensively, then ALWAYS advance the
      // turn. The old code could throw before advanceTurn (classify on an
      // unexpected card, a logging/render fault), leaving the turn stuck on a
      // bot forever — "机器人卡死不出牌". Wrapping the apply step and moving
      // turn progression into a finally-style tail guarantees liveness.
      try {
        var pattern = null;
        try { pattern = window.PCGame.classify(msg.cards, state.level); } catch (e) { pattern = null; }
        pattern = pattern || msg.pattern || null;
        state.table = { cards: msg.cards, type: pattern && pattern.type, bySid: msg.by };
        state.tablePattern = pattern;
        state.seatPlays[msg.by] = { cards: (msg.cards || []).slice(), pattern: pattern };
        state.passes = 0;
        state.lastWinner = msg.by;  // only a PLAY (never a pass) may win the trick
        (msg.cards || []).forEach(function (c) {
          if (!state.played.some(function (p) { return p.id === c.id; })) {
            state.played.push({ s: c.s, r: c.r, id: c.id });
          }
        });
        // Count cards played per seat for the low-card display. My own play
        // was already counted optimistically in play(); count others here.
        if (msg.by !== mySid) {
          state.playedBySeat[msg.by] = (state.playedBySeat[msg.by] || 0) + (msg.cards || []).length;
        }
        // VALIDITY: warn (do not drop — liveness first) if a remote play
        // reuses card ids already played this round. A tampered client could
        // otherwise "replay" the same cards; the log makes it visible.
        if (msg.by !== mySid && (msg.cards || []).length) {
          var reused = (msg.cards || []).filter(function (c) {
            return state.played.some(function (p) { return p.id === c.id; });
          }).length;
          if (reused === msg.cards.length) {
            dlog('PLAY-SUSPECT', 'by=' + msg.by + ' all ' + reused + ' cards already played');
          }
        }
        var seat = seatOfSid(msg.by);
        if (msg.by !== mySid) {
          state.hand = state.hand.filter(function (c) {
            return !(msg.cards || []).some(function (p) { return p.id === c.id; });
          });
        }
        var who = state.seats[seat] ? state.seats[seat].nickname : '玩家';
        try { note(who + ' 出 ' + cardsLabel(msg.cards, pattern)); } catch (e) {}
        if (!state.spectator && state.hand.length === 0 && state.finishOrder.indexOf(mySid) === -1) {
          state.finishOrder.push(mySid);
          try { note('你出完了！第 ' + state.finishOrder.length + ' 名'); } catch (e) {}
          try { sendGame({ kind: 'finished', round: state.roundNo, by: mySid, order: state.finishOrder.slice() }); } catch (e) {}
        }
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[PCGame] onPlay apply error:', e);
      }
      advanceTurn(msg.by);
    }

    function onPass(msg) {
      dlog('ECHO-PASS', 'by=' + msg.by + ' round=' + msg.round + ' | turn before=' + state.turn +
        ' pending=' + state._myPassPending);
      // My own optimistic pass already applied this echo's effect. Consume one
      // pending pass in arrival order (E2EE seq guarantees ordering) — unlike
      // a round|sid signature this stays unique across multiple passes per round.
      if (msg.by === mySid && state._myPassPending > 0) {
        state._myPassPending--;
        return;
      }
      applyPass(msg.by);
    }

    function advanceTurn(fromSid) {
      var prevTurn = state.turn;
      var i = seatOfSid(fromSid);
      for (var n = 1; n <= state.seats.length; n++) {
        var cand = state.seats[(i + n) % state.seats.length];
        if (state.finishOrder.indexOf(cand.sid) === -1) { state.turn = cand.sid; break; }
      }
      dlog('ADVANCE', 'from=' + fromSid + ' turn ' + prevTurn + ' -> ' + state.turn +
        ' | finish=' + JSON.stringify(state.finishOrder));
      // lastWinner is NOT touched here. It is updated ONLY when someone plays
      // cards (see onPlay / optimistic play). Updating it on a pass made the
      // next trick get led by the last PASSER instead of the last player —
      // the root cause of "过牌后轮次乱了/像没生效".
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
      var sid = state.turn;
      dlog('SCHEDULE', 'turn=' + sid + ' enabled=' + botsEnabled + ' isHost=' + isHost() +
        ' phase=' + state.phase + ' spectator=' + state.spectator + ' hands=' + botHandSizes());
      if (!botsEnabled || !isHost() || state.phase !== 'playing' || state.spectator) {
        dlog('SCHEDULE-SKIP', 'guard: enabled=' + botsEnabled + ' isHost=' + isHost() +
          ' phase=' + state.phase + ' spectator=' + state.spectator);
        return;
      }
      if (!sid || !isBotSid(sid)) {
        dlog('SCHEDULE-SKIP', 'turn is not a bot (human seat or empty)');
        return;
      }
      if (!state.botHands || !state.botHands[sid] || !state.botHands[sid].length) {
        // Turn landed on a cardless bot (its 'finished' echo was lost). Treat
        // it as finished locally and hand the lead to the next active seat,
        // otherwise nobody drives this turn and the table freezes.
        dlog('BOT-CARDLESS', sid + ' | finishOrder=' + JSON.stringify(state.finishOrder));
        if (state.finishOrder.indexOf(sid) === -1) {
          state.finishOrder.push(sid);
          try { sendGame({ kind: 'finished', round: state.roundNo, by: sid,
            order: state.finishOrder.slice() }); } catch (e) {}
        }
        var next = nextActiveSid(sid);
        dlog('BOT-CARDLESS-NEXT', sid + ' -> ' + next);
        if (next && next !== sid) { state.turn = next; onUpdate(state); scheduleBot(); }
        return;
      }
      dlog('BOT-TIMER-SET', sid + ' in ' + botThinkMs + 'ms | hand=' + state.botHands[sid].length);
      botTimer = setTimeout(function () { botTimer = null; botStep(sid); }, botThinkMs);
    }

    /* A bot's move is published over E2EE and its turn advance comes back via
     * the broadcast echo. If that echo is ever lost (a rejected frame, a thrown
     * exception in the receive path, a transient wrap/seq hiccup) the turn would
     * sit on the bot forever — "机器人卡死不出牌". The watchdog re-drives the
     * same bot after a grace period, but ONLY while the turn is still on that
     * bot. As soon as any echo advances the turn, clearBotTimer() cancels it. */
    function armBotWatchdog(sid) {
      if (botWatchdog) { clearTimeout(botWatchdog); botWatchdog = null; }
      if (!botsEnabled || !isHost() || state.phase !== 'playing') return;
      botWatchdog = setTimeout(function () {
        botWatchdog = null;
        dlog('WD-FIRE', sid + ' | turn=' + state.turn + ' phase=' + state.phase +
          ' hand=' + ((state.botHands[sid] || []).length));
        // Still this bot's turn and still its move pending? Then the echo that
        // should have advanced the turn never arrived — drive it again.
        if (isHost() && state.phase === 'playing' && !state.spectator &&
            state.turn === sid && state.botHands[sid] && state.botHands[sid].length) {
          dlog('WD-REDRIVE', sid);
          botStep(sid);
        } else {
          dlog('WD-NOOP', 'turn moved on or bot out of cards');
        }
      }, BOT_WATCHDOG_MS);
      dlog('WD-ARM', sid + ' in ' + BOT_WATCHDOG_MS + 'ms');
    }

    /* sendGame returns a Promise (app.js sendKind is async: buildMessage awaits
     * the RSA wrap + signature). A rejection used to be invisible — a bare
     * try/catch cannot catch an async rejection, so a failed bot PLAY silently
     * vanished and the watchdog was the only hint. Track it explicitly. */
    function sendDiag(payload, label, onFail) {
      var out;
      try { out = sendGame(payload); }
      catch (e) {
        dlog('SEND-SYNC-ERR', label + ' | ' + (e && e.message ? e.message : e));
        if (onFail) onFail(e);
        return false;
      }
      var failed = function (e) {
        dlog('SEND-REJECT', label + ' | ' + (e && e.message ? e.message : e));
        // Roll back any optimistic hand mutation this action already made,
        // otherwise every watchdog re-drive silently burns another card
        // (a dropped connection ate 6 cards in one game: 26->20).
        if (onFail) onFail(e);
        // A rejected SEND means no echo will ever advance the turn for this
        // action — re-drive via watchdog so the game cannot stall. Only arm
        // when the pending action belongs to a bot seat.
        var pending = state.turn;
        if (isHost() && state.phase === 'playing' && !state.spectator && isBotSid(pending)) {
          armBotWatchdog(pending);
        }
      };
      if (out && typeof out.then === 'function') {
        out.then(function () { dlog('SEND-OK', label); }).catch(failed);
      } else {
        dlog('SEND-OK', label + ' (sync)');
      }
      return true;
    }

    function botStep(sid) {
      dlog('BOT-STEP', sid + ' | turn=' + state.turn + ' hand=' + ((state.botHands[sid] || []).length) +
        ' table=' + (state.tablePattern ? (state.tablePattern.name || state.tablePattern.type) : 'lead'));
      // Re-validate after the think delay: state may have moved on.
      if (!isHost() || state.phase !== 'playing' || state.spectator || state.turn !== sid) {
        dlog('BOT-STEP-ABORT', 'guard | isHost=' + isHost() + ' phase=' + state.phase +
          ' spectator=' + state.spectator + ' turn=' + state.turn);
        return;
      }
      var hand = state.botHands[sid];
      if (!hand || !hand.length) { dlog('BOT-STEP-ABORT', 'empty hand'); return; }
      var move = null;
      try {
        move = window.PCBots.chooseMove({
          hand: hand, tablePattern: state.tablePattern || null, level: state.level,
          mySid: sid,
          bySid: (state.table && state.table.bySid) || null,
          teamOf: function (s) { return seatOfSid(s) % 2; }, // sid -> team index
          remaining: remainingOf
        }, window.PCGame);
      } catch (e) { dlog('DECIDE-ERR', sid + ' | ' + (e && e.message ? e.message : e)); move = null; }
      dlog('DECIDE', sid + ' -> ' + (move
        ? ('PLAY ' + (move.pattern && move.pattern.name ? move.pattern.name : move.pattern.type) +
           ' cards=' + move.cards.map(function (c) { return rankName(c.r) + (c.s || ''); }).join(',') +
           ' | ' + (move.why || ''))
        : 'PASS'));
      try {
        if (!move) {
          // Cannot beat the table -> pass (legal whenever there is a table).
          sendDiag({ kind: 'pass', round: state.roundNo, by: sid }, 'PASS by ' + sid);
        } else {
          var ids = {};
          move.cards.forEach(function (c) { ids[c.id] = true; });
          var before = hand.slice();
          var played = hand.filter(function (c) { return ids[c.id]; });
          state.botHands[sid] = hand.filter(function (c) { return !ids[c.id]; });
          // HANDS-ROLLBACK: if the play is rejected (e.g. socket not OPEN),
          // put the removed cards BACK. Optimistically dropping them with no
          // rollback made every watchdog re-drive burn one more card, so the
          // bot slowly "lost" its hand while never actually playing anything.
          var rollback = function () {
            state.botHands[sid] = before;
            dlog('HANDS-ROLLBACK', sid + ' restored ' + played.length +
              ' cards | hand ' + state.botHands[sid].length);
            try { onUpdate(state); } catch (e) {}
          };
          sendDiag({ kind: 'play', round: state.roundNo, by: sid,
            cards: played.map(function (c) { return { s: c.s, r: c.r, id: c.id }; }),
            pattern: { type: move.pattern.type, rank: move.pattern.rank, len: move.pattern.len },
            bot: true }, 'PLAY by ' + sid + ' ' + played.length + ' cards, left=' + state.botHands[sid].length,
            rollback);
          // Bot finished its cards -> announce so team scoring can resolve.
          // Guard: on rejection rollback() already restored the hand, so do
          // NOT announce a finish for a play that never left the device.
          // Record it in OUR finishOrder immediately too: the FINISHED echo is
          // broadcast back to us, and while the merge de-dupes, having it local
          // up front means the 3rd finisher reliably triggers settlement.
          if (!state.botHands[sid].length) {
            var order = state.finishOrder.slice();
            if (order.indexOf(sid) === -1) order.push(sid);
            state.finishOrder = order;
            sendDiag({ kind: 'finished', round: state.roundNo, by: sid, order: order },
              'FINISHED by ' + sid + ' order=' + JSON.stringify(order));
            if (state.finishOrder.length >= 3 && state.phase === 'playing') finishRound();
          }
        }
        // Published. Arm the safety net in case the echo never comes back.
        armBotWatchdog(sid);
      } catch (e) {
        // sendDiag already logs sync errors; this catches anything else.
        dlog('BOT-STEP-ERR', sid + ' | ' + (e && e.message ? e.message : e));
        armBotWatchdog(sid);
      }
    }

    function rankName(r) {
      return ({ 15: '2', 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 16: '小王', 17: '大王' })[r] || String(r);
    }
    /* Compact single-card label for tribute logs, e.g. "K♠" / "大王". */
    function cardShort(c) {
      if (!c) return '';
      if (c.r === 16 || c.r === 17) return rankName(c.r);
      var SUIT = { S: '♠', H: '♥', C: '♣', D: '♦' };
      return rankName(c.r) + (SUIT[c.s] || '');
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

    /* Guandan ranks: 大科(1st) 二科(2nd) 二拉(3rd, also 三科) 大拉(4th, last).
     * A round is only complete once THREE players are out (the fourth is last
     * by default) or all four have announced. The old code settled at the 2nd
     * finisher, which froze the remaining bots (phase=finished) and produced an
     * incomplete result — exactly the log where bot_2/bot_3 never finished. */
    var RANK_TITLES = ['大科', '二科', '二拉', '大拉'];
    function seatNick(sid) {
      var s = state.seats[seatOfSid(sid)];
      return s ? s.nickname : (isBotSid(sid) ? botNick(sid) : '玩家');
    }
    /* Remaining cards for a seat. Everyone can count cards played per seat
     * (broadcast plays) so remaining = 27 - played. Locally we also know bot
     * hands exactly (host) and my own hand exactly, which is more accurate. */
    function remainingOf(sid) {
      var playedN = state.playedBySeat[sid] || 0;
      var guess = 27 - Math.min(27, playedN);
      if (sid === mySid && !state.spectator) return state.hand.length;
      if (state.botHands && state.botHands[sid]) return state.botHands[sid].length;
      return guess;
    }
    function isTeammate(a, b) {
      // Team by seat parity: seat0(host)+seat2(partner) vs seat1+seat3.
      return (seatOfSid(a) % 2) === (seatOfSid(b) % 2);
    }
    function finishRound() {
      if (state.result) return; // already settled this round
      // Complete the order: append any seat still holding cards, by remaining
      // card count ascending (fewest cards = better place). Host knows bot
      // hand sizes; for humans use their visible hand length when available.
      var order = state.finishOrder.slice();
      var rest = state.seats.map(function (s) { return s.sid; })
        .filter(function (sid) { return order.indexOf(sid) === -1; });
      function left(sid) {
        if (sid === mySid) return state.hand.length;
        if (state.botHands && state.botHands[sid]) return state.botHands[sid].length;
        return 27; // unknown remote human: treat as still holding a full hand
      }
      rest.sort(function (a, b) { return left(a) - left(b); });
      order = order.concat(rest).slice(0, 4);
      state.finishOrder = order;

      var levelBefore = state.level;
      var seatIdxOrder = order.map(function (sid) { return seatOfSid(sid); });
      var teamOf = state.seats.map(function (s, i) { return i % 2; });
      var delta = window.PCGame.levelDelta(seatIdxOrder, teamOf);
      var winnerTeam = teamOf[seatIdxOrder[0]];          // the team that took 大科
      // Remember last round's finish order (as seat indices) so the next deal
      // can apply 进贡/还贡/抗贡 before wrapping hands.
      state.pendingTributeOrder = seatIdxOrder.slice();
      var firstTeam = winnerTeam;
      var myTeam = state.mySeat % 2;
      var win = firstTeam === myTeam;
      // Each team keeps its OWN level; only the winning team advances. The
      // next deal uses the winner's new level. This matches real Guandan
      // (both sides climb separately) instead of a single shared level.
      var adv = advanceLevel(state.teamLevel[winnerTeam], delta);
      state.teamLevel[winnerTeam] = adv.level;
      state.winnerTeam = winnerTeam;
      state.seasonCleared = adv.cleared;
      state.level = state.teamLevel[winnerTeam];          // level for the next deal
      if (adv.cleared) {
        try { note('🏆 ' + (winnerTeam === myTeam ? '本队' : '对方') + ' 打过 A，通关！'); } catch (e) {}
      }

      state.result = {
        order: order,
        ranks: order.map(function (sid, i) {
          return { sid: sid, nickname: seatNick(sid), title: RANK_TITLES[i] || ('第' + (i + 1)),
            isMe: sid === mySid, teammate: isTeammate(sid, mySid) };
        }),
        win: win, delta: delta, levelBefore: levelBefore, levelAfter: state.level,
        teamLevel: state.teamLevel.slice(), winnerTeam: winnerTeam, cleared: adv.cleared,
        round: state.roundNo, partnerSid: state.partnerSid
      };
      state.phase = 'finished';
      clearBotTimer();
      try {
        note('🏁 第 ' + state.roundNo + ' 局结束 · ' +
          order.map(function (sid, i) { return RANK_TITLES[i] + ' ' + seatNick(sid); }).join(' / ') +
          (adv.cleared ? ' · ' + (win ? '本队' : '对方') + '通关，打过 A！'
            : (win ? ' · 本队胜，升 ' + delta + ' 级 → 打' + rankName(state.level) : ' · 对方领先，打' + rankName(state.level))));
      } catch (e) {}
      dlog('MATCH-OVER', 'order=' + JSON.stringify(order) + ' level ' + rankName(levelBefore) +
        ' -> ' + rankName(state.level) + ' win=' + win + ' round=' + state.roundNo);
      onUpdate(state);
    }

    function onFinished(msg) {
      dlog('FINISHED-ECHO', 'by=' + msg.by + ' order=' + JSON.stringify(msg.order) +
        ' | prev=' + JSON.stringify(state.finishOrder));
      // VALIDITY GUARD: reject forged/tampered finish frames. Every sid in the
      // order must be a real seat this round, no duplicates, and the reporter
      // must be in the order. Without this a tampered client could inject any
      // ranking (cheat / state fork). Fine for honest clients; blocks garbage.
      var orderIn = Array.isArray(msg.order) ? msg.order : (msg.by ? [msg.by] : []);
      var validSids = state.seats.map(function (s) { return s.sid; });
      var seenFin = {};
      var bad = orderIn.length === 0 || orderIn.length > 4 ||
        (msg.by && orderIn.indexOf(msg.by) === -1);
      orderIn.forEach(function (sid) {
        if (validSids.indexOf(sid) === -1 || seenFin[sid]) bad = true;
        seenFin[sid] = true;
      });
      if (bad) {
        dlog('FINISHED-REJECT', 'invalid order/by | order=' + JSON.stringify(orderIn) + ' by=' + msg.by);
        return;
      }
      // Merge, don't overwrite: echoes may arrive out of order. Keep first-seen
      // order and never drop a place that is already recorded.
      var merged = state.finishOrder.slice();
      (msg.order || [msg.by]).forEach(function (sid) {
        if (merged.indexOf(sid) === -1) merged.push(sid);
      });
      state.finishOrder = merged;
      if (state.phase !== 'playing') { onUpdate(state); return; }
      // Only finish when 3 are out (4th is last by default).
      if (state.finishOrder.length >= 3) finishRound();
      else onUpdate(state);
    }

    /* Host confirms the settlement -> bump to the next round and redeal with
     * the same four seats + partner. Everyone receives the new 'deal' frame
     * (carrying round + level), so no separate message type is needed. */
    function nextRound() {
      if (state.phase !== 'finished') { toast('本局尚未结束'); return false; }
      if (!isHost()) { toast('只有房主可以开始下一局'); return false; }
      if (state.seasonCleared) { toast('已通关（打过 A），请重新开局'); return false; }
      state.roundNo = (state.roundNo || 0) + 1;
      state.result = null;
      state.phase = 'dealing';
      state.finishOrder = [];
      state.seatPlays = {};
      state.played = [];
      dlog('NEXT-ROUND', 'round=' + state.roundNo + ' level=' + rankName(state.level) +
        ' players=' + JSON.stringify(state.players) + ' partner=' + state.partnerSid);
      startMatch();
      return true;
    }

    /* Guandan level order: this room starts at 2 (rank 15) and climbs
     * 3,4,...,K,A. The DEALT rank follows this order; passing A clears the
     * season. (rankName maps 15->2, 14->A.) Starting at 2 avoids an immediate
     * clear — 2 is the entry level here, A is the top. */
    var LEVEL_SEQ = [15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    function advanceLevel(cur, delta) {
      var i = LEVEL_SEQ.indexOf(cur);
      if (i === -1) i = 0; // unknown -> start at 2
      var ni = i + Math.max(0, delta);
      if (ni >= LEVEL_SEQ.length) {
        return { level: LEVEL_SEQ[LEVEL_SEQ.length - 1], cleared: true };
      }
      return { level: LEVEL_SEQ[ni], cleared: false };
    }

    /* Receive a decrypted game payload from the chat E2EE layer. */
    function onMessage(msg) {
      dlog('RECV', 'kind=' + msg.kind + (msg.by ? ' by=' + msg.by : '') +
        (msg.round ? ' round=' + msg.round : '') + ' | decode ok');
      // STALE-FRAME GUARD: a delayed/replayed frame from a previous round must
      // never mutate the current trick's table/turn/finishOrder. 'deal' and
      // 'start' legitimately advance the round, so they are exempt; every
      // in-round action carries msg.round and is checked here.
      if (msg.round != null && msg.kind !== 'deal' && msg.kind !== 'start') {
        if (msg.round !== state.roundNo) {
          dlog('STALE-DROP', 'kind=' + msg.kind + ' frame.round=' + msg.round +
            ' local.round=' + state.roundNo);
          return;
        }
      }
      switch (msg.kind) {
        case 'deal': onDeal(msg); break;
        case 'deal_request': openDealForLate(msg); break;
        case 'play': onPlay(msg); break;
        case 'pass': onPass(msg); break;
        case 'finished': onFinished(msg); break;
        case 'start':
          if (msg.players && !setPlayers(msg.players, msg.partnerSid)) { toast('所选玩家已离线，请重新选择'); break; }
          if (isHost()) startMatch();
          break;
        case 'spectate_state': /* v23: spectator feature removed — ignore */ break;
        default: break;
      }
    }

    /* v23: spectator feature removed. Server-side relations are no longer
     * consumed by the client; state.spectator stays false for every player. */
    async function startMatch() {
      if (!isHost()) { toast('只有房主可以开局'); return; }
      if (state.spectator) { toast('旁观者不能开局'); return; }
      var built = await buildDeal();
      if (!built) return;
      sendGame(built);
      note('房主已洗牌发牌');
    }

    function requestStart(players, partnerSid) {
      sendGame({ kind: 'start', players: players || null, partnerSid: partnerSid || null });
    }
    function requestDeal() { sendGame({ kind: 'deal_request', requestBy: mySid }); }

    /* v24: auto-arrange cycles through 火力集中 / 少手数 / 平铺(点数序).
     * Only the LOCAL display order changes — card ids and E2EE game data are
     * untouched. The button label is returned so the UI can show the mode. */
    function autoArrange() {
      if (!window.PCBots || !window.PCGame) return null;
      var view = state.spectator ? state.targetHand : state.hand;
      if (!view || !view.length) return null;
      arrangeMode = (arrangeMode + 1) % 3;
      var arrangement;
      if (arrangeMode === 2) {
        // 平铺: plain rank order (strongest first), no grouping.
        arrangement = (window.PCGame.sortHandForView)
          ? { order: window.PCGame.sortHandForView(view, state.level), label: '平铺 · 点数序' }
          : { order: view.slice(), label: '平铺' };
      } else {
        var schemes = window.PCBots.arrangeSchemes(view, state.level, window.PCGame);
        var s = schemes[arrangeMode] || schemes[0];
        arrangement = { order: s.order, label: s.name };
        // Record the grouping so the UI can label each combo stack.
        state.arrangeGroups = s.groups.map(function (g) {
          return { name: g.pattern.name, ids: g.cards.map(function (c) { return c.id; }) };
        });
      }
      if (arrangeMode === 2) state.arrangeGroups = null;
      if (state.spectator) state.targetHand = arrangement.order;
      else state.hand = arrangement.order;
      note('已' + arrangement.label + '（仅本机显示顺序，牌局数据不变）');
      onUpdate(state);
      return { mode: arrangeMode, label: arrangement.label };
    }

    self.arrangeMode = function () { return arrangeMode; };
    self.state = state;
    self.onMessage = onMessage;
    self.syncSeats = syncSeats;
    self.setPlayers = setPlayers;
    self.startMatch = startMatch;
    self.nextRound = nextRound;
    self.requestStart = requestStart;
    self.requestDeal = requestDeal;
    self.autoArrange = autoArrange;
    self.play = play;
    self.pass = pass;
    self.targetNickname = function (sid) {
      var s = state.seats.filter(function (x) { return x.sid === sid; })[0];
      return s ? s.nickname : '玩家';
    };
    self.rankName = rankName;
    self.nextLevelFrom = advanceLevel;   // exposed for level-progression tests
    self.cardsLabel = cardsLabel;
    self.remainingOf = remainingOf;
    self.diagText = diagText;         // export bot behaviour trace for the UI
    self.noteDiag = function (text) { dlog('EXTERNAL', text); }; // app-layer errors (e.g. E_REPLAY) feed the trace
    /* A WSS reconnect assigns a fresh sid. Keep the match alive by translating
     * every stored reference to my OLD sid into the new one, instead of tearing
     * down and rebuilding the engine (which used to reset phase to idle and
     * lose hands/turn/botHands -> "重连后无法继续牌局"). Called from app.js on
     * JOINED, before any game frames are replayed. */
    self.updateMySid = function (newSid) {
      if (!newSid || newSid === mySid) return false;
      var old = mySid;
      function repl(v) { return v === old ? newSid : v; }
      mySid = newSid;
      state.hostSid = repl(state.hostSid);
      state.partnerSid = repl(state.partnerSid);
      if (state.players) state.players = state.players.map(repl);
      if (state.seats) state.seats.forEach(function (s) { if (s.sid === old) { s.sid = newSid; s.isMe = true; } else s.isMe = false; });
      state.turn = repl(state.turn);
      state.lastWinner = repl(state.lastWinner);
      if (state.finishOrder) state.finishOrder = state.finishOrder.map(repl);
      if (state.seatPlays && state.seatPlays[old]) { state.seatPlays[newSid] = state.seatPlays[old]; delete state.seatPlays[old]; }
      if (state.result) {
        state.result.order = state.result.order.map(repl);
        state.result.partnerSid = repl(state.result.partnerSid);
        (state.result.ranks || []).forEach(function (r) { r.sid = repl(r.sid); r.isMe = r.sid === newSid; });
      }
      state._myPassPending = 0;   // sid migration: any in-flight pass echo is stale now
      state.mySeat = seatOfSid(newSid);
      dlog('SID-MIGRATE', old + ' -> ' + newSid + ' host=' + state.hostSid + ' turn=' + state.turn + ' phase=' + state.phase);
      onUpdate(state);
      return true;
    };
    self.mySid = function () { return mySid; };
    self.botsEnabled = botsEnabled;
    self.isBotSid = isBotSid;
    self.botNick = botNick;
    self.roster = allRoster;      // real members + auto-filled bots (for seat picker)
    return self;
  }

  return { create: create };
})();
