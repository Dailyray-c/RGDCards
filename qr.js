/* ============================================================
 * qr.js —— 极简二维码生成器（无依赖，纯 Canvas 绘制）
 *
 * 为什么自己写而不是引 CDN：
 *   本项目是无构建工具的原生静态页，引入了外部 CDN 就等于把「扫码邀请」
 *   这个核心链路的可用性押在第三方上（断网 / 被墙 / CDN 下线都会坏）。
 *   邀请链接里还带着云端凭据，更不该让第三方看到。
 *   所以内置一个只做「字节模式 + 纠错等级 M」的编码器 —— 覆盖到
 *   版本 1~20（可容纳 666 字节），足够装下 URL + Token + 房间号，
 *   并给较长的 Upstash Token 留出余量。
 *
 * 实现要点：
 *   · 字节模式（UTF-8），纠错等级 M
 *   · 自动选最小可容纳的版本
 *   · 生成 0/1 矩阵，交给调用方绘到 canvas 或 <img>
 *   · 单一导出：window.QRCode.matrix(text) → { size, data: Uint8Array }
 * ============================================================ */
(function (root) {
'use strict';

/* ---------- 有限域 GF(256) 乘法（用于 Reed-Solomon） ---------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/* ---------- Reed-Solomon 纠错码字 ---------- */

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* ---------- 版本表（字节模式，纠错等级 M） ----------
 * 每行：[总码字数, 数据码字数, 每块纠错码字数, 对齐点中心,
 *        组1块数, 组1每块数据码字, 组2块数, 组2每块数据码字]
 *
 * 组1/组2 是标准的分块方式：v8 起两组就不等长，必须分开写，
 * 不能简单用「数据码字总数 / 块数」一刀切（见 buildCodewords 的注释）。
 *
 * ⚠️ 容量提醒（踩过大坑）：
 *   字节模式 + 纠错 M 的**实际**容量 = 数据码字数 - 3（4 位模式 + 16 位长度头）。
 *   所以 v10 只装得下 **213** 字节，不是 216，更不是注释里曾写的 "~270"。
 *   真实的邀请链接（云端 URL + Token + 房间号 + 域名前缀）实测 265 字节，
 *   在 v10 上会直接 draw() 失败 —— 这就是「二维码没渲染出来」的根因。
 *   故版本表一直排到 v20（上限 666 字节），留足余量。
 *
 * 每一行的数值都由「组1 + 组2 数据码字 = 数据码字总数」和
 * 「数据 + 块数×每块纠错 = 总码字」两条恒等式校验过。 */
const VERSIONS = [
  null,
  [26, 16, 10, [], 1, 16, 0, 0],
  [44, 28, 16, [6, 18], 1, 28, 0, 0],
  [70, 44, 26, [6, 22], 1, 44, 0, 0],
  [100, 64, 18, [6, 26], 2, 32, 0, 0],
  [134, 86, 24, [6, 30], 2, 43, 0, 0],
  [172, 108, 16, [6, 34], 4, 27, 0, 0],
  [196, 124, 18, [6, 22, 38], 4, 31, 0, 0],
  [242, 154, 22, [6, 24, 42], 2, 38, 2, 39],
  [292, 182, 22, [6, 26, 46], 3, 36, 2, 37],
  [346, 216, 26, [6, 28, 50], 4, 43, 1, 44],
  // ---- v11~v20：为真实长链接（含完整 Upstash 凭据）留的余量 ----
  [404, 254, 30, [6, 30, 54], 1, 50, 4, 51],
  [466, 290, 22, [6, 32, 58], 6, 36, 2, 37],
  [532, 334, 22, [6, 34, 62], 8, 37, 1, 38],
  [581, 365, 24, [6, 26, 46, 66], 4, 40, 5, 41],
  [655, 415, 24, [6, 26, 48, 70], 5, 41, 5, 42],
  [733, 453, 28, [6, 26, 50, 74], 7, 45, 3, 46],
  [815, 507, 28, [6, 30, 54, 78], 10, 46, 1, 47],
  [901, 563, 26, [6, 30, 56, 82], 9, 43, 4, 44],
  [991, 627, 26, [6, 30, 58, 86], 3, 44, 11, 45],
  [1085, 669, 26, [6, 34, 62, 90], 3, 41, 13, 42],
];

/** 支持的最高版本（版本表长度 - 1） */
const MAX_VERSION = VERSIONS.length - 1;

/* ---------- 矩阵构建 ---------- */

function makeMatrix(size) {
  const m = [];
  for (let i = 0; i < size; i++) m.push(new Uint8Array(size));
  return m;
}

/** 定位图形（三个角上的回字） */
function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c;
      if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[rr][cc] = on ? 1 : 0;
    }
  }
}

/** 对齐图形（小回字） */
function placeAlignment(m, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      m[row + r][col + c] = on ? 1 : 0;
    }
  }
}

/** 时序图形（第 6 行/列的交替黑白） */
function placeTiming(m) {
  const n = m.length;
  for (let i = 8; i < n - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
}

function reserveFormat(m, reserved) {
  const n = m.length;
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { reserved[8][i] = 1; reserved[i][8] = 1; }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = 1;
    reserved[n - 1 - i][8] = 1;
  }
  reserved[n - 8][8] = 1;
}

/* ---------- 比特流 ---------- */

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return out;
}

function buildCodewords(text, version) {
  const info = VERSIONS[version];
  const dataCap = info[1];
  const bytes = utf8Bytes(text);

  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  put(0b0100, 4);                 // 字节模式
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);

  // 终止符 + 补齐到字节
  const cap = dataCap * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  // 填充码字（0xEC / 0x11 交替）
  const pad = [0xec, 0x11];
  let pi = 0;
  while (cw.length < dataCap) cw.push(pad[pi++ % 2]);

  // 分块 + 纠错
  //
  // 注意：版本 8~10 的块是**不等长**的（标准表里分两组，第二组每块多 1 个码字）。
  // 早期实现用 `perBlock = floor(dataCap / blocks)` 一刀切，v8+ 的最后一组
  // 会被切错长度，交织后整块错位 → 只有大尺寸失败。这里按标准表显式分组。
  const [ecLen, g1n, g1k, g2n, g2k] = [info[2], info[4], info[5], info[6], info[7]];
  const dataBlocks = [];
  for (let i = 0; i < g1n; i++) dataBlocks.push(cw.slice(i * g1k, (i + 1) * g1k));
  const off = g1n * g1k;
  for (let i = 0; i < g2n; i++) dataBlocks.push(cw.slice(off + i * g2k, off + (i + 1) * g2k));
  const ecBlocks = dataBlocks.map((b) => rsEncode(b, ecLen));

  // 交织：先所有数据块的第 i 列（长度不齐时短的先结束），再所有纠错块的第 i 列
  const out = [];
  const maxData = Math.max.apply(null, dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

/* ---------- 数据填充（之字形） ---------- */

/**
 * 数据填充：标准规定的「之字形」顺序 —— 从右下角开始，每两列一组向左走，
 * 组内自下而上（或自上而下）交替填充。
 *
 * 关键细节：**第 6 列是时序列，必须整体跳过**。
 * 旧实现写 `if (col === 6) col--`，当 col 走到 6 时把左列临时改成 5，
 * 于是 (6,5) 这一组实际写进了 (5,4) —— 与下一轮的 (4,3) 重叠，
 * 数据被打乱、解码失败（表现为 jsQR 返回 null）。正确做法是把 6 整列
 * 从配对里剔除：向右回溯一列，使该组变成 (7,5)。
 */
function placeData(m, reserved, codewords) {
  const n = m.length;
  let bitIdx = 0;
  const total = codewords.length * 8;
  const nextBit = () => {
    if (bitIdx >= total) return 0;
    const byte = codewords[bitIdx >> 3];
    const bit = (byte >> (7 - (bitIdx & 7))) & 1;
    bitIdx++;
    return bit;
  };

  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    // 第 6 列是时序列，不参与数据填充：整组右移一列
    if (col === 6) col = 7;
    for (let k = 0; k < n; k++) {
      const row = up ? n - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        let bit = nextBit();
        // 掩码 0：(row + col) % 2 === 0
        if ((row + c) % 2 === 0) bit ^= 1;
        m[row][c] = bit;
      }
    }
    up = !up;
  }
}

/* ---------- 版本信息（版本 ≥ 7 才有） ---------- */

/**
 * 版本 7 起，需要在右上和左下各放一份 18 位版本信息（6×3 区域）。
 *
 * 这是版本 7+ 最容易漏掉的一步：漏了它，纠错码字会被塞进这两块区域，
 * 从而把整个数据区打乱 —— 表现为小尺寸（v1~6）能扫、一到大尺寸就扫不出。
 * 这正是「长链接二维码解码失败」的根因。
 *
 * 计算：版本号（6 位）做 BCH(18,6)，生成多项式 0x1F25。
 */
function placeVersion(m, version) {
  if (version < 7) return;
  let v = version;
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
  const bits = (version << 12) | rem;

  const n = m.length;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[n - 11 + c][r] = bit;          // 左下：3 列 × 6 行
    m[r][n - 11 + c] = bit;          // 右上：6 行 × 3 列
  }
}

/* ---------- 格式信息 ---------- */

/**
 * 15 位格式信息（纠错等级 + 掩码 + BCH 纠错），按标准规定的位置摆放两遍。
 *
 * 位置规则（bit i，i 从 0 到 14）：
 *   第一份（绕左上角）：
 *     i=0..5   → (8, i)
 *     i=6..7   → (8, i+1)      （跳过时序列 6）
 *     i=8      → (7, 8)
 *     i=9..14  → (14-i, 8)
 *   第二份：
 *     i=0..7   → (size-1-i, 8)
 *     i=8..14  → (8, size-15+i)
 *   另：(size-8, 8) 是固定暗模块（不参与格式位）。
 */
function placeFormat(m) {
  const n = m.length;
  // 纠错等级 M(00) + 掩码 0(000) → 5 位数据，做 BCH(15,5) 后异或掩码常量
  const data = 0b00000;
  let v = data << 10;
  for (let i = 4; i >= 0; i--) if (v & (1 << (i + 10))) v ^= 0x537 << i;
  const fmt = ((data << 10) | v) ^ 0x5412;

  // bit 取「从最高位往下数」的第 i 位（标准是按 MSB→LSB 逐个摆放）
  const bitAt = (i) => (fmt >> (14 - i)) & 1;

  for (let i = 0; i < 15; i++) {
    const bit = bitAt(i);
    // 第一份：绕左上角
    if (i < 6) m[8][i] = bit;
    else if (i < 8) m[8][i + 1] = bit;
    else if (i === 8) m[7][8] = bit;
    else m[14 - i][8] = bit;
    // 第二份：左下 + 右上
    if (i < 8) m[n - 1 - i][8] = bit;
    else m[8][n - 15 + i] = bit;
  }
  m[n - 8][8] = 1;   // 固定暗模块
}

/* ---------- 对外接口 ---------- */

/**
 * 生成二维码矩阵。
 * @param {string} text 要编码的内容
 * @returns {{size:number, data:Uint8Array[]}|null} 失败（内容过长）返回 null
 */
function matrix(text) {
  const bytes = utf8Bytes(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    // 4 位模式 + 长度指示符（v1~9 是 8 位，v10+ 是 16 位）+ 数据
    const needBits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (needBits <= VERSIONS[v][1] * 8) { version = v; break; }
  }
  if (!version) return null;

  const info = VERSIONS[version];
  const size = version * 4 + 17;
  const m = makeMatrix(size);
  const reserved = makeMatrix(size);

  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) reserved[r][c] = 1;
  for (let r = 0; r < 9; r++) for (let c = size - 8; c < size; c++) reserved[r][c] = 1;
  for (let r = size - 8; r < size; r++) for (let c = 0; c < 9; c++) reserved[r][c] = 1;

  for (const row of info[3]) {
    for (const col of info[3]) {
      if (reserved[row][col]) continue;
      placeAlignment(m, row, col);
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) reserved[row + r][col + c] = 1;
    }
  }

  placeTiming(m);
  for (let i = 0; i < size; i++) { reserved[6][i] = 1; reserved[i][6] = 1; }
  reserveFormat(m, reserved);

  // 版本 ≥7：右上 / 左下各 6×3 的版本信息区，必须在填数据前预留，
  // 否则数据会写进去、把版本位冲掉（v7+ 解码失败的头号原因）。
  if (version >= 7) {
    for (let r = 0; r < 6; r++) for (let c = size - 11; c < size - 8; c++) reserved[r][c] = 1;
    for (let r = size - 11; r < size - 8; r++) for (let c = 0; c < 6; c++) reserved[r][c] = 1;
  }

  const cw = buildCodewords(text, version);
  placeData(m, reserved, cw);
  placeVersion(m, version);
  placeFormat(m);
  return { size, data: m };
}

/**
 * 把文本画到 canvas 上。
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {{scale?:number, margin?:number, dark?:string, light?:string}} [opts]
 * @returns {boolean} 是否成功
 */
function draw(canvas, text, opts) {
  const o = opts || {};
  const scale = o.scale || 4;
  const margin = o.margin == null ? 4 : o.margin;
  const dark = o.dark || '#11141a';
  const light = o.light || '#ffffff';

  const qr = matrix(text);
  if (!qr) return false;

  const total = (qr.size + margin * 2) * scale;
  canvas.width = total;
  canvas.height = total;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = dark;
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.data[r][c]) {
        ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
      }
    }
  }
  return true;
}

const QRCode = { matrix, draw, maxVersion: MAX_VERSION };

if (typeof module !== 'undefined' && module.exports) module.exports = QRCode;
if (root && typeof window !== 'undefined') root.QRCode = QRCode;

})(typeof window !== 'undefined' ? window : this);
