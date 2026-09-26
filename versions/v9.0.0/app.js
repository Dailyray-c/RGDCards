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

const RULES_BY_MODE = { hearts: HEARTS, gongzhu: GONGZHU };

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
function cardEl(card, { playable, picked, blocked, sold } = {}) {
  const suit = H.suitOf(card);
  const rank = H.rankOf(card);
  const el = document.createElement('div');
  el.className = 'card ' + (H.SUIT_IS_RED[suit] ? 'red' : 'black');
  if (playable) el.classList.add('playable');
  if (picked) el.classList.add('picked');
  if (blocked) el.classList.add('blocked');
  if (sold) el.classList.add('is-sold');
  el.dataset.card = card;
  el.innerHTML =
    `<div class="card-corner tl">` +
      `<span class="card-rank">${rank}</span>${suitSvg(suit)}` +
    `</div>` +
    suitSvgBig(suit) +
    `<div class="card-corner br">` +
      `<span class="card-rank">${rank}</span>${suitSvg(suit)}` +
    `</div>`;
  return el;
}

/* ============================================================
 * 游戏状态
 * ============================================================ */
const state = {
  mode: 'hearts',       // 'hearts' | 'gongzhu'
  players: [],
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

/* 传牌开关按模式分开存：
 *   红心大战默认传牌（标准规则），拱猪**没有传牌规则**。
 *   分开关的好处是「切回红心大战」时能恢复原来的勾选，而不是被拱猪覆盖成关。 */
const passEnabled = () => (isGongzhu() ? false : state.settings.passHearts !== false);

/* 当前生效的规则模块。所有规则调用都通过它取，写死 H 就会串规则。 */
function rule() { return RULES_BY_MODE[state.mode] || HEARTS; }
const isGongzhu = () => state.mode === 'gongzhu';

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

/** 切换玩法模式。
 * ⚠️ 只切模式与文案，**不自动开局** —— 玩家必须点「新的一局」才开始。
 *    否则误点一下顶栏就把进行中的牌局冲掉了。 */
function setMode(key) {
  const k = RULES_BY_MODE[key] ? key : 'hearts';
  if (state.mode === k) return;
  state.mode = k;
  setRules(k);

  // 上一局的残留（传牌窗 / 亮牌窗 / 结算窗）必须关掉，否则会盖在新桌面上
  $('ovPass').hidden = true;
  $('ovSell').hidden = true;
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
  state.players = [];
  state.scores = [0, 0, 0, 0];
  state.collected = [0, 0, 0, 0];
  state.collectedCards = [[], [], [], []];
  state.round = 0;
  state.trickIndex = 0;
  state.trickPlays = [];
  state.leadSuit = null;
  state.sold = [];
  state.soldBy = {};
  state.selectedPass = [];
  state.selectedSell = [];
  state.busy = false;
  state.phase = 'idle';
  resetTrickRender();

  applyModeChrome();
  renderModeChrome(k);
  render();

  const name = k === 'gongzhu' ? '拱猪' : '红心大战';
  $('logList').innerHTML = `<li>已切换到「${name}」，点「新的一局」开始。</li>`;
  setHint(`已切换到「${name}」· 点「新的一局」开始发牌。`);
}

/** 顶栏标题 / 分段控件的高亮 / 难度与传牌等控件联动 */
function renderModeChrome(k = state.mode) {
  [...$('modeSeg').children].forEach(
    (b) => b.classList.toggle('on', b.dataset.mode === k));
  document.title = k === 'gongzhu' ? '拱猪' : '红心大战 / 拱猪';
  $('brandTitle').textContent = k === 'gongzhu' ? '拱猪' : '红心大战';
  $('brandSub').textContent = k === 'gongzhu'
    ? 'Gongzhu · 猪羊变压器' : 'Hearts · 经典四人牌局';
  syncSettingsUI();
}

/** 按模式调整文案与显隐（不重开局时也调用） */
function applyModeChrome() {
  const gz = isGongzhu();
  $('gzOptions').hidden = !gz;
  $('rowSell').hidden = !gz;
  $('rowHearts').hidden = false;
  $('rowQueen').hidden = false;
  $('rowExtra').hidden = false;
  // 拱猪没有传牌规则 → 「传牌方向」这一行直接隐藏
  $('rowPass').hidden = gz;

  if (gz) {
    $('kHearts').textContent = '已收红桃';
    $('kQueen').textContent = '猪 / 羊';
    $('kExtra').textContent = '变压器';
    $('scorePanelSub').innerHTML = `满 <span id="targetScore">${state.settings.threshold}</span> 分终局`;
  } else {
    $('kHearts').textContent = '红心已出';
    $('kQueen').textContent = '黑桃 Q';
    $('kExtra').textContent = '满贯处理';
    $('scorePanelSub').innerHTML = `满 <span id="targetScore">100</span> 分终局`;
  }

  // 规则弹窗：只显示当前模式的规则
  $('rulesTitle').textContent = gz ? '拱猪规则' : '红心大战规则';
  $('rulesLead').textContent = gz
    ? '四人各 13 张牌，不传牌；目标是尽量少收负分、多收正分。'
    : '四人各 13 张牌，目标是尽量少收罚分。';
  $('rulesHearts').hidden = gz;
  $('rulesGongzhu').hidden = !gz;

  syncSettingsUI();
}

/* ============================================================
 * 渲染
 * ============================================================ */
const SEAT_LABEL = ['你', 'AI 西', 'AI 北', 'AI 东'];

function render() {
  renderSeats();
  renderScore();
  renderInfo();
  renderSoldBoard();
  renderHand();
  renderWonCards();
  renderTrick();
}

function renderSeats() {
  for (let i = 1; i <= 3; i++) {
    const p = state.players[i];
    if (!p) continue;
    $('name' + i).textContent = SEAT_LABEL[i];
    $('hand' + i).textContent = p.handSize + ' 张';
    $('score' + i).textContent = p.score + ' 分';

    const tag = $('tag' + i);
    const isActive = state.phase === 'playing' && state.players[activeSeat()] === p;
    if (isActive) {
      tag.textContent = '思考中';
      tag.classList.add('thinking');
      $('seat' + i).classList.add('active');
    } else {
      tag.textContent = state.phase === 'playing' ? '等待'
        : state.phase === 'idle' ? '等待' : '出牌';
      tag.classList.remove('thinking');
      $('seat' + i).classList.remove('active');
    }

    // 剩余牌背
    const mini = $('mini' + i);
    const want = p.handSize;
    if (mini.childElementCount !== want) {
      mini.innerHTML = '<div class="mini-back"></div>'.repeat(want);
    }
  }
}

function renderScore() {
  const gz = isGongzhu();
  const rows = [];
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
  const gz = isGongzhu();
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
 * 只显示「有分值的牌」还是「全部收到的牌」？
 *   → 显示全部。玩家需要看清自己到底收了些什么，
 *     只挑有分牌会让人误以为漏收/多收。
 * 牌面用极小尺寸的只读卡片，角标仍可读。
 */
function renderWonCards() {
  const gz = isGongzhu();
  for (let i = 0; i < 4; i++) {
    const box = $('won' + i);
    if (!box) continue;
    const cards = (state.collectedCards && state.collectedCards[i]) || [];

    if (!state.players[i] || state.phase === 'idle' || !cards.length) {
      box.hidden = true;
      box.innerHTML = '';
      continue;
    }

    box.hidden = false;
    // 有分值的牌排在前面，一眼看出"收到了什么要紧的"
    const sorted = cards.slice().sort((a, b) => {
      const pa = Math.abs(H.cardPoints(a)), pb = Math.abs(H.cardPoints(b));
      if (pa !== pb) return pb - pa;
      return H.RANK_VALUE[H.rankOf(b)] - H.RANK_VALUE[H.rankOf(a)];
    });

    const soldSet = new Set(gz ? (state.sold || []) : []);
    // 拱猪里「猪 / 羊 / 变压器 / 红桃」才是玩家在意的，标记出来
    box.innerHTML =
      `<span class="won-label">已收 ${cards.length} 张</span>` +
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
  if (!me) return;

  const isMyTurn = state.phase === 'playing' && activeSeat() === 0;
  const legal = isMyTurn ? H.legalCards(me.hand, {
    leadSuit: state.leadSuit,
    isFirstTrick: state.trickIndex === 0,
    mustLeadClub2: state.trickIndex === 0 && state.trickPlays.length === 0,
  }) : [];

  $('handTitle').textContent = `你的手牌 · ${me.hand.length} 张`;
  $('handHint').textContent = isMyTurn
    ? `可出 ${legal.length} 张` + (
        state.leadSuit
          ? (me.hand.some((c) => H.suitOf(c) === state.leadSuit)
              ? `（须跟${H.SUIT_NAME[state.leadSuit]}）`
              : `（已无${H.SUIT_NAME[state.leadSuit]}，可垫牌）`)
          : '（你首引）'
      )
    : (isGongzhu() && state.sold && state.sold.length
        ? `本局已亮：${state.sold.map((c) => H.SELL_LABEL[c] || cardText(c)).join('、')}`
        : '');

  const soldSet = new Set(state.sold || []);
  for (const c of me.hand) {
    const can = isMyTurn && legal.includes(c);
    const el = cardEl(c, {
      playable: can,
      blocked: isMyTurn && !can,
      sold: soldSet.has(c),
    });
    if (can) el.addEventListener('click', () => onPlayCard(c));
    wrap.appendChild(el);
  }
}

/* 增量渲染出牌区。
 * 关键：已落桌的牌不重建 DOM，只追加新牌 —— 否则每出一张牌，
 * 前面几张会被销毁重建、进场动画重播，表现为整桌牌一起闪烁。
 * 用一个签名标记哪些牌已渲染，避免重复插入。
 */
let renderedTrickKeys = new Set();

function resetTrickRender() {
  renderedTrickKeys = new Set();
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

function renderTrick() {
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

  const note = $('trickNote');
  const fmtPts = (v) => (v > 0 ? '+' + v : String(v));
  const gz = isGongzhu();
  // 拱猪里亮过的牌分数翻倍 → 墩分也要按翻倍后的值报，否则与侧栏对不上账
  const soldSet = new Set(gz ? (state.sold || []) : []);
  const livePts = (plays) => plays.reduce((sum, p) => {
    const base = H.cardPoints(p.card);
    return sum + (soldSet.has(p.card) ? base * 2 : base);
  }, 0);

  if (state.phase === 'idle') note.textContent = '点击「新的一局」开始';
  else if (state.phase === 'selling') note.textContent = '亮牌阶段（拱猪）';
  else if (state.phase === 'passing') note.textContent = '传牌阶段';
  else if (state.trickPlays.length === 0) note.textContent = `第 ${state.trickIndex + 1} 墩 · ${SEAT_LABEL[activeSeat()]} 首引`;
  else if (state.trickPlays.length < 4) {
    const pts = livePts(state.trickPlays);
    const w = H.trickWinner(state.trickPlays, state.leadSuit);
    note.textContent = `第 ${state.trickIndex + 1} 墩 · 已出 ${state.trickPlays.length} 张` +
      ` · 暂时领先 ${SEAT_LABEL[w]}` + (pts ? ` · 本墩 ${fmtPts(pts)} 分` : '');
  } else {
    const w = H.trickWinner(state.trickPlays, state.leadSuit);
    const pts = livePts(state.trickPlays);
    note.textContent = `${SEAT_LABEL[w]} 收下这墩${pts ? `，得 ${fmtPts(pts)} 分` : '（无分）'}`;
  }
}

function setHint(text, kind = '') {
  $('hintText').textContent = text;
  $('hintbar').className = 'hintbar' + (kind ? ' ' + kind : '');
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
  return state.trickPlays.length
    ? (state.leader + state.trickPlays.length) % 4
    : state.leader;
}

/* ============================================================
 * 游戏流程
 * ============================================================ */
function newGame() {
  state.scores = [0, 0, 0, 0];
  state.round = 0;
  state.sold = [];
  state.phase = 'idle';
  state.busy = false;
  $('logList').innerHTML = `<li>新对局开始 · ${isGongzhu() ? '拱猪' : '红心大战'}。</li>`;
  startRound();
}

function startRound() {
  // 作废上一局可能仍在跑的循环（例如结算动画未完就点了「新的一局」）
  runId++;
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
 * 避免第二局沿用上一局的牌元素导致点选错牌。 */
function renderSellDialog() {
  const me = state.players[0];
  const wrap = $('sellCards');
  const sellables = me.hand.filter((c) => H.isSellable(c));

  const sig = me.hand.join(',');
  if (wrap.dataset.sig !== sig) {
    wrap.innerHTML = '';
    if (!sellables.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = '你手里没有可亮的牌（猪 / 羊 / 变压器 / 红桃A）。';
      wrap.appendChild(note);
    }
    for (const c of sellables) {
      const el = cardEl(c, { playable: true });
      el.addEventListener('click', () => toggleSellCard(el.dataset.card));
      wrap.appendChild(el);
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
    if (myRun !== runId) return;      // 已被新的一局取代，安静退出
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

async function playTrick(myRun) {
  state.trickPlays = [];
  state.leadSuit = null;
  resetTrickRender();     // 新一墩：清空出牌区并重置渲染标记
  render();

  for (let k = 0; k < 4; k++) {
    if (myRun !== runId) return;    // 这一局已被取代
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
      if (myRun !== runId) return;   // 思考期间可能已经开了新局
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

    render();

    // 出一张牌后留出观战间隔，方便玩家看清这手牌是什么
    if (k < 3) await sleep(state.settings.delay ? 620 : 0);
  }

  if (myRun !== runId) return;

  // 结算这一墩前多停一拍，让最后一手牌看得清楚
  await sleep(state.settings.delay ? 850 : 0);
  if (myRun !== runId) return;
  if (state.trickPlays.length !== 4) return;   // 状态不完整则不结算，交给新循环
  const winner = H.trickWinner(state.trickPlays, state.leadSuit);
  const pts = H.trickPoints(state.trickPlays);

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

  const fmtPts = (v) => (v > 0 ? '+' + v : String(v));
  renderTrick();
  if (pts) {
    addLog(`${SEAT_LABEL[winner]} 收下第 ${state.trickIndex + 1} 墩，得 ${fmtPts(pts)} 分`, true);
  }
  setHint(`${SEAT_LABEL[winner]} 收下这墩${pts ? `，得 ${fmtPts(pts)} 分` : '（无分）'}`,
    pts > 0 ? 'err' : 'ok');

  state.leader = winner;
  state.trickIndex++;
  renderInfo();
  renderScore();
  // 收墩后停留，让玩家看清这墩的归属再进入下一墩
  await sleep(state.settings.delay ? 950 : 0);
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
          return `<span class="settle-item${p.value > 0 ? ' pos' : ''}">` +
            `${p.label} <em>${fmt(p.value)}</em>${tag}</span>`;
        }).join('')
      : '<span class="settle-none">无分牌</span>';

    // 变压器：说清是「翻倍」还是「无分改为 +50」，两者含义完全不同
    const notes = [];
    if (d.moon) notes.push('<b class="moon-mark">满红 +200</b>');
    if (d.transformerEmpty) {
      notes.push(`<b class="tf-mark">变压器 · 本局未扣分，改为 +${H.TRANSFORMER_EMPTY_BONUS}</b>`);
    } else if (d.doubledBy) {
      notes.push(`<b class="tf-mark">变压器 · ${fmt(d.doubledBy)} × 2 = ${fmt(deltas[i])}</b>`);
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
  const { deltas, details, mooner } = H.settleRound(state.collectedCards, { sold: state.sold });
  $('ovSettle').hidden = true;
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
  $('resNext').textContent = over ? '再来一局' : '继续下一局';
  $('ovResult').hidden = false;
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
 * 事件绑定
 * ============================================================ */
$('btnNew').addEventListener('click', () => {
  $('ovPass').hidden = true;
  $('ovSell').hidden = true;
  $('ovResult').hidden = true;
  $('ovSettle').hidden = true;
  newGame();
});

$('passConfirm').addEventListener('click', confirmPass);

$('passAuto').addEventListener('click', () => {
  const me = state.players[0];
  const picked = new AIPlayer(0, 'tmp', state.difficulty);
  picked.setHand(me.hand);
  state.selectedPass = picked.choosePassCards(3);
  renderPassDialog();
});

/* ---- 亮牌（拱猪） ---- */
$('sellConfirm').addEventListener('click', confirmSell);
$('sellSkip').addEventListener('click', () => {
  state.selectedSell = [];
  syncSellSelection();
  afterSell();
});

/* ---- 拱猪结算明细 ---- */
$('settleNext').addEventListener('click', confirmSettle);

$('resNext').addEventListener('click', () => {
  $('ovResult').hidden = true;
  if (state.phase === 'gameEnd') newGame();
  else startRound();
});

/* ---- 模式切换 ---- */
$('modeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || !btn.dataset.mode) return;
  if (btn.dataset.mode === state.mode) return;
  setMode(btn.dataset.mode);
});

$('diffSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-diff]');
  if (!btn) return;
  state.difficulty = btn.dataset.diff;
  [...$('diffSeg').children].forEach((b) => b.classList.toggle('on', b === btn));
  if (state.phase !== 'idle') setHint(`AI 难度已切换为「${DIFFICULTY[state.difficulty].label}」，下一局生效。`);
});

$('btnRules').addEventListener('click', () => {
  applyModeChrome();
  $('ovRules').hidden = false;
});
$('rulesClose').addEventListener('click', () => { $('ovRules').hidden = true; });

$('btnSettings').addEventListener('click', () => {
  applyModeChrome();
  $('ovSettings').hidden = false;
});
$('settingsClose').addEventListener('click', () => { $('ovSettings').hidden = true; });

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

/** 设置面板控件的选中态与当前模式对齐（开关 + 拱猪专用项） */
function syncSettingsUI() {
  const gz = isGongzhu();
  const setSw = (id, on, disabled) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-checked', String(!!on));
    el.disabled = !!disabled;
    el.closest('.opt-row')?.classList.toggle('is-disabled', !!disabled);
  };
  setSw('swMoon', state.settings.moonSelf);
  // 拱猪没有传牌规则 → 开关置灰，避免玩家以为打开就能传牌
  setSw('swPass', passEnabled(), gz);
  setSw('swDelay', state.settings.delay);
  setSw('swSell', state.settings.sell);

  const note = $('passNote');
  if (note) note.hidden = !gz;

  const inp = $('inpThreshold');
  if (inp) inp.value = state.settings.threshold;
  [...$('thresholdChips')?.children || []].forEach(
    (b) => b.classList.toggle('on', Number(b.dataset.v) === state.settings.threshold));
}

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

/* 初始渲染 */
state.players = [0, 1, 2, 3].map((i) =>
  i === 0 ? new HumanPlayer(0, '你') : new AIPlayer(i, SEAT_LABEL[i], state.difficulty));
applyModeChrome();
render();

/* 暴露给自动化测试 */
window.__game = {
  state, newGame, startRound, onPlayCard, confirmPass,
  confirmSell, afterSell, toggleSellCard, confirmSettle, setMode, setThreshold,
  togglePassCard,
  legalCards: (hand, ctx) => H.legalCards(hand, ctx),
  HEARTS, GONGZHU,
  rulesNow: rule,
  render, renderTrick, renderScore, renderInfo, resetTrickRender,
  renderSoldBoard, renderWonCards,
  club2Holder, passEnabled, activeSeat,
  humanTurnHint,          // 供自动化校验提示文案
  setDifficulty: (d) => { state.difficulty = d; },
};

})();
