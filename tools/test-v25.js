/* v25 tests: shared Chinese nickname pool + arrange rule fixes.
 * Run: node tools/test-v25.js */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));
const B = require(path.join(__dirname, '..', 'client', 'src', 'bots.js'));
const N = require(path.join(__dirname, '..', 'shared', 'nicknames.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('\n=== v25 共享随机昵称池 ===');
check('昵称数量约100 (90~115)', N.list.length >= 90 && N.list.length <= 115, N.list.length);
check('全部为纯中文2-3字', N.list.every(s => /^[\u4e00-\u9fa5]{2,3}$/.test(s)));
check('无重复', new Set(N.list).size === N.list.length);
['小帅', '小美', '如烟', '柳如烟', '沈知意'].forEach(n =>
  check('含流行漫剧名 ' + n, N.list.indexOf(n) !== -1));
{
  const draws = Array.from({ length: 200 }, () => N.random());
  check('random() 总返回池内名字', draws.every(n => N.list.indexOf(n) !== -1));
  const p = N.pick(3);
  check('pick(3) 返回3个互异名字', p.length === 3 && new Set(p).size === 3, JSON.stringify(p));
}

console.log('\n=== v25 顺子封顶5张 ===');
{
  // 构造 3~10 共8张连续单牌(不同花色避免同花顺抢先)。
  const run = [];
  const suits = ['S', 'H', 'C', 'D'];
  for (let r = 3; r <= 10; r++) run.push({ s: suits[(r - 3) % 4], r, id: 'r' + r });
  const res = B.arrangeWith(run, 15, G, { bombsFirst: true });
  const straights = res.groups.filter(g =>
    g.pattern.type === G.TYPE.STRAIGHT || g.pattern.type === G.TYPE.STFLUSH);
  check('长顺被拆成不超过5张的组', straights.length > 0 && straights.every(g => g.cards.length <= 5),
    JSON.stringify(straights.map(g => g.cards.length)));
  check('拆分后仍覆盖全部8张', run.every(c =>
    res.groups.some(g => g.cards.some(x => x.id === c.id))));
}

console.log('\n=== v25 三带二不合并 / 三张先于对子 ===');
{
  // 三张7 + 一对K + 单3：应出现独立的“三张”组与“对子”组，而不是一个5张三带二。
  const hand = [
    { s: 'S', r: 7, id: 'a' }, { s: 'H', r: 7, id: 'b' }, { s: 'C', r: 7, id: 'c' },
    { s: 'S', r: 13, id: 'd' }, { s: 'H', r: 13, id: 'e' },
    { s: 'C', r: 3, id: 'f' }
  ];
  const res = B.arrangeWith(hand, 15, G, { bombsFirst: true });
  const triple = res.groups.find(g => g.cards.length === 3 && g.pattern.type === G.TYPE.TRIPLE);
  const pair = res.groups.find(g => g.cards.length === 2 && g.pattern.type === G.TYPE.PAIR);
  const fused = res.groups.find(g => g.cards.length === 5);
  check('三张7独立成组', !!triple);
  check('对子K独立成组', !!pair);
  check('没有5张三带二组合', !fused);
}

console.log('\n=== v25 两方案合法性回归 ===');
{
  const hands = G.deal(G.makeDeck());
  hands.forEach((hand, i) => {
    const schemes = B.arrangeSchemes(hand, 15, G);
    schemes.forEach((s, si) => {
      const seen = {};
      let legal = true, overLong = false;
      s.groups.forEach(g => {
        if (!G.classify(g.cards, 15)) legal = false;
        if ((g.pattern.type === G.TYPE.STRAIGHT || g.pattern.type === G.TYPE.STFLUSH) && g.cards.length > 5) overLong = true;
        g.cards.forEach(c => { seen[c.id] = (seen[c.id] || 0) + 1; });
      });
      const cover = hand.every(c => seen[c.id] === 1) && Object.keys(seen).length === hand.length;
      check('第' + (i + 1) + '手方案' + (si + 1) + ': 合法', legal);
      check('第' + (i + 1) + '手方案' + (si + 1) + ': 覆盖27张', cover);
      check('第' + (i + 1) + '手方案' + (si + 1) + ': 顺子≤5', !overLong);
    });
  });
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
