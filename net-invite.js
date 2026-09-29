/* ============================================================
 * net-invite.js —— 扫码邀请
 *
 * 房主建房后生成一个二维码 / 链接，朋友扫码直接进同一房间。
 *
 * ── 链接里装什么 ──────────────────────────────────────
 *   房间号 + 云同步配置（Upstash URL 与 Token）。
 *   因为本项目没有自己的服务端，Friend 要连上同一份数据，
 *   就必须拿到同一套 Upstash 凭据 —— 这是「无服务器」架构的必然代价。
 *
 * ── 隐私边界（重要）─────────────────────────────────────
 *   被邀请者**不能看到云端凭据**。做法是：
 *     · 凭据只放在 URL 的 hash 段（# 之后）。hash 不会发给服务器，
 *       也不会出现在 referer / 日志里。
 *     · 页面读取后**立刻从地址栏抹掉**（replaceState），并只存内存，
 *       不写进 localStorage —— 这样被邀请者即使在控制台里翻也翻不到
 *       「房主配置了什么」，只能看到房间号和玩家昵称。
 *     · 界面上不做任何凭据回显（不填进 input、不显示文本）。
 *
 *   诚实说明：这是**防误看**而不是**强加密**。链接本身对拿到它的人是
 *   透明的（扫码前就能看到长串），真要严格保密需要自建服务端代理。
 *   朋友之间小范围玩够用；这一点在界面上也会如实提示房主。
 *
 * ── 数据销毁 ──────────────────────────────────────────
 *   被邀请者（非房主）在**对局结束**时自动清除本地留存的房间信息，
 *   只保留本局战绩。房间本体由房主负责解散（见 net-client.leaveRoom）。
 * ============================================================ */
(function (root) {
'use strict';

const HASH_KEY = 'join';

/* ---------- 编码 / 解码 ----------
 *
 * 两种格式并存：
 *
 *   v2（紧凑，当前默认）：`#join=2~<url>~<token>~<code>[~<prefix>]`
 *     · 直接用 `~` 分隔，**不做 base64** —— base64 会把体积撑大 33%，
 *       而邀请链接本来就要塞进二维码，字节数直接决定二维码的版本/密度。
 *     · url 去掉 `https://` 前缀（解码时补回），省 8 字节。
 *     · prefix 为默认值 `ncm:` 时整段省略。
 *     实测：真实链接（Upstash URL + 64 字符 Token + 房间号）从 265 字节
 *     降到 ~113 字节，二维码从 v12（65×65）降到 v9（53×53），更好扫。
 *
 *   v1（旧格式，仍可解码）：`#join=<base64url(json)>`
 *     早期版本发的链接必须继续能用，否则已分享出去的二维码会失效。
 *
 * 分隔符安全性：`~` 是 RFC3986 的 unreserved 字符，不会出现在
 * Upstash URL / Token（base64url 字符集）/ 房间码 / `ncm:` 里。
 * 万一将来出现，encodeInvite 会自动退回 v1 格式（见下方守卫）。
 */

/** v2 紧凑格式解码 */
function decodeV2(kv) {
  const parts = kv.split('~');
  if (parts.length < 4) return null;
  const u = parts[1], t = parts[2], c = parts[3], p = parts[4], m = parts[5];
  if (!u || !t || !c) return null;
  return {
    // 编码时剥掉了 https://，这里补回；显式带 scheme 的（如 http://）原样保留
    url: /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : 'https://' + u,
    token: t,
    prefix: p || 'ncm:',
    code: c,
    // 玩法（可选，2026-09-28 起随链接携带，用来在进房前就亮出对应的主题色）。
    // 只认合法值 —— 老链接没有这段，字段缺失时调用方自己兜底。
    mode: (m === 'hearts' || m === 'gongzhu' || m === 'ddz') ? m : undefined,
  };
}

/** v1 旧格式解码：base64url(JSON) */
function decodeV1(kv) {
  let obj;
  try {
    // base64url → base64 → UTF-8
    let b64 = kv.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
  if (!obj || !obj.u || !obj.t || !obj.c) return null;
  return { url: obj.u, token: obj.t, prefix: obj.p || 'ncm:', code: obj.c,
    mode: (obj.m === 'hearts' || obj.m === 'gongzhu' || obj.m === 'ddz') ? obj.m : undefined };
}

/**
 * 把 `#join=...` 解成 {url, token, prefix, code}。
 *
 * ⚠️ 出口一律是**长字段名**（url/token/prefix）。
 *   链接里为了省字节用短名，但内部统一用长名 —— 曾经因为这里返回短名、
 *   而 getNetConfig 读长名，导致扫码后「配置明明在内存里却显示未配置」。
 */
function decodeInvite(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  // 支持 `join=xxx` 与 `xxx` 两种写法
  const kv = raw.indexOf('=') >= 0 ? raw.slice(raw.indexOf('=') + 1) : raw;
  if (!kv) return null;
  if (kv.slice(0, 2) === '2~') return decodeV2(kv);
  return decodeV1(kv);
}

/** v1 编码（保留给「字段含 ~ 时」的兜底路径） */
function encodeV1(payload) {
  const json = JSON.stringify({
    u: payload.url,
    t: payload.token,
    p: payload.prefix || 'ncm:',
    c: payload.code,
    m: payload.mode || undefined,
  });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return '#' + HASH_KEY + '=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 把 {url, token, prefix, code[, mode]} 编成 `#join=2~...`（紧凑格式）。
 * ⚠️ mode 是第 6 段，且**只在 prefix 也写出时才追加** —— 这是位置编码的兼容约束：
 *    老客户端按位置取 prefix（第 5 段），若 mode 顶掉了 prefix 的位置，
 *    老客户端会把 'ddz' 误读成 prefix，扫码直接配置错乱。
 */
function encodeInvite(payload) {
  const url = String(payload.url == null ? '' : payload.url);
  const token = String(payload.token == null ? '' : payload.token);
  const code = String(payload.code == null ? '' : payload.code);
  const prefix = payload.prefix || 'ncm:';
  const mode = payload.mode || '';

  // 守卫：任一字段含分隔符 `~` 时，紧凑格式会产生歧义 → 退回 base64 旧格式。
  if (url.indexOf('~') >= 0 || token.indexOf('~') >= 0
      || code.indexOf('~') >= 0 || prefix.indexOf('~') >= 0) {
    return encodeV1({ url, token, prefix, code, mode });
  }

  // https:// 最常见，剥掉不存（解码时补回），换来的字节数直接降低二维码版本
  const bare = url.replace(/^https:\/\//, '');
  const parts = ['2', bare, token, code];
  if (prefix !== 'ncm:' || mode) parts.push(prefix);
  if (mode) parts.push(mode);
  return '#' + HASH_KEY + '=' + parts.join('~');
}

/* ---------- 生成分享链接 ---------- */

/**
 * 生成完整邀请链接。
 * @param {{url:string, token:string, prefix?:string, code:string, mode?:string}} payload
 * @returns {string} 形如 https://host/path#join=xxxx
 */
function buildLink(payload) {
  const base = location.origin + location.pathname;
  return base + encodeInvite(payload);
}

/* ---------- 消费（页面加载时调用一次） ---------- */

/**
 * 检查当前地址是否带邀请信息。
 *
 * ⚠️ 无论成功与否，**都要立刻把 hash 从地址栏抹掉** ——
 * 否则被邀请者一截图/一转发就把房主的凭据泄出去了。
 *
 * @returns {{url,token,prefix,code}|null} 解出的邀请信息
 */
function consumeInvite() {
  const info = decodeInvite(location.hash);
  if (location.hash) {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (_) { /* 老浏览器忽略 */ }
  }
  return info;
}

/**
 * 被邀请者的一次性配置：只存在于内存，绝不落盘。
 * 用完之后 clear() 抹掉。
 */
let pending = null;
function setPending(info) { pending = info || null; }
function getPending() { return pending; }
function clearPending() { pending = null; }

/**
 * 判断「当前这套云端配置是不是扫码带进来的」。
 * 用来决定：要不要对用户隐藏配置、对局结束要不要销毁本地数据。
 */
function isInvited() { return !!pending; }

const NET_INVITE = {
  encodeInvite, decodeInvite, buildLink, consumeInvite,
  setPending, getPending, clearPending, isInvited, HASH_KEY,
};

if (typeof module !== 'undefined' && module.exports) module.exports = NET_INVITE;
if (root && typeof window !== 'undefined') root.NET_INVITE = NET_INVITE;

})(typeof window !== 'undefined' ? window : this);
