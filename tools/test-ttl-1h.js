/* v26: room lifetime is capped at 1 hour so test rooms self-clean.
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

console.log('\n=== v26 生命期 1 小时上限 ===');
check('DEFAULT_TTL_SECONDS = 3600', P.LIMITS.DEFAULT_TTL_SECONDS === 3600, P.LIMITS.DEFAULT_TTL_SECONDS);
check('MAX_TTL_SECONDS = 3600', P.LIMITS.MAX_TTL_SECONDS === 3600, P.LIMITS.MAX_TTL_SECONDS);
check('MIN_TTL_SECONDS 仍为 60', P.LIMITS.MIN_TTL_SECONDS === 60, P.LIMITS.MIN_TTL_SECONDS);

// validateApply in isolation: stub keyStore so constructor works.
const stubKeys = { serverSecret: () => 'test-secret' };
const rooms = new Rooms({}, stubKeys, {}, {}, {}, () => {});

check('合法: ttl=3600 通过', (() => {
  try { return rooms.validateApply({ name: '测试房', ttlSeconds: 3600 }).ttlSeconds === 3600; }
  catch (e) { return false; }
})());
check('合法: ttl=1800 通过', (() => {
  try { return rooms.validateApply({ name: '测试房', ttlSeconds: 1800 }).ttlSeconds === 1800; }
  catch (e) { return false; }
})());
check('默认: 不传 ttl 用 3600', (() => {
  try { return rooms.validateApply({ name: '测试房' }).ttlSeconds === 3600; }
  catch (e) { return false; }
})());
check('拒绝: ttl=7200 超上限', (() => {
  try { rooms.validateApply({ name: '测试房', ttlSeconds: 7200 }); return false; }
  catch (e) { return /3600|1 小时/.test(e.message); }
})());
check('拒绝: 旧的 48h=172800 超上限', (() => {
  try { rooms.validateApply({ name: '测试房', ttlSeconds: 172800 }); return false; }
  catch (e) { return /3600|1 小时/.test(e.message); }
})());
check('拒绝: 旧的 72h=259200 超上限', (() => {
  try { rooms.validateApply({ name: '测试房', ttlSeconds: 259200 }); return false; }
  catch (e) { return /3600|1 小时/.test(e.message); }
})());

console.log('\n=== 门户下拉仅 1 小时 ===');
const fs = require('fs');
const portal = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'index.html'), 'utf8');
const ttlSel = portal.match(/<select id="r-ttl">([\s\S]*?)<\/select>/);
check('门户存在 r-ttl 下拉', !!ttlSel);
if (ttlSel) {
  const optionVals = [...ttlSel[1].matchAll(/value="(\d+)"/g)].map(m => m[1]);
  check('仅一个选项', optionVals.length === 1, JSON.stringify(optionVals));
  check('唯一选项为 3600', optionVals[0] === '3600', optionVals[0]);
  check('无长生命期选项(28800/86400等)', !/value="(28800|43200|86400|172800|259200)"/.test(ttlSel[1]));
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
