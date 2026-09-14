// 疑似GPS 地図ツール + 中継サーバー(server.js) + 差し替え部品(fake-gps.js) + ダンジョンの中身(dungeon.js) + クエスト(quest.js) のヘッドレス検証
//   node tools/verify_map_tool.js            … 画面を出さずに検証
//   node tools/verify_map_tool.js --headful  … Chrome の画面を出して検証
// 終了コード: 0 = 全項目合格 / 1 = 不合格あり / 2 = 準備に失敗（puppeteer-core・Chrome・server.js 起動）
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8793;                                   // 起動用 .vbs の 8790 とぶつけない
const BASE = `http://127.0.0.1:${PORT}`;
const OTHER_HOST = 'example.com';                    // 公開ホストのふり（差し替え禁止のはず）
const LAN_HOST = 'my-pc.local';                      // 自宅 LAN のふり（差し替え可のはず）
const HEADFUL = process.argv.includes('--headful');
const TOKYO = { lat: 35.681236, lng: 139.767125 };
const SENDAI = { lat: 38.26, lng: 140.882 };
const EARTH_RADIUS_M = 6371008.8;
// 検証で置くダンジョンは一時ファイルへ。プロジェクトの dungeons.json は触らない
const DUNGEONS_TMP = path.join(os.tmpdir(), 'fake-gps-verify-dungeons.json');

function loadPuppeteer() {
  try { return require('puppeteer-core'); } catch (e) { /* 次を試す */ }
  try { return require(path.join(os.tmpdir(), 'df_pptr', 'node_modules', 'puppeteer-core')); } catch (e) { /* 次へ */ }
  return null;
}

function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// server.js を子プロセスで起動し、/gps/info が応答するまで待つ
function startServer() {
  try { fs.unlinkSync(DUNGEONS_TMP); } catch (e) { /* 無ければそれでよい */ }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DUNGEONS_FILE: DUNGEONS_TMP },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    const deadline = Date.now() + 8000;
    const poll = () => {
      const req = http.get(`${BASE}/gps/info`, res => {
        res.resume();
        resolve(child);
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server.js が起動しません'));
        else setTimeout(poll, 200);
      });
    };
    poll();
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  … ${detail}` : ''}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const toRad = deg => deg * Math.PI / 180;

function distanceM(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const fmt = p => (p && Number.isFinite(p.lat) ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : String(p && p.error));

function toolState(page) {
  return page.evaluate(() => {
    const s = window.fakeGpsTool.state;
    return { lat: s.pos.lat, lng: s.pos.lng, distance: s.distance, speed: s.speed, target: s.target, peers: s.peers, connected: s.connected, dungeons: s.dungeons.length, quests: s.quests.length };
  });
}

function gameState(page) {
  return page.evaluate(() => ({ enabled: window.fakeGps.enabled, reason: window.fakeGps.reason, connected: window.fakeGps.connected, ...window.demoGame }));
}

function containerLatLng(page, x, y) {
  return page.evaluate((px, py) => {
    const ll = window.fakeGpsTool.map.containerPointToLatLng([px, py]);
    return { lat: ll.lat, lng: ll.lng };
  }, x, y);
}

async function clickMap(page, x, y) {
  const box = await (await page.$('#map')).boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
}

// パネルのボタン/チェックは要素へ直接 click を投げる（scrollIntoView 待ちでハングしないように）
function clickId(page, id) {
  return page.$eval('#' + id, el => el.click());
}

function setInput(page, id, value) {
  return page.$eval('#' + id, (el, v) => { el.value = v; }, value);
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get(BASE + pathname, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

// 条件が満たされるまで待つ（ゲーム側は 3 秒ごとに配置を取り直すので待ちが要る）
async function waitFor(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

// 地図ツールの peers が期待値になるまで待つ（SSE で伝わるのを待つ）
async function waitPeers(page, want, ms = 4000) {
  const deadline = Date.now() + ms;
  let last = -1;
  while (Date.now() < deadline) {
    last = (await toolState(page)).peers;
    if (last === want) return true;
    await sleep(150);
  }
  return last === want;
}

async function main() {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    console.error('[verify] puppeteer-core が見つかりません');
    return 2;
  }
  const executablePath = findChrome();
  if (!executablePath) {
    console.error('[verify] Chrome が見つかりません');
    return 2;
  }

  let server;
  try {
    server = await startServer();
  } catch (e) {
    console.error('[verify]', e.message);
    return 2;
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: HEADFUL ? false : 'new',
    protocolTimeout: 60000,
    defaultViewport: { width: 1200, height: 800 },
    args: [
      `--host-resolver-rules=MAP ${OTHER_HOST} 127.0.0.1, MAP ${LAN_HOST} 127.0.0.1`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const pageErrors = [];
  const watchErrors = (page, label) => page.on('pageerror', err => pageErrors.push(`${label}: ${err.message}`));

  try {
    // ---- 1. 地図ツールを開く ----
    const mapPage = await browser.newPage();
    watchErrors(mapPage, 'map');
    await mapPage.goto(`${BASE}/map.html`, { waitUntil: 'domcontentloaded' });
    const ready = await mapPage.waitForFunction(() => window.fakeGpsTool, { timeout: 20000 }).then(() => true, () => false);
    if (!ready) {
      console.error('[verify] map.html が起動しません（Leaflet を CDN から読めていない可能性）');
      return 2;
    }
    await mapPage.waitForFunction(() => window.fakeGpsTool.state.connected, { timeout: 5000 }).catch(() => {});
    let tool = await toolState(mapPage);
    check('地図ツール: 初めて開いたときの位置は東京駅', distanceM(tool, TOKYO) < 0.01, fmt(tool));
    check('地図ツール: 中継サーバーにつながる', tool.connected === true);
    await sleep(400);   // 起動直後の位置を publish させる

    // ---- 2. ゲームを開く ----
    const game = await browser.newPage();
    watchErrors(game, 'game');
    await game.goto(`${BASE}/demo-game.html?fakegps=1`, { waitUntil: 'domcontentloaded' });
    await game.waitForFunction(() => window.demoGame && window.demoGame.updates > 0, { timeout: 5000 }).catch(() => {});
    let g = await gameState(game);
    check('ゲーム: ?fakegps=1 で疑似GPSが有効になる', g.enabled === true, g.reason);
    check('ゲーム: 中継サーバーから開いた直後の位置が届く', g.updates > 0 && distanceM(g, TOKYO) < 0.01, `${fmt(g)} / 更新 ${g.updates} 回`);
    await game.waitForFunction(() => window.demoGame.map && window.demoGame.map.ready, { timeout: 15000 }).catch(() => {});
    g = await gameState(game);
    check('地図: ゲーム画面に地図が出て、自分の位置が真ん中に来る', g.map && distanceM(g.map.center, TOKYO) < 2,
      g.map ? `${fmt(g.map.center)} / ズーム ${g.map.zoom}` : '地図が出ない');
    check('地図ツール: つながっているゲームを 1 つと数える', await waitPeers(mapPage, 1), `${(await toolState(mapPage)).peers} つ`);

    // ---- 3. ワープ ----
    await mapPage.evaluate(() => window.fakeGpsTool.setSpeed('warp'));
    const warpPoint = await containerLatLng(mapPage, 300, 250);
    await clickMap(mapPage, 300, 250);
    await sleep(700);
    tool = await toolState(mapPage);
    g = await gameState(game);
    check('ワープ: クリックした地点へ瞬間移動する', distanceM(tool, warpPoint) < 0.5, `${distanceM(tool, warpPoint).toFixed(2)} m のずれ`);
    check('ワープ: ゲームにも同じ位置が届く', distanceM(g, warpPoint) < 0.5, fmt(g));
    check('ワープ: 歩いた距離に数えない', tool.distance === 0, `${tool.distance} m`);
    check('ワープ: ゲームの地図も自分についていく', g.map && distanceM(g.map.center, warpPoint) < 2, g.map && fmt(g.map.center));

    // ---- 3-2. ゲームの地図を指で動かす → 追いかけるのをやめ、◎ で戻る ----
    const gameMapBox = await (await game.$('#gameMap')).boundingBox();
    const midX = gameMapBox.x + gameMapBox.width / 2;
    const midY = gameMapBox.y + gameMapBox.height / 2;
    await game.mouse.move(midX, midY);
    await game.mouse.down();
    await game.mouse.move(midX - 160, midY - 90, { steps: 8 });
    await game.mouse.up();
    await sleep(300);
    g = await gameState(game);
    const recenterShown = await game.$eval('#recenterBtn', el => !el.hidden);
    const draggedAway = g.map && g.map.follow === false && distanceM(g.map.center, warpPoint) > 20;
    const draggedDetail = g.map ? `動かした後 ${distanceM(g.map.center, warpPoint).toFixed(0)} m` : '';
    await clickId(game, 'recenterBtn');
    await sleep(300);
    g = await gameState(game);
    check('地図: 指で動かすと追いかけるのをやめ、◎ で現在地に戻る',
      draggedAway && recenterShown && g.map.follow === true && distanceM(g.map.center, warpPoint) < 2,
      `${draggedDetail} / 戻した後 ${g.map ? distanceM(g.map.center, warpPoint).toFixed(1) : '-'} m`);

    // ---- 4. 車の速さで歩いて向かう ----
    await mapPage.evaluate(() => window.fakeGpsTool.setSpeed('car'));
    const walkFrom = { lat: tool.lat, lng: tool.lng };
    const walkTarget = await containerLatLng(mapPage, 600, 250);
    const walkStartedAt = Date.now();
    await clickMap(mapPage, 600, 250);
    await sleep(3000);
    tool = await toolState(mapPage);
    const walkElapsedS = (Date.now() - walkStartedAt) / 1000;
    const walked = distanceM(walkFrom, tool);
    const expectedWalk = (40 / 3.6) * walkElapsedS;
    check('歩き: 時速 40km の速さで進む', walked > expectedWalk * 0.75 && walked < expectedWalk * 1.1,
      `${walked.toFixed(1)} m（${walkElapsedS.toFixed(2)} 秒なら ${expectedWalk.toFixed(1)} m）`);
    const detour = distanceM(walkFrom, tool) + distanceM(tool, walkTarget) - distanceM(walkFrom, walkTarget);
    check('歩き: 目的地へまっすぐ向かう', detour < 1, `寄り道 ${detour.toFixed(2)} m`);
    check('歩き: まだ目的地に着いていない', tool.target !== null && distanceM(tool, walkTarget) > 5, `残り ${distanceM(tool, walkTarget).toFixed(1)} m`);
    check('歩き: 歩いた距離が増える', Math.abs(tool.distance - walked) < 1, `${tool.distance.toFixed(1)} m`);
    g = await gameState(game);
    check('歩き: ゲームにも速さと位置が届く', Math.abs(g.speed - 40 / 3.6) < 0.01 && distanceM(g, tool) < (40 / 3.6) * 0.6,
      `速さ ${(g.speed * 3.6).toFixed(1)} km/h / 地図との差 ${distanceM(g, tool).toFixed(1)} m`);

    // ---- 5. 止まる ----
    await clickId(mapPage, 'stopBtn');
    await sleep(600);
    tool = await toolState(mapPage);
    g = await gameState(game);
    check('止まる: 目的地が消え、ゲームに速さ 0 が届く', tool.target === null && tool.speed === 0 && g.speed === 0, `ゲームの速さ ${g.speed}`);
    const stoppedAt = { lat: tool.lat, lng: tool.lng };
    await sleep(500);
    tool = await toolState(mapPage);
    check('止まる: その場から動かない', distanceM(tool, stoppedAt) < 0.01, `${distanceM(tool, stoppedAt).toFixed(3)} m`);

    // ---- 6. キー操作（走りで ↑ を 1.5 秒） ----
    await mapPage.evaluate(() => window.fakeGpsTool.setSpeed('run'));
    const keyFrom = { lat: tool.lat, lng: tool.lng };
    const keyStartedAt = Date.now();
    await mapPage.keyboard.down('ArrowUp');
    await sleep(1500);
    await mapPage.keyboard.up('ArrowUp');
    const keyElapsedS = (Date.now() - keyStartedAt) / 1000;
    await sleep(300);
    tool = await toolState(mapPage);
    const north = distanceM(keyFrom, { lat: tool.lat, lng: keyFrom.lng });
    const east = distanceM(keyFrom, { lat: keyFrom.lat, lng: tool.lng });
    const expectedKey = (10 / 3.6) * keyElapsedS;
    check('キー: ↑ で北へ走りの速さで進む', tool.lat > keyFrom.lat && north > expectedKey * 0.6 && north < expectedKey * 1.2,
      `北へ ${north.toFixed(2)} m（${keyElapsedS.toFixed(2)} 秒なら ${expectedKey.toFixed(2)} m）`);
    check('キー: ↑ だけなら東西にずれない', east < 0.05, `${east.toFixed(3)} m`);

    // ---- 6-2. 向き（← で西へ歩くと戦士が左を向き、→ で東へ歩くと右に戻る。止まっても向きはそのまま） ----
    const facingNow = async () => ({
      game: (await gameState(game)).facing,
      gameSprite: (await game.$$('.me .npc.left')).length,
      tool: (await mapPage.$$('.pin .npc.left')).length,
    });
    await mapPage.keyboard.down('ArrowLeft');
    await sleep(800);
    await mapPage.keyboard.up('ArrowLeft');
    await sleep(500);
    const faceWest = await facingNow();
    await mapPage.keyboard.down('ArrowRight');
    await sleep(800);
    await mapPage.keyboard.up('ArrowRight');
    await sleep(500);
    const faceEast = await facingNow();
    check('向き: 西へ歩くと戦士が左を向き（ゲームも地図ツールも・止まってもそのまま）、東へ歩くと右に戻る',
      faceWest.game === 'left' && faceWest.gameSprite === 1 && faceWest.tool === 1
        && faceEast.game === 'right' && faceEast.gameSprite === 0 && faceEast.tool === 0,
      `西 ${JSON.stringify(faceWest)} / 東 ${JSON.stringify(faceEast)}`);

    // ---- 7. 座標へ飛ぶ ----
    await setInput(mapPage, 'jumpInput', '38.260, 140.882');
    await clickId(mapPage, 'jumpBtn');
    await sleep(700);
    tool = await toolState(mapPage);
    g = await gameState(game);
    check('座標へ飛ぶ: 入力した座標へ移動する', distanceM(tool, SENDAI) < 0.01, fmt(tool));
    check('座標へ飛ぶ: ゲームにも届く', distanceM(g, SENDAI) < 0.01, fmt(g));

    await setInput(mapPage, 'jumpInput', 'wasd');
    await clickId(mapPage, 'jumpBtn');
    await sleep(400);
    tool = await toolState(mapPage);
    const jumpError = await mapPage.$eval('#jumpError', el => el.textContent);
    check('座標へ飛ぶ: 読めない入力では動かず知らせる（入力欄の WASD でも歩かない）',
      distanceM(tool, SENDAI) < 0.01 && jumpError.length > 0, jumpError);

    // ---- 8. GPS のブレ ----
    await clickId(mapPage, 'jitterChk');
    const offsets = [];
    for (let i = 0; i < 6; i++) {
      await sleep(700);
      const t = await toolState(mapPage);
      const gg = await gameState(game);
      offsets.push(distanceM(t, gg));
    }
    await clickId(mapPage, 'jitterChk');
    check('ブレ: ゲームに届く位置が揺れる', offsets.some(d => d > 0.5), `${offsets.map(d => d.toFixed(1)).join(' / ')} m`);
    check('ブレ: 揺れは精度 10m の円に収まる', offsets.every(d => d <= 10.05));
    await sleep(700);
    tool = await toolState(mapPage);
    g = await gameState(game);
    check('ブレ: 切ると元の位置に戻る', distanceM(g, tool) < 0.01, `${distanceM(g, tool).toFixed(3)} m`);

    // ---- 9. getCurrentPosition とページ移動 ----
    const once = await game.evaluate(() => new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        e => resolve({ error: e.message }),
        { timeout: 3000 });
    }));
    check('getCurrentPosition でも今の位置が取れる', distanceM(once, tool) < 0.01, fmt(once));

    await game.goto(`${BASE}/demo-game.html`, { waitUntil: 'domcontentloaded' });
    await game.waitForFunction(() => window.demoGame && window.demoGame.updates > 0, { timeout: 5000 }).catch(() => {});
    g = await gameState(game);
    check('スイッチ: 同じタブでページを移っても有効なまま', g.enabled === true && distanceM(g, tool) < 0.01, g.reason || fmt(g));

    // ---- 10. ダンジョンを置く ----
    await setInput(mapPage, 'dgName', 'テストの祠');
    await mapPage.$eval('#dgKind', el => { el.value = 'shrine'; });
    await setInput(mapPage, 'dgRadius', '40');
    await clickId(mapPage, 'placeBtn');                    // 配置モードに入る
    const spot = await containerLatLng(mapPage, 500, 300);
    await clickMap(mapPage, 500, 300);
    await clickId(mapPage, 'placeBtn');                    // 配置モードを抜ける
    await sleep(600);
    tool = await toolState(mapPage);
    check('配置: 地図をクリックした場所にダンジョンができる', tool.dungeons === 1, `${tool.dungeons} 個`);
    check('配置: ピンは動かない（配置モード中のクリックで歩かない）', distanceM(tool, SENDAI) < 0.01, fmt(tool));
    const savedFile = await getJson('/gps/dungeons');
    const placed = savedFile.dungeons[0] || {};
    check('配置: 中継サーバーのファイルに保存される',
      savedFile.dungeons.length === 1 && placed.name === 'テストの祠' && placed.kind === 'shrine' && placed.radius === 40 && distanceM(placed, spot) < 0.5,
      `${placed.name} / ${fmt(placed)}`);
    check('配置: ゲーム側の一覧にも出る', await waitFor(async () => (await gameState(game)).dungeons === 1));
    check('配置: ゲームの地図にもダンジョンの印が出る',
      await waitFor(async () => (await game.$$('.dg-pin')).length === 1 && (await gameState(game)).map.pins === 1));
    const pinLook = await game.$eval('.dg-pin', el => ({ bg: getComputedStyle(el).backgroundImage, w: el.offsetWidth, h: el.offsetHeight })).catch(() => ({}));
    const pinImageW = await game.evaluate(src => new Promise(done => {
      const img = new Image();
      img.onload = () => done(img.naturalWidth);
      img.onerror = () => done(0);
      img.src = src;
    }), 'sprites/dungeon/shrine.png');
    check('配置: ゲームの印は種類（祠）の入口の絵で、96×96 で出る',
      /sprites\/dungeon\/shrine\.png/.test(pinLook.bg) && pinLook.w === 96 && pinLook.h === 96 && pinImageW === 384,
      `${pinLook.bg} / ${pinLook.w}×${pinLook.h} / 画像 ${pinImageW}px`);
    const labelBg = await mapPage.$eval('.dglabel', el => getComputedStyle(el).backgroundImage).catch(() => '');
    check('配置: 地図ツールの印も入口の絵（祠）で出る', /sprites\/dungeon\/shrine\.png/.test(labelBg), labelBg);
    check('配置: 範囲の外にいる間は入れない', (await gameState(game)).canEnter === null);

    // ---- 11. 歩かずに現場へ行って展開を確認 ----
    await mapPage.evaluate(() => window.fakeGpsTool.goToDungeon(window.fakeGpsTool.state.dungeons[0]));
    await sleep(600);
    tool = await toolState(mapPage);
    check('現場へ飛ぶ: ピンがダンジョンの位置へ移動する', distanceM(tool, spot) < 0.5, `${distanceM(tool, spot).toFixed(2)} m のずれ`);
    check('現場へ飛ぶ: 範囲に入ると入れるようになる', await waitFor(async () => (await gameState(game)).canEnter === placed.id));
    g = await gameState(game);
    check('現場へ飛ぶ: 地図の印が光る（入れる表示に変わる）',
      g.map.near.includes(placed.id) && (await game.$$('.dg-pin.near')).length === 1, `near=${g.map.near.join(',')}`);
    await clickId(game, 'enterBtn');
    await sleep(400);
    g = await gameState(game);
    check('展開: 入るとダンジョン画面が開く', g.inside === placed.id, `inside=${g.inside}`);
    const dungeonBody = await game.$eval('#dgBody', el => el.textContent);
    const shownCount = Number((dungeonBody.match(/敵が (\d+) 体/) || [])[1]);
    check('展開: 画面に敵の数が出る', g.battle && shownCount === g.battle.rooms, dungeonBody.replace(/\n/g, ' '));
    const lineup = g.battle ? g.battle.lineup : [];
    check('中身: 敵は種類（祠）の顔ぶれから出て、最後の部屋はボス',
      lineup.length >= 2 && lineup.every(id => id.startsWith('shrine.')) && lineup[lineup.length - 1] === 'shrine.boss', lineup.join(', '));

    // ---- 12. 途中で逃げる（決まった目で 1 回傷を負ってから） → 地図の印をタップして入り直す ----
    // 最後まで攻略すると、そのダンジョンには二度と入れないので、入り直しは攻略する前に確かめる
    const heroMid = g.hero;
    await clickId(game, 'advanceBtn');
    const hurt = await game.evaluate(() => {
      // 冒険者は 1 の目で外し、敵は 20 の目（会心）で当てる。ダメージのサイコロは真ん中の目
      const rolls = [0, 0.999];
      const random = Math.random;
      Math.random = () => (rolls.length > 0 ? rolls.shift() : 0.5);
      try {
        document.getElementById('attackBtn').click();
      } finally {
        Math.random = random;
      }
      return window.demoGame.battle;
    });
    const fleeLabel = await game.$eval('#leaveBtn', el => el.textContent);
    await clickId(game, 'leaveBtn');
    await sleep(200);
    g = await gameState(game);
    check('逃げる: 戦いの途中でも逃げて出られ、宝箱はもらえない',
      /逃げる/.test(fleeLabel) && hurt && hurt.phase === 'fight' && hurt.heroHp < hurt.heroMaxHp
        && g.inside === null && g.hero.gold === heroMid.gold && g.hero.xp === heroMid.xp,
      `${fleeLabel} / 逃げる前の HP ${hurt && hurt.heroHp} / ${hurt && hurt.heroMaxHp}`);

    await game.$eval('.dg-pin', el => el.click());
    await sleep(300);
    const popupText = await game.$eval('.dg-popup', el => el.textContent).catch(() => '');
    await game.$eval('.dg-popup button', el => el.click()).catch(() => {});
    await sleep(200);
    g = await gameState(game);
    check('地図: 印をタップすると案内が出て、そこからも入れる', /入る/.test(popupText) && g.inside === placed.id, popupText);
    check('中身: 同じダンジョンは入り直しても同じ顔ぶれ', g.battle && JSON.stringify(g.battle.lineup) === JSON.stringify(lineup),
      g.battle && g.battle.lineup.join(', '));
    check('中身: 入り直すと HP と回復薬は満タンに戻る', g.battle && g.battle.heroHp === g.battle.heroMaxHp && g.battle.potions === 3);

    // ---- 13. 最後まで戦う ----
    const heroBefore = g.hero;
    await clickId(game, 'advanceBtn');
    g = await gameState(game);
    check('戦闘: 奥へ進むと 1 部屋目の敵と戦いになる',
      g.battle.phase === 'fight' && g.battle.room === 1 && g.battle.enemyId === lineup[0], `${g.battle.phase} / ${g.battle.enemyId}`);
    check('戦闘: HP が満タンのうちは回復薬を使えない', await game.$eval('#potionBtn', el => el.disabled));
    // ボタンを押して決着まで進める（HP が半分を切ったら回復薬、それ以外は攻撃）
    const fight = await game.evaluate(() => {
      const s = window.demoGame;
      const click = id => document.getElementById(id).click();
      const out = { steps: 0, bad: [], firstLog: null };
      while (out.steps < 500 && s.battle && s.battle.phase !== 'result') {
        out.steps += 1;
        const b = s.battle;
        if (b.phase === 'room-clear') {
          click('advanceBtn');
          continue;
        }
        click(b.heroHp <= b.heroMaxHp / 2 && b.potions > 0 ? 'potionBtn' : 'attackBtn');
        const a = s.battle;
        if (a.turn !== b.turn + 1) out.bad.push(`手番 ${b.turn}→${a.turn}`);
        if (a.heroHp < 0 || a.heroHp > a.heroMaxHp) out.bad.push(`あなたの HP ${a.heroHp}`);
        if (a.enemyHp < 0) out.bad.push(`敵の HP ${a.enemyHp}`);
        if (out.firstLog === null) out.firstLog = [...document.querySelectorAll('#dgLog li')].map(li => li.textContent).join(' | ');
      }
      return { ...out, battle: s.battle, hero: s.hero, saved: localStorage.getItem('locgame.hero.v1') };
    });
    const fought = fight.battle || {};
    check('戦闘: 行動するとサイコロの目が記録に出る', /🎲\d+/.test(fight.firstLog || ''), (fight.firstLog || '').slice(0, 90));
    check('戦闘: HP は 0 未満にも最大超えにもならず、1 回の行動で手番が 1 つ進む', fight.bad.length === 0, fight.bad.slice(0, 3).join(' / '));
    check('戦闘: 最後に決着がつく（攻略か、力尽きるか）', fought.result === 'win' || fought.result === 'lose',
      `${fought.result} / ${fought.turn} 手 / ${fought.room} 部屋目`);
    const rewardOk = fought.result === 'win'
      ? fought.gold > 0 && fought.xp > 0 && fight.hero.gold === heroBefore.gold + fought.gold
        && fight.hero.xp === heroBefore.xp + fought.xp && fight.hero.cleared[placed.id] === 1
      : fight.hero.gold === heroBefore.gold && fight.hero.xp === heroBefore.xp + fought.xp;
    check('決着: 攻略なら宝箱と経験値、力尽きたら倒した分の経験値だけが入る', rewardOk,
      `${fought.result} / 💰 +${fought.gold} / 経験値 +${fought.xp}`);
    const saved = JSON.parse(fight.saved || 'null');
    check('決着: 冒険者の記録がブラウザに保存される', saved && saved.xp === fight.hero.xp && saved.gold === fight.hero.gold, fight.saved);
    await clickId(game, 'leaveBtn');
    await sleep(400);
    check('展開: 出ると元の画面に戻る', (await gameState(game)).inside === null);

    // ---- 13-1. 攻略したダンジョンには、もう入れない（力尽きたときは入り直せる） ----
    // 決着は乱数のまま。どちらになっても、その結末に合った振る舞いかを見る
    g = await gameState(game);
    const enterShown = await game.$eval('#enterBtn', el => !el.hidden);
    const glowing = (await game.$$('.dg-pin.near')).length;
    await game.$eval('.dg-pin', el => el.click());
    await sleep(300);
    const afterText = await game.$eval('.dg-popup', el => el.textContent).catch(() => '');
    const afterButtons = (await game.$$('.dg-popup button')).length;
    await game.$eval('.leaflet-popup-close-button', el => el.click()).catch(() => {});
    await sleep(100);
    check('攻略済み: 攻略したら範囲の中でも入れず（入るボタン・印の光・案内のボタンが消える）、力尽きたら入り直せる',
      fought.result === 'win'
        ? g.canEnter === null && !enterShown && glowing === 0 && /攻略済み/.test(afterText) && afterButtons === 0
        : g.canEnter === placed.id && enterShown && glowing === 1 && afterButtons === 1,
      `${fought.result} / canEnter=${g.canEnter} / 案内「${afterText}」`);

    // ---- 13-2. クエスト主から受注 → 目的地が現れる → 攻略 → クエスト主へ報告して報酬 ----
    await setInput(mapPage, 'qName', 'テストの長老');
    await mapPage.$eval('#qLook', el => { el.value = 'wizard'; el.dispatchEvent(new Event('change')); });
    await mapPage.$eval('#qKind', el => { el.value = 'goblin'; });
    const pinBeforeQuest = await toolState(mapPage);
    const giverSpot = await containerLatLng(mapPage, 350, 420);
    const targetSpot = await containerLatLng(mapPage, 720, 420);
    await clickId(mapPage, 'questBtn');
    await clickMap(mapPage, 350, 420);
    const secondStepHint = await mapPage.$eval('#questHint', el => el.textContent);
    await clickMap(mapPage, 720, 420);
    await sleep(600);
    tool = await toolState(mapPage);
    check('クエスト配置: 2 回クリックでクエスト主と目的地がセットで置かれ、ピンは動かない',
      tool.quests === 1 && tool.dungeons === 2 && distanceM(tool, pinBeforeQuest) < 0.01 && /目的地/.test(secondStepHint),
      `クエスト主 ${tool.quests} 人 / ダンジョン ${tool.dungeons} 個 / 2 回目の案内「${secondStepHint}」`);
    const questWorld = await getJson('/gps/dungeons');
    const quest = questWorld.quests[0] || {};
    const questTarget = questWorld.dungeons.find(d => d.id === quest.dungeonId) || {};
    check('クエスト配置: 中継サーバーに保存され、目的地は questId 付きのダンジョンになる',
      questWorld.quests.length === 1 && quest.name === 'テストの長老' && quest.look === 'wizard' && distanceM(quest, giverSpot) < 0.5
        && questTarget.questId === quest.id && questTarget.kind === 'goblin' && distanceM(questTarget, targetSpot) < 0.5,
      `${quest.name} / ${quest.look} → ${questTarget.name}`);

    const giverShown = await waitFor(async () => (await gameState(game)).quests === 1 && (await game.$$('.qg-pin')).length === 1);
    g = await gameState(game);
    const giverSprite = await game.$eval('.qg-pin .npc', el => el.style.backgroundImage).catch(() => '');
    check('受注前: クエスト主が専用の絵で地図に出て、目的地のダンジョンは地図にも一覧にも出ない',
      giverShown && /sprites\/npc\/wizard\.png/.test(giverSprite) && g.dungeons === 1 && (await game.$$('.dg-pin')).length === 1,
      `${giverSprite} / ダンジョン ${g.dungeons} 個`);
    check('受注前: 離れていると話しかけられない', g.canTalk === null && await game.$eval('#talkBtn', el => el.hidden));
    const spriteStatus = await game.evaluate(() => Promise.all(window.QuestRules.LOOKS.map(look =>
      fetch(window.QuestRules.spriteUrl(look.id)).then(r => `${look.id}:${r.status}:${r.headers.get('content-type')}`))));
    check('クエスト主の絵: 見た目の一覧にある絵が全部サーバーから届く',
      spriteStatus.length > 0 && spriteStatus.every(s => s.endsWith(':200:image/png')),
      `${spriteStatus.length} 人 ${spriteStatus.filter(s => !s.endsWith(':200:image/png')).join(' / ')}`);

    await mapPage.evaluate(() => window.fakeGpsTool.goToDungeon(window.fakeGpsTool.state.quests[0]));
    const canTalk = await waitFor(async () => (await gameState(game)).canTalk === quest.id);
    check('受注: クエスト主に近づくと話しかけるボタンが出て、足元が光る',
      canTalk && (await game.$$('.qg-pin.near')).length === 1 && !(await game.$eval('#talkBtn', el => el.hidden)));
    await clickId(game, 'talkBtn');
    await sleep(200);
    g = await gameState(game);
    const askText = await game.$eval('#talkText', el => el.textContent);
    const askButtons = await game.$$eval('#talkActions button', els => els.map(el => el.id));
    check('会話: 依頼の言葉と報酬が出て、引き受ける / 断る を選べる',
      g.talking === quest.id && /報酬/.test(askText) && askButtons.includes('talkAcceptBtn') && askButtons.includes('talkDeclineBtn'),
      askText.replace(/\n/g, ' ').slice(0, 70));
    await clickId(game, 'talkDeclineBtn');
    await sleep(200);
    g = await gameState(game);
    check('断る: 何も変わらず、目的地は出ないまま', g.talking === null && !g.questState[quest.id] && g.dungeons === 1,
      `会話 ${g.talking} / 進み具合 ${g.questState[quest.id]} / ダンジョン ${g.dungeons} 個`);

    // 今度は地図のクエスト主をタップして話しかけ、引き受ける
    await game.$eval('.qg-pin', el => el.click());
    await sleep(300);
    const giverPopupText = await game.$eval('.qg-popup', el => el.textContent).catch(() => '');
    await game.$eval('.qg-popup button', el => el.click()).catch(() => {});
    await sleep(200);
    const talkingFromMap = (await gameState(game)).talking;
    check('地図: クエスト主をタップすると案内が出て、そこからも話しかけられる',
      /話しかける/.test(giverPopupText) && talkingFromMap === quest.id, giverPopupText);
    await game.$eval('#talkAcceptBtn', el => el.click()).catch(() => {});
    await sleep(300);
    g = await gameState(game);
    const savedProgress = JSON.parse(await game.evaluate(() => localStorage.getItem('locgame.quests.v1')) || '{}');
    check('引き受ける: 目的地のダンジョンが地図に現れ、進み具合がブラウザに保存される',
      g.questState[quest.id] === 'accepted' && savedProgress[quest.id] === 'accepted' && g.dungeons === 2
        && (await game.$$('.dg-pin')).length === 2 && g.talking === null,
      `進み具合 ${JSON.stringify(savedProgress)} / ダンジョン ${g.dungeons} 個`);
    const questLine = await game.$eval('#questLine', el => (el.hidden ? '' : el.textContent));
    const view = g.map && g.map.bounds;
    const targetInView = Boolean(view) && questTarget.lat >= view.south && questTarget.lat <= view.north
      && questTarget.lng >= view.west && questTarget.lng <= view.east;
    check('引き受ける: 次に向かう目的地と距離が画面に出て、地図が目的地まで見えるように引く',
      questLine.includes(questTarget.name) && targetInView && g.map.follow === false && await game.$eval('#toast', el => !el.hidden),
      questLine);

    await clickId(game, 'talkBtn');
    await sleep(200);
    const acceptedText = await game.$eval('#talkText', el => el.textContent);
    const acceptedButtons = await game.$$eval('#talkActions button', els => els.map(el => el.id));
    await clickId(game, 'talkCloseBtn');
    await sleep(100);
    check('受注中: 話しかけると目的地の方角と距離を教えてくれ、まだ報酬は受け取れない',
      acceptedText.includes(questTarget.name) && /[北東南西]+へ \d+ m/.test(acceptedText) && !acceptedButtons.includes('talkReportBtn'),
      acceptedText.replace(/\n/g, ' '));

    await mapPage.evaluate(id => window.fakeGpsTool.goToDungeon(window.fakeGpsTool.state.dungeons.find(d => d.id === id)), questTarget.id);
    check('目的地: 近づくと入れる', await waitFor(async () => (await gameState(game)).canEnter === questTarget.id));
    const heroBeforeQuestRun = (await gameState(game)).hero;
    const questRun = await game.evaluate(() => {
      const s = window.demoGame;
      const click = id => document.getElementById(id).click();
      const random = Math.random;
      // 毎回 20 の目 = 冒険者の会心の一撃で、敵は反撃する前に倒れる（依頼の流れを見るため決着を固定する）
      Math.random = () => 0.999;
      try {
        click('enterBtn');
        for (let i = 0; i < 50 && s.battle && s.battle.phase !== 'result'; i++) click(s.battle.phase === 'fight' ? 'attackBtn' : 'advanceBtn');
      } finally {
        Math.random = random;
      }
      return { inside: s.inside, battle: s.battle, hero: s.hero, questState: { ...s.questState }, body: document.getElementById('dgBody').textContent };
    });
    const questBattle = questRun.battle || {};
    check('目的地: 攻略すると依頼が「報告できる」になり、依頼の報酬はまだ入らない（宝箱と経験値だけ）',
      questRun.inside === questTarget.id && questBattle.result === 'win' && questRun.questState[quest.id] === 'cleared'
        && questRun.hero.gold === heroBeforeQuestRun.gold + questBattle.gold && questRun.hero.xp === heroBeforeQuestRun.xp + questBattle.xp
        && /報告/.test(questRun.body),
      `${questBattle.result} / ${questRun.body.replace(/\n/g, ' ')}`);
    await clickId(game, 'leaveBtn');
    await sleep(200);
    g = await gameState(game);
    check('攻略済み: 攻略した目的地には、範囲の中にいてももう入れない',
      g.canEnter === null && g.hero.cleared[questTarget.id] === 1 && await game.$eval('#enterBtn', el => el.hidden),
      `canEnter=${g.canEnter}`);

    await mapPage.evaluate(() => window.fakeGpsTool.goToDungeon(window.fakeGpsTool.state.quests[0]));
    await waitFor(async () => (await gameState(game)).canTalk === quest.id);
    const reward = await game.evaluate(() => window.QuestRules.REQUESTS.goblin);
    const heroBeforeReport = (await gameState(game)).hero;
    const markBeforeReport = await game.$eval('.qg-mark', el => el.textContent).catch(() => '');
    await clickId(game, 'talkBtn');
    await sleep(200);
    await game.$eval('#talkReportBtn', el => el.click()).catch(() => {});
    await sleep(200);
    g = await gameState(game);
    const reportText = await game.$eval('#talkText', el => el.textContent);
    check('報告: 頭の上が ? になり、報告すると依頼の報酬が入って、目的地のダンジョンは消える',
      markBeforeReport === '?' && g.questState[quest.id] === 'done'
        && g.hero.gold === heroBeforeReport.gold + reward.gold && g.hero.xp === heroBeforeReport.xp + reward.xp
        && g.dungeons === 1 && (await game.$$('.dg-pin')).length === 1,
      `印「${markBeforeReport}」 / ${reportText.replace(/\n/g, ' ')}`);
    await clickId(game, 'talkCloseBtn');
    await sleep(100);
    await clickId(game, 'talkBtn');
    await sleep(200);
    const doneButtons = await game.$$eval('#talkActions button', els => els.map(el => el.id));
    await clickId(game, 'talkCloseBtn');
    await sleep(100);
    check('報告の後: もう一度話しかけても、依頼も報酬も出ない',
      !doneButtons.includes('talkAcceptBtn') && !doneButtons.includes('talkReportBtn') && (await game.$$('.qg-mark')).length === 0,
      doneButtons.join(','));

    const badSave = await postJson('/gps/dungeons', { dungeons: questWorld.dungeons.filter(d => !d.questId), quests: questWorld.quests });
    const afterBadSave = await getJson('/gps/dungeons');
    check('サーバー: 目的地の無いクエスト主は保存を断り、ファイルは変わらない',
      badSave.status === 400 && afterBadSave.quests.length === 1 && afterBadSave.dungeons.length === 2, `HTTP ${badSave.status}`);
    const oldClientSave = await postJson('/gps/dungeons', { dungeons: questWorld.dungeons });
    const afterOldClient = await getJson('/gps/dungeons');
    check('サーバー: quests を送らない古い画面から保存しても、クエスト主は消えない',
      oldClientSave.status === 200 && afterOldClient.quests.length === 1, `HTTP ${oldClientSave.status}`);

    await mapPage.evaluate(id => window.fakeGpsTool.removeQuest(id), quest.id);
    await sleep(600);
    const afterQuestDelete = await getJson('/gps/dungeons');
    check('クエスト削除: 目的地のダンジョンも一緒に消え、ゲームからもクエスト主がいなくなる',
      afterQuestDelete.quests.length === 0 && afterQuestDelete.dungeons.length === 1
        && await waitFor(async () => (await gameState(game)).quests === 0 && (await game.$$('.qg-pin')).length === 0),
      `クエスト主 ${afterQuestDelete.quests.length} 人 / ダンジョン ${afterQuestDelete.dungeons.length} 個`);

    // ---- 14. ルール（決まった目を振らせて確かめる） ----
    const rules = await game.evaluate(() => {
      const R = window.DungeonRules;
      const seq = values => { let i = 0; return () => values[i++ % values.length]; };
      const face = (n, sides) => (n - 0.5) / sides;   // その目が出る乱数の値
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 3000; i++) {
        const v = R.rollDice('2d4+2', Math.random);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const run = R.startRun({ id: 'verify-1', kind: 'goblin' }, 0);
      R.advance(run);
      run.enemy.hp = 99;
      run.enemy.maxHp = 99;
      // 冒険者は 20 の目（会心: 1d8+3 を 8・8 で振って 19）、敵は 1 の目（大失敗）
      R.act(run, 'attack', seq([face(20, 20), face(8, 8), face(8, 8), face(1, 20)]));
      const crit = 99 - run.enemy.hp;
      const heroHpAfterFumble = run.hero.hp;
      const hpBefore = run.enemy.hp;
      R.act(run, 'attack', seq([face(1, 20)]));        // 1 の目は必ず外れ
      const fumbleDamage = hpBefore - run.enemy.hp;
      run.hero.hp = 5;
      const potions = run.hero.potions;
      R.act(run, 'potion', seq([face(3, 4), face(3, 4), face(1, 20)]));   // 2d4+2 を 3・3 で振って 8 回復
      return {
        range: [lo, hi], crit, heroHpAfterFumble, heroMaxHp: run.hero.maxHp, fumbleDamage,
        heal: run.hero.hp - 5, potionsUsed: potions - run.hero.potions,
        levels: [0, 99, 100, 299, 300].map(xp => R.levelInfo(xp).level),
      };
    });
    check('ルール: 2d4+2 は 4〜10 に収まる', rules.range[0] === 4 && rules.range[1] === 10, rules.range.join('〜'));
    check('ルール: 20 の目は会心でダメージのサイコロを倍振り、1 の目は必ず外れる',
      rules.crit === 19 && rules.fumbleDamage === 0 && rules.heroHpAfterFumble === rules.heroMaxHp, `会心 ${rules.crit} / 1 の目 ${rules.fumbleDamage}`);
    check('ルール: 回復薬は 1 つ減り、振った分だけ回復する', rules.heal === 8 && rules.potionsUsed === 1, `+${rules.heal} / ${rules.potionsUsed} 個`);
    check('ルール: 経験値 100 で Lv 2、300 で Lv 3', JSON.stringify(rules.levels) === '[1,1,2,2,3]', rules.levels.join(','));

    // ---- 14-2. 依頼のルール ----
    const questRules = await game.evaluate(() => {
      const Q = window.QuestRules;
      const junkDropped = JSON.stringify(Q.normalizeProgress({ a: 'done', b: 'bogus', c: 3 })) === '{"a":"done"}';
      const list = [{ id: 'q1', dungeonId: 'd1' }];
      const notAccepted = Q.markCleared({}, list, 'd1').cleared.length === 0;
      let p = Q.accept({}, 'q1');
      const early = Q.report(p, 'q1', 'goblin').reward;
      p = Q.markCleared(p, list, 'd1').progress;
      const first = Q.report(p, 'q1', 'goblin');
      const second = Q.report(first.progress, 'q1', 'goblin');
      return { junkDropped, notAccepted, early, first: first.reward, second: second.reward, reaccept: Q.accept(first.progress, 'q1').q1 };
    });
    check('依頼のルール: 受けていない依頼は攻略しても達成にならず、報酬は攻略した後に 1 回だけ',
      questRules.junkDropped && questRules.notAccepted && questRules.early === null && questRules.first !== null
        && questRules.second === null && questRules.reaccept === 'done',
      JSON.stringify(questRules));

    // ---- 15. 削除 ----
    await mapPage.evaluate(() => window.fakeGpsTool.removeDungeon(window.fakeGpsTool.state.dungeons[0].id));
    await sleep(600);
    const afterDelete = await getJson('/gps/dungeons');
    check('削除: サーバーからもゲームからも消える',
      afterDelete.dungeons.length === 0 && await waitFor(async () => (await gameState(game)).dungeons === 0),
      `残り ${afterDelete.dungeons.length} 個`);

    // ---- 15-2. 地図の部品(Leaflet)が読めなくても遊べる ----
    const noLeaflet = await browser.newPage();
    watchErrors(noLeaflet, 'no-leaflet');
    await noLeaflet.setRequestInterception(true);
    noLeaflet.on('request', req => (/leaflet/i.test(req.url()) ? req.abort() : req.continue()));
    await noLeaflet.goto(`${BASE}/demo-game.html?fakegps=1`, { waitUntil: 'domcontentloaded' });
    await noLeaflet.waitForFunction(() => window.demoGame && window.demoGame.updates > 0, { timeout: 5000 }).catch(() => {});
    await sleep(300);
    const noLeafletState = await noLeaflet.evaluate(() => ({
      leaflet: typeof window.L,
      notice: !document.getElementById('noMap').hidden,
      updates: window.demoGame.updates,
      map: window.demoGame.map,
    }));
    check('地図が読めなくても: 案内を出し、位置と一覧だけで遊べる',
      noLeafletState.leaflet === 'undefined' && noLeafletState.notice && noLeafletState.updates > 0 && noLeafletState.map === null,
      JSON.stringify(noLeafletState));
    await noLeaflet.close();

    // ---- 16. 差し替えてはいけない場面 ----
    const plain = await browser.newPage();
    watchErrors(plain, 'plain');
    await plain.goto(`${BASE}/demo-game.html`, { waitUntil: 'domcontentloaded' });
    const plainState = await plain.evaluate(() => ({
      enabled: window.fakeGps.enabled,
      native: /\[native code\]/.test(String(navigator.geolocation.watchPosition)),
    }));
    check('スイッチ無し: 差し替えず本物の位置情報を使う', plainState.enabled === false && plainState.native, JSON.stringify(plainState));
    await plain.close();

    const other = await browser.newPage();
    watchErrors(other, 'other-host');
    await other.goto(`http://${OTHER_HOST}:${PORT}/demo-game.html?fakegps=1`, { waitUntil: 'domcontentloaded' });
    const otherState = await other.evaluate(() => ({
      host: location.hostname,
      enabled: window.fakeGps.enabled,
      reason: window.fakeGps.reason,
      native: /\[native code\]/.test(String(navigator.geolocation.watchPosition)),
    }));
    check('公開ホスト: ?fakegps=1 を付けても差し替えない',
      otherState.host === OTHER_HOST && otherState.enabled === false && otherState.native, `${otherState.host} / ${otherState.reason}`);
    await other.close();

    // ---- 17. スマホ相当（自宅 LAN の .local ホスト）では有効 ----
    const lan = await browser.newPage();
    watchErrors(lan, 'lan-host');
    await lan.goto(`http://${LAN_HOST}:${PORT}/demo-game.html?fakegps=1`, { waitUntil: 'domcontentloaded' });
    await lan.waitForFunction(() => window.demoGame && window.demoGame.updates > 0, { timeout: 5000 }).catch(() => {});
    const lanState = await lan.evaluate(() => ({
      host: location.hostname,
      enabled: window.fakeGps.enabled,
      reason: window.fakeGps.reason,
      ...window.demoGame,
    }));
    tool = await toolState(mapPage);   // 期待値は固定座標でなく「いまのピンの位置」
    check('自宅LAN(.local): スマホのように別ホストから開いても位置が届く',
      lanState.host === LAN_HOST && lanState.enabled === true && lanState.updates > 0 && distanceM(lanState, tool) < 0.01,
      `${lanState.host} / ${fmt(lanState)}`);
    await lan.close();

    // ---- 18. ゲームを閉じる ----
    await game.close();
    check('地図ツール: 閉じたゲームは数えなくなる', await waitPeers(mapPage, 0), `${(await toolState(mapPage)).peers} つ`);

    check('ページ上のエラーが無い', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 合格`);
  return failed.length > 0 ? 1 : 0;
}

main().then(
  code => process.exit(code),
  err => {
    console.error('[verify] 実行エラー:', err);
    process.exit(2);
  });
