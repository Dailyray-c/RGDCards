/* ============================================================
 * net-core.js —— 联机底层：Upstash Redis REST 客户端 + 房间读写
 *
 * 设计要点
 * ────────
 * 1. 只用 Redis 的字符串键 + 原子命令，不依赖 RedisJSON：
 *    房间整体序列化成 JSON 存一个键，读改写用 WATCH/MULTI 或
 *    「版本号 CAS」保证并发安全。
 *
 * 2. 并发模型 —— 乐观锁（版本号 CAS）：
 *    房间对象自带 `v`（版本号），每次写入前用 Lua 脚本校验版本，
 *    版本不符就重读重试。这样两台设备同时出牌不会互相覆盖。
 *
 * 3. 全部走 Upstash REST，浏览器可直接调用，无需自建服务端。
 *    POST {url}   body: ["EVAL", lua, keys, args...]
 *    Authorization: Bearer {token}
 * ============================================================ */
(function (root) {
'use strict';

const ROOM_TTL = 60 * 60 * 6;      // 房间 6 小时无活动自动过期
const CODE_LEN = 6;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 I O 0 1

/* ---------- 底层请求 ---------- */

/**
 * 调一次 Upstash REST。
 * @param {string[]} cmd Redis 命令数组，如 ["GET", "k"]
 * @param {object} [opts] 额外选项：{ keepalive: true } 用于 pagehide 等
 *        页面即将卸载、普通 await 拿不到响应时的"最佳努力"请求。
 * @returns {Promise<any>} result 字段
 */
async function upstash(cmd, cfg, opts) {
  const c = cfg || NET_CONFIG.getNetConfig();
  if (!c.ready) {
    const err = new Error('NET_NOT_CONFIGURED');
    err.code = 'NET_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(c.url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + c.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
    keepalive: !!(opts && opts.keepalive),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Upstash ${res.status}: ${text.slice(0, 200)}`);
    err.code = 'NET_HTTP_' + res.status;
    throw err;
  }
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error);
    err.code = 'NET_REDIS_ERROR';
    throw err;
  }
  return data.result;
}

const roomKey = (code) => NET_CONFIG.getNetConfig().prefix + 'room:' + code;
/** 在线心跳键：每个真人玩家定期写自己的时间戳，房主据此判断「谁掉线了」。
 *  键不带 TTL —— 用值里的时间戳判活，避免依赖各后端对 EX 参数的支持差异。 */
const seenKey = (code, playerId) => NET_CONFIG.getNetConfig().prefix + 'seen:' + code + ':' + playerId;

/* ---------- Lua 脚本（原子 CAS 写入） ---------- */

// 版本号相符才写入，返回写入后的新内容；不符返回 nil 表示需要重读
const CAS_SET = `
local cur = redis.call('GET', KEYS[1])
if cur == false then
  if ARGV[1] ~= 'nil' then return false end
else
  local ok, obj = pcall(cjson.decode, cur)
  if not ok or tostring(obj.v) ~= ARGV[1] then return false end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return ARGV[2]
`;

// 房间不存在才创建（避免抢房间码）
const CREATE_IF_ABSENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return ARGV[1]
`;

/* ---------- 房间基础操作 ---------- */

function randomCode() {
  let s = '';
  const a = CODE_ALPHABET;
  for (let i = 0; i < CODE_LEN; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/** 读房间；不存在返回 null */
async function readRoom(code) {
  const raw = await upstash(['GET', roomKey(code)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * 创建房间。会重试若干次以避开已存在的房间码。
 * @param {object} room 初始房间对象（须含 v 字段）
 */
async function createRoom(code, room) {
  const payload = JSON.stringify(room);
  const out = await upstash(
    ['EVAL', CREATE_IF_ABSENT, '1', roomKey(code), payload, String(ROOM_TTL)]);
  return out ? room : null;
}

/**
 * 乐观锁写入：拿到最新房间 → 交给 mutator 修改 → 版本匹配则写入。
 * mutator 返回 false 表示放弃本次写入（如状态已不适用）。
 *
 * @param {string} code
 * @param {(room:object)=>(object|false)} mutator
 * @param {number} retries
 * @returns {Promise<object|null>} 写入后的房间；放弃或重试耗尽返回 null
 */
async function updateRoom(code, mutator, retries = 6) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const room = await readRoom(code);
    if (!room) return null;

    const expected = String(room.v);
    const draft = JSON.parse(JSON.stringify(room));
    const next = mutator(draft);
    if (next === false) return null;

    next.v = room.v + 1;
    next.touchedAt = Date.now();
    const out = await upstash([
      'EVAL', CAS_SET, '1', roomKey(code),
      expected, JSON.stringify(next), String(ROOM_TTL),
    ]);
    if (out) return JSON.parse(out);

    // 版本冲突 → 退避后重试
    await new Promise((r) => setTimeout(r, 30 + attempt * 40));
  }
  return null;
}

/** 仅当房间仍存在时删除 */
async function deleteRoom(code) {
  await upstash(['DEL', roomKey(code)]);
}

/* ---------- 轮询 ---------- */

/**
 * 轻量轮询：只在版本号变化时返回新房间，省流量。
 * @param {string} code
 * @param {number} knownV 已知版本号
 * @param {number} timeoutMs
 * @returns {Promise<{changed:boolean, room:object|null}>}
 */
/** 轮询的两种档位。见 pollRoom 的说明。 */
const POLL_FAST = { start: 180, cap: 1500, growth: 1.5 };
const POLL_SLOW = { start: 1000, cap: 3000, growth: 1.5 };

/**
 * 轮询房间直到版本号变化。
 *
 * 退避策略：**每次检测到变化后都从 start 重新起步**，所以只要牌局在推进
 * （房主的 AI 节拍每 ~900ms 写一次），轮询就一直停在 180~400ms 这一档，
 * 每一次状态变化都能被及时看到 —— 不会出现「没看见对方出牌就过墩了」。
 *
 * 只有**真的没事发生**（大厅等人、等真人出牌）时才会一路退避到 cap。
 * 也就是说，大退避影响的只是"从静止到第一次变化"的最坏延迟（≤ cap），
 * 而不会让进行中的牌局变卡。这是省 Upstash 读次数的主要手段：
 * 静止时从 ~2.0 次/秒 降到 ~1.1 次/秒（大厅档 ~0.35 次/秒）。
 *
 * @param {string} code
 * @param {number} knownV
 * @param {number} timeoutMs
 * @param {{slow?:boolean}} [opts] slow=true 走大厅慢档（房间还没开局时）
 */
async function pollRoom(code, knownV, timeoutMs = 9000, opts) {
  const cfg = (opts && opts.slow) ? POLL_SLOW : POLL_FAST;
  const deadline = Date.now() + timeoutMs;
  let delay = cfg.start;
  while (Date.now() < deadline) {
    let room = null;
    let readFailed = false;
    try { room = await readRoom(code); } catch (e) {
      if (e.code === 'NET_NOT_CONFIGURED') throw e;
      // ⚠️ 瞬时网络错误绝不能当成「房间被删」—— Wi-Fi 抖一下就踢人出局，
      //    曾让玩家在正常对局中莫名掉线。读失败只退避重试，到点按「无变化」返回。
      readFailed = true;
    }
    if (readFailed) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(cfg.cap, Math.round(delay * cfg.growth));
      continue;
    }
    // 只有「成功读到、但键不存在」才算房间真的没了（房主解散 / 过期）
    if (!room) return { changed: true, room: null };
    if (room.v !== knownV) return { changed: true, room };
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(cfg.cap, Math.round(delay * cfg.growth));
  }
  return { changed: false, room: null };
}

const NET_CORE = {
  upstash, roomKey, seenKey, readRoom, createRoom, updateRoom, deleteRoom, pollRoom,
  randomCode, CODE_LEN, CODE_ALPHABET, ROOM_TTL,
};

if (typeof module !== 'undefined' && module.exports) module.exports = NET_CORE;
if (root && typeof window !== 'undefined') root.NET_CORE = NET_CORE;

})(typeof window !== 'undefined' ? window : this);
