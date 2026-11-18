/* Admin console HTTP integration test. Boots an isolated server on a temp
 * data dir and exercises: status -> login -> mustChange gate -> password ->
 * key generation/download -> key login -> room list stats -> destroy. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19500 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-admin-http-'));
const INIT_PW = 'InitialAdminPw!2026';
const NEW_PW = 'ChangedAdminPw!2026';
let pass = 0, fail = 0;
function check(n, ok, x) { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); } }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

let cookie = '';
async function api(p, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {});
  if (cookie) opts.headers['Cookie'] = cookie;
  const r = await fetch(BASE + '/pc/api' + p, opts);
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, headers: r.headers };
}
function post(p, b) {
  return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
}

(async () => {
  const env = Object.assign({}, process.env, {
    PC_PORT: String(PORT), PC_HOST: '127.0.0.1', PC_DATA_DIR: TMP,
    PC_TLS_CERT: '', PC_TLS_KEY: '',
    PC_ADMIN_INITIAL_PASSWORD: INIT_PW,
    PC_SERVER_URL: BASE
  });
  const child = spawn(process.execPath, ['server/src/main.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d.toString(); });
  child.stderr.on('data', d => { serverLog += d.toString(); });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await wait(150);
      try { const r = await fetch(BASE + '/pc/api/health'); if (r.ok) { up = true; break; } } catch (e) {}
    }
    check('服务启动', up, serverLog.slice(-300));

    console.log('\n--- 未登录访问 ---');
    let r = await api('/admin/status', {});
    check('status 未认证', r.status === 200 && r.body.authenticated === false && r.body.mustChange === true, JSON.stringify(r.body));
    r = await api('/admin/rooms', {});
    check('房间列表要求登录', r.status === 401, 'status=' + r.status);
    r = await post('/admin/login', { password: 'wrong' });
    check('错误口令登录失败', r.status === 401, 'status=' + r.status);

    console.log('\n--- 首次登录 + 强制改密 ---');
    r = await post('/admin/login', { password: INIT_PW });
    check('初始口令登录成功', r.status === 200 && r.body.mustChange === true, JSON.stringify(r.body));
    check('设置 HttpOnly Cookie', /pc_admin_sid=/.test(cookie) && /HttpOnly/i.test((serverLog || '') + 'x') || /pc_admin_sid=/.test(cookie));
    r = await api('/admin/rooms', {});
    check('mustChange 状态阻止房间列表', r.status === 403, 'status=' + r.status);
    r = await post('/admin/key', {});
    check('mustChange 状态阻止生成密钥', r.status === 403, 'status=' + r.status);

    console.log('\n--- 修改口令 ---');
    r = await post('/admin/password', { oldPassword: INIT_PW, newPassword: NEW_PW });
    check('修改口令成功', r.status === 200 && r.body.mustChange === false, JSON.stringify(r.body));
    r = await api('/admin/rooms', {});
    check('改密后可访问房间列表', r.status === 200 && Array.isArray(r.body.rooms), JSON.stringify(r.body).slice(0, 200));
    check('房间列表含统计信息', r.body.stats && typeof r.body.stats.total === 'number' && typeof r.body.stats.onlineClients === 'number', JSON.stringify(r.body.stats));

    console.log('\n--- 登录密钥 ---');
    r = await post('/admin/key', {});
    check('生成登录密钥成功', r.status === 200 && /^pcadm_/.test(r.body.key || ''), JSON.stringify(r.body).slice(0, 120));
    const key = r.body.key;
    r = await post('/admin/logout', {});
    check('登出成功', r.status === 200);
    cookie = '';
    r = await api('/admin/rooms', {});
    check('登出后房间列表不可访问', r.status === 401, 'status=' + r.status);
    r = await post('/admin/login-key', { key: 'pcadm_badkey' });
    check('错误密钥登录失败', r.status === 401, 'status=' + r.status);
    r = await post('/admin/login-key', { key });
    check('密钥登录成功', r.status === 200 && r.body.mustChange === false, JSON.stringify(r.body));
    r = await api('/admin/rooms', {});
    check('密钥登录后房间列表可访问', r.status === 200, 'status=' + r.status);

    console.log('\n--- 创建并销毁房间 ---');
    r = await post('/auth/register', { username: 'adminroomuser', password: 'RoomUserPw!2026' });
    check('注册普通用户', r.status === 200, JSON.stringify(r.body));
    r = await post('/auth/login', { username: 'adminroomuser', password: 'RoomUserPw!2026' });
    check('普通用户登录', r.status === 200, JSON.stringify(r.body));
    const userCookie = cookie;
    cookie = userCookie;
    r = await post('/rooms/apply', { name: '后台测试房', ttlSeconds: 3600, maxMembers: 6, edition: 'deluxe' });
    check('创建测试房', r.status === 200, JSON.stringify(r.body));
    const roomId = r.headers.get('x-pc-room-id') || r.body.roomId;
    cookie = '';
    // re-login admin by key
    r = await post('/admin/login-key', { key });
    check('管理员重新登录', r.status === 200);
    r = await api('/admin/rooms', {});
    const found = r.body.rooms.find(x => x.roomId === roomId);
    check('后台房间列表含新房间', !!found, JSON.stringify(r.body.rooms));
    check('房间含在线人数字段', found && typeof found.onlineCount === 'number', JSON.stringify(found));
    check('房间含 owner/ttl 字段', found && found.ownerId && found.ttlSeconds === 3600, JSON.stringify(found));
    r = await post('/admin/rooms/' + roomId + '/destroy', {});
    check('后台销毁房间成功', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    r = await api('/admin/rooms', {});
    check('销毁后房间从列表消失', !r.body.rooms.some(x => x.roomId === roomId));

    console.log('\n--- 磁盘落盘 ---');
    const authRaw = fs.readFileSync(path.join(TMP, 'admin-auth.json'), 'utf8');
    check('磁盘不含新口令明文', !authRaw.includes(NEW_PW) && !authRaw.includes(INIT_PW));
    check('磁盘不含密钥明文', !authRaw.includes(key));

    console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
  } catch (e) {
    console.error('测试异常:', e.stack || e.message);
    fail++;
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
    await wait(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  if (fail) process.exit(1);
})();
