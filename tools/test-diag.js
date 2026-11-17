'use strict';
/* Tests for the bot behaviour diagnostic trace.
 * Run: node tools/test-diag.js
 * Proves:
 *  1) diagText() exports a header + full event trace
 *  2) a SYNCHRONOUS throw from sendGame is logged as SEND-SYNC-ERR
 *  3) an ASYNC rejection from sendGame is logged as SEND-REJECT (the blind spot
 *     that a plain try/catch could never see)
 *  4) the whole scheduling -> decide -> send chain appears in the trace
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

function makeSandbox() {
  let now = 0, seq = 0;
  const timers = [];
  const logs = [];
  const sb = {
    console: { info: (...a) => logs.push(a.join(' ')), warn: () => {}, log: () => {} },
    Math, Date, JSON, Set, Object, Array, String, Number, Promise,
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    PCCrypto: { aesEncrypt: () => ({}), aesDecrypt: () => '{}', wrapKey: () => '', unwrapKey: () => '', randomBytes: n => 'x'.repeat(n) },
    PCProtocol: { MSG: {} },
    __advance(ms) {
      now += ms; let guard = 0;
      while (guard++ < 100) {
        const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at);
        if (!due.length) break;
        const t = due[0]; timers.splice(timers.indexOf(t), 1); t.fn();
      }
    }
  };
  sb.window = sb; sb.globalThis = sb;
  sb.window.PCGame = G; sb.window.PCBots = B;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'gameclient.js'), 'utf8'), sb);
  return sb;
}

function makeGame(sb, sendGame) {
  const ctx = {
    config: { roomId: 'r_test' }, mySid: 'me', uk: { publicPem: 'p', privatePem: 'k' },
    members: { all: () => [], get: () => null },
    sendGame: sendGame || (() => undefined), sendControl: () => {}, toast: () => {},
    bots: true, onUpdate: () => {}
  };
  return sb.window.PCGameClient.create(ctx);
}
function seed(game, hands) {
  const st = game.state;
  st.seats = ['me', 'bot_1', 'bot_2', 'bot_3'].map(sid => ({ sid, nickname: sid, isBot: sid !== 'me', isMe: sid === 'me' }));
  st.hostSid = 'me'; st.phase = 'playing'; st.spectator = false; st.turn = 'me';
  st.table = null; st.tablePattern = null; st.passes = 0; st.lastWinner = null; st.finishOrder = [];
  st.hand = hands[0].slice();
  st.botHands = { bot_1: hands[1].slice(), bot_2: hands[2].slice(), bot_3: hands[3].slice() };
  return st;
}

console.log('\n=== 机器人诊断日志测试 ===');

// Test 1: diagText exports header + events.
{
  const sb = makeSandbox();
  const game = makeGame(sb);
  const st = seed(game, G.deal(G.makeDeck()));
  game.onMessage({ kind: 'play', by: 'me', round: st.roundNo, cards: [st.hand[0]],
    pattern: { type: 1, rank: st.hand[0].r, len: 1 } });
  const text = game.diagText();
  check('diagText 导出表头', /=== 掼蛋机器人诊断日志 ===/.test(text));
  check('diagText 含 RECV 事件', /RECV/.test(text));
  check('diagText 含 ADVANCE 事件', /ADVANCE/.test(text));
  check('diagText 含 SCHEDULE 事件', /SCHEDULE/.test(text));
}

// Test 2: synchronous throw from sendGame is logged.
{
  const sb = makeSandbox();
  const game = makeGame(sb, () => { throw new Error('sync wrap failed'); });
  const st = seed(game, G.deal(G.makeDeck()));
  game.onMessage({ kind: 'play', by: 'me', round: st.roundNo, cards: [st.hand[0]],
    pattern: { type: 1, rank: st.hand[0].r, len: 1 } });
  sb.__advance(2000); // fire bot think timer -> botStep -> sendDiag
  check('同步发送异常被记录为 SEND-SYNC-ERR', /SEND-SYNC-ERR/.test(game.diagText()));
}

// Test 3: async rejection from sendGame is logged (the critical blind spot).
{
  const sb = makeSandbox();
  const game = makeGame(sb, () => Promise.reject(new Error('async buildMessage rejected')));
  const st = seed(game, G.deal(G.makeDeck()));
  game.onMessage({ kind: 'play', by: 'me', round: st.roundNo, cards: [st.hand[0]],
    pattern: { type: 1, rank: st.hand[0].r, len: 1 } });
  sb.__advance(2000);
  // flush microtasks (Promise .catch) with async boundary
  return new Promise(resolve => setImmediate(() => {
    const text = game.diagText();
    check('异步发送拒绝被记录为 SEND-REJECT', /SEND-REJECT/.test(text), text.split('\n').filter(l => /SEND/.test(l)).join(' | '));
    console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
    process.exitCode = fail ? 1 : 0;
    resolve();
  }));
}
