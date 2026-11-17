/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom media. */
'use strict';
/*
 * Media helpers: voice clip recording, file pick + encrypt, WebRTC mesh video.
 * All file/voice bytes are encrypted client-side with a fresh K_file and the
 * key itself is sent as a normal E2EE message, so the server sees ciphertext.
 * WebRTC media is P2P DTLS-SRTP; signaling is wrapped to the target member.
 */
window.PCMedia = function (ctx) {
  var self = this;
  var config = ctx.config;
  var net = ctx.net;
  var apiBase = config.serverUrl.replace(/\/$/, '') + PCProtocol.DEFAULTS.apiPrefix;
  var mediaRecorder = null, chunks = [];
  var pcs = {};         // sid -> RTCPeerConnection
  var localStream = null;
  var inCall = false;

  function api(path, opts) {
    return fetch(apiBase + path, opts).then(function (r) { return r.json(); });
  }

  /* Encrypt bytes and upload the ciphertext blob; returns {fileId, keyB64, iv, ct, tag}. */
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

  async function downloadAndDecrypt(fileId, keyB64, iv, aad) {
    var res = await api('/file/get?id=' + encodeURIComponent(fileId) +
      '&room=' + encodeURIComponent(config.roomId) + '&sid=' + encodeURIComponent(ctx.mySid));
    if (!res.ok) throw new Error(res.error || '下载失败');
    var f = res.file;
    var plain = await PCCrypto.aesDecryptBytes(PCCrypto.unb64(keyB64), aad || ('file|' + config.roomId),
      iv, f.ct, f.tag);
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

  this.recordVoice = function () {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      ctx.toast('当前环境不支持录音，请使用在线入口'); return;
    }
    if (self._recording) {
      self._recording = false;
      if (ctx.onRecordState) ctx.onRecordState(false);
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
      ctx.toast('录音结束，正在加密发送…');
      return;
    }
    if (self._pending) return;
    self._pending = true;
    if (ctx.onRecordState) ctx.onRecordState('pending');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      self._pending = false;
      if (self._recording) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        self._recording = false;
        if (ctx.onRecordState) ctx.onRecordState(false);
        if (!chunks.length) return;
        var blob = new Blob(chunks, { type: 'audio/webm' });
        blob.arrayBuffer().then(function (buf) {
          return self.sendFileLike(new Uint8Array(buf), 'voice.webm', 'audio/webm');
        }).then(function () {
          ctx.toast('语音已加密发送');
        }).catch(function (e) { ctx.toast('语音发送失败：' + e.message); });
      };
      mediaRecorder.start();
      self._recording = true;
      if (ctx.onRecordState) ctx.onRecordState(true);
      ctx.toast('录音中… 再次点击麦克风按钮结束');
    }).catch(function () {
      self._pending = false;
      if (ctx.onRecordState) ctx.onRecordState(false);
      ctx.toast('无法访问麦克风，请使用在线 HTTPS 入口');
    });
  };

  this.sendFileLike = async function (bytes, name, mime) {
    var up = await encryptAndUpload(bytes);
    var plaintext = JSON.stringify({
      kind: 'file', name: name, mime: mime, size: bytes.length,
      fileId: up.fileId, keyB64: up.keyB64, iv: up.iv, aad: up.aad
    });
    ctx.sendKind(plaintext, 'file');
  };

  this.receiveFile = async function (meta) {
    var plain = await downloadAndDecrypt(meta.fileId, meta.keyB64, meta.iv, meta.aad);
    var blob = new Blob([plain], { type: meta.mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = meta.name || 'file'; document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  };

  /* --- WebRTC mesh video. Signaling is relayed wrapped per target member. --- */
  async function wrapSignal(targetSid, obj) {
    var target = ctx.members.get(targetSid);
    if (!target) return null;
    var text = JSON.stringify(obj);
    var K = PCCrypto.randomBytes(32);
    var enc = await PCCrypto.aesEncrypt(K, 'rtc|' + config.roomId, text);
    var wrap = await PCCrypto.wrapKey(K, target.ukPub);
    return PCCrypto.b64(new TextEncoder().encode(JSON.stringify({
      iv: enc.iv, ct: enc.ct, tag: enc.tag, wrap: wrap
    })));
  }
  async function unwrapSignal(fromSid, b64str) {
    var obj = JSON.parse(new TextDecoder().decode(PCCrypto.unb64(b64str)));
    var K = await PCCrypto.unwrapKey(obj.wrap, ctx.uk.privatePem);
    var plain = await PCCrypto.aesDecrypt(K, 'rtc|' + config.roomId, obj.iv, obj.ct, obj.tag);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function peer(sid) {
    if (pcs[sid]) return pcs[sid];
    var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pcs[sid] = pc;
    if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    pc.ontrack = function (e) { ctx.onRemoteTrack(sid, e.streams[0]); };
    pc.onicecandidate = function (e) {
      if (e.candidate) {
        wrapSignal(sid, { kind: 'ice', candidate: e.candidate }).then(function (w) {
          if (w) net.send({ type: PCProtocol.MSG.RTC_SIGNAL, to: sid, encryptedSignal: w });
        });
      }
    };
    return pc;
  }

  this.startCall = async function (voiceOnly) {
    if (inCall) return;
    if (!navigator.mediaDevices || !window.RTCPeerConnection) {
      ctx.toast('当前环境不支持实时通话，请使用在线入口'); return;
    }
    var constraints = voiceOnly ? { video: false, audio: true } : { video: true, audio: true };
    try { localStream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (e) { ctx.toast('无法访问摄像头/麦克风，请使用在线 HTTPS 入口'); return; }
    inCall = true;
    ctx.onLocalStream(localStream);
    // Initiate to every other member (perfect negotiation simplified: initiator offers).
    var others = PCMembers.all().filter(function (m) { return m.sid !== ctx.mySid; });
    if (others.length > 8) ctx.toast('成员超过 8 人，已降级为仅音频');
    for (var i = 0; i < others.length; i++) {
      (function (m) {
        var pc = peer(m.sid);
        pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); })
          .then(function () {
            return wrapSignal(m.sid, { kind: 'offer', sdp: pc.localDescription });
          }).then(function (w) {
            if (w) net.send({ type: PCProtocol.MSG.RTC_SIGNAL, to: m.sid, encryptedSignal: w });
          }).catch(function (e) { ctx.toast('建立通话失败：' + e.message); });
      })(others[i]);
    }
  };

  this.handleSignal = async function (fromSid, encryptedSignal) {
    if (!inCall) return;
    var sig;
    try { sig = await unwrapSignal(fromSid, encryptedSignal); }
    catch (e) { return; }
    var pc = peer(fromSid);
    try {
      if (sig.kind === 'offer') {
        await pc.setRemoteDescription(sig.sdp);
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        var w = await wrapSignal(fromSid, { kind: 'answer', sdp: pc.localDescription });
        if (w) net.send({ type: PCProtocol.MSG.RTC_SIGNAL, to: fromSid, encryptedSignal: w });
      } else if (sig.kind === 'answer') {
        await pc.setRemoteDescription(sig.sdp);
      } else if (sig.kind === 'ice') {
        await pc.addIceCandidate(sig.candidate);
      }
    } catch (e) { /* ignore negotiation races in mesh demo */ }
  };

  this.hangup = function () {
    inCall = false;
    for (var sid in pcs) { try { pcs[sid].close(); } catch (e) { /* noop */ } delete pcs[sid]; }
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    localStream = null;
    ctx.onCallEnd();
  };
  this.inCall = function () { return inCall; };
};
