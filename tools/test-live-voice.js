'use strict';
/* Encrypted voice-clip tests (v29).
 * Run: node tools/test-live-voice.js
 * Full-duplex live voice (WebRTC) has been REMOVED. This suite now proves:
 *  1) the full-duplex implementation is genuinely gone from media.js
 *  2) voice-clip format probing picks a supported mime + duration metadata
 *  3) record -> encrypt -> send produces a proper encrypted file message
 *  4) insecure contexts block recording with a clear diagnostic
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
const flush = () => new Promise(r => setImmediate(r));
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

const MEDIA_SRC = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'media.js'), 'utf8');

function makeSandbox(opts) {
  opts = opts || {};
  const log = [];
  const sentFrames = [];
  const diag = [];
  const constraintsSeen = [];
  const micTracksStopped = [];
  const recorders = [];

  function FakeStream(kind) {
    this.getTracks = () => [{ kind: kind, stop: () => micTracksStopped.push(kind) }];
  }

  const sandbox = {
    console, Math, Date, JSON, Promise, Set, Map, Object, Array, String, Number, Error,
    TextEncoder: function () { this.encode = s => new Uint8Array(Buffer.from(s, 'utf8')); },
    TextDecoder: function () { this.decode = b => Buffer.from(b).toString('utf8'); },
    setTimeout: (fn, ms) => setTimeout(fn, 0),
    clearTimeout: id => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, 1000000),
    clearInterval: id => clearInterval(id),
    location: { href: 'https://chat.example/room' },
    isSecureContext: opts.insecure ? false : true,
    navigator: {
      mediaDevices: { getUserMedia: async (c) => {
        constraintsSeen.push(c);
        return new FakeStream('audio');
      } }
    },
    MediaStream: function (arr) { this.getTracks = () => arr; },
    Blob: function (parts, opts) {
      this.size = parts.reduce((n, p) => n + (p.size || (p.byteLength || 0) || String(p).length), 0);
      this.type = (opts && opts.type) || '';
      this.arrayBuffer = async () => new Uint8Array(Math.max(1, this.size)).buffer;
    },
    MediaRecorder: (function () {
      function R(stream, opts) {
        this.mimeType = (opts && opts.mimeType) || '';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
        recorders.push(this);
      }
      R.prototype.start = function () { this.state = 'recording'; };
      R.prototype.stop = function () { this.state = 'inactive'; if (this.onstop) this.onstop(); };
      R.isTypeSupported = m => m === 'audio/webm;codecs=opus' || m === 'audio/webm';
      return R;
    })(),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, fileId: 'f123' }) }),
    PCProtocol: {
      MSG: { RTC_SIGNAL: 'rtc_signal' },
      DEFAULTS: { apiPrefix: '/pc/api' }
    },
    PCCrypto: {
      randomBytes: n => new Uint8Array(n),
      b64: b => Buffer.from(b).toString('base64'),
      unb64: s => new Uint8Array(Buffer.from(s, 'base64')),
      aesEncrypt: (k, aad, text) => ({ iv: 'iv', ct: 'ct-' + text, tag: 'tag' }),
      aesEncryptBytes: (k, aad, bytes) => ({ iv: 'iv', ct: 'ctb', tag: 'tag' }),
      aesDecrypt: (k, aad, iv, ct, tag) => new TextEncoder().encode(String(ct).slice(3)),
      wrapKey: (k, pub) => new Uint8Array([1, 2, 3]),
      unwrapKey: (w, pem) => new Uint8Array([1, 2, 3])
    },
    PCMembers: {
      all: () => opts.members || [{ sid: 'peerB', nickname: 'B', ukPub: 'pubB' }],
      get: sid => ({ sid: sid, ukPub: 'pub-' + sid })
    },
    __log: log, __sent: sentFrames, __diag: diag, __constraints: constraintsSeen,
    __micStopped: micTracksStopped, __recorders: recorders
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MEDIA_SRC, sandbox);
  return sandbox;
}

function makeMedia(sb) {
  const ctx = {
    config: { roomId: 'r1', serverUrl: 'https://chat.example' },
    net: { send: f => sb.__sent.push(f) },
    mySid: sb.__mySid || 'meA',
    uk: { privatePem: 'PRIV' },
    members: sb.PCMembers,
    toast: () => {},
    sendKind: (text, kind) => sb.__sent.push({ type: 'sendKind', kind, text }),
    diag: (t, d) => sb.__diag.push(t + (d ? ':' + d : '')),
    onRecordState: s => sb.__log.push('REC-STATE ' + s)
  };
  return new sb.PCMedia(ctx);
}

(async () => {
  console.log('== Encrypted voice clips (full-duplex voice removed) ==');

  // 1) source-level: full-duplex implementation is genuinely gone.
  {
    check('no RTCPeerConnection', MEDIA_SRC.indexOf('RTCPeerConnection') === -1);
    check('no startVoice API', MEDIA_SRC.indexOf('startVoice') === -1);
    check('no handleSignal auto-join', MEDIA_SRC.indexOf('VOICE-AUTOJOIN') === -1);
    check('no inCall API', MEDIA_SRC.indexOf('inCall') === -1);
    check('recordVoice still present', MEDIA_SRC.indexOf('this.recordVoice') !== -1);
  }

  // 2) voice-clip format probing (via source-level assertions; MediaRecorder mock).
  {
    check('multi-codec probing present', MEDIA_SRC.indexOf('audio/webm;codecs=opus') !== -1 &&
      MEDIA_SRC.indexOf('audio/ogg;codecs=opus') !== -1 && MEDIA_SRC.indexOf('audio/mp4') !== -1);
    check('60s cap constant present', MEDIA_SRC.indexOf('MAX_VOICE_MS = 60000') !== -1);
    check('duration metadata in voice message', MEDIA_SRC.indexOf('voice: true, duration: dur') !== -1);
    check('secure-context guard present', MEDIA_SRC.indexOf('window.isSecureContext') !== -1);
    check('audio-only recorder constraint', MEDIA_SRC.indexOf('{ audio: true, video: false }') !== -1);
  }

  // 3) voice-clip record -> encrypt -> send, dynamic flow.
  {
    const sb = makeSandbox({});
    const m = makeMedia(sb);
    m.recordVoice();
    await flush(); await flush();
    check('recorder created after mic grant', sb.__recorders.length === 1);
    check('recorder uses supported opus mime', sb.__recorders[0].mimeType === 'audio/webm;codecs=opus');
    const rec = sb.__recorders[0];
    check('recording started', rec.state === 'recording');
    check('record-state feedback shown true', sb.__log.some(x => x === 'REC-STATE true'));
    rec.ondataavailable({ data: { size: 123, byteLength: 123 } });
    rec.stop();
    await flush(); await flush(); await flush();
    const clip = sb.__sent.filter(f => f.type === 'sendKind' && f.kind === 'file');
    check('voice clip sent as file message', clip.length === 1);
    if (clip.length) {
      const meta = JSON.parse(clip[0].text);
      check('voice flag set', meta.voice === true);
      check('duration metadata present', meta.duration >= 1);
      check('voice mime correct', /^audio\//.test(meta.mime));
      check('voice filename uses extension', /^voice-\d+\.webm$/.test(meta.name));
      check('encrypted key material present', !!meta.keyB64 && !!meta.iv && !!meta.fileId);
    }
    check('recording indicator cleared', sb.__log.some(x => x === 'REC-STATE false'));
  }

  // 4) insecure context blocks recording with a clear diagnostic.
  {
    const sb = makeSandbox({ insecure: true });
    const m = makeMedia(sb);
    m.recordVoice();
    await flush();
    check('insecure context blocks recording', sb.__recorders.length === 0);
    check('insecure context diagnostic emitted', sb.__diag.some(x => x.indexOf('VOICE-INSECURE') === 0));
  }

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
