/*
 * fake-gps.js — 疑似GPSの差し替え部品（PC / スマホ対応・中継サーバー版）
 *
 * 自作の位置ゲーの <head> で、ゲーム本体のスクリプトより先に読み込む。
 *   <script src="fake-gps.js"></script>
 *
 * URL に ?fakegps=1 を付けて開いたときだけ、navigator.geolocation を
 * 中継サーバー(server.js)経由で地図ツール(map.html)のピンの位置に差し替える。
 * 付けなければ何もしないので、スマホ実機では本物の GPS がそのまま使われる。?fakegps=0 で解除。
 *
 * 有効になるのは localhost / 自宅 LAN(プライベートIP・.local)から開いたときだけ。
 * 公開先(GitHub Pages 等の外部ホスト)では付けても無効なので、遊ぶ人はごまかせない。
 * 位置は server.js が Server-Sent Events で配る。ゲームは同じサーバーから配信されている前提。
 */
(function () {
  'use strict';

  var STREAM_URL = '/gps/stream?role=game';
  var SWITCH_KEY = 'fakeGps.enabled';
  var DEFAULT_ACCURACY_M = 10;

  var api = { enabled: false, connected: false, reason: '', last: null };
  window.fakeGps = api;

  // ?fakegps=1 / 0 はタブ内で覚える(ゲーム内でページを移っても切れないように)
  function readSwitch() {
    var value = new URLSearchParams(location.search).get('fakegps');
    try {
      if (value === '1' || value === '0') sessionStorage.setItem(SWITCH_KEY, value);
      return sessionStorage.getItem(SWITCH_KEY) === '1';
    } catch (e) {
      return value === '1';
    }
  }

  // localhost と自宅 LAN(プライベートIP・.local)だけ許す。公開ホストは拒否する
  function isLocalOrLan(host) {
    if (!host) return false;
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
    if (host.slice(-6) === '.local' || host.slice(-10) === '.localhost') return true;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    var a = +m[1], b = +m[2];
    if (a === 127) return true;                       // ループバック
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 (link-local)
    return false;
  }

  if (!readSwitch()) {
    api.reason = 'URL に ?fakegps=1 が無い';
    return;
  }
  if (!isLocalOrLan(location.hostname)) {
    api.reason = 'localhost / 自宅LAN 以外では使えない';
    console.warn('[fake-gps] ' + api.reason + ': ' + location.hostname);
    return;
  }
  if (typeof EventSource === 'undefined') {
    api.reason = 'このブラウザは Server-Sent Events に対応していない';
    console.warn('[fake-gps] ' + api.reason);
    return;
  }

  var watchers = {};        // watchPosition の id → { success, error, timer }
  var nextWatchId = 1;
  var pendingOnce = [];     // 位置が届くのを待っている getCurrentPosition

  function isValidPosition(p) {
    return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng);
  }

  // 本物の GeolocationPosition と同じ形にする
  function toPosition(p) {
    return {
      coords: {
        latitude: p.lat,
        longitude: p.lng,
        accuracy: typeof p.accuracy === 'number' ? p.accuracy : DEFAULT_ACCURACY_M,
        altitude: null,
        altitudeAccuracy: null,
        heading: typeof p.heading === 'number' ? p.heading : null,
        speed: typeof p.speed === 'number' ? p.speed : null
      },
      timestamp: typeof p.ts === 'number' ? p.ts : Date.now()
    };
  }

  function timeoutError() {
    return {
      code: 3,
      message: '疑似GPS: 地図ツールから位置が届かない(map.html を開いてください)',
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3
    };
  }

  function hasTimeout(options) {
    return !!options && typeof options.timeout === 'number' && isFinite(options.timeout) && options.timeout >= 0;
  }

  // ゲーム側のコールバックが例外を投げても配信を止めない(本物と同じくコンソールには出す)
  function safeCall(fn, arg) {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (e) {
      setTimeout(function () { throw e; }, 0);
    }
  }

  function deliver(msg) {
    api.last = msg;
    var pos = toPosition(msg);
    Object.keys(watchers).forEach(function (id) {
      var w = watchers[id];
      if (!w) return;   // 直前のコールバックで clearWatch された
      if (w.timer) {
        clearTimeout(w.timer);
        w.timer = null;
      }
      safeCall(w.success, pos);
    });
    var waiting = pendingOnce;
    pendingOnce = [];
    waiting.forEach(function (req) {
      if (req.timer) clearTimeout(req.timer);
      safeCall(req.success, pos);
    });
  }

  var es = new EventSource(STREAM_URL);
  es.addEventListener('open', function () { api.connected = true; });
  es.addEventListener('error', function () { api.connected = false; });  // EventSource が自動で再接続する
  es.addEventListener('position', function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (isValidPosition(msg)) deliver(msg);
  });

  var fakeGeolocation = {
    getCurrentPosition: function (success, error, options) {
      if (api.last) {
        var pos = toPosition(api.last);
        setTimeout(function () { safeCall(success, pos); }, 0);
        return;
      }
      var req = { success: success, timer: null };
      if (hasTimeout(options)) {
        req.timer = setTimeout(function () {
          pendingOnce = pendingOnce.filter(function (r) { return r !== req; });
          safeCall(error, timeoutError());
        }, options.timeout);
      }
      pendingOnce.push(req);
    },

    watchPosition: function (success, error, options) {
      var id = nextWatchId++;
      var w = { success: success, error: error, timer: null };
      watchers[id] = w;
      if (api.last) {
        var pos = toPosition(api.last);
        setTimeout(function () {
          if (watchers[id]) safeCall(success, pos);
        }, 0);
      } else if (hasTimeout(options)) {
        w.timer = setTimeout(function () {
          w.timer = null;
          if (watchers[id]) safeCall(error, timeoutError());
        }, options.timeout);
      }
      return id;
    },

    clearWatch: function (id) {
      var w = watchers[id];
      if (!w) return;
      if (w.timer) clearTimeout(w.timer);
      delete watchers[id];
    }
  };

  try {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      get: function () { return fakeGeolocation; }
    });
  } catch (e) {
    // 差し替えに失敗したら本物のまま動かす
  }
  if (navigator.geolocation !== fakeGeolocation) {
    api.reason = 'navigator.geolocation を差し替えられなかった';
    console.warn('[fake-gps] ' + api.reason);
    es.close();
    return;
  }

  api.enabled = true;

  // 疑似GPS で動いていることが画面でわかるように、左下に小さな札を出す
  function showBadge() {
    var badge = document.createElement('div');
    badge.textContent = '📍 疑似GPS';
    badge.title = '地図ツール(map.html)のピンの位置を使っています';
    badge.setAttribute('data-fake-gps-badge', '');
    badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:3px 8px;' +
      'border-radius:10px;background:rgba(200,40,40,.85);color:#fff;font:12px/1.4 sans-serif;pointer-events:none;';
    document.body.appendChild(badge);
  }
  if (document.body) showBadge();
  else document.addEventListener('DOMContentLoaded', showBadge);
})();
