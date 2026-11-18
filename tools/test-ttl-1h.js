/* v27: room lifetime default 1 hour, user-selectable up to 24 hours.
 * Test rooms created during deploy use 1 hour and self-clean.
 * Run: node tools/test-ttl-1h.js */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'server', 'src', 'protocol.js'));
const { Rooms } = require(path.join(__dirname, '..', 'server', 'src', 'rooms.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('\n=== v27 生命期：默认1小时，可选到24小时 ===');
check('DEFAULT_TTL_SECONDS = 3600', P.LIMITS.DEFAULT_TTL_SECONDS === 3600, P.LIMITS.DEFAULT_TTL_SECONDS);
check('MAX_TTL_SECONDS = 86400', P.LIMITS.MAX_TTL_SECONDS === 86400, P.LIMITS.MAX_TTL_SECONDS);
check('MIN_TTL_SECONDS 仍为 60', P.LIMITS.MIN_TTL_SECONDS === 60, P.LIMITS.MIN_TTL_SECONDS);

const stubKeys = { serverSecret: () => 'test-secret' };
const rooms = new Rooms({}, stubKeys, {}, {}, {}, () => {});

function applyOk(ttl) {
  try { return rooms.validateApply({ name: '测试房', ttlSeconds: ttl }).ttlSeconds === ttl; }
  catch (e) { return false; }
}
function applyRejected(ttl) {
  try { rooms.validateApply({ name: '测试房', ttlSeconds: ttl }); return false; }
  catch (e) { return /86400|24 小时/.test(e.message); }
}

check('合法: 3600 (1h)', applyOk(3600));
check('合法: 7200 (2h)', applyOk(7200));
check('合法: 21600 (6h)', applyOk(21600));
check('合法: 28800 (8h)', applyOk(28800));
check('合法: 43200 (12h)', applyOk(43200));
check('合法: 86400 (24h)', applyOk(86400));
check('默认: 不传 ttl 用 3600', (() => {
  try { return rooms.validateApply({ name: '测试房' }).ttlSeconds === 3600; }
  catch (e) { return false; }
})());
check('拒绝: ttl=90000 超24h', applyRejected(90000));
check('拒绝: ttl=259200 超24h', applyRejected(259200));

console.log('\n=== 门户下拉：1(默认)/2/6/8/12/24 小时 ===');
const fs = require('fs');
const portal = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'index.html'), 'utf8');
const ttlSel = portal.match(/<select id="r-ttl">([\s\S]*?)<\/select>/);
check('门户存在 r-ttl 下拉', !!ttlSel);
if (ttlSel) {
  const optionVals = [...ttlSel[1].matchAll(/value="(\d+)"/g)].map(m => m[1]);
  const expected = ['3600', '7200', '21600', '28800', '43200', '86400'];
  check('六个选项齐全', JSON.stringify(optionVals) === JSON.stringify(expected), JSON.stringify(optionVals));
  check('1小时为默认选中', /value="3600"\s+selected/.test(ttlSel[1]));
  check('偏好记忆白名单含全部选项', expected.every(v => portal.indexOf("TTL_OK=[3600,7200,21600,28800,43200,86400]") !== -1));
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
