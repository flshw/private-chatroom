'use strict';
/* Reconnect-state tests: a WSS reconnect must NOT destroy an in-progress
 * match. Verifies game.updateMySid remaps every stored sid reference so host
 * identity, seats, turn, hands and botHands survive a fresh sid assignment. */
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
  const sandbox = {
    console, Math, Date, JSON, Set, Object, Array, String, Number,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    window: {}
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.window.PCGame = G; sandbox.window.PCBots = B;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'gameclient.js'), 'utf8'), sandbox);
  return sandbox;
}

function makeGame(sb, mySid) {
  const ctx = {
    config: { roomId: 'r_test' }, mySid: mySid, uk: { publicPem: 'p', privatePem: 'k' },
    members: { all: () => [], get: () => null },
    sendGame: () => {}, sendControl: () => {}, toast: () => {}, bots: true, onUpdate: () => {}
  };
  return sb.window.PCGameClient.create(ctx);
}

console.log('=== 重连后牌局状态保留(updateMySid) ===');

// Seed a live match where 'me' is host at seat 0, turn on a bot.
const sb = makeSandbox();
const game = makeGame(sb, 's_old');
const st = game.state;
st.seats = ['s_old', 'bot_1', 'bot_2', 'bot_3'].map(sid => ({ sid, nickname: sid, isBot: sid.indexOf('bot_') === 0, isMe: sid === 's_old' }));
st.players = ['s_old', 'bot_1', 'bot_2', 'bot_3'];
st.hostSid = 's_old'; st.phase = 'playing'; st.spectator = false; st.turn = 'bot_2';
st.lastWinner = 'bot_1'; st.finishOrder = []; st._myPassPending = 2;
st.hand = G.deal(G.makeDeck())[0];
st.botHands = { bot_1: [], bot_2: [], bot_3: [] };
const handBefore = st.hand.length;

check('前置: 旧sid是房主且局在进行', game.state.hostSid === 's_old' && game.state.phase === 'playing');

// Reconnect assigns a fresh sid.
const changed = game.updateMySid('s_new');
check('迁移返回true', changed === true);
check('mySid已更新', game.mySid() === 's_new', game.mySid());
check('房主sid随之迁移(isHost仍成立)', st.hostSid === 's_new', st.hostSid);
check('座位sid迁移且isMe正确', st.seats[0].sid === 's_new' && st.seats[0].isMe === true);
check('players迁移', st.players[0] === 's_new');
check('当前回合未受影响', st.turn === 'bot_2', st.turn);
check('上家赢家未受影响', st.lastWinner === 'bot_1');
check('手牌完整保留', st.hand.length === handBefore);
check('phase仍为playing(未回退idle)', st.phase === 'playing');
check('过牌回显计数在重连后清零(旧回显作废)', st._myPassPending === 0, st._myPassPending);

// Idempotent: same sid -> no change
const changed2 = game.updateMySid('s_new');
check('相同sid重复调用无副作用', changed2 === false);

// isHost behaviour: migrate back and confirm host check still works internally
const st2 = makeSandbox();
const g2 = makeGame(st2, 's_a');
g2.state.hostSid = 's_a'; g2.state.phase = 'playing'; g2.state.spectator = false;
g2.updateMySid('s_b');
check('迁移后仍为房主(机器人可继续驱动)', g2.state.hostSid === 's_b' && g2.mySid() === 's_b');

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
