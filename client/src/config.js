/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom client config. */
'use strict';
/* Client bootstrap validation. Verifies the config signature with the baked
 * SSK_pub BEFORE any connection is opened. A tampered HTML fails closed. */
window.PCConfig = (function () {
  /* Verify config block signature using the baked SSK public key (forge). */
  function verify(config, sig, sskPem) {
    return PCCrypto.verifySig(config, sig, sskPem);
  }

  /* Returns Promise<{ok, config, error, offsetMs}>. Fails closed on any error. */
  async function load() {
    var config = window.__PC_CONFIG__;
    var sig = window.__PC_CONFIG_SIG__;
    if (!config || !sig) return { ok: false, error: '客户端缺少配置块，文件可能不完整' };
    if (config.v !== PCProtocol.PROTOCOL_VERSION) return { ok: false, error: '协议版本不兼容' };
    if (!/BEGIN PUBLIC KEY/.test(config.roomPubKey || '') ||
        !/BEGIN PUBLIC KEY/.test(config.serverPubKey || '')) {
      return { ok: false, error: '配置缺少公钥，已停止连接' };
    }
    var valid = false;
    try { valid = verify(config, sig, config.serverPubKey); }
    catch (e) { return { ok: false, error: '配置验签失败：' + e.message }; }
    if (!valid) return { ok: false, error: '配置签名无效，文件可能被篡改' };

    // Server time correction: never trust the local clock for expiry/ts.
    var offsetMs = 0;
    var statusUrl = config.serverUrl.replace(/\/$/, '') + PCProtocol.DEFAULTS.apiPrefix +
      '/room/' + encodeURIComponent(config.roomId) + '/status';
    try {
      var resp = await fetch(statusUrl, { cache: 'no-store' });
      var data = await resp.json();
      if (data.ok && data.serverTime) offsetMs = data.serverTime - Date.now();
      if (!data.ok || data.status === 'invalid') {
        return { ok: false, error: '房间不存在、已到期或凭证已吊销' };
      }
      if (data.expiresAt && Date.now() + offsetMs >= data.expiresAt) {
        return { ok: false, error: '房间已到期' };
      }
    } catch (e) {
      return { ok: false, error: '无法连接服务器，请检查网络后重试' };
    }
    return { ok: true, config: config, offsetMs: offsetMs };
  }

  return { load: load, verify: verify };
})();
