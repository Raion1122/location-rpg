// dungeon.js — ダンジョンの中身（敵の顔ぶれ・サイコロ・戦いのルール）
//
// 画面(DOM)には触らない。demo-game.html が読み込み、window.DungeonRules として使う。
// Node からも require できる（ルールだけを試したいとき用）。
//
// サイコロを振る関数はすべて rng（0 以上 1 未満を返す関数）を引数で受け取る。
// ふだんは Math.random、検証では決まった目を返す関数を渡す。
//
// 敵を増やすとき: MONSTERS に 1 行足し、LINEUPS の minions に id を並べるだけでよい。
'use strict';

(function (root) {
  // ---- 敵 ----
  // D&D 風の数値: hp = 体力 / ac = 防御（命中の合計がこれ以上なら当たる）/ atk = 命中の上乗せ
  //               dmg = ダメージのサイコロ / xp = 倒したときの経験値
  const MONSTERS = {
    'goblin.grunt':    { name: 'ゴブリン',       emoji: '👺', hp: 7,  ac: 13, atk: 4, dmg: '1d6+2',  xp: 25 },
    'goblin.archer':   { name: 'ゴブリンの弓兵', emoji: '🏹', hp: 6,  ac: 12, atk: 4, dmg: '1d6+1',  xp: 25 },
    'goblin.boss':     { name: 'ゴブリンの親分', emoji: '👹', hp: 16, ac: 15, atk: 4, dmg: '1d8+2',  xp: 100 },

    'bandit.thug':     { name: '盗賊',           emoji: '🗡️', hp: 9,  ac: 12, atk: 3, dmg: '1d6+1',  xp: 25 },
    'bandit.lookout':  { name: '盗賊の見張り',   emoji: '🔭', hp: 8,  ac: 13, atk: 3, dmg: '1d4+2',  xp: 25 },
    'bandit.boss':     { name: '盗賊の頭',       emoji: '🦹', hp: 20, ac: 14, atk: 4, dmg: '1d8+2',  xp: 100 },

    'shrine.wisp':     { name: '狐火',           emoji: '🔥', hp: 6,  ac: 13, atk: 4, dmg: '1d4+2',  xp: 25 },
    'shrine.moss':     { name: '苔の番人',       emoji: '🌿', hp: 12, ac: 11, atk: 3, dmg: '1d6+2',  xp: 35 },
    'shrine.boss':     { name: '祠のぬし',       emoji: '🦊', hp: 24, ac: 13, atk: 4, dmg: '1d8+3',  xp: 120 },

    'orc.scout':       { name: 'オークの斥候',   emoji: '🪓', hp: 11, ac: 12, atk: 4, dmg: '1d6+2',  xp: 50 },
    'orc.warrior':     { name: 'オーク',         emoji: '👊', hp: 15, ac: 13, atk: 5, dmg: '1d10+3', xp: 75 },
    'orc.boss':        { name: 'オークの戦士長', emoji: '🐗', hp: 30, ac: 15, atk: 5, dmg: '1d12+3', xp: 250 },

    'tomb.skeleton':   { name: 'スケルトン',     emoji: '💀', hp: 13, ac: 13, atk: 4, dmg: '1d6+2',  xp: 50 },
    'tomb.zombie':     { name: 'ゾンビ',         emoji: '🧟', hp: 22, ac: 8,  atk: 3, dmg: '1d6+1',  xp: 50 },
    'tomb.boss':       { name: '墓所の主',       emoji: '👻', hp: 32, ac: 14, atk: 5, dmg: '1d8+3',  xp: 200 },

    'dragon.kobold':   { name: 'コボルド',       emoji: '🦎', hp: 5,  ac: 12, atk: 4, dmg: '1d4+2',  xp: 25 },
    'dragon.wyrmling': { name: '子竜',           emoji: '🐲', hp: 30, ac: 16, atk: 5, dmg: '1d10+3', xp: 300 },
    'dragon.boss':     { name: '竜',             emoji: '🐉', hp: 60, ac: 17, atk: 7, dmg: '2d8+4',  xp: 1000 },
  };

  // ---- ダンジョンの種類ごとの顔ぶれ（id は地図ツールの「種類」と同じ） ----
  // danger = 危険度 1〜5 / treasure = 攻略したときの宝箱のサイコロ / blurb = 入口の一文
  const LINEUPS = {
    goblin: { minions: ['goblin.grunt', 'goblin.archer'], boss: 'goblin.boss', danger: 1, treasure: '3d10',
      blurb: '湿った穴の奥から、キーキーと甲高い声が響く。' },
    bandit: { minions: ['bandit.thug', 'bandit.lookout'], boss: 'bandit.boss', danger: 1, treasure: '4d10',
      blurb: '焚き火の跡がまだ温かい。見張りがこちらに気づいた。' },
    shrine: { minions: ['shrine.wisp', 'shrine.moss'], boss: 'shrine.boss', danger: 2, treasure: '4d10',
      blurb: '鳥居をくぐると、ふっと空気が冷えた。青い火がゆらめいている。' },
    orc: { minions: ['orc.scout', 'orc.warrior'], boss: 'orc.boss', danger: 4, treasure: '8d10',
      blurb: '太鼓の音。大きな影がいくつも、斧を担いで立ち上がる。' },
    tomb: { minions: ['tomb.skeleton', 'tomb.zombie'], boss: 'tomb.boss', danger: 3, treasure: '6d10',
      blurb: '石の扉がひとりでに閉まった。暗がりで骨の鳴る音がする。' },
    dragon: { minions: ['dragon.kobold', 'dragon.wyrmling'], boss: 'dragon.boss', danger: 5, treasure: '20d10',
      blurb: '洞窟の奥が赤く光っている。硫黄の匂いと、巨大な寝息。' },
  };
  const DEFAULT_KIND = 'goblin';   // 知らない種類が来たら、これの顔ぶれで遊ぶ

  // ---- 冒険者 ----
  const POTIONS_PER_RUN = 3;       // 入るたびに満タン
  const POTION_HEAL = '2d4+2';
  const MAX_LEVEL = 20;
  const MAX_LOG = 50;

  const tableFor = kind => LINEUPS[kind] || LINEUPS[DEFAULT_KIND];

  // ---- サイコロ ----
  // '2d4+2' → { count: 2, sides: 4, bonus: 2 }
  function parseDice(expr) {
    const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(String(expr).replace(/\s+/g, ''));
    if (!m) throw new Error(`サイコロの書き方が不正です: ${expr}`);
    return { count: Number(m[1]), sides: Number(m[2]), bonus: m[3] ? Number(m[3]) : 0 };
  }

  const rollDie = (sides, rng) => Math.min(sides, 1 + Math.floor(rng() * sides));

  // crit = 会心。D&D と同じく、サイコロの数だけを倍にする（上乗せは倍にしない）
  function rollDice(expr, rng, crit = false) {
    const { count, sides, bonus } = parseDice(expr);
    let sum = 0;
    for (let i = 0; i < (crit ? count * 2 : count); i++) sum += rollDie(sides, rng);
    return Math.max(0, sum + bonus);
  }

  // ---- 敵の数と顔ぶれ ----
  // ダンジョンの id から決める ⇒ 同じダンジョンなら、誰が何度入っても同じ
  function hashId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
    return h;
  }

  // 同じ種(seed)なら毎回同じ並びを返す乱数（mulberry32）
  function seededRng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const monsterCount = id => 2 + (hashId(id) % 4);

  // 最後の部屋はボス。それまでは種類ごとの手下から選ぶ
  function lineupFor(dungeon) {
    const table = tableFor(dungeon.kind);
    const rng = seededRng(hashId(dungeon.id));
    const ids = [];
    for (let i = 1; i < monsterCount(dungeon.id); i++) ids.push(table.minions[Math.floor(rng() * table.minions.length)]);
    ids.push(table.boss);
    return ids;
  }

  // ---- 冒険者の成長 ----
  // 累計の経験値から Lv を出す。Lv2 = 100、Lv3 = 300、Lv4 = 600 …（次の Lv まで「今の Lv × 100」）
  function levelInfo(totalXp) {
    let level = 1;
    let floor = 0;
    while (level < MAX_LEVEL && totalXp >= floor + level * 100) {
      floor += level * 100;
      level += 1;
    }
    return { level, into: totalXp - floor, need: level < MAX_LEVEL ? level * 100 : null };
  }

  function heroStats(level) {
    return { maxHp: 24 + level * 6, ac: 15 + Math.floor((level - 1) / 4), atk: 4 + level, dmg: `1d8+${2 + level}` };
  }

  function newHero() {
    return { xp: 0, gold: 0, cleared: {} };
  }

  // 保存から読んだ値は壊れているかもしれないので、形の合う部分だけ使う
  function normalizeHero(raw) {
    const hero = newHero();
    if (!raw || typeof raw !== 'object') return hero;
    if (Number.isSafeInteger(raw.xp) && raw.xp >= 0) hero.xp = raw.xp;
    if (Number.isSafeInteger(raw.gold) && raw.gold >= 0) hero.gold = raw.gold;
    if (raw.cleared && typeof raw.cleared === 'object') {
      for (const [id, n] of Object.entries(raw.cleared)) {
        if (Number.isSafeInteger(n) && n > 0) hero.cleared[id] = n;
      }
    }
    return hero;
  }

  // 挑戦の結果を足した「新しい記録」を返す（元の記録は書き換えない）
  // 倒した敵の経験値はどう終わっても持ち帰れ、宝箱は攻略したときだけ
  function settle(hero, run) {
    const cleared = { ...hero.cleared };
    if (run.result === 'win') cleared[run.dungeonId] = (cleared[run.dungeonId] || 0) + 1;
    const next = { xp: hero.xp + run.xp, gold: hero.gold + run.gold, cleared };
    return { hero: next, levelUps: levelInfo(next.xp).level - levelInfo(hero.xp).level };
  }

  // ---- 1 回の挑戦 ----
  function startRun(dungeon, totalXp) {
    const table = tableFor(dungeon.kind);
    const level = levelInfo(totalXp).level;
    const stats = heroStats(level);
    return {
      dungeonId: dungeon.id,
      kind: LINEUPS[dungeon.kind] ? dungeon.kind : DEFAULT_KIND,
      danger: table.danger,
      blurb: table.blurb,
      lineup: lineupFor(dungeon),
      room: 0,                 // いま何部屋目か（0 = まだ入口）
      phase: 'intro',          // intro → fight ⇄ room-clear → result
      hero: { level, ...stats, hp: stats.maxHp, potions: POTIONS_PER_RUN },
      enemy: null,
      turn: 0,
      xp: 0,                   // この挑戦で倒した敵の経験値の合計
      gold: 0,                 // 攻略したときの宝箱
      result: null,            // 'win' | 'lose' | 'left'
      log: [],                 // 新しいものが先頭
    };
  }

  function addLog(run, text) {
    run.log.unshift(text);
    if (run.log.length > MAX_LOG) run.log.length = MAX_LOG;
  }

  function spawn(monsterId) {
    const m = MONSTERS[monsterId];
    return { id: monsterId, name: m.name, emoji: m.emoji, hp: m.hp, maxHp: m.hp, ac: m.ac, atk: m.atk, dmg: m.dmg, xp: m.xp };
  }

  // 入口 → 1 部屋目、敵を倒した後 → 次の部屋へ
  function advance(run) {
    if (run.phase !== 'intro' && run.phase !== 'room-clear') return false;
    run.room += 1;
    run.enemy = spawn(run.lineup[run.room - 1]);
    run.phase = 'fight';
    const { emoji, name } = run.enemy;
    addLog(run, run.room === run.lineup.length
      ? `🚪 最後の部屋。${emoji} ${name} が待ち構えている！`
      : `🚪 ${run.room} 部屋目。${emoji} ${name} が現れた！`);
    return true;
  }

  // d20 ＋ 命中の上乗せ が相手の防御以上なら命中。20 の目は会心、1 の目は必ず外れ
  function strike(attacker, defender, rng) {
    const d20 = rollDie(20, rng);
    const crit = d20 === 20;
    const fumble = d20 === 1;
    const total = d20 + attacker.atk;
    const hit = !fumble && (crit || total >= defender.ac);
    const damage = hit ? Math.max(1, rollDice(attacker.dmg, rng, crit)) : 0;
    defender.hp = Math.max(0, defender.hp - damage);
    return { d20, total, crit, fumble, hit, damage };
  }

  function strikeText(who, attacker, defender, s) {
    const roll = `🎲${s.d20} + ${attacker.atk} = ${s.total}（防御 ${defender.ac}）`;
    if (s.fumble) return `${who}の攻撃 ${roll} → 大失敗…`;
    if (!s.hit) return `${who}の攻撃 ${roll} → 外れ`;
    return `${who}の攻撃 ${roll} → ${s.crit ? '会心の一撃！' : '命中！'} ${s.damage} ダメージ`;
  }

  function finish(run, result, rng) {
    run.phase = 'result';
    run.result = result;
    if (result === 'win') {
      run.gold = rollDice(tableFor(run.kind).treasure, rng);
      addLog(run, `🏆 攻略した！ 宝箱に 💰 ${run.gold} G`);
    } else if (result === 'lose') {
      addLog(run, '💀 力尽きた…');
    } else {
      addLog(run, '🏃 ダンジョンを出た');
    }
  }

  // 冒険者が 1 手動き、敵が生きていれば敵が 1 手返す。起きたことを events で返す
  // action: 'attack' | 'potion'。今は動けない / 使えないときは何もせず [] を返す
  function act(run, action, rng) {
    if (run.phase !== 'fight') return [];
    const { hero, enemy } = run;
    const events = [];

    if (action === 'attack') {
      const s = strike(hero, enemy, rng);
      events.push({ actor: 'hero', type: 'attack', ...s });
      addLog(run, strikeText('⚔️ あなた', hero, enemy, s));
    } else if (action === 'potion') {
      if (hero.potions <= 0 || hero.hp >= hero.maxHp) return [];
      hero.potions -= 1;
      const before = hero.hp;
      hero.hp = Math.min(hero.maxHp, hero.hp + rollDice(POTION_HEAL, rng));
      events.push({ actor: 'hero', type: 'heal', amount: hero.hp - before });
      addLog(run, `🧪 回復薬を飲んだ → HP +${hero.hp - before}（残り ${hero.potions} 個）`);
    } else {
      return [];
    }
    run.turn += 1;

    if (enemy.hp === 0) {
      run.xp += enemy.xp;
      events.push({ actor: 'enemy', type: 'down', xp: enemy.xp });
      addLog(run, `✨ ${enemy.name} を倒した！ 経験値 +${enemy.xp}`);
      if (run.room === run.lineup.length) finish(run, 'win', rng);
      else run.phase = 'room-clear';
      return events;
    }

    const s = strike(enemy, hero, rng);
    events.push({ actor: 'enemy', type: 'attack', ...s });
    addLog(run, strikeText(`${enemy.emoji} ${enemy.name}`, enemy, hero, s));
    if (hero.hp === 0) finish(run, 'lose', rng);
    return events;
  }

  // 途中で出る（戦いの最中なら逃げる）。倒した敵の経験値は持ち帰れる
  function leave(run) {
    if (run.phase !== 'result') finish(run, 'left');
  }

  const api = {
    MONSTERS, LINEUPS, POTIONS_PER_RUN, POTION_HEAL,
    parseDice, rollDice, monsterCount, lineupFor, dangerOf: kind => tableFor(kind).danger,
    levelInfo, heroStats, newHero, normalizeHero, settle,
    startRun, advance, act, leave,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DungeonRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
