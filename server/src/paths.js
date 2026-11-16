/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/* Centralised paths + environment configuration for the independent process. */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_DIR = path.join(ROOT, 'admin');
const TEMPLATE_FILE = path.join(ROOT, '..', 'client', 'dist', 'private-chat.template.html');
const DELUXE_TEMPLATE_FILE = path.join(ROOT, '..', 'client', 'dist', 'private-chat-deluxe.template.html');

function envInt(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const DATA_DIR = process.env.PC_DATA_DIR || path.join(ROOT, 'data');
const KEYS_DIR = process.env.PC_KEYS_DIR || path.join(DATA_DIR, 'keys');
const LOG_DIR = process.env.PC_LOG_DIR || path.join(DATA_DIR, 'logs');
const FILES_DIR = path.join(DATA_DIR, 'files');

const config = {
  port: envInt('PC_PORT', 8443),
  host: process.env.PC_HOST || '127.0.0.1',
  publicPrefix: process.env.PC_PUBLIC_PREFIX || '/Pchat',
  apiPrefix: process.env.PC_API_PREFIX || '/pc/api',
  wsPath: process.env.PC_WS_PATH || '/pc/ws',
  serverUrl: process.env.PC_SERVER_URL || 'https://flshw.online',
  hardMaxMembers: envInt('PC_HARD_MAX_MEMBERS', 20),
  maxRoomsPerUser: envInt('PC_QUOTA_ROOMS', 3),
  tlsCert: process.env.PC_TLS_CERT || '',
  tlsKey: process.env.PC_TLS_KEY || ''
};

module.exports = {
  ROOT, PUBLIC_DIR, ADMIN_DIR, TEMPLATE_FILE, DELUXE_TEMPLATE_FILE,
  DATA_DIR, KEYS_DIR, LOG_DIR, FILES_DIR, config
};
