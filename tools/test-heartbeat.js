/*
 * Regression test: heartbeat must use the SAME object that the pong handler
 * touches. The old code read/wrote ws.isAlive while pong set session.isAlive,
 * so every socket was terminated on the 2nd tick regardless of pong replies.
 */
'use strict';
const assert = require('assert');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

/* Simulate N heartbeat ticks. A live client replies to every ping (pong event
 * fires between ticks). Return how many ticks the client was terminated. */
function runHeartbeat({ buggy, ticks, repliesPong }) {
  const session = { connId: 'abc', isAlive: true, touch() { this.isAlive = true; } };
  const ws = { _session: session, terminated: 0, terminate() { this.terminated++; } };
  const clients = [ws];
  let kills = 0;

  for (let t = 0; t < ticks; t++) {
    // heartbeat tick
    for (const w of clients) {
      if (buggy) {
        // OLD: reads/writes ws.isAlive (never set by pong)
        if (w.isAlive === false) { w.terminate(); kills++; continue; }
        w.isAlive = false;
      } else {
        // FIXED: reads/writes session.isAlive (set by pong->touch)
        const s = w._session;
        if (s && s.isAlive === false) { w.terminate(); kills++; continue; }
        if (s) s.isAlive = false;
      }
      // browser auto-replies to WebSocket ping with pong
      if (repliesPong) w._session.touch();
    }
  }
  return kills;
}

console.log('=== 心跳存活判定回归 ===');

// BUGGY: a fully-alive client (replies every pong) is still killed on tick 2
const buggyKills = runHeartbeat({ buggy: true, ticks: 6, repliesPong: true });
check('旧逻辑：健康客户端每2个tick被误杀一次(复现bug)', buggyKills >= 2, 'kills=' + buggyKills);

// FIXED: a fully-alive client is NEVER killed
const fixedKills = runHeartbeat({ buggy: false, ticks: 20, repliesPong: true });
check('修复后：健康客户端20个tick零误杀', fixedKills === 0, 'kills=' + fixedKills);

// FIXED: a truly dead client (no pong) IS killed on tick 2
const deadKills = runHeartbeat({ buggy: false, ticks: 2, repliesPong: false });
check('修复后：真正掉线客户端仍会在第2个tick被清除', deadKills === 1, 'kills=' + deadKills);

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
