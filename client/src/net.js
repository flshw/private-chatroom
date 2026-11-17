/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom network layer. */
'use strict';
/* WSS transport with join handshake, heartbeat and exponential-backoff reconnect.
 * On reconnect it reuses the same UK_i (stored locally) and re-JOINs.
 *
 * CONNECT-WATCHDOG: a socket that never reaches OPEN, or one that stops
 * answering heartbeats (TCP half-open), is force-closed so onclose ALWAYS
 * drives a reconnect. Without this, a socket stuck in CONNECTING keeps
 * readyState != 1, every game send is rejected as "连接未就绪", the echo that
 * advances the turn never comes, and the bot turn freezes. */
window.PCNet = function (handlers) {
  var config = handlers.config;
  var self = this;
  var ws = null;
  var retries = 0;
  var closedByUser = false;
  var heartbeat = null;
  var joinFrame = null;
  var connectTimer = null;      // CONNECT-WATCHDOG: force-close if never OPEN
  var reconnectTimer = null;    // idempotent reconnect scheduler
  var pongMiss = 0;             // consecutive heartbeats with no frame received
  var CONNECT_TIMEOUT_MS = 6000;
  var HEARTBEAT_MS = 15000;

  function url() {
    var base = config.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    return base + (config.wsUrl || '/pc/ws');
  }

  function send(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  /* Idempotent: never schedule two reconnects for one dead socket. */
  function scheduleReconnect() {
    if (closedByUser || reconnectTimer) return;
    retries++;
    var delay = Math.min(8000, 500 * Math.pow(2, Math.min(retries, 6))) + Math.random() * 400;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(joinFrame); }, delay);
  }

  function connect(frame) {
    if (frame) joinFrame = frame;
    closedByUser = false;
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    pongMiss = 0;
    var u = url();
    try { ws = new WebSocket(u); }
    catch (e) {
      if (handlers.onError) handlers.onError('连接地址无效');
      scheduleReconnect();
      return;
    }

    /* CONNECT-WATCHDOG: if the handshake never completes, close the socket so
     * onclose fires and reconnects. The extra guard covers engines where close()
     * during CONNECTING does not emit onclose. */
    connectTimer = setTimeout(function () {
      connectTimer = null;
      if (ws && ws.readyState !== 1) {
        if (console.warn) console.warn('[PCDIAG] CONNECT-TIMEOUT state=' + ws.readyState + ' -> force reconnect');
        try { ws.close(); } catch (e) {}
        setTimeout(function () {
          if (!closedByUser && ws && ws.readyState !== 1) scheduleReconnect();
        }, 400);
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = function () {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      retries = 0; pongMiss = 0;
      if (joinFrame) send(joinFrame);
      if (handlers.onOpen) handlers.onOpen();
    };
    ws.onmessage = function (ev) {
      var f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      pongMiss = 0; // any frame (incl. PONG) proves the socket is alive
      if (f.type === PCProtocol.MSG.PONG) return;
      if (handlers.onFrame) handlers.onFrame(f);
    };
    ws.onclose = function () {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (closedByUser) return;
      if (handlers.onClose) handlers.onClose();
      scheduleReconnect();
    };
    ws.onerror = function () { /* close / connect watchdog drive reconnect */ };

    if (!heartbeat) {
      heartbeat = setInterval(function () {
        if (!ws || ws.readyState !== 1) return; // connect watchdog handles non-OPEN
        if (pongMiss >= 2) {
          /* Half-open: TCP says OPEN but no frames arrive. Force a fresh socket. */
          if (console.warn) console.warn('[PCDIAG] HEARTBEAT-DEAD -> force reconnect');
          try { ws.close(); } catch (e) {}
          return;
        }
        pongMiss++;
        send({ type: PCProtocol.MSG.PING, ts: Date.now() });
      }, HEARTBEAT_MS);
    }
  }

  this.start = function (frame) { connect(frame); };
  this.send = send;
  this.close = function () {
    closedByUser = true;
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (ws) { try { ws.close(); } catch (e) { /* noop */ } }
    ws = null;
  };
  this.rejoin = function (frame) { joinFrame = frame; if (ws && ws.readyState === 1) send(frame); };
  this.connected = function () { return !!(ws && ws.readyState === 1); };
  /* Diagnostics: -1=no socket, 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED */
  this.readyState = function () { return ws ? ws.readyState : -1; };
};
