// quest.js — クエスト（依頼）のルール：クエスト主の見た目・依頼の言葉と報酬・受注から報告までの進み方
//
// 画面(DOM)には触らない。map.html と demo-game.html が読み込み、window.QuestRules として使う。
// Node からも require できる（ルールだけを試したいとき用）。
//
// 流れ: まだ受けていない(new) → 受けた(accepted) → 目的地を攻略した(cleared) → 報告して報酬をもらった(done)
// 進み具合は遊ぶ人の端末にだけ保存する（{ クエストの id: 'accepted' | 'cleared' | 'done' }）。
//
// 依頼を増やすとき: REQUESTS に目的地の種類（dungeon.js の LINEUPS と同じ id）ごとの 1 行を足す。
'use strict';

(function (root) {
  // ---- クエスト主の見た目 ----
  // sprites/npc/<id>.png は 1 コマ 48×72 を横に 6 コマ並べた歩きの絵。足元がコマの下端に来る。
  // 絵はダンジョンファイターズ（同じ作者の自作ゲーム）の素材から切り出して流用している。
  const SPRITE = { frameW: 48, frameH: 72, frames: 6 };
  const LOOKS = [
    { id: 'oldman', name: '村の長老' },
    { id: 'oldwoman', name: '村のおばあさん' },
    { id: 'man', name: '村の男' },
    { id: 'woman', name: '村の女' },
    { id: 'boy', name: '村の少年' },
    { id: 'girl', name: '村の少女' },
    { id: 'keeper', name: '酒場の主人' },
    { id: 'priest', name: '神官' },
    { id: 'bishop', name: '司教' },
    { id: 'wizard', name: '老魔法使い' },
    { id: 'warrior', name: '女戦士' },
  ];
  const DEFAULT_LOOK = 'oldman';
  const lookOf = id => LOOKS.find(l => l.id === id) || LOOKS.find(l => l.id === DEFAULT_LOOK);
  const spriteUrl = id => `sprites/npc/${lookOf(id).id}.png`;

  const TALK_RADIUS_M = 30;      // クエスト主にこれだけ近づくと話しかけられる
  const TARGET_RADIUS_M = 40;    // 目的地のダンジョンに入れる半径（ふつうのダンジョンの既定と同じ）

  // ---- 依頼（目的地のダンジョンの種類ごと） ----
  // title = 依頼の名前 / ask = 頼むときの言葉 / thanks = 攻略して戻ったときの言葉 / gold・xp = 報告でもらえる報酬
  const REQUESTS = {
    goblin: { title: 'ゴブリン退治', gold: 50, xp: 100,
      ask: '近くの巣穴にゴブリンが住みついて、夜な夜な畑を荒らしていくんです。\nどうか退治してもらえませんか。',
      thanks: 'ゴブリンがいなくなって、畑も静かになりました。\n本当にありがとう！' },
    bandit: { title: '盗賊の討伐', gold: 60, xp: 100,
      ask: '街道で荷馬車が盗賊に襲われました。\nアジトの場所は分かっています。頭を懲らしめてください。',
      thanks: '盗賊の頭を倒してくれたんですね！\nこれで安心して街道を通れます。' },
    shrine: { title: '祠の鎮め', gold: 100, xp: 200,
      ask: '山の祠のあたりで、夜になると青い火が飛ぶんです。\n祠のぬしが怒っているのかもしれません…。',
      thanks: '青い火が出なくなりました。\nぬしも静まったようです。ありがとう！' },
    tomb: { title: '墓所の浄化', gold: 200, xp: 400,
      ask: '古い墓所から、骨の鳴る音が聞こえるんです。\n眠れない死者たちを鎮めてあげてください。',
      thanks: '墓所が静かになりました。\n死者たちも、やっと眠れたでしょう。' },
    orc: { title: 'オークの野営地', gold: 300, xp: 600,
      ask: 'オークの一団が野営地を築きました。\n村に攻めてくる前に、戦士長を討ってください。危険な仕事です。',
      thanks: 'オークの戦士長を討ち取るとは…！\n村を救ってくれて、ありがとう。' },
    dragon: { title: '竜の討伐', gold: 1500, xp: 3000,
      ask: '北の洞窟に竜が棲みつきました。\n命の保証はできません。それでも行ってくれますか？',
      thanks: 'まさか、本当に竜を倒すなんて…！\nあなたは村の英雄です。' },
  };
  const DEFAULT_KIND = 'goblin';   // 知らない種類が来たら、これの依頼として扱う
  const requestFor = kind => REQUESTS[kind] || REQUESTS[DEFAULT_KIND];

  // クエスト主の呼び名に、依頼のグレード（目的地のダンジョンの危険度 1〜5）を添える。例: 村の長老（LV1）
  // danger が分からない（目的地が無い）ときは名前だけ
  const giverLabel = (quest, danger) => (Number.isInteger(danger) ? `${quest.name}（LV${danger}）` : quest.name);

  // ---- 進み具合 ----
  const STATES = ['accepted', 'cleared', 'done'];

  // 保存から読んだ値は壊れているかもしれないので、形の合う部分だけ使う
  function normalizeProgress(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, st] of Object.entries(raw)) {
      if (STATES.includes(st)) out[id] = st;
    }
    return out;
  }

  const stateOf = (progress, questId) => progress[questId] || 'new';

  // ふつうのダンジョンはいつも見える。依頼の目的地は、受けてから報告するまでだけ見える
  function isDungeonVisible(dungeon, progress) {
    if (!dungeon.questId) return true;
    const st = stateOf(progress, dungeon.questId);
    return st === 'accepted' || st === 'cleared';
  }

  // 以下はどれも「新しい進み具合」を返す（元の進み具合は書き換えない）
  function accept(progress, questId) {
    if (stateOf(progress, questId) !== 'new') return progress;
    return { ...progress, [questId]: 'accepted' };
  }

  // 攻略したダンジョンが、受けている依頼の目的地なら「攻略した」へ進める
  function markCleared(progress, quests, dungeonId) {
    const next = { ...progress };
    const cleared = [];
    for (const q of quests) {
      if (q.dungeonId !== dungeonId || stateOf(progress, q.id) !== 'accepted') continue;
      next[q.id] = 'cleared';
      cleared.push(q.id);
    }
    return { progress: next, cleared };
  }

  // 攻略した後にクエスト主へ報告すると、1 回だけ報酬が出る。kind = 目的地のダンジョンの種類
  function report(progress, questId, kind) {
    if (stateOf(progress, questId) !== 'cleared') return { progress, reward: null };
    const { gold, xp } = requestFor(kind);
    return { progress: { ...progress, [questId]: 'done' }, reward: { gold, xp } };
  }

  const api = {
    SPRITE, LOOKS, DEFAULT_LOOK, TALK_RADIUS_M, TARGET_RADIUS_M, REQUESTS,
    lookOf, spriteUrl, requestFor, giverLabel,
    normalizeProgress, stateOf, isDungeonVisible, accept, markCleared, report,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuestRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
