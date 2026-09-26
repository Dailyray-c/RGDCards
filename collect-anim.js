/* ============================================================
 * collect-anim.js —— 收牌动画
 *
 * 一墩分出胜负后，把桌面上那 4 张牌**飞到赢家身边**，
 * 并在赢家旁边浮出「谁收下 / 得几分」的标识。
 *
 * ── 为什么单独一个模块 ──────────────────────────────────
 *   动画是纯视觉行为，不该和牌局逻辑纠缠。这个模块**只读 DOM、只写动画层**，
 *   不碰 state、不碰 ONLINE，因此单机与联机可以共用同一套动画，
 *   也不会因为动画出错而影响出牌判定。
 *
 * ── 三条硬约束（改动时务必保持）─────────────────────────
 *   1. **绝不拦截触控**：动画层 pointer-events:none，所有飞行牌都是
 *      绝对定位克隆。手机上动画期间照样能点、能滑。
 *   2. **只动 transform / opacity**：走合成器，不触发重排重绘。
 *      移动端才不会掉帧。
 *   3. **可随时打断**：新动画开始 / 换局 / 收墩结束时，整层直接清空，
 *      不留残留、不产生"卡在半空的牌"。
 *
 * ── 联机一致性 ────────────────────────────────────────
 *   动画的输入（赢家、牌、分数）由调用方传入，且**以权威状态为准**
 *   （联机时取裁判给的 lastTrick，而不是本地猜）。
 *   同一墩用 key 去重，重复触发不会重播 —— 避免轮询/补播导致的动画错乱。
 * ============================================================ */
(function (root) {
'use strict';

/** 飞行时长兜底（ms）。与 CSS 里 `--collect-ms` 的兜底值保持一致。 */
const FLY_MS = 620;
/** 每张牌的错开间隔：形成"一张张被收走"的节奏，而不是四张齐飞 */
const STAGGER_MS = 70;

/**
 * 实际飞行时长。
 * 允许用 `window.__collectFlyMs` 覆盖 —— **仅供录制/调试**（放慢成慢动作才拍得到中间帧），
 * 产品流程不会去设置它，所以不设时行为与常量完全一致。
 * 用函数而不是直接读常量，是为了让覆盖能在运行时生效。
 */
function flyMs() {
  const v = root && +root.__collectFlyMs;
  return v > 0 ? v : FLY_MS;
}

let layer = null;
let lastKey = null;
let running = [];
let timers = [];

/* ---------- 工具 ---------- */

const $ = (id) => document.getElementById(id);

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function getLayer() {
  if (!layer || !layer.isConnected) layer = $('collectLayer');
  return layer;
}

/** 手机端：提示条会和徽标说同一句话，动画期间让它先退到后面去 */
function setFlash(on) {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle('is-collect-flash', !!on);
}

/** 清空动画层并移除所有临时高亮（可被随时调用，幂等） */
function cancelAll() {
  clearTimers();
  const l = getLayer();
  if (l) l.innerHTML = '';
  // ⚠️ 必须把还在等的 promise 兑现掉。
  //    单机流程是 `await runCollectAnim(...)`；如果这里只清定时器不 resolve，
  //    那个 await 会**永远挂住** —— 表现就是「动画被打断后整局卡死不动」。
  const pending = running;
  running = [];
  document.querySelectorAll('.is-collecting')
    .forEach((el) => el.classList.remove('is-collecting'));
  setFlash(false);
  for (const done of pending) { try { done(); } catch (e) { /* 收尾失败不该影响牌局 */ } }
}

/**
 * 找出某个座位的"落点"元素 —— 牌最终飞向哪里。
 *   自己（0）：没有独立座位卡，用手牌区代替
 *   其余三家：优先用「已收关键牌」那一行（牌确实会出现在那里），
 *             没有时退回座位卡本身
 */
function anchorFor(seat) {
  if (seat === 0) return document.querySelector('.hand-area') || $('handCards');
  const won = $('won' + seat);
  if (won && !won.hidden && won.offsetParent !== null) return won;
  return $('seat' + seat);
}

/* ---------- 徽标定位 ---------- */

function intersects(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

/** 牌桌的屏幕矩形（徽标的活动范围，越界就会盖到页头/页脚上去） */
function tableRect() {
  const t = $('table');
  if (t) {
    const r = t.getBoundingClientRect();
    if (r.width && r.height) return r;
  }
  const w = root.innerWidth || 0, h = root.innerHeight || 0;
  return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
}

/**
 * 徽标必须避开的元素 —— 压住它们就等于把玩家正在看的信息盖掉了。
 *   · `#myRoundScore`：本局我收下的分（手机上正好在手牌区上方）
 *   · `#hintbar`：底部提示条
 *   · 座位卡本身：当锚点是卡**内部**的「已收关键牌」那一行时，
 *     若不算上座位卡，徽标就会压在座位名字上（这是之前踩过的坑）。
 */
function blockers(anchorEl) {
  const out = [];
  for (const id of ['myRoundScore', 'hintbar']) {
    const el = $(id);
    if (!el || el.hidden || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) out.push(r);
  }
  const card = anchorEl && anchorEl.closest && anchorEl.closest('.seat');
  if (card && card !== anchorEl) {
    const r = card.getBoundingClientRect();
    if (r.width && r.height) out.push(r);
  }
  return out;
}

/**
 * 从 startY 朝 dir 方向逐层挪，直到不再压住任何关键元素。
 * 用整条横向带判交（保守：宁可多让一点），挪出桌就返回 null 交给另一个方向。
 */
function walkY(startY, dir, tb, halfH, avoid) {
  let y = startY;
  for (let i = 0; i < 6; i++) {
    if (y - halfH < tb.top + 4 || y + halfH > tb.bottom - 4) return null;
    const band = { left: -1e6, right: 1e6, top: y - halfH, bottom: y + halfH };
    const hit = avoid.find((b) => intersects(band, b));
    if (!hit) return y;
    y = dir < 0 ? hit.top - halfH - 10 : hit.bottom + halfH + 10;
  }
  return null;
}

/**
 * 算出标识徽标该摆在哪。
 *
 * 不用"固定偏移"——各座位卡尺寸不同（北是横条、西东是竖卡），固定偏移
 * 一定会压住座位上的名字。改为按锚点几何来定：
 *   ① 优先放锚点**正上方**（最贴合「牌飞到谁那儿」的直觉）
 *   ② 上方出桌或被挡 → 放锚点**正下方**
 *   ③ 都不行 → 夹回桌内，宁可贴边也不飞出牌桌
 * 横向按徽标**实测宽度**夹住 —— 长昵称在窄屏上也不会溢出牌桌。
 *
 * @param {Element} anchorEl 落点元素（用来找它所属的座位卡）
 * @param {DOMRect} anchorRect 落点的屏幕矩形
 * @param {number} bw 徽标实测宽
 * @param {number} bh 徽标实测高
 */
function badgePos(anchorEl, anchorRect, bw, bh) {
  const halfW = bw / 2;
  const halfH = bh / 2;
  const tb = tableRect();
  const avoid = blockers(anchorEl);

  let y = walkY(anchorRect.top - halfH - 10, -1, tb, halfH, avoid);
  if (y == null) y = walkY(anchorRect.bottom + halfH + 10, 1, tb, halfH, avoid);
  if (y == null) {
    y = anchorRect.top - halfH - 10;
    y = Math.max(tb.top + halfH + 4, Math.min(y, tb.bottom - halfH - 4));
  }

  let x = anchorRect.left + anchorRect.width / 2;
  if (halfW * 2 >= tb.width - 12) {
    x = tb.left + tb.width / 2;                       // 徽标比桌还宽：只能居中
  } else {
    if (x - halfW < tb.left + 6) x = tb.left + 6 + halfW;
    if (x + halfW > tb.right - 6) x = tb.right - 6 - halfW;
  }

  return { x, y };
}

/* ---------- 主流程 ---------- */

/**
 * 播放收牌动画。
 *
 * @param {object} o
 * @param {number}   o.winner  收牌的座位（0..3，本地座位号）
 * @param {Array}    o.plays   本墩的 4 手牌 [{player, card}]，player 为本地座位号
 * @param {number}   [o.points] 本墩得分（拱猪可能为负）
 * @param {string}   o.key     本墩唯一标识（如 "2:7" = 第 2 局第 7 墩）；用于去重
 * @param {string}   [o.label] 赢家显示名
 * @param {boolean}  [o.isSelf] 赢家是不是本人（本人没有座位卡，落点不同）
 * @param {Array}    [o.sourceEls] 显式指定每张牌的来源元素（与 plays 同序）。
 *                  不给时按 `#slot{player}` 里找 —— 斗地主「亮底牌」那 3 张
 *                  不在任何出牌位里，只能显式传进来。
 * @param {string}   [o.badgeHTML] 自定义徽标内容（默认是「X 收下这墩 +N 分」）
 * @returns {Promise<void>} 动画结束（或被打断/跳过）后 resolve
 */
function play(o) {
  const key = String(o && o.key != null ? o.key : '');
  // 同一墩只播一次 —— 联机轮询 + 补播会把"4 张牌"这个状态重复送到，
  // 不去重就会反复重播，看起来像动画错乱。
  if (key && key === lastKey) return Promise.resolve();

  const plays = (o && o.plays) || [];
  const winner = o ? o.winner : -1;
  if (!plays.length || winner < 0 || winner > 3) return Promise.resolve();

  // 新动画开始 → 立刻收掉上一个（不等待，避免叠影）
  cancelAll();
  lastKey = key;

  const l = getLayer();
  const target = anchorFor(winner);
  // 没有落点（比如牌桌还没渲染）就只做高亮，不做飞行
  if (!l || !target) return Promise.resolve();

  // 飞行时长：JS 的收尾计时与 CSS 的过渡必须来自同一个数，否则会「牌还在半空就被清掉」
  const ms = flyMs();
  l.style.setProperty('--collect-ms', ms + 'ms');

  // ① 先量出每张牌当前的屏幕位置（必须在做任何改动之前量，否则读到旧值）
  const sources = [];
  const explicit = Array.isArray(o && o.sourceEls) ? o.sourceEls : null;
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    let el = null;
    if (explicit && explicit[i]) {
      el = explicit[i];
    } else {
      const slot = $('slot' + p.player);
      if (!slot) continue;
      el = slot.querySelector('.card[data-card="' + p.card + '"]')
        || slot.querySelector('.card');
    }
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    sources.push({ el, rect: r });
  }
  if (!sources.length) return Promise.resolve();

  const tRect = target.getBoundingClientRect();
  const tcx = tRect.left + tRect.width / 2;
  const tcy = tRect.top + tRect.height / 2;

  // ② 降级：用户偏好减少动效时，跳过飞行，只留标识与高亮
  const reduce = root.matchMedia
    && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ③ 高亮赢家 + 让桌面上的原牌淡出（否则会和飞行克隆重影）
  target.classList.add('is-collecting');
  for (const s of sources) {
    const slot = s.el.parentElement;
    if (slot) slot.classList.add('is-collecting');
  }

  // ④ 造飞行克隆
  const clones = [];
  if (!reduce) {
    for (const s of sources) {
      const c = s.el.cloneNode(true);
      c.classList.remove('card-enter', 'is-lead', 'playable', 'picked', 'blocked', 'waiting');
      c.classList.add('collect-fly');
      c.removeAttribute('id');
      c.style.width = s.rect.width + 'px';
      c.style.height = s.rect.height + 'px';
      // 起点：原地
      c.style.setProperty('--x', s.rect.left + 'px');
      c.style.setProperty('--y', s.rect.top + 'px');
      c.style.transform = `translate3d(${s.rect.left}px, ${s.rect.top}px, 0)`;
      l.appendChild(c);
      clones.push({ node: c, from: s.rect, rot: (Math.random() * 10 - 5) });
    }
  }

  // ⑤ 徽标：收牌方标识 + 本墩得分。
  //    先挂上去量出**实际尺寸**再定位 —— 昵称长短会改变宽度，
  //    用固定宽度估算，长昵称在手机上就会溢出牌桌。
  const badge = document.createElement('div');
  badge.className = 'collect-badge';
  if (o.badgeHTML) {
    badge.innerHTML = o.badgeHTML;
  } else {
    const pts = o.points || 0;
    const ptsCls = pts > 0 ? 'is-plus' : (pts < 0 ? 'is-minus' : 'is-zero');
    const ptsTxt = pts === 0 ? '无分' : (pts > 0 ? '+' + pts + ' 分' : pts + ' 分');
    badge.innerHTML =
      '<span class="collect-badge-who">' + escapeHtml(o.label || '') + '</span>收下这墩' +
      '<span class="collect-badge-pts ' + ptsCls + '">' + escapeHtml(ptsTxt) + '</span>';
  }
  l.appendChild(badge);
  const bp = badgePos(target, tRect, badge.offsetWidth || 180, badge.offsetHeight || 34);
  badge.style.setProperty('--x', bp.x + 'px');
  badge.style.setProperty('--y', bp.y + 'px');

  // 手机上提示条和徽标说的是同一句话，动画期间让它退到后面去
  setFlash(true);

  return new Promise((resolve) => {
    const finish = () => {
      clearTimers();
      const ll = getLayer();
      if (ll) ll.innerHTML = '';
      document.querySelectorAll('.is-collecting')
        .forEach((el) => el.classList.remove('is-collecting'));
      setFlash(false);
      running = [];
      resolve();
    };

    // 下一帧再改终点：让浏览器先提交起点，否则过渡会被合并成"直接出现"
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        badge.classList.add('is-in');

        clones.forEach((c, i) => {
          const t = setTimeout(() => {
            // 终点：落到赢家锚点中心，并缩小到锚点尺度
            const shrink = winner === 0 ? 0.42 : 0.34;
            const w = c.from.width, h = c.from.height;
            const tx = tcx - w / 2;
            const ty = tcy - h / 2;
            c.node.classList.add('is-lifting');
            c.node.style.transform =
              `translate3d(${tx}px, ${ty}px, 0) rotate(${c.rot}deg) scale(${shrink})`;
            c.node.style.opacity = '0';
          }, i * STAGGER_MS);
          timers.push(t);
        });

        // 等最后一张飞完就收尾
        const total = reduce ? 120 : ms + (clones.length - 1) * STAGGER_MS + 60;
        timers.push(setTimeout(finish, total));
      });
    });

    running.push(finish);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 换局 / 离开牌桌时调用：清掉残留动画与去重标记 */
function reset() {
  cancelAll();
  lastKey = null;
}

const CollectAnim = {
  play, cancelAll, reset,
  FLY_MS, STAGGER_MS,
  // 供测试断言
  get lastKey() { return lastKey; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CollectAnim;
if (root && typeof window !== 'undefined') root.CollectAnim = CollectAnim;

})(typeof window !== 'undefined' ? window : this);
