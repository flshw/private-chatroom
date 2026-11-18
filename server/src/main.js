/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/* Entry point: wire modules, start listeners and the expiry sweeper. */
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const { Database } = require('./database');
const { KeyStore } = require('./keys');
const { Accounts } = require('./accounts');
const { Issuer } = require('./issuer');
const { Rooms } = require('./rooms');
const { Hub } = require('./hub');
const { Shares } = require('./shares');
const { createHttpServer } = require('./http');
const { AdminAuth } = require('./admin-auth');
const { config, DATA_DIR, LOG_DIR } = require('./paths');

const verbose = process.argv.indexOf('--verbose') !== -1;
function logger(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'server-' + new Date().toISOString().slice(0, 10) + '.log'), line + '\n');
  } catch (e) { /* noop */ }
  if (verbose) console.log(line);
  else console.log(line);
}

/* Dedicated connection/message trace. Kept SEPARATE from the boot log so a
 * reconnect storm can be handed off in one small file. Carries no plaintext —
 * only structural facts: sid, room, seq, accept/reject reason, WS state. */
function connLog(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'conn-' + new Date().toISOString().slice(0, 10) + '.log'), line + '\n');
  } catch (e) { /* noop */ }
  if (verbose) console.log('CONN ' + msg);
}

let httpServer, wss, heartbeat, sweepTimer, db, adminAuth;

async function boot() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(logger);
  await db.init();
  adminAuth = new AdminAuth(logger).init();
  const keys = new KeyStore(logger).init();
  const accounts = new Accounts(db, logger);
  const issuer = new Issuer(db, keys, P.canonicalJSON, logger);
  const hub = new Hub({ db, keys, canonicalJSON: P.canonicalJSON, logger, connLog, serverSecret: keys.serverSecret() });
  const shares = new Shares(db, logger, keys);
  const rooms = new Rooms(db, keys, issuer, accounts, hub, logger);
  rooms.shares = shares;
  hub.rooms = rooms;
  const srv = createHttpServer({ accounts, rooms, hub, db, keyStore: keys, logger, connLog, shares, adminAuth });
  httpServer = srv.server;
  wss = srv.wss;
  heartbeat = srv.heartbeat;
  httpServer.listen(config.port, config.host, () => {
    logger('════════════════════════════════════════════════════');
    logger('  Private Chatroom v' + P.PC_RELEASE_VERSION + ' · 独立进程已启动');
    logger('  监听    ' + config.host + ':' + config.port);
    logger('  门户前缀 ' + config.publicPrefix + '/  API ' + config.apiPrefix + '  WS ' + config.wsPath);
    logger('  数据目录 ' + DATA_DIR);
    logger('  SSK 指纹 ' + keys.ssk.fingerprint);
    logger('════════════════════════════════════════════════════');
  });
  // Startup sweep: destroy any rooms that expired while the process was down.
  const swept = rooms.sweepExpired();
  if (swept) logger('启动清理：销毁过期房间 ' + swept + ' 个');
  sweepTimer = setInterval(() => {
    try { const n = rooms.sweepExpired(); if (n) logger('定时清理：销毁过期房间 ' + n + ' 个'); }
    catch (e) { logger('清理异常: ' + e.message); }
  }, 60000);
}

function shutdown(signal) {
  logger('收到 ' + signal + '，正在优雅退出…');
  if (sweepTimer) clearInterval(sweepTimer);
  if (heartbeat) clearInterval(heartbeat);
  try { if (wss) for (const ws of wss.clients) ws.terminate(); } catch (e) { /* noop */ }
  if (adminAuth) { try { adminAuth.close(); } catch (e) { /* noop */ } }
  if (httpServer) httpServer.close(() => { if (db) db.close(); process.exit(0); });
  else { if (db) db.close(); process.exit(0); }
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

boot().catch(e => { console.error('启动失败: ' + e.stack || e.message); process.exit(1); });
