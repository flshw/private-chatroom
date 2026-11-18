/* v24 strategy + arrange-scheme tests. Run: node tools/test-v24-strategy.js */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));
const B = require(path.join(__dirname, '..', 'client', 'src', 'bots.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('\n=== v24 理牌方案（火力集中 / 少手数）===');
const hands = G.deal(G.makeDeck());
hands.forEach((hand, i) => {
  const schemes = B.arrangeSchemes(hand, 15, G);
  check('第' + (i + 1) + '手: 生成两种方案', schemes.length === 2 &&
    schemes[0].name.indexOf('火力') >= 0 && schemes[1].name.indexOf('少手') >= 0);
  schemes.forEach((s, si) => {
    const seen = {};
    let legal = true;
    s.groups.forEach(g => {
      if (!G.classify(g.cards, 15)) legal = false;
      g.cards.forEach(c => { seen[c.id] = (seen[c.id] || 0) + 1; });
    });
    let cover = hand.every(c => seen[c.id] === 1) && Object.keys(seen).length === hand.length;
    check('第' + (i + 1) + '手 方案' + (si + 1) + ': 每组合法', legal);
    check('第' + (i + 1) + '手 方案' + (si + 1) + ': 覆盖27张不重复', cover);
    check('第' + (i + 1) + '手 方案' + (si + 1) + ': order与groups一致',
      s.order.length === hand.length &&
      new Set(s.order.map(c => c.id)).size === hand.length);
  });
});

console.log('\n=== v24 少手数方案质量（统计正确）===');
{
  const s1 = B.arrangeWith(hands[0], 15, G, { bombsFirst: true });
  const s2 = B.arrangeWith(hands[0], 15, G, { bombsFirst: false });
  check('stats.tricks 与 groups 数一致', s1.tricks === s1.groups.length && s2.tricks === s2.groups.length);
  check('stats.bombs 计数炸弹/同花顺/王炸', s1.bombs === s1.groups.filter(g =>
    [G.TYPE.BOMB, G.TYPE.ROCKET, G.TYPE.STFLUSH].indexOf(g.pattern.type) >= 0).length);
  check('每套方案 handPower 可计算（不抛错）', typeof B.handPower(hands[0], 15, G) === 'number');
}

console.log('\n=== v24 机器人策略 ===');
{
  // 有鬼打一张: 手握大王 + 一堆小单，领出应为最小单张。
  const hand = [
    { s: 'W', r: 17, id: 'j1' },
    { s: 'S', r: 3, id: 'a' }, { s: 'H', r: 4, id: 'b' },
    { s: 'C', r: 5, id: 'c' }, { s: 'D', r: 9, id: 'd' },
    { s: 'S', r: 10, id: 'e' }, { s: 'H', r: 12, id: 'f' }
  ];
  const lead = B.chooseMove({ hand, tablePattern: null, level: 15 }, G);
  check('有鬼打一张: 领出单张探路', !!lead && lead.cards.length === 1 &&
    lead.why === '有鬼打一张(探路)', lead && (lead.name + '/' + lead.why));
}
{
  // 配合队友: 桌面是对家出的, 只用炸弹能压 -> 应 PASS。
  const hand = [
    { s: 'S', r: 6, id: 'x1' }, { s: 'H', r: 6, id: 'x2' },
    { s: 'C', r: 6, id: 'x3' }, { s: 'D', r: 6, id: 'x4' },
    { s: 'S', r: 3, id: 'x5' }, { s: 'H', r: 4, id: 'x6' },
    { s: 'C', r: 5, id: 'x7' }, { s: 'D', r: 7, id: 'x8' },
    { s: 'S', r: 8, id: 'x9' }, { s: 'H', r: 9, id: 'xa' },
    { s: 'C', r: 10, id: 'xb' }, { s: 'D', r: 11, id: 'xc' },
    { s: 'S', r: 12, id: 'xd' }
  ];
  const table = G.classify([
    { s: 'S', r: 14, id: 't1' }
  ], 15); // 单张A — 我只有炸弹能压(单张最大是Q)
  const ctx = {
    hand, tablePattern: table, level: 15,
    mySid: 'me', bySid: 'mate',
    teamOf: s => (s === 'me' || s === 'mate') ? 0 : 1,
    remaining: () => 10
  };
  const mv = B.chooseMove(ctx, G);
  check('配合队友: 对家领出时不炸对家', mv === null, mv && (mv.name + '/' + mv.why));
  // 同一手牌, 桌面是对手出的 -> 应炸(拦牌/唯一可压)
  const ctx2 = Object.assign({}, ctx, {
    bySid: 'foe', teamOf: s => (s === 'me') ? 0 : 1, remaining: () => 10
  });
  const mv2 = B.chooseMove(ctx2, G);
  check('对手牌: 唯一可压时用炸弹', !!mv2 && mv2.cards.length === 4 &&
    G.classify(mv2.cards, 15).type === G.TYPE.BOMB, mv2 && (mv2.name + '/' + mv2.why));
}
{
  // 无上下文的 verify-follow 不变式: 有炸弹也不 PASS（除非对家上下文）。
  const hand = [
    { s: 'S', r: 6, id: 'x1' }, { s: 'H', r: 6, id: 'x2' },
    { s: 'C', r: 6, id: 'x3' }, { s: 'D', r: 6, id: 'x4' }
  ];
  const table = G.classify([{ s: 'S', r: 3, id: 't' }], 15);
  const mv = B.chooseMove({ hand, tablePattern: table, level: 15 }, G);
  check('无上下文: 有可压牌绝不PASS', !!mv && G.canBeat(mv.pattern, table, 15));
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
