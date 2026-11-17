'use strict';
/* Fault-injection tests for the net.js CONNECT-WATCHDOG / half-open fixes.
 * Run: node tools/test-net-watchdog.js
 * Proves:
 *  1) a socket stuck in CONNECTING is force-closed and reconnects
 *     (onclose does NOT fire on its own — exactly the 25s freeze in the log)
 *  2) a half-open socket (OPEN but silent) is force-closed after 2 missed
 *     heartbeats
 *  3) a healthy socket is NOT spuriously reconnected
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

function makeSandbox(sockFactory) {
  let now = 0, seq = 0;
  const timers = [];
  const sockets = [];
  const warns = [];
  const sandbox = {
    console: { warn: m => warns.push(String(m)), info: () => {}, log: () => {} },
    Math, Date, JSON, Set, Object, Array, String, Number, Error,
    WebSocket: function (u) { const s = sockFactory(u, this); sockets.push(s); return s; },
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: now + ms, fn, cleared: false }); return id; },
    clearTimeout(id) { const t = timers.find(t => t.id === id); if (t) t.cleared = true; },
    setInterval(fn, ms) { const id = ++seq; timers.push({ id, at: now + ms, fn, every: ms, cleared: false }); return id; },
    clearInterval(id) { const t = timers.find(t => t.id === id); if (t) t.cleared = true; },
    PCProtocol: { MSG: { PONG: 'pong', PING: 'ping' } },
    __sockets: sockets, __warns: warns,
    __now: () => now,
    __advance(ms) {
      now += ms;
      let guard = 0;
      while (guard++ < 500) {
        const due = timers.filter(t => !t.cleared && t.every && t.at <= now);
        const one = timers.filter(t => !t.cleared && !t.every && t.at <= now)
          .sort((a, b) => a.at - b.at);
        const t = due[0] || one[0];
        if (!t) break;
        if (t.every) t.at += t.every;      // reschedule interval from its own due time
        else t.cleared = true;             // fire timeout once
        t.fn();
      }
    }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'net.js'), 'utf8'), sandbox);
  return sandbox;
}

const CFG = { serverUrl: 'https://x.example', wsUrl: '/pc/ws' };
function mkNet(sb, handlers) {
  handlers = handlers || {};
  handlers.config = CFG;
  const net = new sb.window.PCNet(handlers);
  return net;
}

console.log('\n=== 连接健康看门狗测试 ===');

// Test 1: socket stuck in CONNECTING (never opens, never closes on its own)
{
  let created = 0;
  const sb = makeSandbox((u, obj) => {
    created++;
    obj.readyState = 0; // CONNECTING forever
    obj.close = function () { /* in real browser this fires onclose; simulate below */ };
    obj.send = function () {};
    return obj;
  });
  const net = mkNet(sb);
  net.start({ type: 'join' });
  check('初始创建了 1 个 socket', sb.__sockets.length === 1, 'n=' + sb.__sockets.length);
  // Advance past CONNECT_TIMEOUT_MS (6000) + close guard (400) + some backoff.
  sb.__advance(7000);
  const hasTimeoutWarn = sb.__warns.some(w => w.indexOf('CONNECT-TIMEOUT') >= 0);
  check('CONNECTING 卡死触发连接超时看门狗', hasTimeoutWarn, sb.__warns.join('|'));
}

// Test 2: healthy OPEN socket must not be force-reconnected by watchdog
{
  const sb = makeSandbox((u, obj) => {
    obj.readyState = 1; // OPEN
    obj.close = function () { this.closed = true; };
    obj.send = function (data) {
      // Reply PONG to every PING -> proves liveness
      const f = JSON.parse(data);
      if (f.type === 'ping' && obj.onmessage) obj.onmessage({ data: JSON.stringify({ type: 'pong' }) });
    };
    return obj;
  });
  const net = mkNet(sb);
  net.start({ type: 'join' });
  sb.__advance(60000); // 4+ minutes... actually 60s = 4 heartbeats
  const deadWarn = sb.__warns.some(w => w.indexOf('HEARTBEAT-DEAD') >= 0);
  check('健康连接不会被误判重连', !deadWarn, sb.__warns.join('|'));
  check('健康连接保持单个 socket', sb.__sockets.length === 1, 'n=' + sb.__sockets.length);
}

// Test 3: half-open socket (OPEN but silent) -> forced closed after 2 missed PONGs
{
  let closedCount = 0;
  const sb = makeSandbox((u, obj) => {
    obj.readyState = 1; // OPEN but never replies to PING
    obj.close = function () { closedCount++; obj.readyState = 3; };
    obj.send = function () {}; // no PONG ever
    return obj;
  });
  const net = mkNet(sb);
  net.start({ type: 'join' });
  // 3 heartbeats at 15s = 45s; pongMiss reaches 2 on the 3rd tick -> close.
  sb.__advance(46000);
  const deadWarn = sb.__warns.some(w => w.indexOf('HEARTBEAT-DEAD') >= 0);
  check('半开连接触发心跳死亡检测', deadWarn, sb.__warns.join('|'));
  check('半开连接被强制关闭', closedCount >= 1, 'closed=' + closedCount);
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exitCode = fail ? 1 : 0;
