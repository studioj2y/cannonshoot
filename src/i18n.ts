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
    docTitle: '一炮定江山 —— 看看你能到第几关',
    title: '一炮定江山',
    subtitle: '看看你能到第几关',
    tips: [
      '🖱️ 移动鼠标瞄准，左键（或空格）发射。',
      '🎚️ 滚轮或 Q / E 调力度。',
      '🔵 右下角切换弹药 —— 不同结构吃不同的球。',
      '⌨️ A/D 转向 · W/S 仰角 · R 重开 · Esc 暂停',
    ],
    tipsTouch: [
      '👆 按住拖动瞄准，松手发射。',
      '🎚️ 底部滑杆调力度，轨迹线预判落点。',
      '🔵 右下角切换弹药。',
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
      standard: '通用基准弹。',
      hammer: '质量翻倍、破厚墙；初速低，射程约标准弹的 77%。',
      bomb: '碰到东西立刻引爆，范围 3.4 米；拆玻璃最狠。',
      triple: '一次三颗、各偏 7°；单颗力道减半，够得着三个散开的承重单元。',
    },
    combo: (n) => `连击 x${n}！`,
    yaw: '水平角',
    pitch: '仰角',
    controls: '左键发射 · WASD 瞄准 · Q/E 调力 · R 重开 · Esc 暂停',
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
    challengeToggleHint: '每关只有 1 发炮弹，失败即重来。',
    challengeGoal: '挑战目标',
    challengeLine: (n) => `积分线 ${n}`,
    challengeWinTitle: '挑战成功！🏆',
    challengeFailTitle: '挑战失败',
    challengeWonLine: '一发定胜负 —— 你过了。',
    locked: '未解锁',
    progressSummary: (cleared, total, stars, challenge) =>
      `已通关 ${cleared}/${total} · 星级 ${stars} · 挑战 ${challenge}/${total}`,
    clearProgress: '清空进度',
  },
  en: {
    docTitle: 'One Shot, One Kingdom — How Far Can You Get',
    title: 'One Shot, One Kingdom',
    subtitle: 'See how far you can get',
    tips: [
      '🖱️ Move the mouse to aim, click (or press Space) to fire.',
      '🎚️ Scroll wheel or Q / E adjusts power.',
      '🔵 Switch ammo at the bottom-right — different structures want different shots.',
      '⌨️ A/D rotate · W/S elevate · R restart · Esc pause',
    ],
    tipsTouch: [
      '👆 Hold and drag to aim, release to fire.',
      '🎚️ Set power with the slider; the line previews the shot.',
      '🔵 Switch ammo at the bottom-right.',
      '⏸ Pause or restart from the top-right.',
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
      standard: 'The baseline ball.',
      hammer: 'Double mass, breaks thick walls; slower, ~77% of the standard range.',
      bomb: 'Detonates on contact, within 3.4m — the best glass-breaker there is.',
      triple: 'Three balls, ±7° apart; half the punch each, but reaches three separate supports.',
    },
    combo: (n) => `COMBO x${n}!`,
    yaw: 'Yaw',
    pitch: 'Elevation',
    controls: 'Click/Space: fire · WASD: aim · Q/E: power · R restart · Esc pause',
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
    challengeToggleHint: 'One shot per level. Miss, and you start over.',
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
