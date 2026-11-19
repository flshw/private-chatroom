'use strict';
/* v29 compass seat layout + control sizing smoke test.
 * Run: node tools/test-seat-layout.js
 * Verifies renderGame assigns role-based compass positions:
 *   me -> bottom, partner -> top, opponents -> left/right
 * and that the built HTML has the enlarged play button + 2-char gaps.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

// --- minimal DOM (mirrors test-deluxe-render.js) ---
function El(tag) {
  this.tagName = (tag || 'div').toUpperCase();
  this.children = []; this.dataset = {}; this.style = { setProperty() {} };
  this._text = ''; this.className = ''; this._listeners = {};
  this.classList = {
    _s: new Set(),
    add(...c) { c.forEach(x => this._s.add(x)); },
    remove(...c) { c.forEach(x => this._s.delete(x)); },
    toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; },
    contains(c) { return this._s.has(c); }
  };
}
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._text; }, set(v) { this._text = String(v); this.children = []; }
});
Object.defineProperty(El.prototype, 'innerHTML', {
  get() { return this._html || ''; }, set(v) { this._html = String(v); this.children = []; }
});
El.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; return c; };
El.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; };
El.prototype.closest = function () { return null; };

const ids = ['game-seats','game-table','my-info-bar','my-hand','game-log','game-panel','card-counter',
  'game-level','btn-game-play','btn-game-pass','btn-game-start','game-settle','game-settle-mask',
  'settle-title','settle-sub','settle-ranks','btn-settle-next','btn-settle-close','player-picks',
  'partner-picks','toast','diag-panel','diag-body'];
const byId = {};
ids.forEach(id => byId[id] = new El('div'));

const sandbox = {
  console: { warn() {}, info() {}, log() {}, error() {} },
  Math, Date, JSON, Set, Object, Array, String, Number,
  navigator: {}, Blob: function () {}, URL: { createObjectURL() {}, revokeObjectURL() {} },
  matchMedia: () => ({ matches: false }),
  setTimeout, clearTimeout,
  document: {
    readyState: 'complete',
    getElementById: id => byId[id] || null,
    createElement: t => new El(t),
    addEventListener() {},
    body: new El('body')
  }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.window.matchMedia = () => ({ matches: false });
sandbox.addEventListener = function () {};
sandbox.removeEventListener = function () {};

const rankName = r => ({ 15:'2',14:'A',13:'K',12:'Q',11:'J' })[r] || String(r);

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'deluxe.js'), 'utf8'), sandbox);
const D = sandbox.window.PCDeluxe;

function posOf(se) {
  const m = /seat-pos-(bottom|top|left|right)/.exec(se.className);
  return m ? m[1] : null;
}
function renderWith(meSid, partnerSid) {
  const seats = [
    { sid:'me', nickname:'我', isMe: meSid === 'me' },
    { sid:'bot_1', nickname:'机器人1' },
    { sid:'bot_2', nickname:'机器人2', isMe: meSid === 'bot_2' },
    { sid:'bot_3', nickname:'机器人3', isMe: meSid === 'bot_3' }
  ];
  const state = {
    seats, hostSid:'me', partnerSid, mySeat:0, phase:'playing',
    level:15, roundNo:1, turn:'me', table:null, log:['你出 对K'],
    seatPlays: {}, played:[], spectate:[], pendingForMe:null, targetHand:[]
  };
  const game = {
    state, rankName, remainingOf: () => 5, syncSeats() {},
    mySid: () => meSid, nextRound() {}
  };
  D.bind({ game, app: { state: { mySid: meSid }, toast() {} } });
  D.renderGame(state);
  return byId['game-seats'].children.map(posOf);
}

console.log('\n=== v29 座位方位 + 按钮尺寸测试 ===');

// Case 1: I am seat0, partner is bot_2 (seat2) -> me bottom, partner top, others left/right
{
  const pos = renderWith('me', 'bot_2');
  check('渲染出 4 个座位', pos.length === 4, JSON.stringify(pos));
  check('自己在下方(bottom)', pos[0] === 'bottom', JSON.stringify(pos));
  check('对家在上方(top)', pos[2] === 'top', JSON.stringify(pos));
  check('两名对手分别在左右', ['left','right'].indexOf(pos[1]) !== -1 && ['left','right'].indexOf(pos[3]) !== -1 && pos[1] !== pos[3], JSON.stringify(pos));
}

// Case 2: I am bot_3 (seat3), partner is bot_1 -> compass follows ROLE not index
{
  const pos = renderWith('bot_3', 'bot_1');
  check('换座位后自己仍在下方(bottom)', pos[3] === 'bottom', JSON.stringify(pos));
  check('换座位后对家仍在上方(top)', pos[1] === 'top', JSON.stringify(pos));
  check('换座位后另两人在左右', pos[0] && pos[2] && ['left','right'].indexOf(pos[0]) !== -1 && ['left','right'].indexOf(pos[2]) !== -1 && pos[0] !== pos[2], JSON.stringify(pos));
}

// Built HTML assertions
const deluxe = fs.readFileSync(path.join(__dirname, '..', 'client', 'dist', 'private-chat-deluxe.template.html'), 'utf8');
check('CSS 有 seat-pos-top 绝对定位', deluxe.indexOf('.seat.seat-pos-top{left:50%;top:0;transform:translateX(-50%)}') !== -1);
check('CSS 出牌按钮 8em', deluxe.indexOf('#btn-game-play{flex:0 0 8em;width:8em') !== -1);
check('CSS 按钮间隔 2em', deluxe.indexOf('.game-bottom{display:flex;gap:2em;justify-content:center') !== -1);
check('全双工语音已从构建产物移除', deluxe.indexOf('btn-voice-live') === -1 && deluxe.indexOf('RTCPeerConnection') === -1);
check('加密语音包仍在构建产物中', deluxe.indexOf('id="btn-voice"') !== -1 && deluxe.indexOf('recordVoice') !== -1);

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
