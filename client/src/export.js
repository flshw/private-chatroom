/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom export. */
'use strict';
/* Local plaintext export. Data is already plaintext in this browser; export
 * just packages it. Warn about plaintext exposure before downloading. */
window.PCExport = (function () {
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function safeName(s) {
    return String(s || 'chat').replace(/[^\w\u4e00-\u9fa5\-]+/g, '_').slice(0, 24) || 'chat';
  }
  function exportTxt(roomName, messages) {
    var lines = messages.map(function (m) {
      var head = '[' + new Date(m.ts).toLocaleString() + '] ' + (m.nickname || m.who || '?') + ':';
      return head + '\n' + (m.text || '') + '\n';
    });
    return '私密聊天导出 · ' + roomName + '\n导出时间：' + new Date().toLocaleString() +
      '\n注意：本文件为明文，请妥善保管。\n\n' + lines.join('\n');
  }
  function exportJson(roomName, messages) {
    return JSON.stringify({
      app: 'Private Chatroom', room: roomName, exportedAt: Date.now(),
      warning: 'plaintext export - handle with care', messages: messages
    }, null, 2);
  }
  function run(roomName, messages) {
    var ok = window.confirm('导出为明文文件？\n聊天记录将以未加密形式保存到本机，请注意保管，不要上传到网盘或公共平台。');
    if (!ok) return;
    var base = 'private-chat-' + safeName(roomName) + '-' + Date.now();
    download(base + '.txt', exportTxt(roomName, messages), 'text/plain;charset=utf-8');
    setTimeout(function () {
      download(base + '.json', exportJson(roomName, messages), 'application/json;charset=utf-8');
    }, 300);
  }
  return { run: run, download: download };
})();
