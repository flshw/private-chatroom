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
   * Returns { groups:[{cards,pattern,label}], singles:n, tricks, bombs, flushes }.
   *
   * v24: two schemes. bombsFirst=true keeps natural bombs / straight flushes /
   * rocket intact and leads with them (火力集中). bombsFirst=false folds small
   * cards into long straights / double straights / triple pairs FIRST so the
   * hand is shed in fewer tricks (少手数), then keeps the big guns. Both emit
   * only patterns validated by classify(), so neither can produce an illegal
   * group — and both cover every card exactly once. */
  function arrangeWith(hand, level, G, opts) {
    G = G || (typeof window !== 'undefined' && window.PCGame);
    if (!G) throw new Error('PCGame engine required');
    level = level || 15;
    opts = opts || {};
    var bombsFirst = opts.bombsFirst !== false;
    var pool = hand.slice();
    var groups = [];

    function take(cards) {
      if (!cards.length) return false;
      var g = mk(cards, G, level);
      if (!g) return false;          // never emit an illegal pattern
      g.label = g.pattern.name;
      groups.push(g);
      pool = without(pool, cards);
      return true;
    }
    function takeBombs() {
      var jokers = pool.filter(function (c) { return c.s === 'W'; });
      if (jokers.length >= 4) take(jokers.slice(0, 4));
      var cnt = rankCounts(pool);
      Object.keys(cnt).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
        var have = pickRank(pool, r, 4);
        if (have.length === 4) take(have);
      });
    }
    function takeStraightFlushes() {
      ['S', 'H', 'C', 'D'].forEach(function (suit) {
        var sc = pool.filter(function (c) { return c.s === suit && c.r >= 3 && c.r <= 14; });
        consecutiveRuns(sc.map(function (c) { return c.r; }), 5).forEach(function (run) {
          var cs = [];
          run.forEach(function (r) { var c = sc.filter(function (x) { return x.r === r; })[0]; if (c) cs.push(c); });
          take(cs);
        });
      });
    }
    function takeStraights() {
      var runs = consecutiveRuns(Object.keys(rankCounts(pool)).map(Number).filter(function (r) {
        return r >= 3 && r <= 14;
      }), 5);
      runs.forEach(function (run) {
        var cs = [];
        run.forEach(function (r) { var c = pickRank(pool, r, 1)[0]; if (c) cs.push(c); });
        take(cs);
      });
    }
    function takeDoubleStraights() {
      var cnt = rankCounts(pool);
      var pairRanks = Object.keys(cnt).map(Number).filter(function (r) { return cnt[r] >= 2 && r <= 14; });
      consecutiveRuns(pairRanks, 3).forEach(function (run) {
        var cs = [];
        run.forEach(function (r) { cs = cs.concat(pickRank(pool, r, 2)); });
        take(cs);
      });
    }
    function takeTripleStraights() {
      var cnt = rankCounts(pool);
      var tripRanks = Object.keys(cnt).map(Number).filter(function (r) { return cnt[r] >= 3 && r <= 14; });
      consecutiveRuns(tripRanks, 2).forEach(function (run) {
        var cs = [];
        run.forEach(function (r) { cs = cs.concat(pickRank(pool, r, 3)); });
        take(cs);
      });
    }
    function takeTriplePairs() {
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
    }
    function takeRest() {
      var cnt = rankCounts(pool);
      Object.keys(cnt).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
        if (cnt[r] >= 2) take(pickRank(pool, r, 2));
      });
      cnt = rankCounts(pool);
      Object.keys(cnt).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
        if (cnt[r] >= 3) take(pickRank(pool, r, 3));
      });
      pool.forEach(function (c) { take([c]); });
    }

    // 1) Rocket (all four jokers) — strongest, always kept.
    var jokers = pool.filter(function (c) { return c.s === 'W'; });
    if (jokers.length >= 4) take(jokers.slice(0, 4));
    if (bombsFirst) {
      // 火力集中: bombs & straight flushes first, then fold the remainder.
      takeBombs(); takeStraightFlushes(); takeStraights();
      takeDoubleStraights(); takeTripleStraights(); takeTriplePairs(); takeRest();
    } else {
      // 少手数: long runs & straight flushes first to shed many cards with one
      // trick, THEN keep bombs intact. Small cards get absorbed into runs.
      takeStraightFlushes(); takeStraights(); takeDoubleStraights();
      takeTripleStraights(); takeTriplePairs(); takeBombs(); takeRest();
    }
    return {
      groups: groups,
      singles: groups.filter(function (g) { return g.pattern.type === G.TYPE.SINGLE; }).length,
      tricks: groups.length,
      bombs: groups.filter(function (g) {
        return g.pattern.type === G.TYPE.BOMB || g.pattern.type === G.TYPE.ROCKET ||
          g.pattern.type === G.TYPE.STFLUSH;
      }).length,
      flushes: groups.filter(function (g) { return g.pattern.type === G.TYPE.STFLUSH; }).length
    };
  }

  function arrange(hand, level, G) { return arrangeWith(hand, level, G, { bombsFirst: true }); }

  /* Two auto-arrange schemes for the cycle button: { name, order, groups, stats }.
   * `order` is a flattened hand order; `groups` carries pattern labels for the
   * UI to show each combo as a labelled stack. */
  function arrangeSchemes(hand, level, G) {
    var a = arrangeWith(hand, level, G, { bombsFirst: true });
    var b = arrangeWith(hand, level, G, { bombsFirst: false });
    function flat(arr) {
      var out = [];
      arr.groups.forEach(function (g) { g.cards.forEach(function (c) { out.push(c); }); });
      return out;
    }
    return [
      { name: '理牌① 火力集中', order: flat(a), groups: a.groups, stats: a },
      { name: '理牌② 少手数', order: flat(b), groups: b.groups, stats: b }
    ];
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

  /* All legal candidate plays from a hand.
   *
   * IMPORTANT: answering must consider EVERY legal combination the hand can
   * form, not just the groups chosen by arrange(). arrange() optimises for
   * "fewest tricks" and happily folds a would-be straight into a triple-pair
   * or double-straight. If we only expose those groups + singles/pairs/triples,
   * the bot cannot see the straight it actually holds and passes even though it
   * could beat a straight on the table — the "不跟牌也不过牌" symptom. So here we
   * also enumerate straights, double/triple straights and straight flushes from
   * the ORIGINAL hand. mk() still validates every combo via classify(), so no
   * illegal play can slip through. */
  function candidates(hand, level, G) {
    var arranged = arrange(hand, level, G);
    var out = arranged.groups.slice();
    var seen = {};
    function key(cs) { return cs.map(function (c) { return c.id; }).sort().join(','); }
    out.forEach(function (g) { seen[key(g.cards)] = true; });
    function maybe(cs) {
      if (!cs.length) return;
      var k = key(cs);
      if (seen[k]) return;
      var g = mk(cs, G, level);
      if (g) { seen[k] = true; out.push(g); }
    }
    var cnt = rankCounts(hand);
    var ranks = Object.keys(cnt).map(Number).sort(function (a, b) { return a - b; });
    ranks.forEach(function (r) {
      maybe(pickRank(hand, r, 1));                       // single
      if (cnt[r] >= 2) maybe(pickRank(hand, r, 2));      // pair
      if (cnt[r] >= 3) maybe(pickRank(hand, r, 3));      // triple
      if (cnt[r] >= 4) maybe(pickRank(hand, r, 4));      // bomb
    });
    // Jokers: rocket / partial joker pairs.
    var jokers = hand.filter(function (c) { return c.s === 'W'; });
    if (jokers.length >= 4) maybe(jokers.slice(0, 4));
    if (jokers.length >= 2) maybe(jokers.slice(0, 2));
    // Straight (5+ consecutive ranks, one card each, 3..A).
    function eachRun(rankList, perRank, fn) {
      for (var len = rankList.length; len >= 2; len--) {
        for (var i = 0; i + len <= rankList.length; i++) {
          var run = rankList.slice(i, i + len);
          var ok = run[run.length - 1] <= 14;
          for (var k = 1; ok && k < run.length; k++) if (run[k] !== run[k - 1] + 1) ok = false;
          if (ok) fn(run);
        }
      }
    }
    eachRun(ranks, 1, function (run) {
      var cs = [];
      run.forEach(function (r) { var c = pickRank(hand, r, 1)[0]; if (c) cs.push(c); });
      maybe(cs);
    });
    // Double straights: 3+ consecutive ranks, two of each.
    var pairRanks = ranks.filter(function (r) { return cnt[r] >= 2 && r <= 14; });
    eachRun(pairRanks, 2, function (run) {
      if (run.length < 3) return;
      var cs = [];
      run.forEach(function (r) { cs = cs.concat(pickRank(hand, r, 2)); });
      maybe(cs);
    });
    // Triple straights (钢板): 2+ consecutive ranks, three of each.
    var tripRanks = ranks.filter(function (r) { return cnt[r] >= 3 && r <= 14; });
    eachRun(tripRanks, 3, function (run) {
      var cs = [];
      run.forEach(function (r) { cs = cs.concat(pickRank(hand, r, 3)); });
      maybe(cs);
    });
    // Straight flushes: same suit, 5+ consecutive ranks.
    ['S', 'H', 'C', 'D'].forEach(function (suit) {
      var sc = hand.filter(function (c) { return c.s === suit && c.r >= 3 && c.r <= 14; });
      var sranks = unique(sc.map(function (c) { return c.r; })).sort(function (a, b) { return a - b; });
      eachRun(sranks, 1, function (run) {
        if (run.length < 5) return;
        var cs = [];
        run.forEach(function (r) { var c = sc.filter(function (x) { return x.r === r; })[0]; if (c) cs.push(c); });
        maybe(cs);
      });
    });
    // Wild (red level card) gap-filling — see addWildCandidates(). Pattern
    // descriptors are built directly (no classify enumeration) for speed.
    function addDirect(cs, pattern) {
      var k = key(cs);
      if (seen[k]) return;
      seen[k] = true;
      out.push({ cards: cs.slice(), pattern: pattern });
    }
    addWildCandidates(hand, level, G, addDirect);
    return out;
  }

  /* Red level cards (逢人配 / wild) can stand in for ANY non-joker card.
   * PCGame.classify() already resolves a wild inside a card set to its
   * strongest legal pattern — but candidates() enumerates plays by REAL rank,
   * and a wild's real rank is `level` (e.g. 15 when playing 2), which is
   * excluded from straights (rank<=14). So the bot could never SEE a play like
   * 3-4-[red 2]-6-7 = straight, and would pass holding a winning hand.
   *
   * This generator adds card sets where wilds FILL THE GAPS of every pattern
   * family. We KNOW the resulting pattern (family + top rank) by construction,
   * so we build its descriptor directly instead of calling classify() — the
   * latter enumerates 52^k wild substitutions and is far too slow when called
   * for hundreds of candidates per bot turn. */
  function addWildCandidates(hand, level, G, addDirect) {
    if (!G.isWild) return;
    var wilds = hand.filter(function (c) { return G.isWild(c, level); });
    if (!wilds.length) return;
    var base = hand.filter(function (c) { return !G.isWild(c, level); });
    var nw = wilds.length;
    var T = G.TYPE, TN = G.TYPE_NAME;
    function pat(type, rank, len) {
      return { type: type, rank: G.cmpVal(rank, level), len: len, name: TN[type] };
    }

    // (A) Same-rank groups: 1 real + wild = pair, 2 real + wild = triple,
    //     3 real + wild = bomb (and 2 real + 2 wild = bomb).
    for (var r = 3; r <= 15; r++) {
      var have = pickRank(base, r, 4);
      if (!have.length) continue;
      for (var target = 2; target <= 4; target++) {
        var need = target - have.length;
        if (need >= 1 && need <= nw) {
          var cards = have.slice(0, Math.min(have.length, target)).concat(wilds.slice(0, need));
          var type = target === 2 ? T.PAIR : target === 3 ? T.TRIPLE : T.BOMB;
          addDirect(cards, pat(type, r, target));
        }
      }
    }

    // (B) Runs where wilds fill missing ranks. perRank=1 straight, 2 double
    // straight (连对), 3 triple straight (钢板); suit != null -> straight flush.
    function fillRun(run, perRank, type, suit) {
      var cs = [], missing = 0;
      for (var i = 0; i < run.length; i++) {
        var r = run[i];
        var avail = base.filter(function (c) {
          return c.r === r && c.r <= 14 && (!suit || c.s === suit);
        });
        var take = Math.min(perRank, avail.length);
        cs = cs.concat(avail.slice(0, take));
        missing += perRank - take;
      }
      if (missing >= 1 && missing <= nw && cs.length + missing === run.length * perRank) {
        var cards = cs.concat(wilds.slice(0, missing));
        addDirect(cards, pat(type, run[run.length - 1], cards.length));
      }
    }
    // Straight flushes FIRST: they share the same 5 cards as a plain straight
    // and addDirect() de-dupes by card ids, so the stronger pattern must claim
    // the key first (otherwise a plain straight shadows the straight flush).
    ['S', 'H', 'C', 'D'].forEach(function (suit) {
      for (var len = 5; len <= 12; len++) {
        for (var start = 3; start + len - 1 <= 14; start++) {
          var run = [];
          for (var k = 0; k < len; k++) run.push(start + k);
          fillRun(run, 1, T.STFLUSH, suit);           // straight flush
        }
      }
    });
    for (var len = 5; len <= 12; len++) {
      for (var start = 3; start + len - 1 <= 14; start++) {
        var run = [];
        for (var k = 0; k < len; k++) run.push(start + k);
        fillRun(run, 1, T.STRAIGHT, null);             // straight
        if (len >= 3) fillRun(run, 2, T.DOUBLE_STRAIGHT, null); // 连对
        if (len >= 2) fillRun(run, 3, T.TRIPLE_STRAIGHT, null); // 钢板
      }
    }
  }

  function isBomb(g) { return !!BOMB_WEIGHT[g.pattern.type]; }

  /* v24 strategy helpers.
   * handPower(): rough role estimate — bombs + big jokers + level cards.
   *   >= 6 → 主攻 (attacker: shed fast, grab control), else 助攻 (support:
   *   play safe, avoid stealing partner's trick).
   * Every decision here is a HEURISTIC on WHICH legal card to play. It never
   * introduces an illegal play, and it only ever passes when the caller has
   * supplied explicit table context AND a partner is winning the trick. */
  function handPower(hand, level, G) {
    var cnt = rankCounts(hand), power = 0;
    Object.keys(cnt).map(Number).forEach(function (r) {
      if (cnt[r] >= 4) power += 3;
      if (r === 17) power += 2;
      if (r === 16) power += 1;
      if (r === level) power += 1;
    });
    if (G && G.isWild && hand.some(function (c) { return G.isWild(c, level); })) power += 2;
    return power;
  }

  /* Decide a move. ctx: { hand, tablePattern (null when leading), level,
   *   mySid, bySid (who played the trick), teamOf(sid)->team index,
   *   remaining(sid)->card count }.
   * Returns { cards, pattern, name, why } to play, or null to PASS.
   * Backward compatible: with only hand/tablePattern/level it NEVER passes
   * while a legal beat exists (the verify-follow invariant). */
  function chooseMove(ctx, G) {
    G = G || (typeof window !== 'undefined' && window.PCGame);
    if (!G) throw new Error('PCGame engine required');
    var level = ctx.level || 15;
    var table = ctx.tablePattern || null;
    var cands = candidates(ctx.hand, level, G);
    if (!cands.length) return null;

    var power = handPower(ctx.hand, level, G);
    var attacker = power >= 6;
    var teamOf = typeof ctx.teamOf === 'function' ? ctx.teamOf : null;
    var mySid = ctx.mySid, bySid = ctx.bySid;

    if (!table) {
      // ---- LEAD ----
      // 有鬼打一张: holding a big joker, probe with the LOWEST single so the
      // partner can read the signal and opponents waste a small card.
      var bigJoker = ctx.hand.some(function (c) { return c.r === 17; });
      var singles = cands.filter(function (g) {
        return g.pattern.type === G.TYPE.SINGLE && !isBomb(g);
      });
      if (bigJoker && singles.length) {
        singles.sort(function (a, b) { return a.pattern.rank - b.pattern.rank; });
        var probe = singles[0];
        return { cards: probe.cards, pattern: probe.pattern, name: probe.pattern.name,
          why: '有鬼打一张(探路)' };
      }
      var pool = cands.filter(function (g) { return !isBomb(g); });
      if (!pool.length) pool = cands;
      if (attacker) {
        // 主攻: shed the most cards per trick, lowest rank first (减手数).
        pool.sort(function (a, b) {
          return b.cards.length - a.cards.length || a.pattern.rank - b.pattern.rank;
        });
        var lead = pool[0];
        return { cards: lead.cards, pattern: lead.pattern, name: lead.pattern.name,
          why: '主攻·多牌快出' };
      }
      // 助攻 / 情况不明: 对子先行 — lowest pair, else lowest combo.
      var pairs = pool.filter(function (g) { return g.pattern.type === G.TYPE.PAIR; });
      var safe = pairs.length ? pairs : pool;
      safe.sort(function (a, b) {
        return a.pattern.rank - b.pattern.rank || b.cards.length - a.cards.length;
      });
      var lead2 = safe[0];
      return { cards: lead2.cards, pattern: lead2.pattern, name: lead2.pattern.name,
        why: pairs.length ? '助攻·对子先行' : '助攻·最小跟牌' };
    }

    // ---- FOLLOW ----
    var answers = cands.filter(function (g) { return G.canBeat(g.pattern, table, level); });
    if (!answers.length) return null;   // cannot beat -> pass
    var normal = answers.filter(function (g) { return !isBomb(g); });
    var bombs = answers.filter(isBomb);

    // Only a bomb can win. Partner is currently taking the trick → don't
    // bomb your own side. Requires explicit table context (never in the
    // standalone verify-follow test, so its invariant is preserved).
    if (!normal.length && bombs.length && teamOf && bySid && mySid && bySid !== mySid &&
        teamOf(bySid) === teamOf(mySid)) {
      return null; // 配合队友：不炸对家
    }
    // Opponent is nearly out (<= 2 cards) and we must bomb to stop them:
    // whether we're attacker or support, block NOW rather than hold back.
    var blocking = false;
    if (!normal.length && typeof ctx.remaining === 'function' && teamOf && bySid && mySid &&
        teamOf(bySid) !== teamOf(mySid) && ctx.remaining(bySid) <= 2) {
      blocking = true;
    }
    var usable = normal.length ? normal : bombs;
    usable.sort(function (a, b) {
      // bombs: smallest bomb first (小炸及时用); blocking uses it regardless.
      return a.pattern.rank - b.pattern.rank ||
        (isBomb(a) ? a.pattern.type - b.pattern.type : 0) ||
        b.cards.length - a.cards.length;
    });
    var best = usable[0];
    var why = normal.length ? '最小即可压' : (blocking ? '拦牌·及时炸' : '大炸沉住气/唯一可压');
    return { cards: best.cards, pattern: best.pattern, name: best.pattern.name, why: why };
  }

  return {
    arrange: arrange, arrangeWith: arrangeWith, arrangeSchemes: arrangeSchemes,
    sortedHand: sortedHand, candidates: candidates, chooseMove: chooseMove,
    handPower: handPower
  };
});
