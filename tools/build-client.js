/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/* Builds client/dist/private-chat.template.html — a single self-contained file
 * with __PC_CONFIG__ left as a literal placeholder for the runtime issuer. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, p), s);
};
const safeJs = s => String(s).replace(/<\/script/gi, '<\\/script');

/* Keep server/ self-contained like the main project. */
const canonical = read('shared/protocol.js');
const serverProto = path.join(ROOT, 'server', 'src', 'protocol.js');
if (!fs.existsSync(serverProto) || fs.readFileSync(serverProto, 'utf8') !== canonical) {
  fs.writeFileSync(serverProto, canonical);
  console.log('已同步: server/src/protocol.js');
}

const parts = {
  '__CSS__': read('client/src/style.css'),
  '__PROTOCOL__': safeJs(canonical),
  '__FORGE__': safeJs(read('vendor/forge.min.js')),
  '__CRYPTO__': safeJs(read('client/src/crypto.js')),
  '__MEMBERS__': safeJs(read('client/src/members.js')),
  '__NET__': safeJs(read('client/src/net.js')),
  '__EXPORT__': safeJs(read('client/src/export.js')),
  '__MEDIA__': safeJs(read('client/src/media.js')),
  '__APP__': safeJs(read('client/src/app.js'))
};

let html = read('client/src/template.html');
for (const key of Object.keys(parts)) {
  const token = '/*' + key + '*/';
  if (html.indexOf(token) === -1) throw new Error('模板缺少占位符: ' + token);
  html = html.replace(token, () => parts[key]);
}

/* __PC_CONFIG__ must survive — it is the runtime injection point. */
if (html.indexOf('__PC_CONFIG__') === -1) throw new Error('运行期占位符 __PC_CONFIG__ 丢失');
/* No other uppercase placeholders should remain. */
const leftover = html.match(/__[A-Z0-9_]+__/g) || [];
const unexpected = leftover.filter(x => x !== '__PC_CONFIG__');
if (unexpected.length) throw new Error('仍有未替换占位符: ' + unexpected.join(', '));
/* No external resources. */
if (/<script[^>]+src=/i.test(html) || /<link[^>]+href=/i.test(html)) {
  throw new Error('模板不得引用外部资源');
}
/* Template must not contain real credentials. */
if (/-----BEGIN (RSA )?PRIVATE KEY-----/.test(parts['__CONFIG__'])) {
  throw new Error('模板不得包含私钥');
}
const bytes = Buffer.byteLength(html, 'utf8');
if (bytes > 500 * 1024) throw new Error('模板体积超过 500 KB: ' + bytes);

write('client/dist/private-chat.template.html', html);
console.log(`构建完成: client/dist/private-chat.template.html (${(bytes / 1024).toFixed(1)} KB)`);
console.log('内联: CSS / PC 协议 / forge / crypto / members / net / export / media / app');
console.log('保留运行期占位符 __PC_CONFIG__，静态校验通过');
