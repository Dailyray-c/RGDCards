/* ============================================================
 * net-referee.js —— 联机对局的「裁判」
 *
 * 联机不做服务器，改由**房主（host）浏览器**兼任裁判：
 *   · 房主负责发牌、判定每墩赢家、结算分值，把权威状态写回房间
 *   · 其他玩家只提交自己的动作（传牌 / 亮牌 / 出牌），并读取权威状态
 *   · 空缺座位由 AI 顶上 —— AI 逻辑复用 players.js 的 AIPlayer
 *
 * 本文件把单人版的牌局推进逻辑抽成「无 DOM」的纯状态机，
 * 规则引擎直接复用 hearts.js / gongzhu.js，保证联机与单机判定一致。
 * ============================================================ */
(function (root) {
'use strict';

/* 浏览器里 window 同时是全局；Node 下 this !== global，必须显式取 globalThis，
   否则 rulesByMode() 读不到调用方挂上去的 HEARTS / GONGZHU。 */
function rulesByMode() {
  const g = (typeof globalThis !== 'undefined') ? globalThis : root;
  let ddz = g.DDZ || root.DDZ;
  if (!ddz && typeof require === 'function') {
    try { ddz = require('./ddz.js'); } catch (_) { /* 浏览器没有 require */ }
  }
  return {
    hearts: g.HEARTS || root.HEARTS,
    gongzhu: g.GONGZHU || root.GONGZHU,
    ddz,
  };
}

/** 创建一个初始房间对象 */
function makeRoom(code, opts = {}) {
  const mode = opts.mode || 'gongzhu';
  const room = {
    v: 1,                       // 版本号（CAS 用）
    code,
    mode,
    createdAt: Date.now(),
    touchedAt: Date.now(),
    hostId: opts.hostId,
    seats: [null, null, null, null],   // 每个座位：{id,name,ready} 或 null
    settings: {
      delay: true,
      sell: true,
      passHearts: true,
      moonSelf: true,
      threshold: -1000,
    },
    // 牌局
    phase: 'lobby',             // lobby | selling | passing | playing | roundEnd | gameEnd
    round: 0,
    scores: [0, 0, 0, 0],
    hands: [[], [], [], []],    // 各家手牌（只下发给本人，见 publicView）
    collected: [0, 0, 0, 0],
    collectedCards: [[], [], [], []],
    sold: [],
    soldBy: {},
    passDirection: 'none',
    selectedPass: [null, null, null, null],   // null=未提交；数组=已提交（可为空数组）
    selectedSell: [null, null, null, null],
    trickIndex: 0,
    trickPlays: [],             // [{seat, card}]
    leadSuit: null,
    leader: 0,
    lastTrick: null,            // 上一墩结果，供前端播动画
    // ⚠️ 收墩缓冲：第 4 张牌落下后**不能立刻清空** trickPlays。
    //    桌面 4 张牌必须作为一个独立快照发布出去，远端才看得到最后一张出的牌。
    //    历史上 resolveTrick 在同一写入里清空 trickPlays，第 4 张牌从未出现在
    //    任何快照中 —— 房主本地因为有自己的动画盖住了，客人则完全看不见出牌，
    //    只能看着桌面从 3 张瞬间变空。见 settleTrick / releaseHold。
    trickHold: false,           // true = 这一墩已分完但仍要再发布一次
    log: [],
    aiSeats: [],                // 哪些座位由 AI 托管（人数不足补位）
  };
  if (mode === 'ddz') {
    room.seatCount = 3;
    room.settings.aiDifficulty = (opts.settings && opts.settings.aiDifficulty) || 'normal';
    room.targetScore = 100;
    room.bottom = [];
    room.baseBid = 1;
    room.redealCount = 0;
    room.bids = [null, null, null, null];
    room.bidTurn = -1;
    room.currentBid = 0;
    room.highestBidder = -1;
    room.landlord = -1;
    room.turn = -1;
    room.currentCombo = null;
    room.lastLeadSeat = -1;
    room.passCount = 0;
    room.moveSeq = 0;
    room.bombCount = 0;
    room.hasRocket = false;
    room.heartsBroken = false;
    room.farmerPlayCount = 0;
    room.landlordPlayCount = 0;
    room.roles = [];
    room.lastPlay = null;
    room.lastAction = null;
    room.actions = [];
    room.actionSeq = 0;
  }
  return room;
}

/* ---------- 工具 ---------- */

const ruleOf = (room) => rulesByMode()[room.mode] || root.GONGZHU;

function occupiedSeats(room) {
  return room.seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
}

function humanCount(room) {
  return room.seats.filter(Boolean).length;
}

/** 需要发牌的座位（真人 + AI 补位） */
function activeSeats(room) {
  const out = [];
  if (!room || !Array.isArray(room.seats)) return out;
  const ai = Array.isArray(room.aiSeats) ? room.aiSeats : [];
  const count = room.mode === 'ddz' ? 3 : 4;
  for (let i = 0; i < count; i++) {
    if (room.seats[i] || ai.includes(i)) out.push(i);
  }
  return out;
}

/* ---------- 开局 ---------- */

/** DDZ 发牌并进入叫分阶段；重发牌时不增加局数。 */
function dealDdz(room) {
  const R = ruleOf(room);
  const active = activeSeats(room);
  if (active.length < 3) return false;
  const deck = R.shuffle(R.createDeck());
  room.hands = [[], [], [], []];
  let k = 0;
  for (const seat of active) {
    room.hands[seat] = R.sortHand(deck.slice(k, k + 17));
    k += 17;
  }
  room.bottom = deck.slice(k);
  room.phase = 'bidding';
  room.bids = [null, null, null, null];
  room.grabActs = [null, null, null, null];
  room.bidStage = 'call';
  room.bidStarter = Math.floor(Math.random() * active.length);  // 随机起始叫位
  room.candidate = -1;
  room.grabCount = 0;
  room.lastGrabber = -1;
  room.bidTurn = active[room.bidStarter] != null ? active[room.bidStarter] : active[0];
  room.bidCount = 0;
  room.currentBid = 0;            // 当前最高叫分（0 = 尚无人叫）；抢地主阶段改为 2^抢次数
  room.callBid = 0;              // 底分 = 最高叫分（抢地主阶段不覆盖）
  room.baseBid = 1;
  room.highestBidder = -1;
  room.landlord = -1;
  room.turn = -1;
  room.currentCombo = null;
  room.lastLeadSeat = -1;
  room.passCount = 0;
  room.moveSeq = 0;
  room.bombCount = 0;
  room.hasRocket = false;
  room.heartsBroken = false;
  room.farmerPlayCount = 0;
  room.landlordPlayCount = 0;
  room.roles = [];
  room.trickPlays = [];
  room.lastPlay = null;
  room.lastAction = null;
  room.actions = [];
  room.actionSeq = 0;
  room.log = [`第 ${room.round} 局开始`];
  room.active = active;
  return true;
}

/** 确定地主并进入 DDZ 出牌阶段。 */
function finishDdzBidding(room) {
  const R = ruleOf(room);
  const active = room.active || activeSeats(room);
  // 最终地主：有人抢则取「最后一个抢地主者」，否则取最高叫分者（地主候选）
  let landlord = room.grabCount > 0 ? room.lastGrabber
    : (room.candidate >= 0 ? room.candidate : (room.highestBidder >= 0 ? room.highestBidder : -1));
  if (landlord < 0) landlord = room.bidTurn >= 0 ? room.bidTurn : active[0];
  room.landlord = landlord;
  room.baseBid = room.callBid || 1;          // 底分 = 最高叫分（抢地主不覆盖）
  room.hands[landlord] = R.sortHand(room.hands[landlord].concat(room.bottom));
  room.roles = [0, 1, 2, 3].map((seat) =>
    seat >= 3 ? null : (seat === landlord ? 'landlord' : 'farmer'));
  room.phase = 'playing';
  room.turn = landlord;
  room.bidTurn = -1;
  room.bidStage = 'done';
  room.currentCombo = null;
  room.lastLeadSeat = -1;
  room.passCount = 0;
  room.moveSeq = 0;
  room.trickPlays = [];
  room.lastPlay = null;
  return true;
}

/**
 * 补位并开始新的一局：发牌 → 进入亮牌 / 传牌阶段。
 * 只有房主调用。
 */
function startRound(room) {
  if (room.mode === 'ddz') {
    if (activeSeats(room).length < 3) return false;
    room.round += 1;
    room.redealCount = 0;
    return dealDdz(room);
  }

  const R = ruleOf(room);
  const active = activeSeats(room);
  if (active.length < 2) return false;

  room.round += 1;
  room.trickIndex = 0;
  room.trickPlays = [];
  room.trickHold = false;
  room.leadSuit = null;
  room.leader = 0;
  room.collected = [0, 0, 0, 0];
  room.collectedCards = [[], [], [], []];
  room.sold = [];
  room.soldBy = {};
  room.lastTrick = null;
  room.selectedPass = [null, null, null, null];
  room.selectedSell = [null, null, null, null];
  room.hands = [[], [], [], []];
  room.log = [`第 ${room.round} 局开始`];

  // 发牌（只发给参赛座位，其余留空）
  const deck = R.shuffle(R.createDeck());
  let k = 0;
  for (const seat of active) {
    for (let i = 0; i < 13; i++) {
      room.hands[seat].push(deck[k++]);
    }
    room.hands[seat] = R.sortHand(room.hands[seat]);
  }
  room.active = active;

  // 亮牌：拱猪有卖牌环节
  const wantSell = room.mode === 'gongzhu' && room.settings.sell;
  if (wantSell) {
    room.phase = 'selling';
    return true;
  }
  return afterSell(room);
}

/** 亮牌阶段结束 → 进入传牌或直接出牌 */
function afterSell(room) {
  const R = ruleOf(room);
  const wantPass = room.mode !== 'gongzhu' && room.settings.passHearts !== false;
  if (wantPass) {
    room.passDirection = R.PASS_CYCLE[(room.round - 1) % R.PASS_CYCLE.length];
    room.phase = 'passing';
    return true;
  }
  return beginPlay(room);
}

/** 首引者：持梅花 2 的人 */
function beginPlay(room) {
  const R = ruleOf(room);
  room.phase = 'playing';
  room.trickIndex = 0;
  room.trickPlays = [];
  room.trickHold = false;
  room.leadSuit = null;
  const owner = room.active.find((s) => room.hands[s].includes(R.CLUB_2));
  room.leader = owner != null ? owner : room.active[0];
  room.turn = room.leader;
  return true;
}

/* ---------- 出牌合法性 ---------- */

function submitBid(room, seat, action) {
  if (room.mode !== 'ddz' || room.phase !== 'bidding') {
    return { ok: false, error: '当前不是叫地主阶段' };
  }
  if (room.bidTurn !== seat) return { ok: false, error: '还没轮到你' };
  const act = (action && action.act) || 'pass';      // 'call' | 'grab' | 'pass'
  if (!Array.isArray(room.actions)) room.actions = [];
  if (!Number.isInteger(room.actionSeq)) room.actionSeq = 0;

  const bidAction = {
    type: room.bidStage === 'grab' ? 'grab' : 'call',
    seat, act, pass: act === 'pass',
    seq: ++room.actionSeq,
  };
  room.lastAction = bidAction;
  room.actions.push(bidAction);

  const active = room.active || activeSeats(room);

  // ---------- 叫地主阶段（1/2/3 分，最高分者成为地主候选人）----------
  if (room.bidStage === 'call') {
    if (act === 'call') {
      const score = Math.max(1, Math.min(3, Number(action.score) || 0));
      if (score <= (room.currentBid || 0)) {
        return { ok: false, error: `叫分必须高于当前最高 ${room.currentBid || 0} 分` };
      }
      room.bids[seat] = score;
      room.currentBid = score;
      room.callBid = score;                  // 底分 = 最高叫分（抢地主阶段不覆盖）
      room.baseBid = score;
      room.candidate = seat;
      room.highestBidder = seat;
      room.bidCount = (room.bidCount || 0) + 1;
      room.log.push(`${(room.seats[seat] && room.seats[seat].name) || ('玩家' + seat)} 叫 ${score} 分`);
      if (score === 3) {
        // 叫满 3 分 → 叫地主阶段结束，进入抢地主
        room.bidStage = 'grab';
        room.bidCount = 0;
        room.grabActs = [null, null, null, null];
        room.bidTurn = nextActiveSeat(room, seat);
        return { ok: true };
      }
    } else {
      room.bids[seat] = 0;
      room.bidCount = (room.bidCount || 0) + 1;
      room.log.push(`${(room.seats[seat] && room.seats[seat].name) || ('玩家' + seat)} 不叫`);
      // 三家都不叫 → 流局重发
      if (room.bidCount >= active.length && room.candidate < 0) {
        if (room.redealCount < 3) {
          room.redealCount += 1;
          dealDdz(room);
          return { ok: true, redeal: true };
        }
        room.candidate = room.bidTurn >= 0 ? room.bidTurn : active[0];
      }
    }
    // 叫地主阶段结束：有人叫（且未叫满 3）且三家都叫完 → 进入抢地主
    if (room.candidate >= 0 && room.bidCount >= active.length) {
      room.bidStage = 'grab';
      room.bidCount = 0;
      room.grabActs = [null, null, null, null];
      room.bidTurn = nextActiveSeat(room, room.candidate);
      return { ok: true };
    }
    if (room.candidate >= 0) {
      room.bidTurn = nextActiveSeat(room, seat);
      return { ok: true };
    }
    if (room.bidCount < active.length) {
      room.bidTurn = nextActiveSeat(room, seat);
      return { ok: true };
    }
    finishDdzBidding(room);   // 兜底（理论上已流局重发）
    return { ok: true };
  }

  // ---------- 抢地主阶段 ----------
  const a = act === 'grab' ? 'grab' : 'pass';
  room.grabActs[seat] = a;
  room.bidCount = (room.bidCount || 0) + 1;
  if (a === 'grab') {
    room.grabCount += 1;
    room.lastGrabber = seat;
    room.currentBid = Math.pow(2, room.grabCount);
    room.highestBidder = seat;
  }
  // 抢地主只问「候选人以外」的玩家各一次：每一次抢都真正易主（最后抢的人当地主）。
  // ⚠️ 旧实现连候选人一起问且排最后 → 候选人必然自己回抢，抢地主沦为给自己抬倍数。
  const askCount = Math.max(1, active.length - 1);
  if (room.bidCount >= askCount) {
    finishDdzBidding(room);
    return { ok: true };
  }
  room.bidTurn = nextActiveSeat(room, seat);
  return { ok: true };
}

function playCards(room, seat, cards) {
  if (room.mode !== 'ddz' || room.phase !== 'playing') {
    return { ok: false, error: '当前不是斗地主出牌阶段' };
  }
  if (room.turn !== seat) return { ok: false, error: '还没轮到你' };
  if (!Array.isArray(cards) || !cards.length) {
    return { ok: false, error: '请选择要出的牌' };
  }
  const hand = room.hands[seat] || [];
  const D = ruleOf(room);
  if (!Array.isArray(room.actions)) room.actions = [];
  if (!Number.isInteger(room.actionSeq)) room.actionSeq = 0;
  const combo = D.classifyPlay(cards);
  if (!combo || !D.isLegalPlay(hand, cards, room.currentCombo)) {
    return { ok: false, error: '这组牌现在不能出' };
  }
  const remaining = hand.slice();
  for (const card of cards) {
    const index = remaining.indexOf(card);
    if (index < 0) return { ok: false, error: '这张牌不在你手里' };
    remaining.splice(index, 1);
  }

  room.hands[seat] = remaining;
  // 两家连续不出后，上一轮的牌和「不出」要先保留一个快照给客户端看；
  // 只有地主/上一手领出者真正出新牌时，才开启新一轮并清掉旧动作。
  // 之前在 passDdz() 里第二个不出一到就清空，导致第二家的「不出」
  // 和第一家的「不出」一起消失，玩家看不到完整过程。
  if (!room.currentCombo && room.trickPlays.some((a) => a.pass)) {
    room.trickPlays = [];
  }
  const action = {
    type: 'play', seat, cards: cards.slice(), combo, pass: false,
    seq: ++room.moveSeq,
    actionSeq: ++room.actionSeq,
  };
  room.trickPlays.push(action);
  room.actions.push(action);
  room.lastPlay = action;
  room.lastAction = action;
  room.currentCombo = combo;
  room.lastLeadSeat = seat;
  room.passCount = 0;
  if (combo.type === 'bomb') room.bombCount += 1;
  if (combo.type === 'rocket') room.hasRocket = true;
  if (seat === room.landlord) room.landlordPlayCount += 1;
  else room.farmerPlayCount += 1;
  if (!remaining.length) {
    endRound(room, seat);
  } else {
    room.turn = nextActiveSeat(room, seat);
  }
  return { ok: true };
}

function passDdz(room, seat) {
  if (room.mode !== 'ddz' || room.phase !== 'playing') {
    return { ok: false, error: '当前不是斗地主出牌阶段' };
  }
  if (room.turn !== seat) return { ok: false, error: '还没轮到你' };
  if (!room.currentCombo) return { ok: false, error: '当前没有可跳过的牌' };
  if (!Array.isArray(room.actions)) room.actions = [];
  if (!Number.isInteger(room.actionSeq)) room.actionSeq = 0;
  const action = {
    type: 'pass', seat, cards: [], combo: null, pass: true,
    seq: ++room.moveSeq,
    actionSeq: ++room.actionSeq,
  };
  room.trickPlays.push(action);
  room.actions.push(action);
  room.lastPlay = action;
  room.lastAction = action;
  room.passCount += 1;
  if (room.passCount >= 2) {
    room.currentCombo = null;
    room.passCount = 0;
    room.turn = room.lastLeadSeat;
    // ⚠️ 新的一手开始 → 清空桌面动作。单机侧（app.js doDdzPass）一直是这么做的，
    //    裁判侧漏了这一句：trickPlays 会一路累积到本局结束，
    //    客户端就会把「上一手是谁跳过的」误当成「这一手也跳过了」。
    // 第二家的「不出」需要先发布给客户端；下一次领出者真正出新牌时，
    // playCards() 开头再清空旧动作。
  } else {
    room.turn = nextActiveSeat(room, seat);
  }
  return { ok: true };
}

function legalFor(room, seat) {
  const R = ruleOf(room);
  const hand = room.hands[seat] || [];
  if (!hand.length) return [];
  if (room.mode === 'ddz') {
    const plays = R.enumeratePlays(hand, room.currentCombo);
    const seen = new Set();
    const cards = [];
    for (const play of plays) {
      for (const card of play.cards) {
        if (!seen.has(card)) {
          seen.add(card);
          cards.push(card);
        }
      }
    }
    return cards;
  }
  return R.legalCards(hand, {
    leadSuit: room.leadSuit,
    isFirstTrick: room.trickIndex === 0,
    mustLeadClub2: room.trickIndex === 0 && room.trickPlays.length === 0,
    heartsBroken: room.heartsBroken,
  });
}

/**
 * 提交一张牌。返回 {ok, error?}。
 * @param {number} seat
 * @param {string} card
 */
function playCard(room, seat, card) {
  if (room.mode === 'ddz') return playCards(room, seat, [card]);
  if (room.phase !== 'playing') return { ok: false, error: '当前不是出牌阶段' };
  // 收墩缓冲期间桌面已满 4 张，谁的牌都不能再进这一墩。
  // 正常情况下这一步会在 STEP_INTERVAL_MS 内由节拍推进器释放，
  // 真人不该撞上；撞上说明客户端视图超前了，直接拒掉最安全。
  if (room.trickHold) return { ok: false, error: '正在收墩' };
  if (room.turn !== seat) return { ok: false, error: '还没轮到你' };

  const hand = room.hands[seat] || [];
  if (!hand.includes(card)) return { ok: false, error: '这张牌不在你手里' };
  if (!legalFor(room, seat).includes(card)) return { ok: false, error: '这张牌现在不能出' };

  const R = ruleOf(room);
  room.hands[seat] = hand.filter((c) => c !== card);
  if (room.trickPlays.length === 0) room.leadSuit = R.suitOf(card);
  room.trickPlays.push({ seat, card });
  if (R.isHeart(card)) room.heartsBroken = true;

  if (room.trickPlays.length === 4) {
    resolveTrick(room);
  } else {
    room.turn = nextActiveSeat(room, seat);
  }
  return { ok: true };
}

/**
 * 收墩的第二步：真正把桌面清空、推进到下一墩。
 *
 * 和 resolveTrick 配对使用。调用点是房主的节拍推进器（pump）：
 * 第 4 张牌落下 → resolveTrick 先只记录归属、保留桌面 → 这一次快照被写进房间，
 * 远端看到完整的 4 张 → 下一拍 pump 调 releaseHold 清桌面并轮到赢家。
 *
 * 幂等：没有处于 hold 状态时直接返回 false，重复调用无副作用。
 * @returns {boolean} 是否真的释放了
 */
function releaseHold(room) {
  if (!room || !room.trickHold) return false;
  room.trickHold = false;
  room.trickPlays = [];
  room.leadSuit = null;
  room.trickIndex += 1;
  room.turn = room.leader;

  const anyoneLeft = (room.active || activeSeats(room))
    .some((s) => (room.hands[s] || []).length > 0);
  if (!anyoneLeft) endRound(room);
  return true;
}

function nextActiveSeat(room, seat) {
  const active = room.active || activeSeats(room);
  const i = active.indexOf(seat);
  return active[(i + 1) % active.length];
}

/**
 * 判定一墩归属并计分。
 *
 * ⚠️ 这里**只判归属、不清桌面**（保留 trickPlays 并置 trickHold=true）。
 *    桌面清空被拆到独立的 releaseHold()，由房主节拍推进器在下一拍调用。
 *    这样第 4 张牌会作为一个完整快照被发布出去，远端才能看见"最后一个人出牌"。
 *    如果在这里顺手 trickPlays = []，第 4 张牌就永远不存在于任何快照里 ——
 *    远端观感是桌面 3 张牌直接消失，完全看不到收墩过程。
 */
function resolveTrick(room) {
  const R = ruleOf(room);
  // 规则引擎的 trickWinner 读的是 plays[i].player，而我们统一用 .seat，
  // 这里做一次显式转换，避免两套字段名漂移（历史 bug：返回 undefined）。
  const plays = room.trickPlays.map((p) => ({ player: p.seat, card: p.card }));
  const winner = R.trickWinner(plays, room.leadSuit);
  const cards = room.trickPlays.map((p) => p.card);
  room.collectedCards[winner] = (room.collectedCards[winner] || []).concat(cards);

  const pts = R.trickPoints(room.trickPlays);
  room.collected[winner] = (room.collected[winner] || 0) + pts;

  room.lastTrick = {
    winner, cards: room.trickPlays.slice(), points: pts, index: room.trickIndex,
  };
  // 桌面留到 releaseHold 再清 —— 见上方注释。
  room.trickHold = true;
  room.leader = winner;
  // 回合归属提前落到赢家，但 turn 的实际切换在 releaseHold 里做，
  // 否则 hold 期间 nextActiveSeat 会拿着旧 turn 继续出牌。
  room.turn = winner;
  return winner;
}

/** 结算本局 */
function endRound(room, winner) {
  if (room.mode === 'ddz') {
    const D = ruleOf(room);
    const winningSeat = winner == null
      ? room.hands.findIndex((hand, seat) => seat < 3 && hand.length === 0)
      : winner;
    const landlordWin = winningSeat === room.landlord;
    const spring = landlordWin && room.farmerPlayCount === 0;
    const antiSpring = !landlordWin && room.landlordPlayCount === 1;
    const result = D.scoreRound({
      baseBid: room.baseBid || 1,
      landlordWin,
      bombCount: room.bombCount,
      rocket: room.hasRocket,
      grabs: room.grabCount,
      spring,
      antiSpring,
    });
    const deltas = [0, 0, 0, 0];
    for (let seat = 0; seat < 3; seat++) {
      deltas[seat] = seat === room.landlord ? result.landlordDelta : result.farmerDelta;
    }
    room.landlordDelta = result.landlordDelta;
    room.farmerDelta = result.farmerDelta;
    room.lastDeltas = deltas;
    room.scores = room.scores.map((score, seat) => score + (deltas[seat] || 0));
    room.phase = D.isGameOver(room.scores, room.targetScore || 100) ? 'gameEnd' : 'roundEnd';
    room.log.push(`第 ${room.round} 局结束`);
    return { deltas, winner: winningSeat };
  }

  const R = ruleOf(room);
  room.phase = 'roundEnd';
  let deltas, mooner = -1;

  if (room.mode === 'gongzhu') {
    const r = R.settleRound(room.collectedCards, { sold: room.sold });
    deltas = r.deltas;
    mooner = r.mooner;
    room.settleDetails = r.details;
  } else {
    const r = R.settleRound(room.collected, room.settings.moonSelf);
    deltas = r.deltas;
  }

  room.lastDeltas = deltas;
  room.scores = room.scores.map((s, i) => s + (deltas[i] || 0));

  const over = R.isGameOver(room.scores, room.settings.threshold);
  room.phase = over ? 'gameEnd' : 'roundEnd';
  room.log.push(`第 ${room.round} 局结束`);
  return { deltas, mooner };
}

/* ---------- 亮牌 / 传牌提交 ---------- */

function submitSell(room, seat, cards) {
  if (room.phase !== 'selling') return { ok: false, error: '当前不是亮牌阶段' };
  if (Array.isArray(room.selectedSell[seat])) return { ok: false, error: '你已经亮过牌了' };
  const R = ruleOf(room);
  const hand = room.hands[seat] || [];
  const uniq = [...new Set(cards)];
  for (const c of uniq) {
    if (!hand.includes(c)) return { ok: false, error: '这张牌不在你手里' };
    if (!R.isSellable(c)) return { ok: false, error: '这张牌不能亮' };
  }
  room.selectedSell[seat] = uniq;

  // 所有参赛者都提交后合并 sold 并进入下一阶段
  const active = room.active || activeSeats(room);
  const submitted = active.every((s) => Array.isArray(room.selectedSell[s]));
  if (submitted) {
    room.sold = active.reduce((acc, s) => acc.concat(room.selectedSell[s] || []), []);
    // ⚠️ soldBy 的约定是「牌码 → 座位号」，必须与单机 app.js 完全一致 ——
    //    renderSoldBoard() 直接拿 `soldBy[card]` 当座位号去查名字。
    //    这里曾写成「座位号 → 牌数组」，方向正好相反，于是联机下亮牌板永远查不到
    //    亮牌人、显示成「—」。（单机写的是 `state.soldBy[c] = i`。）
    room.soldBy = {};
    for (const s of active) {
      for (const c of (room.selectedSell[s] || [])) room.soldBy[c] = s;
    }
    afterSell(room);
  }
  return { ok: true };
}

function submitPass(room, seat, cards) {
  if (room.phase !== 'passing') return { ok: false, error: '当前不是传牌阶段' };
  if (Array.isArray(room.selectedPass[seat])) return { ok: false, error: '你已经传过牌了' };
  const hand = room.hands[seat] || [];
  const uniq = [...new Set(cards)];
  for (const c of uniq) {
    if (!hand.includes(c)) return { ok: false, error: '这张牌不在你手里' };
  }
  room.selectedPass[seat] = uniq;

  const active = room.active || activeSeats(room);
  const submitted = active.every((s) => Array.isArray(room.selectedPass[s]));
  if (submitted) {
    const R = ruleOf(room);
    for (const s of active) {
      const target = R.passTarget(s, room.passDirection);
      if (target < 0) continue;
      for (const c of room.selectedPass[s] || []) {
        room.hands[s] = room.hands[s].filter((x) => x !== c);
        room.hands[target] = R.sortHand(room.hands[target].concat(c));
      }
    }
    beginPlay(room);
  }
  return { ok: true };
}

/* ---------- AI 自动行动 ---------- */

/** AI 该出手时替它决定一张牌 */
function aiChooseCard(room, seat) {
  const R = ruleOf(room);
  const hand = room.hands[seat] || [];
  const legal = legalFor(room, seat);
  if (!legal.length) return null;

  // 简易策略：优先丢分牌（拱猪丢负分、红心丢大牌），否则丢最小
  const score = (c) => {
    const p = R.cardPoints(c);
    if (room.mode === 'gongzhu') return p;        // 越负越优先丢
    return -p;                                     // 红心：分越高越优先丢
  };
  const isLead = room.trickPlays.length === 0;
  if (isLead) {
    // 首引尽量出小牌，避免主动收分
    return legal.slice().sort((a, b) => R.RANK_VALUE[R.rankOf(a)] - R.RANK_VALUE[R.rankOf(b)])[0];
  }
  const risky = legal.slice().sort((a, b) => score(a) - score(b));
  // 如果手上都是烂牌，就丢最小的
  return risky[0] || legal[0];
}

/** DDZ 叫分阶段 AI 的决策。 */
function aiChooseBid(room, seat) {
  const D = ruleOf(room);
  const difficulty = (room.settings && room.settings.aiDifficulty) || 'normal';
  if (room.bidStage === 'grab') {
    // grabCount / callBid 决定了当前倍数：抢一次 ×2，门槛要随倍数上抬
    return D.grabLandlordAI(room.hands[seat] || [], {
      difficulty,
      grabCount: room.grabCount || 0,
      callBid: room.callBid || room.baseBid || 1,
    }) ? { act: 'grab' } : { act: 'pass' };
  }
  const score = D.callLandlordAI(room.hands[seat] || [], { difficulty, currentBid: room.currentBid });
  return score > 0 ? { act: 'call', score } : { act: 'pass' };
}

/** DDZ 出牌阶段 AI 的决策；没有能压过的牌时返回空数组。 */
function aiChooseDdzPlay(room, seat) {
  const D = ruleOf(room);
  return D.playAI(room.hands[seat] || [], room.currentCombo, {
    difficulty: room.settings && room.settings.aiDifficulty || 'normal',
  });
}

/** 亮牌阶段 AI 的决策（保守：只亮猪/变压器这类高风险牌） */
function aiChooseSell(room, seat) {
  const R = ruleOf(room);
  const hand = room.hands[seat] || [];
  const out = [];
  if (hand.includes(R.TRANSFORMER)) out.push(R.TRANSFORMER);
  return out;
}

/** 传牌阶段 AI 的决策：传走最大的三张 */
function aiChoosePass(room, seat) {
  const R = ruleOf(room);
  const hand = (room.hands[seat] || []).slice();
  hand.sort((a, b) => R.RANK_VALUE[R.rankOf(b)] - R.RANK_VALUE[R.rankOf(a)]);
  return hand.slice(0, 3);
}

/**
 * 房主推进 AI：把该 AI 做的动作做掉，直到轮到真人或阶段结束。
 * 返回是否发生了推进。
 */
function stepAI(room) {
  if (!room || !Array.isArray(room.seats)) return false;
  const active = room.active || activeSeats(room);
  if (!active.length) return false;
  const ai = Array.isArray(room.aiSeats) ? room.aiSeats : [];
  const isAI = (s) => ai.includes(s);

  if (room.mode === 'ddz') {
    if (room.phase === 'bidding' && isAI(room.bidTurn)) {
      submitBid(room, room.bidTurn, aiChooseBid(room, room.bidTurn));
      return true;
    }
    if (room.phase === 'playing' && room.turn != null && isAI(room.turn)) {
      const cards = aiChooseDdzPlay(room, room.turn);
      if (cards.length) playCards(room, room.turn, cards);
      else if (room.currentCombo) passDdz(room, room.turn);
      else return false;
      return true;
    }
    return false;
  }

  // ⚠️ 收墩缓冲优先处理：第 4 张牌已经落下、但桌面还没清空。
  //    这一步由节拍推进器独立走一拍，把「桌面 4 张牌」当作一个完整快照发布出去。
  //    顺序很重要 —— 必须在 playing 分支**之前**处理，否则会拿着已满 4 张的
  //    trickPlays 继续走 playCard，直接把第 5 张塞进这一墩。
  if (room.trickHold) return releaseHold(room);

  if (room.phase === 'selling') {
    let moved = false;
    for (const s of active) {
      // 最后一名提交者会让阶段切换到 passing，必须重新判断，否则会
      // 用上一个阶段的状态继续提交（进而被 submitSell 拒掉）。
      if (room.phase !== 'selling') break;
      if (isAI(s) && !Array.isArray(room.selectedSell[s])) {
        submitSell(room, s, aiChooseSell(room, s));
        moved = true;
      }
    }
    return moved;
  }

  if (room.phase === 'passing') {
    let moved = false;
    for (const s of active) {
      if (room.phase !== 'passing') break;
      if (isAI(s) && !Array.isArray(room.selectedPass[s])) {
        submitPass(room, s, aiChoosePass(room, s));
        moved = true;
      }
    }
    return moved;
  }

  if (room.phase === 'playing' && room.turn != null && isAI(room.turn)) {
    const card = aiChooseCard(room, room.turn);
    if (card) { playCard(room, room.turn, card); return true; }
  }
  return false;
}

/* ---------- 视图裁剪（防作弊） ---------- */

/**
 * 生成发给某个玩家的视图：
 *   · 只给本人的手牌
 *   · 其余人只给张数
 *   · 已收牌公开（本来就摆在桌上）
 */
/**
 * 回合超时时的"默认行动"：替当前该行动的真人出一手合法牌 / 不出 / 不叫。
 * 用于联机房主计时器（15s 内没回应就自动推进，避免卡在某人回合）。
 * @returns {boolean} 是否真的执行了一次动作
 */
function forceTimeout(room, seat) {
  if (!room || !room.seats[seat]) return false;
  if (room.mode === 'ddz') {
    if (room.phase === 'bidding' && room.bidTurn === seat) {
      submitBid(room, seat, { act: 'pass' }); return true;  // 叫/抢超时 → 不叫/不抢
    }
    if (room.phase === 'playing' && room.turn === seat) {
      if (room.currentCombo) { passDdz(room, seat); return true; }   // 能不出就不出
      const cards = aiChooseDdzPlay(room, seat);
      if (cards && cards.length) { playCards(room, seat, cards); return true; }
      return false;
    }
    return false;
  }
  // 红心大战 / 拱猪
  if (room.phase === 'selling' && !Array.isArray(room.selectedSell[seat])) {
    submitSell(room, seat, []); return true;                 // 亮牌超时 → 不亮
  }
  if (room.phase === 'passing' && !Array.isArray(room.selectedPass[seat])) {
    submitPass(room, seat, []); return true;                 // 传牌超时 → 不传
  }
  if (room.phase === 'playing' && room.turn === seat) {
    const card = aiChooseCard(room, seat);
    if (card) { playCard(room, seat, card); return true; }
    return false;
  }
  return false;
}

/** 当前该行动的真人座位（计时器判定用）。返回 -1 表示此阶段无需计时。 */
function currentActorSeat(room) {
  if (!room) return -1;
  if (room.mode === 'ddz') {
    if (room.phase === 'bidding') return room.bidTurn;
    if (room.phase === 'playing') return room.turn;
    return -1;
  }
  if (room.phase === 'selling') {
    const next = activeSeats(room).find((s) => !Array.isArray(room.selectedSell[s]));
    return next == null ? -1 : next;
  }
  if (room.phase === 'passing') {
    const next = activeSeats(room).find((s) => !Array.isArray(room.selectedPass[s]));
    return next == null ? -1 : next;
  }
  if (room.phase === 'playing') return room.turn;
  return -1;
}

function publicView(room, mySeat) {
  const view = JSON.parse(JSON.stringify(room));
  view.hands = room.hands.map((h, i) => (i === mySeat ? h : []));
  view.handSizes = room.hands.map((h) => h.length);
  view.mySeat = mySeat;
  view.selectedPass = room.selectedPass.map((cards, i) =>
    (i === mySeat || !Array.isArray(cards) ? cards : cards.map(() => '*')));
  view.selectedSell = room.selectedSell.map((cards, i) =>
    (i === mySeat || !Array.isArray(cards) ? cards : cards.map(() => '*')));
  if (room.mode === 'ddz' && !['playing', 'roundEnd', 'gameEnd'].includes(room.phase)) {
    view.bottom = [];
  }
  return view;
}

const NET_REFEREE = {
  RULES_BY_MODE: rulesByMode,
  makeRoom, ruleOf, occupiedSeats, humanCount, activeSeats,
  startRound, afterSell, beginPlay, dealDdz, finishDdzBidding,
  legalFor, playCard, playCards, passDdz, submitBid,
  resolveTrick, releaseHold, endRound, nextActiveSeat,
  submitSell, submitPass,
  aiChooseCard, aiChooseBid, aiChooseDdzPlay, aiChooseSell, aiChoosePass, stepAI,
  currentActorSeat, forceTimeout,
  publicView,
};

if (typeof module !== 'undefined' && module.exports) module.exports = NET_REFEREE;
if (root && typeof window !== 'undefined') root.NET_REFEREE = NET_REFEREE;

})(typeof window !== 'undefined' ? window : this);
