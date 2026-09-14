// server.js — 疑似GPS 中継サーバー（依存ゼロ・Node標準だけ）
//
// これ 1 本で 2 役:
//   1. 静的ファイル配信（map.html / fake-gps.js / demo-game.html など）
//   2. 位置の中継（Server-Sent Events）。地図ツールが送ったピンの位置を、
//      同じ Wi-Fi のスマホで開いたゲームへ配る。
//
//   起動: node server.js         （既定 0.0.0.0:8790 = LAN からも届く）
//   環境変数: PORT / HOST で変えられる（検証は HOST=127.0.0.1 で使う）
//
// 位置ソースの差し替え自体は fake-gps.js が行い、localhost / 自宅 LAN からしか
// 有効にならない。公開先(HTTPS の外部ホスト)では効かないので、遊ぶ人はごまかせない。
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;                       // server.js はプロジェクト直下に置く
const PORT = parseInt(process.env.PORT || '8790', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 256 * 1024;                   // ダンジョン 500 個 + クエスト主 200 人が収まる大きさ
const KEEPALIVE_MS = 25000;
const DEMO_PATH = '/demo-game.html?fakegps=1';
// 置いたダンジョンとクエスト主の保存先。検証では別ファイルを使うので環境変数で差し替えられる
const DUNGEONS_FILE = process.env.DUNGEONS_FILE || path.join(ROOT, 'dungeons.json');
const MAX_DUNGEONS = 500;
const MAX_QUESTS = 200;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

let lastPosition = null;                       // 直近のピン位置。後から来たゲームへすぐ渡す
const clients = new Set();                     // { res, role: 'map' | 'game' }

function lanIPv4() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// ---- 置いたもの（ダンジョン・クエスト主）----
// 受け取った配置をそのまま信用せず、形の合うものだけ通す

// 緯度・経度・半径が使える数ならその値を、だめなら null
function placeOf(x) {
  const lat = Number(x.lat);
  const lng = Number(x.lng);
  const radius = Number(x.radius);
  if (!Number.isFinite(lat) || Math.abs(lat) > 85) return null;
  if (!Number.isFinite(lng) || Math.abs(lng) > 180) return null;
  if (!Number.isFinite(radius) || radius < 5 || radius > 2000) return null;
  return { lat, lng, radius };
}

const textOf = (value, max) => String(value == null ? '' : value).slice(0, max);
const createdAtOf = value => (typeof value === 'string' ? value.slice(0, 40) : new Date().toISOString());

function sanitizeDungeons(input) {
  if (!Array.isArray(input) || input.length > MAX_DUNGEONS) return null;
  const out = [];
  for (const d of input) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID_RE.test(d.id)) return null;
    const place = placeOf(d);
    if (!place) return null;
    // questId があるのはクエストの目的地（ゲームでは受注するまで出ない）
    if (d.questId != null && (typeof d.questId !== 'string' || !ID_RE.test(d.questId))) return null;
    out.push({
      id: d.id,
      name: textOf(d.name, 40),
      kind: textOf(d.kind, 20),
      ...place,
      ...(d.questId ? { questId: d.questId } : {}),
      createdAt: createdAtOf(d.createdAt),
    });
  }
  return out;
}

function sanitizeQuests(input) {
  if (!Array.isArray(input) || input.length > MAX_QUESTS) return null;
  const out = [];
  for (const q of input) {
    if (!q || typeof q !== 'object' || typeof q.id !== 'string' || !ID_RE.test(q.id)) return null;
    if (typeof q.dungeonId !== 'string' || !ID_RE.test(q.dungeonId)) return null;
    const place = placeOf(q);   // radius = 話しかけられる距離
    if (!place) return null;
    out.push({
      id: q.id,
      name: textOf(q.name, 40),
      look: textOf(q.look, 20),
      ...place,
      dungeonId: q.dungeonId,
      createdAt: createdAtOf(q.createdAt),
    });
  }
  return out;
}

// クエスト主と目的地は必ず 1 対 1 でそろえる（片方だけ残ると、出てこない目的地や行き先の無い依頼になる）
function sanitizeWorld(rawDungeons, rawQuests) {
  const dungeons = sanitizeDungeons(rawDungeons);
  const quests = sanitizeQuests(rawQuests);
  if (!dungeons || !quests) return null;
  const questIds = new Set(quests.map(q => q.id));
  const dungeonById = new Map(dungeons.map(d => [d.id, d]));
  if (dungeons.some(d => d.questId && !questIds.has(d.questId))) return null;
  if (quests.some(q => !dungeonById.has(q.dungeonId) || dungeonById.get(q.dungeonId).questId !== q.id)) return null;
  return { dungeons, quests };
}

function readWorld() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DUNGEONS_FILE, 'utf8'));
  } catch (e) {
    return { dungeons: [], quests: [] };   // まだ 1 つも置いていない
  }
  // クエストが無かった頃の形（version 1）のファイルもそのまま読める
  return sanitizeWorld(data && data.dungeons, (data && data.quests) || []) || { dungeons: [], quests: [] };
}

function writeWorld(world) {
  const data = { version: 2, updatedAt: new Date().toISOString(), dungeons: world.dungeons, quests: world.quests };
  const tmp = DUNGEONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DUNGEONS_FILE);   // 書き途中の壊れたファイルを残さない
  return data;
}

function sse(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // 相手が切れた瞬間。close で片付くので無視
  }
}

function gameCount() {
  let n = 0;
  for (const c of clients) if (c.role === 'game') n += 1;
  return n;
}

function notifyPeers() {
  const games = gameCount();
  for (const c of clients) if (c.role === 'map') sse(c.res, 'peers', { games });
}

function openStream(req, res, role) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  const client = { res, role };
  clients.add(client);

  if (role === 'game' && lastPosition) sse(res, 'position', lastPosition);
  notifyPeers();   // 新しい map には今の数を、game 追加時は既存 map へ通知

  req.on('close', () => {
    clients.delete(client);
    if (role === 'game') notifyPeers();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handlePublish(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (msg && msg.type === 'position' && Number.isFinite(msg.lat) && Number.isFinite(msg.lng)) {
    lastPosition = msg;
    for (const c of clients) if (c.role === 'game') sse(c.res, 'position', msg);
  }
  res.writeHead(204);
  res.end();
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (pathname === '/') pathname = '/map.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/gps/stream') {
    const role = new URL(req.url, 'http://x').searchParams.get('role') === 'map' ? 'map' : 'game';
    openStream(req, res, role);
    return;
  }
  if (pathname === '/gps/publish') {
    handlePublish(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (e) {} });
    return;
  }
  // 置いたダンジョンとクエスト主（まとめて 1 つのファイル）
  if (pathname === '/gps/dungeons') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: 2, ...readWorld() }));
      return;
    }
    if (req.method === 'POST') {
      readBody(req).then(raw => {
        let world;
        try {
          const body = JSON.parse(raw);
          // quests を送ってこない古い画面からの保存では、置いてあるクエスト主を消さずに残す
          world = sanitizeWorld(body.dungeons, body.quests === undefined ? readWorld().quests : body.quests);
        } catch (e) {
          world = null;
        }
        if (!world) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '配置の形が不正です（クエスト主と目的地がそろっていない等。地図ツールを開き直してください）' }));
          return;
        }
        const saved = writeWorld(world);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(saved));
      }).catch(() => { try { res.writeHead(500); res.end(); } catch (e) {} });
      return;
    }
    res.writeHead(405);
    res.end();
    return;
  }
  if (pathname === '/gps/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ port: PORT, ips: lanIPv4(), demoPath: DEMO_PATH }));
    return;
  }
  serveStatic(req, res);
});

setInterval(() => {
  for (const c of clients) {
    try { c.res.write(':keepalive\n\n'); } catch (e) {}
  }
}, KEEPALIVE_MS).unref();

server.listen(PORT, HOST, () => {
  const ips = lanIPv4();
  console.log(`[server] 起動: http://localhost:${PORT}/map.html`);
  if (ips.length) {
    console.log('[server] スマホ(同じWi-Fi)から:');
    for (const ip of ips) console.log(`           http://${ip}:${PORT}${DEMO_PATH}`);
  }
  console.log('[server] 止めるにはこのウィンドウを閉じる');
});
