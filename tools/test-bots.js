/* Unit + self-play test for the Guandan bot engine. Run: node tools/test-bots.js */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));
const B = require(path.join(__dirname, '..', 'client', 'src', 'bots.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('\n=== 机器人理牌/出牌引擎 ===');

// 1. deal 4 hands, arrange each: every group must be a legal pattern, and all
//    27 cards must be covered exactly once.
let deck = G.makeDeck();
let hands = G.deal(deck);
let allCardsOk = true, allLegal = true, totalGroups = 0, maxSingles = 0;
hands.forEach((hand) => {
  const a = B.arrange(hand, 15, G);
  totalGroups += a.groups.length;
  maxSingles = Math.max(maxSingles, a.singles);
  const seen = {};
  a.groups.forEach((g) => {
    if (!G.classify(g.cards, 15)) allLegal = false;
    g.cards.forEach((c) => { seen[c.id] = (seen[c.id] || 0) + 1; });
  });
  hand.forEach((c) => { if (seen[c.id] !== 1) allCardsOk = false; });
});
check('理牌覆盖每手全部 27 张且不重复', allCardsOk);
check('理牌产出的每个组合都是合法牌型', allLegal);
// Big off-suit cards / lone jokers cannot always be folded — 27 cards may
// legitimately leave ~10 singles. What matters is that singles stay a clear
// minority of the hand and overall trick count drops well below 27.
check('理牌显著去单化（单张 < 手牌 40%）', maxSingles < 27 * 0.4, 'max=' + maxSingles);
check('理牌把 27 张压缩为 <= 16 手', totalGroups / 4 <= 16, 'avg=' + (totalGroups / 4).toFixed(1));

// 2. sortedHand preserves the exact card multiset.
const sh = B.sortedHand(hands[0], 15, G).map((c) => c.id).sort().join(',');
const oh = hands[0].map((c) => c.id).sort().join(',');
check('sortedHand 仅重排不增删牌', sh === oh);

// 3. leading move is a non-bomb playable pattern.
const lead = B.chooseMove({ hand: hands[0], tablePattern: null, level: 15 }, G);
check('领出返回合法非炸弹牌型', !!lead && !!G.classify(lead.cards, 15) &&
  G.classify(lead.cards, 15).type !== G.TYPE.BOMB);

// 4. answering: when a tiny single sits on table, bot must produce a beating
//    single or pass; whatever it plays is legal and beats the table.
let tablePattern = G.classify([{ s: 'S', r: 3, id: 't3' }], 15);
const ans = B.chooseMove({ hand: hands[1], tablePattern: tablePattern, level: 15 }, G);
check('应牌若出牌必合法且能压桌面',
  ans === null || (G.classify(ans.cards, 15) && G.canBeat(ans.pattern, tablePattern, 15)));

// 5. self-play: four bots play one full match; must terminate and someone empties hand.
function selfPlay() {
  let hs = G.deal(G.makeDeck()).map((h) => G.sortHand(h, 15));
  let table = null, tableBy = -1, passes = 0, turn = 0, finished = [];
  let guard = 0;
  while (finished.length < 3 && guard++ < 600) {
    if (finished.indexOf(turn) !== -1) { turn = (turn + 1) % 4; continue; }
    const mv = B.chooseMove({ hand: hs[turn], tablePattern: table, level: 15 }, G);
    if (mv === null) {
      passes++;
      if (table === null) { turn = (turn + 1) % 4; continue; } // cannot pass when leading
      if (passes >= 3 - finished.length) { table = null; passes = 0; turn = tableBy; }
      else turn = (turn + 1) % 4;
      continue;
    }
    // apply
    const ids = {};
    mv.cards.forEach((c) => ids[c.id] = true);
    hs[turn] = hs[turn].filter((c) => !ids[c.id]);
    table = mv.pattern; tableBy = turn; passes = 0;
    if (hs[turn].length === 0 && finished.indexOf(turn) === -1) finished.push(turn);
    turn = (turn + 1) % 4;
  }
  return { finished, guard };
}
const sp = selfPlay();
check('机器人自对战能正常分出胜负（至少 3 家出完）', sp.finished.length >= 3,
  'finished=' + sp.finished.length + ' turns=' + sp.guard);
check('自对战未在步数上限卡死', sp.guard < 600, 'turns=' + sp.guard);

console.log('\n=== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ===');
process.exit(failed ? 1 : 0);
