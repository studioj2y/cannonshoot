import { useSyncExternalStore } from 'react';
import type { ColorKey, Objective } from './game/levels';

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
  start: string;
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
  fire: string;
  combo: (n: number) => string;
  yaw: string;
  pitch: string;
  controls: string;
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
      '⌨️ A/D 左右转 · W/S 调仰角 · R 重开 · Esc 暂停',
    ],
    start: '开始游戏',
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
    fire: '发射！💥',
    combo: (n) => `连击 x${n}！`,
    yaw: '水平角',
    pitch: '仰角',
    controls: '鼠标：瞄准 · 左键/空格：发射 · WASD：瞄准 · Q/E：调力 · R：重开 · Esc：暂停',
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
      '⌨️ A/D rotate · W/S elevate · R restart · Esc pause',
    ],
    start: 'START PLAYING',
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
    fire: 'FIRE! 💥',
    combo: (n) => `COMBO x${n}!`,
    yaw: 'Yaw',
    pitch: 'Elevation',
    controls: 'Mouse: aim · Click/Space: fire · WASD aim · Q/E power · R restart · Esc pause',
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
