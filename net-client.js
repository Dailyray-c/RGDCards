/* ============================================================
 * net-client.js —— 联机会话
 *
 * 职责：把「房间」和「界面」缝在一起。
 *   · 建房 / 加入 / 离开
 *   · 轮询房间变化 → 通知 UI 重绘
 *   · 房主独有：推进 AI、判定每墩、结算（调用 net-referee）
 *   · 普通玩家：提交自己的动作（亮牌 / 传牌 / 出牌）
 *
 * 房主 = 房主浏览器的标签页。它同时也是一名玩家，边玩边当裁判。
 * 房主掉线时房间停止推进（其他玩家会看到「房主已离开」提示）。
 * ============================================================ */
(function (root) {
'use strict';

const REF = root.NET_REFEREE;
const CORE = root.NET_CORE;

/* 本机会话状态 */
const session = {
  active: false,       // 是否在联机模式
  code: null,
  mySeat: -1,
  playerId: null,
  playerName: '玩家',
  isHost: false,
  room: null,          // 权威房间（房主本地就是权威；其他人是服务器副本）
  view: null,          // 裁剪后的视图
  pollToken: 0,        // 用于取消旧的轮询循环
  pumpToken: 0,        // 用于取消旧的 AI 节拍循环（每次启动 ++ 使旧循环失效）
  playback: null,      // 播放队列：把"轮询漏掉的中间态"逐帧补播，见 enqueuePlayback
  listeners: new Set(),
  lastError: '',
};

let nameSyncTimer = 0;   // 昵称写回房间的防抖句柄（见 setPlayerName）

/* ---------- 玩家标识 ---------- */

const LS_PID = 'ncm.pid';
function ensurePlayerId() {
  try {
    let id = localStorage.getItem(LS_PID);
    if (!id) {
      id = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(LS_PID, id);
    }
    return id;
  } catch (_) {
    return 'p' + Math.random().toString(36).slice(2, 10);
  }
}

function setPlayerName(name) {
  session.playerName = name || '玩家';
  // 已经在房间里时要把新名字写回房间，否则别人看到的仍是进房那一刻的旧名字。
  // ⚠️ 输入框是逐字符触发 input 的，必须防抖 —— 否则每敲一个字发一次写请求。
  if (!session.active || !session.code || session.mySeat < 0) return;
  clearTimeout(nameSyncTimer);
  nameSyncTimer = setTimeout(syncNameToRoom, 300);
}

/** 把本地昵称写回房间座位（值没变则不写，省一次往返） */
async function syncNameToRoom() {
  if (!session.active || !session.code || session.mySeat < 0) return;
  try {
    const room = await CORE.updateRoom(session.code, (draft) => {
      const s = draft.seats[session.mySeat];
      if (!s || s.name === session.playerName) return false;
      s.name = session.playerName;
      return draft;
    });
    if (room) {
      session.room = room;
      session.view = REF.publicView(room, session.mySeat);
      emit('room');
    }
  } catch (e) {
    // 名字同步失败不该影响对局
  }
}

/* ---------- 事件订阅 ---------- */

function subscribe(fn) {
  session.listeners.add(fn);
  return () => session.listeners.delete(fn);
}

function emit(kind) {
  for (const fn of session.listeners) {
    try { fn(kind, session); } catch (e) { console.error(e); }
  }
}

function setError(msg) {
  session.lastError = msg || '';
  emit('error');
}

/* ---------- 播放队列（根治「看不见 AI 出牌」） ---------- */

/**
 * 为什么需要这个？
 *
 * 联机的状态同步是「轮询服务器拿最新快照」。无论轮询多快，它都只能拿到
 * **某一时刻的快照**：如果房主在这一瞬间之前连续推进了两步，客户端就直接
 * 从「0.1」跳到「0.3」，中间那次出牌永远看不到 —— 这就是用户反馈的
 * 「看不见 AI 出牌过程 / 对方的牌一下就多了一张」。
 *
 * 调参数（加快轮询、放慢节拍）只能降低概率，无法根治：任何非零的轮询间隔
 * 都存在被跳过的窗口。
 *
 * 根治办法：**不再只显示「最新快照」，而是让显示进度单调地追上去。**
 *
 * 核心是一个「显示水位」——记录**玩家眼睛看到的那一帧**（不是最新快照）。
 * 每次收到新快照时：
 *   · 如果快照比显示水位超前很多 → 构造中间帧，以固定节拍一张一张揭示；
 *   · 显示水位**只增不减**，绝不能被后到的旧快照拉回去。
 *
 * 这样漏失率从「取决于网络」变成 **恒为 0**：只要牌最终进了快照，
 * 玩家就一定看得到它被打出来的那一下。
 *
 * 设计要点（踩过坑）：
 *   · 显示进度用一个自增的 `seq` 标识，**不用「到达顺序」**。
 *     历史 bug：每次新快照都 ++token 作废在途 drain，导致队列永远播不完、
 *     显示还在 1 张时服务器已经 3 张，界面反复回退（1→2→1）。
 *   · `displayCursor` 单调递增：只在严格推进时才更新。
 *   · 队列与 drain 循环是**唯一写入者**（单消费者），避免多方竞争。
 */

/** 每张新出现的牌停留多久 */
const PLAYBACK_MS = 700;

/** 队列上限，防止长时间后台标签页堆积成"快进动画" */
const PLAYBACK_MAX = 12;

/** 取「牌局进度」的指纹：出牌位序号 = 墩号 * 4 + 本墩已出张数 */
function trickCursor(room) {
  if (!room) return 0;
  if (room.mode === 'ddz') return room.moveSeq || 0;
  if (!room.trickPlays) return 0;
  return (room.trickIndex || 0) * 4 + room.trickPlays.length;
}

/**
 * 从 prev 到 next 之间，补出中间的出牌帧（不含 next 本身）。
 *
 * 只在**同一墩内**补帧：跨墩时局面已被 resolveTrick 清空，无法反推出
 * 那四张牌分别是谁在第几位出的，这时不臆造 —— 一墩结束本来就该整体重绘。
 */
function intermediateFrames(prev, next) {
  if (!prev || !next) return [];
  if (prev.trickIndex !== next.trickIndex) return [];   // 跨墩 → 不补
  const from = prev.trickPlays.length;
  const to = next.trickPlays.length;
  if (to <= from) return [];                            // 没新增 → 不补

  const frames = [];
  for (let i = from + 1; i <= to; i++) {
    const snap = JSON.parse(JSON.stringify(next));
    snap.trickPlays = next.trickPlays.slice(0, i);
    frames.push(snap);
  }
  return frames;
}

/** 播放状态：{ queue, seq, timer } —— 单消费者，永远只向前走 */
function ensurePlayback() {
  if (!session.playback) {
    session.playback = { queue: [], seq: 0, timer: null, cursor: -1 };
  }
  return session.playback;
}

/**
 * 把新快照「喂」进补播队列。**不返回视图**——显示由 currentView() 决定。
 *
 * 关键不变式：显示水位（pb.cursor）只增不减，队列是唯一驱动者。
 */
function enqueuePlayback(prevRoom, nextRoom) {
  const pb = ensurePlayback();
  const nextCursor = trickCursor(nextRoom);

  // 非牌局阶段（大厅/结算/亮牌/传牌）不做逐帧补播：那里的"中间态"是
  // 表单勾选状态，本来就不需要动画，直接切最新状态并清空队列。
  const playing = nextRoom && nextRoom.phase === 'playing'
    && prevRoom && prevRoom.phase === 'playing';
  if (!playing) {
    pb.queue.length = 0;
    pb.cursor = nextCursor;
    stopDrain();
    return;
  }

  // 起点：队列非空就从队尾接着补；否则从上一帧权威快照接着补。
  const tail = pb.queue.length ? pb.queue[pb.queue.length - 1] : prevRoom;
  const frames = intermediateFrames(tail, nextRoom);

  // 只补「确实向前推进」的帧，绝不让显示水位倒退
  for (const f of frames) {
    if (trickCursor(f) > pb.cursor) pb.queue.push(f);
  }

  // 尾巴一定要是最新快照，否则真实局面推进了、界面却停在中间帧不动。
  if (!pb.queue.length || trickCursor(pb.queue[pb.queue.length - 1]) < nextCursor) {
    pb.queue.push(nextRoom);
  }

  // 队列过长（长时间后台标签页）→ 丢掉中间帧直接追最新，避免"快进动画"
  while (pb.queue.length > PLAYBACK_MAX) pb.queue.shift();

  // 队首成为新的显示水位（单调递增）
  if (pb.queue.length && trickCursor(pb.queue[0]) > pb.cursor) {
    pb.cursor = trickCursor(pb.queue[0]);
  }

  startDrain();
}

/** 消费队列：每 PLAYBACK_MS 前进一帧。**单实例**，无 token 作废。 */
function startDrain() {
  const pb = ensurePlayback();
  if (pb.timer) return;                      // 已经在跑，让它自己继续
  pb.timer = setInterval(() => {
    if (!session.active) { stopDrain(); return; }
    if (!pb.queue.length) { stopDrain(); emit('room'); return; }
    pb.queue.shift();
    // 显示水位随消费单调前进
    if (pb.queue.length) pb.cursor = Math.max(pb.cursor, trickCursor(pb.queue[0]));
    emit('room');
    if (!pb.queue.length) { stopDrain(); emit('room'); }
  }, PLAYBACK_MS);
}

function stopDrain() {
  const pb = session.playback;
  if (pb && pb.timer) { clearInterval(pb.timer); pb.timer = null; }
}

/** 当前该显示的视图：队首帧优先（补播中），否则最新权威视图 */
function currentView() {
  const pb = session.playback;
  if (pb && pb.queue.length) return REF.publicView(pb.queue[0], session.mySeat);
  return session.view;
}

/* ---------- 建房 / 加入 ---------- */

/**
 * 建房。
 * @param {string} mode       'hearts' | 'gongzhu' | 'ddz'
 * @param {string} [difficulty] 主页选中的 AI 难度，写进 settings.aiDifficulty ——
 *        托管席位（含 AI 占位）的叫分上限与出牌强度都读它。
 */
async function createRoom(mode, difficulty) {
  const cfg = root.NET_CONFIG.getNetConfig();
  if (!cfg.ready) {
    setError('未配置联机服务。请先在 net-config.js 填入 Upstash URL 与 Token。');
    return null;
  }
  session.playerId = ensurePlayerId();

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = CORE.randomCode();
    const room = REF.makeRoom(code, {
      mode: mode || 'gongzhu',
      hostId: session.playerId,
    });
    room.seats[0] = { id: session.playerId, name: session.playerName, ready: true };
    // 建房时就把其余空位标成 AI 托管，大厅里立刻能看出「差几个人」
    const seatCount = room.seatCount || 4;
    room.aiSeats = Array.from({ length: seatCount }, (_, i) => i)
      .filter((i) => !room.seats[i]);
    if (room.mode === 'ddz') {
      room.settings.aiDifficulty = difficulty || room.settings.aiDifficulty || 'normal';
    }

    let created = null;
    try { created = await CORE.createRoom(code, room); } catch (e) {
      if (e.code === 'NET_NOT_CONFIGURED') {
        setError('未配置联机服务。请先在 net-config.js 填入 Upstash URL 与 Token。');
        return null;
      }
      setError('创建房间失败：' + e.message);
      return null;
    }
    if (created) {
      session.active = true;
      session.code = code;
      session.isHost = true;
      session.mySeat = 0;
      session.room = created;
      session.view = REF.publicView(created, 0);
      setError('');
      startPolling();
      emit('joined');
      return code;
    }
  }
  setError('房间码生成冲突，请重试');
  return null;
}

async function joinRoom(code) {
  const cfg = root.NET_CONFIG.getNetConfig();
  if (!cfg.ready) {
    setError('未配置联机服务。请先在 net-config.js 填入 Upstash URL 与 Token。');
    return null;
  }
  session.playerId = ensurePlayerId();
  const clean = String(code || '').trim().toUpperCase();
  if (clean.length !== CORE.CODE_LEN) {
    setError('房间码应为 ' + CORE.CODE_LEN + ' 位');
    return null;
  }

  let joined = null;
  const room = await CORE.updateRoom(clean, (draft) => {
    // 已在房间里（断线重连）
    const mine = draft.seats.findIndex((s) => s && s.id === session.playerId);
    if (mine >= 0) {
      draft.seats[mine].name = session.playerName;
      joined = mine;
      return draft;
    }
    // 找空位
    const seatCount = draft.mode === 'ddz' ? 3 : (draft.seatCount || 4);
    const empty = draft.seats.findIndex((s, i) => i < seatCount && s === null);
    if (empty < 0) { setError('房间已满'); return false; }
    if (draft.phase !== 'lobby') { setError('这局已经开打了，无法中途加入'); return false; }
    draft.seats[empty] = { id: session.playerId, name: session.playerName, ready: true };
    joined = empty;
    return draft;
  });

  if (!room) {
    if (!session.lastError) setError('房间不存在或已过期');
    return null;
  }

  // AI 补位座位随人数变化重算
  await reseatAI(clean);

  session.active = true;
  session.code = clean;
  session.isHost = false;
  session.mySeat = joined ?? 0;
  setError('');
  startPolling();
  emit('joined');
  return clean;
}

/** 人数不足 4 时把空位标记为 AI 托管 */
async function reseatAI(code) {
  return CORE.updateRoom(code, (draft) => {
    const seatCount = draft.mode === 'ddz' ? 3 : (draft.seatCount || 4);
    draft.seatCount = seatCount;
    const humans = draft.seats.map((s, i) => (s && i < seatCount ? i : -1)).filter((i) => i >= 0);
    const aiSeats = [];
    // 至少补到对应模式的参赛人数
    for (let i = 0; i < seatCount; i++) {
      if (!draft.seats[i]) aiSeats.push(i);
    }
    draft.aiSeats = aiSeats;
    if (draft.mode === 'ddz') draft.settings.aiDifficulty = draft.settings.aiDifficulty || 'normal';
    draft.humanSeats = humans;
    return draft;
  });
}

/* ---------- 房间设置（房主） ---------- */

async function updateSettings(patch) {
  if (!session.active || !session.isHost) return null;
  const room = await CORE.updateRoom(session.code, (draft) => {
    Object.assign(draft.settings, patch);
    return draft;
  });
  if (room) { session.room = room; emit('room'); }
  return room;
}

async function setMode(mode) {
  if (!session.isHost) return null;
  const room = await CORE.updateRoom(session.code, (draft) => {
    if (draft.phase !== 'lobby') return false;
    draft.mode = mode;
    draft.seatCount = mode === 'ddz' ? 3 : 4;
    draft.aiSeats = Array.from({ length: draft.seatCount }, (_, i) => i)
      .filter((i) => !draft.seats[i]);
    if (mode === 'ddz') draft.settings.aiDifficulty = draft.settings.aiDifficulty || 'normal';
    return draft;
  });
  if (room) { session.room = room; emit('room'); }
  return room;
}

/* ---------- 开局 ---------- */

async function startGame() {
  if (!session.isHost) return null;
  const room = await CORE.updateRoom(session.code, (draft) => {
    if (draft.phase !== 'lobby') return false;
    const seatCount = draft.mode === 'ddz' ? 3 : (draft.seatCount || 4);
    draft.seatCount = seatCount;
    // 人数不足用 AI 补满参赛座位（以当前座位反推，避免重复叠加）
    draft.aiSeats = Array.from({ length: seatCount }, (_, i) => i)
      .filter((i) => !draft.seats[i]);
    if (draft.aiSeats.length === seatCount) return false;   // 一个人都没有，别开局
    if (draft.mode === 'ddz') draft.settings.aiDifficulty = draft.settings.aiDifficulty || 'normal';
    REF.startRound(draft);
    return draft;   // 只发牌进阶段，AI 的亮牌/传牌交给节拍循环逐步推进
  });
  if (room) {
    session.room = room;
    session.view = REF.publicView(room, session.mySeat);
    emit('room');
    startPacedPump();
  }
  return room;
}

/**
 * 房主：本局结算完成后开下一局。
 *
 * 推进权只在房主（裁判）手上 —— 普通玩家调用直接返回 null，
 * 他们跟着房间阶段走就行（下一局开始时 phase 会自动变回 selling/passing/playing）。
 *
 * 到达终局线（gameEnd）时，重置累计分与局数，从第 1 局重新开始一盘。
 *
 * ⚠️ 阶段判断用 roundEnd / gameEnd，**不要**用 `phase !== 'lobby'` 之类的宽松条件：
 *    否则在出牌中途误点就会把整局重新发牌。
 */
async function nextRound() {
  if (!session.isHost) return null;
  const room = await CORE.updateRoom(session.code, (draft) => {
    if (draft.phase !== 'roundEnd' && draft.phase !== 'gameEnd') return false;
    if (draft.phase === 'gameEnd') {
      draft.scores = [0, 0, 0, 0];
      draft.round = 0;          // startRound() 会 +1 → 新一盘从第 1 局开始
      draft.log = [];
    }
    const seatCount = draft.mode === 'ddz' ? 3 : (draft.seatCount || 4);
    draft.aiSeats = Array.from({ length: seatCount }, (_, i) => i)
      .filter((i) => !draft.seats[i]);
    if (draft.mode === 'ddz') draft.settings.aiDifficulty = draft.settings.aiDifficulty || 'normal';
    REF.startRound(draft);
    return draft;
  });
  if (room) {
    session.room = room;
    session.view = REF.publicView(room, session.mySeat);
    emit('room');
    startPacedPump();
  }
  return room;
}


/* ---------- 玩家动作 ---------- */

/*
 * 三个动作的统一约定：mutator 直接就地修改传入的 draft，
 * 返回 false 表示「放弃本次提交」，其它返回值一律忽略。
 * 注意：绝不能把 REF.submitPass() 的返回值（{ok,...}）当成新房间 ——
 * 历史 bug：sendAction 用 mutator 的返回值当房间，导致 {ok:true} 被当成
 * 房间对象传给 stepAI，在 room.aiSeats 上炸掉。
 */
async function submitSell(cards) {
  return sendAction((draft) => {
    const res = REF.submitSell(draft, session.mySeat, cards);
    if (!res.ok) { setError(res.error); return false; }
    return true;
  });
}

async function submitPass(cards) {
  return sendAction((draft) => {
    const res = REF.submitPass(draft, session.mySeat, cards);
    if (!res.ok) { setError(res.error); return false; }
    return true;
  });
}

async function submitBid(bid) {
  return sendAction((draft) => {
    const res = REF.submitBid(draft, session.mySeat, bid);
    if (!res.ok) { setError(res.error); return false; }
    return true;
  });
}

async function playCards(cards) {
  return sendAction((draft) => {
    const res = REF.playCards(draft, session.mySeat, cards);
    if (!res.ok) { setError(res.error); return false; }
    return true;
  });
}

async function passPlay() {
  return sendAction((draft) => {
    const res = REF.passDdz(draft, session.mySeat);
    if (!res.ok) { setError(res.error); return false; }
    return true;
  });
}

async function playCard(card) {
  const mode = (session.view && session.view.mode) || (session.room && session.room.mode);
  if (mode === 'ddz') return playCards([card]);
  return sendAction((draft) => {
    const res = REF.playCard(draft, session.mySeat, card);
    if (!res.ok) { setError(res.error); return false; }
    return true;
  });
}

/** 统一的动作提交：房主本地改，普通玩家写服务器 */
async function sendAction(fn) {
  if (!session.active) return null;
  setError('');

  // mutator 只用来「就地改 draft / 或返回 false 放弃」
  const mutate = (draft) => {
    const res = fn(draft);
    if (res === false) return false;
    return draft;
  };

  if (session.isHost) {
    // 房主：本地权威副本上改，再推给服务器。
    //
    // ⚠️ 关键：房主不是唯一写者 —— 其他真人玩家的提交也写同一个房间键。
    // 所以推送前必须把服务器上「别人刚提交的东西」合并进来，否则会用
    // 本地旧副本覆盖掉并发提交（历史 bug：客人传的牌被房主提交时清掉）。
    const draft = JSON.parse(JSON.stringify(session.room));
    if (mutate(draft) === false) return null;

    // ⚠️ 只推进「一步」，不要把 AI 一口气全推完。
    //    全推完的话，写回服务器的状态会一次跳过好几张牌（甚至整墩），
    //    其他玩家轮询回来直接看到终态 —— 表现就是「没看见对方出牌就下一轮了」。
    //    剩下的 AI 步骤交给 startPacedPump() 按节拍逐步推进。
    const authoritative = await writeHostDraft(draft);
    session.room = authoritative;
    session.view = REF.publicView(authoritative, session.mySeat);
    emit('room');
    startPacedPump();
    return authoritative;
  }

  // 普通玩家：交给服务器，由房主轮询后推进
  const room = await CORE.updateRoom(session.code, mutate);
  if (room) { session.room = room; session.view = REF.publicView(room, session.mySeat); emit('room'); }
  return room;
}

/**
 * 房主把本地 draft 写回服务器（合并并发提交 + 版本对齐）。
 * 返回权威房间对象。
 */
async function writeHostDraft(draft) {
  const base = session.room ? JSON.parse(JSON.stringify(session.room)) : null;
  const room = await CORE.updateRoom(session.code, (srv) => {
    // 房主的 AI 可能正好与客人的动作并发。若服务器已出现新的
    // 斗地主叫分/动作，不能把基于旧快照的 AI 状态写回去覆盖它。
    if (base && srv.v !== base.v && hasRemoteDdzAction(srv, base)) return srv;
    mergeRemoteSubmissions(srv, draft);
    draft.v = srv.v;
    return draft;
  });
  // 写入失败（版本冲突耗尽）时保留本地权威，避免玩家看到自己的操作被「吞掉」
  return room || draft;
}

/** 判断服务器是否已经发生了基于 base 之后的斗地主动作。 */
function hasRemoteDdzAction(srv, base) {
  if (!srv || !base || srv.mode !== 'ddz' || base.mode !== 'ddz') return false;
  if (srv.phase !== base.phase || srv.bidTurn !== base.bidTurn ||
      srv.turn !== base.turn || srv.moveSeq !== base.moveSeq ||
      srv.actionSeq !== base.actionSeq) return true;
  if (JSON.stringify(srv.bids || []) !== JSON.stringify(base.bids || [])) return true;
  const a = srv.lastAction || null;
  const b = base.lastAction || null;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * 把服务器副本上「其他座位已提交、但本地还是 null」的内容补进本地 draft。
 * 只合并提交类字段：本地已提交的以本地为准（本地就是自己刚做的动作）。
 */
function mergeRemoteSubmissions(srv, draft) {
  if (!srv) return draft;
  for (const key of ['selectedPass', 'selectedSell', 'bids']) {
    const a = srv[key], b = draft[key];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    for (let i = 0; i < 4; i++) {
      // 本地是 null（还没提交）而服务器已有 → 采纳服务器（别人提交的）
      if (b[i] === null && a[i] !== null) b[i] = a[i];
    }
  }
  if (srv.mode === 'ddz') {
    const remoteActions = Array.isArray(srv.actions) ? srv.actions : [];
    const localActions = Array.isArray(draft.actions) ? draft.actions : [];
    const actions = localActions.slice();
    const seen = new Set(actions.map((action) => JSON.stringify(action)));
    for (const action of remoteActions) {
      const key = JSON.stringify(action);
      if (!seen.has(key)) { seen.add(key); actions.push(action); }
    }
    actions.sort((a, b) =>
      (a.actionSeq || a.seq || 0) - (b.actionSeq || b.seq || 0));
    draft.actions = actions;

    const remoteSeq = srv.actionSeq || 0;
    const localSeq = draft.actionSeq || 0;
    if (remoteSeq > localSeq) {
      const stateKeys = [
        'phase', 'hands', 'bottom', 'bids', 'bidTurn', 'currentBid',
        'highestBidder', 'landlord', 'turn', 'currentCombo', 'lastLeadSeat',
        'passCount', 'moveSeq', 'bombCount', 'hasRocket', 'roles',
        'lastPlay', 'lastAction', 'baseBid',
      ];
      for (const key of stateKeys) {
        if (Object.prototype.hasOwnProperty.call(srv, key)) {
          draft[key] = JSON.parse(JSON.stringify(srv[key]));
        }
      }
      draft.actionSeq = remoteSeq;
    } else if (srv.lastAction &&
        (!draft.lastAction || (srv.lastAction.actionSeq || srv.lastAction.seq || 0) >
          (draft.lastAction.actionSeq || draft.lastAction.seq || 0))) {
      draft.lastAction = srv.lastAction;
    }
  }
  // 座位表：别人的加入 / 离开也要跟上，否则房主写入会把人踢掉
  if (Array.isArray(srv.seats)) {
    for (let i = 0; i < 4; i++) {
      if (srv.seats[i] && !draft.seats[i]) draft.seats[i] = srv.seats[i];
      else if (!srv.seats[i] && draft.seats[i] && srv.seats[i] !== undefined
               && draft.seats[i].id !== session.playerId) {
        // 别人离开了（服务器上是空的、而本地还留着非自己的座位）→ 清掉
        draft.seats[i] = null;
      }
    }
  }
  // aiSeats 跟随座位表重算：有真人的座位绝不能同时算 AI
  if (Array.isArray(srv.aiSeats)) {
    const count = draft.mode === 'ddz' ? 3 : (draft.seatCount || 4);
    draft.aiSeats = Array.from({ length: count }, (_, i) => i)
      .filter((i) => !draft.seats[i]);
  }
  return draft;
}

/* ---------- 房主推进 ---------- */

/**
 * AI 每步之间的间隔（毫秒）。
 *
 * 这个值决定「玩家能多清楚地看到对方出牌」。单人版用 620~950ms 的延迟动画，
 * 联机版必须给出**同等甚至更长**的停顿，否则在「一次轮询拿到新状态」的
 * 模型下，几张牌会挤在一起出现，玩家就会觉得"没看见出牌就过墩了"。
 *
 * 取 900ms：比单人版略慢一点，给轮询留出把每一步都取回来的时间窗。
 */
const STEP_INTERVAL_MS = 900;
/* 斗地主「叫分」阶段的节拍。刻意比出牌慢得多：
 * 叫分是「一锤子买卖」，错过就再也看不到了，必须留出读盘时间。 */
const DDZ_BID_STEP_MS = 1500;

/**
 * 房主侧推进：**一次只走一步**（AI 一次出牌 / 一次提交）。
 *
 * 与旧实现的区别：
 *   旧：while (stepAI(room)) {}  —— 一次调用把能做的全做完再写回
 *   新：单步推进 + 调用方节拍等待，让中间状态可见
 *
 * 返回是否发生了推进。
 */
function pumpHostOnce(room) {
  return REF.stepAI(room);
}

/**
 * 节拍推进：房主每隔 STEP_INTERVAL_MS 让 AI 走一步并写回服务器。
 *
 * 这样每次写回只前进一小步，其他玩家在轮询里就能看到「对方刚出了一张牌」，
 * 而不是一次跳过好几张。轮到真人或阶段结束时就空转等待，**不退出** ——
 * 由 pumpToken 决定它的生命周期。
 *
 * 设计要点（踩过坑，务必保持）：
 *   · 只用 pumpToken 判定"我是否已过期"，**不要**再加 pumpRunning 之类的布尔闸门。
 *     历史 bug：闸门在 finally 里异步复位，而调用方在复位前就检查，导致
 *     「AI 回合到了却再也没人推进」——表现为整局卡死。
 *   · 循环**常驻**：轮到真人时只是 sleep 后重试，而不是 return 退出。
 *     否则「真人出牌 → 轮到 AI」这段没有任何事件会把它重新唤醒（同样是死锁）。
 *   · startPacedPump() 幂等：已启动就什么都不做，避免多循环叠加。
 */
function startPacedPump() {
  if (!session.active || !session.isHost) return;
  if (session.pumpToken > 0) return;       // 已启动，常驻循环自己会继续
  session.pumpToken += 1;
  pacedLoop(session.pumpToken);
}

/** 换局 / 离开 / 重连时停掉常驻节拍循环 */
function stopPacedPump() {
  session.pumpToken += 1;                  // 旧循环下个检查点自动退出
}

async function pacedLoop(token) {
  while (session.active && token === session.pumpToken && session.isHost) {
    if (!session.room) { await sleep(200); continue; }

    // 用副本试探「还有没有 AI 要动」
    const probe = JSON.parse(JSON.stringify(session.room));
    if (!REF.stepAI(probe)) {
      // 轮到真人 / 阶段结束 → 空转等下一次触发（不要退出！）
      await sleep(300);
      continue;
    }

    // ⚠️ 斗地主叫分阶段要放慢节拍：900ms 下两家 AI 叫完只要 1.8 秒，
    //    玩家还没看清「谁叫了几分」就进出牌了（用户反馈「展示叫分时间太短」）。
    const biddingDdz = session.room.mode === 'ddz' && session.room.phase === 'bidding';
    await sleep(biddingDdz ? DDZ_BID_STEP_MS : STEP_INTERVAL_MS);
    if (!session.active || token !== session.pumpToken) return;

    const draft = JSON.parse(JSON.stringify(session.room));
    if (!REF.stepAI(draft)) continue;      // 期间局面已变（真人已行动）→ 重新判断

    const written = await writeHostDraft(draft);
    session.room = written;
    session.view = REF.publicView(written, session.mySeat);
    emit('room');
  }
}

/* ---------- 轮询 ---------- */

function startPolling() {
  session.pollToken += 1;
  // 作废旧节拍循环并允许重新启动：用负数占位，使旧循环的 token 一定不等
  session.pumpToken = 0;         // startPacedPump() 会从 1 重新开始
  // 换局/重连：清空补播队列，避免把上一局的中间帧带进新局
  session.playback = null;
  stopDrain();
  const token = session.pollToken;
  loop(token);
}

async function loop(token) {
  while (session.active && token === session.pollToken) {
    let knownV = session.room ? session.room.v : -1;
    let res;
    try {
      res = await CORE.pollRoom(session.code, knownV, 9000);
    } catch (e) {
      if (e.code === 'NET_NOT_CONFIGURED') { setError('联机服务未配置'); }
      await sleep(2000);
      continue;
    }

    if (token !== session.pollToken || !session.active) return;

    if (res.changed && !res.room) {
      // 房间没了
      session.active = false;
      setError('房间已关闭或过期');
      emit('closed');
      return;
    }

    if (res.changed && res.room) {
      // 只在自己还没有"更新"的权威副本时才采纳服务器的。
      // 否则会和正在跑的节拍循环打架：循环刚写回 v=N，轮询又把旧的 v=N 覆盖回来。
      if (!session.isHost || !session.room || res.room.v > session.room.v) {
        const prev = session.room;
        session.room = res.room;
        // 权威视图 = 服务器最新快照（供逻辑判定用，见 isMyTurn 的注释）。
        session.view = REF.publicView(res.room, session.mySeat);
        // 显示视图 = 补播队列正在演的那一帧（供渲染用）。
        // 注意传的是「上一帧权威快照」而不是「玩家看到的帧」：
        // 队列内部自己维护显示水位，这里只负责把新出现的牌塞进队列。
        enqueuePlayback(prev, res.room, session.mySeat);
        emit('room');
      }

      // 房主的节拍循环是**常驻**的（startPacedPump 幂等，启动一次即可），
      // 它自己会发现「轮到 AI 了」并逐步推进，这里不需要再唤醒。
      if (session.isHost) startPacedPump();
    }
  }
}

/* ---------- 离开 ---------- */

async function leaveRoom() {
  const code = session.code;
  const pid = session.playerId;
  const wasHost = session.isHost;
  session.active = false;
  session.pollToken += 1;
  session.pumpToken += 1;      // 立刻作废常驻的 AI 节拍循环
  stopDrain();                 // 并停掉补播队列的定时器
  session.playback = null;

  try {
    if (code) {
      if (wasHost) {
        await CORE.deleteRoom(code);          // 房主走了就解散
      } else {
        await CORE.updateRoom(code, (draft) => {
          const idx = draft.seats.findIndex((s) => s && s.id === pid);
          if (idx >= 0) draft.seats[idx] = null;
          const count = draft.mode === 'ddz' ? 3 : (draft.seatCount || 4);
          draft.aiSeats = Array.from({ length: count }, (_, i) => i)
            .filter((i) => !draft.seats[i]);
          if (draft.phase !== 'lobby') draft.phase = 'lobby';
          return draft;
        });
      }
    }
  } catch (_) { /* 网络失败也允许本地退出 */ }

  session.code = null;
  session.room = null;
  session.view = null;
  session.mySeat = -1;
  session.isHost = false;
  emit('left');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 便捷读取 ---------- */

const isActive = () => session.active;
// 注意：返回的是「当前该显示的那一帧」。补播期间它可能是队列里的中间帧，
// 而不是服务器最新快照 —— 这正是「一步步看见对方出牌」的关键。
const getView = () => currentView();
const getRoom = () => session.room;
const getMySeat = () => session.mySeat;
const amHost = () => session.isHost;

/** 当前阶段是否轮到我操作 */
/**
 * 逻辑判定一律用**权威视图**（服务器最新快照），绝不能用补播中的中间帧。
 *
 * 补播帧只是"给人看的动画进度"，它比真实局面落后。如果拿它来判断
 * 「轮到我了吗 / 我能出哪些牌」，玩家就会被自己的动画卡住：
 * 明明服务器上已经轮到自己了，界面却说"不是你的回合"。
 * 这个 bug 在补播机制引入后才会出现，务必保持 session.view 与 currentView() 分离。
 */

function isMyTurn() {
  const v = session.view;
  if (!v || v.phase !== 'playing') return false;
  return v.turn === session.mySeat;
}

function isMyBidTurn() {
  const v = session.view;
  if (!v || v.mode !== 'ddz' || v.phase !== 'bidding') return false;
  return v.bidTurn === session.mySeat;
}

/** DDZ 当前可出的牌组 */
function myLegalPlays() {
  const v = session.view;
  if (!v || v.mode !== 'ddz' || v.phase !== 'playing' || v.turn !== session.mySeat) return [];
  const D = REF.ruleOf(v);
  return D.enumeratePlays(v.hands[session.mySeat] || [], v.currentCombo)
    .map((play) => play.cards.slice());
}

/** 我当前可出的牌 */
function myLegalCards() {
  const v = session.view;
  if (!v || v.phase !== 'playing' || v.turn !== session.mySeat) return [];
  if (v.mode === 'ddz') return myLegalPlays().reduce((all, cards) => all.concat(cards), []);
  const R = REF.ruleOf(v);
  return R.legalCards(v.hands[session.mySeat] || [], {
    leadSuit: v.leadSuit,
    isFirstTrick: v.trickIndex === 0,
    mustLeadClub2: v.trickIndex === 0 && v.trickPlays.length === 0,
  });
}

const NET_CLIENT = {
  session, subscribe,
  setPlayerName, ensurePlayerId,
  createRoom, joinRoom, leaveRoom, reseatAI,
  updateSettings, setMode, startGame, nextRound,
  submitSell, submitPass, submitBid, playCards, passPlay, playCard,
  isActive, getView, getRoom, getMySeat, amHost, isMyTurn, isMyBidTurn,
  myLegalCards, myLegalPlays,
  setError,
  // 调试 / 测试用：节拍推进相关
  startPacedPump, STEP_INTERVAL_MS,
  // 调试 / 测试用：补播队列相关
  currentView, trickCursor, intermediateFrames, PLAYBACK_MS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = NET_CLIENT;
if (root && typeof window !== 'undefined') root.NET_CLIENT = NET_CLIENT;

})(typeof window !== 'undefined' ? window : this);
