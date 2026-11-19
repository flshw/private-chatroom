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
  '__NICKNAMES__': safeJs(read('shared/nicknames.js')),
  '__MEMBERS__': safeJs(read('client/src/members.js')),
  '__NET__': safeJs(read('client/src/net.js')),
  '__EXPORT__': safeJs(read('client/src/export.js')),
  '__MEDIA__': safeJs(read('client/src/media.js')),
  '__APP__': safeJs(read('client/src/app.js'))
};

const baseMarkers = [
  ['PC 协议', 'root.PCProtocol = api'],
  ['配置校验', 'window.PCConfig = (function'],
  ['随机昵称模块', 'root.PCNicknames = api'],
  ['随机昵称按钮', 'id="btn-random-nick"'],
  ['随机昵称生成', 'window.PCNicknames.random()'],
  ['加密模块', 'window.PCCrypto = (function'],
  ['成员表', 'window.PCMembers = (function'],
  ['网络层', 'window.PCNet = function'],
  ['导出模块', 'window.PCExport = (function'],
  ['媒体模块', 'window.PCMedia = function'],
  ['localStorage 密钥持久化', "localStorage.setItem(ukStoreKey(roomId)"],
  ['退出房间按钮', 'id="btn-exit"'],
  ['退出房间流程', 'function leaveRoom()'],
  ['启动脚本', 'boot();'],
  /* v22: E2EE security + seq reliability (both editions) */
  ['SSK指纹白名单', 'var KNOWN_SSK_FP = ['],
  ['配置指纹校验', 'sskFingerprint(config.serverPubKey)'],
  ['验签拒绝帧内公钥', 'var verifyWith = senderUkPub;'],
  ['拒绝未验签发送者', 'MSG-DROP unverified sender='],
  ['服务端确认seq对齐', 'SEQ-RESYNC'],
  ['历史消息去重', 'state.msgKeys[dkey]'],
  ['历史sid归属', 'state.mySids[env.senderSid]'],
  ['成员表epoch', 'memberList.epoch != null'],
  /* v29: full-duplex live voice REMOVED; encrypted voice clips kept. */
  ['全双工语音已移除', html => html.indexOf('VOICE-AUTOJOIN') === -1 && html.indexOf('btn-voice-live') === -1 && html.indexOf('RTCPeerConnection') === -1],
  ['语音包多编码探测', 'audio/webm;codecs=opus'],
  ['语音包内联播放器', 'voice-clip'],
  ['视频入口已移除', html => html.indexOf('id="btn-video"') === -1 && html.indexOf('video-overlay') === -1]
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
  for (const entry of markers) {
    const [label, marker] = entry;
    const pass = typeof marker === 'function' ? marker(html) : html.indexOf(marker) !== -1;
    if (!pass) throw new Error(version + ' 内联模块缺失/校验失败: ' + label);
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
  ['到期锁定游戏控件', 'function setExpired()'],
  ['到期锁定接入', 'window.PCDeluxe.setExpired) window.PCDeluxe.setExpired()'],
  ['出牌端到期守卫', 'if (expiredUI) { if (ctx && ctx.toast) ctx.toast(\'房间已解散或到期，无法继续操作\'); return; }'],
  ['3D 画布层级', '#chat>#scene3d{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}'],
  ['刷新自动续进', 'var nick = savedNickname();'],
  ['两版通用续进', 'if (cached && nick) {'],
  ['四人开局门槛', 'membersList.length >= 4'],
  ['三人选座开局', 'game.requestStart([mySid].concat(picked), partner);'],
  ['记牌器面板', 'id="card-counter"'],
  ['选座面板', 'id="game-setup"'],
  ['选人弹窗遮罩', 'id="game-setup-mask"'],
  ['自动预选规则', 'membersList.length === 4'],
  ['理牌与出牌同排', 'class="game-bottom"'],
  ['出牌统计', 'state.played.push('],
  ['手牌同类堆叠', "className = 'pcard-stack'"],
  ['纵向扇形堆叠', 'stepY * (g.cards.length - 1))'],
  ['移动端堆叠尺寸自适应', "cardW = 36; cardH = 52; stepX = 8; stepY = 18"],
  ['选牌保持滚动位置', 'if (prevScroll) hand.scrollLeft = prevScroll'],
  ['单张可选', 'function toggleOne(c)'],
  ['牌面角标花色', "corner.className = 'pip'"],
  ['出牌区居中', '.game-table{width:min(100%,560px)'],
  ['v30侧栏垂直居中左侧', '.game-log{left:16px}'],
  ['v30侧栏垂直居中右侧', '.game-chat{right:16px}'],
  ['游戏浮层透出聊天', 'pointer-events:none}'],
  ['记牌器放大', 'font-size:15px;color:var(--ink)'],
  ['过牌始终可点', 'btnPass.disabled = !inPlay'],
  ['过牌无反馈修复', '你是本轮首位领出，请先出牌'],
  ['过牌自我反馈', "by === mySid ? '你'"],
  ['机器人放慢', 'botThinkMs = 1400'],
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
  ['过牌乐观即时反馈', 'state._myPassPending'],
  ['过牌防重复计数', 'state._myPassPending--;'],
  ['过牌领出者修复', 'only a PLAY (never a pass) may win the trick'],
  ['赢家出局领出顺延', 'function nextActiveSid(fromSid)'],
  ['领出跳过出局座位', 'if (state.finishOrder.indexOf(leadSid) !== -1) {'],
  ['机器人回合看门狗', 'function armBotWatchdog(sid)'],
  ['看门狗超时重驱', 'BOT_WATCHDOG_MS'],
  ['渲染异常隔离不含状态推进', 'UI rendering must never be able to abort game-state progression'],
  ['onPlay最终必推进回合', 'then ALWAYS advance the'],
  ['空手牌机器人顺延', 'Turn landed on a cardless bot'],
  ['自动理牌按钮', 'id="btn-game-arrange"'],
  ['理牌循环四模式', 'arrangeMode = (arrangeMode + 1) % 4'],
  ['理牌四模式文案', "var ARRANGE_LABELS = ['↔ 平铺', '▤ 堆叠', '🔥 火力', '🀄 少手']"],
  ['理牌方案生成', 'function arrangeSchemes(hand, level, G)'],
  ['理牌方案按组合堆叠', 'st.arrangeGroups'],
  ['理牌UI用点数排序', 'return window.PCGame.sortHandForView(cards, st.level)'],
  ['掼蛋引擎', 'root.PCGame = api'],
  ['机器人引擎', 'root.PCBots = api'],
  ['机器人跟牌穷举所有牌型', 'also enumerate straights, double/triple straights and straight flushes from'],
  ['机器人自动理牌', 'function arrange(hand, level, G)'],
  ['机器人自动出牌', 'function botStep(sid)'],
  ['机器人诊断日志缓冲', 'var DIAG_MAX = 400;'],
  ['机器人诊断导出接口', 'self.diagText = diagText'],
  ['机器人异步发送失败可捕获', 'SEND-REJECT'],
  ['机器人同步发送失败可捕获', 'SEND-SYNC-ERR'],
  /* Half-open connection + hand-burning fixes (v18): a stuck CONNECTING socket
   * never fired onclose so the bot turn froze for 25s; rejected plays silently
   * ate one card per watchdog re-drive. Both must stay in the bundle. */
  ['连接建立超时看门狗', 'CONNECT-TIMEOUT'],
  ['心跳死亡检测', 'HEARTBEAT-DEAD'],
  ['重连幂等调度', 'function scheduleReconnect()'],
  ['连接就绪状态接口', 'this.readyState = function ()'],
  ['机器人手牌发送失败回滚', 'HANDS-ROLLBACK'],
  ['诊断日志全链路-决策', "dlog('DECIDE'"],
  ['诊断日志全链路-回显', "dlog('ECHO-PLAY'"],
  ['诊断日志全链路-回合推进', "dlog('ADVANCE'"],
  ['诊断日志全链路-结算', "dlog('MATCH-OVER'"],
  ['游戏帧不再静默吞掉', 'GAME-FRAME-MALFORMED'],
  ['seq提交制修复卡死', 'state.seq = usedSeq; // commit only after a successful hand-off'],
  ['断线不消耗seq', 'seq rolled back from'],
  ['REPLAY错误可见', '消息时序错乱(REPLAY)'],
  ['外部错误接入诊断', 'self.noteDiag = function'],
  /* v19: reconnect resilience — sid migration preserves the match, connection
   * layer events enter the diagnosis panel, history game frames are skipped. */
  ['重连sid迁移接口', 'self.updateMySid = function (newSid)'],
  ['重连sid迁移日志', 'SID-MIGRATE'],
  ['重连恢复牌局日志', 'RECONNECT-RESUME'],
  ['enterChat幂等', 'if (chatReady && game) {'],
  ['历史game帧跳过', 'if (skipGameHistory) return;'],
  ['连接层诊断接入', 'onDiag: function (tag, detail)'],
  ['建连诊断', "diag('NET-CONNECT'"],
  ['断连诊断', "diag('NET-CLOSE'"],
  ['重连调度诊断', "diag('NET-RECONNECT-SCHED'"],
  ['诊断面板UI', 'id="diag-panel"'],
  ['诊断复制按钮', 'id="btn-diag-copy"'],
  ['诊断下载按钮', 'id="btn-diag-download"'],
  ['诊断面板样式', '#diag-panel{position:fixed'],
  ['机器人补位座位', "BOT_SIDS = ['bot_1', 'bot_2', 'bot_3']"],
  ['游戏客户端', 'window.PCGameClient = (function'],
  ['3D 引擎', 'window.PC3D = (function'],
  ['豪华版UI', 'window.PCDeluxe = (function'],
  /* Mobile / touch adaptation — keep these fixes from regressing on rebuild. */
  ['移动顶栏两行布局', 'grid-template-areas:"name meta . exit" "game mem . ."'],
  ['移动手牌可滚到首尾', 'justify-content:safe center'],
  ['移动按钮44px触控', '.game-bottom .tool-btn{min-height:44px'],
  ['全双工语音已移除', html => html.indexOf('btn-voice-live') === -1 && html.indexOf('pipShowStatus') === -1],
  ['录音状态反馈', 'b.classList.toggle(\'recording\', rec)'],
  ['触摸无粘滞悬停', '@media(hover:hover)'],
  ['输入字号防iOS缩放', '.composer input[type=text]{min-width:88px;padding:10px 11px;font-size:16px}'],
  /* Landscape phone adaptation — short/wide viewport must repack the game
   * panel into two columns so hand + play/pass buttons stay on-screen. */
  ['横屏专用布局', '@media(orientation:landscape) and (max-height:520px)'],
  ['横屏两列网格', 'grid-template-areas:'],
  ['横屏堆叠尺寸', 'landscape) and (max-height:520px)\').matches)'],
  /* v20: full-round settlement + next round + partner pick + per-seat display */
  ['结算四位名次', "var RANK_TITLES = ['大科', '二科', '二拉', '大拉']"],
  ['结算收官函数', 'function finishRound()'],
  ['三人出局才结算', 'state.finishOrder.length >= 3) finishRound()'],
  ['下一局接口', 'self.nextRound = nextRound'],
  ['新一局递增局号', 'state.roundNo = (state.roundNo || 0) + 1'],
  ['对家随发牌广播', 'partner: state.partnerSid'],
  ['选对家接口', 'function requestStart(players, partnerSid)'],
  ['选对家UI', 'id="partner-picks"'],
  ['对家座位排布', 'seat2 (opposite) becomes the teammate'],
  /* v29: compass seat layout + enlarged play button + 2-char gaps. */
  ['座位按角色方位类名', "el.className = 'seat seat-pos-' + rolePos"],
  ['本人座位框已删除', "if (s && s.isMe) continue;"],
  ['对家在上方', "if (s && st.partnerSid === s.sid) rolePos = 'top'"],
  ['对手在左右', "(oppSeen++ === 0) ? 'left' : 'right'"],
  ['座位绝对定位', '.seat.seat-pos-top{left:50%;top:0;transform:translateX(-50%)}'],
  ['记牌器与级别同行', 'class="game-headrow"'],
  ['游戏聊天侧栏UI', 'id="game-chat"'],
  ['游戏聊天右侧对称', '.game-chat{right:16px}'],
  ['牌局动态高度加大', 'max-height:66vh'],
  ['出牌按钮8字符宽', '.game-bottom #btn-game-play{flex:0 0 8em;width:8em;min-width:0;max-width:8em}'],
  ['按钮间隔2字符', '.game-bottom{display:flex;gap:2em;justify-content:center'],
  ['我的信息条UI', 'id="my-info-bar"'],
  ['我的信息条居中样式', '.my-info-bar{display:flex;gap:14px;align-items:center;justify-content:center;width:max-content'],
  ['结算面板UI', 'id="game-settle"'],
  ['确认下一局按钮', 'id="btn-settle-next"'],
  ['结算面板渲染', 'function renderSettle(st)'],
  ['每座位最后出牌', 'state.seatPlays[msg.by] = { cards:'],
  ['每座位出牌展示', "className = 'seat-play'"],
  ['过牌座位标记', "state.seatPlays[by] = { cards: [], passed: true }"],
  ['低牌数显示', "'剩 ' + left + ' 张'"],
  ['每堆全选按钮', "className = 'stack-all'"],
  ['框选常驻开启', "hand.classList.add('marquee-on')"],
  ['框选按钮已移除', html => html.indexOf('id="btn-game-marquee"') === -1],
  ['框选实现', 'function initMarquee()'],
  ['框选覆盖层样式', '.hand-marquee{position:absolute'],
  ['结算面板样式', '#game-settle-mask{position:fixed'],
  /* seq竞态: 发送队列串行化, 修复同tick PLAY/FINISHED 同seq的 E_REPLAY */
  ['seq发送队列', 'function enqueueSend(task)'],
  ['seq队列串行调用', 'return enqueueSend(function () { return sendKindNow(plaintext, kind); });'],
  /* v21: 红桃级牌万能牌接入 + 框选定位修复 + 牌局动态滚动条 */
  ['万能牌引擎isWild', "function isWild(card, level) { return card.s === 'H' && card.r === level; }"],
  ['万能牌引擎枚举替换', 'function classify(cards, level) {'],
  ['万能牌机器人候选', 'function addWildCandidates(hand, level, G, addDirect)'],
  ['万能牌补缺调用', 'addWildCandidates(hand, level, G, addDirect);'],
  ['框选手牌定位容器', '.my-hand{position:relative'],
  ['框选滚动坐标修正', 'x: e.clientX - r.left + hand.scrollLeft'],
  ['框选拖拽阈值', 'DRAG_TH = 6'],
  ['牌局动态半透明背景', 'background:rgba(10,16,34,.62)'],
  ['牌局动态常显滚动条', 'overflow-y:scroll;overflow-x:hidden'],
  /* v22: 规则完整性 + 状态可靠性 + XSS (deluxe only) */
  ['昵称XSS修复', "who.textContent = r.nickname + (r.isMe ? '（我）' : '')"],
  ['进贡规则引擎', 'function applyTribute(hands, finishOrder, teamOf, level)'],
  ['进贡发牌接入', 'window.PCGame.applyTribute(hands'],
  ['进贡首出权', 'msg.tribute.firstSeat'],
  ['两级队各自升级', 'teamLevel: state.teamLevel.slice()'],
  ['级数序列无跳级', 'var LEVEL_SEQ = [15, 3, 4'],
  ['通关终局', 'state.seasonCleared = adv.cleared'],
  ['陈旧帧丢弃', 'STALE-DROP'],
  ['出牌失败回滚', '出牌未送达，已撤销本地出牌'],
  ['过牌失败回滚', '过牌未送达，已撤销本地过牌'],
  ['过牌回显计数', '_myPassPending'],
  ['名次合法性校验', 'FINISHED-REJECT'],
  ['重复出牌告警', 'PLAY-SUSPECT'],
  /* v29: spectator/video/full-duplex voice all removed; encrypted voice-clip
   * player kept. These must hold in the built deluxe bundle. */
  ['旁观入口已移除', html => html.indexOf('btn-spectate') === -1 && html.indexOf('spectate-picker') === -1],
  ['视频通话已移除', html => html.indexOf('id="btn-video"') === -1 && html.indexOf('video-overlay') === -1 && html.indexOf('pip-video') === -1],
  ['全双工语音已移除', html => html.indexOf('VOICE-AUTOJOIN') === -1 && html.indexOf('btn-voice-live') === -1 && html.indexOf('RTCPeerConnection') === -1],
  ['语音包多编码探测', 'audio/webm;codecs=opus'],
  ['语音包60秒上限', 'MAX_VOICE_MS'],
  ['语音包播放器', 'voice-clip'],
  /* v23 rule correctness: 2 weakest when not level; 接风 leads to winner's
   * partner (opposite seat), never the next player on the right. */
  ['2牌力规则', 'a plain 2 is the smallest card when not playing 2'],
  ['接风对家领出', 'leadAfterWinner'],
  ['接风队友座位', 'state.seats[(i + 2) % 4]'],
  /* v24: tip removed, diag in topbar, smarter bots, two arrange schemes,
   * box-select always on and arrange/pass/play on ONE row. */
  ['牌桌提示已删除', html => html.indexOf('同类牌纵向叠放') === -1],
  ['诊断按钮在顶栏时间旁', html => {
    var meta = html.indexOf('id="remain"'), diag = html.indexOf('id="btn-game-diag"');
    return meta > -1 && diag > meta && html.indexOf('id="game-panel"') > diag;
  }],
  ['机器人主攻助攻策略', 'function handPower(hand, level, G)'],
  ['机器人有鬼打一张', '有鬼打一张(探路)'],
  ['机器人配合队友不炸对家', '配合队友：不炸对家'],
  ['机器人拦牌及时炸', '拦牌·及时炸'],
  ['机器人策略诊断字段', 'move.why'],
  ['组合标签堆叠显示', "'stack-label'"],
  ['按钮4字符固定宽度', 'flex:0 0 4.6em;width:4.6em;min-width:0;max-width:4.6em'],
  ['理牌按钮短文案', 'b.textContent = r.label;'],
  ['底部按钮顺序理牌出牌过牌', html => {
    var b = html.slice(html.indexOf('class="game-bottom"'));
    var a = b.indexOf('btn-game-arrange'), p = b.indexOf('btn-game-play'), s = b.indexOf('btn-game-pass');
    return a > -1 && a < p && p < s;
  }],
  ['机器人牌型用引擎权威描述符', 'var real = G.classify(cs, level);   // authoritative descriptor'],
  ['顺子封顶5张', 'var MAX_RUN = 5;'],
  ['钢板恰好2组(禁777888999)', 'tripRanks.length === 2 && tripRanks.length === ranks.length'],
  ['三连对恰好3对', 'pairRanks.length === 3 && pairRanks.length === ranks.length'],
  ['同花顺恰好5张', 'if (cards.length !== 5 || cards.some(isJoker)) return null;'],
  ['重复告警先查后记(无误报)', 'var reusedBefore = 0;'],
  ['三带二不合并', '三带二 is intentionally NOT fused'],
  ['三张先于对子', 'if (cnt[r] >= 3) take(pickRank(pool, r, 3));'],
  ['机器人复用昵称池', 'BOT_NAME_SEEDS']
]);
build('豪华版', deluxeParts, deluxeMarkers, 'client/dist/private-chat-deluxe.template.html');

console.log('内联: CSS / PC 协议 / forge / crypto / config / members / net / export / media / app');
console.log('豪华版额外: game / gameclient / engine3d / deluxe');
console.log('保留运行期占位符 __PC_CONFIG__，静态校验通过');
