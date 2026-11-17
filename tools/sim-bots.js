'use strict';
/* Diagnostic: faithfully simulate PCGameClient turn state machine with 3 bots.
 * Run: node tools/sim-bots.js
 */
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));
const B = require(path.join(__dirname, '..', 'client', 'src', 'bots.js'));

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function run(seed) {
  const rnd = mulberry32(seed);
  const seats = ['me', 'bot_1', 'bot_2', 'bot_3'];
  const botSids = ['bot_1', 'bot_2', 'bot_3'];
  const level = 15;
  const hands = G.deal(G.makeDeck(), rnd);
  const botHands = {};
  botSids.forEach((s, i) => botHands[s] = hands[i + 1].slice());
  const state = {
    seats, turn: seats[0], table: null, tablePattern: null, passes: 0,
    lastWinner: null, finishOrder: [], phase: 'playing', hand: hands[0].slice(),
    botHands, roundNo: 1
  };
  const q = [];
  let passEchoSig = null, steps = 0, issue = null;
  let leadPasses = 0, emptyTurns = 0, playCount = 0, passCount = 0;

  const seatOf = s => seats.indexOf(s);
  const isBot = s => botSids.indexOf(s) !== -1;
  function nextActive(from) {
    const i = seatOf(from); if (i < 0) return null;
    for (let n = 1; n <= seats.length; n++) {
      const c = seats[(i + n) % seats.length];
      if (state.finishOrder.indexOf(c) === -1) return c;
    }
    return null;
  }
  function send(msg) { q.push(msg); }
  function scheduleBot() {
    const sid = state.turn;
    if (!sid || !isBot(sid)) return;
    if (!state.botHands[sid] || !state.botHands[sid].length) {
      emptyTurns++; issue = issue || ('EMPTY_TURN:' + sid); return;
    }
  }
  function advance(from) {
    const i = seatOf(from);
    for (let n = 1; n <= seats.length; n++) {
      const c = seats[(i + n) % seats.length];
      if (state.finishOrder.indexOf(c) === -1) { state.turn = c; break; }
    }
    scheduleBot();
  }
  function applyPass(by) {
    state.passes++; passCount++;
    if (state.passes >= seats.length - 1 - state.finishOrder.length) {
      state.table = null; state.tablePattern = null; state.passes = 0;
      let lead = state.lastWinner || by;
      if (state.finishOrder.indexOf(lead) !== -1) lead = nextActive(lead) || by;
      state.turn = lead;
    } else advance(by);
    scheduleBot();
  }
  function onPlay(msg) {
    const p = G.classify(msg.cards, level) || msg.pattern;
    state.table = { cards: msg.cards, type: p && p.type, bySid: msg.by };
    state.tablePattern = p; state.passes = 0; state.lastWinner = msg.by; playCount++;
    if (msg.by !== 'me') {
      const ids = new Set(msg.cards.map(c => c.id));
      state.hand = state.hand.filter(c => !ids.has(c.id));
    }
    if (state.hand.length === 0 && state.finishOrder.indexOf('me') === -1) state.finishOrder.push('me');
    advance(msg.by);
  }
  function onPass(msg) {
    const sig = state.roundNo + '|' + msg.by;
    if (msg.by === 'me' && passEchoSig === sig) { passEchoSig = null; return; }
    applyPass(msg.by);
  }
  function onFinished(msg) {
    state.finishOrder = msg.order.slice();
    if (state.finishOrder.length >= 2) state.phase = 'finished';
  }
  function onMessage(m) {
    switch (m.kind) {
      case 'play': onPlay(m); break;
      case 'pass': onPass(m); break;
      case 'finished': onFinished(m); break;
    }
  }
  function decide(hand) {
    try { return B.chooseMove({ hand, tablePattern: state.tablePattern, level }, G); }
    catch (e) { return null; }
  }
  function botStep(sid) {
    if (state.turn !== sid) return;
    const hand = state.botHands[sid];
    if (!hand || !hand.length) { issue = issue || ('BOTSTEP_EMPTY:' + sid); return; }
    const mv = decide(hand);
    if (!mv) {
      if (state.tablePattern == null) { leadPasses++; issue = issue || ('LEAD_PASS:' + sid); }
      send({ kind: 'pass', round: state.roundNo, by: sid }); return;
    }
    const ids = new Set(mv.cards.map(c => c.id));
    state.botHands[sid] = hand.filter(c => !ids.has(c.id));
    send({ kind: 'play', round: state.roundNo, by: sid, cards: mv.cards, pattern: mv.pattern, bot: true });
    if (!state.botHands[sid].length) {
      const o = state.finishOrder.slice(); if (o.indexOf(sid) === -1) o.push(sid);
      send({ kind: 'finished', round: state.roundNo, by: sid, order: o });
    }
  }
  function humanStep() {
    if (state.finishOrder.indexOf('me') !== -1) { advance('me'); return; }
    const mv = decide(state.hand);
    if (!mv) {
      if (state.tablePattern == null) { leadPasses++; issue = issue || ('LEAD_PASS:me'); }
      passEchoSig = state.roundNo + '|me'; applyPass('me');
      send({ kind: 'pass', round: state.roundNo, by: 'me' }); return;
    }
    const ids = new Set(mv.cards.map(c => c.id));
    state.hand = state.hand.filter(c => !ids.has(c.id));
    send({ kind: 'play', round: state.roundNo, by: 'me', cards: mv.cards, pattern: mv.pattern });
    if (!state.hand.length && state.finishOrder.indexOf('me') === -1) {
      const o = state.finishOrder.slice(); o.push('me');
      send({ kind: 'finished', round: state.roundNo, by: 'me', order: o });
    }
  }
  function drain() { while (q.length) onMessage(q.shift()); }

  scheduleBot();
  let stuckAt = null, stable = 0;
  while (state.phase === 'playing' && steps++ < 3000) {
    const before = state.turn;
    if (before === 'me') humanStep(); else botStep(before);
    drain();
    if (state.turn === before && state.phase === 'playing') {
      stable++; if (stable > 5) { stuckAt = before; break; }
    } else stable = 0;
  }
  return {
    steps, issue, leadPasses, emptyTurns, playCount, passCount,
    phase: state.phase, finishOrder: state.finishOrder, stuckAt,
    botLeft: botSids.map(s => s + ':' + state.botHands[s].length).join(' '),
    handLeft: state.hand.length
  };
}

let bad = 0;
const total = 800;
const issues = {};
for (let i = 1; i <= total; i++) {
  const r = run(i * 7919);
  if (r.issue || r.stuckAt || r.phase !== 'finished') {
    bad++;
    const key = r.issue || ('STUCK@' + r.stuckAt) || ('PHASE:' + r.phase);
    issues[key] = (issues[key] || 0) + 1;
    if (bad <= 6) console.log('seed', i * 7919, JSON.stringify(r));
  }
}
console.log('\nTOTAL', total, 'BAD', bad);
console.log(JSON.stringify(issues, null, 2));
