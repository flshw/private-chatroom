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

const ids = ['game-seats','game-table','my-info-bar','my-hand','game-log','game-chat','game-panel','card-counter',
  'tab-game-log','tab-game-chat','game-level','btn-game-play','btn-game-pass','btn-game-start','game-settle','game-settle-mask',
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

console.log('\n=== v30 座位方位 + 记牌器同行 + 侧栏 + 按钮尺寸测试 ===');

// Case 1: I am seat0, partner is bot_2 (seat2) -> only 3 boxes: partner top, others left/right
{
  const pos = renderWith('me', 'bot_2');
  check('渲染出 3 个座位（本人框已删除）', pos.length === 3, JSON.stringify(pos));
  check('不含 bottom 方位（无本人框）', pos.indexOf('bottom') === -1, JSON.stringify(pos));
  check('对家在上方(top)', pos[1] === 'top', JSON.stringify(pos));
  check('两名对手分别在左右', pos[0] === 'left' && pos[2] === 'right', JSON.stringify(pos));
}

// Case 2: I am bot_3 (seat3), partner is bot_1 -> compass follows ROLE not index; me box omitted
{
  const pos = renderWith('bot_3', 'bot_1');
  check('换座位后仍只有 3 个框', pos.length === 3 && pos.indexOf('bottom') === -1, JSON.stringify(pos));
  check('换座位后对家仍在上方(top)', pos[1] === 'top', JSON.stringify(pos));
  check('换座位后另两人在左右', pos[0] === 'left' && pos[2] === 'right', JSON.stringify(pos));
}

// v33: click a collapsed side tab to float its panel out; clicking the other
// tab closes the first. Tabs were bound at module load (wire() ran already).
{
  const tabLog = byId['tab-game-log'], tabChat = byId['tab-game-chat'];
  const log = byId['game-log'], chat = byId['game-chat'];
  check('侧栏呼出按钮已绑定点击', !!(tabLog._listeners && tabLog._listeners.click && tabLog._listeners.click.length));
  if (tabLog._listeners && tabLog._listeners.click) {
    tabLog._listeners.click[0]();
    check('点击牌局动态标签呼出面板', log.classList.contains('rail-open'));
    if (tabChat._listeners && tabChat._listeners.click) {
      tabChat._listeners.click[0]();
      check('点击游戏聊天标签切换:前者关闭', !log.classList.contains('rail-open') && chat.classList.contains('rail-open'));
    }
  }
}

// Built HTML assertions
const deluxe = fs.readFileSync(path.join(__dirname, '..', 'client', 'dist', 'private-chat-deluxe.template.html'), 'utf8');
check('CSS 有 seat-pos-top 绝对定位', deluxe.indexOf('.seat.seat-pos-top{left:50%;top:0;transform:translateX(-50%)}') !== -1);
check('无本人座位框（源码已跳过 isMe）', deluxe.indexOf('if (s && s.isMe) continue;') !== -1);
check('记牌器与级别同行容器 game-headrow', deluxe.indexOf('class="game-headrow"') !== -1 && deluxe.indexOf('.game-headrow{display:flex') !== -1);
check('游戏聊天侧栏 UI', deluxe.indexOf('id="game-chat"') !== -1);
check('游戏聊天侧栏样式(右侧对称)', deluxe.indexOf('.game-chat{right:10px}') !== -1);
check('侧栏退到外侧(10px)', deluxe.indexOf('.game-log{left:10px}') !== -1 && deluxe.indexOf('.game-chat{right:10px}') !== -1);
check('v33 牌桌核心容器 game-core 包住座位与出牌区(随缩放)', deluxe.indexOf('class="game-core"') !== -1 && deluxe.indexOf('.game-core{position:relative;width:min(100%,calc(560px * var(--ui-scale)))') !== -1);
check('v33 核心顶部留白防对家框压住出牌区', deluxe.indexOf('--core-top:calc(84px * var(--ui-scale))') !== -1 && deluxe.indexOf('padding-top:var(--core-top)') !== -1);
check('v33 对家贴出牌区上方(top:0)', deluxe.indexOf('.seat.seat-pos-top{left:50%;top:0;transform:translateX(-50%)}') !== -1);
check('v33 两对手贴出牌区左右(随缩放)', deluxe.indexOf('.seat.seat-pos-left{left:calc(-142px * var(--ui-scale))') !== -1 && deluxe.indexOf('.seat.seat-pos-right{right:calc(-142px * var(--ui-scale))') !== -1);
check('v33 出牌区由 core 承载且加高', deluxe.indexOf('.game-table{width:100%;min-height:calc(200px * var(--ui-scale))') !== -1);
check('v33 牌局动态/游戏聊天加高(78vh)', deluxe.indexOf('min-height:calc(280px * var(--ui-scale));max-height:78vh') !== -1);
check('v33 侧栏窄宽度收缩标签与呼出逻辑', deluxe.indexOf('id="tab-game-log"') !== -1 && deluxe.indexOf('rails-collapsed') !== -1 && deluxe.indexOf("panel.classList.toggle('rails-collapsed', narrow)") !== -1);
check('v33 竖屏旋转提示 + 强制横屏', deluxe.indexOf('id="rotate-hint"') !== -1 && deluxe.indexOf('@media(orientation:portrait) and (max-width:820px)') !== -1);
check('v33 窗体缩放变量(--ui-scale)', deluxe.indexOf("root.style.setProperty('--ui-scale'") !== -1 && deluxe.indexOf('calc(13px * var(--ui-scale))') !== -1);
check('app 镜像聊天到游戏侧栏', deluxe.indexOf("var gchat = $('game-chat');") !== -1);
check('CSS 出牌按钮 8em', deluxe.indexOf('#btn-game-play{flex:0 0 8em;width:8em') !== -1);
check('CSS 按钮间隔 2em', deluxe.indexOf('.game-bottom{display:flex;gap:2em;justify-content:center') !== -1);
check('全双工语音已从构建产物移除', deluxe.indexOf('btn-voice-live') === -1 && deluxe.indexOf('RTCPeerConnection') === -1);
check('加密语音包仍在构建产物中', deluxe.indexOf('id="btn-voice"') !== -1 && deluxe.indexOf('recordVoice') !== -1);

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
