/* ============================================================
 * 红心大战 / 拱猪 · 应用层（状态机 + 渲染 + 交互）
 * 包在 IIFE 内，避免顶层标识符污染全局脚本作用域。
 *
 * 两套玩法共用同一张牌桌：顶栏 #modeSeg 切换 state.mode，
 * 所有的规则访问都走 rule() —— 它返回当前生效的规则模块
 * （HEARTS 或 GONGZHU），并同步切换 AI 侧的规则（setRules）。
 * 两套规则的分差：
 *   - 红心大战：collected 是「收下的罚分累加值」，settleRound(number[])
 *   - 拱猪：    collected 同样是累加值（用于侧栏），但结算必须用
 *               「每家收到的牌面数组」，因为要判满红、亮牌、变压器
 * ============================================================ */
(function () {
'use strict';

const HEARTS = window.HEARTS;
const GONGZHU = window.GONGZHU;
const { HumanPlayer, AIPlayer, DIFFICULTY, setRules } = window.HEARTS_PLAYERS;

const RULES_BY_MODE = { hearts: HEARTS, gongzhu: GONGZHU, ddz: window.DDZ };
/* 斗地主规则模块。刻意用固定引用而不是走 H（= rule()）：
 * H 在斗地主模式下指向的正是 DDZ，但很多地方（如牌面渲染）需要在
 * 「当前不是斗地主模式」时也能安全判断，写死引用更不容易出错。 */
const D = window.DDZ;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 花色矢量图形 ----------
 * 梅花按参考图重绘（12×16 参考像素图等比映射到 24×24 viewBox）：
 *   - 三个饱满圆瓣：顶部一瓣居中偏高，左右两瓣略低且更外扩
 *   - 三瓣交汇处留出凹槽，形成清晰的三叶剪影
 *   - 瓣下收出一段细颈，再接一个外展的梯形短脚（参考图底部特征）
 * 这条 path 在 14px 小尺寸下仍能辨出"三瓣 + 短脚"的梅花轮廓。
 */
const SUIT_PATHS = {
  H: 'M12 21.2C12 21.2 3.2 14.6 3.2 9.1 3.2 6 5.6 3.6 8.4 3.6c2 0 3.1 1.1 3.6 1.9.5-.8 1.6-1.9 3.6-1.9 2.8 0 5.2 2.4 5.2 5.5 0 5.5-8.8 12.1-8.8 12.1z',
  D: 'M12 2.4L20.4 12 12 21.6 3.6 12z',
  S: 'M12 2.6c3.6 3.6 8.4 6.2 8.4 10.3 0 2.6-2 4.3-4.2 4.3-1 0-1.9-.3-2.6-.9.3 1.7 1.2 3 2.9 4H7.5c1.7-1 2.6-2.3 2.9-4-.7.6-1.6.9-2.6.9-2.2 0-4.2-1.7-4.2-4.3C3.6 8.8 8.4 6.2 12 2.6z',
  // 三圆瓣 + 细颈 + 外展梯形脚（对齐参考图）
  C: 'M12 2.4 C14.4 2.4 16.2 4.2 16.2 6.5 C16.2 7.4 15.9 8.3 15.4 9 C16.1 8.6 17 8.4 17.9 8.4 C20.2 8.4 21.9 10.1 21.9 12.3 C21.9 14.5 20.1 16.2 18 16.2 C16.7 16.2 15.6 15.6 14.8 14.6 L15.1 17.3 L16.8 17.3 L16.8 19.9 L7.2 19.9 L7.2 17.3 L8.9 17.3 L9.2 14.6 C8.4 15.6 7.3 16.2 6 16.2 C3.9 16.2 2.1 14.5 2.1 12.3 C2.1 10.1 3.8 8.4 6.1 8.4 C7 8.4 7.9 8.6 8.6 9 C8.1 8.3 7.8 7.4 7.8 6.5 C7.8 4.2 9.6 2.4 12 2.4 Z',
};

/* 花色是否为红色。
 * ⚠️ 刻意**不走 H**（= rule()）：斗地主模式下调 rule() 拿到的是 DDZ 模块，
 *    它不导出 SUIT_IS_RED，`H.SUIT_IS_RED[suit]` 会直接抛 TypeError。
 *    三套玩法的花色代号统一是 C/D/H/S，共用这一张表就够了。 */
const RED_SUIT = { C: false, D: true, S: false, H: true };

function suitSvg(suit, cls = '') {
  return `<svg class="card-suit-sm ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${SUIT_PATHS[suit]}" fill="currentColor"/></svg>`;
}

function suitSvgBig(suit) {
  return `<svg class="card-suit-big" viewBox="0 0 24 24" aria-hidden="true"><path d="${SUIT_PATHS[suit]}" fill="currentColor"/></svg>`;
}

/* ---------- 生成一张牌的 DOM ----------
 * 版面（按需求调整）：
 *   左上角：点数在上、花色紧贴其下 —— 数字位于最左上角
 *   右下角：反向对称的角标
 *   中央：一个略小、不挤角标的花色图形
 */
function cardEl(card, { playable, picked, blocked, waiting, sold } = {}) {
  // 只有斗地主模式才使用 DDZ 的牌面解析；否则普通牌会被误判为 DDZ 牌，
  // 导致红心/方块等原有模式失去正确的花色颜色。
  const ddzCard = state.mode === 'ddz' && D && D.isCard(card);
  const suit = ddzCard ? D.suitOf(card) : H.suitOf(card);
  const rank = ddzCard ? D.rankOf(card) : H.rankOf(card);
  const joker = ddzCard && D.isJoker(card);
  const el = document.createElement('div');
  // 大小王没有花色，单独走 .joker 版式；其余按「红/黑」着色。
  el.className = 'card ' + (joker ? 'joker' : (RED_SUIT[suit] ? 'red' : 'black'));
  if (playable) el.classList.add('playable');
  if (picked) el.classList.add('picked');
  if (blocked) el.classList.add('blocked');
  if (waiting) el.classList.add('waiting');
  if (sold) el.classList.add('is-sold');
  el.dataset.card = card;
  if (joker) {
    const label = card === D.SJOKER ? '小王' : '大王';
    el.innerHTML = `<span class="joker-label">${label}</span><span class="joker-mark">王</span>`;
  } else {
    el.innerHTML =
      `<div class="card-corner tl">` +
        `<span class="card-rank">${rank}</span>${suitSvg(suit)}` +
      `</div>` +
      suitSvgBig(suit) +
      `<div class="card-corner br">` +
        `<span class="card-rank">${rank}</span>${suitSvg(suit)}` +
      `</div>`;
  }
  return el;
}

/* ============================================================
 * 游戏状态
 * ============================================================ */
const state = {
  mode: 'hearts',       // 'hearts' | 'gongzhu' | 'ddz'
  players: [],
  landlord: -1,
  roles: [],
  bidTurn: -1,
  currentBid: 0,
  currentCombo: null,
  lastPlay: null,
  bottom: [],
  moveSeq: 0,
  bombCount: 0,
  hasRocket: false,
  selectedPlay: [],
  /* ---- 斗地主专用（单机与联机共用同一份形状）----
   * 单机由本地循环推进；联机由 syncStateFromView 从房间快照灌进来。 */
  turn: -1,             // 该谁出牌（本地座位号）
  bids: [],             // 各家叫分：null = 未叫，0 = 不叫，1~3 = 分数
  bidCount: 0,          // 本轮已叫分家数
  highestBidder: -1,
  baseBid: 1,           // 定地主时锁定的底分
  passCount: 0,         // 连续「不出」家数，满 2 回到 lastLeadSeat
  lastLeadSeat: -1,
  redealCount: 0,       // 三家都不叫导致的重新发牌次数
  targetScore: 100,     // 斗地主终局线
  lastDeltas: [0, 0, 0],
  scores: [0, 0, 0, 0],
  round: 0,
  phase: 'idle',        // idle | selling | passing | playing | roundEnd | gameEnd
  passDirection: 'none',
  trickIndex: 0,
  trickPlays: [],
  leadSuit: null,
  leader: 0,
  collected: [0, 0, 0, 0],      // 每家本局已收的「分数累加值」（侧栏展示用）
  collectedCards: [[], [], [], []], // 每家本局收到的牌（拱猪结算必需）
  sold: [],                     // 本局亮出的牌（牌码数组，规则引擎读取）
  soldBy: {},                   // 亮牌 → 座位号（UI 展示「谁亮的」，引擎不依赖）
  difficulty: 'normal',
  settings: {
    moonSelf: true,        // true=自己 -26；false=其他三家 +26
    passHearts: true,      // 红心大战：是否启用传牌
    delay: true,
    sell: true,            // 拱猪：是否启用亮牌环节
    threshold: -1000,      // 拱猪：终局分数阈值
  },
  selectedPass: [],
  selectedSell: [],
  busy: false,
  paused: false,
};

/**
 * 对局循环的代际标记（第 8 轮引入，第 9 轮补齐调用点）。
 *
 * playLoop / playTrick 都是 async，await 期间交出控制权。若旧循环还没结束
 * 就触发了新一轮（点「新的一局」、切模式），两个循环会同时推进同一份 state，
 * 表现为 "Cannot read properties of undefined (reading 'hand'/'player')" 且牌局错乱。
 *
 * 所有 await 返回后都校验 `myRun !== runId` → 过期循环安静退出。
 *
 * ⚠️ **每一个会清空 / 重建牌桌的入口都必须 runId++**，否则在途循环不会被作废：
 *      · startRound()  —— 新的一局
 *      · beginPlay()   —— 开始出牌
 *      · setMode()     —— 切换模式（清空 players，第 9 轮补上）
 *
 * ⚠️ 声明必须放在这里（state 之后、所有使用者之前）。
 *    `let` 存在暂时性死区，若声明在使用点之后，早期调用会抛 TDZ 错误。
 */
let runId = 0;

/* 回到主页只暂停当前循环，不丢弃牌局；继续时原地恢复。 */
async function waitForResume(myRun) {
  while (state.paused && myRun === runId) await sleep(80);
  return myRun === runId && !state.paused;
}

/* 传牌开关按模式分开存：
 *   红心大战默认传牌（标准规则），拱猪**没有传牌规则**。
 *   分开关的好处是「切回红心大战」时能恢复原来的勾选，而不是被拱猪覆盖成关。 */
const passEnabled = () => (isGongzhu() || isDdz() ? false : state.settings.passHearts !== false);

/* 当前生效的规则模块。所有规则调用都通过它取，写死 H 就会串规则。 */
function rule() { return RULES_BY_MODE[state.mode] || HEARTS; }
const isGongzhu = () => state.mode === 'gongzhu';
const isDdz = () => state.mode === 'ddz';

/* 兼容层：代码里大量使用 H.xxx 读取规则常量与函数。
 * 用 Proxy 把 H 的读取转发到 rule()，切模式后无需改任何调用点。
 * getOwnPropertyDescriptor / has 挂钩是为了让 Object.keys(H) 之类的
 * 反射调用也能正常工作（少数工具函数会用到）。 */
const H = new Proxy({}, {
  get(_t, k) { return rule()[k]; },
  has(_t, k) { return k in rule(); },
  ownKeys() { return Reflect.ownKeys(rule()); },
  getOwnPropertyDescriptor(_t, k) {
    const d = Object.getOwnPropertyDescriptor(rule(), k);
    if (d) d.configurable = true;
    return d;
  },
});

/** 清空斗地主专用状态。切模式 / 退出对局时必须调 ——
 *  这些字段在红心 / 拱猪路径里没人维护，留着会污染下一次进入斗地主时的判断
 *  （例如残留的 turn 会让「该谁出牌」一开始就指向别人）。 */
function resetDdzState() {
  state.landlord = -1;
  state.roles = [];
  state.bidTurn = -1;
  state.currentBid = 0;
  state.currentCombo = null;
  state.lastPlay = null;
  state.bottom = [];
  state.moveSeq = 0;
  state.bombCount = 0;
  state.hasRocket = false;
  state.selectedPlay = [];
  state.turn = -1;
  state.bids = [];
  state.bidCount = 0;
  state.highestBidder = -1;
  state.baseBid = 1;
  state.passCount = 0;
  state.lastLeadSeat = -1;
  state.redealCount = 0;
  state.lastDeltas = [0, 0, 0];
  ddzLegalCache = { sig: '', cards: [] };
  hideDdzDealLayer();
}

/** 切换玩法模式。
 * ⚠️ 只切模式与文案，**不自动开局** —— 玩家必须点「新的一局」才开始。
 *    否则误点一下顶栏就把进行中的牌局冲掉了。 */
function setMode(key) {
  const k = RULES_BY_MODE[key] ? key : 'hearts';
  if (state.mode === k) return;
  state.mode = k;
  if (k !== 'ddz') setRules(k);

  // 上一局的残留（传牌窗 / 亮牌窗 / 叫分窗 / 底牌窗 / 结算窗）必须关掉，否则会盖在新桌面上
  $('ovPass').hidden = true;
  $('ovSell').hidden = true;
  $('ovBid').hidden = true;
  $('ovBottom').hidden = true;
  $('ovSettle').hidden = true;
  $('ovResult').hidden = true;

  // 换模式等于换玩法：清空牌桌，回到「未开局」状态
  //
  // ⚠️ 必须先递增 runId，作废所有**在途**的对局循环。
  //    setMode 会把 state.players 清空为 []，若此时旧循环正好卡在
  //    await（AI 思考 / 玩家出牌）上，它醒来后仍会去读
  //    state.players[seat].hand → undefined.hand → 抛 TypeError，
  //    并可能把过期状态写回新牌桌。
  //    只靠 playTrick 里的存在性判断是"兜底"，代际作废才是"根治"。
  runId++;
  resolveDdzWait(null);        // 斗地主循环可能正挂在叫分 / 出牌上，立刻解除
  state.players = [];
  state.scores = [0, 0, 0, 0];
  state.collected = [0, 0, 0, 0];
  state.collectedCards = [[], [], [], []];
  resetDdzState();
  state.round = 0;
  state.trickIndex = 0;
  state.trickPlays = [];
  state.leadSuit = null;
  state.sold = [];
  state.soldBy = {};
  state.selectedPass = [];
  state.selectedSell = [];
  state.busy = false;
  state.paused = false;
  state.phase = 'idle';
  resetTrickRender();

  applyModeChrome();
  renderModeChrome(k);
  render();

  const name = MODE_NAME[k];
  $('logList').innerHTML = `<li>已切换到「${name}」，点「开始新的一局」开始。</li>`;
  setHint(`已切换到「${name}」· 点「开始新的一局」开始发牌。`);
}

/** 顶栏 / 主页模式卡 / 规则面板等「与模式相关的外观」统一在这里刷新 */
function renderModeChrome(k = state.mode) {
  document.body.dataset.mode = k;
  document.title = k === 'ddz' ? '斗地主 · 三人联机' : (k === 'gongzhu' ? '拱猪 · 红心大战' : '红心大战 · 拱猪');

  [...$('homeModes').children].forEach((b) => {
    const on = b.dataset.mode === k;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });

  const chip = $('gameModeChip');
  if (chip) chip.querySelector('b').textContent = MODE_NAME[k];

  renderGameChrome();
  syncSettingsUI();
}

/** 游戏页顶栏的局数 / 传牌方向 */
function renderGameChrome() {
  const t = $('gameRoundText');
  if (!t) return;
  if (!state.round || state.phase === 'idle') { t.textContent = '未开局'; return; }
  if (isDdz()) {
    const stage = state.phase === 'bidding' ? '叫分抢地主'
      : (state.phase === 'playing' ? '出牌中' : '本局结束');
    t.textContent = `第 ${state.round} 局 · ${stage}`;
    return;
  }
  const dir = isGongzhu() ? '不传牌' : (H.PASS_LABEL[state.passDirection] || '');
  t.textContent = `第 ${state.round} 局` + (dir ? ` · ${dir}` : '');
}

/** 按模式调整文案与显隐（不重开局时也调用） */
function applyModeChrome() {
  const gz = isGongzhu();
  const ddz = isDdz();
  // 主页对局选项卡里的「拱猪专属」块（亮牌 / 终局分数，2026-09-26 从设置面板搬来）
  $('gzHomeOpts').hidden = !gz;
  $('rowSell').hidden = !gz;
  $('rowMoonOpt').hidden = gz || ddz;
  $('settingsMoonRow').hidden = gz || ddz;
  $('rowHearts').hidden = ddz;
  $('rowQueen').hidden = ddz;
  $('rowExtra').hidden = ddz;
  $('rowPass').hidden = gz || ddz;
  // 传牌只有红心大战有：拱猪 / 斗地主下开关整行收掉（不做置灰提示）
  $('rowPassOpt').hidden = gz || ddz;
  // 设置面板的只读镜像：满贯 / 传牌仅红心；亮牌 / 终局分数仅拱猪
  $('settingsPassRow').hidden = gz || ddz;
  $('settingsSellRow').hidden = !gz;
  $('settingsThresholdRow').hidden = !gz;
  // 底牌入口按钮：只有斗地主且已定地主时才出现（renderDdzBottom 会再校准一次）
  const bottomBtn = $('btnShowBottom');
  if (bottomBtn && !ddz) bottomBtn.hidden = true;
  $('ddzActions').hidden = !ddz;

  if (ddz) {
    $('kHearts').textContent = '地主';
    $('kQueen').textContent = '当前叫分';
    $('kExtra').textContent = '倍数';
    $('scorePanelSub').textContent = '叫分 × 炸弹倍数';
  } else if (gz) {
    $('kHearts').textContent = '已收红桃';
    $('kQueen').textContent = '猪 / 羊';
    $('kExtra').textContent = '变压器';
    $('scorePanelSub').textContent = `满 ${state.settings.threshold} 分终局`;
  } else {
    $('kHearts').textContent = '红心已出';
    $('kQueen').textContent = '黑桃 Q';
    $('kExtra').textContent = '满贯处理';
    $('scorePanelSub').textContent = '满 100 分终局';
  }

  $('rulesTitle').textContent = ddz ? '斗地主规则' : (gz ? '拱猪规则' : '红心大战规则');
  $('rulesLead').textContent = ddz
    ? '叫分抢地主，地主拿 3 张底牌后先出完牌者所在方获胜。可直接开局对两个 AI，也可联机三人同桌。'
    : (gz ? '四人各 13 张牌，不传牌；目标是少收负分，多收正分。' : '四人各 13 张牌，目标是少收罚分。');
  $('opsFlow').textContent = ddz
    ? '叫分阶段选择不叫或 1 / 2 / 3 分；出牌时可多选牌组后提交。'
    : (gz ? '拱猪开局可亮牌；不选即不亮。' : '红心大战传牌阶段选 3 张确认传出。');
  $('rulesHearts').hidden = gz || ddz;
  $('rulesGongzhu').hidden = !gz;
  $('rulesDdz').hidden = !ddz;
  $('scoreHearts').hidden = gz || ddz;
  $('scoreGongzhu').hidden = !gz;
  $('scoreDdz').hidden = !ddz;

  $('modeTipTitle').textContent = ddz ? '斗地主 · 判胜' : (gz ? '拱猪 · 判胜' : '红心大战 · 判胜');
  $('modeTipBody').textContent = ddz
    ? '斗地主：叫分后地主拿 3 张底牌，地主或农民一方先出完牌即结算。在主页点「开始新的一局」可直接对两个 AI 开打，也可以在主页下方建房 / 加入房间联机三人同桌。'
    : (gz ? `任一家累计分 ≤ ${state.settings.threshold} 即终局，累计分最高者获胜。详细规则见「帮助」。` : '任一玩家累计达到 100 分即终局，总分最低者获胜。详细规则见「帮助」。');

  renderGameChrome();
  syncSettingsUI();
}

/* ============================================================
 * 渲染
 * ============================================================ */
const SEAT_LABEL = ['你', 'AI 西', 'AI 北', 'AI 东'];

/* AI 补位的名字，按**联机座位号**索引（0=房主位，1/2/3 依次）。
   刻意独立于 SEAT_LABEL：联机下座位是轮转的，若按本地座位取名，
   同一个 AI 在不同玩家的设备上会叫不同名字。详见 syncStateFromView。 */
const AI_NAME = ['你', 'AI 西', 'AI 北', 'AI 东'];

/* ============================================================
 * 本机持久化：玩家昵称 + 最近战绩
 * ------------------------------------------------------------
 * 主页的「玩家卡」与「最近战绩」都写 localStorage。
 * 隐私模式 / 禁用存储时会抛异常，全部兜住并退化为内存态。
 * ============================================================ */
const LS_NAME = 'hearts.playerName';
const LS_HISTORY = 'hearts.history';
const HISTORY_MAX = 30;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }

function loadPlayerName() {
  const v = (lsGet(LS_NAME) || '').trim();
  return v || '玩家昵称';
}
function loadHistory() {
  try {
    const arr = JSON.parse(lsGet(LS_HISTORY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function pushHistory(rec) {
  const arr = loadHistory();
  arr.unshift(rec);
  lsSet(LS_HISTORY, JSON.stringify(arr.slice(0, HISTORY_MAX)));
  renderHistory();
}
function clearHistory() { lsSet(LS_HISTORY, '[]'); renderHistory(); }

const MODE_NAME = { hearts: '红心大战', gongzhu: '拱猪', ddz: '斗地主' };

function historyRowHTML(rec) {
  const fmt = (v) => (v > 0 ? '+' + v : String(v));
  const rankCls = rec.rank === 1 ? 'pos' : (rec.rank === 4 ? 'neg' : '');
  return `<div class="history-row">` +
      `<span class="h-l">` +
        `<b>${MODE_NAME[rec.mode] || '对局'} · 第 ${rec.round} 局</b>` +
        `<i>第 ${rec.rank} 名 · ${DIFFICULTY[rec.diff] ? DIFFICULTY[rec.diff].label : '熟练'}` +
          `${rec.final ? ' · 终局' : ''}</i>` +
      `</span>` +
      `<span class="h-r ${rankCls}">${fmt(rec.score)}</span>` +
    `</div>`;
}

function renderHistory() {
  const arr = loadHistory();
  const empty = '<p class="history-empty">还没有战绩。打完一局本局结算后，这里会自动记录。</p>';
  const html = arr.length ? arr.slice(0, 4).map(historyRowHTML).join('') : empty;
  const full = arr.length ? arr.map(historyRowHTML).join('') : empty;
  const a = $('historyList'); if (a) a.innerHTML = html;
  const b = $('historyListFull'); if (b) b.innerHTML = full;
}

/* ============================================================
 * 主屏路由 / 面板 / 提示条
 * ------------------------------------------------------------
 * 交互流程：主页完成全部配置 → 点「开始新的一局」进入游戏页。
 * 说明性内容一律走面板层，牌桌上不留任何解释文字。
 * ============================================================ */
const PANEL_IDS = { info: 'panelInfo', settings: 'panelSettings', rules: 'panelRules', history: 'panelHistory' };
const TAB_ITEMS = ['play', 'rules', 'settings', 'history'];

function showScreen(name) {
  const screens = {
    home: $('screenHome'),
    game: $('screenGame'),
    lobby: $('screenLobby'),
    join: $('screenJoin'),
  };
  Object.keys(screens).forEach((k) => {
    const el = screens[k];
    if (el) el.hidden = (k !== name);
  });
  document.body.dataset.screen = name;
  // 离开对局屏时把手机端的「隐藏式上边栏」收回默认的收起态
  if (name !== 'game') document.body.classList.remove('topbar-open');
  closePanels();
}

function openPanel(name) {
  closePanels();
  const el = $(PANEL_IDS[name]);
  if (!el) return;
  el.hidden = false;
  $('scrim').hidden = false;
  document.body.dataset.panel = name;
}

function closePanels() {
  Object.keys(PANEL_IDS).forEach((k) => {
    const el = $(PANEL_IDS[k]);
    if (el) el.hidden = true;
  });
  $('scrim').hidden = true;
  document.body.dataset.panel = '';
  syncTabs();
}

/** 移动端底部导航：面板打开时高亮对应项，否则高亮「牌局」 */
function syncTabs() {
  const open = document.body.dataset.panel || 'play';
  [...$('homeTabbar').querySelectorAll('.tab')].forEach((b) => {
    b.classList.toggle('is-on', b.dataset.tab === (open === 'info' ? 'play' : open));
  });
}

/** 规则面板内的分段（规则 / 分值 / 操作） */
function switchRulesTab(name) {
  [...$('rulesTabs').children].forEach((b) => b.classList.toggle('is-on', b.dataset.ptab === name));
  [...document.querySelectorAll('#panelRules .pt-pane')].forEach((p) => {
    p.hidden = p.dataset.pane !== name;
  });
}

/* 状态提示条：手工提示优先，没有手工提示时回落到自动提示（墩况） */
let hintManual = '';
let hintKind = '';
let hintAuto = '';

function renderHintbar() {
  const el = $('hintText');
  if (!el) return;
  el.textContent = hintManual || hintAuto || '准备开始。';
  const bar = $('hintbar');
  if (bar) bar.className = 'hintbar' + (hintKind ? ' ' + hintKind : '');
}
function setAutoHint(text) { hintAuto = text || ''; renderHintbar(); }
function clearManualHint() { hintManual = ''; hintKind = ''; }

function render() {
  renderSeats();
  renderScore();
  renderInfo();
  renderSoldBoard();
  renderHand();
  renderWonCards();
  renderMyRoundScore();
  renderTrick();
  renderGameChrome();
  // 叫分弹窗开着时，弹窗里的「各家叫分」要跟着最新状态刷新 ——
  // 别人（AI / 其他玩家）叫完分，我这边不必等下一次交互就能看到。
  const bidBox = $('ovBid');
  if (bidBox && !bidBox.hidden) renderBidList();
}

function renderSeats() {
  for (let i = 1; i <= 3; i++) {
    // 斗地主三人局：本地只有 1 号位（西）与 2 号位（北）两个对手位，
    // 3 号位没有对应玩家 —— 不跳过的话会留下上一局的名字与分数残影。
    if (isDdz() && i === 3) continue;
    const p = state.players[i];
    if (!p) continue;
    $('name' + i).textContent = SEAT_LABEL[i];
    // 中央出牌位下方的名字也要跟着走 —— 它在 HTML 里只是个占位初值，
    // 不覆写的话联机时会一直显示「AI 西 / AI 北 / AI 东」，与座位卡对不上。
    const slotLabel = $('slotLabel' + i);
    if (slotLabel) slotLabel.textContent = SEAT_LABEL[i];
    // 座位卡只保留「剩几张 / 已收几分」——牌桌上不做信息堆砌。
    // 拆成两个 span，窄屏由 CSS 改成上下两行，避免长句折行。
    const mine = isGongzhu()
      ? H.liveScore(state.collectedCards[i] || [], state.sold || []).total
      : (isDdz() ? (state.scores[i] || 0) : (state.collected[i] || 0));
    const meta = $('meta' + i);
    if (meta) {
      meta.innerHTML = state.phase === 'idle'
        ? '<b>等待发牌</b>'
        : isDdz()
          ? `<b>剩 ${p.handSize} 张</b><i>${state.roles[i] === 'landlord' ? '地主' : '农民'} · ${mine > 0 ? '+' + mine : mine} 分</i>`
          : `<b>剩 ${p.handSize} 张</b><i>已收 ${mine > 0 ? '+' + mine : mine} 分</i>`;
    }

    const tag = $('tag' + i);
    const isActive = isDdz()
      ? (state.phase === 'bidding' && state.bidTurn === i) || (state.phase === 'playing' && activeSeat() === i)
      : (state.phase === 'playing' && state.players[activeSeat()] === p);
    if (isActive) {
      tag.textContent = isDdz() && state.phase === 'bidding' ? '叫分中' : '出牌中';
      tag.classList.add('thinking');
      $('seat' + i).classList.add('active');
    } else {
      // 叫分阶段：把「谁叫了几分 / 谁不叫」直接写在座位卡上。
      // 只记在日志里等于没写 —— 牌桌上日志面板是收起的，玩家看不到 AI 的叫分。
      const bid = (state.bids || [])[i];
      tag.textContent = isDdz() && state.phase === 'bidding'
        ? (bid == null ? '等待叫分' : (bid ? `叫 ${bid} 分` : '不叫'))
        : (isDdz() && state.roles[i] === 'landlord' ? '地主'
          : state.phase === 'playing' ? '等待'
            : state.phase === 'idle' ? '等待' : '出牌');
      tag.classList.remove('thinking');
      $('seat' + i).classList.remove('active');
    }

    // 剩余牌背（新版牌桌用「剩 N 张」文字表达，牌背保持隐藏）
    const mini = $('mini' + i);
    if (mini) {
      const want = p.handSize;
      if (mini.childElementCount !== want) {
        mini.innerHTML = '<div class="mini-back"></div>'.repeat(want);
      }
    }
  }
}

function renderScore() {
  const ddz = isDdz();
  const gz = isGongzhu();
  const rows = [];
  if (ddz) {
    // 三人局：本地只有 0 / 1 / 2 三个座位，第 4 位不存在，不能进计分板
    const order = [0, 1, 2].filter((i) => state.players[i]);
    order.sort((a, b) => (state.scores[b] || 0) - (state.scores[a] || 0));
    for (const i of order) {
      const role = state.roles[i] === 'landlord' ? '地主' : (state.roles[i] ? '农民' : '');
      rows.push(`<tr class="${i === 0 ? 'me' : ''}"><td>${SEAT_LABEL[i]}${role ? ` · ${role}` : ''}</td><td class="score-num">—</td><td class="score-num">${state.scores[i] || 0}</td></tr>`);
    }
    $('scoreBody').innerHTML = rows.join('');
    return;
  }
  for (let i = 0; i < 4; i++) {
    if (!state.players[i]) continue;
    const p = state.players[i];

    // 「本局」列：
    //   拱猪走 liveScore —— 直接把亮牌翻倍、变压器×2 / +50 都算进去，
    //   玩家在局中看到的就是最终会拿到的分数，不必等到结算才知道。
    //   红心大战仍是原始收牌分累加（没有翻倍机制）。
    let cell;
    if (gz) {
      const live = H.liveScore(state.collectedCards[i], state.sold);
      cell = live.total;
    } else {
      cell = state.collected[i] || 0;
    }

    const num = cell > 0 ? '+' + cell : String(cell);

    // 进度条：
    //   拱猪 —— 只给「负分」显示，表示距离出局线（阈值）还有多远。
    //           正分是在赢分，画成"快出局了"会误导，所以不显示。
    //   红心大战 —— 罚分制，低分好，所有人都是向着 100 分跑，
    //               原有行为保持不变。
    let bar = '';
    if (gz) {
      if (p.score < 0) {
        const pct = Math.min(100, (p.score / state.settings.threshold) * 100);
        // 三档配色一律避开绿色 —— 绿色在拱猪里表示正分/安全。
        const tier = pct >= 80 ? ' is-danger' : pct >= 50 ? ' is-warn' : ' is-gz';
        bar = `<div class="score-bar${tier}">` +
              `<span style="width:${pct}%"></span></div>`;
      }
    } else {
      const pct = Math.min(100, Math.max(0, p.score / HEARTS.GAME_OVER_SCORE * 100));
      bar = `<div class="score-bar"><span style="width:${pct}%"></span></div>`;
    }

    rows.push(
      `<tr class="${i === 0 ? 'me' : ''}">` +
        `<td>${SEAT_LABEL[i]}</td>` +
        `<td class="score-num">${num}</td>` +
        `<td class="score-num"><div class="score-cell">` +
          `<span>${p.score}</span>` + bar +
        `</div></td>` +
      `</tr>`
    );
  }
  $('scoreBody').innerHTML = rows.join('');
}

function renderInfo() {
  const ddz = isDdz();
  const gz = isGongzhu();
  if (ddz) {
    $('rowPass').hidden = true;
    $('infoTrick').textContent = `${state.moveSeq || 0} 手`;
    $('infoHearts').textContent = state.landlord >= 0
      ? `${SEAT_LABEL[state.landlord]}（${state.roles[0] === 'landlord' ? '你是地主' : '你是农民'}）`
      : '待定';
    $('infoQueen').textContent = state.currentBid ? `${state.currentBid} 分` : '未叫分';
    const mult = Math.pow(2, (state.bombCount || 0) + (state.hasRocket ? 1 : 0));
    $('infoMoon').textContent = `${mult} 倍${state.hasRocket ? ' · 含王炸' : ''}`;
    $('infoSell').textContent = '斗地主不亮牌';
    return;
  }
  // 拱猪没有传牌规则 → 不显示传牌方向
  $('rowPass').hidden = gz;
  $('infoPass').textContent = gz
    ? '不传牌'
    : (H.PASS_LABEL[state.passDirection] || '—');
  $('infoTrick').textContent = `${state.trickIndex} / 13`;

  if (!gz) {
    $('infoHearts').textContent = (state.heartsPlayed || 0) + ' 张';
    $('infoQueen').textContent = (state.queenTaken && state.queenTakenBy >= 0)
      ? `被 ${SEAT_LABEL[state.queenTakenBy]} 收下`
      : '未出现';
    $('infoMoon').textContent = state.settings.moonSelf ? '自己 −26' : '其他三家 +26';
    return;
  }

  // ---- 拱猪 ----
  // 红桃：已出现张数 / 13
  const heartsShown = state.collectedCards.reduce(
    (n, cards) => n + cards.filter((c) => H.isHeart(c)).length, 0);
  $('infoHearts').textContent = `${heartsShown} / 13 张`;

  // 猪 / 羊：谁收了
  const findHolder = (target) => {
    for (let i = 0; i < 4; i++) {
      if (state.collectedCards[i].includes(target)) return SEAT_LABEL[i];
    }
    return null;
  };
  const pigHolder = findHolder(H.PIG);
  const sheepHolder = findHolder(H.SHEEP);
  const parts = [];
  parts.push(pigHolder ? `猪→${pigHolder}` : '猪未出');
  parts.push(sheepHolder ? `羊→${sheepHolder}` : '羊未出');
  $('infoQueen').textContent = parts.join(' · ');

  // 变压器：说清是「×2」还是「无分改为 +50」——两者含义完全不同，
  // 只写「本局翻倍」会让 0 分的持有者以为翻倍后还是 0。
  const tfHolder = findHolder(H.TRANSFORMER);
  if (!tfHolder) {
    $('infoMoon').textContent = '未出现';
  } else {
    const idx = state.collectedCards.findIndex((cs) => cs.includes(H.TRANSFORMER));
    const live = H.liveScore(state.collectedCards[idx], state.sold);
    $('infoMoon').textContent = live.transformerEmpty
      ? `${tfHolder} · 无分改为 +${H.TRANSFORMER_EMPTY_BONUS}`
      : `${tfHolder} · 分数 ×2`;
  }

  // 已亮牌：把每张亮牌自身的分值也标出来，一眼看出翻倍后是多少
  $('infoSell').textContent = state.sold && state.sold.length
    ? state.sold.map((c) => {
        const base = H.cardPoints(c);
        const detail = base === 0 ? '翻倍' : `${base > 0 ? '+' : ''}${base}→${base * 2 > 0 ? '+' : ''}${base * 2}`;
        return `${H.SELL_LABEL[c] || cardText(c)}（${detail}）`;
      }).join('、')
    : '无';
}

/* ---------- 本局我的扣分提示框 ----------
 * 座位卡与计分板是「四家横向对比」，这个框只回答一个问题：
 * 「我这局到目前为止亏了多少」。数据源与座位卡完全一致（拱猪走
 * liveScore，红心走原始收牌分），把它单独抽出来是为了让玩家不用
 * 在四行里找自己那一行。
 */
function renderMyRoundScore() {
  const box = $('myRoundScore');
  if (!box) return;

  const gz = isGongzhu();
  if (isDdz()) {
    // 斗地主不再用「本局我收下的分」这一行 —— 它占一整行却只说一件事，
    // 手机端尤其浪费。分数看座位卡的「±N 分」与计分面板，身份/叫分在手牌标题行。
    box.hidden = true;
    const roleEl = $('handRole');
    if (roleEl) {
      const role = state.roles[0] === 'landlord' ? '地主' : (state.roles[0] ? '农民' : '');
      if (role) roleEl.textContent = `${role} · 叫分 ${state.currentBid || 0}`;
      else roleEl.textContent = state.phase === 'bidding' ? '叫分中' : '';
      roleEl.classList.toggle('is-landlord', state.roles[0] === 'landlord');
    }
    return;
  }
  const roleEl = $('handRole');
  if (roleEl) { roleEl.textContent = ''; roleEl.classList.remove('is-landlord'); }
  const starting = state.phase === 'idle' || !state.players[0];
  if (starting) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const myCards = (state.collectedCards && state.collectedCards[0]) || [];
  let total = 0;
  let live = null;
  if (gz) {
    live = H.liveScore(myCards, state.sold);
    total = live.total;
  } else {
    total = state.collected[0] || 0;
  }

  const totalEl = $('myRoundTotal');
  const detailEl = $('myRoundDetail');
  totalEl.textContent = total > 0 ? '+' + total : String(total);

  // 颜色语义：两套规则都是「正分=对自己有利」的少数派，
  //   拱猪：正分（已收羊等）绿、负分红；
  //   红心：收分即罚分，所以 >0 是坏事（红），0 才安全。
  const isGood = gz ? total > 0 : total === 0;
  const isBad = gz ? total < 0 : total > 0;
  box.classList.toggle('is-safe', isGood);
  box.classList.toggle('is-zero', gz && total === 0);
  box.classList.toggle('is-bad', isBad);

  // 明细必须和右列总分「对得上账」，否则玩家会以为是 bug：
  //   · 满贯：整段替换为 +400，逐张分与猪羊分全部失效 → 只列这一条
  //   · 满红：红桃整体转为 +200，猪羊仍独立计 → 列「满红 +200」+ 猪/羊
  //   · 普通：逐张列有分的牌
  const chips = [];
  const notes = [];
  const soldSet = new Set(gz ? (state.sold || []) : []);

  const chipOf = (card, label) => {
    const base = H.cardPoints(card);
    const isSold = soldSet.has(card);
    const val = isSold ? base * 2 : base;
    const cls = val > 0 ? ' pos' : '';
    const tag = isSold ? '×2' : '';
    return `<span class="ms-chip${cls}">${label}` +
           `<em>${val > 0 ? '+' + val : val}</em>${tag}</span>`;
  };

  if (gz && live && live.slam) {
    chips.push(`<span class="ms-chip pos">满贯（满红 + 猪 + 羊）` +
               `<em>+${H.GRAND_SLAM_BONUS}</em></span>`);
  } else if (gz && live && live.moon) {
    chips.push(`<span class="ms-chip pos">满红（13 张红桃）` +
               `<em>+${H.MOON_BONUS}</em></span>`);
    // 猪 / 羊在满红里仍然独立计分
    for (const c of [H.PIG, H.SHEEP]) {
      if (myCards.includes(c)) chips.push(chipOf(c, H.SELL_LABEL[c] || cardText(c)));
    }
  } else {
    const scored = myCards
      .filter((c) => H.cardPoints(c) !== 0)
      .map((c) => ({ card: c, base: H.cardPoints(c) }));
    scored.sort((a, b) => Math.abs(b.base) - Math.abs(a.base));
    for (const { card } of scored) {
      chips.push(chipOf(card, (H.SELL_LABEL && H.SELL_LABEL[card]) || cardText(card)));
    }
  }

  // 变压器不直接计分，但会改写总分，必须单独说明
  if (gz && live) {
    if (live.transformerEmpty) {
      notes.push(`<span class="ms-note">含变压器（0 分）· 无失分改记 +${H.TRANSFORMER_EMPTY_BONUS}</span>`);
    } else if (live.doubled) {
      notes.push(`<span class="ms-note">含变压器（0 分）· 本局得分 ${live.base > 0 ? '+' + live.base : live.base} ×2</span>`);
    }
  }

  if (!chips.length && !notes.length) {
    detailEl.innerHTML = '<span class="myscore-empty">本局暂未收到有分牌</span>';
  } else {
    detailEl.innerHTML = chips.join('') + notes.join('');
  }
}

/**
 * 公开亮牌板：把本局所有亮的牌**公示**在牌桌上方，所有人都能看到。
 *
 * 与「已获得的牌」严格区分：
 *   · 亮牌板 = 本局开局时各家的**赌注宣告**（谁亮了什么），全局公开、
 *     固定展示，是「信息」而非「战果」。
 *   · 已获得的牌 = 各家收墩**之后实际收到**的牌，随牌局推进增长。
 * 两者视觉与位置都拉开（顶部横条 vs 各座位下方），避免混淆。
 */
function renderSoldBoard() {
  const board = $('soldBoard');
  const list = $('soldBoardList');
  const sold = state.sold || [];

  // 只在拱猪、且有亮牌时展示（红心大战没有亮牌机制）
  if (!isGongzhu() || !sold.length || state.phase === 'idle') {
    board.hidden = true;
    return;
  }
  board.hidden = false;

  list.innerHTML = sold.map((c) => {
    const who = state.soldBy[c];
    const base = H.cardPoints(c);
    const doubled = base * 2;
    const delta = base === 0
      ? '无分牌'
      : `${base > 0 ? '+' : ''}${base} → ${doubled > 0 ? '+' : ''}${doubled}`;
    const mine = who === 0;
    return `<div class="sold-chip${mine ? ' mine' : ''}">` +
        `<span class="sold-chip-who">${who != null ? SEAT_LABEL[who] : '—'}</span>` +
        `<span class="sold-chip-card ${H.SUIT_IS_RED[H.suitOf(c)] ? 'red' : ''}">` +
          `${H.SELL_LABEL[c] || cardText(c)}</span>` +
        `<span class="sold-chip-delta">${delta}</span>` +
      `</div>`;
  }).join('');
}

/**
 * 「已获得的牌」：展示每家本局**实际收到**的牌。
 *
 * 两个模式都有（拱猪 / 红心大战行为一致），与亮牌板完全分开。
 * 只展示与计分直接相关的牌：拱猪为全部红桃、猪、羊、变压器；
 * 红心大战为全部红桃和黑桃 Q。其余已收牌仍保留在状态中用于结算，
 * 但不在牌桌上展开，避免信息堆叠。
 * 牌面用极小尺寸的只读卡片，角标仍可读。
 */
function renderWonCards() {
  const gz = isGongzhu();
  if (isDdz()) {
    for (let i = 0; i < 4; i++) {
      const box = $('won' + i);
      if (box) { box.hidden = true; box.innerHTML = ''; }
    }
    return;
  }
  const keyCards = (cards) => cards.filter((c) =>
    H.isHeart(c) || (gz
      ? [H.PIG, H.SHEEP, H.TRANSFORMER].includes(c)
      : H.isQueenOfSpades(c)));
  for (let i = 0; i < 4; i++) {
    const box = $('won' + i);
    if (!box) continue;

    // 自己（座位 0）不再展示「已收关键牌」——上方的「本局我收下的分」
    // 提示框已经把本人这一局的得失说得更清楚，再挂一条会重复。
    // 其余三家的展示保持不变。
    if (i === 0) {
      box.hidden = true;
      box.innerHTML = '';
      continue;
    }

    const cards = (state.collectedCards && state.collectedCards[i]) || [];
    const visibleCards = keyCards(cards);

    if (!state.players[i] || state.phase === 'idle' || !visibleCards.length) {
      box.hidden = true;
      box.innerHTML = '';
      continue;
    }

    box.hidden = false;
    // 有分值的牌排在前面，一眼看出"收到了什么要紧的"
    const sorted = visibleCards.slice().sort((a, b) => {
      const pa = Math.abs(H.cardPoints(a)), pb = Math.abs(H.cardPoints(b));
      if (pa !== pb) return pb - pa;
      return H.RANK_VALUE[H.rankOf(b)] - H.RANK_VALUE[H.rankOf(a)];
    });

    const soldSet = new Set(gz ? (state.sold || []) : []);
    // 拱猪里「猪 / 羊 / 变压器 / 红桃」才是玩家在意的，标记出来
    // 标签写两套：窄屏侧座位只有 64px，用 short 版（「已收 3」）避免竖排
    box.innerHTML =
      `<span class="won-label"><span class="won-label-full">已收关键牌 ${visibleCards.length} 张</span><span class="won-label-short">已收 ${visibleCards.length}</span></span>` +
      `<div class="won-cards">` +
        sorted.map((c) => {
          const pts = H.cardPoints(c);
          const isSold = soldSet.has(c);
          const cls = [
            'won-card',
            H.SUIT_IS_RED[H.suitOf(c)] ? 'red' : 'black',
            pts !== 0 ? 'has-points' : '',
            isSold ? 'is-sold-card' : '',
          ].filter(Boolean).join(' ');
          const title = [
            cardText(c),
            pts !== 0 ? `${pts > 0 ? '+' : ''}${pts} 分` : '无分',
            isSold ? '（已亮，分数翻倍）' : '',
          ].join(' ');
          return `<span class="${cls}" title="${title}">` +
              `<span class="won-rank">${H.rankOf(c)}</span>` +
              `<span class="won-suit">${H.SUIT_SYMBOL[H.suitOf(c)]}</span>` +
            `</span>`;
        }).join('') +
      `</div>`;
  }
}

function renderHand() {
  const me = state.players[0];
  const wrap = $('handCards');
  wrap.innerHTML = '';
  const actions = $('ddzActions');
  // 叫分阶段还没有「出牌 / 不出」这回事，整行收掉 —— 顺带把这一行的高度
  // 让给中央出牌区（叫分时那里本来就是空的）。
  if (actions) actions.hidden = !isDdz() || state.phase === 'bidding';
  if (!me) return;

  const isMyTurn = state.phase === 'playing' && activeSeat() === 0;
  let legal = [];
  if (isDdz()) {
    // 联机走房间快照（防作弊：只下发本人生牌）；单机本地算。
    legal = ONLINE_ACTIVE() ? (ONLINE.myLegalPlays() || []) : ddzLocalLegalCards();
  } else {
    legal = isMyTurn ? H.legalCards(me.hand, {
      leadSuit: state.leadSuit,
      isFirstTrick: state.trickIndex === 0,
      mustLeadClub2: state.trickIndex === 0 && state.trickPlays.length === 0,
    }).map((c) => [c]) : [];
  }
  const legalCards = new Set(legal.flat());
  $('handTitle').textContent = `你的手牌 · ${me.hand.length} 张`;
  wrap.classList.toggle('is-waiting', !isMyTurn);

  const soldSet = new Set(state.sold || []);
  for (const c of me.hand) {
    // legalCards 已把两种形态摊平成「牌集合」，两条分支判断完全一致
    const can = isMyTurn && legalCards.has(c);
    const el = cardEl(c, {
      playable: can,
      blocked: isMyTurn && !can,
      waiting: !isMyTurn,
      picked: isDdz() && state.selectedPlay.includes(c),
      sold: soldSet.has(c),
    });
    if (isDdz() && isMyTurn && can) {
      el.addEventListener('click', () => toggleDdzCard(c));
    } else if (!isDdz() && can) {
      el.addEventListener('click', () => (ONLINE_ACTIVE() ? onlinePlayCard(c) : onPlayCard(c)));
    }
    wrap.appendChild(el);
  }
  if (isDdz()) {
    const hint = $('ddzComboHint');
    if (hint) hint.textContent = ddzComboHint(isMyTurn);
    const hasBeat = ddzHasBeat();
    const mustPass = isMyTurn && !!state.currentCombo && !hasBeat;
    const pass = $('ddzPass');
    if (pass) {
      pass.disabled = !isMyTurn || !state.currentCombo;
      // 压不过上一手时把「不出」推到主位（金色实心）—— 这是此刻唯一的合法操作，
      // 按钮本身就该把玩家往那儿引。
      pass.classList.toggle('is-guide', mustPass);
    }
    const play = $('ddzPlay');
    if (play) {
      play.disabled = !isMyTurn || !state.selectedPlay.length;
      play.classList.toggle('is-dim', mustPass);
    }
  }
}

/** 我当前有没有能压过上一手的牌（首引时手里有牌就算有）。
 *  用来决定「不出」要不要被推成主按钮。 */
function ddzHasBeat() {
  const me = state.players[0];
  if (!me || state.phase !== 'playing' || activeSeat() !== 0) return false;
  // 同上：联机是牌型列表、单机是牌列表，摊平后取 size 才两种形态都成立
  const legal = ONLINE_ACTIVE() ? (ONLINE.myLegalPlays() || []) : ddzLocalLegalCards();
  return new Set(legal.flat()).size > 0;
}

/** 斗地主操作区右侧的提示文案：说清「选中的这组牌是什么牌型 / 能不能出」。
 *  比单纯报张数有用得多 —— 玩家多选几张后最想知道的就是「这算不算一手」。 */
function ddzComboHint(isMyTurn) {
  const picked = state.selectedPlay || [];
  if (state.phase === 'bidding') return '';
  if (state.phase === 'roundEnd' || state.phase === 'gameEnd') return '本局已结束';
  // 没选牌时不重复提示条里已经说过的话（「轮到你出牌 · 你首引…」），
  // 两行说同一件事只会让操作区显得乱。
  if (!isMyTurn || !picked.length) return '';
  const combo = D.classifyPlay(picked);
  if (!combo) return `已选 ${picked.length} 张 · 不是合法牌型`;
  const label = DDZ_TYPE_LABEL[combo.type] || combo.type;
  if (state.currentCombo && !D.canBeat(combo, state.currentCombo)) {
    return `${label} · 压不过上一手`;
  }
  return `${label} · 可出`;
}

/** 牌型中文名（用于操作区提示与日志） */
const DDZ_TYPE_LABEL = {
  single: '单张', pair: '对子', triple: '三张', tripleSingle: '三带一',
  triplePair: '三带二', straight: '顺子', pairStraight: '连对',
  airplane: '飞机', bomb: '炸弹', rocket: '王炸',
};

/**
 * 单机斗地主：我当前「点得动」的牌（把合法牌型摊平成牌码集合）。
 * 与联机侧的 legalFor 同一套口径 —— 出现在任何合法牌型里的牌才算可出，
 * 其余灰显。首引时任意单张都合法，所以等价于「手里全部可点」。
 *
 * 按「手牌 + 上一手」签名缓存：renderHand 每次重绘都会问一次，
 * 而 enumeratePlays 在 20 张牌时最差要 6ms，没必要每帧重算。
 */
let ddzLegalCache = { sig: '', cards: [] };
function ddzLocalLegalCards() {
  const me = state.players[0];
  if (!me || state.phase !== 'playing' || activeSeat() !== 0) return [];
  const sig = me.hand.join(',') + '|' +
    (state.currentCombo ? state.currentCombo.cards.join(',') : '');
  if (ddzLegalCache.sig === sig) return ddzLegalCache.cards;
  const set = new Set();
  for (const play of D.enumeratePlays(me.hand, state.currentCombo)) {
    for (const c of play.cards) set.add(c);
  }
  ddzLegalCache = { sig, cards: [...set] };
  return ddzLegalCache.cards;
}

function toggleDdzCard(card) {
  const i = state.selectedPlay.indexOf(card);
  if (i >= 0) {
    state.selectedPlay.splice(i, 1);      // 取消选中永远允许
  } else {
    // 不能出的牌根本不该被选中 —— 它不出现在任何合法牌型里，
    // 点它只会让玩家以为「选了就能出」。手牌渲染已经不给它绑事件，
    // 这里是第二道防线（联机换帧、脚本调用等）。
    // ⚠️ 两个来源的**形态不同**：
    //    联机 myLegalPlays() = 牌型列表 [[c,c],[c,c,c],…]；单机 ddzLocalLegalCards() = 牌列表 [c,…]。
    //    必须摊平成牌集合再判断。此前直接 legal.includes(card)，联机下恒 false
    //    —— 真人点了牌却选不中、出牌按钮永远禁用，整局卡死（2026-09-26 修）。
    const legal = ONLINE_ACTIVE() ? (ONLINE.myLegalPlays() || []) : ddzLocalLegalCards();
    if (!new Set(legal.flat()).has(card)) return;
    state.selectedPlay.push(card);
  }
  renderHand();
}

async function submitDdzPlay() {
  if (!ONLINE_ACTIVE() || !state.selectedPlay.length || !ONLINE.isMyTurn()) return;
  const cards = state.selectedPlay.slice();
  $('ddzPlay').disabled = true;
  try {
    await ONLINE.playCards(cards);
    state.selectedPlay = [];
    renderOnlineTable();
  } finally {
    $('ddzPlay').disabled = false;
  }
}

async function submitDdzPass() {
  if (!ONLINE_ACTIVE() || !ONLINE.isMyTurn() || !state.currentCombo) return;
  $('ddzPass').disabled = true;
  try { await ONLINE.passPlay(); state.selectedPlay = []; renderOnlineTable(); }
  finally { $('ddzPass').disabled = false; }
}

/** 是否处于联机对局中（联机时不跑单人版循环） */
function ONLINE_ACTIVE() {
  return !!(window.NET_CLIENT && window.NET_CLIENT.isActive());
}

/* 增量渲染出牌区。
 * 关键：已落桌的牌不重建 DOM，只追加新牌 —— 否则每出一张牌，
 * 前面几张会被销毁重建、进场动画重播，表现为整桌牌一起闪烁。
 * 用一个签名标记哪些牌已渲染，避免重复插入。
 */
let renderedTrickKeys = new Set();

/**
 * 斗地主出牌位的 DOM 缓存：座位 → { sig, node }。
 *
 * 为什么要缓存：`renderTrick` 每帧都会跑（联机轮询 ~700ms 一次），
 * 如果每次都 `slot.innerHTML = ''` 重建，入场动画与灰显过渡会反复重播 ——
 * 表现为**闪烁**。按「内容签名」做增量更新后，内容没变的那一格完全不动。
 * 内容变了（这家又出牌了 / 改成不出）才重建，此时重播动画正是我们想要的。
 */
let ddzTrickCache = {};

function resetTrickRender() {
  renderedTrickKeys = new Set();
  ddzTrickCache = {};
  for (let i = 0; i < 4; i++) {
    const slot = $('slot' + i);
    slot.innerHTML = '';
    slot.classList.remove('filled');
  }
}

/** 给某张牌加上/去掉「首引」标记角标 */
function markLeadCard(el, on) {
  if (!el) return;
  el.classList.toggle('is-lead', on);
  let tag = el.querySelector('.lead-tag');
  if (on) {
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'lead-tag';
      tag.textContent = '首引';
      el.appendChild(tag);
    }
  } else if (tag) {
    tag.remove();
  }
}

/** 让桌面上只有首引那张牌带标记（增量渲染下可能出现遗漏或残留） */
function syncLeadMarker() {
  const lead = state.trickPlays[0];
  for (let i = 0; i < 4; i++) {
    const el = $('slot' + i).querySelector('.card');
    if (!el) continue;
    const isLead = lead === undefined ? false
      : (i === lead.player && el.dataset.card === lead.card);
    markLeadCard(el, isLead);
  }
}

function renderDdzBottom() {
  const wrap = $('ddzBottomCards');
  const btn = $('btnShowBottom');
  // 底牌只有定完地主之后才有意义（叫分阶段还不知道会发给谁）
  const visible = isDdz() && state.landlord >= 0 &&
    Array.isArray(state.bottom) && state.bottom.length;
  if (btn) btn.hidden = !visible;
  if (!wrap) return;
  if (!visible) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '';
  state.bottom.forEach((card) => wrap.appendChild(cardEl(card)));
  const lead = $('bottomLead');
  if (lead) {
    lead.textContent = `${SEAT_LABEL[state.landlord] || '地主'} 拿走的 ${state.bottom.length} 张底牌` +
      ` · 底分 ${state.baseBid || 1}`;
  }
}

function renderTrick() {
  if (isDdz()) {
    // 出牌区显示「一轮内三家的最后一次动作」：
    //   · 出牌 → 摆出那组牌（同一家在**本轮里更早**出的牌不再重复摆）
    //   · 不出 → 一枚「不出」胶囊
    // 一家在本轮里可能出好几次（被压过之后又压回来），全摆出来会叠成一堆；
    // 只留最后一次，信息没丢、桌面也不乱。
    //
    // 另外：被压过的那些牌**灰显但不消失** —— 玩家还能看到「刚才谁出了什么」，
    // 同时一眼分出「现在要压的是哪一手」（只有最后那手是彩色的）。
    // 某个玩家再次行动（出牌 / 不出）时，他那一格才被替换掉。
    const latest = {};                 // 座位 → 本轮该座位最后一次动作
    let targetAction = null;           // 当前需要被压过的那一手（最后一张非「不出」）
    const lastIdxBySeat = {};          // 座位 → 其最后一次动作在 trickPlays 里的下标
    let targetIndex = -1;              // 最后一张非「不出」的下标
    (state.trickPlays || []).forEach((a, idx) => {
      latest[a.player] = a;
      lastIdxBySeat[a.player] = idx;
      if (!a.pass) { targetAction = a; targetIndex = idx; }
    });

    const nextCache = {};
    for (let i = 0; i < 4; i++) {
      const slot = $('slot' + i);
      if (!slot) continue;
      const cell = slot.parentElement;
      // 三个出牌位**常驻**（与四人玩法一致）：空着就是虚线虚框，出了牌就填进去。
      // 底板既然固定了高度，就不必再靠「收起空格」省地方；
      // 位置固定之后玩家一眼就知道哪一格是谁的。
      if (cell) cell.hidden = false;
      const action = latest[i];
      const showCards = !!action && !action.pass &&
        Array.isArray(action.cards) && action.cards.length > 0;
      const showPass = !!action && !!action.pass;

      if (!showCards && !showPass) {
        if (ddzTrickCache[i]) { ddzTrickCache[i].node.remove(); delete ddzTrickCache[i]; }
        slot.classList.remove('filled');
        continue;
      }
      slot.classList.add('filled');

      // ⚠️ 增量更新，而不是每次 `slot.innerHTML = ''` 重建。
      //    重建会让「入场动画」和「灰显过渡」每帧重播 —— 表现为闪烁
      //    （联机轮询每 ~700ms 就会重绘一次，尤其明显）。
      //    内容签名不变 → 直接复用节点，一个字节都不动；
      //    只有内容真的变了（这家又出牌了 / 改成不出）才重建。
      const sig = showPass ? 'pass' : action.cards.join(',');
      let node = ddzTrickCache[i] && ddzTrickCache[i].sig === sig &&
        ddzTrickCache[i].node.isConnected ? ddzTrickCache[i].node : null;

      if (!node) {
        if (ddzTrickCache[i]) ddzTrickCache[i].node.remove();
        node = document.createElement('div');
        node.className = 'ddz-play-wrap card-enter';
        if (showPass) {
          const chip = document.createElement('span');
          chip.className = 'ddz-pass-chip';
          chip.textContent = '不出';
          node.appendChild(chip);
        } else {
          const group = document.createElement('div');
          group.className = 'ddz-play-group';
          action.cards.forEach((card) => group.appendChild(cardEl(card)));
          node.appendChild(group);
        }
        slot.appendChild(node);
      }

      // 灰显单独用类切换 —— 走 CSS transition，平滑淡出、且不重建节点。
      // 「被压过」= 该座位最后一次动作出现在「当前目标那一手」之前：
      //   · 出过的牌被新的一手压过 → 灰
      //   · 上一轮的「不出」被新一轮首引顶掉 → 也灰
      //   · 紧跟在当前目标之后的「不出」（本轮刚跳过的那几家）→ 不灰，仍是当前状态
      const myIdx = lastIdxBySeat[i];
      const isStale = myIdx != null && myIdx < targetIndex;
      node.classList.toggle('is-stale', isStale);
      nextCache[i] = { sig, node };
    }
    ddzTrickCache = nextCache;
    // 底板**牌局内一直显示**（不再「三家都没动就收起」）——
    // 收起来会让牌桌高度忽大忽小，出牌位也跟着跳；固定住反而更稳。
    // 尺寸由 CSS 的 min-height 定，不随内容变。

    renderDdzBottom();
    if (state.phase === 'idle') {
      setAutoHint('点「开始新的一局」对两个 AI 开打，也可以在下方建房联机三人同桌');
    } else if (state.phase === 'bidding') {
      setAutoHint(state.bidTurn === 0
        ? `轮到你叫分 · ${state.currentBid ? `当前最高 ${state.currentBid} 分` : '尚无人叫分'}`
        : `叫分中 · ${ddzBidSummary()}`);
    } else if (state.phase === 'playing') {
      const seat = activeSeat();
      if (seat === 0) {
        if (!state.currentCombo) setAutoHint('轮到你出牌 · 你首引，点牌多选后点「出牌」');
        else if (ddzHasBeat()) setAutoHint('轮到你出牌 · 点牌多选，需压过上一手；也可以点「不出」');
        else setAutoHint('你压不过上一手 · 点「不出」跳过');
      } else {
        setAutoHint(`${SEAT_LABEL[seat] || '其他玩家'} 正在出牌…`);
      }
    } else {
      setAutoHint('本局结束 · 查看地主 / 农民得分');
    }
    return;
  }
  const current = new Set();

  for (const p of state.trickPlays) {
    const key = p.player + ':' + p.card;
    current.add(key);
    if (renderedTrickKeys.has(key)) continue;   // 已渲染过，跳过（不重建）

    const slot = $('slot' + p.player);
    slot.classList.add('filled');
    const el = cardEl(p.card);
    el.classList.add('card-enter');
    slot.appendChild(el);
  }

  // 首引标记同步（增量渲染下，标记可能在别处被清掉或遗漏）
  syncLeadMarker();

  // 本墩清空（新一墩开始）时，移除上一墩残留
  if (state.trickPlays.length === 0 && renderedTrickKeys.size > 0) {
    resetTrickRender();
  }
  // 移除已不在当前墩里的牌（收墩后清理）
  for (const key of renderedTrickKeys) {
    if (current.has(key)) continue;
    const [seat] = key.split(':');
    const slot = $('slot' + seat);
    slot.innerHTML = '';
    slot.classList.remove('filled');
  }

  renderedTrickKeys = current;

  const fmtPts = (v) => (v > 0 ? '+' + v : String(v));
  const gz = isGongzhu();
  // 拱猪里亮过的牌分数翻倍 → 墩分也要按翻倍后的值报，否则与侧栏对不上账
  const soldSet = new Set(gz ? (state.sold || []) : []);
  const livePts = (plays) => plays.reduce((sum, p) => {
    const base = H.cardPoints(p.card);
    return sum + (soldSet.has(p.card) ? base * 2 : base);
  }, 0);

  if (state.phase === 'idle') setAutoHint('等待开始 · 回到主页点「开始新的一局」');
  else if (state.phase === 'selling') setAutoHint('亮牌阶段（拱猪）');
  else if (state.phase === 'passing') setAutoHint('传牌阶段');
  else if (state.trickPlays.length === 0) setAutoHint(`第 ${state.trickIndex + 1} 墩 · ${SEAT_LABEL[activeSeat()]} 首引`);
  else if (state.trickPlays.length < 4) {
    const pts = livePts(state.trickPlays);
    const w = H.trickWinner(state.trickPlays, state.leadSuit);
    setAutoHint(`第 ${state.trickIndex + 1} 墩 · 已出 ${state.trickPlays.length} 张` +
      ` · 暂时领先 ${SEAT_LABEL[w]}` + (pts ? ` · 本墩 ${fmtPts(pts)} 分` : ''));
  } else {
    const w = H.trickWinner(state.trickPlays, state.leadSuit);
    const pts = livePts(state.trickPlays);
    setAutoHint(`${SEAT_LABEL[w]} 收下这墩${pts ? `，得 ${fmtPts(pts)} 分` : '（无分）'}`);
  }

  // 联机侧：桌面凑满 4 张就是「这一墩已分完」的信号，此时播收牌动画。
  // 单机不在这里触发 —— 单机的节奏由 playTrick 精确控制（且需要 await）。
  maybeCollectAnimOnline();
}

/** 手工提示：优先于自动提示显示，玩家出牌后自动让位 */
function setHint(text, kind = '') {
  hintManual = text || '';
  hintKind = kind || '';
  renderHintbar();
}

function addLog(text, hot = false) {
  const list = $('logList');
  if (list.children.length === 1 && list.children[0].textContent === '等待开局…') list.innerHTML = '';
  const li = document.createElement('li');
  li.textContent = text;
  if (hot) li.classList.add('hot');
  list.insertBefore(li, list.firstChild);
  while (list.children.length > 40) list.removeChild(list.lastChild);
}

function activeSeat() {
  // 联机模式直接用房间给出的 turn（已转成本地座位号）。
  // 本地公式依赖 leader + 墩内张数，在「有人掉线 / AI 补位」时容易对不上。
  if (ONLINE_ACTIVE() && state.onlineTurn != null && state.onlineTurn >= 0) {
    return state.onlineTurn;
  }
  // 斗地主不是墩类玩法：一次动作是一「组」牌，没有 trickPlays.length 可数，
  // 该谁出牌完全由 state.turn 决定。
  if (isDdz()) return state.turn >= 0 ? state.turn : 0;
  return state.trickPlays.length
    ? (state.leader + state.trickPlays.length) % 4
    : state.leader;
}

/* ============================================================
 * 游戏流程
 * ============================================================ */
function newGame() {
  // 斗地主是三人局，分数数组长度也不同，单独走一条入口
  if (isDdz()) {
    state.scores = [0, 0, 0];
    state.round = 0;
    state.targetScore = D.GAME_OVER_SCORE;
    state.phase = 'idle';
    state.busy = false;
    state.paused = false;
    state.redealCount = 0;
    $('logList').innerHTML = '<li>新对局开始 · 斗地主（你 + 2 个 AI）。</li>';
    startRound();
    return;
  }
  state.scores = [0, 0, 0, 0];
  state.round = 0;
  state.sold = [];
  state.phase = 'idle';
  state.busy = false;
  state.paused = false;
  $('logList').innerHTML = `<li>新对局开始 · ${isGongzhu() ? '拱猪' : '红心大战'}。</li>`;
  startRound();
}

function startRound() {
  if (isDdz()) return startDdzRound();
  // 作废上一局可能仍在跑的循环（例如结算动画未完就点了「新的一局」）
  runId++;
  // 收牌动画是纯视觉的，换局时直接清干净 —— 否则上一局的飞行牌
  // 可能挂在新一局的牌桌上，看起来像"牌凭空乱飞"
  if (window.CollectAnim) window.CollectAnim.reset();
  state.round++;
  state.collected = [0, 0, 0, 0];
  state.collectedCards = [[], [], [], []];
  state.trickIndex = 0;
  state.trickPlays = [];
  state.leadSuit = null;
  state.heartsPlayed = 0;
  state.queenTaken = false;
  state.queenTakenBy = -1;
  state.selectedPass = [];
  state.selectedSell = [];
  state.sold = [];
  state.soldBy = {};
  state.phase = 'idle';
  state.busy = false;
  state.paused = false;
  delete $('passCards').dataset.sig;
  delete $('sellCards').dataset.sig;

  // 建立四个玩家（保留累计分）
  const prevScores = state.scores.slice();
  state.players = [
    new HumanPlayer(0, '你'),
    new AIPlayer(1, SEAT_LABEL[1], state.difficulty),
    new AIPlayer(2, SEAT_LABEL[2], state.difficulty),
    new AIPlayer(3, SEAT_LABEL[3], state.difficulty),
  ];
  state.players.forEach((p, i) => { p.score = prevScores[i]; });

  // 发牌
  const deck = H.shuffle(H.createDeck());
  const hands = [[], [], [], []];
  for (let i = 0; i < 52; i++) hands[i % 4].push(deck[i]);
  state.players.forEach((p, i) => p.setHand(hands[i]));

  // 传牌方向。拱猪没有传牌规则 → 恒为 'none'
  const dirs = passEnabled() ? H.PASS_CYCLE : ['none'];
  state.passDirection = dirs[(state.round - 1) % dirs.length];

  addLog(`第 ${state.round} 局发牌完成 · ${H.PASS_LABEL[state.passDirection]}`);
  applyModeChrome();
  render();

  // 拱猪：先亮牌（卖牌），再传牌
  if (isGongzhu() && state.settings.sell) {
    const iHaveSellable = state.players.some(
      (p) => p.hand.some((c) => H.isSellable(c)));
    if (iHaveSellable) {
      openSellDialog();
      return;
    }
    addLog('本局无人持可亮之牌，跳过亮牌环节');
  }
  afterSell();
}

/** 亮牌环节结束后进入传牌（或直接开打） */
function afterSell() {
  // AI 亮牌：在传牌前定好，因为亮牌依据的是「发牌后的原始手牌」
  if (isGongzhu() && state.settings.sell) {
    for (let i = 1; i <= 3; i++) {
      const p = state.players[i];
      const out = p.chooseSellCards({ allowSell: true }) || [];
      out.filter((c) => p.hand.includes(c)).forEach((c) => {
        if (!state.sold.includes(c)) {
          state.sold.push(c);
          state.soldBy[c] = i;      // 记录「谁亮的」，供公开亮牌板展示
        }
      });
    }
  }

  if (state.sold && state.sold.length) {
    addLog(`本局亮牌：${state.sold.map((c) => {
      const who = state.soldBy[c];
      return who != null ? `${SEAT_LABEL[who]}亮${H.SELL_LABEL[c] || cardText(c)}` : (H.SELL_LABEL[c] || cardText(c));
    }).join('、')}`, true);
  }

  $('ovSell').hidden = true;
  render();

  if (state.passDirection === 'none') {
    beginPlay(club2Holder());
  } else {
    openPassDialog();
  }
}

/**
 * 第一墩的首引者 = 持梅花 2 的人。
 * 红心大战与拱猪**两套规则一致**，都要求梅花 2 先手。
 * 异常牌局（构造的牌局里没人持 C2）退化为座位 0，
 * 否则 legalCards 拿不到 C2、首引会变成空着无人可出。
 */
function club2Holder() {
  const i = state.players.findIndex((p) => p.hand.includes(H.CLUB_2));
  return i === -1 ? 0 : i;
}

/* ---------- 亮牌（卖牌）阶段 —— 仅拱猪 ---------- */
function openSellDialog() {
  state.phase = 'selling';
  state.selectedSell = [];
  renderSellDialog();
  $('ovSell').hidden = false;
  $('sellTip').hidden = true;
  setHint('亮牌阶段：勾选要亮出的牌（分数翻倍），或选择不亮。');
}

/* 与 renderPassDialog 同理：按手牌签名决定是否重建 DOM，
 * 避免第二局沿用上一局的牌元素导致点选错牌。
 *
 * ⚠️ 这里渲染的是**全部手牌**，不是只有能亮的那几张。
 *    原因：亮哪张是策略决定，取决于手里还有什么（比如手里红桃多就别轻易亮红桃 A）。
 *    只列可亮的牌，玩家在弹窗里看不到手牌，就得凭记忆决策 ——
 *    移动端尤其致命：弹窗是底部抽屉，正好把手牌区盖住，且遮罩会拦住触摸，
 *    连横向滑动看后面的牌都做不到。
 *    现在可亮的牌保持可点，其余灰显（.blocked）作参照。 */
function renderSellDialog() {
  const me = state.players[0];
  const wrap = $('sellCards');
  const sellables = me.hand.filter((c) => H.isSellable(c));

  const sig = me.hand.join(',');
  if (wrap.dataset.sig !== sig) {
    wrap.innerHTML = '';
    for (const c of me.hand) {
      const can = H.isSellable(c);
      const el = cardEl(c, { playable: can, blocked: !can });
      if (can) el.addEventListener('click', () => toggleSellCard(el.dataset.card));
      wrap.appendChild(el);
    }
    if (!sellables.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = '你手里没有可亮的牌（猪 / 羊 / 变压器 / 红桃A），可直接点「不亮牌」。';
      wrap.appendChild(note);
    }
    wrap.dataset.sig = sig;
  }

  syncSellSelection();
}

function toggleSellCard(c) {
  const i = state.selectedSell.indexOf(c);
  if (i >= 0) state.selectedSell.splice(i, 1);
  else state.selectedSell.push(c);
  syncSellSelection();
}

function syncSellSelection() {
  const wrap = $('sellCards');
  for (const el of wrap.children) {
    el.classList.toggle('picked', state.selectedSell.includes(el.dataset.card));
  }
  const n = state.selectedSell.length;
  $('sellConfirm').disabled = false;

  if (!n) {
    setSellTip('不选中即表示不亮牌。亮牌是赌注：赌对翻倍得分，赌错翻倍失分。');
  } else {
    const names = state.selectedSell.map((c) => H.SELL_LABEL[c] || cardText(c)).join('、');
    const risky = state.selectedSell.filter((c) => H.cardPoints(c) < 0).length;
    setSellTip(
      `已选 ${n} 张：${names}。` +
      (risky ? `其中 ${risky} 张是负分牌，一旦自己吃到将双倍失分。` : ''),
      risky ? '' : 'ok');
  }
}

function setSellTip(text, kind = '') {
  const el = $('sellTip');
  if (!el) return;
  el.textContent = text;
  el.className = 'pass-tip' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function confirmSell() {
  const me = state.players[0];
  // 防御：过滤掉已不在手上的牌
  state.selectedSell
    .filter((c) => me.hand.includes(c) && H.isSellable(c))
    .forEach((c) => {
      if (!state.sold.includes(c)) {
        state.sold.push(c);
        state.soldBy[c] = 0;        // 0 = 真人
      }
    });
  afterSell();
}

/* ---------- 传牌阶段 ---------- */
function openPassDialog() {
  state.phase = 'passing';
  state.selectedPass = [];

  // 明确告知传牌对象
  const target = H.passTarget(0, state.passDirection);
  const targetName = SEAT_LABEL[target];
  $('passLead').innerHTML =
    `本局<b>${H.PASS_LABEL[state.passDirection]}</b>，` +
    `你要把 3 张牌传给 <b class="pass-target">${targetName}</b>。`;
  $('passWho').textContent = `传出对象：${targetName}`;

  renderPassDialog();
  $('ovPass').hidden = false;
  setHint(isGongzhu()
    ? `传牌阶段：选 3 张传给${targetName}。优先把猪传出去，别把羊和变压器传走。`
    : `传牌阶段：选 3 张传给${targetName}。优先把黑桃 Q 和红心大牌传出去。`);
}

/* 传牌候选：一次构建，后续只切换选中 class。
 * 不重建 DOM 有两个好处：① 点击不闪烁 ② 选中态可以有过渡动画。
 *
 * ⚠️ 重建判定必须比较「牌面内容」而不是「手牌数量」：
 * 每局手牌恒为 13 张，若只比数量，第二局就会误判为"无需重建"，
 * 于是 DOM 里残留上一局的牌元素、点击选到的是上一局的花色点数，
 * 确认传牌时 removeCard 会抛「手中没有 X」，整局卡死在传牌阶段。
 */
function renderPassDialog() {
  const me = state.players[0];
  const wrap = $('passCards');

  // 用当前手牌拼出签名，与 DOM 上挂的签名比对，不同才重建
  const sig = me.hand.join(',');
  if (wrap.dataset.sig !== sig) {
    wrap.innerHTML = '';
    for (const c of me.hand) {
      const el = cardEl(c, { playable: true });
      el.dataset.card = c;
      // 用 dataset 读值而非闭包捕获，避免残留节点持有旧牌值
      el.addEventListener('click', () => togglePassCard(el.dataset.card));
      wrap.appendChild(el);
    }
    wrap.dataset.sig = sig;
  }

  syncPassSelection();
}

/** 切换某张牌的选中状态，只改 class */
function togglePassCard(c) {
  const i = state.selectedPass.indexOf(c);
  if (i >= 0) {
    state.selectedPass.splice(i, 1);
  } else {
    if (state.selectedPass.length >= 3) {
      // 已选满：提示而非静默忽略
      setPassTip('最多只能选 3 张，请先取消一张。');
      return;
    }
    state.selectedPass.push(c);
  }
  syncPassSelection();
}

/** 把选中状态同步到 DOM 与计数 */
function syncPassSelection() {
  const wrap = $('passCards');
  for (const el of wrap.children) {
    const picked = state.selectedPass.includes(el.dataset.card);
    el.classList.toggle('picked', picked);
  }
  const n = state.selectedPass.length;
  $('passCount').textContent = `已选 ${n} / 3`;
  $('passConfirm').disabled = n !== 3;

  // 选中了危险牌时给出提醒（两套玩法的"危险牌"定义不同）
  const dangerCard = isGongzhu() ? H.PIG : H.QUEEN_OF_SPADES;
  const dangerName = isGongzhu() ? '猪（黑桃 Q）' : '黑桃 Q';
  if (state.selectedPass.includes(dangerCard)) {
    setPassTip(isGongzhu()
      ? `已选中猪，传出它可以甩掉 −100 分风险。`
      : `已选中黑桃 Q，传出它可以甩掉 13 分风险。`, 'ok');
  } else if (state.selectedPass.length === 3) {
    setPassTip('已选满 3 张，可以确认传出了。', 'ok');
  } else {
    setPassTip('');
  }
}

function setPassTip(text, kind = '') {
  const el = $('passTip');
  if (!el) return;
  el.textContent = text;
  el.className = 'pass-tip' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

async function confirmPass() {
  const me = state.players[0];
  // 保险：过滤掉已不在手中的牌（防御 UI 残留旧牌导致的脏选中）
  const chosen = state.selectedPass.filter((c) => me.hand.includes(c)).slice(0, 3);
  if (chosen.length < 3) {
    setPassTip(`请重新选择，需选出 3 张（当前有效 ${chosen.length} 张）。`);
    renderPassDialog();
    return;
  }
  $('ovPass').hidden = true;

  // AI 各自选牌
  const ais = [1, 2, 3].map((i) => ({
    player: state.players[i],
    out: state.players[i].choosePassCards(3),
  }));

  // 收集所有传出的牌，按方向派发
  const outs = [chosen, ais[0].out, ais[1].out, ais[2].out];
  const incoming = [[], [], [], []];
  for (let i = 0; i < 4; i++) {
    const t = H.passTarget(i, state.passDirection);
    incoming[t].push(...outs[i]);
  }
  for (let i = 0; i < 4; i++) {
    outs[i].forEach((c) => state.players[i].tryRemoveCard(c));
    incoming[i].forEach((c) => state.players[i].receiveCard(c));
    state.players[i].setHand(state.players[i].hand);
  }

  addLog(`传牌完成 · 你传出 ${chosen.map(cardText).join(' ')}`);
  if (chosen.includes(isGongzhu() ? H.PIG : H.QUEEN_OF_SPADES)) {
    addLog(isGongzhu() ? '你把猪传了出去' : '你把黑桃 Q 传了出去', true);
  }
  render();

  // 首引出牌者：持有梅花 2 的人（第一墩他必须且只能出梅花 2）
  //   红心大战走这条路径时已经把牌传过一轮，C2 可能易主 → 必须在传牌后重新查。
  beginPlay(club2Holder());
}
function cardText(card) {
  return H.SUIT_SYMBOL[H.suitOf(card)] + H.rankOf(card);
}

/* ---------- 出牌阶段 ---------- */
async function beginPlay(starter) {
  state.phase = 'playing';
  state.leader = starter;
  state.trickIndex = 0;
  state.trickPlays = [];
  state.leadSuit = null;
  render();
  addLog(`第 ${state.round} 局开打 · ${SEAT_LABEL[starter]} 持有梅花 2，首引`);
  setHint(`牌局开始 · ${SEAT_LABEL[starter]} 持有梅花 2，由他首引。`);
  // 开启新的一代：任何仍在跑的旧循环会在下一次 await 返回后自行退出
  const myRun = ++runId;
  await playLoop(myRun);
}

/* ⚠️ 对局循环必须是「单实例」的。
 *   playLoop() 是 async 的，里面的 await（AI 思考、观战间隔）会交出控制权。
 *   如果在它还没跑完时又触发了第二轮（例如测试脚本连着调 newGame，
 *   或玩家在上一局结算动画未完时点了「新的一局」），就会有两个循环
 *   同时推进同一份 state：一个把 trickPlays 清空、另一个正在读
 *   trickPlays[0].player → 抛 "Cannot read properties of undefined"，
 *   并且两个循环互相覆盖对方的出牌，牌局彻底错乱。
 *
 *   用一个自增的 runId 做代际标记：只有当前代的循环才有权继续推进。
 *   新的一局会把 runId +1，旧循环在下一次 await 返回后自行退出。
 */
async function playLoop(myRun) {
  while (state.trickIndex < 13) {
    if (!(await waitForResume(myRun))) return;
    await playTrick(myRun);
    if (myRun !== runId) return;
    if (state.phase !== 'playing') return;
  }
  endRound();
}

/**
 * 轮到玩家时生成提示文案。区分三种情形：
 *  ① 我是首引（无主导花色）
 *  ② 有主导花色必须跟
 *  ③ 已无该花色，可以任意垫牌 —— 此时只说明事实，不给策略建议
 *
 * 拱猪与红心大战在此处差异最大：拱猪没有"禁红心 / 禁猪"，
 * 所以 ① 的文案里不能出现任何禁用字眼。
 */
function humanTurnHint(legal, opts = {}) {
  const me = state.players[0];
  const isFirstTrick = state.trickIndex === 0;
  const gz = isGongzhu();

  // ⓪ 第一墩首引：手里有梅花 2 就必须且只能出梅花 2
  if (opts.mustLeadClub2 && legal.length === 1 && legal[0] === H.CLUB_2) {
    return '第一墩由持梅花 2 者首引 · 点击梅花 2 开牌';
  }

  // ① 首引
  if (!state.leadSuit) {
    if (!gz) {
      if (isFirstTrick) {
        return `轮到你首引 · 第一墩不能出红心和黑桃 Q，可出 ${legal.length} 张`;
      }
      const heartsOnly = me.hand.every((c) => H.isHeart(c));
      if (heartsOnly) {
        return `轮到你首引 · 你手里全是红心，只能出红心（可出 ${legal.length} 张）`;
      }
      return `轮到你首引 · 不能出红心，可出 ${legal.length} 张`;
    }
    // 拱猪：首引没有任何花色或牌面限制
    return `轮到你首引 · 可出 ${legal.length} 张`;
  }

  const suitName = H.SUIT_NAME[state.leadSuit];
  const hasSuit = me.hand.some((c) => H.suitOf(c) === state.leadSuit);

  // ② 必须跟花色
  if (hasSuit) {
    if (!gz && isFirstTrick) {
      return `轮到你出牌 · 必须跟出${suitName}，且第一墩不能出红心和黑桃 Q（可出 ${legal.length} 张）`;
    }
    return `轮到你出牌 · 必须跟出${suitName}（可出 ${legal.length} 张）`;
  }

  // ③ 断门：只说明"可以任意垫牌"这一事实，不再给出垫牌策略提示
  //    （按用户要求去掉"尽量避免红心"、"垫小牌即可"等建议文案）
  const danger = gz ? H.PIG : H.QUEEN_OF_SPADES;
  const dangerLabel = gz ? '猪' : '黑桃 Q';
  const tips = [`你已没有${suitName}，可以垫任意牌（${legal.length} 张可选）`];
  if (me.hand.includes(danger)) tips.push(`注意别把${dangerLabel}垫进去`);
  return tips.join(' · ');
}

/* ---------- 收牌动画（单机 / 联机共用入口） ---------- */

/**
 * 把「本墩归谁」播成动画：桌面 4 张牌飞向赢家 + 赢家旁浮出标识。
 *
 * @param {number} winner  收牌座位（**本地**座位号 0..3）
 * @param {number} points  本墩得分
 * @param {{plays?:Array, round?:number, trickIndex?:number}} [opts]
 * @returns {Promise<void>} 动画放完（或跳过）后 resolve
 */
function runCollectAnim(winner, points, opts) {
  const A = window.CollectAnim;
  if (!A) return Promise.resolve();
  const o = opts || {};
  const src = o.plays || state.trickPlays;
  const plays = src.map((p) => ({ player: p.player, card: p.card }));
  return A.play({
    winner,
    plays,
    points: points || 0,
    // key = 局号:墩号 —— 同一墩只有一个 key，联机重复帧/补播不会重播
    key: (o.round != null ? o.round : state.round) + ':' +
         (o.trickIndex != null ? o.trickIndex : state.trickIndex),
    label: SEAT_LABEL[winner] || ('玩家' + (winner + 1)),
    isSelf: winner === 0,
  });
}

/**
 * 联机：桌面首次出现 4 张牌时播收牌动画。
 *
 * ⚠️ 赢家取裁判写下的 `lastTrick`（**权威**），不用本地规则引擎再算一遍 ——
 *    两套算法万一漂移，动画就会「把牌发给错的人」，比不播还糟。
 *    收墩缓冲保证了「桌面 4 张」与 `lastTrick` 同时存在，所以这里一定读得到。
 *
 * 不 await：联机渲染由轮询驱动，动画不该拖慢它。重复触发由 CollectAnim
 * 的 key 去重挡掉（补播会把同一个「4 张」状态送来很多次）。
 */
function maybeCollectAnimOnline() {
  if (!ONLINE_ACTIVE()) return;
  if (state.trickPlays.length !== 4) return;
  const v = ONLINE.getView();
  if (!v || !v.lastTrick) return;
  // 墩号对不上说明这条 lastTrick 属于上一墩（还没被新快照覆盖），跳过
  if (v.lastTrick.index !== v.trickIndex) return;

  const mySeat = ONLINE.getMySeat();
  const toLocal = (i) => ((i - mySeat) % 4 + 4) % 4;
  const winner = toLocal(v.lastTrick.winner);
  const plays = (v.lastTrick.cards || []).map((p) => ({
    player: toLocal(p.seat), card: p.card,
  }));
  if (!plays.length) return;

  runCollectAnim(winner, v.lastTrick.points || 0, {
    plays,
    round: v.round || 0,
    trickIndex: v.lastTrick.index,
  }).then(() => {
    // 动画放完 = 这 4 张牌已被收走，桌面不该再摆着它们（否则牌飞走后又闪回一桌牌）。
    // 这里**只撤 DOM**，不动 state.trickPlays / renderedTrickKeys：
    //   后者仍记着这 4 个 key，所以即使快照里它们还在（收墩缓冲尚未放开），
    //   renderTrick() 也不会把它们补画回来；等快照真的清空，清理分支自然收尾。
    // 先核对桌面确实是刚才那 4 张，避免误伤已经开始的下一墩。
    for (const p of plays) {
      const slot = $('slot' + p.player);
      const el = slot && slot.querySelector('.card');
      if (!el || el.getAttribute('data-card') !== p.card) return;
    }
    for (const p of plays) {
      const slot = $('slot' + p.player);
      if (slot) slot.innerHTML = '';
    }
  });
}

async function playTrick(myRun) {
  state.trickPlays = [];
  state.leadSuit = null;
  resetTrickRender();     // 新一墩：清空出牌区并重置渲染标记
  clearManualHint();      // 上一墩的手工提示不该留到新一墩
  render();

  for (let k = 0; k < 4; k++) {
    if (!(await waitForResume(myRun))) return;
    const seat = (state.leader + k) % 4;
    const p = state.players[seat];
    const isFirstTrick = state.trickIndex === 0;
    // 第一墩的第一家（k===0 即首引）必须出梅花 2
    const mustLeadClub2 = isFirstTrick && k === 0;
    const legal = H.legalCards(p.hand, { leadSuit: state.leadSuit, isFirstTrick, mustLeadClub2 });
    if (!legal.length) return;

    const ctx = { leadSuit: state.leadSuit, isFirstTrick, mustLeadClub2 };

    let card;
    if (p.isHuman) {
      state.phase = 'playing';
      render();
      setHint(humanTurnHint(legal, { mustLeadClub2 }));
      card = await p.chooseCard(legal, ctx);
      if (myRun !== runId) return;   // 等待玩家期间可能已经开了新局
      if (!legal.includes(card)) {   // 兜底：绝不放行非法牌
        card = legal[0];
      }
    } else {
      // AI 思考时间：让玩家看清"谁在想、想多久"
      const think = state.settings.delay ? 700 + Math.random() * 400 : 0;
      if (think) await sleep(think);
      if (!(await waitForResume(myRun))) return;
      card = p.chooseCard(legal, Object.assign({
        trickPlays: state.trickPlays, trickIndex: state.trickIndex,
      }, ctx));
      if (!legal.includes(card)) card = legal[0];
    }

    // ⚠️ 等待期间若这一墩已被新的循环清空，就不能再往 trickPlays 里塞牌 ——
    //    否则会出现「一墩里 5 张牌」这种状态，收墩判定随后读到 undefined。
    //
    // ⚠️ 必须**先判断玩家对象还在不在**：setMode 会把 state.players 清空为 []，
    //    此时 state.players[seat] 是 undefined，直接 .hand 就抛
    //    "Cannot read properties of undefined (reading 'hand')"。
    //    （这条曾被 runId 校验漏过：setMode 清牌桌时并没有递增 runId）
    const pl = state.players[seat];
    if (!pl || !pl.hand.includes(card)) return;

    p.removeCard(card);
    if (state.leadSuit === null) state.leadSuit = H.suitOf(card);
    state.trickPlays.push({ player: seat, card });
    state.players.forEach((q, qi) => { if (q.observe) q.observe(seat, card, state.leadSuit); });

    if (H.isHeart(card)) state.heartsPlayed++;
    if (H.isQueenOfSpades(card)) { state.queenTaken = true; }

    clearManualHint();   // 牌已落下，轮次提示让位给墩况提示
    render();

    // 出一张牌后留出观战间隔，方便玩家看清这手牌是什么
    if (k < 3) await sleep(state.settings.delay ? 620 : 0);
  }

  if (myRun !== runId) return;

  // 结算前先停一拍让最后一手牌看清 —— 随后紧接着播「收牌动画」，
  // 所以这里的停顿比原来短（动画本身也会让牌在桌上多留一会儿）。
  await sleep(state.settings.delay ? 420 : 0);
  if (!(await waitForResume(myRun))) return;
  if (state.trickPlays.length !== 4) return;   // 状态不完整则不结算，交给新循环
  const winner = H.trickWinner(state.trickPlays, state.leadSuit);
  const basePts = H.trickPoints(state.trickPlays);
  const soldSet = new Set(isGongzhu() ? (state.sold || []) : []);
  const pts = isGongzhu()
    ? state.trickPlays.reduce((sum, p) => {
        const value = H.cardPoints(p.card);
        return sum + (soldSet.has(p.card) ? value * 2 : value);
      }, 0)
    : basePts;

  // ⚠️ 收牌动画必须在**改动 state 之前**播：动画要读桌面上的 4 张牌，
  //    而下面一改 state（收牌堆、清桌面）这 4 张牌就没了。
  await runCollectAnim(winner, pts);

  // 动画期间若已经换了局（重开/退出），这一墩的结算就不能再写进新状态里
  if (myRun !== runId) return;

  // 双份记录：
  //   collected      —— 分数累加值（侧栏"本局"列）
  //   collectedCards —— 收到的牌（拱猪结算要判满红 / 亮牌 / 变压器）
  state.collected[winner] += pts;
  state.players[winner].collected = state.collected[winner];
  //
  // ⚠️⚠️ 收墩是「赢家收走桌面**全部 4 张**牌」，不是只收他自己出的那一张。
  //
  //   曾经的写法是 `if (p.player === winner) push(p.card)` —— 只把赢家自己
  //   打出的那张记进收牌堆，另外 3 张**直接丢弃**。后果：
  //     · 一局 13 墩只收集到 13 张牌（应为 52 张），收牌堆严重残缺
  //     · 变压器在 ~68% 的局里"从未出现"（其实打出来过，只是没被记录）
  //     · 满红永远不可能达成（收不到 13 张红桃）、满贯同理
  //     · 亮牌若不在赢家自己手上，翻倍判定也会漏
  //   实测（1000 局）：平均每局只收 13.00 张，变压器无归属占 68.3%。
  for (const p of state.trickPlays) state.collectedCards[winner].push(p.card);

  if (pts && state.trickPlays.some((p) => H.isQueenOfSpades(p.card))) {
    state.queenTakenBy = winner;
  }

  // ⚠️ 动画放完 = 这 4 张牌**已经被收走**，桌面必须跟着空掉。
  //    之前这里不处理，后果是：动画结束时 is-collecting 一撤，桌面 4 张牌
  //    立刻恢复不透明，而 renderTrick() 又照 state.trickPlays 把它们留在桌上 ——
  //    观感就是「牌飞走之后又闪回一桌牌」，白留 950ms。
  //    把这一墩从 state 里撤掉，renderTrick() 的清理分支自然会把桌面清空。
  //    归属与得分在上面的 collected / collectedCards 里已经记完了，不受影响。
  state.trickPlays = [];

  const fmtPts = (v) => (v > 0 ? '+' + v : String(v));
  renderTrick();
  if (pts) {
    addLog(`${SEAT_LABEL[winner]} 收下第 ${state.trickIndex + 1} 墩，得 ${fmtPts(pts)} 分`, true);
  }
  const badScore = isGongzhu() ? pts < 0 : pts > 0;
  setHint(`${SEAT_LABEL[winner]} 收下这墩${pts ? `，得 ${fmtPts(pts)} 分` : '（无分）'}`,
    pts ? (badScore ? 'err' : 'ok') : '');

  state.leader = winner;
  state.trickIndex++;
  renderInfo();
  renderScore();
  // 收墩后停留，让玩家看清这墩的归属再进入下一墩
  await sleep(state.settings.delay ? 950 : 0);
}

/* ============================================================
 * 斗地主 · 单机（1 名玩家 + 2 个 AI）
 *
 * 与红心 / 拱猪的墩类玩法结构完全不同，所以**不复用** playLoop：
 *   · 一次动作是「一组牌」，不是一张牌 —— trickPlays 里存 {cards, combo}
 *   · 没有「收墩」，改为「连续两家不出 → 回到最后出牌的人重新首引」
 *   · 阶段是 bidding → playing → roundEnd / gameEnd，没有 selling / passing
 *
 * 推进方式沿用单机既有的「一条顺序 async 循环 + 代际作废（runId）」：
 *   轮到玩家 → 循环挂起在 waitForDdz 上，由按钮点击解除；
 *   轮到 AI   → sleep 一个观战间隔再决策。
 * 联机路径完全不经过这里 —— 那边由房主裁判推进，客户端只读房间快照。
 * ============================================================ */

/** 叫分上限：难度越低越保守（与裁判侧 aiChooseBid 同一口径）。 */
const DDZ_BID_CAP = { easy: 1, normal: 2, hard: 3 };
const ddzBidCap = () => DDZ_BID_CAP[state.difficulty] || 2;

/* 叫分阶段的节奏。刻意比出牌慢得多：叫分是「一锤子买卖」，
 * 错过就再也看不到了（用户反馈「展示叫分时间太短」）。 */
const DDZ_BID_STEP_MS = 1500;   // 每家 AI 叫分之间的观战间隔
const DDZ_BID_HOLD_MS = 1100;   // 三家叫完 → 揭晓地主之间的停顿
const DDZ_BOTTOM_HOLD_MS = 2600; // 亮底牌停多久，再飞向地主

/** 「AI 西 不叫 · AI 北 叫 2 分 · 你 1 分」—— 叫分阶段的一行摘要 */
function ddzBidSummary() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    if (!state.players[i]) continue;
    const b = (state.bids || [])[i];
    parts.push(`${SEAT_LABEL[i]} ${b == null ? '未叫' : (b ? `叫 ${b} 分` : '不叫')}`);
  }
  return parts.join(' · ');
}

const SUIT_MARK = { C: '♣', D: '♦', H: '♥', S: '♠' };

/** 斗地主牌面文字。不能走 cardText()：那里读的是 H.SUIT_SYMBOL，
 *  而斗地主模式下 rule() 返回的 DDZ 模块并没有这个常量。 */
function cardTextDdz(card) {
  if (D.isJoker(card)) return card === D.SJOKER ? '小王' : '大王';
  return (SUIT_MARK[D.suitOf(card)] || '') + D.rankOf(card);
}

/* 挂起点：{ kind: 'bid' | 'play', myRun, resolve } */
let ddzWait = null;

/**
 * 挂起当前循环，等玩家操作（叫分 / 出牌 / 不出）。
 * ⚠️ 必须同时监听代际作废（runId 变化）：切模式、重开一局都会让在途循环
 *    永远等不到点击；promise 不 resolve 就会一直挂着，并持有整份 state。
 */
function waitForDdz(kind, myRun) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (ddzWait && ddzWait.resolve === finish) ddzWait = null;
      resolve(value);
    };
    const timer = setInterval(() => { if (myRun !== runId) finish(null); }, 150);
    ddzWait = { kind, myRun, resolve: finish };
  });
}

/** 玩家做出选择 → 解除挂起。返回是否真的有人在等（避免误吞事件）。 */
function resolveDdzWait(value) {
  if (!ddzWait) return false;
  ddzWait.resolve(value);
  return true;
}

/** 发牌并进入叫分阶段。重发牌也走这里，**不增加局数**。 */
function dealDdz() {
  const deck = D.shuffle(D.createDeck());
  const hands = [[], [], []];
  for (let i = 0; i < 51; i++) hands[i % 3].push(deck[i]);
  // 直接写 p.hand 而不是 p.setHand()：setHand 内部走的是 players.js 里
  // 当前生效的规则模块（红心 / 拱猪），它的 sortHand 不认识斗地主的牌码。
  state.players.forEach((p, i) => { p.hand = D.sortHand(hands[i]); });
  state.bottom = D.sortHand(deck.slice(51));

  state.phase = 'bidding';
  state.bids = [null, null, null];
  state.bidCount = 0;
  state.bidTurn = (state.round - 1) % 3;
  state.currentBid = 0;
  state.baseBid = 1;
  state.highestBidder = -1;
  state.landlord = -1;
  state.roles = [null, null, null];
  state.turn = -1;
  state.currentCombo = null;
  state.lastPlay = null;
  state.lastLeadSeat = -1;
  state.passCount = 0;
  state.moveSeq = 0;
  state.bombCount = 0;
  state.hasRocket = false;
  state.trickPlays = [];
  state.selectedPlay = [];
  ddzLegalCache = { sig: '', cards: [] };
}

/** 单机斗地主：开新的一局 */
function startDdzRound() {
  runId++;                     // 作废在途循环（可能正挂在叫分 / 出牌上）
  resolveDdzWait(null);
  if (window.CollectAnim) window.CollectAnim.reset();

  state.round++;
  state.redealCount = 0;
  state.scores = [0, 1, 2].map((i) => (state.scores || [])[i] || 0);
  state.collected = [0, 0, 0];
  state.collectedCards = [[], [], []];
  state.sold = [];
  state.soldBy = {};
  state.selectedPass = [];
  state.selectedSell = [];
  state.lastDeltas = [0, 0, 0];
  state.busy = false;
  state.paused = false;

  const prevScores = state.scores.slice();
  state.players = [
    new HumanPlayer(0, SEAT_LABEL[0] || '你'),
    new AIPlayer(1, SEAT_LABEL[1] || 'AI 西', state.difficulty),
    new AIPlayer(2, SEAT_LABEL[2] || 'AI 北', state.difficulty),
  ];
  state.players.forEach((p, i) => { p.score = prevScores[i] || 0; });

  dealDdz();
  addLog(`第 ${state.round} 局发牌完成 · 每家 17 张，底牌 3 张`);
  applyModeChrome();
  render();

  const myRun = runId;
  ddzBidLoop(myRun).catch((e) => {
    console.error('[ddz] 叫分循环异常', e);
    setHint('斗地主出现异常：' + e.message, 'err');
  });
}

async function ddzBidLoop(myRun) {
  // 三家都不叫会重发牌，最多 3 次 —— 用外层 for 承接「重发后再叫一轮」。
  for (;;) {
    while (myRun === runId && state.phase === 'bidding' && state.bidTurn >= 0) {
      if (!(await waitForResume(myRun))) return;
      const seat = state.bidTurn;
      let bid;
      if (seat === 0) {
        openBidDialog();
        const answer = await waitForDdz('bid', myRun);
        if (myRun !== runId) return;
        if (!answer || answer.kind !== 'bid') return;
        bid = answer.bid;
      } else {
        await sleep(state.settings.delay ? DDZ_BID_STEP_MS : 0);
        if (myRun !== runId) return;
        bid = D.bidAI(state.players[seat].hand, state.currentBid, { maxBid: ddzBidCap() });
      }
      applyBid(seat, bid);
      render();
    }
    if (myRun !== runId) return;
    if (state.phase !== 'bidding') break;
    // 三家叫完先停一拍再揭晓地主：否则最后一家刚叫完座位卡立刻变成「地主」，
    // 之前那几行「叫 N 分」一闪而过，玩家根本来不及看。
    setHint(`叫分结束 · ${ddzBidSummary()}`);
    render();
    await sleep(state.settings.delay ? DDZ_BID_HOLD_MS : 0);
    if (myRun !== runId) return;
    clearManualHint();               // 让位给下面的阶段提示
    if (finishDdzBidding() === 'redeal') continue;
    break;
  }
  if (myRun !== runId || state.phase !== 'playing') return;
  // 亮底牌 → 停几秒 → 飞向地主（与收牌动画同一套视觉）
  await showDdzBottomDeal(state.landlord, myRun);
  if (myRun !== runId || state.phase !== 'playing') return;
  await ddzPlayLoop(myRun);
}

/** 记一次叫分。三家都叫完（或有人叫满 3 分）时把 bidTurn 置 -1 收口。 */
function applyBid(seat, bid) {
  const value = Math.max(0, Math.min(3, Number(bid) || 0));
  state.bids[seat] = value;
  state.bidCount = (state.bidCount || 0) + 1;
  if (value > state.currentBid) {
    state.currentBid = value;
    state.highestBidder = seat;
  }
  addLog(`${SEAT_LABEL[seat]} ${value ? `叫 ${value} 分` : '不叫'}`, !!value);
  if (value === 3 || state.bidCount >= 3) { state.bidTurn = -1; return; }
  state.bidTurn = (seat + 1) % 3;
}

/** 叫分收口：定地主、发底牌、进入出牌。返回 'playing' | 'redeal'。 */
function finishDdzBidding() {
  $('ovBid').hidden = true;

  if (state.highestBidder < 0) {
    if (state.redealCount < 3) {
      state.redealCount += 1;
      const starter = (state.round - 1) % 3;   // 重发后仍由同一起始位先叫
      addLog(`三家都不叫，重新发牌（第 ${state.redealCount} 次）`, true);
      setHint('三家都不叫，重新发牌…');
      dealDdz();
      state.bidTurn = starter;
      render();
      return 'redeal';
    }
    // 连续 3 次无人叫分 → 指定起始位以 1 分当地主，避免牌局卡死
    state.currentBid = 1;
    state.highestBidder = (state.round - 1) % 3;
    state.bids[state.highestBidder] = 1;
    addLog(`连续 ${state.redealCount} 次无人叫分，指定 ${SEAT_LABEL[state.highestBidder]} 以 1 分当地主`, true);
  }

  const landlord = state.highestBidder;
  state.landlord = landlord;
  state.baseBid = state.currentBid || 1;
  state.roles = [0, 1, 2].map((i) => (i === landlord ? 'landlord' : 'farmer'));
  state.players[landlord].hand =
    D.sortHand(state.players[landlord].hand.concat(state.bottom));

  state.phase = 'playing';
  state.turn = landlord;
  state.bidTurn = -1;
  state.currentCombo = null;
  state.lastPlay = null;
  state.lastLeadSeat = -1;
  state.passCount = 0;
  state.moveSeq = 0;
  state.trickPlays = [];
  state.selectedPlay = [];
  ddzLegalCache = { sig: '', cards: [] };

  addLog(`${SEAT_LABEL[landlord]} 成为地主（底分 ${state.baseBid}），拿走 3 张底牌`, true);
  render();
  return 'playing';
}

/** 收掉「亮底牌」展示层 */
function hideDdzDealLayer() {
  const layer = $('ddzDealLayer');
  if (!layer) return;
  layer.hidden = true;
  layer.innerHTML = '';
}

/**
 * 定完地主后：把 3 张底牌亮在牌桌中央停几秒，再飞向地主（复用收牌动画那套视觉）。
 * 动画结束后底牌仍可从手牌标题行的「底牌」按钮点开查看。
 * @param {number} landlord 本地座位号
 * @param {number} myRun    代际标记；中途换局 / 切模式就安静退出
 */
async function showDdzBottomDeal(landlord, myRun) {
  const layer = $('ddzDealLayer');
  if (!layer || landlord < 0) return;
  const cards = Array.isArray(state.bottom) ? state.bottom.slice() : [];
  if (!cards.length) return;

  layer.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'ddz-deal-row';
  const label = document.createElement('span');
  label.className = 'ddz-deal-label';
  label.textContent = `${SEAT_LABEL[landlord] || '地主'} 拿到底牌`;
  row.appendChild(label);
  const box = document.createElement('div');
  box.className = 'ddz-deal-cards';
  const els = cards.map((c) => {
    const el = cardEl(c);
    box.appendChild(el);
    return el;
  });
  row.appendChild(box);
  layer.appendChild(row);
  layer.hidden = false;

  await sleep(state.settings.delay ? DDZ_BOTTOM_HOLD_MS : 0);
  if (myRun !== runId || !isDdz()) { hideDdzDealLayer(); return; }

  if (window.CollectAnim) {
    await window.CollectAnim.play({
      winner: landlord,
      plays: cards.map((c) => ({ player: landlord, card: c })),
      sourceEls: els,
      key: `bottom:${state.round}`,
      label: SEAT_LABEL[landlord] || '',
      badgeHTML: `<span class="collect-badge-who">${escapeHtml(SEAT_LABEL[landlord] || '')}</span>` +
        `收下 ${cards.length} 张底牌`,
    });
  }
  hideDdzDealLayer();
}

/**
 * 打开叫分弹窗。
 * @param {number}   [currentBid] 联机时用房间快照里的最高分；单机省略则读本地 state
 * @param {string[]} [cards]      我的手牌；单机省略则读本地 state.players[0].hand
 *
 * ⚠️ 手牌必须搬进弹窗里展示。手机端弹窗是**底部抽屉**，会把手牌区整个盖住，
 *    而叫分恰恰是最需要看牌的时刻（有几张 2、有没有王，直接决定叫几分）。
 */
function openBidDialog(currentBid, cards) {
  const box = $('ovBid');
  if (!box) return;
  const cur = currentBid != null ? Number(currentBid) || 0 : (state.currentBid || 0);

  const mine = Array.isArray(cards) ? cards : ((state.players[0] && state.players[0].hand) || []);
  renderBidHand(mine);
  renderBidList();

  $('bidLead').textContent = cur
    ? `当前最高 ${cur} 分。你只能叫更高的分数，或选择不叫。`
    : '轮到你叫分。可以不叫，或叫 1 / 2 / 3 分（叫 3 分立即成为地主）。';
  $('bidTurnText').textContent = '轮到你叫分';
  $('bidCurrentText').textContent = cur ? `当前最高：${cur} 分` : '当前最高：不叫';
  [...$('ddzBidButtons').children].forEach((b) => {
    const v = Number(b.dataset.bid);
    b.disabled = !(v === 0 || v > cur);
  });
  box.hidden = false;
}

/** 叫分弹窗里的手牌：只作参考，不可点选 */
function renderBidHand(cards) {
  const wrap = $('bidHand');
  if (!wrap) return;
  const list = D.sortHand(cards || []);
  const label = $('bidHandLabel');
  if (label) label.textContent = `你的手牌 · ${list.length} 张`;
  wrap.innerHTML = '';
  list.forEach((c) => wrap.appendChild(cardEl(c)));
}

/** 叫分弹窗里的各家叫分一览 —— 「看不到 AI 叫了几分」的直接解法 */
function renderBidList() {
  const el = $('bidList');
  if (!el) return;
  const rows = [];
  for (let i = 0; i < 3; i++) {
    if (!state.players[i]) continue;
    const b = (state.bids || [])[i];
    const txt = b == null ? '待叫' : (b ? `叫 ${b} 分` : '不叫');
    const cls = ['ddz-bid-item', i === 0 ? 'is-me' : '',
      b == null ? 'is-wait' : (b ? 'is-bid' : 'is-pass')].filter(Boolean).join(' ');
    rows.push(`<span class="${cls}"><b>${escapeHtml(SEAT_LABEL[i])}</b><em>${txt}</em></span>`);
  }
  el.innerHTML = rows.join('');
}

async function ddzPlayLoop(myRun) {
  while (myRun === runId && state.phase === 'playing') {
    if (!(await waitForResume(myRun))) return;
    const seat = state.turn;
    if (seat === 0) {
      setHint(state.currentCombo
        ? '轮到你出牌 · 选一组能压过上一手的牌，或点「不出」'
        : '轮到你出牌 · 你首引，出任意合法牌型');
      render();
      const answer = await waitForDdz('play', myRun);
      if (myRun !== runId) return;
      if (!answer) return;
      if (answer.kind === 'pass') {
        if (!doDdzPass(0)) setHint('你是本轮首引，必须出牌。', 'err');
      } else if (!doDdzPlay(0, answer.cards)) {
        setHint('这组牌现在不能出。', 'err');
      }
    } else {
      await sleep(state.settings.delay ? 850 : 0);
      if (myRun !== runId) return;
      const p = state.players[seat];
      const cards = D.playAI(p.hand, state.currentCombo, { difficulty: state.difficulty });
      if (cards && cards.length) doDdzPlay(seat, cards);
      else doDdzPass(seat);
    }
    if (myRun !== runId) return;
    render();
  }
}

/** 出牌。返回是否真的出成功（失败时不消耗轮次，调用方可以重新等玩家选）。 */
function doDdzPlay(seat, cards) {
  const p = state.players[seat];
  if (!p || !Array.isArray(cards) || !cards.length) return false;
  const combo = D.classifyPlay(cards);
  if (!combo) return false;
  if (state.currentCombo && !D.canBeat(combo, state.currentCombo)) return false;

  const hand = p.hand.slice();
  for (const c of cards) {
    const i = hand.indexOf(c);
    if (i < 0) return false;
    hand.splice(i, 1);
  }
  p.hand = D.sortHand(hand);

  // 两家连续不出后，旧牌和「不出」先保留一个渲染周期给玩家看；
  // 只有地主/上一手领出者真正开始新一轮出牌时才清空。
  if (!state.currentCombo && state.trickPlays.some((a) => a.pass)) {
    state.trickPlays = [];
  }

  state.moveSeq++;
  state.lastPlay = { seat, cards: cards.slice(), combo };
  state.currentCombo = combo;
  state.lastLeadSeat = seat;
  state.passCount = 0;
  if (combo.type === 'bomb') state.bombCount++;
  // ⚠️ 王炸单独计 hasRocket，**不要**再加进 bombCount：
  //    计分公式是 2^(炸弹数 + 王炸?1:0)，两处都加会变成 ×4。
  //    裁判侧（net-referee.js playCards）同样是分开计的。
  if (combo.type === 'rocket') state.hasRocket = true;

  state.trickPlays.push({
    player: seat, seat, cards: cards.slice(), card: cards[0], pass: false, combo,
  });
  state.selectedPlay = [];
  clearManualHint();
  addLog(`${SEAT_LABEL[seat]} 出 ${cards.map(cardTextDdz).join(' ')}` +
    (combo.type === 'bomb' ? '（炸弹）' : (combo.type === 'rocket' ? '（王炸）' : '')), true);

  if (p.hand.length === 0) { ddzFinish(seat); return true; }
  state.turn = (seat + 1) % 3;
  return true;
}

/** 不出。首引时非法（返回 false）。连续两家不出 → 桌面清空、上一手重新首引。 */
function doDdzPass(seat) {
  if (!state.currentCombo) return false;
  state.moveSeq++;
  state.passCount++;
  state.trickPlays.push({
    player: seat, seat, cards: [], card: null, pass: true, combo: null,
  });
  clearManualHint();
  addLog(`${SEAT_LABEL[seat]} 不出`);
  if (state.passCount >= 2) {
    state.turn = state.lastLeadSeat;
    state.currentCombo = null;
    state.passCount = 0;
    // 不要此刻清空：第二家的「不出」需要先留在桌面给玩家看。
    // 下一次领出者真正出牌时，doDdzPlay() 开头再清掉旧牌与不出。
  } else {
    state.turn = (seat + 1) % 3;
  }
  return true;
}

/** 有人出完手牌 → 按「底分 × 炸弹倍数」结算，地主 / 农民两方对赌。 */
function ddzFinish(winnerSeat) {
  const landlordWin = winnerSeat === state.landlord;
  const result = D.scoreRound({
    baseBid: state.baseBid || 1,
    landlordWin,
    bombCount: state.bombCount,
    rocket: state.hasRocket,
  });
  const deltas = [0, 1, 2].map((i) =>
    (i === state.landlord ? result.landlordDelta : result.farmerDelta));

  state.players.forEach((p, i) => { p.score += deltas[i]; });
  state.scores = state.players.map((p) => p.score);
  state.lastDeltas = deltas;
  state.selectedPlay = [];

  const over = D.isGameOver(state.scores, state.targetScore || D.GAME_OVER_SCORE);
  state.phase = over ? 'gameEnd' : 'roundEnd';
  addLog(`${SEAT_LABEL[winnerSeat]} 出完手牌 · ${landlordWin ? '地主' : '农民'}获胜`, true);
  showDdzResult(deltas, result, landlordWin, winnerSeat, over);
  render();
}

/** 斗地主结果弹窗：复用 #ovResult 版式，但没有「满贯 / 满红」那套概念。 */
function showDdzResult(deltas, result, landlordWin, winnerSeat, over) {
  const fmt = (v) => (v > 0 ? '+' + v : String(v));
  const meIsLandlord = state.roles[0] === 'landlord';
  const iWon = meIsLandlord === landlordWin;
  const best = Math.max.apply(null, state.scores);
  const topSeat = state.scores.indexOf(best);

  $('resBadge').textContent = over ? '对局结束' : `第 ${state.round} 局结束`;
  $('resTitle').textContent = over
    ? (topSeat === 0 ? '你赢了' : `${SEAT_LABEL[topSeat]} 获胜`)
    : (iWon ? '本局你赢了' : '本局你输了');
  $('resSub').textContent =
    `${SEAT_LABEL[winnerSeat]} 先出完手牌，${landlordWin ? '地主' : '农民'}获胜。` +
    `底分 ${result.baseBid} · 倍数 ×${result.multiplier}` +
    `（${state.bombCount} 个炸弹${result.rocket ? ' + 王炸' : ''}）。` +
    `你的总分 ${state.scores[0]} 分。`;

  const rows = [];
  for (let i = 0; i < 3; i++) {
    const role = state.roles[i] === 'landlord' ? '地主' : '农民';
    rows.push(
      `<tr class="${i === 0 ? 'me' : ''}">` +
        `<td>${SEAT_LABEL[i]} · ${role}</td>` +
        `<td class="score-num">${fmt(deltas[i])}</td>` +
        `<td class="score-num">${state.scores[i]}</td>` +
      `</tr>`
    );
  }
  $('resBody').innerHTML = rows.join('');
  $('resNext').disabled = false;
  $('resNext').textContent = over ? '再来一局' : '继续下一局';
  $('ovResult').hidden = false;

  pushHistory({
    mode: state.mode,
    round: state.round,
    rank: iWon ? 1 : 2,
    score: state.scores[0],
    delta: deltas[0],
    diff: state.difficulty,
    final: !!over,
    ts: Date.now(),
  });
}

/* ---------- 本局结算 ----------
 * 两套玩法共用同一个结算弹窗，但结算模型不同：
 *   红心大战：collected 就是本局罚分，settleRound(number[]) 直接给 deltas
 *   拱猪：    settleRound(牌面数组) 得到 deltas，但还必须先让玩家
 *            知道「这些分数是怎么来的」——变压器翻倍会让结果与直觉
 *            完全相反（−138 分变成 −276），不展示推导过程玩家会以为
 *            是 bug。所以拱猪走两阶段：先亮明细，再应用分数。
 */
function endRound() {
  state.phase = 'roundEnd';
  const gz = isGongzhu();

  if (!gz) {
    const { deltas, shooter, shot } = H.settleRound(state.collected, state.settings.moonSelf);
    applyDeltas(deltas);
    const over = H.isGameOver(state.scores);
    showResult(deltas, { shooter, shot }, over);
    if (shot) addLog(`${SEAT_LABEL[shooter]} 收下全部 26 分，完成满贯！`, true);
    state.phase = over ? 'gameEnd' : 'roundEnd';
    render();
    return;
  }

  // ---- 拱猪 ----
  const { deltas, details, mooner } = H.settleRound(state.collectedCards, { sold: state.sold });
  showSettleDetail(deltas, details, mooner);
}

/** 把 deltas 应用到累计分 */
function applyDeltas(deltas) {
  for (let i = 0; i < 4; i++) state.players[i].score += deltas[i];
  state.scores = state.players.map((p) => p.score);
}

/* ---------- 拱猪结算明细弹窗 ---------- */
function showSettleDetail(deltas, details, mooner) {
  const fmt = (v) => (v > 0 ? '+' + v : String(v));
  const gz = isGongzhu();

  $('settleBadge').textContent = `第 ${state.round} 局收牌明细`;
  $('settleTitle').textContent = mooner >= 0
    ? `${SEAT_LABEL[mooner]} 满红！`
    : '本局各家收下的牌';

  const rows = [];
  for (let i = 0; i < 4; i++) {
    const d = details[i];

    // 亮牌直接按翻倍后的值展示（parts 里的 value 已经是 ×2 后的数），
    // 这样「明细逐条加起来」就等于右列的最终分，不会出现对不上账的困惑。
    const parts = d.parts.length
      ? d.parts.map((p) => {
          const tag = p.doubled ? ' <b class="sell-mark">亮×2</b>' : '';
          const cls = p.value > 0 ? ' pos' : (p.zero ? ' zero' : '');
          const val = p.zero ? '0' : fmt(p.value);
          return `<span class="settle-item${cls}">` +
            `${p.label} <em>${val}</em>${tag}</span>`;
        }).join('')
      : '<span class="settle-none">无分牌</span>';

    // 变压器本身 0 分，只对「持有者本局其他牌的分」生效，
    // 所以不能说成「变压器 −10」，而要写成「本局得分 ×2」——
    // 明细里已有底座分时（parts 非空）就从底座分推导，避免与逐张明细对不上账。
    const notes = [];
    if (d.moon) notes.push('<b class="moon-mark">满红 +200</b>');
    if (d.transformerEmpty) {
      notes.push(`<b class="tf-mark">含变压器（0 分）· 本局未失分，改记 +${H.TRANSFORMER_EMPTY_BONUS}</b>`);
    } else if (d.doubledBy != null) {
      notes.push(
        `<b class="tf-mark">含变压器（0 分）· 本局得分 ${fmt(d.doubledBy)} × 2 = ${fmt(deltas[i])}</b>`
      );
    }

    rows.push(
      `<tr class="${i === 0 ? 'me' : ''}">` +
        `<td>${SEAT_LABEL[i]}</td>` +
        `<td class="settle-cards">${parts}${notes.length ? '<div class="settle-notes">' + notes.join('') + '</div>' : ''}</td>` +
        `<td class="score-num"><b>${fmt(deltas[i])}</b></td>` +
      `</tr>`
    );
  }
  $('settleBody').innerHTML = rows.join('');
  $('settleFoot').textContent = '确认后分数才计入累计。';
  $('settleNext').textContent = '计入分数';
  $('ovSettle').hidden = false;

  addLog('本局结束 · 请查看收牌明细', true);
  render();
}

/** 玩家确认明细 → 真正把分数计入累计并弹出结果 */
function confirmSettle() {
  $('ovSettle').hidden = true;

  // 联机：分数由裁判算好、并且**已经计入房间累计分**（state.scores 是它的镜像）。
  // 本地既不能重算也不能再 applyDeltas 一次 —— 那会重复加分。
  if (ONLINE_ACTIVE()) {
    const v = ONLINE.getView();
    if (v && (v.phase === 'roundEnd' || v.phase === 'gameEnd')) {
      onlineSettleStage = 'result';
      showOnlineResult(v);
    }
    return;
  }

  const { deltas, details, mooner } = H.settleRound(state.collectedCards, { sold: state.sold });
  applyDeltas(deltas);

  if (mooner >= 0) addLog(`${SEAT_LABEL[mooner]} 收齐 13 张红桃，完成满红！`, true);
  const tf = details.findIndex((d) => d.transformer);
  if (tf >= 0) addLog(`${SEAT_LABEL[tf]} ${details[tf].transformer}`, true);

  const over = H.isGameOver(state.scores, state.settings.threshold);
  showResult(deltas, { shooter: -1, shot: false, mooner, details }, over);
  state.phase = over ? 'gameEnd' : 'roundEnd';
  render();
}

function showResult(deltas, extra, over) {
  const me = state.players[0];
  const gz = isGongzhu();
  const rank = H.ranking(state.scores);
  const myRank = rank.findIndex((r) => r.player === 0) + 1;
  const fmt = (v) => (v > 0 ? '+' + v : String(v));

  $('resBadge').textContent = over ? '对局结束' : `第 ${state.round} 局结束`;

  if (gz) {
    const mooner = extra.mooner;
    $('resTitle').textContent = over
      ? (myRank === 1 ? '你赢了' : `你第 ${myRank} 名`)
      : (mooner >= 0 ? `${SEAT_LABEL[mooner]} 满红` : '本局结算');
    $('resSub').textContent = over
      ? `终局线 ${state.settings.threshold} 分，累计分最高者获胜。你的总分 ${me.score} 分。`
      : (mooner >= 0
          ? `${SEAT_LABEL[mooner]} 独收 13 张红桃，红桃部分转为 +200。`
          : `你本局收下 ${fmt(deltas[0])} 分。`);
  } else {
    const { shooter, shot } = extra;
    $('resTitle').textContent = over
      ? (myRank === 1 ? '你赢了' : `你第 ${myRank} 名`)
      : (shot ? `${SEAT_LABEL[shooter]} 满贯` : '本局结算');
    $('resSub').textContent = over
      ? `最终得分最低者获胜。你的总分 ${me.score} 分。`
      : (shot
          ? `${SEAT_LABEL[shooter]} 独收 26 分，${state.settings.moonSelf ? '自己 −26 分' : '其余三家各 +26 分'}。`
          : `你本局收下 ${state.collected[0]} 分罚分。`);
  }

  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push(
      `<tr class="${i === 0 ? 'me' : ''}">` +
        `<td>${SEAT_LABEL[i]}</td>` +
        `<td class="score-num">${fmt(deltas[i])}</td>` +
        `<td class="score-num">${state.players[i].score}</td>` +
      `</tr>`
    );
  }
  $('resBody').innerHTML = rows.join('');
  // 单机没有「等房主」这一说：把联机可能留下的禁用态复位
  $('resNext').disabled = false;
  $('resNext').textContent = over ? '再来一局' : '继续下一局';
  $('ovResult').hidden = false;

  // 记入本机战绩（主页「最近战绩」与战绩面板读同一份数据）
  pushHistory({
    mode: state.mode,
    round: state.round,
    rank: myRank,
    score: state.scores[0],
    delta: deltas[0],
    diff: state.difficulty,
    final: !!over,
    ts: Date.now(),
  });
}

/* ---------- 玩家出牌 ---------- */
function onPlayCard(card) {
  const me = state.players[0];
  if (!me || state.phase !== 'playing' || activeSeat() !== 0) return;
  const legal = H.legalCards(me.hand, {
    leadSuit: state.leadSuit,
    isFirstTrick: state.trickIndex === 0,
    mustLeadClub2: state.trickIndex === 0 && state.trickPlays.length === 0,
  });
  if (!legal.includes(card)) {
    setHint('这张牌现在不能出。' + explainIllegal(card, legal), 'err');
    return;
  }
  me.submit(card);
}

/** 解释为什么某张牌不能出，用于交互反馈 */
function explainIllegal(card, legal) {
  const gz = isGongzhu();
  const isFirstTrick = state.trickIndex === 0;
  const me = state.players[0];
  const suit = H.suitOf(card);

  // 拱猪没有首墩禁红心 / 禁猪，唯一的"花色外"约束是必须跟花色
  if (!gz) {
    if (isFirstTrick && H.isHeart(card)) {
      const other = me.hand.filter((c) => !H.isHeart(c) && !H.isQueenOfSpades(c));
      if (other.length) return '第一墩不能出红心。';
    }
    if (isFirstTrick && H.isQueenOfSpades(card)) {
      const other = me.hand.filter((c) => !H.isHeart(c) && !H.isQueenOfSpades(c));
      if (other.length) return '第一墩不能出黑桃 Q。';
    }
    if (!state.leadSuit && H.isHeart(card)) {
      if (me.hand.some((c) => !H.isHeart(c))) return '首引不能出红心。';
    }
  }

  if (state.leadSuit && suit !== state.leadSuit) {
    const hasSuit = me.hand.some((c) => H.suitOf(c) === state.leadSuit);
    if (hasSuit) return `本墩必须跟出${H.SUIT_NAME[state.leadSuit]}。`;
  }
  return '';
}

/* ============================================================
 * 主屏切换 / 主页联动
 * ============================================================ */
function closeAllModals() {
  ['ovBid', 'ovBottom', 'ovPass', 'ovSell', 'ovSettle', 'ovResult'].forEach((id) => {
    $(id).hidden = true;
  });
}

/** 主页主按钮文案：有进行中的牌局时追加「继续当前对局」 */
function syncHomeCta() {
  // 斗地主的「进行中」包含叫分阶段（bidding），漏掉的话回到主页就看不到「继续」
  const hasGame = !!state.players[0] &&
    ['selling', 'passing', 'bidding', 'playing'].includes(state.phase);
  const cont = $('btnContinue');
  cont.hidden = !hasGame;
  $('btnNew').textContent = hasGame ? '重新开一局' : '开始新的一局';
}

function restorePausedModal() {
  // 斗地主：循环正挂在 waitForDdz 上等玩家操作，回主页时弹窗被 closeAllModals 收掉了，
  // 回到牌桌必须原样弹回来，否则玩家看着牌桌却没有任何可点的入口。
  if (isDdz() && state.phase === 'bidding' && state.bidTurn === 0) {
    openBidDialog();
    setHint('叫分阶段：选择不叫或叫 1 / 2 / 3 分。');
    return;
  }
  if (isDdz() && state.phase === 'playing') {
    setHint(activeSeat() === 0 ? '轮到你出牌' : '等待其他玩家出牌…');
    return;
  }
  if (state.phase === 'selling') {
    renderSellDialog();
    $('ovSell').hidden = false;
    setHint('亮牌阶段：选择要亮出的牌，或直接跳过。');
    return;
  }
  if (state.phase === 'passing') {
    const target = H.passTarget(0, state.passDirection);
    const targetName = SEAT_LABEL[target];
    $('passLead').innerHTML =
      `本局<b>${H.PASS_LABEL[state.passDirection]}</b>，` +
      `你要把 3 张牌传给 <b class="pass-target">${targetName}</b>。`;
    $('passWho').textContent = `传出对象：${targetName}`;
    renderPassDialog();
    $('ovPass').hidden = false;
    setHint(`传牌阶段：选 3 张传给${targetName}。`);
  }
}

function goHome() {
  if (state.players[0] &&
      ['selling', 'passing', 'bidding', 'playing'].includes(state.phase)) {
    state.paused = true;
  }
  closeAllModals();
  showScreen('home');
  syncHomeCta();
  renderHistory();
}

/** 结束当前对局并回到主页（分数清空，等于重来） */
function exitToHome() {
  runId++;                      // ⚠️ 必须作废在途循环，否则旧循环会写回新牌桌
  resolveDdzWait(null);         // 斗地主循环可能正挂在叫分 / 出牌上
  closeAllModals();
  state.players = [];
  state.scores = [0, 0, 0, 0];
  state.collected = [0, 0, 0, 0];
  state.collectedCards = [[], [], [], []];
  resetDdzState();
  state.round = 0;
  state.trickIndex = 0;
  state.trickPlays = [];
  state.leadSuit = null;
  state.sold = [];
  state.soldBy = {};
  state.selectedPass = [];
  state.selectedSell = [];
  state.busy = false;
  state.paused = false;
  state.phase = 'idle';
  resetTrickRender();
  hintAuto = '';
  clearManualHint();
  // 回到「未开局」的牌桌：重建一局空牌局供渲染（斗地主是三人局）
  const seats = isDdz() ? 3 : 4;
  state.players = Array.from({ length: seats }, (_, i) =>
    (i === 0 ? new HumanPlayer(0, SEAT_LABEL[0]) : new AIPlayer(i, SEAT_LABEL[i], state.difficulty)));
  $('logList').innerHTML = '<li>已退出对局，回到主页。</li>';
  render();
  goHome();
}

/* ============================================================
 * 事件绑定
 * ============================================================ */

/* ---- 手机端「隐藏式上边栏」：点一下展开 / 收起 ----
 * 收起时右半边的按钮是 display:none，点不到；点窄条本身（或它的提示箭头）
 * 展开。点按钮不切换，否则「点退出」会先被当成切换手势。 */
(function bindGameTopbarToggle() {
  const bar = document.querySelector('#screenGame > .topbar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    document.body.classList.toggle('topbar-open');
  });
})();

/* ---- 主页 → 开局 ---- */
$('btnNew').addEventListener('click', () => {
  closeAllModals();
  showScreen('game');
  newGame();
  syncHomeCta();
});

$('btnContinue').addEventListener('click', () => {
  state.paused = false;
  closeAllModals();
  showScreen('game');
  render();
  restorePausedModal();
});

/* ---- 主页配置：玩法模式 ---- */
$('homeModes').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || btn.dataset.mode === state.mode) return;
  setMode(btn.dataset.mode);
  renderHomeValues();
});

/* ---- 主页配置：AI 难度 ---- */
$('diffSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-diff]');
  if (!btn) return;
  state.difficulty = btn.dataset.diff;
  [...$('diffSeg').children].forEach((b) => b.classList.toggle('on', b === btn));
  // 已经在联机房间里（且是房主）时，把难度同步给房间 ——
  // 这就是「联机 AI 占位的水平选择」：大厅与主页两处改都会落到 settings.aiDifficulty。
  if (ONLINE_ACTIVE() && ONLINE.amHost()) {
    ONLINE.updateSettings({ aiDifficulty: state.difficulty });
  }
  renderHomeValues();
});

/* ---- 顶栏「帮助 · 设置」（更多设置入口已移除：设置项统一在主页对局选项区） ---- */
$('btnSettingsHome').addEventListener('click', () => openPanel('settings'));
$('btnSettingsGame').addEventListener('click', () => openPanel('settings'));
$('btnHelpHome').addEventListener('click', () => { switchRulesTab('rule'); openPanel('rules'); });
$('btnInfoPanel').addEventListener('click', () => openPanel('info'));

/* ---- 面板关闭：遮罩 / 关闭按钮 / 设置里的帮助入口 ---- */
$('scrim').addEventListener('click', closePanels);
document.querySelectorAll('.panel [data-close]').forEach((b) =>
  b.addEventListener('click', closePanels));
document.querySelectorAll('[data-open-rules]').forEach((b) =>
  b.addEventListener('click', () => { switchRulesTab(b.dataset.openRules || 'rule'); openPanel('rules'); }));

/* ---- 规则面板内分段 ---- */
$('rulesTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ptab]');
  if (btn) switchRulesTab(btn.dataset.ptab);
});

/* ---- 移动端底部导航：牌局回到配置，其余升起对应面板 ---- */
$('homeTabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  const t = btn.dataset.tab;
  if (t === 'play') { closePanels(); return; }
  if (t === 'rules') switchRulesTab('rule');
  openPanel(t);
});

/* ---- 游戏页顶栏 ---- */
$('btnBackHome').addEventListener('click', goHome);
$('btnExitGame').addEventListener('click', exitToHome);

/* ---- 昵称与战绩 ---- */
$('playerName').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  const name = v || '玩家昵称';
  SEAT_LABEL[0] = name;
  const echo = $('playerNameEcho');
  if (echo) echo.textContent = name;
  lsSet(LS_NAME, v);
  const me = state.players[0];
  if (me) me.name = name;
  // 同步给联机客户端：建房 / 进房时用它写入 seats，已在房里则由内部防抖写回
  if (window.NET_CLIENT) window.NET_CLIENT.setPlayerName(v || '玩家');
  render();
});
$('btnHistoryAll').addEventListener('click', () => openPanel('history'));
$('btnClearHistory').addEventListener('click', () => {
  clearHistory();
  $('btnClearHistory').textContent = '已清空';
  setTimeout(() => { $('btnClearHistory').textContent = '清空战绩记录'; }, 1400);
});

/* ---- 快捷键 ---- */
document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Escape') {
    const anyModal = ['ovPass', 'ovSell', 'ovSettle', 'ovResult'].some((id) => !$(id).hidden);
    if (anyModal) return;            // 局内弹窗交给各自的按钮处理，避免误关
    closePanels();
    return;
  }
  if (document.body.dataset.screen !== 'game') return;
  if (e.key === 'i' || e.key === 'I') openPanel('info');
  if (e.key === 'h' || e.key === 'H') { switchRulesTab('rule'); openPanel('rules'); }
});

$('passConfirm').addEventListener('click', async () => {
  // 联机：交给裁判推进（与亮牌同理，本地 confirmPass 不会写房间）
  if (ONLINE_ACTIVE()) {
    const me = state.players[0];
    const chosen = state.selectedPass.filter((c) => me.hand.includes(c)).slice(0, 3);
    if (chosen.length < 3) {
      setPassTip(`请重新选择，需选出 3 张（当前有效 ${chosen.length} 张）。`);
      renderPassDialog();
      return;
    }
    $('passConfirm').disabled = true;
    try {
      await ONLINE.submitPass(chosen);
      $('ovPass').hidden = true;
      renderOnlineTable();
    } finally {
      $('passConfirm').disabled = false;
    }
    return;
  }
  confirmPass();
});

$('passAuto').addEventListener('click', () => {
  const me = state.players[0];
  const picked = new AIPlayer(0, 'tmp', state.difficulty);
  picked.setHand(me.hand);
  state.selectedPass = picked.choosePassCards(3);
  renderPassDialog();
});

/* ---- 亮牌（拱猪） ---- */
$('sellConfirm').addEventListener('click', async () => {
  // 联机：提交给裁判（房主），由房主汇总后推进阶段。
  // 不能走本地 confirmSell —— 它会把牌写进本地 sold 并在本地跑 afterSell，
  // 房间里的 selectedSell[mySeat] 却始终是 null，阶段永远停在 selling。
  if (ONLINE_ACTIVE()) {
    const me = state.players[0];
    const picked = state.selectedSell.filter((c) => me.hand.includes(c));
    $('sellConfirm').disabled = true;
    try {
      await ONLINE.submitSell(picked);
      $('ovSell').hidden = true;
      renderOnlineTable();
    } finally {
      $('sellConfirm').disabled = false;
    }
    return;
  }
  confirmSell();
});

$('sellSkip').addEventListener('click', async () => {
  // 「不亮牌」= 提交空数组，同样是有效提交（null 才代表未提交）
  if (ONLINE_ACTIVE()) {
    state.selectedSell = [];
    syncSellSelection();
    $('sellSkip').disabled = true;
    try {
      await ONLINE.submitSell([]);
      $('ovSell').hidden = true;
      renderOnlineTable();
    } finally {
      $('sellSkip').disabled = false;
    }
    return;
  }
  state.selectedSell = [];
  syncSellSelection();
  afterSell();
});

/* ---- 拱猪结算明细 ---- */
$('settleNext').addEventListener('click', confirmSettle);

/* ---- 斗地主：叫分 / 出牌 / 不出 ----
 * 同一套按钮服务两条路径：
 *   单机 —— 解除 async 循环的挂起点，由本地 ddzBidLoop / ddzPlayLoop 推进
 *   联机 —— 直接提交给房主裁判，弹窗与按钮态由房间快照驱动
 */
$('ddzBidButtons').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-bid]');
  if (!btn || btn.disabled) return;
  const bid = Number(btn.dataset.bid);
  $('ovBid').hidden = true;

  if (!ONLINE_ACTIVE()) { resolveDdzWait({ kind: 'bid', bid }); return; }

  btn.disabled = true;
  try {
    await ONLINE.submitBid(bid);
    renderOnlineTable();
  } finally {
    btn.disabled = false;
  }
});

$('ddzPlay').addEventListener('click', async () => {
  if (ONLINE_ACTIVE()) { await submitDdzPlay(); return; }
  const cards = state.selectedPlay.slice();
  if (!cards.length) return;
  // 单机侧先本地校验一遍，给出明确原因；不合法时不消耗轮次，玩家可以改选。
  const combo = D.classifyPlay(cards);
  if (!combo) { setHint('这组牌不是合法牌型。', 'err'); return; }
  if (state.currentCombo && !D.canBeat(combo, state.currentCombo)) {
    setHint('这组牌压不过上一手。', 'err');
    return;
  }
  resolveDdzWait({ kind: 'play', cards });
});

$('ddzPass').addEventListener('click', async () => {
  if (ONLINE_ACTIVE()) { await submitDdzPass(); return; }
  resolveDdzWait({ kind: 'pass' });
});

/* ---- 斗地主：底牌改为点击查看 ----
 * 底牌不再常驻牌桌：手机端那一行会把牌桌顶部塞满，而且定完地主之后
 * 它就是一成不变的静态信息。改成牌桌只留一个入口，点了弹出小窗。 */
$('btnShowBottom').addEventListener('click', () => {
  if (!isDdz() || !state.bottom || !state.bottom.length) return;
  renderDdzBottom();
  $('ovBottom').hidden = false;
});
$('ovBottom').addEventListener('click', (e) => {
  if (e.target === $('ovBottom') || e.target.closest('[data-close-bottom]')) {
    $('ovBottom').hidden = true;
  }
});

$('resNext').addEventListener('click', async () => {
  // 联机：推进权在房主（裁判跑在他浏览器里），普通玩家点了也没用 —— 等房间阶段变化
  if (ONLINE_ACTIVE()) {
    if (!ONLINE.amHost()) return;
    const btn = $('resNext');
    btn.disabled = true;
    try {
      await ONLINE.nextRound();
      $('ovResult').hidden = true;
      renderOnlineTable();
    } finally {
      btn.disabled = false;
    }
    return;
  }

  $('ovResult').hidden = true;
  if (state.phase === 'gameEnd') newGame();
  else startRound();
  syncHomeCta();
});

$('resHome').addEventListener('click', goHome);

function bindSwitch(id, key) {
  const el = $(id);
  el.addEventListener('click', () => {
    state.settings[key] = !state.settings[key];
    el.classList.toggle('on', state.settings[key]);
    el.setAttribute('aria-checked', String(state.settings[key]));
    renderInfo();
  });
}
bindSwitch('swMoon', 'moonSelf');
bindSwitch('swPass', 'passHearts');
bindSwitch('swDelay', 'delay');
bindSwitch('swSell', 'sell');

/** 设置面板控件的选中态与当前模式对齐（开关 + 拱猪专用项 + 只读镜像） */
function syncSettingsUI() {
  const gz = isGongzhu();
  const setSw = (id, on, disabled) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-checked', String(!!on));
    el.disabled = !!disabled;
  };
  setSw('swMoon', state.settings.moonSelf);
  // 传牌开关只在红心大战显示（拱猪 / 斗地主整行隐藏，见 applyModeChrome），无需置灰
  setSw('swPass', passEnabled());
  setSw('swDelay', state.settings.delay);
  setSw('swSell', state.settings.sell);

  const inp = $('inpThreshold');
  if (inp) inp.value = state.settings.threshold;
  [...$('thresholdChips')?.children || []].forEach(
    (b) => b.classList.toggle('on', Number(b.dataset.v) === state.settings.threshold));

  // 设置面板里的只读镜像（真正的开关都在主页，这里只做汇总）
  const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const diff = DIFFICULTY[state.difficulty];
  setTxt('setModeValue', MODE_NAME[state.mode]);
  setTxt('setDiffValue', diff ? diff.label : '熟练');
  setTxt('setMoonValue', state.settings.moonSelf ? '自己 −26' : '其余三家 +26');
  setTxt('setPassValue', gz ? '不传牌' : (state.settings.passHearts ? '开启' : '关闭'));
  setTxt('setSellValue', state.settings.sell ? '开启' : '关闭');
  setTxt('setThresholdValue', String(state.settings.threshold).replace('-', '−'));
  setTxt('playerNameEcho', SEAT_LABEL[0]);

  // 主页拱猪卡上的终局线跟着设置走
  const tag = $('tagGzThreshold');
  if (tag) tag.textContent = `${state.settings.threshold} 分终局`;

  // 主页判胜提要里也带上了阈值，需要跟着刷新
  const tip = $('modeTipBody');
  if (tip && gz) tip.textContent =
    `任一家累计分 ≤ ${state.settings.threshold} 即终局，累计分最高者获胜。详细规则见「帮助」。`;
}

/** 主页上所有受配置影响的文案一起刷新 */
function renderHomeValues() { syncSettingsUI(); syncHomeCta(); }

/* ---- 拱猪终局分数 ---- */
function setThreshold(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n >= 0) {
    $('inpThreshold').value = state.settings.threshold;
    return;
  }
  state.settings.threshold = Math.round(n);
  $('inpThreshold').value = state.settings.threshold;
  [...$('thresholdChips').children].forEach((b) =>
    b.classList.toggle('on', Number(b.dataset.v) === state.settings.threshold));
  if (isGongzhu()) {
    applyModeChrome();
    renderScore();
  }
}

$('inpThreshold').addEventListener('change', (e) => setThreshold(e.target.value));
$('inpThreshold').addEventListener('input', (e) => {
  const n = Number(e.target.value);
  if (Number.isFinite(n) && n < 0) setThreshold(n);
});

$('thresholdChips').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-v]');
  if (!btn) return;
  setThreshold(btn.dataset.v);
});

/* ============================================================
 * 联机对局 —— 界面侧
 *
 * 与单人版刻意隔离：单人版的牌局推进（playLoop / playTrick）在
 * 联机模式下完全停用，权威状态由 NET_CLIENT 的房间对象提供。
 * 这里只负责把房间 → DOM。
 * ============================================================ */
const ONLINE = window.NET_CLIENT;
const ONLINE_CORE = window.NET_CORE;
const ONLINE_REF = window.NET_REFEREE;

const SEAT_NAME_ONLINE = ['南（你）', '西', '北', '东'];

/* ---------- 主页入口 ---------- */

function refreshOnlineStatus() {
  const el = $('onlineStatus');
  if (!el) return;
  const cfg = window.NET_CONFIG.getNetConfig();
  el.textContent = cfg.ready ? '已就绪' : '未配置';
  el.classList.toggle('is-ready', cfg.ready);
  el.classList.toggle('is-bad', !cfg.ready);
  const err = $('onlineError');
  if (err) {
    // 优先显示用户刚操作产生的提示（保存成功 / 连接失败 / 清除成功…），
    // 不要被 refreshOnlineStatus 覆盖掉，否则测试失败的提示会一闪而过。
    if (!holdOnlineMessage) {
      const msg = ONLINE.session.lastError || (cfg.ready ? '' : window.NET_CONFIG.netStatusText());
      err.textContent = msg;
      err.hidden = !msg;
    }
  }
}

/* 置 true 时 refreshOnlineStatus 不覆盖 #onlineError，
   让「保存并测试」的结果能停留在界面上。 */
let holdOnlineMessage = false;

function showOnlineError(msg) {
  const el = $('onlineError');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

/**
 * 用一次 PING 验证当前配置能否连通 Upstash。
 * 成功返回 true；失败返回 false（原因写进 console 便于排查）。
 */
async function testNetConnection() {
  try {
    const res = await window.NET_CORE.upstash(['PING']);
    if (String(res).toUpperCase() === 'PONG') return true;
    console.warn('[net] PING 返回非预期结果：', res);
    return false;
  } catch (e) {
    console.warn('[net] 连接测试失败：', e && (e.code || e.message), e);
    return false;
  }
}

/* ---------- 大厅渲染 ---------- */

function renderLobby() {
  const room = ONLINE.getRoom();
  if (!room) return;
  const mySeat = ONLINE.getMySeat();

  $('lobbyCode').textContent = room.code;
  // 被邀请者不给看玩法名（同 renderLobbySettings 的理由：那本来就是"房主的配置"）
  const invitedGuest = window.NET_INVITE.isInvited() && !ONLINE.amHost();
  $('lobbyModeHint').textContent = invitedGuest
    ? '由房主设定'
    : (MODE_NAME[room.mode] || '红心大战');
  $('btnStartOnline').hidden = !ONLINE.amHost();
  $('btnStartOnline').disabled = room.phase !== 'lobby';

  // 扫码邀请入口只给房主 —— 客人手里没有（也不该有）云端凭据，
  // 拼不出有效链接，给了按钮只会误导。
  const invBtn = $('btnInvite');
  if (invBtn) invBtn.hidden = !ONLINE.amHost();

  // 被邀请者：显示一条说明，告知「用的是房主的联机服务 + 局末自动清理」
  const invitedBox = $('invitedNotice');
  if (invitedBox) {
    const invited = !!window.NET_INVITE.isInvited() && !ONLINE.amHost();
    invitedBox.hidden = !invited;
    if (invited) { const ic = $('invitedCode'); if (ic) ic.textContent = room.code; }
  }

  // 座位：斗地主是三人局，只画 3 个座位
  const seatCount = room.mode === 'ddz' ? 3 : (room.seatCount || 4);
  const seatsEl = $('lobbySeats');
  const rows = [];
  for (let i = 0; i < seatCount; i++) {
    const s = room.seats[i];
    const isAI = !s && (room.aiSeats || []).includes(i);
    const cls = [
      'lobby-seat',
      i === mySeat ? 'is-me' : '',
      !s && !isAI ? 'is-empty' : '',
      isAI ? 'is-ai' : '',
    ].filter(Boolean).join(' ');

    const name = s ? s.name : (isAI ? 'AI 托管' : '空位');
    const tag = s
      ? (s.id === room.hostId ? '<span class="lobby-seat-tag is-host">房主</span>' : '')
      : (isAI ? '<span class="lobby-seat-tag is-ai">AI</span>' : '<span class="lobby-seat-tag">等待加入</span>');

    rows.push(
      `<div class="${cls}">` +
        `<span class="lobby-seat-avatar">` +
          `<svg viewBox="0 0 34 34" fill="none"><circle cx="17" cy="13" r="4.8" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 26c0-4.2 3.9-7 8.5-7s8.5 2.8 8.5 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>` +
        `</span>` +
        `<span class="lobby-seat-name">${escapeHtml(name)}${i === mySeat ? '（你）' : ''}</span>` +
        tag +
      `</div>`
    );
  }
  seatsEl.innerHTML = rows.join('');

  // 设置（仅房主可改）
  renderLobbySettings(room);

  const humans = room.seats.filter(Boolean).length;
  const note = !ONLINE.amHost()
    ? '等待房主开始对局…'
    : (room.mode === 'ddz'
        ? (humans >= 2
            ? `当前 ${humans} 位真人，空位由 AI 补到 3 人。点「开始对局」发牌。`
            : '斗地主三人局：1 位真人 + 2 个 AI 即可开局，也可以等朋友一起。')
        : (humans >= 2
            ? `当前 ${humans} 位真人，其余座位由 AI 托管。点「开始对局」发牌。`
            : '至少需要 2 位真人才能开局，其余座位由 AI 托管。'));
  $('lobbyNote').textContent = note;
}

function renderLobbySettings(room) {
  const el = $('lobbySettings');
  if (!el) return;
  const canEdit = ONLINE.amHost() && room.phase === 'lobby';
  const dis = canEdit ? '' : 'disabled';
  const mode = room.mode || 'hearts';
  const gz = mode === 'gongzhu';
  const ddz = mode === 'ddz';
  const diff = (room.settings && room.settings.aiDifficulty) || 'normal';

  // 被邀请者：用户明确要求「不能看见房主的配置信息」。
  // 注意这里不止是禁用下拉框 —— 禁用状态下 `<select>` 仍会把**房主选的值**
  // 明明白白地显示出来（截图里一眼就看见"拱猪 / 启用"）。所以对客人直接不渲染
  // 具体值，统一显示为「由房主设定」，把信息真正挡住。
  const invitedGuest = window.NET_INVITE.isInvited() && !ONLINE.amHost();
  if (invitedGuest) {
    el.innerHTML =
      `<div class="lobby-set-row"><span>玩法</span><em class="lobby-set-masked">由房主设定</em></div>` +
      `<div class="lobby-set-row"><span>玩法选项</span><em class="lobby-set-masked">由房主设定</em></div>`;
    return;
  }

  const opt = (value, label, current) =>
    `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;

  // 玩法选项：斗地主没有亮牌 / 传牌，改显示 AI 难度（托管席位的叫分与出牌强度）
  let optionRow;
  if (ddz) {
    optionRow =
      `<div class="lobby-set-row"><span>AI 难度</span>` +
        `<select id="lbDiff" ${dis}>` +
          opt('easy', '入门', diff) + opt('normal', '熟练', diff) + opt('hard', '高手', diff) +
        `</select></div>`;
  } else if (gz) {
    optionRow =
      `<div class="lobby-set-row"><span>亮牌（卖牌）</span>` +
        `<select id="lbSell" ${dis}>` +
          `<option value="1" ${room.settings.sell ? 'selected' : ''}>启用</option>` +
          `<option value="0" ${!room.settings.sell ? 'selected' : ''}>不启用</option>` +
        `</select></div>`;
  } else {
    optionRow =
      `<div class="lobby-set-row"><span>传牌</span>` +
        `<select id="lbPass" ${dis}>` +
          `<option value="1" ${room.settings.passHearts ? 'selected' : ''}>启用</option>` +
          `<option value="0" ${!room.settings.passHearts ? 'selected' : ''}>不启用</option>` +
        `</select></div>`;
  }

  el.innerHTML =
    `<div class="lobby-set-row"><span>玩法</span>` +
      `<select id="lbMode" ${dis}>` +
        opt('gongzhu', '拱猪', mode) +
        opt('hearts', '红心大战', mode) +
        opt('ddz', '斗地主（三人）', mode) +
      `</select></div>` + optionRow;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 联机牌桌渲染 ---------- */

/** 把房间视图映射成单机版 state 的形状，复用既有渲染函数 */
function syncStateFromView() {
  const v = ONLINE.getView();
  if (!v) return;
  const mySeat = ONLINE.getMySeat();

  // 座位轮转：让自己始终在下方（本地座位 0），其余按顺时针映射
  //   联机座位 i → 本地座位 (i - mySeat + N) % N
  //   ⚠️ N 必须按玩法取：斗地主是**三人局**（N = 3），红心 / 拱猪才是 4。
  //      写死 4 时，mySeat = 2 会把「联机 2 号位（就是自己）」算成本地 2 号位，
  //      对手的牌与分数全部错位 —— 三人局里压根没有第 4 个座位可供轮转。
  const N = v.mode === 'ddz' ? 3 : 4;
  const toLocal = (i) => ((i - mySeat) % N + N) % N;
  const fromLocal = (local) => ((local + mySeat) % N + N) % N;
  const handOf = (local) => v.hands[fromLocal(local)] || [];

  state.mode = v.mode;
  state.phase = v.phase === 'lobby' ? 'idle' : v.phase;
  state.round = v.round;
  state.scores = [0, 1, 2, 3].map((local) => v.scores[fromLocal(local)] || 0);
  state.trickIndex = v.trickIndex || 0;
  state.leadSuit = v.leadSuit;
  state.settings = Object.assign({}, state.settings, v.settings);
  state.settings.delay = false;   // 联机由轮询驱动，不用本地延迟
  if (isDdz()) {
    state.landlord = v.landlord != null && v.landlord >= 0 ? toLocal(v.landlord) : -1;
    state.roles = Array.from({ length: 4 }, (_, local) => (v.roles ? (v.roles[fromLocal(local)] || null) : null));
    state.bidTurn = v.bidTurn != null && v.bidTurn >= 0 ? toLocal(v.bidTurn) : -1;
    state.currentBid = v.currentBid || 0;
    // 各家叫分也要轮转 —— 叫分弹窗与座位卡都要显示「谁叫了几分」，
    // 漏掉这一项的话联机下永远显示「待叫」。
    state.bids = [0, 1, 2].map((local) => {
      const remote = fromLocal(local);
      const b = v.bids ? v.bids[remote] : null;
      return b == null ? null : Number(b);
    });
    state.highestBidder = v.highestBidder != null && v.highestBidder >= 0
      ? toLocal(v.highestBidder) : -1;
    state.currentCombo = v.currentCombo || null;
    state.lastPlay = v.lastPlay ? Object.assign({}, v.lastPlay, { player: toLocal(v.lastPlay.seat != null ? v.lastPlay.seat : v.lastPlay.player) }) : null;
    state.bottom = (v.bottom || []).slice();
    state.moveSeq = v.moveSeq || 0;
    state.bombCount = v.bombCount || 0;
    state.hasRocket = !!v.hasRocket;
    if (state.phase !== 'playing') state.selectedPlay = [];
  }

  for (let local = 0; local < 4; local++) {
    const remote = fromLocal(local);
    const p = state.players[local];
    if (!p) continue;
    p.score = v.scores[remote] || 0;
    if (local === 0) {
      p.hand = handOf(0).slice();
    } else {
      const n = v.handSizes ? v.handSizes[remote] : (v.hands[remote] || []).length;
      p.hand = new Array(n).fill('XX');
    }
  }

  state.collected = [0, 1, 2, 3].map((local) => v.collected[fromLocal(local)] || 0);
  state.collectedCards = [0, 1, 2, 3].map((local) => (v.collectedCards[fromLocal(local)] || []).slice());
  state.sold = (v.sold || []).slice();
  // ⚠️ soldBy 是「牌码 → 座位号」，且座位号是**联机座位序**，必须轮转。
  //    这里曾把 key 当成座位号轮转（`soldBy[toLocal(key)]`），而 key 其实是牌码，
  //    结果是 soldBy 里塞满了 `NaN` 键、真正的牌码查不到 → 亮牌板永远显示「—」。
  //    下面的形态判断同时兼容旧版裁判写出的「座位号 → 牌数组」。
  state.soldBy = {};
  if (v.soldBy) {
    Object.keys(v.soldBy).forEach((key) => {
      const val = v.soldBy[key];
      if (Array.isArray(val)) {
        // 旧形态：key 是联机座位号，val 是该座位亮出的牌 —— 就地摊平成新形态
        for (const card of val) state.soldBy[card] = toLocal(Number(key));
      } else if (val != null) {
        state.soldBy[key] = toLocal(Number(val));
      }
    });
  }

  // 出牌区：把远端 seat 转成本地座位
  state.trickPlays = isDdz()
    ? (v.trickPlays || []).map((p) => ({
        player: toLocal(p.seat),
        cards: (p.cards || (p.card ? [p.card] : [])).slice(),
        card: p.card,
        pass: !!p.pass,
        combo: p.combo || null,
      }))
    : (v.trickPlays || []).map((p) => ({ player: toLocal(p.seat), card: p.card }));

  // leader / turn 也要跟着转，否则 activeSeat() 算出来的「该谁出牌」会错位
  state.leader = v.leader != null ? toLocal(v.leader) : 0;
  state.onlineTurn = v.turn != null ? toLocal(v.turn) : -1;

  // 名字：本地座位 0 = 自己
  //   ⚠️ `session.playerName` 必须与主页输入框保持同步（见初始化与 input 事件），
  //      否则建房时 `seats[0].name` 存的是默认的「玩家」——
  //      房主自己在牌桌上看到的是「玩家」，别人看到的也是「玩家」。
  SEAT_LABEL[0] = ONLINE.session.playerName || '你';
  // 斗地主是三人局，本地只有 1、2 两个对手位；本地 3 号位（东座）不存在，
  // 循环上限直接跟着 N 走，免得给空座位写上一句不存在的人名。
  for (let local = 1; local < N; local++) {
    const remote = fromLocal(local);
    const s = v.seats[remote];
    // ⚠️ AI 的名字按**联机座位**取，不按本地座位。
    //    座位是轮转的（自己永远在下方），若按本地座位命名，同一个 AI 在房主手机上叫
    //    「AI 东」、在客人手机上叫「AI 北」——两台设备对不上号。
    //    固定按联机座位命名后，两台设备看到的是同一个名字。
    SEAT_LABEL[local] = s ? s.name : (v.aiSeats.includes(remote) ? AI_NAME[remote] : '空位');
  }
  // state.players[i].name 也要跟着走：它被结算表 / 日志等地方读取
  for (let local = 0; local < 4; local++) {
    if (state.players[local]) state.players[local].name = SEAT_LABEL[local];
  }

  // ⚠️ 顶栏模式标签 / 模式色 / 规则面板必须跟着**房间**走。
  //    房主建的是拱猪房、而本机默认是红心大战时，不同步就会出现
  //    「顶栏写着红心大战，牌桌却是拱猪」——亮牌条冒出变压器、轮次写「不传牌」，
  //    玩家会以为是显示错乱。放在最后调用，此时 state 已经全部同步好。
  if (document.body.dataset.mode !== v.mode) renderModeChrome(v.mode);
}

/**
 * 联机专属：确保 state.players 已按 4 席建好。
 *
 * 单人版的 players 是在 newGame() / startRound() 里建的，而联机对局的推进
 * 完全由房间驱动，本地从没跑过那两个函数 —— 如果不在这里补建，
 * 所有依赖 state.players[i].hand 的渲染（亮牌弹窗 / 传牌弹窗 / 手牌区）
 * 一上手就会读 undefined.hand 崩掉。
 *
 * 这里只保证「对象存在且是 HumanPlayer」，手牌内容由 syncStateFromView 填。
 */
function ensureOnlinePlayers() {
  if (!Array.isArray(state.players) || state.players.length !== 4
      || !state.players[0]) {
    state.players = [
      new HumanPlayer(0, SEAT_LABEL[0] || '你'),
      new AIPlayer(1, SEAT_LABEL[1] || '南', state.difficulty),
      new AIPlayer(2, SEAT_LABEL[2] || '西', state.difficulty),
      new AIPlayer(3, SEAT_LABEL[3] || '北', state.difficulty),
    ];
  }
}

function renderOnlineTable() {
  ensureOnlinePlayers();
  syncStateFromView();
  render();
  syncOnlineModals();
  syncOnlineSettlement();
  renderOnlineChrome();
  maybePlayDdzBottomDeal();
}

/** 已经为哪一局播过「亮底牌」动画（联机侧用；单机走 ddzBidLoop 里的 await） */
let ddzDealShownRound = 0;

/**
 * 联机：第一次看到本局进入 playing 就播一次亮底牌动画。
 * 不 await —— 轮询会持续重绘牌桌，动画挂在独立的 #ddzDealLayer 上，不受影响。
 */
function maybePlayDdzBottomDeal() {
  const v = ONLINE.getView();
  if (!v || v.mode !== 'ddz' || v.phase !== 'playing') return;
  if (ddzDealShownRound === v.round) return;
  if (state.landlord < 0 || !state.bottom.length) return;
  ddzDealShownRound = v.round;
  showDdzBottomDeal(state.landlord, runId);
}

/**
 * 联机专属：按房间阶段打开 / 关闭局内弹窗。
 *
 * 单人版是在 startRound() / afterSell() 里同步开弹窗的，但联机的阶段推进
 * 发生在房主浏览器（甚至别的玩家的提交里），本地 startRound 根本不会跑，
 * 于是「亮牌弹窗永远不弹、确认按钮点不动」—— 联机必须自己按 phase 驱动 UI。
 *
 * 三个约束：
 *   · 只在 game 屏生效，避免在大厅/主页把弹窗顶出来
 *   · 已提交的玩家不再弹窗，改为显示「等待其他玩家」
 *   · 回合结束 / 结算弹窗由阶段渲染负责，这里不碰，避免互相盖住
 */
function syncOnlineModals() {
  if (!ONLINE_ACTIVE()) return;
  const v = ONLINE.getView();
  if (!v) return;
  if (document.body.dataset.screen !== 'game') return;

  const mySeat = ONLINE.getMySeat();
  const submittedSell = Array.isArray(v.selectedSell[mySeat]);
  const submittedPass = Array.isArray(v.selectedPass[mySeat]);

  // ---- 叫分（斗地主）：轮到我且房间还停在 bidding 才弹 ----
  // state.bidTurn 已在 syncStateFromView 里轮转成本地座位号，
  // 为 0 就表示「房主裁判认为该我（本地 0 号位）叫分」。
  const wantBid = v.mode === 'ddz' && v.phase === 'bidding' && state.bidTurn === 0;
  const bidBox = $('ovBid');
  if (bidBox.hidden === wantBid) {
    if (wantBid) {
      state.phase = 'bidding';
      openBidDialog(v.currentBid || 0, v.hands[mySeat] || []);
      setHint('叫分阶段：选择不叫或叫 1 / 2 / 3 分。');
    } else {
      bidBox.hidden = true;
    }
  }

  // ---- 亮牌（拱猪）：未提交才弹，提交后收起 ----
  const wantSell = v.phase === 'selling' && !submittedSell;
  const sellBox = $('ovSell');
  if (sellBox.hidden === wantSell) {
    if (wantSell) {
      state.phase = 'selling';
      state.selectedSell = [];
      renderSellDialog();
      sellBox.hidden = false;
      setHint('亮牌阶段：勾选要亮出的牌（分数翻倍），或选择不亮。');
    } else {
      sellBox.hidden = true;
    }
  }

  // ---- 传牌：未提交才弹 ----
  const wantPass = v.phase === 'passing' && !submittedPass;
  const passBox = $('ovPass');
  if (passBox.hidden === wantPass) {
    if (wantPass) {
      state.phase = 'passing';
      state.selectedPass = [];
      const target = H.passTarget(0, H.PASS_CYCLE[(v.round - 1) % H.PASS_CYCLE.length]);
      const targetName = SEAT_LABEL[target] || '下家';
      $('passLead').innerHTML =
        `本局<b>${H.PASS_LABEL[v.passDirection] || '传牌'}</b>，` +
        `你要把 3 张牌传给 <b class="pass-target">${targetName}</b>。`;
      $('passWho').textContent = `传出对象：${targetName}`;
      renderPassDialog();
      passBox.hidden = false;
      setHint(`传牌阶段：选 3 张传给${targetName}。`);
    } else {
      passBox.hidden = true;
    }
  }
}

/* ---------- 联机结算 ----------
 * 单机是本地 endRound() 直接弹结算；联机不行 —— 结算发生在**房主浏览器**
 * （裁判算出 deltas 写进房间），本地 endRound 根本不会跑。
 * 所以联机必须自己按 phase 驱动：roundEnd / gameEnd → 弹出结算。
 *
 * 关键约束：
 *   · 得分一律用裁判写下的 v.lastDeltas，**不在本地重算** ——
 *     重算会与裁判漂移，而且 v.scores 已经把 deltas 计进去了，
 *     本地再 applyDeltas 一次就是重复加分。
 *   · 同一局只弹一次（onlineSettleRound 去重），否则轮询每来一帧就把
 *     弹窗内容重置一遍，玩家点按钮时会感觉「点了没反应」。
 *   · 座位要按 mySeat 轮转成本地座位号，否则分数会挂到别人名下。
 */
let onlineSettleRound = 0;      // 已经为哪一局弹过结算（0 = 还没弹过）
let onlineSettleStage = '';     // '' | 'detail'（拱猪明细）| 'result'（结果）

/** 把裁判的 deltas / details 从联机座位轮转成本地座位。
 *  ⚠️ 模数按玩法取：斗地主是三人局（N = 3），写死 4 会把分数挂到别人名下。 */
function onlineSeatRotate(arr) {
  const v = ONLINE.getView() || {};
  const N = v.mode === 'ddz' ? 3 : 4;
  const mySeat = ONLINE.getMySeat();
  const out = [];
  for (let local = 0; local < N; local++) {
    out[local] = arr[((local + mySeat) % N + N) % N];
  }
  return out;
}

function onlineDeltas(v) {
  return onlineSeatRotate(v.lastDeltas || [0, 0, 0, 0]).map((x) => x || 0);
}

function syncOnlineSettlement() {
  if (!ONLINE_ACTIVE()) return;
  const v = ONLINE.getView();
  if (!v) return;
  if (document.body.dataset.screen !== 'game') return;

  const ended = v.phase === 'roundEnd' || v.phase === 'gameEnd';
  if (!ended) {
    // 下一局已经开始（或还没打完）→ 收掉结算弹窗，并允许下一局再弹
    if (!$('ovSettle').hidden) $('ovSettle').hidden = true;
    if (!$('ovResult').hidden) $('ovResult').hidden = true;
    if (onlineSettleStage) { onlineSettleStage = ''; onlineSettleRound = 0; }
    return;
  }

  if (onlineSettleRound === v.round && onlineSettleStage) return;   // 本局已弹过

  // 结算弹窗（z-index 60）会被收牌动画层（z-index 70）压住 ——
  // 最后这一墩若是 AI 打出的（房主节拍推进），结算几乎与动画同时到，
  // 飞行中的牌和徽标就会画到弹窗上面。先把动画收干净再弹窗。
  // 用 cancelAll 而不是 reset：保留 lastKey，避免同一墩被重新触发一次。
  if (window.CollectAnim) window.CollectAnim.cancelAll();

  onlineSettleRound = v.round;

  // 拱猪先亮收牌明细（变压器翻倍会让结果与直觉相反，不展示推导会像 bug），
  // 与单机的两阶段一致。明细里的分数直接用裁判算好的，本地不重算。
  if (v.mode === 'gongzhu' && Array.isArray(v.settleDetails) && onlineSettleStage !== 'result') {
    onlineSettleStage = 'detail';
    const details = onlineSeatRotate(v.settleDetails);
    const mooner = details.findIndex((d) => d && d.moon);
    showSettleDetail(onlineDeltas(v), details, mooner);
    return;
  }

  onlineSettleStage = 'result';
  showOnlineResult(v);
}

/** 联机版结果弹窗：与单机 showResult 同款版式，但数据全部来自房间快照 */
function showOnlineResult(v) {
  const mySeat = ONLINE.getMySeat();
  const deltas = onlineDeltas(v);
  const over = v.phase === 'gameEnd';
  const gz = v.mode === 'gongzhu';
  const fmt = (x) => (x > 0 ? '+' + x : String(x));

  // 斗地主单独一条分支：DDZ 模块没有 H.ranking，而且它是「地主 / 农民两方对赌」，
  // 个人名次只有赢 / 输两种，硬套四人排名会直接抛 TypeError。
  if (v.mode === 'ddz') {
    const landlordWin = (v.landlordDelta || 0) > 0;
    const meIsLandlord = state.roles[0] === 'landlord';
    const iWon = meIsLandlord === landlordWin;
    const best = Math.max(state.scores[0] || 0, state.scores[1] || 0, state.scores[2] || 0);
    const topSeat = [0, 1, 2].find((i) => (state.scores[i] || 0) === best) || 0;
    const bombCount = v.bombCount || 0;
    const multiplier = Math.pow(2, bombCount + (v.hasRocket ? 1 : 0));

    $('resBadge').textContent = over ? '对局结束' : `第 ${v.round} 局结束`;
    $('resTitle').textContent = over
      ? (topSeat === 0 ? '你赢了' : `${SEAT_LABEL[topSeat]} 获胜`)
      : (iWon ? '本局你赢了' : '本局你输了');
    $('resSub').textContent =
      `${landlordWin ? '地主' : '农民'}获胜。底分 ${v.baseBid || 1} · 倍数 ×${multiplier}` +
      `（${bombCount} 个炸弹${v.hasRocket ? ' + 王炸' : ''}）。你的总分 ${state.scores[0]} 分。`;

    const rows = [];
    for (let i = 0; i < 3; i++) {
      const role = state.roles[i] === 'landlord' ? '地主' : '农民';
      rows.push(
        `<tr class="${i === 0 ? 'me' : ''}">` +
          `<td>${SEAT_LABEL[i]} · ${role}</td>` +
          `<td class="score-num">${fmt(deltas[i])}</td>` +
          `<td class="score-num">${state.scores[i]}</td>` +
        `</tr>`
      );
    }
    $('resBody').innerHTML = rows.join('');

    const host = ONLINE.amHost();
    $('resNext').disabled = !host;
    $('resNext').textContent = host
      ? (over ? '再来一局' : '继续下一局')
      : '等待房主开始下一局';
    $('ovResult').hidden = false;

    pushHistory({
      mode: state.mode,
      round: v.round,
      rank: iWon ? 1 : 2,
      score: state.scores[0],
      delta: deltas[0],
      diff: state.difficulty,
      final: !!over,
      ts: Date.now(),
    });
    return;
  }

  // state.scores 已在 syncStateFromView 里轮转好，直接用
  const rank = H.ranking(state.scores);
  const myRank = rank.findIndex((r) => r.player === 0) + 1;

  $('resBadge').textContent = over ? '对局结束' : `第 ${v.round} 局结束`;

  if (gz) {
    $('resTitle').textContent = over
      ? (myRank === 1 ? '你赢了' : `你第 ${myRank} 名`)
      : '本局结算';
    $('resSub').textContent = over
      ? `终局线 ${state.settings.threshold} 分，累计分最高者获胜。你的总分 ${state.scores[0]} 分。`
      : `你本局收下 ${fmt(deltas[0])} 分。`;
  } else {
    $('resTitle').textContent = over
      ? (myRank === 1 ? '你赢了' : `你第 ${myRank} 名`)
      : '本局结算';
    $('resSub').textContent = over
      ? `最终得分最低者获胜。你的总分 ${state.scores[0]} 分。`
      : `你本局收下 ${state.collected[0]} 分罚分。`;
  }

  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push(
      `<tr class="${i === 0 ? 'me' : ''}">` +
        `<td>${SEAT_LABEL[i]}</td>` +
        `<td class="score-num">${fmt(deltas[i])}</td>` +
        `<td class="score-num">${state.scores[i]}</td>` +
      `</tr>`
    );
  }
  $('resBody').innerHTML = rows.join('');

  // 只有房主能推进下一局（裁判在他浏览器里）；其他人等房间阶段变化
  const host = ONLINE.amHost();
  $('resNext').disabled = !host;
  $('resNext').textContent = host
    ? (over ? '再来一局' : '继续下一局')
    : '等待房主开始下一局';
  $('ovResult').hidden = false;

  pushHistory({
    mode: state.mode,
    round: v.round,
    rank: myRank,
    score: state.scores[0],
    delta: deltas[0],
    diff: state.difficulty,
    final: !!over,
    ts: Date.now(),
  });
}

/** 联机专属：高亮「该谁出牌」并给出轮到自己的提示 */
function renderOnlineChrome() {
  const v = ONLINE.getView();
  if (!v) return;

  if (v.phase === 'playing') {
    if (ONLINE.isMyTurn()) {
      setHint('轮到你出牌');
    } else {
      const remote = v.turn;
      const name = (v.seats[remote] && v.seats[remote].name) ||
        (v.aiSeats.includes(remote) ? 'AI ' + SEAT_NAME_ONLINE[remote] : '其他玩家');
      setHint(`${name} 正在出牌…`);
    }
  } else if (v.phase === 'selling') {
    const mine = v.selectedSell[ONLINE.getMySeat()];
    setHint(Array.isArray(mine) ? '已提交亮牌，等待其他玩家…' : '选择要亮的牌');
  } else if (v.phase === 'passing') {
    const mine = v.selectedPass[ONLINE.getMySeat()];
    setHint(Array.isArray(mine) ? '已提交传牌，等待其他玩家…' : `传 3 张牌给下家`);
  } else if (v.phase === 'roundEnd' || v.phase === 'gameEnd') {
    // 结算弹窗会盖在牌桌上，但提示条也要说清「下一步谁点」——
    // 否则非房主玩家会以为是卡住了。
    setHint(ONLINE.amHost() ? '本局结束 · 点「继续下一局」开新的一局'
                            : '本局结束 · 等待房主开始下一局');
  }
}

/* ---------- 联机动作 ---------- */

async function onlinePlayCard(card) {
  await ONLINE.playCard(card);
  renderOnlineTable();
}

async function onlineStartGame() {
  await ONLINE.startGame();
  showScreen('game');
  renderOnlineTable();
}

/* ---------- 事件接线 ---------- */

ONLINE.subscribe((kind) => {
  if (kind === 'error') { refreshOnlineStatus(); return; }
  if (kind === 'joined') {
    showScreen('lobby');
    renderLobby();
    return;
  }
  if (kind === 'left' || kind === 'closed') {
    // 离开牌桌：清掉可能在飞的收牌动画，避免残留挂到主页上
    if (window.CollectAnim) window.CollectAnim.reset();
    showScreen('home');
    syncHomeCta();
    refreshOnlineStatus();
    return;
  }
  if (kind === 'room') {
    const v = ONLINE.getView();
    if (!v) return;
    if (v.phase === 'lobby') {
      if ($('screenLobby').hidden === false) renderLobby();
      else { showScreen('lobby'); renderLobby(); }
    } else {
      if (!$('screenGame').hidden) renderOnlineTable();
      else { showScreen('game'); renderOnlineTable(); }
    }

    // 终局（gameEnd）→ 被邀请者本机立即销毁房间信息，只留战绩。
    // 放在这里而不是结算弹窗里，是为了覆盖「对方结束、我没点弹窗」的场景。
    if (v.phase === 'gameEnd') destroyInvitedRoomData();
  }
});

/* ---------- 扫码邀请 ---------- */

/**
 * 房主：生成邀请二维码与链接。
 *
 * 链接里带的是「房主的云端凭据 + 房间码」，这样朋友扫码就能连到同一份数据。
 * 这是无服务端架构的必然：没有我们自己的服务器，就只能共用一套存储凭据。
 * 界面上会明确提示房主「链接含凭据，只发给信任的人」。
 */
function openInviteModal() {
  const cfg = window.NET_CONFIG.getNetConfig();
  const code = ONLINE.session.code;
  if (!cfg.ready || !code) { showOnlineError('请先配置联机服务并建房。'); return; }

  const link = window.NET_INVITE.buildLink({
    url: cfg.url, token: cfg.token, prefix: cfg.prefix || 'ncm:', code,
  });

  $('inviteLink').value = link;
  { const ic = $('inviteCode'); if (ic) ic.textContent = code; }

  const cv = $('inviteQr');
  // ⚠️ margin 至少要 4 个模块，否则手机相机难以定位静区（规范要求 ≥4）。
  //    scale 用 4：v6 左右的中长链接约 41 模块，(41+8)*4 ≈ 196px，够清晰又不会
  //    超出弹窗。CSS 那边只做等比约束（max-width/max-height），不再写死宽高，
  //    否则位图尺寸与显示尺寸不一致，会被插值糊掉。
  const okDraw = window.QRCode.draw(cv, link, {
    scale: 4, margin: 4, dark: '#14181F', light: '#FFFFFF',
  });
  if (!okDraw) {
    // 内容超长（极长的 Token）时二维码装不下 —— 退化为只给链接，别让用户对着空图发愣
    cv.hidden = true;
    showOnlineError('链接过长，二维码装不下，请直接复制链接发送。');
  } else {
    cv.hidden = false;
  }
  $('ovInvite').hidden = false;
}

function closeInviteModal() {
  $('ovInvite').hidden = true;
}

/**
 * 被邀请者：页面加载时若地址带邀请信息，先走「确认页」而不是直接进房。
 *
 * 用户明确要求「先确认再进房」，所以这里只把房间号与昵称亮出来让 TA 看一眼，
 * 点「进入房间」才真正用这份凭据去连接。
 */
function handleInviteOnLoad() {
  const info = window.NET_INVITE.consumeInvite();
  if (!info || !info.url || !info.token || !info.code) return false;

  // ⚠️ 关键：把凭据放进内存，**不写 localStorage、不回显到任何输入框**。
  // 这样被邀请者在界面上、在控制台里都翻不到房主的云端配置。
  window.NET_INVITE.setPending(info);

  { const jc = $('joincCode'); if (jc) jc.textContent = String(info.code).toUpperCase(); }
  $('joincName').value = loadPlayerName();

  const err = $('joincError');
  if (err) { err.hidden = true; err.textContent = ''; }

  showScreen('join');
  return true;
}

/** 被邀请者：确认后正式进房 */
async function acceptInvite() {
  const info = window.NET_INVITE.getPending();
  if (!info) return;
  const name = ($('joincName').value || '').trim().slice(0, 10) || '玩家';
  SEAT_LABEL[0] = name;
  lsSet(LS_NAME, name);
  const me = state.players[0];
  if (me) me.name = name;
  window.NET_CLIENT.setPlayerName(name);

  const err = $('joincError');
  const fail = (m) => {
    if (err) { err.textContent = m; err.hidden = !m; }
  };
  fail('');

  const room = await ONLINE.joinRoom(String(info.code).toUpperCase());
  if (!room) {
    fail(ONLINE.session.lastError || '加入失败，请确认房主还在房间里。');
    return;
  }
  showScreen('lobby');
  renderLobby();
  refreshOnlineStatus();
}

/** 被邀请者：放弃加入 → 清掉内存里的凭据，回主页 */
function declineInvite() {
  window.NET_INVITE.clearPending();
  showScreen('home');
  syncHomeCta();
  refreshOnlineStatus();
}

/* ---------- 局末数据销毁（被邀请者） ---------- */

/**
 * 对局结束时，被邀请者本机不保留房间信息（用户要求「结束即销毁，但保留战绩」）。
 *
 * 「销毁」= 清掉房间码 / 云端凭据引用 / 会话状态；
 * 「保留战绩」= 本局比分照常写进历史记录（renderHistory 那条链路），不受影响。
 *
 * 房主不销毁：房间是他的，由他自己决定何时解散（离开房间即删除）。
 */
function destroyInvitedRoomData() {
  if (!window.NET_INVITE.isInvited()) return;
  if (ONLINE.amHost()) return;

  window.NET_INVITE.clearPending();
  // 本地不留房间记忆：清掉可能残留的会话字段
  try {
    ONLINE.session.code = null;
    ONLINE.session.room = null;
    ONLINE.session.view = null;
  } catch (_) { /* 只读场景忽略 */ }
}

function initOnlineUI() {
  if (!$('btnCreateRoom')) return;

  $('btnCreateRoom').addEventListener('click', async () => {
    showOnlineError('');
    // 建房用主页当前选中的玩法（含斗地主），并把主页的 AI 难度一起带进房间 ——
    // 托管席位（含 AI 占位）的叫分上限与出牌强度都读 settings.aiDifficulty。
    await ONLINE.createRoom(state.mode, state.difficulty);
  });

  $('btnJoinRoom').addEventListener('click', () => {
    const box = $('onlineJoin');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      showOnlineError('');                  // 收起时残留的报错要清掉
      $('roomCodeInput').focus();
    }
  });

  $('btnJoinCancel').addEventListener('click', () => {
    $('onlineJoin').hidden = true;
    $('roomCodeInput').value = '';
    showOnlineError('');
  });

  /* ---- 联机服务配置面板 ---- */
  $('btnNetSetup').addEventListener('click', () => {
    const box = $('netSetup');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      const cfg = window.NET_CONFIG.getNetConfig();
      $('netUrl').value = cfg.url || '';
      $('netToken').value = cfg.token || '';
      showOnlineError('');
      $('netUrl').focus();
    }
  });

  $('btnNetSave').addEventListener('click', async () => {
    const url = $('netUrl').value.trim().replace(/\/+$/, '');
    const token = $('netToken').value.trim();
    if (!url || !token) { showOnlineError('URL 和 Token 都要填。'); return; }
    if (!/^https?:\/\//i.test(url)) { showOnlineError('URL 需要以 https:// 开头。'); return; }
    window.NET_CONFIG.setNetConfig({ url, token, prefix: 'ncm:' });

    holdOnlineMessage = true;                 // 结果提示要留住
    showOnlineError('正在测试连接…');
    const okc = await testNetConnection();
    if (okc) {
      $('netSetup').hidden = true;
      refreshOnlineStatus();                  // 先刷新 badge
      holdOnlineMessage = false;
      showOnlineError('连接成功，联机服务已就绪。');
      setTimeout(() => { if (!ONLINE.session.lastError) showOnlineError(''); }, 4000);
    } else {
      refreshOnlineStatus();
      holdOnlineMessage = false;
      showOnlineError('连接失败：请检查 URL / Token 是否复制完整（详见浏览器控制台）。');
    }
  });

  $('btnNetClear').addEventListener('click', () => {
    window.NET_CONFIG.setNetConfig(null);   // 清除后回落到 net-config.js 常量
    $('netUrl').value = '';
    $('netToken').value = '';
    holdOnlineMessage = true;
    refreshOnlineStatus();
    holdOnlineMessage = false;
    showOnlineError('已清除本机保存的凭据。');
  });

  $('netToken').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnNetSave').click();
  });

  $('btnJoinGo').addEventListener('click', async () => {
    showOnlineError('');
    await ONLINE.joinRoom($('roomCodeInput').value);
  });

  $('roomCodeInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { showOnlineError(''); await ONLINE.joinRoom($('roomCodeInput').value); }
  });
  $('roomCodeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });

  $('btnLobbyBack').addEventListener('click', async () => {
    await ONLINE.leaveRoom();
    showScreen('home');
    syncHomeCta();
    refreshOnlineStatus();
  });

  $('btnLeaveRoom').addEventListener('click', async () => {
    await ONLINE.leaveRoom();
    showScreen('home');
    syncHomeCta();
    refreshOnlineStatus();
  });

  $('btnCopyCode').addEventListener('click', async () => {
    const code = ONLINE.session.code || '';
    try {
      await navigator.clipboard.writeText(code);
      $('btnCopyCode').textContent = '已复制';
      setTimeout(() => { $('btnCopyCode').textContent = '复制房间码'; }, 1400);
    } catch (_) {
      showOnlineError('复制失败，请手动记下：' + code);
    }
  });

  $('btnStartOnline').addEventListener('click', onlineStartGame);

  /* ---- 扫码邀请（房主） ---- */
  if ($('btnInvite')) $('btnInvite').addEventListener('click', openInviteModal);
  if ($('btnCopyInvite')) {
    $('btnCopyInvite').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('inviteLink').value);
        $('btnCopyInvite').textContent = '已复制';
        setTimeout(() => { $('btnCopyInvite').textContent = '复制'; }, 1400);
      } catch (_) {
        $('inviteLink').select();
        showOnlineError('复制失败，请手动选中链接复制。');
      }
    });
  }
  if ($('ovInvite')) {
    $('ovInvite').addEventListener('click', (e) => {
      if (e.target === $('ovInvite') || e.target.closest('[data-close-invite]')) closeInviteModal();
    });
  }

  /* ---- 扫码加入确认（被邀请者） ---- */
  if ($('btnJoincGo')) $('btnJoincGo').addEventListener('click', acceptInvite);
  if ($('btnJoincCancel')) $('btnJoincCancel').addEventListener('click', declineInvite);

  // 大厅设置项（事件委托，因为设置区会重绘）
  $('lobbySettings').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'lbMode') await ONLINE.setMode(t.value);
    else if (t.id === 'lbSell') await ONLINE.updateSettings({ sell: t.value === '1' });
    else if (t.id === 'lbPass') await ONLINE.updateSettings({ passHearts: t.value === '1' });
    else if (t.id === 'lbDiff') await ONLINE.updateSettings({ aiDifficulty: t.value });
  });

  refreshOnlineStatus();
}

/* ============================================================
 * 初始化
 * ============================================================ */
const savedName = loadPlayerName();
SEAT_LABEL[0] = savedName;
$('playerName').value = savedName;
$('playerNameEcho').textContent = savedName;
// ⚠️ 必须把已保存的昵称同步给联机客户端。建房时 `seats[0].name` 取的就是
//    `session.playerName`，漏掉这一步的话它一直是默认的「玩家」——
//    表现是房主在牌桌上看到自己叫「玩家」，别人看到的也是「玩家」。
if (window.NET_CLIENT) window.NET_CLIENT.setPlayerName(savedName);

state.players = [0, 1, 2, 3].map((i) =>
  i === 0 ? new HumanPlayer(0, savedName) : new AIPlayer(i, SEAT_LABEL[i], state.difficulty));

applyModeChrome();
renderModeChrome();
renderHistory();
switchRulesTab('rule');
render();
syncHomeCta();
showScreen('home');
initOnlineUI();

// 扫码邀请：地址里带 #join=... 就先进确认页（必须在 showScreen('home') 之后，
// 否则会被那句覆盖回主页）。
handleInviteOnLoad();
refreshOnlineStatus();

/* 暴露给自动化测试 */
window.__game = {
  state, newGame, startRound, onPlayCard, confirmPass,
  confirmSell, afterSell, toggleSellCard, confirmSettle, setMode, setThreshold,
  togglePassCard,
  legalCards: (hand, ctx) => H.legalCards(hand, ctx),
  HEARTS, GONGZHU,
  rulesNow: rule,
  render, renderTrick, renderScore, renderInfo, resetTrickRender,
  renderSoldBoard, renderWonCards, renderMyRoundScore,
  // 收牌动画（调试 / 测试用）
  COLLECT: window.CollectAnim,
  runCollectAnim, maybeCollectAnimOnline,
  club2Holder, passEnabled, activeSeat,
  humanTurnHint,          // 供自动化校验提示文案
  setDifficulty: (d) => { state.difficulty = d; },
  setPlayerName: (n) => {
    SEAT_LABEL[0] = n || '玩家昵称';
    lsSet(LS_NAME, n || '');
    const me = state.players[0];
    if (me) me.name = SEAT_LABEL[0];
    render();
  },
  // 新版外壳
  showScreen, openPanel, closePanels, goHome, exitToHome,
  switchRulesTab, loadHistory, clearHistory, renderHistory, syncHomeCta,
  renderHintbar, hintState: () => ({ manual: hintManual, auto: hintAuto, kind: hintKind }),
  clearManualHint,          // 测试里清掉手工提示，好断言自动提示文案
  ddzHasBeat,               // 斗地主：我当前有没有能压过上一手的牌
  // 联机
  syncStateFromView, renderOnlineTable, renderLobby, ONLINE,
  // 扫码邀请
  openInviteModal, closeInviteModal, handleInviteOnLoad, acceptInvite, declineInvite,
  destroyInvitedRoomData, INVITE: window.NET_INVITE,
};

})();
