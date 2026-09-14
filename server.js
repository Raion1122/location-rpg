// server.js — 疑似GPS 中継サーバー（依存ゼロ・Node標準だけ）
//
// これ 1 本で 3 役:
//   1. 静的ファイル配信（map.html / fake-gps.js / demo-game.html など）
//   2. 位置の中継（Server-Sent Events）。地図ツールが送ったピンの位置を、
//      同じ Wi-Fi のスマホで開いたゲームへ配る。
//   3. 「📤 スマホ用に公開」: dungeons.json だけを git でコミットして GitHub へ push する
//      （GitHub Pages のゲームがこのファイルを読む）。この PC で開いた地図ツールからだけ受ける。
//
//   起動: node server.js         （既定 0.0.0.0:8790 = LAN からも届く）
//   環境変数: PORT / HOST で変えられる（検証は HOST=127.0.0.1 で使う）
//            DUNGEONS_FILE / PUBLISH_REPO で保存先と git のフォルダを変えられる（検証は一時フォルダを使う）
//
// 位置ソースの差し替え自体は fake-gps.js が行い、localhost / 自宅 LAN からしか
// 有効にならない。公開先(HTTPS の外部ホスト)では効かないので、遊ぶ人はごまかせない。
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

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
// 「📤 スマホ用に公開」で git を回すフォルダ。検証では一時フォルダの練習用リポジトリに差し替える
const PUBLISH_REPO = process.env.PUBLISH_REPO || ROOT;
const GIT_TIMEOUT_MS = 15000;
const PUSH_TIMEOUT_MS = 90000;                 // GitHub の返事やログインの画面を待ち続けて止まらないように
const PUSHED_COMMIT_PREFIX = 'dungeons.json:'; // 配置だけのコミットの件名の書き出し（手で push したときも同じ）

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

// ---- スマホ用に公開（dungeons.json だけをコミットして GitHub へ push）----
// GitHub Pages のゲームは dungeons.json を直接読むので、push すれば外のスマホにも届く

let publishing = false;                        // 二度押しで git を重ねて走らせない

function git(args, timeout = GIT_TIMEOUT_MS) {
  return new Promise(resolve => {
    // GIT_TERMINAL_PROMPT=0: 見えない窓でユーザー名を聞かれて止まらない / LC_ALL=C: 失敗の理由を英語のまま見分ける
    execFile('git', ['-C', PUBLISH_REPO, ...args], {
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        missing: Boolean(err && err.code === 'ENOENT'),
        timedOut: Boolean(err && err.killed),
        out: String(stdout || '').trim(),
        err: String(stderr || '').trim(),
      });
    });
  });
}

// git の出力から理由の 1 行を拾う（fatal: / error: の行を優先）
function gitReason(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.find(line => /^(fatal|error):/.test(line)) || lines.pop() || '理由不明';
}

function failed(error, status = 500) {
  return { status, body: { ok: false, error } };
}

// この PC（localhost）で開いた地図ツールからの依頼だけ受ける。同じ Wi-Fi のスマホや、よそのページからは断る
function fromThisPc(req) {
  const addr = req.socket.remoteAddress || '';
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false;
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

// 戻り値は { status: HTTP の番号, body: 返す JSON }
async function publishWorld() {
  const rel = path.relative(PUBLISH_REPO, DUNGEONS_FILE).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return failed('保存ファイル（dungeons.json）が git のフォルダの外にあります');
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream.missing) return failed('git が見つかりません（Git for Windows を入れてから、中継サーバーを起動し直してください）');
  if (!upstream.ok) return failed('送り先の GitHub が決まっていません（git のフォルダでない・今のブランチに送り先が無い）');

  const changes = await git(['status', '--porcelain', '--', rel]);
  if (!changes.ok) return failed('変更を調べられませんでした: ' + gitReason(changes.err));
  if (changes.out) {
    const world = readWorld();
    const message = `${PUSHED_COMMIT_PREFIX} 地図ツールの「スマホ用に公開」から（ダンジョン ${world.dungeons.length} 個・クエスト主 ${world.quests.length} 人）`;
    const added = await git(['add', '--', rel]);
    // -- rel: ほかに書きかけのファイルがあっても巻き込まない
    const committed = added.ok ? await git(['commit', '-m', message, '--', rel]) : added;
    if (!committed.ok) return failed('コミットできませんでした: ' + gitReason(committed.err || committed.out));
  }

  // まだ送っていないコミット（前に送れなかった配置や、手でコミットした分も含む）
  const pending = await git(['log', '--format=%s', '@{u}..HEAD']);
  if (!pending.ok) return failed('送る分を調べられませんでした: ' + gitReason(pending.err));
  const subjects = pending.out ? pending.out.split(/\r?\n/) : [];
  if (subjects.length === 0) {
    return { status: 200, body: { ok: true, status: 'nochange', message: '前に送ったときから配置が変わっていないので、送るものはありません' } };
  }

  const pushed = await git(['push'], PUSH_TIMEOUT_MS);
  if (!pushed.ok) {
    let why = gitReason(pushed.err);
    if (pushed.timedOut) why = `GitHub から ${PUSH_TIMEOUT_MS / 1000} 秒返事がありません。ログインの画面が出ていないか見てください`;
    else if (/\[rejected\]|non-fast-forward|fetch first/.test(pushed.err)) why = 'GitHub 側に、この PC に無い変更があります。先に git pull で取り込んでください';
    else if (/Authentication failed|could not read Username|terminal prompts disabled/.test(pushed.err)) why = 'GitHub にログインできませんでした';
    return failed(`送れませんでした（${why}）。コミットは PC に残っているので、直ったらもう一度押すと送ります`);
  }
  const head = await git(['rev-parse', '--short', 'HEAD']);
  const others = subjects.filter(s => !s.startsWith(PUSHED_COMMIT_PREFIX)).length;
  let message = `GitHub に送りました（${head.out}）。1〜2 分でスマホ（GitHub Pages）に反映されます`;
  if (others > 0) message += `。配置のほかに、まだ送っていなかったコミット ${others} 件も一緒に送りました`;
  return { status: 200, body: { ok: true, status: 'pushed', message, commit: head.out, sent: subjects.length, others } };
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
  // 置いた配置をスマホ用に公開（dungeons.json だけをコミットして push）。この PC で開いた地図ツールからだけ
  if (pathname === '/gps/push') {
    const reply = ({ status, body }) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!fromThisPc(req)) {
      reply(failed('公開は、この PC で開いた地図ツール（localhost）からだけできます', 403));
      return;
    }
    if (publishing) {
      reply(failed('いま送っている途中です。終わるまで待ってください', 409));
      return;
    }
    publishing = true;
    publishWorld()
      .catch(e => failed('公開の途中で止まりました: ' + e.message))
      .then(reply)
      .catch(() => {})
      .finally(() => { publishing = false; });
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
