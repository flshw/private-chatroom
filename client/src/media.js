/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom media. */
'use strict';
/*
 * Media helpers: full-duplex AUDIO-ONLY live voice over WebRTC mesh, plus
 * encrypted voice-clip recording and file transfer.
 *
 * - Live voice: every member runs an RTCPeerConnection mesh. Signaling is
 *   wrapped per target member with that member's UK public key, so the server
 *   only ever relays ciphertext. A member who receives an offer AUTO-JOINS the
 *   call (pulls a local mic stream) instead of dropping it — this is what makes
 *   "full duplex" actually work when the other side never pressed a button.
 *   Perfect-negotiation glare handling prevents simultaneous-offer deadlock.
 * - Voice clips / files: bytes are encrypted client-side with a fresh K_file
 *   and that key is delivered as a normal E2EE message, so the server only
 *   stores ciphertext.
 *
 * There is intentionally NO video anywhere in this build.
 */
window.PCMedia = function (ctx) {
  var self = this;
  var config = ctx.config;
  var net = ctx.net;
  var apiBase = config.serverUrl.replace(/\/$/, '') + PCProtocol.DEFAULTS.apiPrefix;

  var mediaRecorder = null, chunks = [];
  var pcs = {};            // sid -> RTCPeerConnection
  var makingOffer = {};    // sid -> boolean, perfect-negotiation glare guard
  var localStream = null;
  var voiceOn = false;

  var MAX_VOICE_MS = 60000;
  var MAX_VOICE_BYTES = 8 * 1024 * 1024;

  function api(path, opts) {
    return fetch(apiBase + path, opts).then(function (r) { return r.json(); });
  }
  function pushDiag(tag, detail) {
    if (ctx && typeof ctx.diag === 'function') ctx.diag(tag, detail);
  }

  /* Encrypt bytes and upload the ciphertext blob; returns key material. */
  async function encryptAndUpload(bytes) {
    var K = PCCrypto.randomBytes(32);
    var aad = 'file|' + config.roomId + '|' + Date.now();
    var enc = await PCCrypto.aesEncryptBytes(K, aad, bytes);
    var payload = {
      roomId: config.roomId, sid: ctx.mySid,
      iv: enc.iv, ct: enc.ct, tag: enc.tag
    };
    var res = await api('/file/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(res.error || '上传失败');
    return { fileId: res.fileId, keyB64: PCCrypto.b64(K), iv: enc.iv, aad: aad };
  }

  async function downloadAndDecrypt(meta) {
    var res = await api('/file/get?id=' + encodeURIComponent(meta.fileId) +
      '&room=' + encodeURIComponent(config.roomId) + '&sid=' + encodeURIComponent(ctx.mySid));
    if (!res.ok) throw new Error(res.error || '下载失败');
    var f = res.file;
    var plain = await PCCrypto.aesDecryptBytes(PCCrypto.unb64(meta.keyB64), meta.aad || ('file|' + config.roomId),
      meta.iv, f.ct, f.tag);
    return plain;
  }

  this.sendFile = async function (file) {
    var bytes = new Uint8Array(await file.arrayBuffer());
    var up = await encryptAndUpload(bytes);
    var plaintext = JSON.stringify({
      kind: 'file', name: file.name, mime: file.type || 'application/octet-stream',
      size: file.size, fileId: up.fileId, keyB64: up.keyB64, iv: up.iv, aad: up.aad
    });
    ctx.sendKind(plaintext, 'file');
  };

  /* ---- Voice clip recording (multi-codec probing, 60s cap, duration) ---- */
  function pickVoiceFormat() {
    if (!window.MediaRecorder) return { mime: '', ext: 'webm' };
    var list = [
      { mime: 'audio/webm;codecs=opus', ext: 'webm' },
      { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
      { mime: 'audio/mp4', ext: 'm4a' },
      { mime: 'audio/webm', ext: 'webm' }
    ];
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i].mime)) return list[i]; } catch (e) { /* older browser */ }
    }
    return { mime: '', ext: 'webm' };
  }
  function setRecState(s) {
    if (ctx && typeof ctx.onRecordState === 'function') ctx.onRecordState(s);
  }
  function clearVoiceTimer() {
    if (self._voiceTimer) { clearTimeout(self._voiceTimer); self._voiceTimer = null; }
  }

  this.recordVoice = function () {
    // Toggle: second tap stops and sends.
    if (self._rec && self._rec.rec && self._rec.rec.state === 'recording') {
      self._rec.rec.stop();
      return;
    }
    if (self._pending) {
      self._cancelPending = true;
      return;
    }
    if (!window.isSecureContext) {
      ctx.toast('麦克风需要 HTTPS 或 localhost 安全环境，请通过在线入口或 localhost 打开');
      pushDiag('VOICE-INSECURE', String(location && location.href));
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      ctx.toast('当前浏览器不支持录音（需较新 Chrome / Edge / Safari）');
      return;
    }
    var fmt = pickVoiceFormat();
    self._pending = true;
    self._cancelPending = false;
    setRecState('pending');
    pushDiag('VOICE-REQUEST', fmt.mime || 'default');

    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (stream) {
      self._pending = false;
      if (self._cancelPending) { stream.getTracks().forEach(function (t) { t.stop(); }); setRecState(false); return; }
      chunks = [];
      var rec;
      try { rec = fmt.mime ? new MediaRecorder(stream, { mimeType: fmt.mime }) : new MediaRecorder(stream); }
      catch (e) { rec = new MediaRecorder(stream); fmt = { mime: '', ext: 'webm' }; }
      self._rec = { rec: rec, stream: stream, ext: fmt.ext, mime: fmt.mime, started: Date.now() };
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () { finalizeVoice(); };
      rec.start(200);
      clearVoiceTimer();
      self._voiceTimer = setTimeout(function () {
        if (self._rec && self._rec.rec && self._rec.rec.state === 'recording') {
          ctx.toast('已达 60 秒上限，自动发送');
          self._rec.rec.stop();
        }
      }, MAX_VOICE_MS);
      // tick the elapsed seconds into the recording indicator
      self._tick = setInterval(function () {
        if (!self._rec) return;
        setRecState('tick:' + Math.max(1, Math.round((Date.now() - self._rec.started) / 1000)));
      }, 1000);
      setRecState(true);
      pushDiag('VOICE-START', fmt.mime || 'default');
    }).catch(function (e) {
      self._pending = false;
      setRecState(false);
      ctx.toast('无法访问麦克风：' + (e && e.message ? e.message : e));
      pushDiag('VOICE-DENIED', e && e.message ? e.message : String(e));
    });
  };

  async function finalizeVoice() {
    var r = self._rec;
    self._rec = null;
    clearVoiceTimer();
    if (self._tick) { clearInterval(self._tick); self._tick = null; }
    setRecState(false);
    if (!r) return;
    try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* noop */ }
    if (!chunks.length) { ctx.toast('未录到音频，已取消'); return; }
    var dur = Math.max(1, Math.round((Date.now() - r.started) / 1000));
    var blob = new Blob(chunks, { type: r.mime || 'audio/webm' });
    if (blob.size > MAX_VOICE_BYTES) { ctx.toast('语音超过 8MB，已取消'); return; }
    ctx.toast('语音已加密发送 · ' + dur + ' 秒');
    pushDiag('VOICE-SEND', 'dur=' + dur + ' bytes=' + blob.size);
    try {
      var buf = await blob.arrayBuffer();
      await self.sendFileLike(new Uint8Array(buf), 'voice-' + Date.now() + '.' + r.ext,
        r.mime || 'audio/webm', { voice: true, duration: dur });
    } catch (e) { ctx.toast('语音发送失败：' + (e && e.message ? e.message : e)); }
  }

  this.sendFileLike = async function (bytes, name, mime, extra) {
    var up = await encryptAndUpload(bytes);
    var plaintext = JSON.stringify(Object.assign({
      kind: 'file', name: name, mime: mime, size: bytes.length,
      fileId: up.fileId, keyB64: up.keyB64, iv: up.iv, aad: up.aad
    }, extra || {}));
    ctx.sendKind(plaintext, 'file');
  };

  /* Return an object URL for inline playback; caller revokes when done. */
  this.receiveFileBlob = async function (meta) {
    var plain = await downloadAndDecrypt(meta);
    var blob = new Blob([plain], { type: meta.mime || 'application/octet-stream' });
    return { url: URL.createObjectURL(blob), blob: blob };
  };
  this.receiveFile = async function (meta) {
    var rec = await this.receiveFileBlob(meta);
    var a = document.createElement('a');
    a.href = rec.url; a.download = meta.name || 'file'; document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(rec.url); }, 4000);
  };

  /* ---- Full-duplex AUDIO-ONLY live voice over WebRTC mesh ---- */
  /* PCCrypto primitives (forge) are synchronous. Wrap them in a promise chain
   * that also tolerates async implementations, so signaling never crashes on a
   * .then of a plain object. This was a latent failure in the old media code. */
  function wrapSignal(targetSid, obj) {
    var target = ctx.members.get(targetSid);
    if (!target) return Promise.resolve(null);
    var text = JSON.stringify(obj);
    return Promise.resolve().then(function () {
      var K = PCCrypto.randomBytes(32);
      var enc = PCCrypto.aesEncrypt(K, 'rtc|' + config.roomId, text);
      return Promise.resolve(enc).then(function (e) {
        return Promise.resolve(PCCrypto.wrapKey(K, target.ukPub)).then(function (wrap) {
          return PCCrypto.b64(new TextEncoder().encode(JSON.stringify({
            iv: e.iv, ct: e.ct, tag: e.tag, wrap: wrap
          })));
        });
      });
    });
  }
  function unwrapSignal(fromSid, b64str) {
    var obj = JSON.parse(new TextDecoder().decode(PCCrypto.unb64(b64str)));
    return Promise.resolve(PCCrypto.unwrapKey(obj.wrap, ctx.uk.privatePem)).then(function (K) {
      return Promise.resolve(PCCrypto.aesDecrypt(K, 'rtc|' + config.roomId, obj.iv, obj.ct, obj.tag));
    }).then(function (plain) {
      return JSON.parse(new TextDecoder().decode(plain));
    });
  }
  function sendSignal(sid, obj) {
    return wrapSignal(sid, obj).then(function (w) {
      if (w) net.send({ type: PCProtocol.MSG.RTC_SIGNAL, to: sid, encryptedSignal: w });
    });
  }
  // Deterministic polite role: the lexicographically smaller sid yields on glare.
  function isPolite(remoteSid) { return String(ctx.mySid) < String(remoteSid); }

  function ensureLocalStream() {
    if (localStream) return Promise.resolve(localStream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('当前环境不支持麦克风'));
    }
    pushDiag('VOICE-MIC-REQUEST', 'audio full-duplex');
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    }).then(function (stream) {
      localStream = stream;
      if (ctx.onLocalStream) ctx.onLocalStream(stream);
      pushDiag('VOICE-MIC-OK', 'tracks=' + stream.getTracks().length);
      return stream;
    });
  }

  function peer(sid) {
    if (pcs[sid]) return pcs[sid];
    var pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.qq.com:3478' }
      ]
    });
    pcs[sid] = pc;
    if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });

    pc.ontrack = function (e) {
      var stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      if (ctx.onRemoteTrack) ctx.onRemoteTrack(sid, stream);
    };
    pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal(sid, { kind: 'ice', candidate: e.candidate }).catch(function () {});
    };
    pc.onnegotiationneeded = function () {
      makingOffer[sid] = true;
      return pc.setLocalDescription().then(function () {
        return sendSignal(sid, { kind: 'description', description: pc.localDescription });
      }).catch(function (e) { pushDiag('VOICE-NEGO-ERR', sid + ' ' + (e && e.message)); })
        .then(function () { makingOffer[sid] = false; });
    };
    pc.onconnectionstatechange = function () {
      pushDiag('VOICE-PC-STATE', sid + ' ' + pc.connectionState);
      if (pc.connectionState === 'failed') ctx.toast('与一位成员的语音连接失败，可关闭后重开语音');
    };
    return pc;
  }

  // Backward-compatible name used by app.js / deluxe.js.
  this.startCall = function (voiceOnly) { return this.startVoice(); };

  this.startVoice = async function () {
    if (voiceOn) return;
    if (!window.RTCPeerConnection) { ctx.toast('当前环境不支持语音通话'); return; }
    try { await ensureLocalStream(); }
    catch (e) { ctx.toast('无法访问麦克风：' + (e && e.message ? e.message : e)); return; }
    voiceOn = true;
    var others = PCMembers.all().filter(function (m) { return m.sid !== ctx.mySid; });
    pushDiag('VOICE-ON', 'peers=' + others.length);
    // Creating a peer + adding tracks fires onnegotiationneeded -> sends offers.
    others.forEach(function (m) { peer(m.sid); });
    if (!others.length) ctx.toast('语音已开启，等待其他成员加入（当前仅你一人）');
    else ctx.toast('全双工语音已开启 · ' + others.length + ' 位成员');
    if (ctx.onVoiceState) ctx.onVoiceState(true);
  };

  this.handleSignal = async function (fromSid, encryptedSignal) {
    var sig;
    try { sig = await unwrapSignal(fromSid, encryptedSignal); }
    catch (e) { pushDiag('VOICE-SIG-DECRYPT-ERR', fromSid + ' ' + (e && e.message)); return; }

    // KEY FIX: an incoming offer/ICE must be handled even if I never pressed
    // the voice button. Auto-join so full-duplex works for the recipient too.
    if (!voiceOn) {
      try { await ensureLocalStream(); }
      catch (e) { pushDiag('VOICE-AUTOJOIN-ERR', fromSid + ' ' + (e && e.message)); return; }
      voiceOn = true;
      pushDiag('VOICE-AUTOJOIN', fromSid);
      if (ctx.onVoiceState) ctx.onVoiceState(true);
    }

    var pc = peer(fromSid);
    var polite = isPolite(fromSid);
    try {
      if (sig.kind === 'description' && sig.description) {
        var desc = sig.description;
        var isOffer = desc.type === 'offer';
        var collision = isOffer && (makingOffer[fromSid] || pc.signalingState !== 'stable');
        var ignore = collision && !polite;
        if (ignore) { pushDiag('VOICE-GLARE-IGNORE', fromSid); return; }
        if (collision && polite) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(desc);
        if (isOffer) {
          await pc.setLocalDescription();  // creates the answer
          await sendSignal(fromSid, { kind: 'description', description: pc.localDescription });
          pushDiag('VOICE-ANSWER-SENT', fromSid);
        }
      } else if (sig.kind === 'ice' && sig.candidate) {
        await pc.addIceCandidate(sig.candidate);
      }
    } catch (e) { pushDiag('VOICE-SIG-ERR', fromSid + ' ' + (e && e.message)); }
  };

  this.hangup = function () {
    voiceOn = false;
    for (var sid in pcs) { try { pcs[sid].close(); } catch (e) { /* noop */ } delete pcs[sid]; }
    makingOffer = {};
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    localStream = null;
    pushDiag('VOICE-OFF', '');
    if (ctx.onCallEnd) ctx.onCallEnd();
    if (ctx.onVoiceState) ctx.onVoiceState(false);
  };
  this.inCall = function () { return voiceOn; };
};
