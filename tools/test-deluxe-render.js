'use strict';
/* Deluxe render smoke test (v20) — exercises the NEW render paths (per-seat
 * play display, low-card counts, settlement panel, per-stack 全选, marquee)
 * against a minimal DOM stub to catch runtime errors/typos. No browser needed.
 * Run: node tools/test-deluxe-render.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

// --- minimal DOM ---
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
El.prototype.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; };
El.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; };
El.prototype.closest = function () { return null; };
El.prototype.setProperty = function () {};

const ids = ['game-seats','game-table','my-info-bar','my-hand','game-log','game-panel','card-counter',
  'game-level','spectator-note','btn-game-play','btn-game-pass','btn-game-start',
  'game-settle','game-settle-mask','settle-title','settle-sub','settle-ranks',
  'btn-settle-next','btn-settle-close','player-picks','partner-picks','btn-game-start',
  'spectate-consent','toast','btn-game-marquee','diag-panel','diag-body'];
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
sandbox.addEventListener = function () {};   // window-level pointermove/up listeners
sandbox.removeEventListener = function () {};

// stub game engine pieces PCDeluxe expects
const rankName = r => ({ 15:'2',14:'A',13:'K',12:'Q',11:'J' })[r] || String(r);
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'deluxe.js'), 'utf8'), sandbox);
const D = sandbox.window.PCDeluxe;

// a fake game object
const state = {
  seats: [
    { sid:'me', nickname:'我', isMe:true },
    { sid:'bot_1', nickname:'机器人1', isBot:true },
    { sid:'bot_2', nickname:'机器人2', isBot:true },
    { sid:'bot_3', nickname:'机器人3', isBot:true }
  ],
  hostSid:'me', partnerSid:'bot_2', mySeat:0, phase:'playing', spectator:false,
  level:15, roundNo:1, turn:'me', table:null, tablePattern:null,
  log:['你出 对K'], played:[], spectate:[], pendingForMe:null, targetHand:[],
  seatPlays: {
    bot_1: { cards:[{s:'H',r:10,id:'a'},{s:'H',r:10,id:'b'}], pattern:{name:'对子'} },
    bot_2: { cards:[], passed:true }
  }
};
const game = {
  state,
  rankName,
  remainingOf: sid => ({ me:5, bot_1:8, bot_2:9, bot_3:12 })[sid],
  syncSeats() {},
  mySid: () => 'me',
  nextRound() { state._nextCalled = true; }
};
const ctx = { state: { mySid: 'me' }, toast() {} };

console.log('\n=== 豪华版新渲染路径冒烟测试 ===');
let err = null;
try {
  D.bind({ game, app: ctx });
  D.renderGame(state);
} catch (e) { err = e; }
check('playing 阶段渲染无异常（含每座位出牌/低牌数/全选按钮）', !err, err && err.stack);
check('座位渲染出 剩N张 低牌数', byId['game-seats'].children.some(se =>
  se.children.some(c => c._text && c._text.indexOf('剩 ') === 0)),
  byId['game-seats'].children.map(se => se.children.map(c => c._text).join('|')).join(' / '));
check('座位渲染出对家标识', byId['game-seats'].children.some(se =>
  se.children.some(c => c._text && c._text.indexOf('对家') !== -1)));
check('座位渲染出过牌标记', byId['game-seats'].children.some(se =>
  se.children.some(c => c.children && c.children.some(x => x._text === '过'))));

// settlement state
state.phase = 'finished';
state.result = {
  round:1, levelBefore:15, levelAfter:6, delta:3, win:true, partnerSid:'bot_2',
  order:['me','bot_1','bot_2','bot_3'],
  ranks:[
    {sid:'me',nickname:'我',title:'大科',isMe:true,teammate:true},
    {sid:'bot_1',nickname:'机器人1',title:'二科',isMe:false,teammate:false},
    {sid:'bot_2',nickname:'机器人2',title:'二拉',isMe:false,teammate:true},
    {sid:'bot_3',nickname:'机器人3',title:'大拉',isMe:false,teammate:false}
  ]
};
err = null;
try { D.renderGame(state); } catch (e) { err = e; }
check('finished 阶段结算面板渲染无异常', !err, err && err.stack);
check('结算面板显示', !byId['game-settle'].classList.contains('hidden'));
check('结算标题含局号与打几', byId['settle-title']._text.indexOf('第 1 局') !== -1 &&
  byId['settle-title']._text.indexOf('打 6') !== -1, byId['settle-title']._text);
check('结算列出四个名次', byId['settle-ranks'].children.length === 4);
check('下一局按钮为主机可用', byId['btn-settle-next'].disabled === false);

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
