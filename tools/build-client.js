/*
 * Copyright (c) 2026 CJS flshw@126.com
 * Private Chatroom · room-scoped end-to-end encrypted chat. All rights reserved.
 * Licensed for use with this Private Chatroom distribution only.
 */
'use strict';
/* Builds two single-file templates (simple + deluxe) with __PC_CONFIG__ left
 * as a literal placeholder for the runtime issuer. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, p), s);
};
const safeJs = s => String(s).replace(/<\/script/gi, '<\\/script');

const canonical = read('shared/protocol.js');
const serverProto = path.join(ROOT, 'server', 'src', 'protocol.js');
if (!fs.existsSync(serverProto) || fs.readFileSync(serverProto, 'utf8') !== canonical) {
  fs.writeFileSync(serverProto, canonical);
  console.log('已同步: server/src/protocol.js');
}

const baseParts = {
  '__PROTOCOL__': safeJs(canonical),
  '__FORGE__': safeJs(read('vendor/forge.min.js')),
  '__CRYPTO__': safeJs(read('client/src/crypto.js')),
  '__CONFIG__': safeJs(read('client/src/config.js')),
  '__MEMBERS__': safeJs(read('client/src/members.js')),
  '__NET__': safeJs(read('client/src/net.js')),
  '__EXPORT__': safeJs(read('client/src/export.js')),
  '__MEDIA__': safeJs(read('client/src/media.js')),
  '__APP__': safeJs(read('client/src/app.js'))
};

const baseMarkers = [
  ['PC 协议', 'root.PCProtocol = api'],
  ['配置校验', 'window.PCConfig = (function'],
  ['加密模块', 'window.PCCrypto = (function'],
  ['成员表', 'window.PCMembers = (function'],
  ['网络层', 'window.PCNet = function'],
  ['导出模块', 'window.PCExport = (function'],
  ['媒体模块', 'window.PCMedia = function'],
  ['localStorage 密钥持久化', "localStorage.setItem(ukStoreKey(roomId)"],
  ['退出房间按钮', 'id="btn-exit"'],
  ['退出房间流程', 'function leaveRoom()'],
  ['启动脚本', 'boot();']
];

function build(version, parts, markers, outFile) {
  let html = read(parts.__TEMPLATE__);
  const inject = Object.assign({}, parts);
  delete inject.__TEMPLATE__;
  for (const key of Object.keys(inject)) {
    const token = '/*' + key + '*/';
    if (html.indexOf(token) === -1) throw new Error(version + ' 模板缺少占位符: ' + token);
    html = html.replace(token, () => inject[key]);
  }
  for (const [label, marker] of markers) {
    if (html.indexOf(marker) === -1) throw new Error(version + ' 内联模块缺失: ' + label);
  }
  if (html.indexOf('__PC_CONFIG__') === -1) throw new Error(version + ' 运行期占位符丢失');
  const RUNTIME_GLOBALS = ['__PC_CONFIG__', '__PC_CONFIG_SIG__'];
  const leftover = (html.match(/__[A-Z0-9_]+__/g) || []).filter(x => RUNTIME_GLOBALS.indexOf(x) === -1);
  if (leftover.length) throw new Error(version + ' 仍有未替换占位符: ' + leftover.join(', '));
  if (/<script[^>]+src=/i.test(html) || /<link[^>]+href=/i.test(html)) {
    throw new Error(version + ' 模板不得引用外部资源');
  }
  if (/-----BEGIN (RSA )?PRIVATE KEY-----/.test(parts['__CONFIG__'] || inject['__CONFIG__'])) {
    throw new Error(version + ' 模板不得包含私钥');
  }
  // Constructors must be invoked with `new`.
  if (html.indexOf('= window.PCNet(') !== -1 || html.indexOf('= window.PCMedia(') !== -1) {
    throw new Error(version + ' 构造函数必须用 new 调用');
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > 900 * 1024) throw new Error(version + ' 模板体积超过 900 KB: ' + bytes);
  write(outFile, html);
  console.log(`构建完成: ${outFile} (${(bytes / 1024).toFixed(1)} KB)`);
  return bytes;
}

/* ---- simple edition ---- */
build('简洁版', Object.assign({ __TEMPLATE__: 'client/src/template.html', __CSS__: read('client/src/style.css') }, baseParts),
  baseMarkers, 'client/dist/private-chat.template.html');

/* ---- deluxe edition: base CSS + deluxe CSS; extra modules ---- */
const deluxeCss = read('client/src/style.css') + '\n' +
  read('client/src/style-deluxe.css').replace('BASE_STYLES_PLACEHOLDER', '');
const deluxeParts = Object.assign({
  __TEMPLATE__: 'client/src/template-deluxe.html',
  __CSS__: deluxeCss,
  '__GAME__': safeJs(read('client/src/game.js')),
  '__BOTS__': safeJs(read('client/src/bots.js')),
  '__GAMECLIENT__': safeJs(read('client/src/gameclient.js')),
  '__ENGINE3D__': safeJs(read('client/src/engine3d.js')),
  '__DELUXE__': safeJs(read('client/src/deluxe.js'))
}, baseParts);
const deluxeMarkers = baseMarkers.concat([
  ['3D 画布层级', '#chat>#scene3d{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}'],
  ['刷新自动续进', 'var nick = savedNickname();'],
  ['两版通用续进', 'if (cached && nick) {'],
  ['四人开局门槛', 'membersList.length >= 4'],
  ['三人选座开局', 'game.requestStart([mySid].concat(picked));'],
  ['记牌器面板', 'id="card-counter"'],
  ['选座面板', 'id="game-setup"'],
  ['选人弹窗遮罩', 'id="game-setup-mask"'],
  ['自动预选规则', 'membersList.length === 4'],
  ['底部出牌按钮', 'class="game-bottom"'],
  ['出牌统计', 'state.played.push('],
  ['手牌同类堆叠', "className = 'pcard-stack'"],
  ['纵向扇形堆叠', 'stepY * (g.cards.length - 1))'],
  ['移动端堆叠尺寸自适应', "cardW = 36; cardH = 52; stepX = 8; stepY = 18"],
  ['选牌保持滚动位置', 'if (prevScroll) hand.scrollLeft = prevScroll'],
  ['单张可选', 'function toggleOne(c)'],
  ['牌面角标花色', "corner.className = 'pip'"],
  ['出牌区居中', '.game-table{width:min(100%,560px)'],
  ['文字提示区悬浮左侧中间', '.game-log{position:absolute;left:16px;top:50%'],
  ['游戏浮层透出聊天', 'pointer-events:none}'],
  ['记牌器放大', 'font-size:15px;color:var(--ink)'],
  ['过牌始终可点', 'btnPass.disabled = !inPlay'],
  ['过牌无反馈修复', '你是本轮首位领出，请先出牌'],
  ['过牌自我反馈', "by === mySid ? '你'"],
  ['机器人放慢', 'botThinkingMs = 1400'],
  ['出牌即时重绘', 'onUpdate(state);\n      return true;'],
  ['出牌同步清空选中', 'var ok = game.play(ids);'],
  ['堆叠选中高亮', '.pcard-stack>.pcard.sel{transform:translateY(-18px)!important'],
  ['出牌动画', '@keyframes pc-card-play'],
  ['动画仅在换牌时触发', 'if (tSig !== lastTableSig) {'],
  ['牌局动态具体牌面', 'function cardsLabel(cards, pattern)'],
  ['牌局动态用具体牌面', "note(who + ' 出 ' + cardsLabel(msg.cards, pattern))"],
  ['静态背景无动画', 'window.PC3D.renderStatic()'],
  ['3D引擎无RAF动画循环', 'function start() { renderStatic(); }'],
  ['3D引擎移除旋转牌', 'MOTION POLICY: this scene is ALWAYS STATIC'],
  ['过牌乐观即时反馈', 'state._passEchoSig'],
  ['过牌防重复计数', 'consume the guard, do not double-count'],
  ['过牌领出者修复', 'only a PLAY (never a pass) may win the trick'],
  ['赢家出局领出顺延', 'function nextActiveSid(fromSid)'],
  ['领出跳过出局座位', 'if (state.finishOrder.indexOf(leadSid) !== -1) {'],
  ['自动理牌按钮', 'id="btn-game-arrange"'],
  ['平铺切换按钮', 'id="btn-game-spread"'],
  ['理牌按点数降序', 'sortHandForView: sortHandForView'],
  ['理牌UI用点数排序', 'return window.PCGame.sortHandForView(cards, st.level)'],
  ['掼蛋引擎', 'root.PCGame = api'],
  ['机器人引擎', 'root.PCBots = api'],
  ['机器人自动理牌', 'function arrange(hand, level, G)'],
  ['机器人自动出牌', 'function botStep(sid)'],
  ['机器人补位座位', "BOT_SIDS = ['bot_1', 'bot_2', 'bot_3']"],
  ['游戏客户端', 'window.PCGameClient = (function'],
  ['3D 引擎', 'window.PC3D = (function'],
  ['豪华版UI', 'window.PCDeluxe = (function'],
  /* Mobile / touch adaptation — keep these fixes from regressing on rebuild. */
  ['移动顶栏两行布局', 'grid-template-areas:"name meta . exit" "game voice mem ."'],
  ['移动手牌可滚到首尾', 'justify-content:safe center'],
  ['移动按钮44px触控', '.game-actions .tool-btn,.game-bottom .tool-btn{min-height:44px'],
  ['PiP触摸拖拽', 'head.addEventListener(\'pointerdown\', down)'],
  ['录音状态反馈', 'b.classList.toggle(\'recording\', state === true)'],
  ['触摸无粘滞悬停', '@media(hover:hover)'],
  ['输入字号防iOS缩放', '.composer input[type=text]{min-width:88px;padding:10px 11px;font-size:16px}'],
  /* Landscape phone adaptation — short/wide viewport must repack the game
   * panel into two columns so hand + play/pass buttons stay on-screen. */
  ['横屏专用布局', '@media(orientation:landscape) and (max-height:520px)'],
  ['横屏两列网格', 'grid-template-areas:'],
  ['横屏堆叠尺寸', 'landscape) and (max-height:520px)\').matches)']
]);
build('豪华版', deluxeParts, deluxeMarkers, 'client/dist/private-chat-deluxe.template.html');

console.log('内联: CSS / PC 协议 / forge / crypto / config / members / net / export / media / app');
console.log('豪华版额外: game / gameclient / engine3d / deluxe');
console.log('保留运行期占位符 __PC_CONFIG__，静态校验通过');
