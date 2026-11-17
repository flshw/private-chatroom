'use strict';
/* Async state-machine simulation with real setTimeout + delayed broadcast echo,
 * so we can reproduce turn deadlocks that a synchronous drain cannot expose.
 * The host owns 3 local bots; every sendGame is echoed back to the host after
 * a variable delay (as the real E2EE server does). A human 'me' occasionally
 * plays/passes too. Run: node tools/sim-bots-async.js
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

function runOnce(seed, cfg) {
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
  let passEchoSig = null;
  let botTimer = null;
  let pending = [];       // in-flight echoes [{at, msg}]
  let now = 0;            // virtual clock (ms)
  let botThink = cfg.botThink;
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
  // sendGame => schedule an echo back to host at now + delay
  function sendGame(msg) {
    const delay = cfg.echoDelay();
    pending.push({ at: now + delay, msg });
  }
  function clearBotTimer() { botTimer = null; }
  function scheduleBot() {
    clearBotTimer();
    if (state.phase !== 'playing') return;
    const sid = state.turn;
    if (!sid || !isBot(sid)) return;
    if (!state.botHands[sid] || !state.botHands[sid].length) return;
    botTimer = { sid, at: now + botThink() };
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
    state.passes++;
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
    state.tablePattern = p; state.passes = 0; state.lastWinner = msg.by;
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
  function dispatch(msg) {
    switch (msg.kind) {
      case 'play': onPlay(msg); break;
      case 'pass': onPass(msg); break;
      case 'finished': onFinished(msg); break;
    }
  }
  function decide(hand) {
    try { return B.chooseMove({ hand, tablePattern: state.tablePattern, level }, G); }
    catch (e) { return null; }
  }
  function botStep(sid) {
    if (state.turn !== sid) return;
    const hand = state.botHands[sid];
    if (!hand || !hand.length) return;
    const mv = decide(hand);
    if (!mv) { sendGame({ kind: 'pass', round: state.roundNo, by: sid }); return; }
    const ids = new Set(mv.cards.map(c => c.id));
    state.botHands[sid] = hand.filter(c => !ids.has(c.id));
    sendGame({ kind: 'play', round: state.roundNo, by: sid, cards: mv.cards, pattern: mv.pattern, bot: true });
    if (!state.botHands[sid].length) {
      const o = state.finishOrder.slice(); if (o.indexOf(sid) === -1) o.push(sid);
      sendGame({ kind: 'finished', round: state.roundNo, by: sid, order: o });
    }
  }
  function humanStep() {
    if (state.finishOrder.indexOf('me') !== -1) { advance('me'); return; }
    const mv = decide(state.hand);
    if (!mv) {
      passEchoSig = state.roundNo + '|me'; applyPass('me');
      sendGame({ kind: 'pass', round: state.roundNo, by: 'me' }); return;
    }
    const ids = new Set(mv.cards.map(c => c.id));
    state.hand = state.hand.filter(c => !ids.has(c.id));
    sendGame({ kind: 'play', round: state.roundNo, by: 'me', cards: mv.cards, pattern: mv.pattern });
    if (!state.hand.length && state.finishOrder.indexOf('me') === -1) {
      const o = state.finishOrder.slice(); o.push('me');
      sendGame({ kind: 'finished', round: state.roundNo, by: 'me', order: o });
    }
  }

  // event loop: repeatedly pick earliest event (bot timer or echo)
  scheduleBot();
  let ticks = 0;
  const LIMIT = 600;
  while (state.phase === 'playing' && ticks++ < LIMIT) {
    const candidates = [];
    if (botTimer) candidates.push({ at: botTimer.at, kind: 'bot', sid: botTimer.sid });
    if (pending.length) candidates.push({ at: pending[0].at, kind: 'echo' });
    if (!candidates.length) break;
    candidates.sort((a, b) => a.at - b.at);
    const ev = candidates[0];
    now = ev.at;
    if (ev.kind === 'bot') {
      botTimer = null;
      botStep(ev.sid);
    } else {
      const msg = pending.shift().msg;
      dispatch(msg);
    }
    // occasionally let the human act when it's their turn (with a small delay)
    if (state.phase === 'playing' && state.turn === 'me' &&
        state.finishOrder.indexOf('me') === -1 && rnd() < cfg.humanActProb) {
      humanStep();
    }
  }
  const stuck = state.phase === 'playing' && ticks >= LIMIT;
  return { ticks, stuck, phase: state.phase, turn: state.turn,
    finishOrder: state.finishOrder.slice(),
    botLeft: botSids.map(s => state.botHands[s].length),
    pending: pending.length, botTimer: !!botTimer };
}

const cfg = {
  botThink: () => 300 + Math.floor(Math.random() * 200),
  echoDelay: () => 40 + Math.floor(Math.random() * 120),
  humanActProb: 0.15
};
let stuckCount = 0, samples = [];
for (let i = 1; i <= 500; i++) {
  const r = runOnce(i * 104729, cfg);
  if (r.stuck) {
    stuckCount++;
    if (samples.length < 6) samples.push({ seed: i * 104729, ...r });
  }
}
console.log('async sim: 500 games, stuck/deadlock =', stuckCount);
if (samples.length) console.log(JSON.stringify(samples, null, 2));
