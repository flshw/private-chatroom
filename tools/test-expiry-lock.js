/* v28: expiry-lock regression — room destroyed while cards on the table must
 * lock every game control and reject taps with a clear message, never reach a
 * closed socket (which caused "连接未就绪，消息未发送" SEND-REJECT). */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, note) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (note ? ' | ' + note : '')); }
}

const app = read('client/src/app.js');
const deluxe = read('client/src/deluxe.js');
const tplLite = read('client/dist/private-chat.template.html');
const tplDeluxe = read('client/dist/private-chat-deluxe.template.html');

console.log('=== v28 到期锁定回归 ===');
check('app.handleExpiry 调用 PCDeluxe.setExpired', /handleExpiry[\s\S]{0,600}PCDeluxe\.setExpired\(\)/.test(app));
check('app.handleExpiry 禁用 btn-game', /handleExpiry[\s\S]{0,800}btn-game'\); if \(gp\) gp\.disabled = true/.test(app));
check('deluxe 定义 expiredUI 标志', /var expiredUI = false/.test(deluxe));
check('deluxe setExpired 锁定按钮集合', /function setExpired\(\)[\s\S]{0,400}btn-game-play/.test(deluxe));
check('setExpired 导出到 API', /setExpired: setExpired/.test(deluxe));
check('toggleGame 到期守卫', /function toggleGame\(\)[\s\S]{0,120}if \(expiredUI\)/.test(deluxe));
check('onPlayClick 到期守卫', /function onPlayClick\(\)[\s\S]{0,120}if \(expiredUI\)/.test(deluxe));
check('onPassClick 到期守卫', /function onPassClick\(\)[\s\S]{0,120}if \(expiredUI\)/.test(deluxe));
check('onStartClick 到期守卫', /function onStartClick\(\)[\s\S]{0,120}if \(expiredUI\)/.test(deluxe));
check('lite 模板不含 deluxe setExpired（无误注入）', !/function setExpired\(\)/.test(tplLite));
check('deluxe 模板含 setExpired', /function setExpired\(\)/.test(tplDeluxe));
check('deluxe 模板含 app 接入', /PCDeluxe\.setExpired\) window\.PCDeluxe\.setExpired\(\)/.test(tplDeluxe));

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
if (fail) process.exit(1);
