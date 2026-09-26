/* ============================================================
 * 拱猪 · 规则引擎
 * 纯逻辑层，不依赖任何 DOM / 渲染。
 *
 * 计分体系（经典拱猪）：
 *   🐷 黑桃 Q   = -100    羊 ♦J     = +100
 *   ⚡ 梅花 10  = 变压器（无自身分值）
 *   ♥ 红桃按牌面扣分：
 *       2、3、4 无分；5~10 各 -10；J -20；Q -30；K -40；A -50
 *       红桃合计 = -200
 *   ♥ 满红（一人收齐 13 张红桃）= +200（红桃部分整体转正，替代原有负分）
 *   🎉 满贯（同一个人收齐 13 张红桃 + 猪 + 羊）= +400
 *
 * 传牌：
 *   拱猪**没有传牌规则**，发牌后直接开打。
 *
 * 变压器（♣10）：
 *   收下者本局所有分数「翻倍」；若本局收下的分恰好为 0，则改为 +50。
 *
 * 亮牌（卖牌）：
 *   开局前可亮出 猪 / 羊 / 变压器 / 红桃A，亮出的牌在结算时分数翻倍。
 *   亮的牌越多，风险与收益同时放大。
 *
 * ⚠️ 必须包在 IIFE 内：本文件与 hearts.js 都以「经典 script」加载，
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

/* ---------- 拱猪专用常量 ---------- */
const PIG = 'SQ';                    // 猪
const SHEEP = 'DJ';                  // 羊
const TRANSFORMER = 'C10';           // 变压器
const CLUB_2 = 'C2';                 // 梅花 2：首墩首引

const PIG_POINTS = -100;
const SHEEP_POINTS = 100;
const TRANSFORMER_EMPTY_BONUS = 50;  // 变压器无分时改为 +50
const MOON_BONUS = 200;              // 满红奖励（红桃部分整体转正）
const GRAND_SLAM_BONUS = 400;        // 满贯：满红 + 猪 + 羊 同收

/** 红桃按牌面的分值（2、3、4 为 0） */
const HEART_POINTS = {
  A: -50, K: -40, Q: -30, J: -20,
  10: -10, 9: -10, 8: -10, 7: -10, 6: -10, 5: -10,
  2: 0, 3: 0, 4: 0,
};

/** 可亮出的牌：猪、羊、变压器、红桃A */
const SELLABLE = [PIG, SHEEP, TRANSFORMER, 'HA'];
const SELL_LABEL = {
  [PIG]: '猪', [SHEEP]: '羊', [TRANSFORMER]: '变压器', HA: '红桃 A',
};

const DEFAULT_GAME_OVER = -1000;     // 默认累计到 -1000 分终局
const TOTAL_HEART_POINTS = Object.values(HEART_POINTS).reduce((a, b) => a + b, 0); // -200

const makeCard = (suit, rank) => `${suit}${rank}`;
const suitOf = (card) => card[0];
const rankOf = (card) => card.slice(1);
const isHeart = (card) => suitOf(card) === 'H';
const isPig = (card) => card === PIG;
const isSheep = (card) => card === SHEEP;
const isTransformer = (card) => card === TRANSFORMER;
const isSellable = (card) => SELLABLE.includes(card);

/* 与红心大战的命名对齐，便于 AI 策略代码在两套规则下复用 */
const QUEEN_OF_SPADES = PIG;                       // 拱猪里"猪"就是黑桃 Q
const isQueenOfSpades = isPig;

/**
 * 单张牌的基础分值（不含亮牌、不含变压器翻倍）
 *   猪 -100 / 羊 +100 / 变压器 0（它的价值通过翻倍体现）/ 红桃按牌面
 */
function cardPoints(card) {
  if (isPig(card)) return PIG_POINTS;
  if (isSheep(card)) return SHEEP_POINTS;
  if (isTransformer(card)) return 0;
  if (isHeart(card)) return HEART_POINTS[rankOf(card)] || 0;
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
 * 拱猪与红心大战的规则差异：
 *   - ❌ 没有「首轮禁红心」—— 红桃是负分牌，但首墩可以照常出
 *   - ❌ 没有「首轮禁猪」  —— 猪可以在首墩出
 *   - ✅ 保留「必须跟花色」
 *   - ✅ 保留「第一墩首引必须出梅花 2」
 *
 * @param {string[]} hand 当前手牌
 * @param {Object}   ctx
 * @param {string|null} ctx.leadSuit     本墩主导花色（null = 自己是首引）
 * @param {boolean}  ctx.isFirstTrick    是否第一墩
 * @param {boolean}  ctx.mustLeadClub2   是否强制首引梅花 2
 * @returns {string[]} 合法牌列表
 */
function legalCards(hand, ctx = {}) {
  const { leadSuit = null, isFirstTrick = false, mustLeadClub2 = false } = ctx;
  if (!hand.length) return [];

  // 第一墩首引只能出梅花 2（异常牌局下退化为常规首引，避免整局卡死）
  if (mustLeadClub2 && hand.includes(CLUB_2)) return [CLUB_2];

  // 必须跟花色
  if (leadSuit) {
    const followers = hand.filter((c) => suitOf(c) === leadSuit);
    if (followers.length) return followers;
  }

  return hand;
}

/** 某张牌当前是否可出 */
function isLegal(card, hand, ctx = {}) {
  return legalCards(hand, ctx).includes(card);
}

/* ============================================================
 * 一墩牌的判定
 * ============================================================ */

/**
 * 判定一墩的赢家：只看主导花色，最大者收下。
 * @returns {number} 赢家的 player 索引
 */
function trickWinner(plays, leadSuit) {
  let best = plays[0];
  for (const p of plays) {
    if (suitOf(p.card) !== leadSuit) continue;
    if (suitOf(best.card) !== leadSuit) { best = p; continue; }
    if (RANK_VALUE[rankOf(p.card)] > RANK_VALUE[rankOf(best.card)]) best = p;
  }
  return best.player;
}

/** 统计一墩的基础分值（不含亮牌与变压器翻倍） */
function trickPoints(plays) {
  return plays.reduce((sum, p) => sum + cardPoints(p.card), 0);
}

/* ============================================================
 * 结算
 * ============================================================ */

/**
 * 把「每家收到的牌」换算成本局得分。
 *
 * 结算顺序（这个顺序很重要）：
 *   ① 逐张累加基础分
 *   ② 亮过牌的每一张，其分数再算一次（即翻倍）
 *   ③ 满红判定：收齐 13 张红桃 → 红桃部分整体转正
 *        · 普通满红：红桃全部替换为 +200
 *        · 满贯（同一个人还同时收到猪和羊）：红桃 +200，且猪转正 +100、
 *          羊保持 +100，三者合计 +400
 *        （其余情况猪照常 -100、羊照常 +100，与满红互不干扰）
 *   ④ 变压器：持有者总分 ×2；若此时总分为 0 → 改为 +50
 *
 * @param {string[][]} collectedCards 每家收到的牌（牌字符串数组）
 * @param {Object} opts
 * @param {string[]} opts.sold   本局亮出的牌（多张亮牌时按牌面去重）
 * @returns {{deltas:number[], details:Object[], mooner:number, slammer:number}}
 */
function settleRound(collectedCards, opts = {}) {
  const sold = opts.sold || [];
  const soldSet = new Set(sold);

  const details = [];
  const deltas = [0, 0, 0, 0];
  let mooner = -1;
  let slammer = -1;

  // ① 逐家先算出「不含满红修正」的基础分，同时统计红桃张数
  const heartCounts = collectedCards.map(
    (cards) => cards.filter((c) => isHeart(c)).length
  );
  for (let i = 0; i < 4; i++) {
    if (heartCounts[i] === 13) { mooner = i; break; }
  }
  // 满贯：满红者同时收到猪和羊
  if (mooner >= 0) {
    const cards = collectedCards[mooner];
    if (cards.includes(PIG) && cards.includes(SHEEP)) slammer = mooner;
  }

  for (let i = 0; i < 4; i++) {
    const cards = collectedCards[i];
    let base = 0;          // 不含满红修正
    let heartPart = 0;     // 红桃部分（用于满红替换）
    let pigPart = 0;       // 猪的部分（满贯时转正）
    const parts = [];      // 明细，供 UI 展示

    for (const c of cards) {
      const p = cardPoints(c);
      if (p === 0) {
        // 变压器 / 无分红桃：0 分但要露脸，否则玩家会以为牌丢了
        if (isTransformer(c)) {
          parts.push({
            card: c, value: 0, doubled: false, zero: true,
            label: SELL_LABEL[c] || `${SUIT_NAME[suitOf(c)]}${rankOf(c)}`,
          });
        }
        continue;
      }
      // ② 亮牌：该张再算一次 = 翻倍
      const mul = soldSet.has(c) ? 2 : 1;
      const v = p * mul;
      base += v;
      if (isHeart(c)) heartPart += v;
      if (isPig(c)) pigPart += v;
      parts.push({
        card: c,
        value: v,
        doubled: mul === 2,
        label: SELL_LABEL[c] || `${SUIT_NAME[suitOf(c)]}${rankOf(c)}`,
      });
    }

    // ③ 满红 / 满贯修正
    let total = base;
    let moon = false;
    let slam = false;
    if (mooner === i) {
      moon = true;
      if (slammer === i) {
        // 满贯：满红 + 猪 + 羊 同收 = 固定 +400。
        // 注意这里是「整段替换」而不是「叠加」——猪的 -100 与羊的 +100
        // 在满贯里已被 400 吸收，再减一次就会算成 500。
        slam = true;
        total = GRAND_SLAM_BONUS;
        parts.length = 0;   // 明细只留满贯一条，避免与已失效的逐张分混淆
        parts.push({
          card: 'GRAND-SLAM', value: GRAND_SLAM_BONUS, doubled: false,
          label: '满贯（满红 + 猪 + 羊）', moon: true, slam: true,
        });
      } else {
        // 普通满红：红桃整体替换为 +200，猪羊照常独立计
        total = base - heartPart + MOON_BONUS;
        parts.push({
          card: 'HEARTS-ALL', value: MOON_BONUS, doubled: false,
          label: '满红（13 张红桃）', moon: true,
        });
      }
    }

    // ④ 变压器
    //    transformerEmpty: 本局恰好 0 分 → 改为 +50
    //    doubledBy:        翻倍前的分数（用于 UI 展示 "X × 2 = Y"）
    let transformerNote = '';
    let transformerEmpty = false;
    let doubledBy = null;
    if (cards.includes(TRANSFORMER)) {
      if (total === 0) {
        total = TRANSFORMER_EMPTY_BONUS;
        transformerEmpty = true;
        transformerNote = `变压器无分，改为 +${TRANSFORMER_EMPTY_BONUS}`;
      } else {
        doubledBy = total;
        total = total * 2;
        transformerNote = `变压器生效，本局总分翻倍`;
      }
    }

    deltas[i] = total;
    details.push({
      player: i, parts, total, moon, slam,
      transformer: transformerNote, transformerEmpty, doubledBy,
      heartCount: heartCounts[i],
    });
  }

  return { deltas, details, mooner, slammer };
}

/** 整场是否结束：任一家累计 <= 终局分数阈值 */
function isGameOver(scores, threshold = DEFAULT_GAME_OVER) {
  return scores.some((s) => s <= threshold);
}

/** 终局排名（拱猪：总分最高者获胜，降序） */
function ranking(scores) {
  return scores
    .map((score, player) => ({ player, score }))
    .sort((a, b) => b.score - a.score);
}

/* ============================================================
 * 传牌
 *
 * ⚠️ 拱猪**没有传牌规则**：发牌后直接开打。
 *    这里保留 PASS_CYCLE / PASS_LABEL 只是为了让两个规则模块的
 *    导出结构保持一致（app.js 通过 Proxy 按模式取，会读到这两个键），
 *    但 PASS_CYCLE 只有 'none' 一项 —— 拱猪永远不会传牌。
 * ============================================================ */
const PASS_CYCLE = ['none'];
const PASS_LABEL = { left: '向左传', right: '向右传', across: '传给对家', none: '不传牌' };

/** 座位顺时针为 0→1→2→3。返回「我传给谁」（拱猪恒为 -1） */
function passTarget(mySeat, direction) {
  if (direction === 'left') return (mySeat + 1) % 4;
  if (direction === 'right') return (mySeat + 3) % 4;
  if (direction === 'across') return (mySeat + 2) % 4;
  return -1;
}

/* ============================================================
 * 实时分值（对局中途展示用）
 * ============================================================ */

/**
 * 把「某一家此刻已收下的牌」换算成**当前实时分值**。
 *
 * 关键约束：返回值必须与 `settleRound` 对该家的判定**完全一致**——
 * 牌桌上展示的分若和结算分对不上，玩家会认为是 bug。因此这里把
 * settleRound 的全部修正逐条复现：
 *   ① 亮过牌的每一张，分数直接按翻倍后计
 *   ② 收齐 13 张红桃（满红）：红桃部分整体替换为 +200
 *   ③ 满红 + 猪 + 羊 同收（满贯）：整段替换为 +400（不是叠加）
 *   ④ 已收下变压器：总分 ×2；若总分恰好 0，改为 +50
 *
 * @param {string[]} cards 该家已收下的牌
 * @param {string[]} sold  本局亮出的牌
 * @returns {{total:number, base:number, doubled:boolean, transformerEmpty:boolean,
 *            moon:boolean, slam:boolean}}
 */
function liveScore(cards, sold = []) {
  const soldSet = new Set(sold);
  let base = 0;
  let heartPart = 0;
  for (const c of cards) {
    const p = cardPoints(c);
    if (p === 0) continue;
    const mul = soldSet.has(c) ? 2 : 1;
    const v = p * mul;
    base += v;
    if (isHeart(c)) heartPart += v;
  }

  // 满红 / 满贯：与 settleRound ③ 保持同一套判定
  let total = base;
  let moon = false;
  let slam = false;
  if (cards.filter((c) => isHeart(c)).length === 13) {
    moon = true;
    if (cards.includes(PIG) && cards.includes(SHEEP)) {
      slam = true;
      total = GRAND_SLAM_BONUS;
    } else {
      // 红桃整体替换成 +200，猪羊照常独立计
      total = base - heartPart + MOON_BONUS;
    }
  }

  if (!cards.includes(TRANSFORMER)) {
    return { total, base, doubled: false, transformerEmpty: false, moon, slam };
  }
  if (total === 0) {
    return {
      total: TRANSFORMER_EMPTY_BONUS, base, doubled: false, transformerEmpty: true, moon, slam,
    };
  }
  return { total: total * 2, base, doubled: true, transformerEmpty: false, moon, slam };
}

/* ============================================================
 * 导出（浏览器全局 + Node 测试双兼容）
 * ============================================================ */
const GONGZHU = {
  key: 'gongzhu',
  SUITS, SUIT_NAME, SUIT_SYMBOL, SUIT_IS_RED, RANKS, RANK_VALUE,
  PIG, SHEEP, TRANSFORMER, CLUB_2,
  QUEEN_OF_SPADES,                                  // = PIG，与红心大战命名对齐
  PIG_POINTS, SHEEP_POINTS, TRANSFORMER_EMPTY_BONUS, MOON_BONUS, GRAND_SLAM_BONUS,
  HEART_POINTS, TOTAL_HEART_POINTS, SELLABLE, SELL_LABEL,
  DEFAULT_GAME_OVER, PASS_CYCLE, PASS_LABEL,
  makeCard, suitOf, rankOf, isHeart, isPig, isSheep, isTransformer, isSellable,
  isQueenOfSpades,
  cardPoints, createDeck, shuffle, sortHand,
  legalCards, isLegal, trickWinner, trickPoints,
  settleRound, liveScore, isGameOver, ranking, passTarget,
};

if (typeof module !== 'undefined' && module.exports) module.exports = GONGZHU;
if (root && typeof window !== 'undefined') root.GONGZHU = GONGZHU;

})(typeof window !== 'undefined' ? window : this);
