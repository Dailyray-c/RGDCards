/* ============================================================
 * net-config.js —— 联机配置
 *
 * 联机走「房间码 + 云端同步」，需要一个能存 JSON 的键值服务。
 * 默认支持 Upstash Redis（https://console.upstash.com），因为它的
 * REST API 可以直接从浏览器调用，不需要自建服务器。
 *
 * ── 怎么配 ─────────────────────────────────────────────
 * ① 打开 https://console.upstash.com ，新建一个 Redis 数据库（免费档够用）
 * ② 进入数据库详情页，找到 "REST API" 区块，复制两个值：
 *      UPSTASH_REDIS_REST_URL    形如 https://xxx-12345.upstash.io
 *      UPSTASH_REDIS_REST_TOKEN  形如 gQAAAAAA...
 * ③ 把这两个值填到本文件下方的 REST_URL / REST_TOKEN
 *
 * ⚠️ 安全提示
 *   浏览器直连会把 token 暴露给任何打开页面的人（F12 就能看到）。
 *   朋友之间小范围玩没问题；若要公开运营，请务必在中间加一层自己的
 *   服务端代理（由服务端持有 token，浏览器只调你的域名），
 *   或改用带权限控制的后端方案。
 * ============================================================ */
(function (root) {
'use strict';

const LS_KEY = 'ncm.net';

/* ==== 在这里填你的 Upstash 凭据 ==== */
/* 留空则视为「未配置」，主页会提示需要先配置。
   也可以不改本文件，改用 net-config.local.js（可加入 .gitignore）。 */
const CONFIG = {
  REST_URL: '',
  REST_TOKEN: '',
  PREFIX: 'ncm:',
};

/* 可选：net-config.local.js 里可以写
     window.NET_CONFIG_LOCAL = { url: '...', token: '...' };
   用来避免把凭据写进会提交的文件。 */
const LOCAL = (root && root.NET_CONFIG_LOCAL) || {};

/* 兼容旧字段名（url / token / prefix），并允许 localStorage 覆盖。
   优先级：localStorage > net-config.local.js > 本文件 CONFIG 常量。
   localStorage 适合临时切环境，不写进代码仓库：
     localStorage.setItem('ncm.net', JSON.stringify({url:'...',token:'...'})) */
const HARDCODED = {
  url: LOCAL.url || CONFIG.REST_URL,
  token: LOCAL.token || CONFIG.REST_TOKEN,
  prefix: LOCAL.prefix || CONFIG.PREFIX,
};

function fromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/**
 * 读取当前生效的联机配置。
 *
 * 优先级：扫码邀请带入的临时配置 > localStorage > net-config.local.js > 本文件常量。
 *
 * 「扫码邀请」最优先是有意的：被邀请者扫了房主的码，就必须连到**房主的**
 * 那份数据库，而不是他自己以前配过的。这份临时配置只存在内存里
 * （见 net-invite.js），刷新页面即失效 —— 既保证能连上，又不留痕。
 *
 * @returns {{url:string, token:string, prefix:string, ready:boolean, invited:boolean}}
 */
function getNetConfig() {
  const invite = (root.NET_INVITE && root.NET_INVITE.getPending()) || null;
  if (invite && invite.url && invite.token) {
    return {
      url: String(invite.url).replace(/\/+$/, ''),
      token: String(invite.token),
      prefix: invite.prefix || 'ncm:',
      ready: true,
      invited: true,
    };
  }
  const stored = fromStorage() || {};
  const pick = (k, d) => (stored[k] || (HARDCODED[k] || d));
  const url = String(pick('url', '')).replace(/\/+$/, '');
  const token = String(pick('token', ''));
  return {
    url,
    token,
    prefix: pick('prefix', 'ncm:'),
    ready: !!(url && token),
    invited: false,
  };
}

/** 把配置写进 localStorage（传 null 可清除，回落到本文件常量） */
function setNetConfig(cfg) {
  try {
    if (cfg == null) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    return true;
  } catch (_) { return false; }
}

/** 给界面用的一句话状态说明 */
function netStatusText() {
  const c = getNetConfig();
  if (c.ready) return '联机服务已就绪';
  return '未配置联机服务：请在 net-config.js 填入 Upstash REST URL 与 Token';
}

const NET_CONFIG = { getNetConfig, setNetConfig, netStatusText, LS_KEY, CONFIG };

if (typeof module !== 'undefined' && module.exports) module.exports = NET_CONFIG;
if (root && typeof window !== 'undefined') root.NET_CONFIG = NET_CONFIG;

})(typeof window !== 'undefined' ? window : this);
