'use strict';
/* Verify: does chooseMove ever PASS while the hand actually holds a legal
 * combination that beats the table? Run: node tools/verify-follow.js */
const path = require('path');
const G = require(path.join(__dirname, '..', 'client', 'src', 'game.js'));
const B = require(path.join(__dirname, '..', 'client', 'src', 'bots.js'));

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Brute-force all "reasonable" combos from a hand and return the strongest
// pattern that canBeat the table. This is a ground-truth oracle independent of
// PCBots.candidates().
function bruteBest(hand, table, level) {
  const byRank = {};
  hand.forEach(c => { (byRank[c.r] = byRank[c.r] || []).push(c); });
  const ranks = Object.keys(byRank).map(Number).filter(r => r >= 3 && r <= 17).sort((a, b) => a - b);
  const combos = [];
  // singles / pairs / triples / bombs
  ranks.forEach(r => {
    const cs = byRank[r];
    combos.push([cs[0]]);
    if (cs.length >= 2) combos.push(cs.slice(0, 2));
    if (cs.length >= 3) combos.push(cs.slice(0, 3));
    if (cs.length >= 4) combos.push(cs.slice(0, 4));
  });
  // rocket
  const jokers = hand.filter(c => c.s === 'W');
  if (jokers.length >= 4) combos.push(jokers.slice(0, 4));
  // straights (5..12) one per consecutive rank
  for (let len = 5; len <= 12; len++) {
    for (let i = 0; i + len <= ranks.length; i++) {
      const run = ranks.slice(i, i + len);
      if (run[run.length - 1] > 14 || run.some((r, k) => k && r !== run[k - 1] + 1)) continue;
      combos.push(run.map(r => byRank[r][0]));
    }
  }
  // double straights (3+ consecutive ranks, 2 each)
  const pairRanks = ranks.filter(r => byRank[r].length >= 2);
  for (let len = 3; len <= 10; len++) {
    for (let i = 0; i + len <= pairRanks.length; i++) {
      const run = pairRanks.slice(i, i + len);
      if (run[run.length - 1] > 14 || run.some((r, k) => k && r !== run[k - 1] + 1)) continue;
      combos.push(run.reduce((a, r) => a.concat(byRank[r].slice(0, 2)), []));
    }
  }
  // triple straights (2+ consecutive ranks, 3 each)
  const tripRanks = ranks.filter(r => byRank[r].length >= 3);
  for (let len = 2; len <= 6; len++) {
    for (let i = 0; i + len <= tripRanks.length; i++) {
      const run = tripRanks.slice(i, i + len);
      if (run[run.length - 1] > 14 || run.some((r, k) => k && r !== run[k - 1] + 1)) continue;
      combos.push(run.reduce((a, r) => a.concat(byRank[r].slice(0, 3)), []));
    }
  }
  // straight flushes
  ['S', 'H', 'C', 'D'].forEach(s => {
    const sr = hand.filter(c => c.s === s && c.r >= 3 && c.r <= 14).map(c => c.r).sort((a, b) => a - b);
    for (let len = 5; len <= 12; len++) {
      for (let i = 0; i + len <= sr.length; i++) {
        const run = sr.slice(i, i + len);
        if (run.some((r, k) => k && r !== run[k - 1] + 1)) continue;
        combos.push(run.map(r => hand.filter(c => c.s === s && c.r === r)[0]));
      }
    }
  });
  let best = null;
  combos.forEach(cs => {
    const p = G.classify(cs, level);
    if (p && G.canBeat(p, table, level) && (!best || G.beats(p, best, level, false))) best = p;
  });
  return best;
}

const rnd = mulberry32(20261117);
const level = 15;
const TABLE_PATTERNS = [
  { name: '单张3', cards: [{ s: 'S', r: 3, id: 'x1' }] },
  { name: '单张K', cards: [{ s: 'S', r: 13, id: 'x2' }] },
  { name: '对子7', cards: [{ s: 'S', r: 7, id: 'x3' }, { s: 'H', r: 7, id: 'x4' }] },
  { name: '三张9', cards: [{ s: 'S', r: 9, id: 'x5' }, { s: 'H', r: 9, id: 'x6' }, { s: 'C', r: 9, id: 'x7' }] },
  { name: '顺子3-7', cards: [{ s: 'S', r: 3, id: 't1' }, { s: 'H', r: 4, id: 't2' }, { s: 'C', r: 5, id: 't3' }, { s: 'D', r: 6, id: 't4' }, { s: 'S', r: 7, id: 't5' }] },
  { name: '三连对3-5', cards: [{ s: 'S', r: 3, id: 'p1' }, { s: 'H', r: 3, id: 'p2' }, { s: 'S', r: 4, id: 'p3' }, { s: 'H', r: 4, id: 'p4' }, { s: 'S', r: 5, id: 'p5' }, { s: 'H', r: 5, id: 'p6' }] },
  { name: '炸弹6', cards: [{ s: 'S', r: 6, id: 'b1' }, { s: 'H', r: 6, id: 'b2' }, { s: 'C', r: 6, id: 'b3' }, { s: 'D', r: 6, id: 'b4' }] }
];

let tested = 0, missed = 0;
const missExamples = [];
TABLE_PATTERNS.forEach(tp => {
  const table = G.classify(tp.cards, level);
  for (let iter = 0; iter < 2000; iter++) {
    // random hand from a fresh deck, excluding the table card ids is not needed
    const deck = G.shuffle(G.makeDeck(), rnd);
    const hand = deck.slice(0, 27);
    const mv = B.chooseMove({ hand, tablePattern: table, level }, G);
    const oracle = bruteBest(hand, table, level);
    tested++;
    if (mv === null && oracle) {
      missed++;
      if (missExamples.length < 8) {
        missExamples.push({
          table: tp.name,
          oracle: oracle.type + '/rank' + oracle.rank,
          handRanks: hand.map(c => c.r).sort((a, b) => a - b).join(',')
        });
      }
    }
  }
});
console.log('tested', tested, 'missed(不跟牌却过牌)', missed, 'rate=' + (missed / tested * 100).toFixed(2) + '%');
console.log(JSON.stringify(missExamples, null, 2));
