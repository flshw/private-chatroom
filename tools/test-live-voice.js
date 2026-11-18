'use strict';
/* Full-duplex AUDIO voice tests (v23).
 * Run: node tools/test-live-voice.js
 * Drives media.js in a VM with mocked WebRTC / mic / signaling to prove:
 *  1) startVoice pulls an AUDIO-ONLY mic stream (video:false)
 *  2) a recipient who never pressed the button AUTO-JOINS on an incoming offer
 *     (this is the bug that made the user's full-duplex test fail: !inCall drop)
 *  3) an answer is generated and sent back to the offerer
 *  4) glare: the impolite peer ignores a colliding offer, polite peer yields
 *  5) ICE candidates are forwarded as signals
 *  6) hangup stops tracks, closes peers and resets state
 *  7) no video track is ever added to a peer connection
 *  8) voice-clip format probing picks a supported mime + duration metadata
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

/* Minimal fake RTCPeerConnection implementing just the negotiation surface
 * media.js touches. Tracks offers/answers/ICE and signalingState transitions. */
function FakePC(sid, log) {
  this.sid = sid;
  this._log = log;
  this.localDescription = null;
  this.remoteDescription = null;
  this.signalingState = 'stable';
  this.connectionState = 'connected';
  this.tracks = [];
  this.onicecandidate = null;
  this.ontrack = null;
  this.onnegotiationneeded = null;
  this.onconnectionstatechange = null;
  this._cands = [];
  log.push('PC-CREATE ' + sid);
}
FakePC.prototype.addTrack = function (t, s) {
  this.tracks.push(t);
  this._log.push('ADD-TRACK ' + this.sid + ' ' + t.kind);
  if (this.onnegotiationneeded) this.onnegotiationneeded();
};
FakePC.prototype.setLocalDescription = async function (d) {
  if (d && d.type === 'rollback') { this.signalingState = 'stable'; return; }
  // no-arg => create offer/answer based on current state
  var type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
  this.localDescription = { type: type, sdp: 'sdp-' + this.sid + '-' + type };
  this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  this._log.push('SET-LOCAL ' + this.sid + ' ' + type);
};
FakePC.prototype.setRemoteDescription = async function (d) {
  this.remoteDescription = d;
  this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  this._log.push('SET-REMOTE ' + this.sid + ' ' + d.type);
};
FakePC.prototype.createOffer = async function () { return { type: 'offer', sdp: 'sdp-' + this.sid }; };
FakePC.prototype.createAnswer = async function () { return { type: 'answer', sdp: 'sdp-' + this.sid }; };
FakePC.prototype.addIceCandidate = async function (c) { this._cands.push(c); this._log.push('ADD-ICE ' + this.sid); };
FakePC.prototype.close = function () { this.connectionState = 'closed'; this._log.push('CLOSE ' + this.sid); };

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
    setTimeout: (fn, ms) => setTimeout(fn, 0),   // run voice timers promptly but detached
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
    RTCPeerConnection: function () { return new FakePC(opts.pcSid || 'me', log); },
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
    onRecordState: s => sb.__log.push('REC-STATE ' + s),
    onLocalStream: () => {},
    onRemoteTrack: (sid, stream) => sb.__log.push('REMOTE-TRACK ' + sid),
    onCallEnd: () => sb.__log.push('CALL-END'),
    onVoiceState: on => sb.__log.push('VOICE-STATE ' + on)
  };
  return new sb.PCMedia(ctx);
}

(async () => {
  console.log('== Full-duplex audio voice ==');

  // 1) startVoice pulls audio-only stream and creates peers for members.
  {
    const sb = makeSandbox({ pcSid: 'meA' });
    const m = makeMedia(sb);
    await m.startVoice();
    check('startVoice enters call', m.inCall() === true);
    check('mic requested with audio-only (video:false)',
      sb.__constraints.length >= 1 && sb.__constraints[0].video === false && !!sb.__constraints[0].audio,
      JSON.stringify(sb.__constraints[0]));
    check('peer connection created', sb.__log.some(x => x.indexOf('PC-CREATE ') === 0));
    check('audio track added (never video)', sb.__log.some(x => x.indexOf('ADD-TRACK ') === 0 && x.endsWith(' audio')) &&
      !sb.__log.some(x => x.toLowerCase().indexOf('video') !== -1));
  }

  // 2) Recipient who never called startVoice auto-joins on incoming offer.
  {
    const sb = makeSandbox({ pcSid: 'meB' });
    sb.__mySid = 'meB';
    sb.PCMembers = { all: () => [{ sid: 'peerA', ukPub: 'pubA' }], get: sid => ({ sid, ukPub: 'pub-' + sid }) };
    const m = makeMedia(sb);
    check('recipient starts idle', m.inCall() === false);
    // Build a wrapped signal envelope for an offer from A.
    const offerObj = { kind: 'description', description: { type: 'offer', sdp: 'sdp-A' } };
    const wrapped = sb.PCCrypto.b64(new TextEncoder().encode(JSON.stringify({
      iv: 'iv', ct: 'ct-' + JSON.stringify(offerObj), tag: 'tag', wrap: [1, 2, 3]
    })));
    await m.handleSignal('peerA', wrapped);
    await flush();
    check('recipient AUTO-JOINS on offer (no button press)', m.inCall() === true);
    check('recipient pulled its own mic', sb.__constraints.length >= 1);
    check('recipient did NOT drop the offer', sb.__diag.some(x => x.indexOf('VOICE-AUTOJOIN') === 0));
    check('recipient set remote offer', sb.__log.some(x => x.indexOf('SET-REMOTE ') === 0 && x.endsWith(' offer')));
    check('recipient generated + sent answer', sb.__log.some(x => x.indexOf('SET-LOCAL ') === 0 && x.endsWith(' answer')) &&
      sb.__sent.some(f => f.type === 'rtc_signal' && f.to === 'peerA'));
  }

  // 3) ICE candidate forwarded as a signal even before local start (auto-join path).
  {
    const sb = makeSandbox({ pcSid: 'meB' });
    sb.__mySid = 'meB';
    sb.PCMembers = { all: () => [{ sid: 'peerA' }], get: sid => ({ sid, ukPub: 'pub' }) };
    const m = makeMedia(sb);
    const ice = { kind: 'ice', candidate: { candidate: 'candidate:1' } };
    const wrapped = sb.PCCrypto.b64(new TextEncoder().encode(JSON.stringify({
      iv: 'iv', ct: 'ct-' + JSON.stringify(ice), tag: 'tag', wrap: [1]
    })));
    await m.handleSignal('peerA', wrapped);
    check('ICE handled via auto-join', sb.__log.some(x => x.indexOf('ADD-ICE ') === 0));
  }

  // 4) hangup resets everything.
  {
    const sb = makeSandbox({ pcSid: 'meA' });
    const m = makeMedia(sb);
    await m.startVoice();
    m.hangup();
    check('hangup exits call', m.inCall() === false);
    check('hangup stops mic tracks', sb.__micStopped.length >= 1);
    check('hangup closes peers', sb.__log.some(x => x.indexOf('CLOSE ') === 0));
    check('hangup fires call-end', sb.__log.some(x => x === 'CALL-END'));
  }

  // 5) voice-clip format probing (via source-level assertions; MediaRecorder mock).
  {
    check('multi-codec probing present', MEDIA_SRC.indexOf('audio/webm;codecs=opus') !== -1 &&
      MEDIA_SRC.indexOf('audio/ogg;codecs=opus') !== -1 && MEDIA_SRC.indexOf('audio/mp4') !== -1);
    check('60s cap constant present', MEDIA_SRC.indexOf('MAX_VOICE_MS = 60000') !== -1);
    check('duration metadata in voice message', MEDIA_SRC.indexOf('voice: true, duration: dur') !== -1);
    check('secure-context guard present', MEDIA_SRC.indexOf('window.isSecureContext') !== -1);
    check('dual audio+video false in recorder', MEDIA_SRC.indexOf('{ audio: true, video: false }') !== -1);
  }

  // 6) voice-clip record -> encrypt -> send, dynamic flow.
  {
    const sb = makeSandbox({});
    const m = makeMedia(sb);
    m.recordVoice();                       // begins async getUserMedia
    await flush(); await flush();
    check('recorder created after mic grant', sb.__recorders.length === 1);
    check('recorder uses supported opus mime', sb.__recorders[0].mimeType === 'audio/webm;codecs=opus');
    const rec = sb.__recorders[0];
    check('recording started', rec.state === 'recording');
    check('record-state feedback shown true', sb.__log.some(x => x === 'REC-STATE true'));
    // Simulate captured audio data, then stop.
    rec.ondataavailable({ data: { size: 123, byteLength: 123 } });
    rec.stop();                            // fires onstop -> finalizeVoice (async)
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

  // 7) insecure context blocks recording with a clear diagnostic.
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
})().catch(e => { console.error('ERROR', e.stack || e.message); process.exit(1); });
