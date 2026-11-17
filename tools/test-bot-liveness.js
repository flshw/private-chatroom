'use strict';
/* Fault-injection tests for the bot-liveness fixes in gameclient.js.
 * Run: node tools/test-bot-liveness.js
 * Proves:
 *  1) a throw inside onUpdate (UI render) does NOT stop turn progression
 *  2) if a bot's play echo is dropped, the watchdog re-drives that bot
 *  3) a bot landing on a cardless seat advances to the next active seat
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

// Minimal browser globals: a controllable virtual timer.
function makeSandbox() {
  let now = 0, seq = 0;
  const timers = [];
  const sandbox = {
    console, Math, Date, JSON, Set, Object, Array, String, Number,
    window: {},
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    PCCrypto: {  // only used on deal; stub with no-ops (tests drive state directly)
      aesEncrypt: () => ({}), aesDecrypt: () => '{}', wrapKey: () => '', unwrapKey: () => '',
      randomBytes: n => 'x'.repeat(n), verifySig: () => true
    },
    PCProtocol: { MSG: {}, signedPart: x => x, PROTOCOL_VERSION: 1, DEFAULTS: {} },
    __timers: timers,
    __now: () => now,
    __advance(ms) {  // fire all timers due within ms, in time order
      now += ms;
      let guard = 0;
      while (guard++ < 100) {
        const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at);
        if (!due.length) break;
        const t = due[0];
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    __flushAll() { let g = 0; while (timers.length && g++ < 100) { const t = timers.shift(); t.fn(); } }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.window.PCGame = G; sandbox.window.PCBots = B;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'gameclient.js'), 'utf8'), sandbox);
  return sandbox;
}

function makeGame(sandbox, opts) {
  opts = opts || {};
  const sent = [];
  const ctx = {
    config: { roomId: 'r_test' }, mySid: 'me', uk: { publicPem: 'p', privatePem: 'k' },
    members: { all: () => [], get: () => null },
    sendGame: msg => { sent.push(msg); if (opts.onSend) opts.onSend(msg, sent); },
    sendControl: () => {}, toast: () => {},
    bots: true,
    onUpdate: opts.onUpdate || (() => {})
  };
  const game = sandbox.window.PCGameClient.create(ctx);
  return { game, sent };
}

function seedHand(sandbox, game, hands) {
  // Set up a 4-seat playing state with bots; host is 'me' at seat 0.
  const st = game.state;
  st.seats = ['me', 'bot_1', 'bot_2', 'bot_3'].map(sid => ({ sid, nickname: sid, isBot: sid !== 'me', isMe: sid === 'me' }));
  st.hostSid = 'me'; st.phase = 'playing'; st.spectator = false; st.turn = 'me';
  st.table = null; st.tablePattern = null; st.passes = 0; st.lastWinner = null; st.finishOrder = [];
  st.hand = hands[0].slice();
  st.botHands = { bot_1: hands[1].slice(), bot_2: hands[2].slice(), bot_3: hands[3].slice() };
  // Do NOT call syncSeats(): members is stubbed empty and would wipe seats.
  return st;
}

function dealHands() { return G.deal(G.makeDeck()); }

console.log('\n=== 机器人存活/看门狗故障注入测试 ===');

// Test 1: onUpdate throws -> onPlay still advances turn.
{
  const sb = makeSandbox();
  const { game } = makeGame(sb, { onUpdate: () => { throw new Error('render boom'); } });
  const hands = dealHands();
  const st = seedHand(sb, game, hands);
  game.onMessage({ kind: 'play', by: 'me', round: st.roundNo, cards: [st.hand[0]],
    pattern: { type: 1, rank: st.hand[0].r, len: 1 } });
  // turn should have advanced away from 'me' to bot_1 despite the render throw
  check('渲染抛异常时回合仍推进到下一机器人', st.turn === 'bot_1', 'turn=' + st.turn);
}

// Test 2: bot's play echo dropped -> watchdog re-drives it.
{
  const sb = makeSandbox();
  const { game, sent } = makeGame(sb, { onUpdate: () => {} });
  const hands = dealHands();
  const st = seedHand(sb, game, hands);
  // Advance from 'me' via a play -> turn becomes bot_1, scheduling its move.
  game.onMessage({ kind: 'play', by: 'me', round: st.roundNo, cards: [st.hand[0]],
    pattern: { type: 1, rank: st.hand[0].r, len: 1 } });
  check('回合推进到 bot_1', st.turn === 'bot_1', 'turn=' + st.turn);
  // Drive bot_1's first move by firing the think timer.
  sb.__advance(2000);
  const playsByBot1 = sent.filter(m => m.kind === 'play' && m.by === 'bot_1').length +
                      sent.filter(m => m.kind === 'pass' && m.by === 'bot_1').length;
  check('机器人回合被正常驱动出牌', playsByBot1 >= 1, 'actions=' + playsByBot1);
  // Its move was published but no echo advanced the turn: turn still bot_1.
  // Fire beyond the watchdog threshold (5s); it must re-drive bot_1.
  const before = sent.filter(m => m.by === 'bot_1').length;
  sb.__advance(6000);
  const after = sent.filter(m => m.by === 'bot_1').length;
  check('回显丢失后看门狗重新驱动机器人', after > before, 'before=' + before + ' after=' + after);
}

// Test 3: turn lands on a cardless bot -> advances to next active seat.
{
  const sb = makeSandbox();
  const { game, sent } = makeGame(sb, {});
  const hands = dealHands();
  const st = seedHand(sb, game, hands);
  // Empty bot_1's hand and put turn on it; fake its finish echo missing.
  st.botHands.bot_1 = [];
  st.turn = 'bot_1';
  // Trigger scheduling via a play that advances to bot_1.
  st.turn = 'me';
  game.onMessage({ kind: 'play', by: 'me', round: st.roundNo, cards: [st.hand[0]],
    pattern: { type: 1, rank: st.hand[0].r, len: 1 } });
  // Force turn back onto cardless bot_1 and re-schedule through a pass cycle.
  st.turn = 'bot_1';
  game.onMessage({ kind: 'pass', by: 'bot_3', round: st.roundNo });
  // After scheduling, turn must not remain on cardless bot_1.
  check('空手牌机器人不会被分配回合', !(st.turn === 'bot_1' && st.botHands.bot_1.length === 0), 'turn=' + st.turn);
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
