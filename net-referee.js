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

/* ---------- 座位数 ----------
 *
 * 房间座位数不再写死 4：狼人杀需要 8~12 人，牌类仍是 4（斗地主 3）。
 * ⚠️ seatCount 改变时必须同步 seats / hands / scores 等定长数组的长度，
 *    否则多出来的座位会 undefined，少掉的座位数据会僵在数组里。
 */
const MAX_SEATS = 12;
const MIN_SEATS = 2;

function clampSeatCount(n) {
  const v = parseInt(n, 10);
  if (!Number.isInteger(v)) return 4;
  return Math.max(MIN_SEATS, Math.min(MAX_SEATS, v));
}

/** 各玩法的默认座位数 */
function defaultSeatCount(mode) {
  if (mode === 'ddz') return 3;
  if (mode === 'werewolf') return 9;   // 常见 9 人局（3 狼 / 3 神 / 3 民）
  return 4;
}

/** 房间当前座位数（兼容旧房间没有 seatCount 字段的情况） */
function seatCountOf(room) {
  if (!room) return 4;
  if (Number.isInteger(room.seatCount) && room.seatCount > 0) return room.seatCount;
  return Array.isArray(room.seats) ? room.seats.length : 4;
}

/** 把按座位定长的数组统一对齐到 seatCount（多退少补） */
function fitSeatArray(arr, n, fill) {
  const src = Array.isArray(arr) ? arr.slice() : [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(i < src.length ? src[i] : (typeof fill === 'function' ? fill(i) : fill));
  return out;
}

/** 创建一个初始房间对象 */
function makeRoom(code, opts = {}) {
  const mode = opts.mode || 'gongzhu';
  const seatCount = clampSeatCount(opts.seatCount || defaultSeatCount(mode));
  const room = {
    v: 1,                       // 版本号（CAS 用）
    code,
    mode,
    seatCount,                  // ⚠️ 唯一的座位容量真相源
    createdAt: Date.now(),
    touchedAt: Date.now(),
    hostId: opts.hostId,
    seats: new Array(seatCount).fill(null),   // 每个座位：{id,name,ready} 或 null
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
    // ⚠️ 所有「按座位定长」的数组都必须按 seatCount 生成，不能写死 4
    scores: new Array(seatCount).fill(0),
    hands: fitSeatArray([], seatCount, () => []),   // 各家手牌（只下发给本人，见 publicView）
    collected: new Array(seatCount).fill(0),
    collectedCards: fitSeatArray([], seatCount, () => []),
    sold: [],
    soldBy: {},
    passDirection: 'none',
    selectedPass: new Array(seatCount).fill(null),  // null=未提交；数组=已提交（可为空数组）
    selectedSell: new Array(seatCount).fill(null),
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
    room.bids = new Array(seatCount).fill(null);
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
  if (mode === 'werewolf') {
    room.werewolf = makeWerewolf(room);
  }
  return room;
}

/* ---------- 狼人杀：房间子状态 ----------
 *
 * 与牌局完全不同：没有手牌/牌桌，只有「角色分配 + 消息流」。
 * 消息一律带 to（目标），可见性由 werewolf.js 的 canSee 判定，
 * 下发前在 publicView 里裁剪 —— 前端只负责渲染，不做权限判断。
 */
function makeWerewolf(room) {
  const WW = wwModule();
  const n = seatCountOf(room);
  return {
    phase: 'setup',            // setup | night | day | end
    round: 0,
    moderatorSeat: -1,         // 主持人座位（不参与扮演、不分配角色）
    roleConfig: (WW && WW.suggestConfig) ? WW.suggestConfig(Math.max(1, n - 1)) : [],
    roles: new Array(n).fill(null),   // 每座位角色 {key,name,camp}；主持人座位为 null
    alive: new Array(n).fill(true),
    revealed: new Array(n).fill(false),  // 是否已公开身份（出局/被查验）
    messages: [],              // {id,from,to,text,phase,round,ts,system?}
    seq: 0,
    startedAt: 0,
    winner: null,              // 'good' | 'wolf' | 'draw' | null（当前局）
    results: [],               // 历史战绩 [{round, winner, at}]
    // 投票：主持人发起 → 玩家投票 → 公布结果
    // ballots 在公布前只给主持人和投票者本人看（publicView 裁剪）
    vote: null,                // {open,title,options:[seat],ballots:{seat:target},revealed,result}
  };
}

/** 系统公告（全场可见）：出局 / 投票结果 / 换局等，由裁判生成 */
function wwPushSystem(w, text) {
  w.seq = (w.seq || 0) + 1;
  w.messages.push({
    id: w.seq, from: -1, to: { kind: 'all' }, text: String(text),
    phase: w.phase, round: w.round, ts: Date.now(), system: true,
  });
  if (w.messages.length > 300) w.messages = w.messages.slice(-300);
}

function wwModule() {
  const g = (typeof globalThis !== 'undefined') ? globalThis : root;
  let ww = g.WEREWOLF || root.WEREWOLF || null;
  // ⚠️ 必须有 require 兜底：浏览器里 werewolf.js 用 <script> 挂到 window，
  //    但 Node 环境（单测 / 服务端）不会自动挂全局，取不到就抽不出角色
  //    —— 表现为「开局成功但所有人身份为空」。与 rulesByMode 处理 ddz 一致。
  if (!ww && typeof require === 'function') {
    try { ww = require('./werewolf.js'); } catch (_) { /* 浏览器没有 require */ }
  }
  return ww;
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
  const count = seatCountOf(room);
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
  const n = seatCountOf(room);
  room.bids = new Array(n).fill(null);
  room.grabActs = new Array(n).fill(null);
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
  room.mingpai = false;            // 斗地主：地主明牌（公开手牌 → 倍数 ×2）
  room.heartsBroken = false;
  room.farmerPlayCount = 0;
  room.landlordPlayCount = 0;
  room.roles = [];
  room.trickPlays = [];
  room.trickClearAt = 0;           // 「两家不出」展示期截止时间（0 = 无）
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
  // 角色数组按实际座位数生成（三人局：1 地主 + 2 农民）
  room.roles = Array.from({ length: seatCountOf(room) }, (_, seat) =>
    (seat === landlord ? 'landlord' : 'farmer'));
  // 进入「明牌」阶段：地主收下底牌后、出第一手前决定是否亮牌（倍数 ×2）。
  // 联机由房主 stepAI / maybeTimeoutCurrentActor 驱动，客户端按 phase 弹明牌弹窗。
  room.mingpai = false;
  room.phase = 'ming';
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
  // 狼人杀：不开局发牌，只做「抽角色 + 进入夜晚」
  if (room.mode === 'werewolf') {
    const res = wwStart(room);
    return !!res.ok;
  }
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
  room.selectedPass = new Array(seatCountOf(room)).fill(null);
  room.selectedSell = new Array(seatCountOf(room)).fill(null);
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
        room.grabActs = new Array(seatCountOf(room)).fill(null);
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
      room.grabActs = new Array(seatCountOf(room)).fill(null);
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

/** 明牌（斗地主）：地主收下底牌后决定亮不亮全部手牌，亮则本局倍数 ×2。 */
function submitMing(room, seat, on) {
  if (room.mode !== 'ddz' || room.phase !== 'ming') {
    return { ok: false, error: '当前不是明牌阶段' };
  }
  if (room.turn !== seat) return { ok: false, error: '还没轮到你' };
  if (!Array.isArray(room.actions)) room.actions = [];
  if (!Number.isInteger(room.actionSeq)) room.actionSeq = 0;
  const action = { type: 'ming', seat, on: !!on, seq: ++room.actionSeq };
  room.lastAction = action;
  room.actions.push(action);
  room.mingpai = !!on;
  room.phase = 'playing';
  room.turn = room.landlord;
  room.log.push(
    `${(room.seats[seat] && room.seats[seat].name) || ('玩家' + seat)} ` +
    `${on ? '明牌（亮出全部手牌，倍数 ×2）' : '不明牌'}`);
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
    // 第二家的「不出」先留在桌面展示一会儿（~1.4s），到点由 stepAI 清空 ——
    // 与单机 doDdzPass 的「先展示上两家都不出，再清桌」语义一致。
    room.trickClearAt = Date.now() + 1400;
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
      mingpai: room.mingpai,
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

  // 「上两家都不出」展示期到点 → 清空桌面（与单机 doDdzPass 的停顿语义对齐）。
  // 放在 stepAI 顶部：房主节拍循环每 ~300ms 用副本试探一次，到点就返回 true
  // 让草稿被写回，客户端拿到 trickPlays 已清空的快照后自然收桌。
  if (room.mode === 'ddz' && room.trickClearAt && Date.now() >= room.trickClearAt) {
    room.trickClearAt = 0;
    room.trickPlays = [];
    return true;
  }

  if (room.mode === 'ddz') {
    if (room.phase === 'bidding' && isAI(room.bidTurn)) {
      submitBid(room, room.bidTurn, aiChooseBid(room, room.bidTurn));
      return true;
    }
    if (room.phase === 'ming' && isAI(room.turn)) {
      const D = ruleOf(room);
      submitMing(room, room.turn,
        D.mingpaiAI(room.hands[room.turn] || [], {
          difficulty: (room.settings && room.settings.aiDifficulty) || 'normal',
        }));
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
    if (room.phase === 'ming' && room.turn === seat) {
      submitMing(room, seat, false); return true;            // 明牌超时 → 默认不明牌
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
    if (room.phase === 'ming') return room.turn;
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

/* ---------- 狼人杀：动作 ---------- */

/** 消息目标归一化：主持人与玩家的权限不同（玩家夜晚只能私聊主持人） */
function wwNormalizeTarget(to, isMod, w, seat, roles) {
  const t = to || {};
  const kind = t.kind || 'all';
  if (kind === 'all') {
    // 玩家只能在「白天」公开发言；主持人随时可以全场广播
    if (!isMod && w.phase !== 'day') return null;
    return { kind: 'all' };
  }
  if (kind === 'mod') {
    if (isMod) return null;                    // 主持人没有「私聊主持人」
    return { kind: 'mod' };
  }
  if (kind === 'role') {
    const role = String(t.role || '').trim();
    if (!role) return null;
    // 玩家只能往「自己所在角色」的频道发言 —— 这就是狼人夜里互相讨论的通道。
    // 想发给别的角色？不行，那是主持人特权。
    if (!isMod) {
      const me = (roles || [])[seat];
      if (!me || me.key !== role) return null;
    }
    return { kind: 'role', role };
  }
  if (!isMod) return null;                     // 定向给单个玩家是主持人特权
  if (kind === 'seat') {
    const s = parseInt(t.seat, 10);
    const n = (w && Array.isArray(w.alive)) ? w.alive.length : seatCountOf(null);
    return (Number.isInteger(s) && s >= 0 && s < n) ? { kind: 'seat', seat: s } : null;
  }
  return null;
}

/** 房主（或主持人）改配置：角色池 / 主持人 */
function wwSetConfig(room, patch) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (w.phase !== 'setup') return { ok: false, error: '游戏已开始，不能改配置' };
  const p = patch || {};
  const WW = wwModule();
  if (Array.isArray(p.roleConfig)) {
    w.roleConfig = p.roleConfig
      .filter((r) => r && String(r.key || '').trim())
      .map((r) => {
        const n = Math.max(0, parseInt(r.count, 10) || 0);
        const base = (WW && WW.roleByKey) ? WW.roleByKey(r.key, r.name) : { key: r.key };
        return {
          key: base.key,
          name: base.name || r.name || r.key,
          camp: base.camp || 'good',
          // seePeers：该角色成员之间是否互相知道身份（狼人互认）。
          // 显式给了就用配置值，没给就继承角色库默认（自定义角色默认 false）。
          seePeers: (r.seePeers != null) ? !!r.seePeers : !!base.seePeers,
          count: n,
        };
      });
  }
  if (p.moderatorSeat !== undefined) {
    const m = parseInt(p.moderatorSeat, 10);
    w.moderatorSeat = Number.isInteger(m) ? m : -1;
  }
  // 玩家数变了就顺手按新人数推荐一套阵容（仅在玩家没手动改过时）
  if (p.autoSuggest) {
    const seats = activeSeats(room).filter((s) => s !== w.moderatorSeat);
    if (WW && WW.suggestConfig) w.roleConfig = WW.suggestConfig(seats.length);
  }
  return { ok: true };
}

/** 抽角色 + 重置存活/公开状态。开局与「下一局」共用，避免两处逻辑走偏。 */
function wwDealRoles(room, w, bumpRound) {
  const seats = activeSeats(room);
  if (seats.length < 2) return { ok: false, error: '至少需要 2 位玩家' };
  if (!(w.moderatorSeat >= 0) || !seats.includes(w.moderatorSeat)) {
    return { ok: false, error: '请先指定一名玩家为主持人' };
  }
  const players = seats.filter((s) => s !== w.moderatorSeat);
  if (players.length < 1) return { ok: false, error: '除主持人外至少要有 1 位玩家' };

  const WW = wwModule();
  const draw = (WW && WW.drawRoles) ? WW.drawRoles : null;
  let assign = {}, filled = 0, trimmed = 0;
  if (draw) {
    const res = draw(players, w.roleConfig);
    assign = res.assign; filled = res.filled; trimmed = res.trimmed;
  }

  const n = seatCountOf(room);
  w.roles = new Array(n).fill(null);
  players.forEach((s) => { w.roles[s] = assign[s] || null; });
  w.alive = Array.from({ length: n }, (_, i) => seats.includes(i));
  w.revealed = new Array(n).fill(false);
  w.vote = null;
  w.winner = null;
  if (bumpRound) w.round = (w.round || 0) + 1;
  return { ok: true, filled, trimmed };
}

function wwNoteLine(filled, trimmed) {
  const note = [];
  if (filled) note.push(`角色不足，已补 ${filled} 名村民`);
  if (trimmed) note.push(`角色超出，已随机去掉 ${trimmed} 个`);
  return note.join('；');
}

/** 开局：给「非主持人」的座位随机抽角色 */
function wwStart(room) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  const res = wwDealRoles(room, w, false);
  if (!res.ok) return res;

  w.round = 1;
  w.phase = 'night';
  w.startedAt = Date.now();
  w.messages = [];
  w.seq = 0;
  w.results = Array.isArray(w.results) ? w.results : [];

  room.phase = 'playing';        // 脱离大厅；子阶段看 werewolf.phase
  room.turn = -1;                // 狼人杀没有「轮到谁出牌」，置 -1 让节拍循环空转
  room.round = 1;
  room.log = ['狼人杀开局：角色已随机分配'];
  const line = wwNoteLine(res.filled, res.trimmed);
  if (line) room.log.push(line);
  return { ok: true, filled: res.filled, trimmed: res.trimmed };
}

/** 主持人判定胜负（好人 / 狼人 / 平局）→ 本局结束 */
function wwSetWinner(room, seat, winner) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能判定胜负' };
  const key = String(winner || '');
  if (!['good', 'wolf', 'draw'].includes(key)) return { ok: false, error: '胜负非法' };

  w.winner = key;
  w.phase = 'end';
  room.phase = 'roundEnd';
  w.results = Array.isArray(w.results) ? w.results : [];
  w.results.push({ round: w.round || 1, winner: key, at: Date.now() });
  const label = key === 'good' ? '好人阵营获胜' : (key === 'wolf' ? '狼人阵营获胜' : '平局');
  wwPushSystem(w, `第 ${w.round || 1} 局结束：${label}`);
  return { ok: true };
}

/** 主持人开下一局：重新抽角色、清空消息、局数 +1 */
function wwNextRound(room, seat) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能开下一局' };
  if (w.phase !== 'end') return { ok: false, error: '请先结束本局并判定胜负' };

  const res = wwDealRoles(room, w, true);
  if (!res.ok) return res;

  w.messages = [];
  w.seq = 0;
  w.phase = 'night';
  room.phase = 'playing';
  room.round = w.round;
  wwPushSystem(w, `第 ${w.round} 局开始：角色已重新分配`);
  const line = wwNoteLine(res.filled, res.trimmed);
  if (line) wwPushSystem(w, line);
  return { ok: true, filled: res.filled, trimmed: res.trimmed };
}

/* ---------- 投票 ---------- */

function wwVoteOpen(room, seat, title, options) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能发起投票' };
  if (w.phase !== 'night' && w.phase !== 'day') return { ok: false, error: '当前阶段不能投票' };

  let opts = Array.isArray(options) && options.length
    ? options.map((s) => parseInt(s, 10))
      .filter((s) => Number.isInteger(s) && s >= 0 && s < seatCountOf(room))
    : [];
  // 不指定候选时默认为「所有存活玩家（不含主持人）」
  if (!opts.length) {
    opts = Array.from({ length: seatCountOf(room) }, (_, i) => i)
      .filter((i) => room.seats[i] && i !== w.moderatorSeat && w.alive[i] !== false);
  }
  if (!opts.length) return { ok: false, error: '没有可投的候选' };

  w.vote = {
    open: true,
    title: String(title || '投票').slice(0, 30),
    options: opts,
    ballots: {},
    revealed: false,
    result: null,
    at: Date.now(),
  };
  wwPushSystem(w, `投票开始：${w.vote.title}（候选 ${opts.length} 位）`);
  return { ok: true };
}

function wwVoteCast(room, seat, target) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  const v = w.vote;
  if (!v || !v.open) return { ok: false, error: '当前没有进行中的投票' };
  if (seat === w.moderatorSeat) return { ok: false, error: '主持人不参与投票' };
  if (w.alive && w.alive[seat] === false) return { ok: false, error: '你已出局，不能投票' };
  const t = parseInt(target, 10);
  if (!v.options.includes(t)) return { ok: false, error: '候选人非法' };
  v.ballots[seat] = t;
  return { ok: true };
}

/** 结束投票；reveal=true 时把结果公之于众 */
function wwVoteClose(room, seat, reveal) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能结束投票' };
  const v = w.vote;
  if (!v || !v.open) return { ok: false, error: '当前没有进行中的投票' };

  const WW = wwModule();
  const tally = (WW && WW.tallyVotes)
    ? WW.tallyVotes(v)
    : { top: null, tie: false, tied: [], total: 0 };
  v.open = false;
  v.result = tally;

  if (reveal !== false) {
    v.revealed = true;
    const nm = (s) => ((room.seats && room.seats[s]) ? room.seats[s].name : `${s + 1} 号`);
    const line = (!tally.top || tally.tie)
      ? (tally.tie ? `平票（${tally.tied.map((e) => nm(e.seat)).join('、')} 各 ${tally.tied[0].count} 票）` : '无人投票')
      : `${nm(tally.top.seat)} 得票最高（${tally.top.count} 票）`;
    wwPushSystem(w, `投票结果：${line}`);
  }
  return { ok: true };
}

function wwVoteCancel(room, seat) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能取消投票' };
  if (!w.vote || !w.vote.open) return { ok: false, error: '当前没有进行中的投票' };
  w.vote = null;
  wwPushSystem(w, '投票已取消');
  return { ok: true };
}

/** 发言 / 主持人喊话 */
function wwSay(room, seat, text, to) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (w.phase !== 'night' && w.phase !== 'day') return { ok: false, error: '当前阶段不能发言' };
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, error: '消息不能为空' };
  if (t.length > 200) return { ok: false, error: '消息最多 200 字' };

  const isMod = seat === w.moderatorSeat;
  // 出局的玩家不再发言（主持人不受此限，他要继续主持）
  if (!isMod && w.alive && w.alive[seat] === false) {
    return { ok: false, error: '你已出局，不能再发言' };
  }
  const target = wwNormalizeTarget(to, isMod, w, seat, w.roles);
  if (!target) {
    return {
      ok: false,
      error: isMod ? '消息目标非法' : '夜晚只能私聊主持人或本角色频道，白天才能公开发言',
    };
  }

  w.seq = (w.seq || 0) + 1;
  w.messages.push({
    id: w.seq, from: seat, to: target, text: t,
    phase: w.phase, round: w.round, ts: Date.now(),
  });
  // 消息流上限，避免长时间对局把房间撑爆
  if (w.messages.length > 300) w.messages = w.messages.slice(-300);
  return { ok: true };
}

/** 主持人切换昼夜 / 结束对局 */
function wwSetPhase(room, seat, phase) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能切换阶段' };
  const p = String(phase || '');
  if (!['night', 'day', 'end'].includes(p)) return { ok: false, error: '阶段非法' };
  if (p === 'night' && w.phase === 'day') w.round = (w.round || 0) + 1;
  w.phase = p;
  room.phase = (p === 'end') ? 'roundEnd' : 'playing';
  if (p === 'end') room.log = room.log || [], room.log.push('主持人宣布对局结束');
  return { ok: true };
}

/** 主持人判定出局 / 复活（出局默认公开身份） */
function wwSetAlive(room, seat, targetSeat, alive) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能判定出局' };
  const t = parseInt(targetSeat, 10);
  if (!Number.isInteger(t) || t < 0 || t >= seatCountOf(room)) return { ok: false, error: '座位非法' };
  if (t === w.moderatorSeat) return { ok: false, error: '主持人不是玩家' };

  const wasAlive = w.alive[t] !== false;
  w.alive[t] = !!alive;
  const name = (room.seats && room.seats[t]) ? room.seats[t].name : `${t + 1} 号`;
  const role = (w.roles || [])[t];

  if (!alive && wasAlive) {
    // 出局 = 身份公开 + 给全场一条死亡公告（这是「死亡提示」的唯一来源）
    w.revealed[t] = true;
    wwPushSystem(w, `${name} 出局${role ? '，身份是「' + role.name + '」' : ''}`);
  } else if (alive && !wasAlive) {
    wwPushSystem(w, `${name} 已复活`);
  }
  return { ok: true };
}

/** 主持人公开某位玩家的身份（如被查验 / 遗言） */
function wwReveal(room, seat, targetSeat) {
  const w = room.werewolf;
  if (!w) return { ok: false, error: '非狼人杀房间' };
  if (seat !== w.moderatorSeat) return { ok: false, error: '只有主持人能公开身份' };
  const t = parseInt(targetSeat, 10);
  if (!Number.isInteger(t) || t < 0 || t >= seatCountOf(room)) return { ok: false, error: '座位非法' };
  w.revealed[t] = true;
  return { ok: true };
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
  // 明牌：地主手牌全程公开给所有客户端（防作弊裁剪只保留本人手牌，这里显式放开地主）
  if (room.mode === 'ddz' && room.mingpai && room.landlord >= 0) {
    view.hands[room.landlord] = room.hands[room.landlord];
  }

  /* 狼人杀：角色 + 消息按可见性裁剪。
   *
   * ⚠️ 必须在这里（裁判侧）裁剪，不能交给前端隐藏 —— 前端拿到完整数据后，
   *    玩家 F12 打开控制台就能看到所有人的身份和私密消息，模式直接失效。
   *    规则由 werewolf.js 的 canSee 单点定义，这里只负责执行。 */
  if (room.mode === 'werewolf' && room.werewolf) {
    const w = room.werewolf;
    const isMod = mySeat === w.moderatorSeat;
    const WW = wwModule();
    const ctx = {
      moderatorSeat: w.moderatorSeat,
      roles: w.roles,
      roleConfig: w.roleConfig,
      seatNames: (room.seats || []).map((s) => (s ? s.name : '')),
    };
    const vis = (WW && WW.visibleMessages)
      ? WW.visibleMessages(w.messages, mySeat, ctx)
      : (w.messages || []).filter((m) => !m.to || m.to.kind === 'all');

    const ww = JSON.parse(JSON.stringify(w));
    // 身份：主持人看全场 / 玩家只看自己 / 已公开可见 / **同角色互认（狼人看得到同伴）**
    ww.roles = (w.roles || []).map((r, i) => {
      if (isMod) return r;
      if (w.revealed && w.revealed[i]) return r;
      if (WW && WW.canSeeRole && WW.canSeeRole(w.roles, mySeat, i)) return r;
      return (i === mySeat) ? r : null;
    });
    // 同伴座位（界面用来标「同伴」角标）
    ww.peers = (WW && WW.peerSeats) ? WW.peerSeats(w.roles, mySeat) : [];
    // 选票：公布前只给主持人和投票者本人看，避免跟风投票
    if (ww.vote && !ww.vote.revealed && !isMod) {
      const mine = (ww.vote.ballots || {})[mySeat];
      ww.vote.ballots = (mine == null) ? {} : { [mySeat]: mine };
    }
    ww.messages = JSON.parse(JSON.stringify(vis));
    ww.isMod = isMod;
    ww.mySeat = mySeat;
    view.werewolf = ww;
  }
  return view;
}

const NET_REFEREE = {
  RULES_BY_MODE: rulesByMode,
  MAX_SEATS, MIN_SEATS, clampSeatCount, defaultSeatCount, seatCountOf, fitSeatArray,
  makeRoom, ruleOf, occupiedSeats, humanCount, activeSeats,
  startRound, afterSell, beginPlay, dealDdz, finishDdzBidding,
  legalFor, playCard, playCards, passDdz, submitBid, submitMing,
  resolveTrick, releaseHold, endRound, nextActiveSeat,
  submitSell, submitPass,
  aiChooseCard, aiChooseBid, aiChooseDdzPlay, aiChooseSell, aiChoosePass, stepAI,
  currentActorSeat, forceTimeout,
  publicView,
  // 狼人杀（联机对话模式）
  makeWerewolf, wwSetConfig, wwStart, wwSay, wwSetPhase, wwSetAlive, wwReveal,
  wwNormalizeTarget, wwDealRoles,
  wwSetWinner, wwNextRound,
  wwVoteOpen, wwVoteCast, wwVoteClose, wwVoteCancel,
};

if (typeof module !== 'undefined' && module.exports) module.exports = NET_REFEREE;
if (root && typeof window !== 'undefined') root.NET_REFEREE = NET_REFEREE;

})(typeof window !== 'undefined' ? window : this);
