/* v27 regression: bot play descriptors MUST match classify() — the root cause
 * of "机器人有牌不跟 / 出牌逻辑有问题". Wild gap-fill candidates used to carry
 * a hand-built (under-estimated) rank; decisions were made on the wrong strength.
 * Run: node tools/test-bot-descriptor.js */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));
const B = require(path.join(__dirname, '..', 'client', 'src', 'bots.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('\n=== v27 候选牌型描述符 = 引擎权威结果 ===');
{
  let total = 0, bad = 0;
  const example = [];
  for (let it = 0; it < 120; it++) {
    const level = 3 + Math.floor(Math.random() * 13);
    for (const hand of G.deal(G.makeDeck())) {
      for (const g of B.candidates(hand, level, G)) {
        total++;
        const real = G.classify(g.cards, level);
        if (!real || real.type !== g.pattern.type || real.len !== g.pattern.len ||
            real.rank !== g.pattern.rank) {
          bad++;
          if (example.length < 5) example.push(JSON.stringify({
            declared: g.pattern, real: real,
            cards: g.cards.map(c => c.r + '' + (c.s || ''))
          }));
        }
      }
    }
  }
  check('大样本候选零描述符错配', bad === 0, bad + '/' + total + ' ' + example.join(' '));
}

console.log('\n=== v27 经典 wild 低估案例 ===');
{
  // 打2(level=15): 10♠ J♠ Q♠ + 两张红桃2(wild) → 实为 A-high 同花顺
  const hand = [
    { s: 'S', r: 10, id: 'a' }, { s: 'S', r: 11, id: 'b' }, { s: 'S', r: 12, id: 'c' },
    { s: 'H', r: 15, id: 'w1' }, { s: 'H', r: 15, id: 'w2' }
  ];
  const cands = B.candidates(hand, 15, G);
  const sf = cands.filter(g => g.pattern.type === G.TYPE.STFLUSH);
  check('生成同花顺候选', sf.length > 0);
  check('同花顺 rank = A(14) 而非 Q(12)', sf.some(g => g.pattern.rank === 14),
    'ranks=' + sf.map(g => g.pattern.rank).join(','));
  sf.forEach(g => {
    const real = G.classify(g.cards, 15);
    check('候选与引擎同花顺一致', real && real.type === g.pattern.type && real.rank === g.pattern.rank);
  });
}

console.log('\n=== v27 机器人决策 = 实际可压牌 ===');
{
  let dec = 0, illegal = 0, cannotBeat = 0;
  for (let it = 0; it < 80; it++) {
    const level = 3 + Math.floor(Math.random() * 13);
    const hands = G.deal(G.makeDeck());
    for (let s = 0; s < 4; s++) {
      const hand = hands[s];
      let m = B.chooseMove({ hand, tablePattern: null, level }, G);
      if (m) {
        dec++;
        const real = G.classify(m.cards, level);
        if (!real || real.type !== m.pattern.type || real.rank !== m.pattern.rank) illegal++;
      }
      if (hand.length >= 2) {
        const table = G.classify([hand[0], hand[1]], level);
        m = B.chooseMove({ hand, tablePattern: table, level }, G);
        if (m) {
          dec++;
          const real = G.classify(m.cards, level);
          if (!real || real.type !== m.pattern.type || real.rank !== m.pattern.rank) illegal++;
          if (!G.canBeat(real, table, level)) cannotBeat++;
        }
      }
    }
  }
  check('决策牌型全部合法且一致', illegal === 0, illegal + '/' + dec);
  check('打出的牌确实能压桌面', cannotBeat === 0, cannotBeat + '/' + dec);
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
