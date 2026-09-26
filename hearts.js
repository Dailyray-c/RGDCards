/* ============================================================
 * 红心大战 · 规则引擎
 * 纯逻辑层，不依赖任何 DOM / 渲染。可直接复用于将来的人人对战。
 *
 * ⚠️ 必须包在 IIFE 内：本文件与 gongzhu.js 都以「经典 script」加载，
 *    共享同一个全局作用域。两者的顶层 const（SUITS / RANKS /
 *    RANK_VALUE ...）同名，未隔离会直接抛
 *    "Identifier 'SUITS' has already been declared"，
 *    导致后加载的整个模块不执行。
 * ============================================================ */
(function (root) {
'use strict';

/* ---------- 花色与牌面 ---------- */
const SUITS = ['C', 'D', 'S', 'H'];           // 梅花 方块 黑桃 红桃
const SUIT_NAME = { C: '梅花', D: '方块', S: '黑桃', H: '红桃' };
const SUIT_SYMBOL = { C: '♣', D: '♦', S: '♠', H: '♥' };
const SUIT_IS_RED = { C: false, D: true, S: false, H: true };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = RANKS.reduce((m, r, i) => (m[r] = i + 1, m), {});

const QUEEN_OF_SPADES = 'SQ';
const CLUB_2 = 'C2';                           // 梅花 2：全副最小的梅花，固定为首墩首引
const POINTS_PER_HEART = 1;
const POINTS_QUEEN_SPADES = 13;
const TOTAL_POINTS = 26;                       // 13 红心 + 猪
const GAME_OVER_SCORE = 100;

const makeCard = (suit, rank) => `${suit}${rank}`;
const suitOf = (card) => card[0];
const rankOf = (card) => card.slice(1);
const isHeart = (card) => suitOf(card) === 'H';
const isQueenOfSpades = (card) => card === QUEEN_OF_SPADES;

/** 该牌面值多少分（红心 1 分，黑桃 Q 13 分，其余 0） */
function cardPoints(card) {
  if (isQueenOfSpades(card)) return POINTS_QUEEN_SPADES;
  if (isHeart(card)) return POINTS_PER_HEART;
  return 0;
}

/** 生成一副 52 张的牌 */
function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(makeCard(s, r));
  return deck;
}

/** Fisher-Yates 洗牌，可注入随机源以便测试复现 */
function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 手牌排序：先按花色（梅花→方块→黑桃→红桃），再按点数升序 */
function sortHand(hand) {
  return hand.slice().sort((x, y) => {
    const sx = SUITS.indexOf(suitOf(x)), sy = SUITS.indexOf(suitOf(y));
    if (sx !== sy) return sx - sy;
    return RANK_VALUE[rankOf(x)] - RANK_VALUE[rankOf(y)];
  });
}

/* ============================================================
 * 出牌合法性校验
 * ============================================================ */

/**
 * 计算当前手牌中所有合法可出的牌。
 *
 * 五条硬约束：
 *  0. 第一墩的首引必须是梅花 2（且只能是梅花 2）
 *  1. 首轮（第一墩）不得出红心，除非手里只剩红心
 *  2. 首轮（第一墩）不得出黑桃 Q，除非手里只剩黑桃 Q
 *  3. 首引（每墩第一家）不能出红心，除非手里只剩红心
 *  4. 跟牌时，手中若有主导花色则必须跟，不能垫其他花色
 *
 * @param {string[]} hand    当前手牌
 * @param {Object}   ctx     上下文
 * @param {string|null} ctx.leadSuit  本墩主导花色（null 表示自己是首引）
 * @param {boolean}  ctx.isFirstTrick 是否第一墩
 * @param {boolean}  ctx.mustLeadClub2 是否强制首引梅花 2（仅第一墩第一家为 true）
 * @returns {string[]} 合法牌列表
 */
function legalCards(hand, ctx = {}) {
  const { leadSuit = null, isFirstTrick = false, mustLeadClub2 = false } = ctx;
  if (!hand.length) return [];

  // 约束 0：第一墩首引只能出梅花 2。
  //   持 C2 者通常拿得到这张牌；若异常情况下手中没有 C2，
  //   则退化为常规首引规则，避免整局卡死。
  if (mustLeadClub2 && hand.includes(CLUB_2)) return [CLUB_2];

  let pool = hand;

  // 约束 4：有主导花色必须跟花色
  if (leadSuit) {
    const followers = hand.filter((c) => suitOf(c) === leadSuit);
    if (followers.length) pool = followers;
  }

  if (isFirstTrick) {
    // 约束 1 & 2：首轮禁红心、禁猪。
    // 例外：仅当手里「除红心和猪之外」再无他牌时才解禁；
    //       解禁时红心与猪地位平等，一并放开（不能只放一个仍禁另一个）。
    const other = pool.filter((c) => !isHeart(c) && !isQueenOfSpades(c));
    if (other.length) return other;
    return pool;
  }

  if (!leadSuit) {
    // 约束 3：首引不能出红心
    const withoutHearts = pool.filter((c) => !isHeart(c));
    if (withoutHearts.length) pool = withoutHearts;
  }

  return pool;
}

/** 某张牌当前是否可出 */
function isLegal(card, hand, ctx = {}) {
  return legalCards(hand, ctx).includes(card);
}

/* ============================================================
 * 一墩牌的判定
 * ============================================================ */

/**
 * 判定一墩的赢家。
 * @param {{player:number, card:string}[]} plays 按出牌顺序排列
 * @param {number} leadSuit 主导花色
 * @returns {number} 赢家的 player 索引
 */
function trickWinner(plays, leadSuit) {
  let best = plays[0];
  for (const p of plays) {
    if (suitOf(p.card) !== leadSuit) continue;              // 非主导花色不可能赢
    if (suitOf(best.card) !== leadSuit) { best = p; continue; }
    if (RANK_VALUE[rankOf(p.card)] > RANK_VALUE[rankOf(best.card)]) best = p;
  }
  return best.player;
}

/** 统计一墩的罚分 */
function trickPoints(plays) {
  return plays.reduce((sum, p) => sum + cardPoints(p.card), 0);
}

/* ============================================================
 * 结算
 * ============================================================ */

/**
 * 把本局收墩记录换算成四家得分。
 * @param {number[]} collected  每家本局收集到的总点数
 * @param {boolean}  shootTheMoonSelf  true=独收者自己 -26；false=其他三家各 +26
 * @returns {{deltas:number[], shooter:number, shot:boolean}}
 */
function settleRound(collected, shootTheMoonSelf = true) {
  let shooter = -1;
  for (let i = 0; i < 4; i++) {
    if (collected[i] === TOTAL_POINTS) { shooter = i; break; }
  }

  const deltas = collected.slice();
  if (shooter === -1) return { deltas, shooter: -1, shot: false };

  // 满贯：由 shooter 单独收下全部 26 分
  if (shootTheMoonSelf) {
    deltas[shooter] = -TOTAL_POINTS;
  } else {
    deltas[shooter] = 0;
    for (let i = 0; i < 4; i++) if (i !== shooter) deltas[i] = TOTAL_POINTS;
  }
  return { deltas, shooter, shot: true };
}

/** 整场是否结束：任一家累计达到 100 分 */
function isGameOver(scores) {
  return scores.some((s) => s >= GAME_OVER_SCORE);
}

/** 终局排名：总分最低者获胜（升序） */
function ranking(scores) {
  return scores
    .map((score, player) => ({ player, score }))
    .sort((a, b) => a.score - b.score);
}

/* ============================================================
 * 传牌
 * ============================================================ */

/** 传牌方向轮换：左 → 右 → 对家 → 不传 */
const PASS_CYCLE = ['left', 'right', 'across', 'none'];
const PASS_LABEL = { left: '向左传', right: '向右传', across: '传给对家', none: '本局不传牌' };

/** 座位顺时针为 0→1→2→3。返回「我传给谁」 */
function passTarget(mySeat, direction) {
  if (direction === 'left') return (mySeat + 1) % 4;
  if (direction === 'right') return (mySeat + 3) % 4;
  if (direction === 'across') return (mySeat + 2) % 4;
  return -1;
}

/* ============================================================
 * 导出（浏览器全局 + Node 测试双兼容）
 * 浏览器下挂在 window.HEARTS，避免顶层 const 与其他脚本冲突。
 * ============================================================ */
const HEARTS = {
  key: 'hearts',
  SUITS, SUIT_NAME, SUIT_SYMBOL, SUIT_IS_RED, RANKS, RANK_VALUE,
  QUEEN_OF_SPADES, CLUB_2, TOTAL_POINTS, GAME_OVER_SCORE, PASS_CYCLE, PASS_LABEL,
  makeCard, suitOf, rankOf, isHeart, isQueenOfSpades, cardPoints,
  createDeck, shuffle, sortHand,
  legalCards, isLegal, trickWinner, trickPoints,
  settleRound, isGameOver, ranking, passTarget,
};

if (typeof module !== 'undefined' && module.exports) module.exports = HEARTS;
if (root && typeof window !== 'undefined') root.HEARTS = HEARTS;

})(typeof window !== 'undefined' ? window : this);
