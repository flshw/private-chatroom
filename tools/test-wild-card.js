/* Regression: 红桃级牌万能牌规则 (wild card) fully wired in.
 * Run: node tools/test-wild-card.js
 */
'use strict';
const assert = require('assert');
const G = require('../client/src/game.js');
const B = require('../client/src/bots.js');

const C = (s, r, id) => ({ s, r, id: id || (s + r) });
const L = 15; // playing 2 -> red heart 2 is the wild
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function names(cands, type) {
  return cands.filter(g => g.pattern.type === type).map(g => g.pattern.rank + ':' + g.cards.map(c => c.s + c.r).join(''));
}

console.log('=== 万能牌规则测试 ===');

// 1) engine recognises wild
check('isWild 红桃级牌', G.isWild(C('H', 15), L) === true);
check('isWild 非红桃不是', G.isWild(C('S', 15), L) === false);
check('isWild 红桃非级牌不是', G.isWild(C('H', 14), L) === false);

// 2) classify resolves wild in a set
check('单张红桃级牌=单张rank16', (() => { const p = G.classify([C('H', 15)], L); return p && p.type === G.TYPE.SINGLE && p.rank === 16; })());
check('3张9+wild=炸弹', (() => { const p = G.classify([C('S', 9), C('H', 9), C('C', 9), C('H', 15, 'w')], L); return p && p.type === G.TYPE.BOMB; })());
check('3,4,6,7+wild=顺子rank7', (() => { const p = G.classify([C('S', 3), C('D', 4), C('C', 6), C('S', 7), C('H', 15, 'w')], L); return p && p.type === G.TYPE.STRAIGHT && p.rank === 7; })());

// 3) bot candidates now include wild gap-fills (the actual bug)
const hand = [C('S', 3), C('D', 4), C('C', 6), C('S', 7), C('H', 15, 'wild')];
const cands = B.candidates(hand, L, G);
check('机器人候选含wild顺子', names(cands, G.TYPE.STRAIGHT).some(x => x.indexOf('H15') >= 0), JSON.stringify(names(cands, G.TYPE.STRAIGHT)));
check('机器人候选含wild对子', names(cands, G.TYPE.PAIR).some(x => x.indexOf('H15') >= 0));

// 4) bot actually beats a table using the wild
const table = G.classify([C('S', 4), C('H', 5), C('C', 6), C('D', 7), C('S', 8)], L); // straight rank 8
const hand2 = [C('S', 5), C('D', 6), C('C', 7), C('S', 8), C('D', 9), C('H', 15, 'wild')];
const move = B.chooseMove({ hand: hand2, tablePattern: table, level: L }, G);
check('机器人用wild顺子跟牌(rank9>rank8)', move && move.pattern.type === G.TYPE.STRAIGHT && move.pattern.rank > table.rank, move ? move.name + ' rank=' + move.pattern.rank : 'PASS');

// 5) straight flush via wild
const h3 = [C('H', 5), C('H', 6), C('H', 7), C('H', 8), C('H', 15, 'wild')];
const sf = names(B.candidates(h3, L, G), G.TYPE.STFLUSH);
check('机器人同花顺用wild', sf.length > 0 && sf.some(x => x.indexOf('H15') >= 0), JSON.stringify(sf));

// 6) bomb via wild beats plain bomb
const h4 = [C('S', 9), C('H', 9), C('C', 9), C('H', 15, 'wild'), C('D', 3)];
const tb = G.classify([C('S', 8), C('H', 8), C('C', 8), C('D', 8)], L);
const mb = B.chooseMove({ hand: h4, tablePattern: tb, level: L }, G);
check('机器人用wild炸弹压炸弹', mb && mb.pattern.type === G.TYPE.BOMB, mb ? mb.name : 'PASS');

// 7) normal hands unchanged (no wild -> no regression)
const h5 = [C('S', 3), C('D', 4), C('C', 6), C('S', 7), C('S', 9)];
const c5 = B.candidates(h5, L, G);
check('无wild手牌仍正常生成候选', c5.length > 0 && c5.every(g => g.pattern && g.pattern.type));

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
