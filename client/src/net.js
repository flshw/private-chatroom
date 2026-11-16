/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom network layer. */
'use strict';
/* WSS transport with join handshake, heartbeat and exponential-backoff reconnect.
 * On reconnect it reuses the same UK_i (stored locally) and re-JOINs. */
window.PCNet = function (handlers) {
  var config = handlers.config;
  var self = this;
  var ws = null;
  var retries = 0;
  var closedByUser = false;
  var heartbeat = null;
  var joinFrame = null;

  function url() {
    var base = config.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    return base + (config.wsUrl || '/pc/ws');
  }

  function send(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  function connect(frame) {
    if (frame) joinFrame = frame;
    closedByUser = false;
    var u = url();
    try { ws = new WebSocket(u); }
    catch (e) { handlers.onError && handlers.onError('连接地址无效'); return; }
    ws.onopen = function () {
      retries = 0;
      if (joinFrame) send(joinFrame);
      handlers.onOpen && handlers.onOpen();
    };
    ws.onmessage = function (ev) {
      var f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.type === PCProtocol.MSG.PONG) return;
      handlers.onFrame && handlers.onFrame(f);
    };
    ws.onclose = function () {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (closedByUser) return;
      handlers.onClose && handlers.onClose();
      retries++;
      var delay = Math.min(30000, 500 * Math.pow(2, Math.min(retries, 6))) + Math.random() * 400;
      setTimeout(function () { connect(joinFrame); }, delay);
    };
    ws.onerror = function () { /* close handler drives reconnect */ };
    if (!heartbeat) {
      heartbeat = setInterval(function () {
        if (ws && ws.readyState === 1) send({ type: PCProtocol.MSG.PING, ts: Date.now() });
      }, 20000);
    }
  }

  this.start = function (frame) { connect(frame); };
  this.send = send;
  this.close = function () {
    closedByUser = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (ws) { try { ws.close(); } catch (e) { /* noop */ } }
    ws = null;
  };
  this.rejoin = function (frame) { joinFrame = frame; if (ws && ws.readyState === 1) send(frame); };
  this.connected = function () { return !!(ws && ws.readyState === 1); };
};
