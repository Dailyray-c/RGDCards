/* ============================================================
 * lan-server.js —— 局域网联机同步服务（方案 A · 产品化）
 *
 * 一份文件同时承担三件事，全部用 Node 内置模块，零新依赖：
 *   ① 静态服务：serve 本目录的游戏页面（index.html / app.js / …）
 *   ② 同步接口：兼容前端 upstash() 调用的 REST（GET/SET/DEL/EVAL，
 *      以及房主建房用的两个 Lua 脚本 CAS_SET / CREATE_IF_ABSENT）
 *   ③ 内网地址探测：GET /__laninfo 返回 {ip, port}，给房主页做兜底
 *
 * 启动：  node lan-server.js            （默认 0.0.0.0:8000）
 *        node lan-server.js 9000        （指定端口）
 *        PORT=9000 node lan-server.js   （或环境变量）
 *
 * 端口被占用时自动 +1 重试，并打印最终地址。
 * 监听 0.0.0.0（而非 127.0.0.1），这样同 Wi-Fi 的手机才能连进来。
 *
 * 设计要点：同步核心 net-core/net-client/net-invite/qr 完全零改动——
 * 客户端本就是「只认一个 URL」的契约式设计，局域网只是把那个 URL
 * 从 Upstash 公网换成房主本机。这就是本地联机几乎免费复用的原因。
 * ============================================================ */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

/* ---------- 端口（冲突自动 +1）---------- */
let PORT = Number(process.argv[2] || process.env.PORT || 8000);

/* ---------- 内网 IP 探测 ----------
 * 取第一个非 internal 的 IPv4，并优先常见私网段（避开 VPN 虚拟网卡）。
 * 真出多网卡选错的情况极少见；/__laninfo 也会把全部候选一并返回，
 * 前端提示「若朋友连不上请核对房主 IP」。 */
function listLanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  const score = (ip) =>
    /^192\.168\./.test(ip) ? 0 :
    /^10\./.test(ip) ? 1 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return out.sort((a, b) => score(a) - score(b));
}
const LAN_IPS = listLanIps();
const LAN_IP = LAN_IPS[0] || '127.0.0.1';

/* ---------- 同步存储（与 _mock_upstash.js 同构）---------- */
const store = new Map();
const TTL = new Map();

function alive(k) {
  if (!store.has(k)) return false;
  const t = TTL.get(k);
  if (t && t < Date.now()) { store.delete(k); TTL.delete(k); return false; }
  return true;
}

/** 极简 Lua 解释：只认前端发的两个脚本（与 mock 保持一致） */
function evalScript(script, keys, args) {
  const k = keys[0];
  if (script.includes("redis.call('EXISTS'")) {        // CREATE_IF_ABSENT
    if (alive(k)) return null;
    store.set(k, args[0]);
    TTL.set(k, Date.now() + Number(args[1]) * 1000);
    return args[0];
  }
  if (script.includes("redis.call('GET'")) {            // CAS_SET
    const expected = args[0];
    if (!alive(k)) {
      if (expected !== 'nil') return null;
    } else {
      let obj;
      try { obj = JSON.parse(store.get(k)); } catch (_) { return null; }
      if (String(obj.v) !== expected) return null;
    }
    store.set(k, args[1]);
    TTL.set(k, Date.now() + Number(args[2]) * 1000);
    return args[1];
  }
  return null;
}

function handleRedis(cmd) {
  const op = String(cmd[0]).toUpperCase();
  if (op === 'PING') return 'PONG';
  if (op === 'GET') return alive(cmd[1]) ? store.get(cmd[1]) : null;
  if (op === 'SET') {
    store.set(cmd[1], cmd[2]);
    if (cmd[3] && String(cmd[3]).toUpperCase() === 'EX') {
      TTL.set(cmd[1], Date.now() + Number(cmd[4]) * 1000);
    }
    return 'OK';
  }
  if (op === 'DEL') {
    const r = alive(cmd[1]) ? 1 : 0;
    store.delete(cmd[1]); TTL.delete(cmd[1]);
    return r;
  }
  if (op === 'EXISTS') return alive(cmd[1]) ? 1 : 0;
  if (op === 'EVAL') {
    const numKeys = Number(cmd[2]);
    const keys = cmd.slice(3, 3 + numKeys);
    const args = cmd.slice(3 + numKeys);
    return evalScript(cmd[1], keys, args);
  }
  throw new Error('unsupported ' + op);
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** 防目录穿越 + 屏蔽敏感/调试文件，只允许 ROOT 内可读的静态资源 */
function safeFile(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const full = path.normalize(path.join(ROOT, p));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  if (/(^|[\\/])(\.git|node_modules|versions|backups|\.workbuddy)([\\/]|$)/.test(full)) return null;
  if (/(^|[\\/])_[^\\/]+$/.test(full)) return null; // 调试用 _* 文件不外发
  return full;
}

/* 局域网下实时更新优先，禁用 SW 以免缓存旧资源（仅本会话注入，不改磁盘文件） */
const SW_KILL = '<script>(function(){try{if("serviceWorker"in navigator){'
  + 'var _r=navigator.serviceWorker.register;'
  + 'navigator.serviceWorker.register=function(){return Promise.resolve('
  + '{scope:"/",unregister:function(){return Promise.resolve(true);},active:null,installing:null,waiting:null});};'
  + '}}catch(e){}})();</script>';

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  // 房主用 localhost/127.0.0.1 打开时，自动跳到内网 IP，
  // 这样页面 origin 变成 IP、生成的邀请二维码朋友才扫得开。
  const host = req.headers.host || '';
  const isLocalHost = /(^|\.)localhost(:[0-9]+)?$/i.test(host) || /^127\.0\.0\.1(:[0-9]+)?$/.test(host);
  if (isLocalHost && (urlPath === '/' || urlPath === '/index.html') && (req.headers.accept || '').includes('text/html')) {
    // 保留原始路径与查询串（如 ?lan=1 开关意图标记），跳转后新页面才知道要点亮开关
    res.writeHead(302, { Location: 'http://' + LAN_IP + ':' + PORT + req.url });
    return res.end();
  }
  const full = safeFile(urlPath);
  if (!full) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    if (ext === '.html') {
      let html = data.toString('utf8');
      html = html.replace('</head>', SW_KILL + '</head>');
      return res.end(html);
    }
    res.end(data);
  });
}

/* ---------- 主处理器 ---------- */
function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ③ 内网地址探测
  if (req.method === 'GET' && req.url.split('?')[0] === '/__laninfo') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ip: LAN_IP, port: PORT, ips: LAN_IPS }));
  }

  // ② 同步接口（前端 upstash() 发 POST 命令数组到根路径）
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let cmd;
      try { cmd = JSON.parse(body); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'bad json' }));
      }
      let result = null;
      try { result = handleRedis(cmd); }
      catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
    return;
  }

  // ① 静态服务
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('method not allowed');
}

/* ---------- 启动（端口冲突自动 +1）---------- */
function start() {
  const server = http.createServer(handler);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      PORT += 1;
      console.log('端口被占用，尝试 ' + PORT);
      return start();
    }
    console.error('启动失败：', e);
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('✅ 局域网联机服务已启动');
    console.log('   本机访问：  http://localhost:' + PORT);
    console.log('   同 Wi-Fi 朋友：http://' + LAN_IP + ':' + PORT);
    if (LAN_IPS.length > 1) {
      console.log('   检测到多块网卡，若朋友连不上请改用其中一张：' + LAN_IPS.join(' / '));
    }
    console.log('   建房后把页面上的二维码发给朋友即可同桌对战。');
    console.log('   提示：游戏页请从上面地址打开；若从其他地址打开，打开「局域网联机」开关后会自动切换过来。');
    console.log('   按 Ctrl+C 停止。');
    console.log('');
  });
}
start();
