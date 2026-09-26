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

/* 各难度「手软」概率：有牌能压时也可能选择不出，给新手留出破绽。
 * 高手档永不手软 —— 这样「AI 难度」在斗地主里也有实际差别，
 * 而不只是影响叫分上限。 */
const SLOPPY = { easy: 0.28, normal: 0.1, hard: 0 };

function playAI(hand, previous, options) {
  const plays = enumeratePlays(hand, previous);
  if (!plays.length) return [];
  const opts = options || {};
  const rnd = typeof opts.random === 'function' ? opts.random : Math.random;
  function compare(a, b) {
    const aSpecial = a.type === 'rocket' || a.type === 'bomb';
    const bSpecial = b.type === 'rocket' || b.type === 'bomb';
    if (!previous && aSpecial !== bSpecial) return aSpecial ? 1 : -1;
    if (previous && aSpecial !== bSpecial) return aSpecial ? 1 : -1;
    if (a.count !== b.count) return a.count - b.count;
    return a.power - b.power;
  }
  plays.sort(compare);
  // ⚠️ 只在「跟牌」时手软。首引（previous 为空）没有「不出」这个选项，
  //    返回空数组会被调用方当成非法动作。
  const sloppy = opts.sloppy != null ? Number(opts.sloppy) : (SLOPPY[opts.difficulty] || 0);
  if (previous && sloppy > 0 && rnd() < sloppy) return [];
  const selected = opts.returnPlay ? plays[0] : plays[0].cards;
  return selected.slice ? selected.slice() : selected;
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
  const multiplier = Math.pow(2, bombs + (hasRocket ? 1 : 0));
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
  playAI, choosePlay: playAI,
  scoreRound, isGameOver
};

if (typeof module !== 'undefined' && module.exports) module.exports = DDZ;
if (root && typeof window !== 'undefined') root.DDZ = DDZ;

})(typeof window !== 'undefined' ? window : this);
