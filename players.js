/* ============================================================
 * 红心大战 / 拱猪 · 玩家与 AI 策略
 *
 * Player 是抽象基类：任何"能出牌的东西"（真人、AI、将来的
 * 联机对手）都实现同一个接口。核心逻辑只认这个接口，不认实现，
 * 因此新增对战模式时零改动。
 *
 * AI 支持两套规则：
 *   - 红心大战（hearts.js）：1 分/红心，猪 13 分，有首墩禁红禁猪
 *   - 拱猪（gongzhu.js）：猪 -100、羊 +100、红桃按牌面扣分、变压器翻倍
 *   AI 通过 setRules() 切换规则模块，打分函数据 rules.key 分流。
 * ============================================================ */

(function (root) {
'use strict';

// 默认规则 = 红心大战。拱猪模式下由 app.js 调 setRules 切换。
const DEFAULT_RULES = (typeof module !== 'undefined' && module.exports)
  ? require('./hearts.js')
  : root.HEARTS;

// 拱猪规则模块（浏览器下已在 gongzhu.js 中挂到 window.GONGZHU）
const GONGZHU_RULES = (typeof module !== 'undefined' && module.exports)
  ? require('./gongzhu.js')
  : root.GONGZHU;

const RULE_SETS = { hearts: DEFAULT_RULES, gongzhu: GONGZHU_RULES };

/* 当前生效的规则。默认红心大战，向后兼容既有调用方。 */
let R = DEFAULT_RULES;

/** 切换全局规则集（app.js 在模式切换时调用） */
function setRules(key) {
  R = RULE_SETS[key] || DEFAULT_RULES;
  return R;
}
function currentRules() { return R; }
function currentRulesKey() { return R === GONGZHU_RULES ? 'gongzhu' : 'hearts'; }

/* 是否为拱猪规则。AI 的打分函数里大量分支靠它分流 ——
 * 两套玩法的分值量级与符号完全相反（红心大战全是罚分，拱猪有猪 -100 / 羊 +100）。 */
function isGongzhuRules() { return R === GONGZHU_RULES; }

/* ============================================================
 * 抽象基类
 * ============================================================ */
class Player {
  constructor(seat, name) {
    this.seat = seat;          // 座位 0..3
    this.name = name;
    this.hand = [];            // 当前手牌
    this.collected = 0;        // 本局已收罚分
    this.score = 0;            // 累计总分
    this.isHuman = false;
  }

  get handSize() { return this.hand.length; }

  /** 发牌/收牌后调用 */
  setHand(cards) { this.hand = R.sortHand(cards); }

  /** 从手中移除一张牌 */
  removeCard(card) {
    const i = this.hand.indexOf(card);
    if (i === -1) throw new Error(`${this.name} 手中没有 ${card}`);
    this.hand.splice(i, 1);
    return card;
  }

  /** 尝试移除一张牌；不在手中则返回 false，不抛错。
   * 用于传牌派发——万一选牌状态与手牌不一致（如 UI 残留旧牌），
   * 宁可少传一张也不该让整局崩在传牌阶段。 */
  tryRemoveCard(card) {
    const i = this.hand.indexOf(card);
    if (i === -1) return false;
    this.hand.splice(i, 1);
    return true;
  }

  /** 接收传入的牌 */
  receiveCard(card) { this.hand.push(card); }

  /** 传牌阶段：从手中选出 n 张要传出去的牌 */
  choosePassCards(n) { return this.hand.slice(0, n); }

  /**
   * 亮牌阶段（仅拱猪）：返回本局想亮出的牌。
   * 默认不亮。子类覆写。返回值为牌字符串数组。
   */
  chooseSellCards() { return []; }

  /**
   * 出牌阶段：从合法牌中选一张。
   * 子类必须覆写。返回值为牌字符串。
   * @param {string[]} legal  当前合法可出的牌
   * @param {Object}   state  牌局快照（见 AIPlayer.buildView）
   */
  chooseCard(legal) { return legal[0]; }

  /** 是否本局为零收墩（用于展示） */
  get isClean() { return this.collected === 0; }
}

/* ============================================================
 * 真人控制器：由 UI 层驱动
 * ============================================================ */
class HumanPlayer extends Player {
  constructor(seat, name) {
    super(seat, name);
    this.isHuman = true;
    this._pending = null;
  }

  /**
   * UI 调用：提交一张牌。核心逻辑会在出牌时等待这个 Promise。
   */
  submit(card) {
    if (this._pending) {
      const resolve = this._pending;
      this._pending = null;
      resolve(card);
    }
  }

  chooseCard(legal) {
    return new Promise((resolve) => { this._pending = resolve; });
  }

  /** 传牌阶段由 UI 提交选中的多张牌 */
  choosePassCardsAsync() {
    return new Promise((resolve) => { this._pendingPass = resolve; });
  }

  submitPass(cards) {
    if (this._pendingPass) {
      const resolve = this._pendingPass;
      this._pendingPass = null;
      resolve(cards);
    }
  }
}

/* ============================================================
 * AI 玩家：三档难度
 *
 * 所有难度共享同一套"牌局视图"与合法性计算，只是在选牌
 * 打分函数上分级。这样难度提升是渐进的，不会有行为断裂。
 * ============================================================ */

const DIFFICULTY = {
  easy:   { key: 'easy',   label: '入门', desc: '会跟花色、随机出小牌，适合熟悉规则' },
  normal: { key: 'normal', label: '熟练', desc: '避开心张、追猪、判断满贯时机' },
  hard:   { key: 'hard',   label: '高手', desc: '记牌、推断断门、残局精确计算' },
};

class AIPlayer extends Player {
  constructor(seat, name, difficulty = 'normal') {
    super(seat, name);
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
    this.memory = {
      played: new Set(),        // 已出现的牌
      suitVoid: [new Set(), new Set(), new Set(), new Set()], // 每家已断的花色
      heartsBroken: false,      // 红心是否已被打出（本局）
      queenTaken: false,        // 猪是否已被收
    };
  }

  /* ---------- 记忆维护 ---------- */

  /** 观察一次出牌（所有玩家出牌时都会广播） */
  observe(playerIndex, card, leadSuit) {
    this.memory.played.add(card);
    if (R.isHeart(card)) this.memory.heartsBroken = true;
    if (R.isQueenOfSpades(card)) this.memory.queenTaken = true;
    // 若该玩家没跟出主导花色，说明其已断门
    if (leadSuit && R.suitOf(card) !== leadSuit) {
      this.memory.suitVoid[playerIndex].add(leadSuit);
    }
  }

  /** 新一局开始时清空记忆 */
  resetMemory() {
    this.memory.played = new Set();
    this.memory.suitVoid = [new Set(), new Set(), new Set(), new Set()];
    this.memory.heartsBroken = false;
    this.memory.queenTaken = false;
  }

  /* ---------- 牌局视图 ---------- */

  /**
   * 把所有决策需要的信息打包成一个只读快照，供打分函数使用。
   */
  buildView(legal, ctx) {
    const { leadSuit, isFirstTrick, trickPlays = [], trickIndex = 0 } = ctx;
    const trickPointsSoFar = R.trickPoints(trickPlays.map((p) => ({ card: p.card })));

    // 当前这一墩的领先者（若已有人出牌）
    let currentWinner = -1;
    if (trickPlays.length) {
      currentWinner = R.trickWinner(trickPlays, leadSuit || R.suitOf(trickPlays[0].card));
    }

    // 本墩最高牌的点数（主导花色）
    let highestInSuit = 0;
    const suit = leadSuit || (trickPlays.length ? R.suitOf(trickPlays[0].card) : null);
    if (suit) {
      for (const p of trickPlays) {
        if (R.suitOf(p.card) === suit) {
          highestInSuit = Math.max(highestInSuit, R.RANK_VALUE[R.rankOf(p.card)]);
        }
      }
    }

    // 若我是本墩最后一手，结果已可精确预判
    const isLastToPlay = trickPlays.length === 3;

    return {
      legal, leadSuit: suit, isFirstTrick, trickIndex, isLastToPlay,
      trickPlays, trickPointsSoFar, currentWinner, highestInSuit,
      memory: this.memory,
      difficulty: this.difficulty,
      // 手里各花色张数
      suitCount: this.countSuits(),
      // 手里最高的牌（按花色分组）
      highestOfSuit: this.highestBySuit(),
      hasQueen: this.hand.includes(R.QUEEN_OF_SPADES),
    };
  }

  countSuits() {
    const m = { C: 0, D: 0, S: 0, H: 0 };
    for (const c of this.hand) m[R.suitOf(c)]++;
    return m;
  }

  highestBySuit() {
    const m = { C: 0, D: 0, S: 0, H: 0 };
    for (const c of this.hand) {
      const s = R.suitOf(c);
      m[s] = Math.max(m[s], R.RANK_VALUE[R.rankOf(c)]);
    }
    return m;
  }

  /* ---------- 主决策入口 ---------- */

  chooseCard(legal, ctx = {}) {
    if (legal.length === 1) return legal[0];
    const view = this.buildView(legal, ctx);
    if (this.difficulty === 'easy') return this.pickEasy(view);
    if (this.difficulty === 'hard') return this.pickHard(view);
    return this.pickNormal(view);
  }

  /* ---------- 入门档：能跟花色，随机出小牌 ---------- */
  pickEasy(view) {
    const { legal, leadSuit, trickPlays } = view;
    // 有牌跟就随机跟，偶尔出最小的
    if (!leadSuit) {
      // 首引：优先出最小的非红心
      const safe = legal.filter((c) => !R.isHeart(c) && !R.isQueenOfSpades(c));
      const pool = safe.length ? safe : legal;
      return this.minBy(pool, (c) => R.RANK_VALUE[R.rankOf(c)]);
    }
    // 跟牌：一半概率出最小，一半概率随机
    if (Math.random() < 0.5) return this.minBy(legal, (c) => R.RANK_VALUE[R.rankOf(c)]);
    return legal[Math.floor(Math.random() * legal.length)];
  }

  /* ---------- 熟练档：避雷 + 追猪 + 满贯判断 ---------- */
  pickNormal(view) {
    const { legal, leadSuit, isFirstTrick, isLastToPlay, trickPointsSoFar, currentWinner } = view;

    // 决定本墩策略：想赢（收小牌 / 收猪）还是想输（甩掉危险牌）
    let wantToWin;
    if (isLastToPlay) {
      // 最后一手：能精确判断。若本墩有分，我赢得起吗？
      const myWinning = legal.filter((c) => this.wouldWin(c, view));
      if (!myWinning.length) {
        // 赢不了，挑一张最没用的牌丢掉
        return this.minBy(legal, (c) => this.discardScore(c, view));
      }
      const cheapestWin = this.minBy(myWinning, (c) => R.RANK_VALUE[R.rankOf(c)]);
      const cheapestAny = this.minBy(legal, (c) => this.discardScore(c, view));

      if (R === GONGZHU_RULES) {
        // 拱猪：这一墩的净分完全确定，直接比较「收下」与「放掉」哪个更好。
        // 收下时：所有分归我（含自己垫进去的那张）。
        const takeTotal = this.simulateTakeAll(cheapestWin, view);
        const dropRisk = this.discardScore(cheapestAny, view);
        // 收下得 takeTotal 分，放掉则那张危险牌留在手里（负 risk 表示它是资产）
        wantToWin = takeTotal > 0 && takeTotal * 8 >= dropRisk * 0.6;
        if (wantToWin) return cheapestWin;
        // 不想赢：优先把危险牌甩出去
        return cheapestAny;
      }

      wantToWin = this.shouldTakeTrick(trickPointsSoFar) && !this.prefersDump(cheapestAny, cheapestWin, view);
      return wantToWin ? cheapestWin : cheapestAny;
    }

    // 非最后一手：看情况打
    if (!leadSuit) {
      return this.chooseLead(view);
    }
    return this.chooseFollow(view);
  }

  /** 若我出 card 收下这一墩，最终会得到多少分（拱猪用） */
  simulateTakeAll(card, view) {
    const leadSuit = view.leadSuit;
    const all = view.trickPlays.map((p) => p.card).concat([card]);
    let s = 0;
    for (const c of all) s += R.cardPoints(c);
    return s;
  }

  /**
   * 该不该收下这一墩。
   * 红心大战：有分就想躲（全是罚分）。
   * 拱猪：分有正负 —— 收下正分是赚，收下负分是亏；空墩收下有利于保出牌权。
   */
  shouldTakeTrick(points) {
    if (points === 0) return true;    // 空墩收下无成本，能拿就拿（保持出牌权）
    if (R === GONGZHU_RULES) return points > 0;   // 拱猪：正分照收，负分要躲
    return false;                      // 红心大战：有分则尽量躲
  }

  /** 甩牌是否比赢墩更划算 */
  prefersDump(dumpCard, winCard, view) {
    if (R === GONGZHU_RULES) {
      // 拱猪：若能用一张危险牌（如大红桃）换掉这墩，且赢下这墩要吃亏，那值得
      const dumpRisk = this.discardScore(dumpCard, view);
      const winCost = R.cardPoints(winCard) < 0 ? 60 : 0;
      return dumpRisk >= 120 && winCost <= 10;
    }
    // 若能用一张很危险的牌换掉这墩，值得
    const dumpRisk = this.discardScore(dumpCard, view);
    const winCost = R.cardPoints(winCard) > 0 ? 14 : 0;   // 赢下带分的墩=风险
    return dumpRisk >= 12 && winCost <= 2;
  }

  /** 首引策略 */
  chooseLead(view) {
    const { legal, suitCount, memory } = view;
    const heartsLeft = this.hand.filter((c) => R.isHeart(c)).length;

    // 手里只有红心 → 只能引红心
    if (heartsLeft === this.hand.length) {
      return this.minBy(legal, (c) => R.RANK_VALUE[R.rankOf(c)]);
    }

    if (R === GONGZHU_RULES) {
      // 拱猪：没有禁引限制，优先"贱卖"危险牌 —— 引自己的短套大牌，
      // 把猪或大红桃在没人跟的时候甩掉是最理想的。
      const score = (c) => {
        if (R.isPig(c)) return -50;                       // 猪：留着是祸，但引出也无功，交给后续判断
        const pts = R.cardPoints(c);
        const s = R.suitOf(c);
        const len = suitCount[s];
        const v = R.RANK_VALUE[R.rankOf(c)];
        // 负分牌 + 短套 = 越该早引出去
        return (pts < 0 ? Math.abs(pts) * 2 : 0) + v * 1.2 - len * 1.5;
      };
      const cands = legal.filter((c) => !R.isPig(c));
      return this.maxBy(cands.length ? cands : legal, score);
    }

    // 有 AKQ 这类大牌，且长度够 → 用大牌引，逼出别人小牌
    const cands = legal.filter((c) => !R.isHeart(c));
    const score = (c) => {
      const s = R.suitOf(c);
      const v = R.RANK_VALUE[R.rankOf(c)];
      const len = suitCount[s];
      // 长套 + 大牌 = 好的引牌（能控制局面）；短套小牌也能安全引走
      return v * 1.2 - len * 1.5;
    };
    return this.maxBy(cands, score);
  }

  /** 跟牌策略 */
  chooseFollow(view) {
    const { legal, leadSuit, highestInSuit, suitCount, memory, currentWinner } = view;
    const gz = R === GONGZHU_RULES;

    // 我手里这张牌能不能赢？
    const winners = legal.filter((c) => this.wouldWin(c, view));
    const losers = legal.filter((c) => !this.wouldWin(c, view));

    const inSuit = R.suitOf(legal[0]) === leadSuit;

    // 有牌跟（同花色）
    if (inSuit) {
      // 领跑者是自己的话，出小牌即可稳住
      if (currentWinner === this.seat) {
        return this.minBy(legal, (c) => R.RANK_VALUE[R.rankOf(c)]);
      }

      if (gz) {
        // 拱猪：分辨这一墩是"要抢"还是"要躲"
        const pts = view.trickPointsSoFar;
        if (pts > 0) {
          // 正分墩（有羊或无分牌里带羊）→ 想赢，用能赢里最小的拿下
          if (winners.length) return this.minBy(winners, (c) => R.RANK_VALUE[R.rankOf(c)]);
          return this.minBy(legal, (c) => R.RANK_VALUE[R.rankOf(c)]);
        }
        if (pts < 0) {
          // 负分墩 → 躲开，优先出赢不了的最小牌
          return losers.length
            ? this.minBy(losers, (c) => Math.abs(R.cardPoints(c)) * -1 + R.RANK_VALUE[R.rankOf(c)])
            : this.minBy(winners, (c) => Math.abs(R.cardPoints(c)));
        }
        // 空墩 → 保存实力，出最小
        return this.minBy(legal, (c) => R.RANK_VALUE[R.rankOf(c)]);
      }

      // 本墩已有分 → 想躲，出最小的
      if (this.trickHasPoints(view)) {
        return losers.length
          ? this.minBy(losers, (c) => R.RANK_VALUE[R.rankOf(c)])
          : this.minBy(winners, (c) => R.RANK_VALUE[R.rankOf(c)]);
      }
      // 空墩 → 用最小的牌跟，保存实力
      return this.minBy(legal, (c) => R.RANK_VALUE[R.rankOf(c)]);
    }

    // 断门，可以垫牌
    return this.chooseDiscard(view, legal);
  }

  /** 垫牌：断门时挑一张最能减轻负担的牌 */
  chooseDiscard(view, legal) {
    const { memory, currentWinner } = view;
    const gz = R === GONGZHU_RULES;

    if (gz) {
      // 拱猪：如果这一墩注定归我（且带负分），索性把大红桃一起塞进来
      if (currentWinner === this.seat && view.trickPointsSoFar < 0) {
        const pen = legal.filter((c) => R.cardPoints(c) < 0);
        if (pen.length) return this.maxBy(pen, (c) => Math.abs(R.cardPoints(c)));
      }
      // 若这一墩是正分且我一定能收，可以把羊留着自己吃
      const noPig = legal.filter((c) => !R.isPig(c));
      const pool = noPig.length ? noPig : legal;
      return this.minBy(pool, (c) => this.discardScore(c, view));
    }

    // 若这一墩我一定收下，就趁机把猪或大红心甩进去（自己在收，分量一样）
    if (currentWinner === this.seat || view.trickPlays.length === 3 && currentWinner === this.seat) {
      // 已经在收墩，垫最贵的罚分牌（反正分数已归我，不如一次清干净）
      const pen = legal.filter((c) => R.cardPoints(c) > 0);
      if (pen.length) return this.maxBy(pen, (c) => R.cardPoints(c));
    }
    // 别把猪垫进别人的墩
    const noQueen = legal.filter((c) => !R.isQueenOfSpades(c));
    const pool = noQueen.length ? noQueen : legal;
    // 优先垫大点数但非罚分的牌（如 K、A），红心其次
    return this.minBy(pool, (c) => this.discardScore(c, view));
  }

  /** 垫牌评分：越低越先垫出去 */
  discardScore(card, view) {
    const gz = R === GONGZHU_RULES;
    const v = R.RANK_VALUE[R.rankOf(card)];

    if (gz) {
      // 拱猪：直接按「这张牌若被自己收下会亏多少」来排序，
      // 分值就是最准的尺度，不需要额外臆测。
      const pts = R.cardPoints(card);
      if (R.isTransformer(card)) return -5;        // 变压器：无分，但别白送人正分
      if (R.isPig(card)) return 200;               // 猪：绝不轻易垫
      if (R.isSheep(card)) return -30;             // 羊：正分牌，愿意收下，但不必抢
      if (pts < 0) return Math.abs(pts) + 20;      // 红桃：按真实扣分排序
      // 无分牌：点数越大越该早扔（将来被迫收墩的概率更高）
      return v;
    }

    if (R.isQueenOfSpades(card)) return 100;                 // 猪：绝不轻易垫
    if (R.isHeart(card)) return 20 + v;                      // 红心：次危险
    // 非罚分：点数越大越该早点扔掉（避免以后被迫收墩）
    return v;
  }

  /** 这一墩是否已经有罚分（拱猪下"有分"包括正分，正分反而是好事） */
  trickHasPoints(view) {
    return view.trickPointsSoFar > 0;
  }

  /** 这一墩的分数对自己是有利还是有害（拱猪里羊是正分，收下是赚） */
  trickIsGood(view) {
    return view.trickPointsSoFar > 0;
  }

  /** 这一墩有分可拿（不论正负） */
  trickHasValue(view) {
    return view.trickPointsSoFar !== 0;
  }

  /** 我出这张牌会不会赢得当前这一墩 */
  wouldWin(card, view) {
    const { leadSuit, trickPlays } = view;
    const suit = leadSuit || (trickPlays.length ? R.suitOf(trickPlays[0].card) : null);
    if (!suit) return true;                                   // 我首引，我最大
    if (R.suitOf(card) !== suit) return false;                // 不同花色赢不了
    const v = R.RANK_VALUE[R.rankOf(card)];
    for (const p of trickPlays) {
      if (R.suitOf(p.card) === suit && R.RANK_VALUE[R.rankOf(p.card)] > v) return false;
    }
    return true;
  }

  /** 是否还有别的玩家可能压过我（简化估算，高手档用） */
  canAnyoneElseTake(view) {
    return view.trickPlays.length < 3;
  }

  /* ---------- 高手档：在熟练档基础上加记牌与残局精算 ---------- */
  pickHard(view) {
    const base = this.pickNormal(view);

    // 残局（手牌 ≤ 4 张）时，若能精确算清就直接用最优解
    if (this.hand.length <= 4) {
      const exact = this.solveEndgame(view);
      if (exact) return exact;
    }

    // 已有的猪是否安全：若猪还没出现且我有黑桃，尽量避免出中大黑桃
    if (view.hasQueen && view.leadSuit === 'S' && view.trickPlays.length > 0) {
      // 跟黑桃时，若本墩可能有分，出小牌避开
      const small = view.legal
        .filter((c) => !R.isQueenOfSpades(c))
        .sort((a, b) => R.RANK_VALUE[R.rankOf(a)] - R.RANK_VALUE[R.rankOf(b)]);
      if (small.length && this.trickHasPoints(view)) return small[0];
    }

    return base;
  }

  /**
   * 残局精确求解：枚举末几张牌的收益，选长期损失最小的。
   * 手牌很少时用穷举（此时状态空间小），否则返回 null 交回启发式。
   *
   * 注意两套玩法的"收益符号"相反：
   *   红心大战：收下的分全是罚分 → 得分是负收益，要减
   *   拱猪：    收下的分有正有负 → 正分是正收益，直接用
   */
  solveEndgame(view) {
    const { legal } = view;
    if (!legal.length) return null;
    const gz = R === GONGZHU_RULES;

    let best = legal[0], bestScore = -Infinity;
    for (const card of legal) {
      let s = 0;
      const immediate = this.simulateImmediate(card, view);
      // 立刻收到的分：红心大战里是罚分（取负），拱猪里就是本身的分值
      s += gz ? immediate : -immediate;

      // 剩余手牌的潜在风险：都是"损失"，统一减去
      const rest = this.hand.filter((c) => c !== card);
      s -= this.handRisk(rest);

      if (view.isLastToPlay && view.trickPointsSoFar !== 0) {
        // 最后一手且本墩有分：
        //   红心大战 → 这墩是罚分，能躲就躲（躲开 +10）
        //   拱猪     → 正分墩要抢（抢到 +20），负分墩要躲（躲开 +10）
        const win = this.wouldWin(card, view);
        const goodTrick = gz && view.trickPointsSoFar > 0;
        if (goodTrick) {
          if (win) s += 20;
        } else if (!win) {
          s += 10;
        }
      }
      if (s > bestScore) { bestScore = s; best = card; }
    }
    return best;
  }

  /** 估算出这张牌这一墩会收到多少分 */
  simulateImmediate(card, view) {
    const { leadSuit, trickPlays } = view;
    const suit = leadSuit || (trickPlays.length ? R.suitOf(trickPlays[0].card) : null);
    const all = [...trickPlays.map((p) => ({ player: p.player, card: p.card })), { player: this.seat, card }];
    if (!suit) return R.cardPoints(card);
    const w = R.trickWinner(all, suit);
    return w === this.seat ? R.trickPoints(all) : 0;
  }

  /** 一手牌的潜在风险分（越高越危险） */
  handRisk(cards) {
    if (R === GONGZHU_RULES) {
      // 拱猪：用真实分值。正分牌（羊）是"负风险"，红桃/猪是正风险。
      let risk = 0;
      for (const c of cards) {
        const pts = R.cardPoints(c);
        if (pts < 0) risk += Math.abs(pts);
        else if (R.isSheep(c)) risk -= 40;      // 羊在手里是资产
        else {
          // 无分牌：大牌将来容易被逼收墩，给一点小额风险
          const v = R.RANK_VALUE[R.rankOf(c)];
          if (v >= 12) risk += 8;
        }
      }
      return risk;
    }

    let risk = 0;
    for (const c of cards) {
      if (R.isQueenOfSpades(c)) risk += 13;
      else if (R.isHeart(c)) {
        const v = R.RANK_VALUE[R.rankOf(c)];
        risk += v >= 11 ? 4 : v >= 8 ? 2 : 0.5;   // 大红心更危险
      } else {
        const v = R.RANK_VALUE[R.rankOf(c)];
        if (v >= 12) risk += 2.5;                  // 黑桃/方块的大牌容易被逼收墩
      }
    }
    return risk;
  }

  /* ---------- 传牌策略 ---------- */

  /**
   * 传牌：把最危险的牌传出去。
   * 难度分档：
   *   入门 — 只认得猪和红心，按点数粗略排序，容易留下危险的大牌
   *   熟练 — 完整风险模型（点数 × 套长）
   *   高手 — 在熟练基础上避免把手牌传成"空心"，保住控制力
   */
  choosePassCards(n) {
    if (this.difficulty === 'easy') return this.choosePassEasy(n);
    return this.choosePassScored(n);
  }

  /** 入门档传牌：粗粒度，只看是不是猪 / 红心 */
  choosePassEasy(n) {
    const gz = R === GONGZHU_RULES;
    const scored = this.hand.map((c) => {
      let risk;
      if (gz) {
        // 拱猪：羊和变压器是资产，硬性不传（入门档也知道别把好东西送人）
        if (R.isSheep(c)) risk = -1000;
        else if (R.isTransformer(c)) risk = -800;
        else if (R.isPig(c)) risk = 1000;
        else if (R.isHeart(c)) risk = 50 + Math.abs(R.cardPoints(c)) * 2;
        else risk = R.RANK_VALUE[R.rankOf(c)];
      } else {
        if (R.isQueenOfSpades(c)) risk = 100;
        else if (R.isHeart(c)) risk = 50 + R.RANK_VALUE[R.rankOf(c)];
        else risk = R.RANK_VALUE[R.rankOf(c)];      // 大牌也传，但不区分套长
      }
      // 入门档有 35% 概率判断失误：随机扰动，让决策不稳定
      if (Math.random() < 0.35) risk = Math.random() * 1100 - 100;
      return { card: c, risk };
    });
    scored.sort((a, b) => b.risk - a.risk);
    return scored.slice(0, n).map((s) => s.card);
  }

  /** 熟练 / 高手档：完整风险模型 */
  choosePassScored(n) {
    const hand = this.hand;
    const scored = hand.map((c) => ({ card: c, risk: this.passRisk(c) }));
    scored.sort((a, b) => b.risk - a.risk);

    const picked = [];
    const suitUsed = {};
    for (const s of scored) {
      if (picked.length >= n) break;
      const suit = R.suitOf(s.card);
      // 高手档额外规避「把手牌传成空心」：不把手里的短套整条传空
      if (this.difficulty === 'hard') {
        const suitTotal = hand.filter((c) => R.suitOf(c) === suit).length;
        if (suitTotal <= 2 && (suitUsed[suit] || 0) >= 1) continue;
      }
      picked.push(s.card);
      suitUsed[suit] = (suitUsed[suit] || 0) + 1;
    }
    for (const s of scored) {
      if (picked.length >= n) break;
      if (!picked.includes(s.card)) picked.push(s.card);
    }
    return picked.slice(0, n);
  }

  /** 单张牌的"该不该传出去"风险值 */
  passRisk(card) {
    const gz = R === GONGZHU_RULES;
    const s = R.suitOf(card);
    const v = R.RANK_VALUE[R.rankOf(card)];
    const suitLen = this.hand.filter((c) => R.suitOf(c) === s).length;

    if (gz) {
      // 拱猪：传送逻辑完全反过来了 —— 羊和变压器是资产（不能传），
      // 猪和红桃大牌是负债（优先传）。
      if (R.isSheep(card)) return -1000;                    // 羊：绝不传出
      if (R.isTransformer(card)) return -800;               // 变压器：也不传
      if (R.isPig(card)) return 1000;                       // 猪：第一优先传出
      if (R.isHeart(card)) {
        return Math.abs(R.cardPoints(card)) * 2 + (suitLen <= 3 ? 30 : 0);
      }
      // 非分牌：黑桃/方块的大牌容易被迫收墩（收红桃、收猪），传出去
      if (v >= 12) return 40 + (suitLen <= 2 ? 20 : 0);
      return v;
    }

    if (R.isQueenOfSpades(card)) return 100;          // 猪：第一优先传出
    if (R.isHeart(card)) {
      // 红心：大牌 + 短套 = 很容易被迫收下
      return 40 + v * 2 + (suitLen <= 3 ? 12 : 0);
    }
    if (s === 'S') {
      // 黑桃 A/K 是"猪的保镖"，且本身容易被迫收墩
      if (v >= 12) return 55;
      if (v >= 10) return 30;
      return 5;
    }
    // 方块/梅花的大牌也危险，但没有直接的罚分关联
    if (v >= 12) return 25 + (suitLen <= 2 ? 10 : 0);
    return v;
  }

  /* ============================================================
   * 亮牌（卖牌）—— 仅拱猪
   *
   * 亮的牌在结算时分数翻倍，所以：
   *   - 亮「猪」= 押注自己能躲开猪，赌对则猪翻倍（对家吃更多亏）
   *   - 亮「羊」= 押注自己能吃掉羊，赌对则 +200
   *   - 亮「变压器」= 押注自己本局有正分，赌对则双倍，赌错则双倍亏损
   *   - 亮「红桃A」= 押注自己能躲开红桃A
   *
   * 注意：亮的牌本身就是在手里，若最终自己收到，则自己承担翻倍后果。
   * 因此是否亮牌，取决于"这张牌留在手里的可能性"。
   * ============================================================ */

  /**
   * @param {Object} ctx
   * @param {boolean} ctx.allowSell   本局是否开放亮牌
   * @returns {string[]} 想亮的牌
   */
  chooseSellCards(ctx = {}) {
    if (!ctx.allowSell) return [];
    if (R.key !== 'gongzhu') return [];

    const sellable = this.hand.filter((c) => R.isSellable(c));
    if (!sellable.length) return [];

    if (this.difficulty === 'easy') {
      // 入门档：只在手里有猪且黑桃很短时亮猪（比较直觉的判断）
      const pig = this.hand.includes(R.PIG) ? [R.PIG] : [];
      const spadeLen = this.hand.filter((c) => R.suitOf(c) === 'S').length;
      return (pig.length && spadeLen <= 3) ? pig : [];
    }

    const out = [];
    const suitLen = (s) => this.hand.filter((c) => R.suitOf(c) === s).length;

    // 猪：手里黑桃越少、越小，越可能被迫吃猪 → 不亮；
    //     黑桃多且有大牌（能护住/甩掉）→ 亮，赌对翻倍。
    if (this.hand.includes(R.PIG)) {
      const spadeLen = suitLen('S');
      const bigSpades = this.hand.filter(
        (c) => R.suitOf(c) === 'S' && R.RANK_VALUE[R.rankOf(c)] >= 12
      ).length;
      // 黑桃 4 张以上且至少有 1 张大牌 → 有把握不吃猪 → 亮
      if (spadeLen >= 4 && bigSpades >= 1 && this.difficulty === 'hard') out.push(R.PIG);
    }

    // 羊：手里有方块大牌护住 → 亮，吃羊可翻倍到 +200
    if (this.hand.includes(R.SHEEP)) {
      const bigDiamonds = this.hand.filter(
        (c) => R.suitOf(c) === 'D' && R.RANK_VALUE[R.rankOf(c)] >= 12
      ).length;
      if (bigDiamonds >= 1) out.push(R.SHEEP);
    }

    // 变压器：手里分牌少（不容易吃分）→ 亮，赌无分得 +50；
    //          手里有明显正分来源（羊）→ 也亮，双倍正分。
    if (this.hand.includes(R.TRANSFORMER)) {
      const hasSheep = this.hand.includes(R.SHEEP);
      const negativeCards = this.hand.filter(
        (c) => R.cardPoints(c) < 0
      ).length;
      if (this.difficulty === 'hard' && (hasSheep || negativeCards === 0)) {
        out.push(R.TRANSFORMER);
      }
    }

    // 红桃A：手里红桃多且有大牌护住 → 亮，赌不吃红桃A
    if (this.hand.includes('HA')) {
      const heartLen = suitLen('H');
      const bigHearts = this.hand.filter(
        (c) => R.suitOf(c) === 'H' && R.RANK_VALUE[R.rankOf(c)] >= 13
      ).length;
      if (heartLen >= 4 && bigHearts >= 1) out.push('HA');
    }

    return out;
  }

  /* ---------- 工具 ---------- */
  minBy(arr, fn) { return arr.reduce((a, b) => (fn(b) < fn(a) ? b : a)); }
  maxBy(arr, fn) { return arr.reduce((a, b) => (fn(b) > fn(a) ? b : a)); }
}

/* ---------- 导出 ---------- */
const HEARTS_PLAYERS = { Player, HumanPlayer, AIPlayer, DIFFICULTY, setRules, currentRules, currentRulesKey };
if (typeof module !== 'undefined' && module.exports) module.exports = HEARTS_PLAYERS;
if (root) root.HEARTS_PLAYERS = HEARTS_PLAYERS;

})(typeof window !== 'undefined' ? window : this);
