/* ============================================================
 * werewolf.js —— 狼人杀（联机专属 · 对话模式）规则与可见性工具
 *
 * 与 hearts / gongzhu / ddz 不同：本模式**没有牌面、没有出牌循环**，
 * 全部交互就是一个「带私密频道的对话框」。因此这里不放牌型算法，
 * 只放两件纯逻辑：
 *   ① 角色抽取（配置 → 洗牌 → 分配到座位）
 *   ② 消息可见性判定（谁能看到哪条消息）
 *
 * ⚠️ 可见性判定必须放在**裁判端**（net-referee 的 publicView）调用：
 *     若只在前端隐藏，玩家 F12 就能看到别人的角色和私密消息。
 *     本文件保持无 DOM、无状态，浏览器与 Node 都能加载（供单测）。
 * ============================================================ */
(function (root) {
'use strict';

/* ---------- 随机数（可注入，便于单测复现） ---------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const rnd = rng || Math.random;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ---------- 角色库 ---------- */

/** 内置角色（key → 名称 / 阵营）。自定义角色不在此表也能用，只要有 name。
 *
 * seePeers = 该角色成员之间**互相知道身份**（狼人夜里互认同伴；
 * 预言家 / 女巫 / 村民彼此不认识）。开启后：
 *   · 同伴的身份对彼此可见（publicView 里揭示）
 *   · 成员可以向「本角色频道」发言，同伴互相看得到（狼人讨论）
 */
const ROLE_LIB = {
  wolf:     { key: 'wolf',     name: '狼人',   camp: 'wolf', seePeers: true },
  seer:     { key: 'seer',     name: '预言家', camp: 'good', seePeers: false },
  witch:    { key: 'witch',    name: '女巫',   camp: 'good', seePeers: false },
  hunter:   { key: 'hunter',   name: '猎人',   camp: 'good', seePeers: false },
  guard:    { key: 'guard',    name: '守卫',   camp: 'good', seePeers: false },
  villager: { key: 'villager', name: '村民',   camp: 'good', seePeers: false },
};

const VILLAGER_KEY = 'villager';
const MOD_ROLE_KEY = '__mod__';        // 主持人不是角色，仅用于展示

/** 默认角色配置（9 人局示例，开局会按实际人数自动补齐/截断） */
const PRESET_CONFIG = [
  { key: 'wolf',     count: 2 },
  { key: 'seer',     count: 1 },
  { key: 'witch',    count: 1 },
  { key: 'hunter',   count: 1 },
  { key: 'villager', count: 2 },
];

function roleByKey(key, fallbackName) {
  const k = String(key || '').trim();
  const base = ROLE_LIB[k];
  if (base) {
    return { key: base.key, name: fallbackName || base.name, camp: base.camp, seePeers: !!base.seePeers };
  }
  return { key: k || 'custom', name: fallbackName || k || '自定义', camp: 'good', seePeers: false };
}

/**
 * 按「玩家人数」推荐一套默认阵容（玩家可自行改）。
 * 阵营比例参考常见面杀配置：狼人约占 1/3，其余为神职 + 村民。
 */
function suggestConfig(playerCount) {
  const n = Math.max(1, parseInt(playerCount, 10) || 1);
  const table = [
    // [玩家数, 狼人, 预言家, 女巫, 猎人, 守卫, 村民]
    [3, 1, 1, 0, 0, 0, 1],
    [4, 1, 1, 1, 0, 0, 1],
    [5, 2, 1, 1, 0, 0, 1],
    [6, 2, 1, 1, 1, 0, 1],
    [7, 2, 1, 1, 1, 0, 2],
    [8, 2, 1, 1, 1, 1, 2],
    [9, 3, 1, 1, 1, 1, 2],
  ];
  let row = table.find((r) => r[0] === n);
  if (!row) row = n > 9
    ? [n, 3, 1, 1, 1, 1, n - 7]
    : table[0];
  // ⚠️ 必须带上 name/camp：只返回 {key,count} 的话，主持人「发给」下拉会
  //    回退显示裸 key（"角色 · wolf"），既难看又会让按名字匹配目标的逻辑落空。
  const mk = (key, count) => {
    const b = roleByKey(key);
    return { key: b.key, name: b.name, camp: b.camp, count };
  };
  const out = [
    mk('wolf', row[1]),
    mk('seer', row[2]),
    mk('witch', row[3]),
    mk('hunter', row[4]),
    mk('guard', row[5]),
    mk('villager', Math.max(0, row[6])),
  ];
  return out.filter((r) => r.count > 0);
}

/** 角色配置 → 角色池（展开成一人一项的数组） */
function expandPool(roleConfig) {
  const cfg = Array.isArray(roleConfig) ? roleConfig : [];
  const pool = [];
  for (const item of cfg) {
    if (!item) continue;
    const n = Math.max(0, parseInt(item.count, 10) || 0);
    const proto = roleByKey(item.key, item.name);
    // ⚠️ seePeers 必须一起带下去：只复制 key/name/camp 的话，分到手上的
    //    角色对象没有互认标志，狼人就永远看不到同伴（同伴互见整体失效）。
    const inherit = (item.seePeers != null) ? !!item.seePeers : !!proto.seePeers;
    for (let i = 0; i < n; i++) {
      pool.push({ key: proto.key, name: proto.name, camp: proto.camp, seePeers: inherit });
    }
  }
  return pool;
}

/**
 * 把角色池调整到正好 n 个：不足补村民，超出截断。
 * ⚠️ 先洗牌再截断，否则被砍掉的永远是配置表末尾的角色（不公平）。
 */
function fitPool(pool, n, rng) {
  // ⚠️ rnd 必须走传入的随机源：写死 Math.random 会让「同种子抽取」不可复现，
  //    联机排查 / 回放就无从下手（_test_werewolf.js 有对应断言）。
  const rnd = rng || Math.random;
  let p = shuffle(pool, rnd);
  let filled = 0, trimmed = 0;
  if (p.length > n) { trimmed = p.length - n; p = p.slice(0, n); }
  else if (p.length < n) {
    filled = n - p.length;
    while (p.length < n) p.push(roleByKey(VILLAGER_KEY));
  }
  return { pool: p, filled, trimmed };
}

/**
 * 抽角色：给「非主持人」的座位随机分配。
 * @param seats      需要分配角色的座位号数组（已排除主持人）
 * @param roleConfig 角色配置 [{key,name?,count}]
 * @param rng        随机源（测试可注入 mulberry32）
 * @returns { assign:{seat:role}, filled, trimmed }
 */
function drawRoles(seats, roleConfig, rng) {
  const list = (Array.isArray(seats) ? seats : []).slice();
  const need = list.length;
  const fitted = fitPool(expandPool(roleConfig), need, rng);
  const pool = shuffle(fitted.pool, rng);
  const assign = {};
  list.forEach((s, i) => { assign[s] = pool[i] || null; });
  return { assign, filled: fitted.filled, trimmed: fitted.trimmed };
}

/* ---------- 消息可见性 ---------- */

/**
 * 消息目标（to）的四种形态：
 *   { kind:'all'  }              全体
 *   { kind:'role', role:'wolf' } 某个角色的所有人（如「狼人请睁眼」）
 *   { kind:'seat', seat:2 }      指定玩家
 *   { kind:'mod'  }              私聊主持人（狼人报刀 / 预言家报查验）
 */

function canSee(msg, viewerSeat, ctx) {
  if (!msg) return false;
  const c = ctx || {};
  const mod = (c.moderatorSeat == null ? -1 : c.moderatorSeat);
  if (viewerSeat === mod) return true;                  // 主持人：全场可见
  if (msg.from === viewerSeat) return true;             // 自己发的始终可见
  const to = msg.to || { kind: 'all' };
  if (to.kind === 'all') return true;                   // 全体消息
  if (to.kind === 'seat') return to.seat === viewerSeat;
  if (to.kind === 'role') {
    const r = (c.roles || [])[viewerSeat];
    return !!r && r.key === to.role;                    // 只有该角色的人看得到
  }
  return false;   // kind==='mod'：只有主持人与发送者可见（上面两条已放行）
}

/** 按可见性裁剪消息列表（裁判下发视图时调用） */
function visibleMessages(messages, viewerSeat, ctx) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((m) => canSee(m, viewerSeat, ctx));
}

/** 目标的展示文案（用于消息气泡上的「发给：狼人」标签） */
function targetLabel(to, ctx) {
  const c = ctx || {};
  const t = to || { kind: 'all' };
  if (t.kind === 'all') return '全体';
  if (t.kind === 'mod') return '主持人（私密）';
  if (t.kind === 'role') {
    const found = (c.roleConfig || []).find((r) => r && r.key === t.role);
    if (found && found.name) return found.name;
    const lib = ROLE_LIB[t.role];
    return (lib && lib.name) || t.role || '未知角色';
  }
  if (t.kind === 'seat') {
    const nm = (c.seatNames || [])[t.seat];
    return nm ? `${nm}（${t.seat + 1} 号）` : `${t.seat + 1} 号玩家`;
  }
  return '全体';
}

/* ---------- 同伴可见性 ---------- */

/** 与我同角色的同伴座位（只有我的角色 seePeers=true 时才有，如狼人互认同伴） */
function peerSeats(roles, mySeat) {
  const list = roles || [];
  const me = list[mySeat];
  if (!me || !me.seePeers) return [];
  const out = [];
  list.forEach((r, i) => { if (r && r.key === me.key && i !== mySeat) out.push(i); });
  return out;
}

/** 我能否看到 targetSeat 的身份：本人 / 已公开 / 同角色且该角色互认 */
function canSeeRole(roles, viewerSeat, targetSeat) {
  const list = roles || [];
  const target = list[targetSeat];
  if (!target) return false;
  if (viewerSeat === targetSeat) return true;
  const me = list[viewerSeat];
  if (me && me.seePeers && me.key === target.key) return true;
  return false;
}

/* ---------- 投票 ---------- */

/** 计票：各选项得票、最高票、是否平票、总票数 */
function tallyVotes(vote) {
  const v = vote || {};
  const opts = Array.isArray(v.options) ? v.options : [];
  const ballots = v.ballots || {};
  const counts = {};
  opts.forEach((o) => { counts[o] = 0; });
  Object.keys(ballots).forEach((voter) => {
    const t = ballots[voter];
    if (t == null) return;
    if (counts[t] == null) counts[t] = 0;
    counts[t] += 1;
  });
  const entries = Object.keys(counts).map((k) => ({ seat: parseInt(k, 10), count: counts[k] }));
  entries.sort((a, b) => b.count - a.count);
  const top = entries.length ? entries[0] : null;
  const hasVote = !!(top && top.count > 0);
  const tied = hasVote ? entries.filter((e) => e.count === top.count) : [];
  return {
    counts: entries,
    top: hasVote ? top : null,
    tie: hasVote && tied.length > 1,
    tied: hasVote ? tied : [],
    total: Object.keys(ballots).length,
  };
}

/* ---------- 主持人快捷口令 ---------- */

/**
 * 主持人快捷口令。
 *
 * 每个口令有三层语义（对应主持人的真实操作节奏）：
 *   · phase —— 自动切昼夜（「天黑请闭眼」入夜，「天亮了…」天亮）
 *   · to    —— **这一句发给谁**：'all' = 公开；角色 key = 只该群体可见
 *   · focus —— **说完之后把「发给」下拉切到哪**：
 *              'wolf' = 切到狼人（接下来私密沟通）；'all' = 切回全体
 *
 * 所以「狼人请睁眼」是**公开喊话**（全场都听见），但说完焦点自动落到狼人，
 * 主持人接下来的话就只进狼人频道；「狼人请闭眼」再把它切回全体。
 */

/** 与角色无关的全场口令（固定头尾） */
const BASE_PHRASES = [
  { text: '天黑请闭眼', phase: 'night', to: 'all' },
  { text: '天亮了，请所有人睁眼', phase: 'day', to: 'all', focus: 'all' },
  { text: '请出局玩家发表遗言', to: 'all' },
  { text: '现在自由发言，请依次表态', to: 'all' },
];

/** 内置角色的专属行动口令（自定义角色没有固定行动，只给睁眼/闭眼） */
const ROLE_ACTIONS = {
  wolf: [{ text: '狼人请确认今晚要袭击的玩家', to: 'wolf' }],
  seer: [{ text: '预言家请指出今晚要查验的玩家', to: 'seer' }],
};

/**
 * 按当前角色配置生成口令列表。
 *
 * ⚠️ 每个非村民角色都会自动生成「X请睁眼 / X请闭眼」一对 ——
 *     手动新增的自定义角色也能被主持流程覆盖；村民不参与夜晚，不加。
 *     生成顺序按角色配置排列，正好就是主持人的走场顺序。
 */
function buildPhrases(roleConfig) {
  const cfg = Array.isArray(roleConfig) ? roleConfig : [];
  const out = [BASE_PHRASES[0]];                       // 天黑请闭眼
  cfg.forEach((r) => {
    if (!r || !r.key) return;
    if (r.key === VILLAGER_KEY) return;                // 村民不加
    const nm = r.name || (ROLE_LIB[r.key] ? ROLE_LIB[r.key].name : r.key);
    out.push({ text: `${nm}请睁眼`, to: 'all', focus: r.key });
    (ROLE_ACTIONS[r.key] || []).forEach((p) => out.push(p));
    out.push({ text: `${nm}请闭眼`, to: 'all', focus: 'all' });
  });
  out.push(BASE_PHRASES[1], BASE_PHRASES[2], BASE_PHRASES[3]);
  return out;
}

/** 默认口令表（没有角色配置时的兜底） */
const PHRASES = buildPhrases(PRESET_CONFIG);

/** 取口令文案（兼容旧的字符串写法） */
function phraseText(p) { return (typeof p === 'string') ? p : (p && p.text) || ''; }

/** 取口令附带的阶段切换（没有则返回 null） */
function phrasePhase(p) {
  const ph = (p && p.phase) || null;
  return (ph === 'night' || ph === 'day') ? ph : null;
}

/** 这一句发给谁：'all' = 公开；其余为角色 key（只该群体可见） */
function phraseTo(p) {
  if (!p || typeof p === 'string') return 'all';
  const t = p.to || 'all';
  return (t === 'all' || !t) ? 'all' : String(t);
}

/** 说完后把「发给」下拉切到哪：'all' | 角色 key | null（null = 不动） */
function phraseFocus(p) {
  if (!p || typeof p === 'string') return null;
  const f = p.focus;
  if (!f) return null;
  return String(f);
}

/** 界面上给口令挂的角标，说明它会自动做什么。
 *  roleConfig 可选：自定义角色不在内置库里，必须从配置里解析名字，
 *  否则角标会显示裸 key（如"之后只发angel"）。 */
function phraseHint(p, roleConfig) {
  if (!p || typeof p === 'string') return '';
  if (p.phase === 'night') return '自动入夜';
  if (p.phase === 'day') return '自动天亮';
  const nm = (k) => {
    const cfg = (Array.isArray(roleConfig) ? roleConfig : [])
      .find((r) => r && r.key === k);
    if (cfg && cfg.name) return cfg.name;
    const r = ROLE_LIB[k];
    return r ? r.name : k;
  };
  if (p.focus && p.focus !== 'all') return `之后只发${nm(p.focus)}`;
  if (p.focus === 'all') return '切回全体';
  if (p.to && p.to !== 'all') return `只${nm(p.to)}可见`;
  return '';
}

const WEREWOLF = {
  ROLE_LIB, PRESET_CONFIG, VILLAGER_KEY, MOD_ROLE_KEY, PHRASES,
  mulberry32, shuffle,
  roleByKey, expandPool, fitPool, drawRoles, suggestConfig,
  BASE_PHRASES, ROLE_ACTIONS, buildPhrases,
  phraseText, phrasePhase, phraseTo, phraseFocus, phraseHint,
  canSee, visibleMessages, targetLabel,
  peerSeats, canSeeRole, tallyVotes,
};

if (typeof module !== 'undefined' && module.exports) module.exports = WEREWOLF;
if (root && typeof window !== 'undefined') root.WEREWOLF = WEREWOLF;

})(typeof window !== 'undefined' ? window : this);
