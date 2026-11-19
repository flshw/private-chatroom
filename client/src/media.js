/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom media. */
'use strict';
/*
 * Media helpers: encrypted voice-clip recording and file transfer.
 *
 * Full-duplex live voice (WebRTC) has been REMOVED. Voice clips / files are
 * encrypted client-side with a fresh K_file and that key is delivered as a
 * normal E2EE message, so the server only ever stores ciphertext.
 *
 * There is intentionally NO video and NO real-time call anywhere in this build.
 */
window.PCMedia = function (ctx) {
  var self = this;
  var config = ctx.config;
  var net = ctx.net;
  var apiBase = config.serverUrl.replace(/\/$/, '') + PCProtocol.DEFAULTS.apiPrefix;

  var mediaRecorder = null, chunks = [];

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

};
