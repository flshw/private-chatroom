/* Copyright (c) 2026 CJS flshw@126.com — Guandan bot (test partner). */
'use strict';
/*
 * PCBots — a deterministic, self-contained Guandan partner bot. Used only to
 * let ONE human test a four-seat match: the host client drives 3 local bots.
 * It never talks to the network; bots hand over their seat's cards to the host
 * locally, and every bot move is broadcast through the same E2EE game channel.
 *
 * Arrangement strategy (compiled from published Guandan guidance):
 *   1) 减轮次、去单化  — fold loose singles into straights / double-straights /
 *      triple-pairs so the hand is played in as few tricks as possible.
 *   2) 炸弹优先，绝不乱拆 — keep natural 4-of-a-kind, straight-flushes and the
 *      rocket intact; never break a bomb to make a short sequence.
 *   3) 逢人配价值最大化 — a red level-card (wild) is kept for a long straight
 *      or a bomb, never wasted on a lone pair.
 *   4) 情况不明，对子先行 — lead with the lowest pair when nothing is known.
 *   5) 小炸及时用，大炸沉住气 — when answering, play the smallest legal combo;
 *      hold stronger bombs back unless they are the only answer.
 *
 * UMD: window.PCBots in browsers, module.exports in Node (unit tests).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCBots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BOMB_WEIGHT = { 9: 1, 10: 2, 11: 3 }; // BOMB < STFLUSH < ROCKET (held back)

  function unique(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out;
  }
  function rankCounts(hand) {
    var m = {};
    hand.forEach(function (c) { m[c.r] = (m[c.r] || 0) + 1; });
    return m;
  }
  function consecutiveRuns(ranks, minLen) {
    ranks = unique(ranks.slice()).sort(function (a, b) { return a - b; });
    if (!ranks.length) return [];
    var runs = [], cur = [ranks[0]];
    for (var i = 1; i < ranks.length; i++) {
      if (ranks[i] === ranks[i - 1] + 1) cur.push(ranks[i]);
      else { if (cur.length >= minLen) runs.push(cur.slice()); cur = [ranks[i]]; }
    }
    if (cur.length >= minLen) runs.push(cur);
    return runs;
  }
  function pickRank(hand, rank, n) {
    return hand.filter(function (c) { return c.r === rank; }).slice(0, n || 1);
  }
  function without(hand, cs) {
    var ids = {};
    cs.forEach(function (c) { ids[c.id] = true; });
    return hand.filter(function (c) { return !ids[c.id]; });
  }

  /* Wrap classify(): every emitted group must be a legal Guandan pattern. */
  function mk(cards, G, level) {
    if (!cards.length) return null;
    var p = G.classify(cards, level);
    return p ? { cards: cards.slice(), pattern: p } : null;
  }
  function addGroup(groups, g) { if (g) groups.push(g); return !!g; }

  /* Arrange a full hand into legal trick-sized groups (auto "理牌").
   * Returns { groups:[{cards,pattern,label}], singles:n }. */
  function arrange(hand, level, G) {
    G = G || (typeof window !== 'undefined' && window.PCGame);
    if (!G) throw new Error('PCGame engine required');
    level = level || 15;
    var pool = hand.slice();
    var groups = [];

    function take(cards) {
      if (!cards.length) return false;
      var g = mk(cards, G, level);
      if (!g) return false;          // never emit an illegal pattern
      groups.push(g);
      pool = without(pool, cards);
      return true;
    }

    // 1) Rocket (all four jokers) — strongest, always kept.
    var jokers = pool.filter(function (c) { return c.s === 'W'; });
    if (jokers.length >= 4) take(jokers.slice(0, 4));

    // 2) Natural bombs (4 of one rank) — never break them up.
    var cnt = rankCounts(pool);
    Object.keys(cnt).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      var have = pickRank(pool, r, 4);
      if (have.length === 4) take(have);
    });

    // 3) Straight flushes (same suit, 5+ consecutive 3..A) before plain runs.
    ['S', 'H', 'C', 'D'].forEach(function (suit) {
      var sc = pool.filter(function (c) { return c.s === suit && c.r >= 3 && c.r <= 14; });
      consecutiveRuns(sc.map(function (c) { return c.r; }), 5).forEach(function (run) {
        var cs = [];
        run.forEach(function (r) { var c = sc.filter(function (x) { return x.r === r; })[0]; if (c) cs.push(c); });
        take(cs);
      });
    });

    // 4) Plain straights (5+ consecutive ranks; one card per rank).
    var runs = consecutiveRuns(Object.keys(rankCounts(pool)).map(Number).filter(function (r) {
      return r >= 3 && r <= 14;
    }), 5);
    runs.forEach(function (run) {
      var cs = [];
      run.forEach(function (r) { var c = pickRank(pool, r, 1)[0]; if (c) cs.push(c); });
      take(cs);
    });

    // 5) Double straights (3+ consecutive pairs) — fold loose pairs away.
    var cnt5 = rankCounts(pool);
    var pairRanks = Object.keys(cnt5).map(Number).filter(function (r) { return cnt5[r] >= 2 && r <= 14; });
    consecutiveRuns(pairRanks, 3).forEach(function (run) {
      var cs = [];
      run.forEach(function (r) { cs = cs.concat(pickRank(pool, r, 2)); });
      take(cs);
    });

    // 6) Triple straights / 钢板 (2+ consecutive triples).
    var cnt6 = rankCounts(pool);
    var tripRanks = Object.keys(cnt6).map(Number).filter(function (r) { return cnt6[r] >= 3 && r <= 14; });
    consecutiveRuns(tripRanks, 2).forEach(function (run) {
      var cs = [];
      run.forEach(function (r) { cs = cs.concat(pickRank(pool, r, 3)); });
      take(cs);
    });

    // 7) Triple-with-pair (三带二): use the LOWEST available pair as kicker to
    //    shed small singles. Repeat while possible.
    var guard = 0;
    while (guard++ < 14) {
      var c = rankCounts(pool);
      var trips = Object.keys(c).map(Number).filter(function (r) { return c[r] >= 3 && r <= 15; })
        .sort(function (a, b) { return a - b; });
      var pairs = Object.keys(c).map(Number).filter(function (r) { return c[r] >= 2 && r <= 15; })
        .sort(function (a, b) { return a - b; });
      var done = false;
      for (var t = 0; t < trips.length && !done; t++) {
        for (var p = 0; p < pairs.length; p++) {
          if (pairs[p] === trips[t]) continue;
          var three = pickRank(pool, trips[t], 3), two = pickRank(pool, pairs[p], 2);
          if (three.length === 3 && two.length === 2 && take(three.concat(two))) { done = true; break; }
        }
      }
      if (!done) break;
    }

    // 8) Remaining pairs, then triples, then single cards.
    var cnt8 = rankCounts(pool);
    Object.keys(cnt8).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      if (cnt8[r] >= 2) take(pickRank(pool, r, 2));
    });
    var cnt9 = rankCounts(pool);
    Object.keys(cnt9).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      if (cnt9[r] >= 3) take(pickRank(pool, r, 3));
    });
    pool.forEach(function (c) { take([c]); });

    return {
      groups: groups,
      singles: groups.filter(function (g) { return g.pattern.type === 1; }).length
    };
  }

  /* Flatten an arrangement back into a display order (理牌后的手牌顺序). */
  function sortedHand(hand, level, G) {
    var arranged = arrange(hand, level, G);
    var out = [], seen = {};
    arranged.groups.forEach(function (g) {
      g.cards.forEach(function (c) { out.push(c); seen[c.id] = true; });
    });
    hand.forEach(function (c) { if (!seen[c.id]) out.push(c); });
    return out;
  }

  /* All legal candidate plays from a hand: the arranged groups (kept intact)
   * plus low singles/pairs/triples so the bot can answer any trick type. */
  function candidates(hand, level, G) {
    var arranged = arrange(hand, level, G);
    var out = arranged.groups.slice();
    var seen = {};
    out.forEach(function (g) { seen[g.cards.map(function (c) { return c.id; }).sort().join(',')] = true; });
    function maybe(cs) {
      if (!cs.length) return;
      var k = cs.map(function (c) { return c.id; }).sort().join(',');
      if (seen[k]) return;
      var g = mk(cs, G, level);
      if (g) { seen[k] = true; out.push(g); }
    }
    var cnt = rankCounts(hand);
    Object.keys(cnt).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      var one = pickRank(hand, r, 1);
      maybe(one);                       // lowest single of this rank
      if (cnt[r] >= 2) maybe(pickRank(hand, r, 2));
      if (cnt[r] >= 3) maybe(pickRank(hand, r, 3));
    });
    return out;
  }

  function isBomb(g) { return !!BOMB_WEIGHT[g.pattern.type]; }

  /* Decide a move. ctx: { hand, tablePattern (null when leading), level }.
   * Returns { cards, pattern, name } to play, or null to PASS. */
  function chooseMove(ctx, G) {
    G = G || (typeof window !== 'undefined' && window.PCGame);
    if (!G) throw new Error('PCGame engine required');
    var level = ctx.level || 15;
    var table = ctx.tablePattern || null;
    var cands = candidates(ctx.hand, level, G);
    if (!cands.length) return null;

    if (!table) {
      // Lead: 情况不明，对子先行 — otherwise shed the most cards cheaply.
      var pairs = cands.filter(function (g) { return g.pattern.type === G.TYPE.PAIR && !isBomb(g); });
      var pool = pairs.length ? pairs : cands.filter(function (g) { return !isBomb(g); });
      if (!pool.length) pool = cands;
      pool.sort(function (a, b) {
        return a.pattern.rank - b.pattern.rank || b.cards.length - a.cards.length;
      });
      var lead = pool[0];
      return { cards: lead.cards, pattern: lead.pattern, name: lead.pattern.name };
    }

    var answers = cands.filter(function (g) { return G.canBeat(g.pattern, table, level); });
    if (!answers.length) return null;   // cannot beat -> pass
    // Smallest legal answer first; among equals prefer shedding more cards;
    // bombs are sorted last (hold the big guns back) unless they are the only
    // legal answer, which the filter above already guarantees is acceptable.
    answers.sort(function (a, b) {
      return (BOMB_WEIGHT[a.pattern.type] || 0) - (BOMB_WEIGHT[b.pattern.type] || 0) ||
        a.pattern.rank - b.pattern.rank || b.cards.length - a.cards.length;
    });
    var best = answers[0];
    return { cards: best.cards, pattern: best.pattern, name: best.pattern.name };
  }

  return { arrange: arrange, sortedHand: sortedHand, candidates: candidates, chooseMove: chooseMove };
});
