import { useSyncExternalStore } from 'react';
import { LEVELS } from './game/levels';

/* ============================================================================
   进度（localStorage）—— 关卡解锁门槛、最好星级、挑战模式通过记录。

   ⚠️ 与语言的存储键（i18n.ts 的 `cbc:lang`）**刻意分开**：
      清了进度不该把界面语言也重置掉，这是两件互不相关的事。
   ⚠️ 键名带版本号（:v1）：以后改了数据结构就升到 v2，旧档读不出来会被
      normalize() 补成默认值，不会让玩家碰到 undefined 崩溃。
   ========================================================================== */

const STORAGE_KEY = 'cbc:progress:v1';

export interface Progress {
  /** 普通模式：逐关是否通关。**关卡解锁门槛读它**（完成前一关才解锁下一关） */
  cleared: boolean[];
  /** 逐关的最好星级（普通模式）。刷新页面不再清零 */
  stars: number[];
  /** 挑战模式：逐关是否已通过（与普通星级完全独立，互不写入） */
  challenge: boolean[];
}

const empty = (): Progress => ({
  cleared: LEVELS.map(() => false),
  stars: LEVELS.map(() => 0),
  challenge: LEVELS.map(() => false),
});

/** 把任意来源的数据补成合法形状（长度对齐关卡数、类型兜底） */
function normalize(raw: unknown): Progress {
  const base = empty();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Partial<Progress>;
  const bools = (v: unknown) => (Array.isArray(v) ? LEVELS.map((_, i) => v[i] === true) : base.cleared);
  const nums = (v: unknown) =>
    Array.isArray(v) ? LEVELS.map((_, i) => (typeof v[i] === 'number' ? Math.max(0, Math.min(3, v[i] as number)) : 0)) : base.stars;
  return { cleared: bools(o.cleared), stars: nums(o.stars), challenge: bools(o.challenge) };
}

function load(): Progress {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? normalize(JSON.parse(v)) : empty();
  } catch {
    /* 无痕模式 / 存储被禁用 / 旧档损坏 —— 一律回落到空进度，不要抛 */
    return empty();
  }
}

/* 快照对象每帧都会被 React 拿去比引用，所以只在真正改动时整体替换它 —— 
   不能就地 mutate（那样引用不变，订阅者收不到通知）。 */
let current: Progress = load();

const listeners = new Set<() => void>();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const get = (): Progress => current;

function commit(next: Progress) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 写不进去也要让本次会话的 UI 正确，所以先更新内存再尝试落盘 */
  }
  listeners.forEach((cb) => cb());
}

/** 组件里这样用：`const p = useProgress();` */
export function useProgress(): Progress {
  return useSyncExternalStore(subscribe, get, get);
}

export function markCleared(levelIndex: number) {
  if (current.cleared[levelIndex]) return;
  const cleared = current.cleared.slice();
  cleared[levelIndex] = true;
  commit({ ...current, cleared });
}

export function recordStars(levelIndex: number, stars: number) {
  if (stars <= (current.stars[levelIndex] ?? 0)) return;
  const next = current.stars.slice();
  next[levelIndex] = stars;
  commit({ ...current, stars: next });
}

export function markChallengePassed(levelIndex: number) {
  if (current.challenge[levelIndex]) return;
  const challenge = current.challenge.slice();
  challenge[levelIndex] = true;
  commit({ ...current, challenge });
}

/** 选关面板用：第一关永远可进，之后要求「前一关已通关」 */
export const isUnlocked = (p: Progress, levelIndex: number) =>
  levelIndex === 0 || p.cleared[levelIndex - 1] === true;

/** 当前可进到的最高关序号（用于「继续游戏」之类的入口） */
export const furthestUnlocked = (p: Progress) => {
  let i = 0;
  while (i < LEVELS.length - 1 && p.cleared[i]) i++;
  return i;
};

/** 设置面板里的「清空进度」用（README 里对应的待办是星级持久化，见 GAME_DESIGN.md） */
export function resetProgress() {
  commit(empty());
}
