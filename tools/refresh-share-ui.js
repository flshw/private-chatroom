/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/*
 * refresh-share-ui.js — upgrade the UI shell of already-cached share links
 * WITHOUT reissuing rooms.
 *
 * Background
 * ----------
 * A share link (/Pchat/s/<code>) serves a signed client HTML that was baked at
 * room-creation time and cached under data/shares/<sha256(code)>.html. When the
 * client templates are rebuilt (new look, bug fix, layout change), already
 * issued rooms keep serving the OLD cached HTML — reissuing a room would rotate
 * joinToken + room key pair and INVALIDATE existing share codes, which is
 * disruptive.
 *
 * The config block (window.__PC_CONFIG__ + __PC_CONFIG_SIG__) is signed by SSK
 * and that signature covers ONLY the config object — never the surrounding UI
 * shell. Therefore we can safely transplant the exact signed config block from
 * the cached HTML into the freshly built template, then atomically replace the
 * cache. The share code, roomId, joinToken, room key, expiry and signature are
 * all preserved byte-for-byte; only HTML/CSS/JS presentation changes.
 *
 * Usage (on the server, as the service user or root):
 *   node tools/refresh-share-ui.js            # dry run: validate, print plan
 *   node tools/refresh-share-ui.js --apply     # back up + atomically rewrite
 *
 * Paths default to the project's server data/template dirs; override with
 *   --shares-dir=<dir> --template-dir=<dir>
 * (useful when running with PC_DATA_DIR in /var/lib/private-chatroom).
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const hit = argv.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : def;
};
const APPLY = argv.indexOf('--apply') !== -1;
const ROOT = path.resolve(__dirname, '..');
const paths = require(path.join(ROOT, 'server', 'src', 'paths'));

const SHARES_DIR = arg('shares-dir', paths.SHARES_DIR);
const TPL_DIR = arg('template-dir', path.join(ROOT, 'client', 'dist'));
const LITE_TPL = path.join(TPL_DIR, 'private-chat.template.html');
const DELUXE_TPL = path.join(TPL_DIR, 'private-chat-deluxe.template.html');
const PH = '/*__PC_CONFIG__*/';

function extractInject(html) {
  const i = html.indexOf('window.__PC_CONFIG__=');
  if (i < 0) return null;
  const nl = html.indexOf('\n', i);
  return html.slice(i, nl < 0 ? html.length : nl);
}
function field(html, re) { const m = html.match(re); return m ? m[1] : null; }

function rebuildOne(file) {
  const old = fs.readFileSync(file, 'utf8');
  const edition = field(old, /"edition":"(deluxe|lite)"/);
  const inject = extractInject(old);
  if (!edition || !inject) return { ok: false, reason: 'no edition/inject block' };
  const tplFile = edition === 'deluxe' ? DELUXE_TPL : LITE_TPL;
  if (!fs.existsSync(tplFile)) return { ok: false, reason: 'template missing: ' + tplFile };
  const tpl = fs.readFileSync(tplFile, 'utf8');
  if (tpl.indexOf(PH) < 0) return { ok: false, reason: 'template missing placeholder' };
  const out = tpl.replace(PH, () => inject);

  const checks = {
    injectPreserved: extractInject(out) === inject,
    exactNewTpl: out === tpl.replace(PH, () => inject),
    noVoiceLive: out.indexOf('btn-voice-live') === -1 && out.indexOf('toggleVoice') === -1,
    roomKept: field(old, /"roomId":"([^"]+)"/) === field(out, /"roomId":"([^"]+)"/),
    tokenKept: field(old, /"joinToken":"([^"]+)"/) === field(out, /"joinToken":"([^"]+)"/),
    sigKept: field(old, /"__PC_CONFIG_SIG__="([^"]+)"/) === field(out, /"__PC_CONFIG_SIG__="([^"]+)"/)
  };
  if (edition === 'deluxe') {
    checks.seatTop = out.indexOf('seat-pos-top') !== -1;
    checks.myInfo = out.indexOf('id="my-info-bar"') !== -1;
    checks.play8em = out.indexOf('#btn-game-play{flex:0 0 8em') !== -1;
    checks.gap2em = out.indexOf('.game-bottom{display:flex;gap:2em') !== -1;
  }
  const ok = Object.keys(checks).every(k => checks[k] === true);
  return { ok, edition, checks, oldLen: old.length, newLen: out.length, out, file };
}

(function main() {
  if (!fs.existsSync(SHARES_DIR)) {
    console.error('shares dir not found: ' + SHARES_DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(SHARES_DIR)
    .filter(f => f.endsWith('.html') && f.indexOf('.bak') === -1)
    .map(f => path.join(SHARES_DIR, f));
  if (!files.length) { console.log('no cached share HTML found in ' + SHARES_DIR); return; }

  let changed = 0, errors = 0;
  for (const file of files) {
    const r = rebuildOne(file);
    const name = path.basename(file);
    if (!r.ok) { console.log('FAIL ' + name + ' ' + (r.reason || JSON.stringify(r.checks))); errors++; continue; }
    console.log((r.checks.exactNewTpl && Object.values(r.checks).every(Boolean) ? 'OK  ' : 'FAIL') +
      ' ' + name + ' [' + r.edition + '] ' + r.oldLen + '->' + r.newLen + ' ' + JSON.stringify(r.checks));
    if (APPLY) {
      const bak = file + '.bak-ui-' + Date.now();
      fs.copyFileSync(file, bak);
      // Preserve the original owner/mode: the service runs as an unprivileged
      // user (e.g. chatroom). Running this tool as root with a fresh temp file
      // would otherwise leave root-owned caches the service cannot read.
      const st = fs.statSync(file);
      const tmp = file + '.new-' + process.pid;
      fs.writeFileSync(tmp, r.out, { mode: st.mode & 0o777 });
      try { fs.chownSync(tmp, st.uid, st.gid); }
      catch (e) { /* not root: temp inherits our uid, same as original owner */ }
      fs.renameSync(tmp, file); // atomic replace; shares.resolve reads whole file
      changed++;
      console.log('  -> WRITTEN uid=' + st.uid + ' gid=' + st.gid + ' (backup ' + path.basename(bak) + ')');
    }
  }
  console.log('RESULT scanned=' + files.length + ' changed=' + changed + ' errors=' + errors + ' apply=' + APPLY);
  if (errors) process.exitCode = 2;
})();
