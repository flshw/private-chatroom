/*
 * Share-QR flow test. Boots an isolated server instance on a temp data dir,
 * exercises: apply -> share links -> QR resolves inline HTML -> both editions
 * share ONE joinToken -> reissue rotates codes (old fail) -> destroy fails all.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const nodeCrypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 500);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-shares-'));
let pass = 0, fail = 0;
function check(n, ok, x) { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); } }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function api(p, opts) { const r = await fetch(BASE + '/pc/api' + p, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; }

function cfgOf(html) {
  const m = html.match(/window\.__PC_CONFIG__=(\{[\s\S]*?\});window\.__PC_CONFIG_SIG__="([^"]+)"/);
  return m ? { cfg: JSON.parse(m[1]), sig: m[2] } : null;
}

(async () => {
  const env = Object.assign({}, process.env, {
    PC_PORT: String(PORT), PC_HOST: '127.0.0.1', PC_DATA_DIR: TMP,
    PC_TLS_CERT: '', PC_TLS_KEY: ''
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
    check('隔离实例启动', up, up ? '' : serverLog.slice(-400));
    if (!up) throw new Error('server did not start');

    const uname = 'share_' + Date.now().toString(36);
    const cookieJar = { cookie: '' };
    const reg = await api('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: 'pw-123456' }) });
    check('注册', reg.status === 200 && reg.body.ok);
    const login = await fetch(BASE + '/pc/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: 'pw-123456' }) });
    cookieJar.cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('登录', /pc_sid=/.test(cookieJar.cookie));

    const roomName = '分享测试房_' + Date.now().toString(36);
    const apply = await fetch(BASE + '/pc/api/rooms/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieJar.cookie },
      body: JSON.stringify({ name: roomName, ttlSeconds: 3600, maxMembers: 6, edition: 'deluxe' })
    });
    const html = await apply.text();
    const cfg = cfgOf(html);
    check('申请签发豪华版 HTML', apply.status === 200 && !!cfg && cfg.cfg.edition === 'deluxe');
    const roomId = cfg.cfg.roomId;

    const links = await api('/rooms/' + roomId + '/shares', { headers: { Cookie: cookieJar.cookie } });
    check('房主可查询两版分享链接', links.status === 200 && links.body.ok && !!links.body.lite && !!links.body.deluxe,
      JSON.stringify(links.body).slice(0, 200));
    const litePath = links.body.lite, deluxePath = links.body.deluxe;

    const liteRes = await fetch(BASE + litePath);
    const liteHtml = await liteRes.text();
    check('扫码 lite 返回内联 HTML（非下载）', liteRes.status === 200 && /text\/html/.test(liteRes.headers.get('content-type') || '') &&
      !/attachment/.test(liteRes.headers.get('content-disposition') || '') && liteHtml.indexOf('/*__PC_CONFIG__*/') === -1);
    const deluxeRes = await fetch(BASE + deluxePath);
    const deluxeHtml = await deluxeRes.text();
    check('扫码 deluxe 返回内联 HTML', deluxeRes.status === 200 && deluxeHtml.indexOf('/*__PC_CONFIG__*/') === -1);
    const liteCfg = cfgOf(liteHtml), deluxeCfg = cfgOf(deluxeHtml);
    check('两版 edition 正确', !!liteCfg && !!deluxeCfg && liteCfg.cfg.edition === 'lite' && deluxeCfg.cfg.edition === 'deluxe');
    check('两版共享同一 joinToken 与 roomPubKey',
      liteCfg.cfg.joinToken === deluxeCfg.cfg.joinToken && liteCfg.cfg.joinToken === cfg.cfg.joinToken &&
      liteCfg.cfg.roomPubKey === deluxeCfg.cfg.roomPubKey);

    const badRes = await fetch(BASE + '/Pchat/s/not_a_real_code');
    check('无效分享码返回 404', badRes.status === 404);

    // reissue rotates codes
    const reissue = await fetch(BASE + '/pc/api/rooms/' + roomId + '/client?edition=lite', { headers: { Cookie: cookieJar.cookie } });
    await reissue.text();
    check('重签成功', reissue.status === 200);
    const oldLite = await fetch(BASE + litePath);
    check('重签后旧二维码失效', oldLite.status === 404, 'status=' + oldLite.status);
    const links2 = await api('/rooms/' + roomId + '/shares', { headers: { Cookie: cookieJar.cookie } });
    check('重签后生成新链接', links2.body.lite && links2.body.lite !== litePath);
    const newLite = await fetch(BASE + links2.body.lite);
    check('新二维码可用', newLite.status === 200);

    // destroy invalidates all
    const dis = await api('/rooms/' + roomId + '/dissolve', { method: 'POST', headers: { Cookie: cookieJar.cookie } });
    check('销毁房间', dis.status === 200 && dis.body.ok);
    const afterDestroy = await fetch(BASE + links2.body.lite);
    check('销毁后二维码失效', afterDestroy.status === 404);

    const sharesDir = path.join(TMP, 'shares');
    check('销毁后 HTML 缓存被清理', fs.existsSync(sharesDir) && fs.readdirSync(sharesDir).length === 0,
      fs.existsSync(sharesDir) ? fs.readdirSync(sharesDir).join(',') : 'no dir');
  } catch (e) {
    fail++; console.log('  ERROR  ' + (e.stack || e.message));
  } finally {
    child.kill('SIGTERM');
    await wait(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  }
})();
