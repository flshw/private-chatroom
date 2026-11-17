'use strict';
/* SEQ send-queue serialization test (v20).
 * Run: node tools/test-send-queue.js
 * Reproduces the log's REPLAY: botStep emits PLAY + FINISHED in the SAME tick.
 * Without a queue both calls read state.seq+1 before either commits -> two
 * frames with identical seq -> server E_REPLAY -> FINISHED dropped -> round
 * stuck. This test verifies every send gets a strictly increasing seq and
 * consecutive sends never overlap, even when buildMessage is slow.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('\n=== SEQ 发送队列串行化测试 ===');

// Load app.js source and extract the two queue helpers + sendKind wrappers by
// running the whole IIFE with a stubbed DOM/crypto, then exercise sendText via
// a captured sendKind. Simpler: statically assert the queue pattern is present
// AND simulate the queue logic with the same control flow.
const app = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'app.js'), 'utf8');
check('sendKind 经 enqueueSend 串行化',
  /function sendKind\(plaintext, kind\) \{\s*return enqueueSend\(/.test(app));
check('队列在失败后保持存活',
  /sendQueue = run\.catch\(function \(\) \{\}\);/.test(app));
check('真正发送体独立为 sendKindNow', app.indexOf('async function sendKindNow(plaintext, kind)') !== -1);
check('seq 仅在成功交给 socket 后提交',
  app.indexOf('state.seq = usedSeq; // commit only after a successful hand-off') !== -1);

// Behavioural simulation of the exact pattern, with an async build step whose
// duration varies to force overlap if unserialized.
(function () {
  let seq = 0;
  let sendQueue = Promise.resolve();
  const sentSeqs = [];
  let inFlight = 0, maxInFlight = 0;
  function enqueueSend(task) {
    const run = sendQueue.then(task, task);
    sendQueue = run.catch(function () {});
    return run;
  }
  function sendKindNow() {
    return new Promise((resolve) => {
      const used = seq + 1;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        sentSeqs.push(used);
        seq = used;           // commit
        inFlight--;
        resolve();
      }, used % 2 ? 5 : 1);   // jitter: without a queue, 2nd send would read old seq
    });
  }
  function sendKind() { return enqueueSend(sendKindNow); }
  // Same-tick burst like botStep's PLAY + FINISHED.
  Promise.all([sendKind(), sendKind(), sendKind(), sendKind()]).then(() => {
    const strictlyIncreasing = sentSeqs.every((s, i) => i === 0 || s === sentSeqs[i - 1] + 1);
    check('同 tick 连发四条 seq 严格递增', strictlyIncreasing, JSON.stringify(sentSeqs));
    check('并发发送数始终为 1（无重叠）', maxInFlight === 1, 'maxInFlight=' + maxInFlight);
    console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
    process.exit(fail ? 1 : 0);
  });
})();
