'use strict';
/* Guandan rule-correctness regression (v23).
 * Run: node tools/test-guandan-rules.js
 * Proves:
 *  R1) When NOT playing 2, a plain 2 is the LOWEST card:
 *      - single 2 loses to single 3; 2-pair loses to 3-pair; 2-bomb is the
 *        weakest bomb; a 2 is never allowed in straights.
 *      - When PLAYING 2 (level=15) it is the level card (2nd only to jokers).
 *  R2) "接风" lead hand-off: if the trick winner has emptied their hand, the
 *      next lead goes to their PARTNER (opposite seat), NOT the next player on
 *      the right; if the partner also finished, fall back to next active seat.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));
const B = require(path.join(__dirname, '..', 'client', 'src', 'bots.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}
const S = 'S', H = 'H';
function card(r, s) { return { r, s: s || S, id: 'r' + r + (s || S) + Math.random().toString(36).slice(2, 6) }; }

console.log('\n=== 掼蛋规则正确性测试 ===');

/* ---------- R1: rank-2 strength ---------- */
{
  const L = 10; // playing 10, so 2 must be the smallest card
  const single2 = G.classify([card(15)], L);
  const single3 = G.classify([card(3)], L);
  check('打10时 单2 小于 单3', G.canBeat(single3, single2, L) === true);
  check('打10时 单2 不能压 单3', G.canBeat(single2, single3, L) === false);

  const pair2 = G.classify([card(15, S), card(15, H)], L);
  const pair3 = G.classify([card(3, S), card(3, H)], L);
  check('打10时 对2 小于 对3', G.canBeat(pair3, pair2, L) === true);

  const bomb2 = G.classify([card(15, S), card(15, H), card(15, 'C'), card(15, 'D')], L);
  const bomb3 = G.classify([card(3, S), card(3, H), card(3, 'C'), card(3, 'D')], L);
  check('打10时 2炸 是最弱炸弹(小于3炸)', G.canBeat(bomb3, bomb2, L) === true);

  // A 2 must NOT be usable inside a straight: 10-J-Q-K-A-2 is invalid.
  const fakeStr8 = [card(10), card(11), card(12), card(13), card(14), card(15)];
  const cls = G.classify(fakeStr8, L);
  check('2 不能进入顺子(10JQKA2 不是有效顺子)', !cls || cls.type !== G.TYPE.STRAIGHT,
    'got ' + (cls && cls.name));

  // sortHand: 2 should sort to the very front (weakest) when playing 10.
  const hand = [card(15), card(3), card(14), card(9)];
  const sorted = G.sortHand(hand, L);
  check('打10时 理牌把2放最弱端', sorted[0].r === 15, 'first=' + sorted[0].r);
}
{
  const L = 15; // playing 2 -> 2 is the level card
  const single2 = G.classify([card(15)], L);
  const singleA = G.classify([card(14)], L);
  check('打2时 单2(级牌) 压 单A', G.canBeat(single2, singleA, L) === true);
  const sJoker = G.classify([card(16, 'W')], L);
  check('打2时 小王 仍压 级牌2', G.canBeat(sJoker, single2, L) === true);
}

/* ---------- R2: 接风 lead hand-off ---------- */
function makeSandbox() {
  let now = 0, seqId = 0;
  const timers = [];
  const sandbox = {
    console: { info() {}, warn() {}, log() {} }, Math, Date, JSON, Set, Object, Array, String, Number,
    setTimeout(fn, ms) { const id = ++seqId; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    PCCrypto: { aesEncrypt: () => ({}), aesDecrypt: () => '{}', wrapKey: () => '', unwrapKey: () => '',
      randomBytes: n => 'x'.repeat(n), verifySig: () => true },
    PCProtocol: { MSG: {}, signedPart: x => x, PROTOCOL_VERSION: 1, DEFAULTS: {} }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.window.PCGame = G; sandbox.window.PCBots = B;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'gameclient.js'), 'utf8'), sandbox);
  return sandbox;
}
function makeGame(sb) {
  return sb.window.PCGameClient.create({
    config: { roomId: 'r_test' }, mySid: 'me', uk: { publicPem: 'p', privatePem: 'k' },
    members: { all: () => [], get: () => null },
    sendGame: () => {}, sendControl: () => {}, toast: () => {},
    bots: false, onUpdate: () => {}
  });
}
/* Seat order: [s0, s1, s2, s3]; teams by parity => s0&s2, s1&s3.
 * lastWinner = s0 who has just emptied their hand (in finishOrder).
 * Everyone else passes -> new trick. Lead must go to s2 (partner of s0). */
{
  const sb = makeSandbox();
  const game = makeGame(sb);
  const st = game.state;
  const seats = ['s0', 's1', 's2', 's3'].map(sid => ({ sid, nickname: sid, isBot: false, isMe: sid === 'me' }));
  st.seats = seats; st.players = seats.map(s => s.sid);
  st.partnerSid = 's2'; st.hostSid = 's0'; st.phase = 'playing'; st.roundNo = 3;
  st.level = 10; st.table = { cards: [card(9)], type: 'single', bySid: 's0' };
  st.tablePattern = G.classify([card(9)], 10);
  st.passes = 0; st.lastWinner = 's0';
  st.finishOrder = ['s0'];                 // s0 emptied their hand
  st.seatPlays = {}; st.turn = 's1'; st.spectate = [];
  // s1, s3 pass (2 passes). Threshold = seats(4) - 1 - finishOrder(1) = 2.
  game.onMessage({ kind: 'pass', by: 's1', round: 3 });
  game.onMessage({ kind: 'pass', by: 's3', round: 3 });
  check('接风: 赢家出完后由对家(s2)领出，而非下家(s1)', st.turn === 's2',
    'turn=' + st.turn);
}
/* Partner also finished -> fall back to next active seat after winner. */
{
  const sb = makeSandbox();
  const game = makeGame(sb);
  const st = game.state;
  const seats = ['s0', 's1', 's2', 's3'].map(sid => ({ sid, nickname: sid, isBot: false, isMe: false }));
  st.seats = seats; st.players = seats.map(s => s.sid);
  st.partnerSid = 's2'; st.hostSid = 's0'; st.phase = 'playing'; st.roundNo = 4;
  st.level = 10; st.table = { cards: [card(9)], type: 'single', bySid: 's0' };
  st.tablePattern = G.classify([card(9)], 10);
  st.passes = 0; st.lastWinner = 's0';
  st.finishOrder = ['s0', 's2'];            // winner + partner both finished
  st.seatPlays = {}; st.turn = 's1'; st.spectate = [];
  // alive: s1, s3. threshold = 4-1-2 = 1 pass
  game.onMessage({ kind: 'pass', by: 's1', round: 4 });
  check('对家也出完时 接风回退到下一个在场者(s1或s3)',
    st.turn === 's1' || st.turn === 's3', 'turn=' + st.turn);
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail === 0 ? 0 : 1);
