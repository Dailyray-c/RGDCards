(function (root) {
'use strict';

/* ---------- Card model ---------- */
const SUITS = ['C', 'D', 'H', 'S'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SJOKER = 'SJOKER';
const BJOKER = 'BJOKER';
const RANK_VALUE = RANKS.reduce((m, r, i) => {
  m[r] = i + 3;
  return m;
}, { SJOKER: 16, BJOKER: 17 });
const SUIT_VALUE = { C: 0, D: 1, H: 2, S: 3 };
const GAME_OVER_SCORE = 100;

function makeCard(suit, rank) {
  if (rank === SJOKER || rank === BJOKER) return rank;
  return String(suit) + String(rank);
}

function isJoker(card) {
  return card === SJOKER || card === BJOKER;
}

function isCard(card) {
  if (isJoker(card)) return true;
  if (typeof card !== 'string') return false;
  const suit = card.charAt(0);
  const rank = card.slice(1);
  return Object.prototype.hasOwnProperty.call(SUIT_VALUE, suit) &&
    Object.prototype.hasOwnProperty.call(RANK_VALUE, rank) && rank !== 'SJOKER' && rank !== 'BJOKER';
}

function suitOf(card) {
  return isJoker(card) ? 'JOKER' : card.charAt(0);
}

function rankOf(card) {
  return isJoker(card) ? card : card.slice(1);
}

function cardValue(card) {
  const rank = rankOf(card);
  return Object.prototype.hasOwnProperty.call(RANK_VALUE, rank) ? RANK_VALUE[rank] : 0;
}

function createDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) deck.push(makeCard(suit, rank));
  }
  deck.push(SJOKER, BJOKER);
  return deck;
}

function shuffle(cards, rand) {
  const random = rand || Math.random;
  const result = cards.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const value = cardValue(a) - cardValue(b);
    if (value) return value;
    return (SUIT_VALUE[suitOf(a)] || 0) - (SUIT_VALUE[suitOf(b)] || 0);
  });
}

function rankGroups(cards) {
  const groups = {};
  for (const card of cards) {
    const value = cardValue(card);
    if (!value) return null;
    if (!groups[value]) groups[value] = [];
    groups[value].push(card);
  }
  return groups;
}

function consecutive(values) {
  if (!values.length) return false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1] + 1) return false;
  }
  return true;
}

function sequenceValues(values, minimum) {
  return values.length >= minimum && values.every((value) => value >= 3 && value <= 14) && consecutive(values);
}

function makePlay(type, cards, value, extra) {
  const play = {
    type,
    cards: cards.slice(),
    count: cards.length,
    value,
    power: value
  };
  if (extra) Object.assign(play, extra);
  return play;
}

function classifyPlay(input) {
  const cards = Array.isArray(input) ? input.slice() : (input && input.cards ? input.cards.slice() : []);
  if (!cards.length) return null;
  if (cards.some((card) => !isCard(card))) return null;
  // 同一张实体牌不能出现两次 —— 少了这一句，['C3','C3'] 会被判成「一对 3」。
  // 实际上无法利用（isLegalPlay 会拿手牌做去重校验），但牌型识别本身不该说谎。
  if (new Set(cards).size !== cards.length) return null;
  const groups = rankGroups(cards);
  if (!groups) return null;
  const values = Object.keys(groups).map(Number).sort((a, b) => a - b);
  const counts = values.map((value) => groups[value].length).sort((a, b) => a - b);
  const total = cards.length;
  const highest = values[values.length - 1];

  if (total === 2 && cards.includes(SJOKER) && cards.includes(BJOKER)) {
    return makePlay('rocket', cards, 17);
  }
  if (total === 1) return makePlay('single', cards, highest);
  if (total === 2 && counts.length === 1 && counts[0] === 2) {
    return makePlay('pair', cards, highest);
  }
  if (total === 3 && counts.length === 1 && counts[0] === 3) {
    return makePlay('triple', cards, highest);
  }
  if (total === 4 && counts.length === 1 && counts[0] === 4) {
    return makePlay('bomb', cards, highest);
  }
  if (total === 4 && counts.length === 2 && counts[1] === 3) {
    return makePlay('tripleSingle', cards, values.find((value) => groups[value].length === 3));
  }
  if (total === 5 && counts.length === 2 && counts[0] === 2 && counts[1] === 3) {
    return makePlay('triplePair', cards, values.find((value) => groups[value].length === 3));
  }

  if (total >= 5 && values.length === total && sequenceValues(values, 5)) {
    return makePlay('straight', cards, highest, { sequenceLength: values.length, startValue: values[0] });
  }
  if (total >= 6 && total % 2 === 0 && counts.length === total / 2 &&
      counts.every((count) => count === 2) && sequenceValues(values, 3)) {
    return makePlay('pairStraight', cards, highest, { sequenceLength: values.length, startValue: values[0] });
  }

  const plane = classifyAirplane(cards, groups, values);
  if (plane) return plane;
  return null;
}

function classifyAirplane(cards, groups, values) {
  const total = cards.length;
  if (values.length < 2 || values.some((value) => value < 3 || value > 14)) return null;
  const candidates = [];
  for (let start = 3; start <= 14; start++) {
    for (let length = 2; start + length - 1 <= 14; length++) {
      const main = [];
      for (let value = start; value < start + length; value++) main.push(value);
      if (!main.every((value) => groups[value] && groups[value].length >= 3)) continue;
      candidates.push(main);
    }
  }
  candidates.sort((a, b) => b.length - a.length || b[b.length - 1] - a[a.length - 1]);

  for (const main of candidates) {
    const n = main.length;
    if (total === n * 3) {
      const pureCounts = values.every((value) => main.includes(value) && groups[value].length === 3);
      if (pureCounts) {
        return makePlay('airplane', cards, main[main.length - 1], {
          sequenceLength: n, startValue: main[0], mainValues: main.slice(), wingType: 'none'
        });
      }
    }
    if (total === n * 4) {
      const remaining = [];
      for (const value of values) {
        const take = main.includes(value) ? 3 : 0;
        for (let i = take; i < groups[value].length; i++) remaining.push(value);
      }
      if (remaining.length === n && new Set(remaining).size === n) {
        return makePlay('airplane', cards, main[main.length - 1], {
          sequenceLength: n, startValue: main[0], mainValues: main.slice(), wingType: 'single'
        });
      }
    }
    if (total === n * 5) {
      const remaining = [];
      for (const value of values) {
        const take = main.includes(value) ? 3 : 0;
        for (let i = take; i < groups[value].length; i++) remaining.push(value);
      }
      const remGroups = {};
      for (const value of remaining) {
        remGroups[value] = (remGroups[value] || 0) + 1;
      }
      const remValues = Object.keys(remGroups).map(Number);
      if (remaining.length === n * 2 && remValues.length === n && remValues.every((value) => remGroups[value] === 2)) {
        return makePlay('airplane', cards, main[main.length - 1], {
          sequenceLength: n, startValue: main[0], mainValues: main.slice(), wingType: 'pair'
        });
      }
    }
  }
  return null;
}

function playCards(play) {
  return Array.isArray(play) ? play : (play && Array.isArray(play.cards) ? play.cards : []);
}

function canBeat(current, previous) {
  const now = classifyPlay(current);
  const before = previous == null ? null : classifyPlay(previous);
  if (!now) return false;
  if (!before) return previous == null;
  if (now.type === 'rocket') return true;
  if (before.type === 'rocket') return false;
  if (now.type === 'bomb' && before.type !== 'bomb') return true;
  if (now.type !== 'bomb' && before.type === 'bomb') return false;
  if (now.type !== before.type) return false;
  if (now.count !== before.count) return false;
  if (now.type === 'airplane' && now.wingType !== before.wingType) return false;
  return now.power > before.power;
}

function removeCardsOnce(hand, cards) {
  const available = hand.slice();
  for (const card of cards) {
    const index = available.indexOf(card);
    if (index < 0) return false;
    available.splice(index, 1);
  }
  return true;
}

function isLegalPlay(hand, cards, previous) {
  let actualHand = hand;
  let actualCards = cards;
  let actualPrevious = previous;

  if (arguments.length < 3) {
    if (cards == null) {
      actualCards = hand;
      actualHand = null;
      actualPrevious = null;
    } else if (Array.isArray(hand) && Array.isArray(cards) && hand.length > cards.length && removeCardsOnce(hand, cards)) {
      actualHand = hand;
      actualCards = cards;
      actualPrevious = null;
    } else {
      actualCards = hand;
      actualHand = null;
      actualPrevious = cards;
    }
  }

  const play = classifyPlay(actualCards);
  if (!play) return false;
  if (Array.isArray(actualHand) && !removeCardsOnce(actualHand, actualCards)) return false;
  return actualPrevious == null || canBeat(play, actualPrevious);
}

function combinations(items, size) {
  const result = [];
  function visit(start, picked) {
    if (picked.length === size) {
      result.push(picked.slice());
      return;
    }
    for (let i = start; i <= items.length - (size - picked.length); i++) {
      picked.push(items[i]);
      visit(i + 1, picked);
      picked.pop();
    }
  }
  if (size > 0 && size <= items.length) visit(0, []);
  return result;
}

function firstCards(groups, values, countEach) {
  const cards = [];
  for (const value of values) {
    const group = groups[value];
    if (!group || group.length < countEach) return null;
    cards.push.apply(cards, group.slice(0, countEach));
  }
  return cards;
}

function enumeratePlays(hand, previous) {
  const sorted = sortHand(hand);
  const groups = rankGroups(sorted) || {};
  const values = Object.keys(groups).map(Number).sort((a, b) => a - b);
  const result = [];
  const seen = {};

  function add(cards) {
    if (!cards || !cards.length) return;
    const key = sortHand(cards).join(',');
    if (seen[key]) return;
    const play = classifyPlay(cards);
    if (!play || !removeCardsOnce(sorted, cards)) return;
    if (previous != null && !canBeat(play, previous)) return;
    seen[key] = true;
    result.push(play);
  }

  for (const card of sorted) add([card]);
  for (const value of values) {
    if (groups[value].length >= 2) {
      for (const cards of combinations(groups[value], 2)) add(cards);
    }
    if (groups[value].length >= 3) {
      for (const cards of combinations(groups[value], 3)) add(cards);
    }
    if (groups[value].length >= 4) add(groups[value].slice(0, 4));
  }
  if (groups[16] && groups[17]) add([groups[16][0], groups[17][0]]);

  for (const value of values) {
    if (groups[value].length < 3) continue;
    for (const triple of combinations(groups[value], 3)) {
      for (const card of sorted) {
        if (triple.indexOf(card) < 0 && cardValue(card) !== value) add(triple.concat([card]));
      }
      for (const pairValue of values) {
        if (pairValue !== value && groups[pairValue].length >= 2) {
          add(triple.concat(groups[pairValue].slice(0, 2)));
        }
      }
    }
  }

  for (let start = 3; start <= 14; start++) {
    for (let length = 5; start + length - 1 <= 14; length++) {
      const run = [];
      for (let value = start; value < start + length; value++) run.push(value);
      const straight = firstCards(groups, run, 1);
      const pairStraight = firstCards(groups, run, 2);
      if (straight) add(straight);
      if (pairStraight && length >= 3) add(pairStraight);
    }
  }

  for (let start = 3; start <= 14; start++) {
    for (let length = 2; start + length - 1 <= 14; length++) {
      const run = [];
      for (let value = start; value < start + length; value++) run.push(value);
      const plane = firstCards(groups, run, 3);
      if (!plane) continue;
      add(plane);

      const remaining = sorted.filter((card) => {
        const index = plane.indexOf(card);
        if (index >= 0) {
          plane[index] = null;
          return false;
        }
        return true;
      });
      for (const wings of combinations(remaining.filter((card) => !run.includes(cardValue(card))), length)) {
        add(firstCards(groups, run, 3).concat(wings));
      }
      const wingPairs = values.filter((value) => !run.includes(value) && groups[value].length >= 2);
      if (wingPairs.length >= length) {
        for (const pairValues of combinations(wingPairs, length)) {
          const wings = [];
          for (const value of pairValues) wings.push.apply(wings, groups[value].slice(0, 2));
          add(firstCards(groups, run, 3).concat(wings));
        }
      }
    }
  }
  return result;
}

function handProfile(hand) {
  const groups = rankGroups(hand) || {};
  const values = Object.keys(groups).map(Number);
  let bombs = 0;
  let triples = 0;
  let pairs = 0;
  for (const value of values) {
    const count = groups[value].length;
    if (count >= 4) bombs++;
    else if (count === 3) triples++;
    else if (count === 2) pairs++;
  }
  return {
    groups,
    values,
    bombs,
    triples,
    pairs,
    smallJoker: !!groups[16],
    bigJoker: !!groups[17],
    rocket: !!groups[16] && !!groups[17]
  };
}

function bidAI(hand, currentBid, options) {
  let bid = currentBid;
  let opts = options || {};
  if (currentBid && typeof currentBid === 'object') {
    opts = currentBid;
    bid = opts.currentBid || 0;
  }
  bid = Number(bid) || 0;
  const profile = handProfile(hand);
  let estimate = 0;
  if (profile.rocket) estimate += 3;
  estimate += Math.min(2, profile.bombs);
  if (profile.smallJoker) estimate += 0.5;
  if (profile.bigJoker) estimate += 0.8;
  estimate += Math.min(1, profile.triples * 0.35);
  estimate += Math.min(0.6, profile.pairs * 0.08);
  for (const value of profile.values) {
    if (value >= 14) estimate += 0.12;
    else if (value >= 12) estimate += 0.05;
  }
  let maxBid = estimate >= 4.5 ? 3 : estimate >= 2.2 ? 2 : estimate >= 0.85 ? 1 : 0;
  if (opts.maxBid != null) maxBid = Math.min(maxBid, Number(opts.maxBid));
  return maxBid > bid ? maxBid : 0;
}

/**
 * 手牌强度 → 期望叫分（0~3）。必须高于当前最高分才叫。
 *
 * ⚠️ est 的分布是「火箭/炸弹主导」的双峰形态（实测 17 张手牌）：
 *      p75 1.85 / p90 2.65 / p95 5.35 —— 区间 [2.7, 4.5) 几乎没有牌。
 *    旧阈值把「叫 2 分」的下限定在 2.6，正好落在空洞里，
 *    结果叫 2 分只占 0.4%（玩家根本见不到），AI 看起来只会「叫 1 分」或「直接叫 3 分」。
 *    这里把 2 分下限挪到 2.0（对应 ~18.6% 的牌，扣掉叫 3 的还剩约 9%），把 2 分区间补出来。
 */
const CALL_THRESHOLD = {
  easy: [1.0, 2.4, 5.2],      // 入门档几乎不叫 3 分
  normal: [1.2, 2.0, 4.2],
  hard: [1.1, 1.9, 4.0],      // 高手打得动，敢多叫一点
};

function callLandlordAI(hand, options) {
  const opts = options || {};
  const th = CALL_THRESHOLD[opts.difficulty] || CALL_THRESHOLD.normal;
  const est = bidEstimate(hand);
  const want = est >= th[2] ? 3 : est >= th[1] ? 2 : est >= th[0] ? 1 : 0;
  const cur = Number(opts.currentBid) || 0;
  if (want <= cur) return 0;       // 不叫（或已无法更高）
  return Math.min(3, want);
}

/**
 * 抢地主阈值（bool）。
 *
 * ⚠️ 抢一次就把底分 ×2，成本远高于「叫 1 分」，所以门槛必须**高于**叫 1 分的门槛，
 *    否则会出现「轮到我时不叫，别人叫了我却去抢」的倒挂行为
 *    （旧值 hard=0.9 < 叫1分所需 1.2，实测 21.9% 的牌是这种矛盾态，
 *     高手档 88.1% 的牌会抢，一局平均倍数冲到 10.8）。
 * ⚠️ 每多抢一次再上一层台阶，避免同一局被一路翻到 ×16。
 */
/**
 * ⚠️ 门槛必须对着「实际会被问到「抢」的那些牌」来标定，而不是全部 17 张牌。
 *    候选人不再参与抢之后（旧规则里候选人最后被问、必然自己回抢），
 *    被问的两家是「叫分没叫赢」的牌，est 明显偏低：
 *        全体 p50 1.50 / p90 2.65  →  被问者 p50 1.24 / p90 1.85 / p95 2.00
 *    照未条件的分布定阈值会把「抢」掐死（实测只剩 1.3% 的动手率）。
 *    目标：每被问一次约 12~15% 动手，换算成整局约 1/4 的概率真正易主。
 */
const GRAB_BASE = { easy: 1.95, normal: 1.80, hard: 1.70 };
const GRAB_STEP = 0.7;         // 每有一次抢，门槛抬高
const GRAB_BID_STEP = 0.35;    // 底分越高，抢（加倍）越贵

function grabLandlordAI(hand, options) {
  const opts = options || {};
  const est = bidEstimate(hand);
  const base = GRAB_BASE[opts.difficulty] != null ? GRAB_BASE[opts.difficulty] : GRAB_BASE.normal;
  const already = Number(opts.grabCount) || 0;
  const bid = Number(opts.callBid) || 1;
  const t = base + GRAB_STEP * already + GRAB_BID_STEP * Math.max(0, bid - 1);
  return est >= t;
}

/** 复用 bidAI 里的强度估算（不暴露中间函数名，这里包一层）。 */
function bidEstimate(hand) {
  const profile = handProfile(hand);
  let estimate = 0;
  if (profile.rocket) estimate += 3;
  estimate += Math.min(2, profile.bombs);
  if (profile.smallJoker) estimate += 0.5;
  if (profile.bigJoker) estimate += 0.8;
  estimate += Math.min(1, profile.triples * 0.35);
  estimate += Math.min(0.6, profile.pairs * 0.08);
  for (const value of profile.values) {
    if (value >= 14) estimate += 0.12;
    else if (value >= 12) estimate += 0.05;
  }
  return estimate;
}

/* ============================================================
 * 出牌 AI（斗地主）
 *
 * 旧实现只做「挑张数最少、点数最小的牌型」，实测 99.5% 的出牌都是单张：
 * 既不像人打的（对子 / 顺子 / 三带一几乎从不出现），也让三档难度除了
 * 「手软概率」之外毫无区别。这里以「手数」为核心重写 ——
 * 手数 = 把整手牌打完需要几手，斗地主的胜负基本就取决于谁的手数少。
 *
 *   入门 —— 会出对子/三张，但不会组顺子，常手软，不判断队友
 *   熟练 —— 按手数取舍，给队友让路，保留炸弹
 *   高手 —— 手数 + 记牌（绝张）+ 威胁判断 + 残局一击
 *
 * options 可额外带：
 *   me / landlord / lastPlayer —— 座位，用于判断队友与威胁（不传则退化）
 *   counts  —— 各家剩余张数数组
 *   played  —— 已出现过的牌数组（高手档记牌用）
 * ============================================================ */

/* 各难度「手软」概率：有牌能压时也可能选择不出，给新手留出破绽。 */
const SLOPPY = { easy: 0.3, normal: 0.12, hard: 0 };

/* 顺子类牌型的搜索规格：need=每个点数取几张，min=最短长度 */
const SEQ_SPECS = [
  { need: 1, min: 5, rank: 14, type: 'straight' },
  { need: 2, min: 3, rank: 14, type: 'pairStraight' },
  { need: 3, min: 2, rank: 14, type: 'airplane' },
];

/** 按点数计数 {value: n} */
function countByValue(cards) {
  const m = {};
  for (const c of cards) {
    const v = cardValue(c);
    m[v] = (m[v] || 0) + 1;
  }
  return m;
}

/** 这些点数当前占用几手（同点数不论几张，打出时都算一手） */
function handsOfValues(counts, values) {
  let h = 0;
  for (const v of values) if ((counts[v] || 0) > 0) h += 1;
  return h;
}

/** 枚举所有连续段：每点至少 need 张、长度 >= minLen、点数 3..maxRank */
function enumSequences(counts, need, minLen, maxRank) {
  const out = [];
  const vals = [];
  for (let v = 3; v <= maxRank; v++) if ((counts[v] || 0) >= need) vals.push(v);
  let i = 0;
  while (i < vals.length) {
    let j = i;
    while (j + 1 < vals.length && vals[j + 1] === vals[j] + 1) j++;
    for (let a = i; a <= j; a++) {
      for (let b = a + minLen - 1; b <= j; b++) out.push(vals.slice(a, b + 1));
    }
    i = j + 1;
  }
  return out;
}

/** 手数估计：贪心提取长牌型后，打完这手牌还要几手（越小越好） */
function estimateHands(counts) {
  const c = {};
  for (const k in counts) c[k] = counts[k];
  let units = 0;
  for (let round = 0; round < 4; round++) {
    let best = null;
    for (const spec of SEQ_SPECS) {
      for (const seq of enumSequences(c, spec.need, spec.min, spec.rank)) {
        const before = handsOfValues(c, seq);
        let after = 0;
        for (const v of seq) if (c[v] - spec.need > 0) after += 1;
        const gain = before - after - 1;
        if (gain > 0 && (!best || gain > best.gain)) best = { gain: gain, seq: seq, need: spec.need };
      }
    }
    if (!best) break;
    for (const v of best.seq) c[v] -= best.need;
    units++;
  }
  let base = 0;
  for (const k in c) if (c[k] > 0) base += 1;
  if (c[16] > 0 && c[17] > 0) base -= 1;   // 双王可组成火箭，合一手
  return base + units;
}

/**
 * 把一手牌拆成若干「出牌单元」。这是首引的候选池 ——
 * 按计划出牌才不会把顺子拆散、把对子拆成两张单牌。
 */
/**
 * 把一手牌拆成若干「出牌单元」。这是首引的候选池 ——
 * 按计划出牌才不会把顺子拆散、把对子拆成两张单牌。
 * allowSeq=false 时不组顺子/连对/飞机（入门档：只会单张、对子、三张）。
 */
function decomposeHand(hand, allowSeq) {
  const groups = {};
  const counts = {};
  for (const c of hand) {
    const v = cardValue(c);
    if (!groups[v]) { groups[v] = []; counts[v] = 0; }
    groups[v].push(c);
    counts[v]++;
  }
  const units = [];
  function pop(v, n) {
    const out = [];
    for (let i = 0; i < n; i++) { out.push(groups[v].pop()); counts[v]--; }
    return out;
  }
  const maxOf = (arr) => arr.reduce((a, b) => (b > a ? b : a), arr[0]);
  const seqGain = (seq, need) => {
    const before = handsOfValues(counts, seq);
    let after = 0;
    for (const v of seq) if (counts[v] - need > 0) after += 1;
    return before - after - 1;
  };

  // 火箭：双王先留出来，绝不拆开当两张单牌打
  if (counts[16] > 0 && counts[17] > 0) {
    units.push({ type: 'rocket', cards: [groups[16].pop(), groups[17].pop()], power: 17, count: 2 });
    counts[16]--; counts[17]--;
  }
  // 长牌型：每轮挑「省下手数最多」的一段，最多四段
  if (allowSeq !== false) {
    for (let round = 0; round < 4; round++) {
      let best = null;
      for (const spec of SEQ_SPECS) {
        for (const seq of enumSequences(counts, spec.need, spec.min, spec.rank)) {
          const gain = seqGain(seq, spec.need);
          if (gain > 0 && (!best || gain > best.gain)) best = { gain: gain, seq: seq, spec: spec };
        }
      }
      if (!best) break;
      const cards = [];
      for (const v of best.seq) cards.push.apply(cards, pop(v, best.spec.need));
      units.push({ type: best.spec.type, cards: cards, power: maxOf(best.seq), count: cards.length });
    }
  }
  const values = Object.keys(counts).map(Number).sort((a, b) => a - b);
  // 炸弹
  for (const v of values) {
    if (counts[v] === 4 && v <= 15) units.push({ type: 'bomb', cards: pop(v, 4), power: v, count: 4 });
  }
  // 剩下的按三张 / 对子 / 单张各自成手
  for (const v of values) {
    while (counts[v] >= 3) units.push({ type: 'triple', cards: pop(v, 3), power: v, count: 3 });
    if (counts[v] === 2) units.push({ type: 'pair', cards: pop(v, 2), power: v, count: 2 });
    else if (counts[v] === 1) units.push({ type: 'single', cards: pop(v, 1), power: v, count: 1 });
  }
  return units;
}

/** 从手牌里拿掉若干张（不改动原数组） */
function removeCards(hand, cards) {
  const rest = hand.slice();
  for (const c of cards) {
    const i = rest.indexOf(c);
    if (i >= 0) rest.splice(i, 1);
  }
  return rest;
}

function isBombLike(play) { return play.type === 'bomb' || play.type === 'rocket'; }

/** 首引候选：出牌单元 + 三带一 / 三带二（能多顺走一张，通常更划算） */
function buildLeadCandidates(hand, level) {
  const units = decomposeHand(hand, level >= 1);
  const out = units.slice();
  for (const t of units) {
    if (t.type !== 'triple') continue;
    const single = units.find((u) => u !== t && u.type === 'single');
    const pair = units.find((u) => u !== t && u.type === 'pair');
    if (single) {
      out.push({ type: 'tripleSingle', cards: t.cards.concat(single.cards),
        power: t.power, count: 4, kick: cardValue(single.cards[0]) });
    }
    if (pair) {
      out.push({ type: 'triplePair', cards: t.cards.concat(pair.cards),
        power: t.power, count: 5, kick: cardValue(pair.cards[0]) });
    }
  }
  return out;
}

/** 由已出现的牌推出「还没露面」的牌（含其他两家手牌与底牌） */
function unseenCounts(hand, played) {
  const counts = countByValue(createDeck());
  for (const c of hand) counts[cardValue(c)]--;
  for (const c of (played || [])) counts[cardValue(c)]--;
  return counts;
}

/**
 * 还没露面的牌里，还有几种能压过这个牌型（高手档记牌用）。
 * 返回 0 表示这一手打出去没人接得起 —— 白得一轮出牌权。
 */
function beatsLeft(play, unseen) {
  if (!unseen) return 1;
  let n = 0;
  if (play.type === 'single' || play.type === 'pair') {
    const need = play.type === 'single' ? 1 : 2;
    for (let v = play.power + 1; v <= 17; v++) n += Math.floor((unseen[v] || 0) / need);
  } else {
    for (let v = play.power + 1; v <= 17; v++) {
      if ((unseen[v] || 0) >= (play.type === 'bomb' || play.type === 'rocket' ? 4 : 1)) n++;
    }
  }
  return n;
}

function buildPlayContext(opts, hand, previous) {
  const level = opts.difficulty === 'easy' ? 0 : opts.difficulty === 'hard' ? 2 : 1;
  const me = opts.me, landlord = opts.landlord, lastPlayer = opts.lastPlayer;
  const counts = opts.counts || null;
  const ctx = {
    level: level,
    hand: hand,
    handLen: hand.length,
    nowHands: estimateHands(countByValue(hand)),
    me: me,
    landlord: landlord,
    lastPlayer: lastPlayer,
    counts: counts,
    unseen: level >= 2 ? unseenCounts(hand, opts.played) : null,
    previous: previous,
    pressure: 0,
  };
  const knownRoles = me != null && landlord != null && counts;
  // 上一手是队友打的（两个农民之间）→ 让路
  ctx.lastIsTeammate = !!(previous && knownRoles && lastPlayer != null &&
    lastPlayer !== landlord && me !== landlord && lastPlayer !== me);

  if (knownRoles) {
    // 敌方（对地主是两个农民，对农民是地主 + 未知底牌）里手牌最少的一家
    let enemyMin = 99;
    if (me === landlord) {
      for (let s = 0; s < counts.length; s++) if (s !== landlord) enemyMin = Math.min(enemyMin, counts[s]);
    } else {
      enemyMin = counts[landlord];
    }
    ctx.enemyMin = enemyMin;
    // 紧迫度：对手快走完了 / 我自己也快走完了，出牌权就值钱了。
    // 高手档对「还剩几手就输」更敏感，残局压得更凶。
    const tense = level >= 2 ? 1.5 : 1;
    if (enemyMin <= 2) ctx.pressure += 2 * tense;
    else if (enemyMin <= 4) ctx.pressure += 1 * tense;
    if (ctx.handLen <= 3) ctx.pressure += 1 * tense;
    // 威胁：再放一手敌方就走了
    ctx.threat = enemyMin <= 2;
    if (!ctx.lastIsTeammate && lastPlayer != null && counts[lastPlayer] <= 2) ctx.threat = true;
  } else {
    ctx.enemyMin = 99;
    ctx.threat = false;
  }
  ctx.prevIsBomb = !!(previous && isBombLike(classifyPlay(previous) || {}));

  /* ---- 角色与位置 ----
   * 出牌顺序 地主 → 下家 → 上家 → 地主：
   *   下家  (landlord+1)：跟在地主后面出，负责给队友喂小牌
   *   上家  (landlord+2)：出完就轮到地主，是「门板位」，负责死顶地主
   * 地主丢失出牌权的代价是两家轮着出，所以同等条件下比农民更该压。 */
  ctx.role = knownRoles ? (me === landlord ? 'landlord' : 'farmer') : null;
  ctx.isGuard = ctx.role === 'farmer' && (landlord + 2) % 3 === me;
  ctx.isFeeder = ctx.role === 'farmer' && (landlord + 1) % 3 === me;
  return ctx;
}

/** 首引：从出牌计划里挑一手，标准是「出完剩下手数最少」 */
function chooseLead(ctx, rnd) {
  const cands = buildLeadCandidates(ctx.hand, ctx.level);
  if (!cands.length) return null;
  let best = null, bestScore = -Infinity;
  for (const p of cands) {
    const rest = removeCards(ctx.hand, p.cards);
    const after = estimateHands(countByValue(rest));
    let s = -after * 12;
    if (!rest.length) s += 500;                       // 一手走完，直接赢
    // 平时别急着甩大牌；被威胁时反过来要压；
    // 高手档的门板位知道自己该顶，出牌没那么忌讳用大牌
    const guardOK = ctx.level >= 2 && ctx.isGuard;
    s -= p.power * (ctx.threat ? -0.2 : (guardOK ? 0.2 : 0.4));
    if (p.kick) s -= p.kick * 0.4;                    // 三带别把大牌垫出去
    if (isBombLike(p)) s -= 60;                       // 炸弹留着
    if (p.count > 1) s += 2;                          // 同等条件下多走几张
    // 队友只剩一张时出单牌送他走；地主只剩一张时尽量不出单牌
    if (ctx.level >= 1 && ctx.me != null && ctx.landlord != null && ctx.counts) {
      const mate = ctx.me === ctx.landlord ? -1 : (3 - ctx.me - ctx.landlord);
      if (mate >= 0 && ctx.counts[mate] === 1 && p.type === 'single') s += 25;
      if (ctx.me !== ctx.landlord && ctx.counts[ctx.landlord] === 1 && p.type === 'single') s -= 20;
    }
    // 高手档记牌：没人接得起的牌优先出（白得一轮）
    if (ctx.level >= 2 && beatsLeft(p, ctx.unseen) === 0) s += 10;
    if (ctx.level === 0) s += rnd() * 14;             // 入门档判断不稳
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best;
}

/**
 * 跟牌的价值：赚到的是「出一轮牌 + 少一手」，付出去的是「牌力」。
 * 只看前者的话，AI 会拿 2 和王去压一张 3 —— 手数是少了，控制力也没了。
 */
function followScore(ctx, p, after) {
  let s = (ctx.nowHands - 1 - after) * 12;   // 手数收益（0=正常，正数=赚了）
  s -= p.power * 0.7;                        // 牌力代价：牌越大越不该用来压小牌
  if (p.kick) s -= p.kick * 0.4;
  s += ctx.pressure * 7;                     // 局势越紧，出牌权越值钱
  // 记牌：压完没人接得起 = 白得一轮出牌权（+14）。
  // ⚠️ 「还有牌能接」不要扣分：实测任何幅度的惩罚都会让高手档不敢跟牌，
  //    反而弱于熟练档（给到 -10 时胜率掉到 41%，-3 也一样）。
  if (ctx.level >= 2 && beatsLeft(p, ctx.unseen) === 0) s += 14;
  // 角色／位置意识属于「高手」：熟练档只知道基本的让路与算账。
  //   地主 —— 把出牌权交出去是两家轮着打，成本最高，所以更该压
  //   门板（地主上家）—— 出完就轮到地主，压住地主是本分
  // ⚠️ followScore 只在「对付敌人」时给角色加成。压队友属于自己人内耗，不该给分。
  if (ctx.level >= 2 && !ctx.lastIsTeammate) {
    if (ctx.role === 'landlord') s += 4;
    else if (ctx.isGuard) s += 2;
  }
  return s;
}

/** 跟牌：能压就压？取决于「赚到的」够不够付「牌力」 */
function chooseFollow(ctx, plays) {
  // 能一手走完 → 无论如何先走
  for (const p of plays) if (p.count === ctx.handLen) return p;
  // ⚠️ 这里曾经是「队友出的牌一律让路 return null」，实测农民整局只出 4~9 张牌，
  //    两个农民互相让到输。现在改成门槛制，见下面 need 的计算。

  let best = null, bestScore = -Infinity;
  for (const p of plays) {
    // 炸弹只在「必须打」或对方也是炸弹时才用
    if (isBombLike(p) && !(ctx.threat && (ctx.prevIsBomb || ctx.handLen <= 4))) continue;
    const rest = removeCards(ctx.hand, p.cards);
    const after = estimateHands(countByValue(rest));
    if (!rest.length) return p;                    // 这一手打完就赢了
    const s = followScore(ctx, p, after);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (!best) return null;
  if (ctx.level === 0) return best;                 // 入门档：有牌就压，不算账

  // 出手门槛（越低 = 越愿意出牌）：
  //   · 队友领出 —— 原则上让路，但账上明显划算时（不亏手数、也不花大牌）可以接过来自己领。
  //     ⚠️ 早期这里是「直接 return null」，结果农民一局只出四五张牌，等于两个人互相让到输。
  //   · 农民面对地主 —— 应该比「地主面对农民」更凶：地主交出牌权是两家轮着打，
  //     农民放走地主却可能直接输掉整局，所以这里给农民更低的门槛。
  let need;
  if (ctx.lastIsTeammate) need = ctx.level >= 2 ? 5 : 7;
  else if (ctx.level >= 2) need = ctx.role === 'landlord' ? -7 : (ctx.isGuard ? -7 : -6);
  else need = -6;
  return bestScore >= need ? best : null;
}
function playAI(hand, previous, options) {
  if (!hand || !hand.length) return [];
  const opts = options || {};
  const rnd = typeof opts.random === 'function' ? opts.random : Math.random;

  // 首引（previous 为空）没有「不出」这个选项，返回空数组会被当成非法动作。
  if (!previous) {
    const ctx = buildPlayContext(opts, hand, previous);
    const lead = chooseLead(ctx, rnd);
    if (!lead) return [];
    return opts.returnPlay ? lead : lead.cards.slice();
  }

  const plays = enumeratePlays(hand, previous);
  if (!plays.length) return [];
  const sloppy = opts.sloppy != null ? Number(opts.sloppy) : (SLOPPY[opts.difficulty] || 0);
  if (sloppy > 0 && rnd() < sloppy) return [];

  const ctx = buildPlayContext(opts, hand, previous);
  const pick = chooseFollow(ctx, plays);
  if (!pick) return [];
  return opts.returnPlay ? pick : pick.cards.slice();
}

function scoreRound(baseBid, landlordWin, bombCount, rocket) {
  let input;
  if (baseBid && typeof baseBid === 'object') {
    input = baseBid;
  } else if (typeof landlordWin === 'boolean') {
    input = { baseBid, landlordWin, bombCount, rocket };
  } else {
    input = { baseBid, bombCount: landlordWin, rocket: bombCount, landlordWin: rocket };
  }
  const bid = Number(input.baseBid) || 0;
  const bombs = Math.max(0, Number(input.bombCount) || 0);
  const hasRocket = !!input.rocket;
  const grabs = Math.max(0, Number(input.grabs) || 0);  // 抢地主次数，每次 ×2
  const spring = !!input.spring;           // 春天：地主赢且农民全程一张未出
  const antiSpring = !!input.antiSpring;   // 反春天：农民赢且地主只首引一手
  let multiplier = Math.pow(2, bombs + (hasRocket ? 1 : 0) + grabs);
  if (spring) multiplier *= 2;
  if (antiSpring) multiplier *= 2;
  const unit = bid * multiplier;
  let landlordDelta;
  let farmerDelta;
  if (input.landlordWin === true || input.winner === 'landlord') {
    landlordDelta = unit * 2;
    farmerDelta = -unit;
  } else {
    landlordDelta = -unit * 2;
    farmerDelta = unit;
  }
  return {
    baseBid: bid,
    bombCount: bombs,
    rocket: hasRocket,
    grabs,
    spring,
    antiSpring,
    multiplier,
    unit,
    landlordWin: input.landlordWin === true || input.winner === 'landlord',
    landlordDelta,
    farmerDelta,
    deltas: [landlordDelta, farmerDelta, farmerDelta]
  };
}

function isGameOver(scores, target) {
  const limit = target == null ? GAME_OVER_SCORE : target;
  return scores.some((score) => score >= limit);
}

const DDZ = {
  SUITS, RANKS, RANK_VALUE, SUIT_VALUE, SJOKER, BJOKER, GAME_OVER_SCORE,
  makeCard, isCard, isJoker, suitOf, rankOf, cardValue,
  createDeck, shuffle, sortHand,
  classifyPlay, canBeat, isLegalPlay, enumeratePlays,
  bidAI, chooseBid: bidAI, callBidAI: bidAI,
  callLandlordAI, grabLandlordAI, bidEstimate, handProfile,
  playAI, choosePlay: playAI,
  scoreRound, isGameOver
};

if (typeof module !== 'undefined' && module.exports) module.exports = DDZ;
if (root && typeof window !== 'undefined') root.DDZ = DDZ;

})(typeof window !== 'undefined' ? window : this);
