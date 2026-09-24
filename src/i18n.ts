import { useSyncExternalStore } from 'react';
import type { ColorKey, Objective } from './game/levels';
import type { AmmoKind } from './game/ammo';

/**
 * 全站文案的唯一出处。
 * 加一门语言 = 给 Lang 加一个字面量 + 在 UI / COLOR_ZH 里补齐对应字段，
 * 其余代码不用动（关卡名与提示在 levels.ts 里，同样是 {zh, en} 结构）。
 */

export type Lang = 'zh' | 'en';

/** 一处文案 = 一份中英对照。levels.ts 的关卡名 / 提示也用这个类型。 */
export interface LocalizedText {
  zh: string;
  en: string;
}

export const resolve = (t: LocalizedText, lang: Lang): string => t[lang];

/* ------------------------------------------------------------------ *
 * 语言状态：默认中文；用户切换后写入 localStorage，刷新仍生效。
 * 用 useSyncExternalStore 订阅 —— 切换语言时所有读它的组件一起重渲染。
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'cbc:lang';

const listeners = new Set<() => void>();

function load(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'zh' || v === 'en') return v;
  } catch {
    /* 无痕模式 / 禁用存储时忽略，回落到默认值 */
  }
  return 'zh';
}

let current: Lang = load();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const getLang = (): Lang => current;

export function setLang(l: Lang) {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
  applyDocumentLang(l);
  listeners.forEach((cb) => cb());
}

/** 同步 <html lang> 与标签页标题，让浏览器与分享卡片也跟着切 */
export function applyDocumentLang(l: Lang) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  document.title = UI[l].docTitle;
}

/** 组件里这样用：`const [lang, setLang] = useLang();` */
export function useLang(): [Lang, (l: Lang) => void] {
  const lang = useSyncExternalStore(subscribe, getLang, getLang);
  return [lang, setLang];
}

/* ------------------------------------------------------------------ *
 * 界面文案
 * ------------------------------------------------------------------ */

interface UiText {
  docTitle: string;
  title: string;
  subtitle: string;
  tips: string[];
  /** 触屏设备的操作说明（与鼠标不同，按设备二选一显示） */
  tipsTouch: string[];
  start: string;
  startTouch: string;
  langLabel: string;
  pauseTitle: string;
  resume: string;
  restart: string;
  levelSelect: string;
  levelLabel: (n: number, total: number) => string;
  score: string;
  target: (n: number) => string;
  ammo: string;
  power: string;
  /* 右下角那颗按钮。原先写「发射」，但鼠标点画布 / 空格 / 触屏松手都能发射，
     它其实是多余的 —— 现在改成**切换弹药**（见 GAME_DESIGN.md 第 4 节 ②）。 */
  switchAmmo: string;
  ammoName: Record<AmmoKind, string>;
  ammoDesc: Record<AmmoKind, string>;
  combo: (n: number) => string;
  yaw: string;
  pitch: string;
  controls: string;
  /** 触屏设备的底部操作提示 */
  controlsTouch: string;
  /** 按住瞄准时浮在屏幕上的提示 */
  aiming: string;
  trajectory: string;
  sound: string;
  wonTitle: string;
  scoreLine: (n: number) => string;
  starRule: (ammo: number, target: number) => string;
  replay: string;
  nextLevel: string;
  backToFirst: string;
  lostTitle: string;
  progressLine: (progress: string, score: number) => string;
  tryAgain: string;
  /* 挑战模式（一发定胜负，见 levels.ts 的 ChallengeRule） */
  challengeBadge: string;
  challengeToggle: string;
  challengeToggleHint: string;
  challengeGoal: string;
  challengeLine: (n: number) => string;
  challengeWinTitle: string;
  challengeFailTitle: string;
  challengeWonLine: string;
  /* 选关：未解锁 / 进度汇总 / 清空 */
  locked: string;
  progressSummary: (cleared: number, total: number, stars: number, challenge: number) => string;
  clearProgress: string;
}

export const UI: Record<Lang, UiText> = {
  zh: {
    docTitle: '彩色砖块炮台 — 3D 物理破坏小游戏',
    title: '🎪 彩色砖块炮台',
    subtitle: '3D 物理破坏小游戏',
    tips: [
      '🖱️ 移动鼠标瞄准炮台。',
      '🎚️ 用滑杆、滚轮或 Q / E 调节发射力度。',
      '💥 点击鼠标左键（或空格）发射。',
      '🧱 借助物理和连锁反应把建筑砸塌。',
      '🧊 半透明的玻璃砖一撞就碎，碎掉以后不再承重，上面会整片塌下来。',
      '🔵 右下角的按钮可以切换弹药：标准弹 / 铁锤弹 / 爆破筒 / 三连发 —— 不同结构吃不同的球。',
      '⌨️ A/D 左右转 · W/S 调仰角 · R 重开 · Esc 暂停',
    ],
    tipsTouch: [
      '👆 手指按住屏幕开始瞄准：左右拖动转视角，上下拖动调仰角。',
      '✋ 手指一松开就发射——瞄准满意了再松手。',
      '🎚️ 先用底部滑杆调好力度，拖动时看轨迹线预判落点。',
      '🧱 借助物理和连锁反应把建筑砸塌。',
      '🧊 半透明的玻璃砖一撞就碎，碎掉以后不再承重，上面会整片塌下来。',
      '🔵 右下角的按钮可以切换弹药：标准弹 / 铁锤弹 / 爆破筒 / 三连发。',
      '⏸ 右上角可以暂停或重开本关。',
    ],
    start: '开始游戏',
    startTouch: '开始游戏 · 按住瞄准，松手发射',
    langLabel: '语言',
    pauseTitle: '⏸ 已暂停',
    resume: '继续游戏',
    restart: '重开本关',
    levelSelect: '选关',
    levelLabel: (n, total) => `第 ${n} 关 / ${total}`,
    score: '得分',
    target: (n) => `目标 ${n}`,
    ammo: '炮弹',
    power: '力度',
    switchAmmo: '切换弹药',
    ammoName: { standard: '标准弹', hammer: '铁锤弹', bomb: '爆破筒', triple: '三连发' },
    ammoDesc: {
      standard: '通用。质量与初速都是其余三种的基准值。',
      hammer: '质量翻倍、撞得动厚墙与平台边缘；代价是初速低——射程只有标准弹的约 77%，得把力度调高。',
      bomb: '碰到东西立刻引爆，范围 3.4 米。拆玻璃和密集砖最狠，但也会连带掀掉自己脚下的结构。',
      triple: '一次三颗、左右各偏 7°。单颗动能只有标准弹的一半，打不动厚墙；胜在能同时够到三个分开的承重单元。',
    },
    combo: (n) => `连击 x${n}！`,
    yaw: '水平角',
    pitch: '仰角',
    controls: '鼠标：瞄准 · 左键/空格：发射 · WASD：瞄准 · Q/E：调力 · R：重开 · Esc：暂停',
    controlsTouch: '按住屏幕拖动：瞄准 · 松手：发射',
    aiming: '瞄准中 · 松手发射',
    trajectory: '轨迹线',
    sound: '音效',
    wonTitle: '过关！🎉',
    scoreLine: (n) => `得分：${n}`,
    starRule: (ammo, target) => `⭐ 完成目标 · ⭐⭐ 剩余炮弹 ≥ ${ammo} · ⭐⭐⭐ 再加分到 ${target}`,
    replay: '重玩本关',
    nextLevel: '下一关 ▶',
    backToFirst: '回到第 1 关',
    lostTitle: '炮弹用完了！😅',
    progressLine: (progress, score) => `进度：${progress} · 得分：${score}`,
    tryAgain: '再试一次',
    challengeBadge: '⚡ 挑战',
    challengeToggle: '⚡ 挑战模式',
    challengeToggleHint: '每关只有 1 发炮弹，一发定胜负，失败即重来。',
    challengeGoal: '挑战目标',
    challengeLine: (n) => `积分线 ${n}`,
    challengeWinTitle: '挑战成功！🏆',
    challengeFailTitle: '挑战失败',
    challengeWonLine: '一发定胜负 —— 这一关你过了。',
    locked: '未解锁',
    progressSummary: (cleared, total, stars, challenge) =>
      `已通关 ${cleared}/${total} · 星级 ${stars} · 挑战 ${challenge}/${total}`,
    clearProgress: '清空进度',
  },
  en: {
    docTitle: 'Color Brick Cannon — 3D Physics Puzzle',
    title: '🎪 Color Brick Cannon',
    subtitle: 'A colorful 3D physics destruction puzzle',
    tips: [
      '🖱️ Move the mouse to aim the cannon.',
      '🎚️ Adjust firing power with the slider, mouse wheel or Q / E.',
      '💥 Click the left mouse button (or Space) to fire.',
      '🧱 Use physics and chain reactions to knock down the structure.',
      '🧊 Translucent glass bricks shatter on impact and stop supporting anything — whatever is above comes down.',
      '🔵 The bottom-right button cycles ammo: Standard / Hammer / Bomb / Triple — different structures want different shots.',
      '⌨️ A/D rotate · W/S elevate · R restart · Esc pause',
    ],
    tipsTouch: [
      '👆 Press and hold anywhere to aim: drag sideways to turn, up or down to elevate.',
      '✋ Let go to fire — so release only once the aim looks right.',
      '🎚️ Set the power with the bottom slider; the trajectory line previews the shot.',
      '🧱 Use physics and chain reactions to knock down the structure.',
      '🧊 Translucent glass bricks shatter on impact and stop supporting anything — whatever is above comes down.',
      '🔵 The bottom-right button cycles ammo: Standard / Hammer / Bomb / Triple.',
      '⏸ Pause or restart from the top-right buttons.',
    ],
    start: 'START PLAYING',
    startTouch: 'START · hold to aim, release to fire',
    langLabel: 'Language',
    pauseTitle: '⏸ Paused',
    resume: 'Resume',
    restart: 'Restart',
    levelSelect: 'Level Select',
    levelLabel: (n, total) => `LEVEL ${n} / ${total}`,
    score: 'SCORE',
    target: (n) => `target ${n}`,
    ammo: 'CANNONBALLS',
    power: 'POWER',
    switchAmmo: 'Switch ammo',
    ammoName: { standard: 'Standard', hammer: 'Hammer', bomb: 'Bomb', triple: 'Triple' },
    ammoDesc: {
      standard: 'The baseline — every other ball is measured against its mass and speed.',
      hammer: 'Double the mass: it breaks thick walls and platform edges. The cost is speed — only ~77% of the standard range, so raise the power.',
      bomb: 'Detonates the instant it touches anything, within 3.4m. The best glass-breaker there is, and the fastest way to take your own footing down with it.',
      triple: 'Three balls, ±7° apart. Each carries about half the standard energy, so thick walls shrug it off — but it reaches three separate load-bearing units at once.',
    },
    combo: (n) => `COMBO x${n}!`,
    yaw: 'Yaw',
    pitch: 'Elevation',
    controls: 'Mouse: aim · Click/Space: fire · WASD aim · Q/E power · R restart · Esc pause',
    controlsTouch: 'Hold & drag: aim · Release: fire',
    aiming: 'AIMING · release to fire',
    trajectory: 'Trajectory',
    sound: 'Sound',
    wonTitle: 'LEVEL CLEAR! 🎉',
    scoreLine: (n) => `Score: ${n}`,
    starRule: (ammo, target) => `⭐ objective · ⭐⭐ with ${ammo}+ balls left · ⭐⭐⭐ also reach ${target} pts`,
    replay: 'Replay',
    nextLevel: 'Next Level ▶',
    backToFirst: 'Back to Level 1',
    lostTitle: 'Out of cannonballs! 😅',
    progressLine: (progress, score) => `Progress: ${progress} · Score ${score}`,
    tryAgain: 'Try Again',
    challengeBadge: '⚡ CHALLENGE',
    challengeToggle: '⚡ Challenge Mode',
    challengeToggleHint: 'One shot per level. Miss the goal and you start over.',
    challengeGoal: 'Challenge goal',
    challengeLine: (n) => `score line ${n}`,
    challengeWinTitle: 'CHALLENGE CLEARED! 🏆',
    challengeFailTitle: 'Challenge failed',
    challengeWonLine: 'One shot, one level — you made it.',
    locked: 'Locked',
    progressSummary: (cleared, total, stars, challenge) =>
      `Cleared ${cleared}/${total} · ${stars} stars · Challenge ${challenge}/${total}`,
    clearProgress: 'Reset progress',
  },
};

/* ------------------------------------------------------------------ *
 * 关卡目标文案
 * 由 objective 的 kind / count / color 现场拼出来，而不是写死在关卡数据里
 * —— 这样改了关卡数值，文案不会跟着对不上。
 * ------------------------------------------------------------------ */

const COLOR_ZH: Record<ColorKey, string> = {
  red: '红',
  yellow: '黄',
  blue: '蓝',
  green: '绿',
  purple: '紫',
  orange: '橙',
  gray: '灰',
};

export function objectiveText(o: Objective, lang: Lang): string {
  const n = o.count ?? 0;
  const zh = lang === 'zh';
  switch (o.kind) {
    case 'knockCount':
      return zh ? `击倒 ${n} 块砖` : `Knock down ${n} bricks`;
    case 'color':
      return zh
        ? `击倒 ${n} 块${COLOR_ZH[o.color ?? 'red']}色砖`
        : `Knock down ${n} ${(o.color ?? 'red').toUpperCase()} bricks`;
    case 'targets':
      return zh ? '击倒顶部的紫色目标' : 'Knock down the purple target on top';
    case 'knockAll':
      return zh ? '击倒场上所有砖块' : 'Knock down every brick';
    case 'score':
      return zh ? '得分达到目标' : 'Reach the target score';
  }
}

// 首次加载即把 <html lang> 与标题设成当前语言
applyDocumentLang(current);
