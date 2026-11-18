/* Tests for admin-auth: first-run password from env, change, key login,
 * sessions, throttling, hash-only-at-rest. Uses a temp DATA_DIR. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-admin-auth-'));
process.env.PC_DATA_DIR = tmp;
process.env.PC_ADMIN_INITIAL_PASSWORD = 'InitialPassw0rd!';

// Force paths.js to re-read env
for (const k of Object.keys(require.cache)) if (k.includes('paths.js')) delete require.cache[k];
const { AdminAuth, AUTH_FILE } = require(path.resolve(__dirname, '..', 'server', 'src', 'admin-auth.js'));

let pass = 0, fail = 0;
function check(name, cond, note) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (note ? ' | ' + note : '')); }
}

console.log('=== admin-auth 测试 ===');
const a = new AdminAuth(() => {}).init();
check('初始状态 mustChange=true', a.status().mustChange === true);
check('初始无密钥', a.hasKey() === false);
check('凭证文件已创建', fs.existsSync(AUTH_FILE));

const raw = fs.readFileSync(AUTH_FILE, 'utf8');
check('磁盘只存 hash/salt 不存明文口令', !raw.includes('InitialPassw0rd!') && /"hash"/.test(raw) && /"salt"/.test(raw));

check('错误口令被拒', (() => { try { a.loginPassword('1.1.1.1', 'wrong'); return false; } catch (e) { return e.status === 401; } })());
const s1 = a.loginPassword('1.1.1.1', 'InitialPassw0rd!');
check('正确口令登录成功', !!s1.sid && a.session(s1.sid) !== null);
check('mustChange 状态下仍可操作（由 API 层拦截）', a.status().mustChange === true);

check('弱口令被拒', (() => { try { a.changePassword('InitialPassw0rd!', 'short'); return false; } catch (e) { return e.status === 400; } })());
check('错误旧口令被拒', (() => { try { a.changePassword('wrong', 'NewStrongPassw0rd!'); return false; } catch (e) { return e.status === 401; } })());
a.changePassword('InitialPassw0rd!', 'NewStrongPassw0rd!');
check('修改口令后 mustChange=false', a.status().mustChange === false);
check('旧口令失效', (() => { try { a.loginPassword('2.2.2.2', 'InitialPassw0rd!'); return false; } catch (e) { return e.status === 401; } })());
const s2 = a.loginPassword('2.2.2.2', 'NewStrongPassw0rd!');
check('新口令登录成功', !!s2.sid);

const key = a.createKey();
check('密钥格式正确', /^pcadm_[A-Za-z0-9_-]+$/.test(key));
check('hasKey=true', a.hasKey() === true);
const keyRaw = fs.readFileSync(AUTH_FILE, 'utf8');
check('磁盘不存密钥明文', !keyRaw.includes(key) && /"keyHash"/.test(keyRaw));
const s3 = a.loginKey('3.3.3.3', key);
check('密钥登录成功', !!s3.sid && a.session(s3.sid) !== null);
check('错误密钥被拒', (() => { try { a.loginKey('4.4.4.4', 'pcadm_bad'); return false; } catch (e) { return e.status === 401; } })());
const key2 = a.createKey();
check('重新生成密钥后旧密钥失效', (() => { try { a.loginKey('5.5.5.5', key); return false; } catch (e) { return e.status === 401; } })());
check('新密钥可用', !!a.loginKey('5.5.5.5', key2).sid);

a.logout(s1.sid);
check('logout 使会话失效', a.session(s1.sid) === null);

// throttle
for (let i = 0; i < 5; i++) { try { a.loginPassword('9.9.9.9', 'bad'); } catch (e) {} }
check('连续失败触发限流', (() => { try { a.loginPassword('9.9.9.9', 'bad'); return false; } catch (e) { return e.status === 429; } })());

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
a.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
if (fail) process.exit(1);
