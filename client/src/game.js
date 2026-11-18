/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom Guandan engine. */
'use strict';
/*
 * PCGame — complete Guandan (掼蛋) rule engine, deterministic and freestanding.
 *
 * SECURITY MODEL: this module only manipulates card objects. It never talks to
 * the network. All game traffic is carried by the E2EE message channel
 * (kind='game'), so the server sees ciphertext only. Dealing wraps each seat's
 * hand to that member's public key. A designated host seat runs the state
 * machine (private friends game — see security-boundary doc for this tradeoff).
 *
 * UMD: window.PCGame in browsers, module.exports in Node (for unit tests).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCGame = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SUITS = ['S', 'H', 'C', 'D']; // spade heart club diamond
  var TYPE = {
    SINGLE: 1, PAIR: 2, TRIPLE: 3, TRIPLE_PAIR: 4,
    STRAIGHT: 5, DOUBLE_STRAIGHT: 6, TRIPLE_STRAIGHT: 7,
    FOUR_TWO: 8, BOMB: 9, STFLUSH: 10, ROCKET: 11
  };
  var TYPE_NAME = {
    1: '单张', 2: '对子', 3: '三张', 4: '三带二', 5: '顺子',
    6: '三连对', 7: '钢板', 8: '四带二', 9: '炸弹', 10: '同花顺', 11: '王炸'
  };

  /* Two full decks = 108 cards. rank 3..15 (J=11,Q=12,K=13,A=14,2=15),
   * jokers W16 (small) / W17 (big). */
  function makeDeck() {
    var cards = [], n = 0;
    for (var d = 0; d < 2; d++) {
      for (var s = 0; s < 4; s++) {
        for (var r = 3; r <= 15; r++) cards.push({ s: SUITS[s], r: r, id: 'c' + n++ });
      }
      cards.push({ s: 'W', r: 16, id: 'c' + n++ });
      cards.push({ s: 'W', r: 17, id: 'c' + n++ });
    }
    return cards;
  }

  function isWild(card, level) { return card.s === 'H' && card.r === level; }
  function isJoker(card) { return card.s === 'W'; }

  /* Ranking value used for comparison. Level card rises above A and jokers
   * stay top. Guandan rule for the rank 2:
   *   - When PLAYING 2 (level===15), 2 IS the level card -> value 16 (handled
   *     by the r===level branch above), i.e. second only to the jokers.
   *   - When playing ANY OTHER rank, 2 collapses to the LOWEST card (below 3).
   *     Returning 2 (nothing else uses r=2) keeps every comparison numeric and
   *     makes 2-strips/singles/bombs the weakest of their kind.
   * Jokers: small=16->17, big=17->18, always above the level card. */
  function cmpVal(r, level) {
    if (r === 17) return 18;
    if (r === 16) return 17;
    if (r === level) return 16;
    if (r === 15) return 2; // a plain 2 is the smallest card when not playing 2
    return r; // 3..14
  }

  function shuffle(deck, rand) {
    rand = rand || Math.random;
    var a = deck.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function deal(deck, rand) {
    var d = shuffle(deck, rand);
    return [d.slice(0, 27), d.slice(27, 54), d.slice(54, 81), d.slice(81, 108)];
  }

  function sortHand(hand, level) {
    return hand.slice().sort(function (a, b) {
      return cmpVal(a.r, level) - cmpVal(b.r, level) || a.s.localeCompare(b.s);
    });
  }

  /* Display / 理牌 order (sortHandForView). Human players read a hand by RANK,
   * strongest first, with same-rank cards kept together — NOT by the bot's
   * "fewest tricks" grouping (which used to push bombs to the front and jokers
   * to the very end). Order: big joker, small joker, level card, then A..3,
   * and finally a plain 2 when 2 is NOT the level (Guandan: weakest card).
   * suit tie-break fixed so the sequence is stable across renders. */
  var VIEW_SUIT = { S: 0, H: 1, C: 2, D: 3, W: 4 };
  function sortHandForView(hand, level) {
    return hand.slice().sort(function (a, b) {
      var va = cmpVal(a.r, level), vb = cmpVal(b.r, level);
      if (va !== vb) return vb - va;              // strongest rank first
      return (VIEW_SUIT[a.s] - VIEW_SUIT[b.s]) || b.r - a.r;
    });
  }

  /* --- classify a set of cards with NO wilds present --- */
  function classifyNormal(cards, level) {
    var n = cards.length;
    if (!n) return null;
    var counts = {};
    cards.forEach(function (c) { counts[c.r] = (counts[c.r] || 0) + 1; });
    var ranks = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });

    // Rocket: exactly the four jokers.
    if (n === 4 && cards.every(isJoker)) {
      return { type: TYPE.ROCKET, rank: 100, len: 4, name: '王炸' };
    }
    // Bomb: 4+ of one rank (no jokers).
    if (n >= 4 && ranks.length === 1 && !isJoker(cards[0])) {
      return { type: TYPE.BOMB, rank: cmpVal(ranks[0], level), len: n, name: '炸弹' };
    }
    // Straight-flush: same suit, 5+ consecutive ranks within 3..14.
    var sf = straightFlush(cards, level);
    if (sf) return sf;
    // Straight: 5+ consecutive single ranks within 3..14.
    var st = straightRanks(ranks, 5), stFlushCheck = null;
    if (st && n >= 5 && ranks.length === n && maxRank(ranks) <= 14 && minRank(ranks) >= 3) {
      return { type: TYPE.STRAIGHT, rank: cmpVal(ranks[ranks.length - 1], level), len: n, name: '顺子' };
    }
    // Triple-straight (钢板): k>=2 consecutive triples.
    if (n >= 6 && n % 3 === 0) {
      var tripRanks = ranks.filter(function (r) { return counts[r] === 3 && r <= 14; });
      if (tripRanks.length === ranks.length && straightRanks(tripRanks, 2)) {
        return { type: TYPE.TRIPLE_STRAIGHT, rank: cmpVal(tripRanks[tripRanks.length - 1], level), len: n, name: '钢板' };
      }
    }
    // Double-straight (三连对): k>=3 consecutive pairs.
    if (n >= 6 && n % 2 === 0) {
      var pairRanks = ranks.filter(function (r) { return counts[r] === 2 && r <= 14; });
      if (pairRanks.length === ranks.length && ranks.length >= 3 && straightRanks(pairRanks, 3)) {
        return { type: TYPE.DOUBLE_STRAIGHT, rank: cmpVal(pairRanks[pairRanks.length - 1], level), len: n, name: '三连对' };
      }
    }
    // Four-with-two: four of a rank + any two kickers.
    if (n === 6) {
      var fours = ranks.filter(function (r) { return counts[r] === 4; });
      if (fours.length === 1) {
        return { type: TYPE.FOUR_TWO, rank: cmpVal(fours[0], level), len: 6, name: '四带二' };
      }
    }
    // Triple-with-pair.
    if (n === 5) {
      var trips = ranks.filter(function (r) { return counts[r] === 3; });
      var pairs = ranks.filter(function (r) { return counts[r] === 2; });
      if (trips.length === 1 && pairs.length === 1) {
        return { type: TYPE.TRIPLE_PAIR, rank: cmpVal(trips[0], level), len: 5, name: '三带二' };
      }
    }
    // Single / pair / triple.
    if (n === 1) return { type: TYPE.SINGLE, rank: cmpVal(cards[0].r, level), len: 1, name: '单张' };
    if (n === 2 && ranks.length === 1) return { type: TYPE.PAIR, rank: cmpVal(ranks[0], level), len: 2, name: '对子' };
    if (n === 3 && ranks.length === 1) return { type: TYPE.TRIPLE, rank: cmpVal(ranks[0], level), len: 3, name: '三张' };
    return null;
  }

  function minRank(r) { return r[0]; }
  function maxRank(r) { return r[r.length - 1]; }
  function straightRanks(ranks, minLen) {
    if (ranks.length < minLen) return false;
    for (var i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
    return true;
  }
  function straightFlush(cards, level) {
    if (cards.length < 5 || cards.some(isJoker)) return null;
    var suit = cards[0].s;
    if (!cards.every(function (c) { return c.s === suit; })) return null;
    var ranks = cards.map(function (c) { return c.r; }).sort(function (a, b) { return a - b; });
    if (ranks[ranks.length - 1] > 14 || ranks[0] < 3) return null;
    if (!straightRanks(ranks, 5)) return null;
    return { type: TYPE.STFLUSH, rank: cmpVal(ranks[ranks.length - 1], level), len: cards.length, name: '同花顺' };
  }

  /* Candidate proxies a wild card may imitate (never a joker). */
  function wildCandidates() {
    var out = [];
    for (var r = 3; r <= 15; r++) for (var s = 0; s < 4; s++) out.push({ s: SUITS[s], r: r, id: 'w' });
    return out;
  }

  /* Full classify: enumerate wild substitutions, keep the strongest valid type. */
  function classify(cards, level) {
    level = level || 15;
    var wilds = cards.filter(function (c) { return isWild(c, level); });
    var normals = cards.filter(function (c) { return !isWild(c, level); });
    if (!wilds.length) return classifyNormal(normals, level);
    var cands = wildCandidates();
    var best = null;
    function assign(i, acc) {
      if (i === wilds.length) {
        var t = classifyNormal(normals.concat(acc), level);
        if (t && (!best || beats(t, best, level, true))) best = t;
        return;
      }
      for (var k = 0; k < cands.length; k++) {
        var c = cands[k];
        acc.push({ s: c.s, r: c.r, id: 'w' + i });
        assign(i + 1, acc);
        acc.pop();
      }
    }
    assign(0, []);
    return best;
  }

  function bombRank(t) {
    if (t.type === TYPE.ROCKET) return 200;
    if (t.type === TYPE.STFLUSH) return 100 + t.rank; // straight-flush beats plain bomb
    if (t.type === TYPE.BOMB) return t.rank;
    return -1;
  }

  /* Does a beat b? When sameTypeOnly, used to rank candidate substitutions. */
  function beats(a, b, level, sameTypeOnly) {
    if (!a) return false;
    if (!b) return true;
    var ba = bombRank(a), bb = bombRank(b);
    if (ba > 0 || bb > 0) {
      if (ba !== bb) return ba > bb;
      if (a.type === TYPE.BOMB && b.type === TYPE.BOMB && a.len !== b.len) return a.len > b.len;
      return a.rank > b.rank;
    }
    if (sameTypeOnly && a.type !== b.type) return false;
    return a.type === b.type && a.len === b.len && a.rank > b.rank;
  }

  /* Can `play` legally beat `table` (the current trick)? */
  function canBeat(play, table, level) {
    if (!play) return false;
    if (!table) return true;
    return beats(play, table, level, false);
  }

  /* --- tribute / level progression helpers --- */
  /* Apply 进贡/还贡/抗贡 to freshly dealt hands. All four hands are known here
   * because the HOST deals locally (bots are local too). Returns transformed
   * hands plus a human-readable event list and the seat that leads the trick.
   *   hands:       [ [card,...] x4 ]  (seat order)
   *   finishOrder: seat indices from LAST round, first-out .. last-out
   *   teamOf:      [0,1,0,1]
   *   level:       current rank (for sizing cards)
   * Cards are objects {s,r,id}; comparison uses cmpVal with the level. */
  function applyTribute(hands, finishOrder, teamOf, level) {
    var copy = hands.map(function (h) { return h.slice(); });
    var events = [];
    if (!finishOrder || finishOrder.length < 4 || !teamOf) {
      return { hands: copy, events: events, resisted: false, firstSeat: 0 };
    }
    var first = finishOrder[0], second = finishOrder[1];
    var third = finishOrder[2], fourth = finishOrder[3];
    var double = teamOf[first] === teamOf[second]; // 双下
    var losers = double ? [third, fourth] : [fourth];
    var winners = double ? [first, second] : [first];

    // 抗贡: the losing side holding both big jokers cancels ALL tribute.
    var bigJokers = 0;
    losers.forEach(function (seat) {
      copy[seat].forEach(function (c) { if (c.r === 17) bigJokers++; });
    });
    if (bigJokers >= 2) {
      return { hands: copy, events: [{ action: 'resist', seats: losers }],
        resisted: true, firstSeat: first };
    }

    function cardValue(c) {
      if (c.r === 17) return 1000;   // big joker highest
      if (c.r === 16) return 999;    // small joker
      return cmpVal(c.r, level);
    }
    function takeMax(seat) {
      var h = copy[seat]; if (!h.length) return null;
      var bi = 0;
      for (var i = 1; i < h.length; i++) if (cardValue(h[i]) > cardValue(h[bi])) bi = i;
      return h.splice(bi, 1)[0];
    }
    function takeMin(seat) {
      var h = copy[seat]; if (!h.length) return null;
      var bi = 0;
      for (var i = 1; i < h.length; i++) if (cardValue(h[i]) < cardValue(h[bi])) bi = i;
      return h.splice(bi, 1)[0];
    }

    // pair each loser -> a winner: in a double, lowest loser pays top winner,
    // second-lowest pays second winner; single: 大拉 pays 大科.
    for (var i = 0; i < losers.length; i++) {
      var from = losers[i], to = winners[i];
      var tribute = takeMax(from);
      if (!tribute) continue;
      copy[to].push(tribute);
      events.push({ action: 'tribute', from: from, to: to, card: tribute });
      var back = takeMin(to);         // 还贡: winner returns its smallest card
      if (back) {
        copy[from].push(back);
        events.push({ action: 'return', from: to, to: from, card: back });
      }
    }
    // Lead: double-down the side that paid tribute leads (loser with the
    // highest remaining single); single-down the 大科 (winner) leads.
    var firstSeat = double ? fourth : first;
    return { hands: copy, events: events, resisted: false, firstSeat: firstSeat };
  }

  /* finishOrder: array of seat indices in finish order (first out .. last).
   * teamOf: [0,1,0,1] for seats 0/2 vs 1/3. Returns level delta for winners. */
  function levelDelta(finishOrder, teamOf) {
    var first = finishOrder[0], second = finishOrder[1];
    if (teamOf[first] === teamOf[second]) return 3; // double win, opponents double-last
    var last = finishOrder[3];
    if (teamOf[first] === teamOf[last]) return 1; // split, only one level
    return 2; // first + third
  }
  function isDoubleDown(finishOrder, teamOf) {
    return teamOf[finishOrder[0]] === teamOf[finishOrder[1]];
  }
  /* Big jokers held per team determines 抗贡 (resist tribute). */
  function canResist(handBySeat, teamOf, losingSeats) {
    var big = 0;
    losingSeats.forEach(function (s) {
      handBySeat[s].forEach(function (c) { if (c.r === 17) big++; });
    });
    return big >= 2;
  }

  return {
    SUITS: SUITS, TYPE: TYPE, TYPE_NAME: TYPE_NAME,
    makeDeck: makeDeck, isWild: isWild, isJoker: isJoker, cmpVal: cmpVal,
    shuffle: shuffle, deal: deal, sortHand: sortHand, sortHandForView: sortHandForView,
    classify: classify, classifyNormal: classifyNormal, beats: beats, canBeat: canBeat,
    levelDelta: levelDelta, isDoubleDown: isDoubleDown, canResist: canResist,
    applyTribute: applyTribute
  };
});
