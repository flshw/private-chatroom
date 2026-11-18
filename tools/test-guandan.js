/* Guandan engine unit tests — Node, no dependencies. */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}
/* Build hand from spec like 'S3 S3 H3 D4 ...' (suit+rank). */
function H(spec) {
  return spec.trim().split(/\s+/).map(function (x, i) {
    var s = x[0], rs = x.slice(1);
    var r = rs === 'T' ? 10 : rs === 'J' ? 11 : rs === 'Q' ? 12 :
      rs === 'K' ? 13 : rs === 'A' ? 14 : rs === '2' ? 15 : (+rs);
    return { s: s, r: r, id: 'x' + i };
  });
}

console.log('\n=== 掼蛋规则引擎测试 ===');
const L = 15; // level = 2, wild = H2

/* Deck integrity */
const deck = G.makeDeck();
check('两副牌共 108 张', deck.length === 108);
check('小王/大王各 2 张（可成王炸）',
  deck.filter(c => c.r === 16).length === 2 && deck.filter(c => c.r === 17).length === 2);
check('每个点数每花色各 2 张', deck.filter(c => c.s === 'S' && c.r === 3).length === 2);

/* Dealing */
const hands = G.deal(deck);
check('四人各 27 张', hands.every(h => h.length === 27));
check('发牌无重复', new Set(hands.flat().map(c => c.id)).size === 108);

/* Basic patterns */
check('单张识别', G.classify(H('S5'), L).type === G.TYPE.SINGLE);
check('对子识别', G.classify(H('S5 H5'), L).type === G.TYPE.PAIR);
check('三张识别', G.classify(H('S5 H5 C5'), L).type === G.TYPE.TRIPLE);
check('三带二识别', G.classify(H('S5 H5 C5 S9 H9'), L).type === G.TYPE.TRIPLE_PAIR);
check('顺子识别(5张/混花色)', G.classify(H('S3 H4 C5 D6 S7'), L).type === G.TYPE.STRAIGHT);
check('顺子含A不含2', G.classify(H('ST HJ CQ DK SA'), L).type === G.TYPE.STRAIGHT);
check('假顺子拒绝', G.classify(H('S3 H4 C5 D6 S8'), L) === null);
check('同花顺识别', G.classify(H('S3 S4 S5 S6 S7'), L).type === G.TYPE.STFLUSH);
check('炸弹识别', G.classify(H('S7 H7 C7 D7'), L).type === G.TYPE.BOMB);
check('王炸识别', G.classify(H('W16 W16 W17 W17'), L).type === G.TYPE.ROCKET);
check('钢板识别(333444)', G.classify(H('S3 H3 C3 S4 H4 C4'), L).type === G.TYPE.TRIPLE_STRAIGHT);
check('三连对识别(334455)', G.classify(H('S3 H3 S4 H4 S5 H5'), L).type === G.TYPE.DOUBLE_STRAIGHT);
check('四带二识别', G.classify(H('S7 H7 C7 D7 S9 H9'), L).type === G.TYPE.FOUR_TWO);

/* Wild card (逢人配: level=2, H2 is wild) */
check('逢人配补对子(H2+S5)', G.classify(H('H2 S5'), L).type === G.TYPE.PAIR);
check('逢人配补炸弹', G.classify(H('S8 C8 D8 H2'), L).type === G.TYPE.BOMB);
check('逢人配补顺子', G.classify(H('S3 S4 S5 S6 H2'), L).type === G.TYPE.STFLUSH);
check('逢人配两张补炸弹', G.classify(H('S9 C9 H2 H2'), L).type === G.TYPE.BOMB);

/* Comparison */
const bomb = G.classify(H('S7 H7 C7 D7'), L);
const straight = G.classify(H('S3 H4 C5 D6 S7'), L); // 混花色顺子
const pairHi = G.classify(H('SA HA'), L);
const pairLo = G.classify(H('S9 H9'), L);
const levelPair = G.classify(H('S2 H2'), L); // level pair, value 16
check('炸弹压顺子', G.canBeat(bomb, straight, L));
check('顺子不能压炸弹', !G.canBeat(straight, bomb, L));
check('大对子压小对子', G.canBeat(pairHi, pairLo, L));
check('级牌对子压A对子', G.canBeat(levelPair, pairHi, L));
check('不同牌型不可压', !G.canBeat(pairHi, straight, L));
const rocket = G.classify(H('W16 W16 W17 W17'), L);
check('王炸压一切', G.canBeat(rocket, bomb, L) && !G.canBeat(bomb, rocket, L));

/* Level progression & tribute */
check('双上升3级', G.levelDelta([0, 2, 1, 3], [0, 1, 0, 1]) === 3);
check('头三升2级', G.levelDelta([0, 1, 2, 3], [0, 1, 0, 1]) === 2);
check('头末升1级', G.levelDelta([0, 1, 3, 2], [0, 1, 0, 1]) === 1);
check('识别双下', G.isDoubleDown([0, 2, 1, 3], [0, 1, 0, 1]) === true);
const hbs = { 0: H('W17 S3'), 1: H('W17 S4') };
check('两张大王可抗贡', G.canResist(hbs, [0, 1, 0, 1], [0, 1]) === true);
check('不足两张大王不可抗贡', G.canResist({ 0: H('W17 S3'), 1: H('S4 S5') }, [0, 1, 0, 1], [0, 1]) === false);

/* applyTribute: central 进贡/还贡/抗贡 resolution */
{
  const teams = [0, 1, 0, 1];
  // Single-down: 大科=seat0, 大拉=seat3. seat3 must pay its biggest card (大王 r17)
  // to seat0, and seat0 returns its smallest card (a 3).
  const hands = [
    H('S3 H4 D5'),            // seat0 winner
    H('S6 H7 D8'),            // seat1
    H('S9 H10 D11'),          // seat2
    H('S12 H13 W17')          // seat3 loser, biggest = 大王
  ];
  const before = hands.map(h => h.length);
  const tr = G.applyTribute(hands, [0, 1, 2, 3], teams, 15);
  check('单下: 大拉向大科进贡一张', tr.events.some(e => e.action === 'tribute' && e.from === 3 && e.to === 0 && e.card.r === 17), JSON.stringify(tr.events));
  check('单下: 大科还贡一张小牌', tr.events.some(e => e.action === 'return' && e.from === 0 && e.to === 3 && e.card.r === 3), JSON.stringify(tr.events));
  check('进贡还贡后各家张数不变', tr.hands.every((h, i) => h.length === before[i]), JSON.stringify(tr.hands.map(h => h.length)));
  check('单下首出为大科(seat0)', tr.firstSeat === 0, 'first=' + tr.firstSeat);
  check('进贡牌确实离开输家手牌', !tr.hands[3].some(c => c.r === 17), JSON.stringify(tr.hands[3]));
}
{
  const teams = [0, 1, 0, 1];
  // Double-down (team0 top two): both losers pay. If the losing side holds both
  // big jokers they resist and NO cards change hands.
  // finishOrder [0,2,1,3]: team0 (seat0,seat2) wins double; losers = seat1,seat3.
  const h4 = [H('S3 H4'), H('W17 S9'), H('S5 H6'), H('W17 S10')];
  const tr = G.applyTribute(h4, [0, 2, 1, 3], teams, 15);
  check('双下+输家双大王 => 抗贡成功', tr.resisted === true && tr.events.some(e => e.action === 'resist'), JSON.stringify(tr.events));
  check('抗贡时不发生进贡', !tr.events.some(e => e.action === 'tribute'), JSON.stringify(tr.events));
  check('抗贡时手牌张数不变', tr.hands.every((h, i) => h.length === h4[i].length), 'ok');
}
{
  const teams = [0, 1, 0, 1];
  // Double-down without jokers: losers seat1 & seat3 each pay biggest to a winner.
  const h4 = [H('S3 H4'), H('W17 S9'), H('S5 H6'), H('S12 H13')];
  const tr = G.applyTribute(h4, [0, 2, 1, 3], teams, 15);
  check('双下: 两名输家都进贡', tr.events.filter(e => e.action === 'tribute').length === 2, JSON.stringify(tr.events));
  check('双下: 两名赢家都还贡', tr.events.filter(e => e.action === 'return').length === 2, JSON.stringify(tr.events));
  check('双下首出为进贡方(seat3)', tr.firstSeat === 3, 'first=' + tr.firstSeat);
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
