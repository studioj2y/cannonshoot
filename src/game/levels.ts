import type { LocalizedText } from '../i18n';

export type BrickShape = 'box' | 'cylinder' | 'wedge';

export interface BrickDef {
  shape: BrickShape;
  pos: [number, number, number];
  size: [number, number, number]; // box: half? no -> full dims; cylinder: [radius, height, radius]
  color: ColorKey;
  static?: boolean;
  mass?: number;
  target?: boolean;
  score?: number;
  rotY?: number;
}

export type ColorKey = 'red' | 'yellow' | 'blue' | 'green' | 'purple' | 'orange' | 'gray';

export const COLORS: Record<ColorKey, number> = {
  red: 0xff5a5f,
  yellow: 0xffd23f,
  blue: 0x4cb5f5,
  green: 0x5bd68a,
  purple: 0xb07cf0,
  orange: 0xff9f43,
  gray: 0xb8c2cc,
};

export interface Objective {
  kind: 'knockCount' | 'knockAll' | 'color' | 'targets' | 'score';
  count?: number;
  color?: ColorKey;
}

export interface LevelDef {
  name: LocalizedText;
  hint: LocalizedText;
  ammo: number;
  targetScore: number;
  twoStarAmmoLeft: number; // ammo remaining required for 2 stars
  objective: Objective;
  ground: 'grass' | 'sand';
  bricks: BrickDef[];
}

const rainbow: ColorKey[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/* ============================================================================
   ⚠️ 摆砖的硬约束 —— 2026-09-23 踩过，照着做免得再翻车

   每块砖的「底面」必须正好落在某个支撑面上：
     地面 y=0 / 静态平台的顶面 / 下方砖块的顶面 / 构件工厂的顶面。
   · 底面悬空 → 求解器让它自由落体，落地冲击把周围结构一起掀翻
   · 底面埋进支撑体 → 求解器要把它顶出来，同样掀翻整座结构
   两种情况都会在开局白送击倒数。L5 曾因此开局 0.5 秒自动胜利（31/55 块被判击倒）。

   高度速查（这些数都是从工厂公式推出来的，加构件前先算一遍）：
     static 平台顶面 = pos.y + size.y / 2
     tower(y0)       支柱底 = y0，每层净高 1.5，顶面 = y0 + layers × 1.5
     arch(y0)        柱底   = y0，顶梁顶面 = y0 + cols × 0.9 + 0.4（cols = round(h / 0.9)）
     wall(y0)        底砖底 = y0，每层净高 bh（垂直方向不留缝）
   ========================================================================== */

/** 砖墙。x0 = 墙的【左边缘】（不是首块砖的中心）。 */
function wall(x0: number, y0: number, z: number, cols: number, rows: number, bw = 1.6, bh = 0.8, bd = 0.9): BrickDef[] {
  const out: BrickDef[] = [];
  const full = bw * 0.97;  // 整砖实际宽度（留 3% 缝，避免相邻砖侧面互相穿插）
  const half = bw / 2;     // 半砖的标准宽度
  for (let r = 0; r < rows; r++) {
    const y = y0 + bh / 2 + r * bh;
    let i = 0;
    const push = (cx: number, w: number, mass: number) =>
      out.push({
        shape: 'box',
        pos: [cx, y, z],
        // 高度取满 bh（原先写 bh * 0.95）：层间留缝会让整面墙微沉，横向扰动足以把
        // 最外侧那块砖晃到 39°（判定阈值 38°），开局白送 1 块进度。
        size: [w, bh, bd],
        color: rainbow[(r + i++) % rainbow.length],
        mass,
      });

    if (r % 2 === 0) {
      for (let c = 0; c < cols; c++) push(x0 + (c + 0.5) * bw, full, 1.4);
    } else {
      // 奇数层 = 两端半砖 + 中间 cols-1 块整砖 ⇒ 外轮廓与偶数层逐毫米对齐。
      // ⚠️ 不能只把整砖整体平移半块（原先的写法）：那样每层两端各凸出半块砖，
      // 而这半块的【正下方是空的】——重心落在支撑区外，关卡开局静置 0.6 秒就会
      // 自己倾覆，白送一块击倒进度，且与玩家开没开炮无关。用半砖收边后，
      // 上下两层的边界完全重合，凸出问题从根上消失。
      push(x0 + half / 2, half * 0.97, 0.7);
      for (let c = 0; c < cols - 1; c++) push(x0 + half + (c + 0.5) * bw, full, 1.4);
      push(x0 + cols * bw - half / 2, half * 0.97, 0.7);
    }
  }
  return out;
}

/** 叠塔。y0 = 起建高度（放在平台上时必须传平台顶面高度，否则柱底会埋进平台）。 */
function tower(x: number, z: number, layers: number, base = 2.2, y0 = 0, withTarget = true): BrickDef[] {
  const out: BrickDef[] = [];
  let y = y0;
  for (let i = 0; i < layers; i++) {
    const w = base * (1 - i * 0.06);
    // two pillars + plate
    out.push({ shape: 'box', pos: [x - w / 2, y + 0.6, z], size: [0.6, 1.2, 0.8], color: rainbow[i % 6], mass: 1.2 });
    out.push({ shape: 'box', pos: [x + w / 2, y + 0.6, z], size: [0.6, 1.2, 0.8], color: rainbow[i % 6], mass: 1.2 });
    out.push({ shape: 'box', pos: [x, y + 1.35, z], size: [w + 1.0, 0.3, 1.2], color: rainbow[(i + 3) % 6], mass: 1.0 });
    y += 1.5;
  }
  // withTarget=false 用于「塔顶要盖别的东西」的关卡（顶面得空出来）
  if (withTarget) {
    out.push({ shape: 'cylinder', pos: [x, y + 0.5, z], size: [0.6, 1.0, 0.6], color: 'purple', mass: 1.0, target: true, score: 300 });
  }
  return out;
}

/** 拱门。y0 = 起建高度；cols 由 h 推出，顶梁顶面 = y0 + cols * 0.9 + 0.4。 */
function arch(x: number, z: number, h: number, span: number, color: ColorKey, y0 = 0): BrickDef[] {
  const out: BrickDef[] = [];
  const cols = Math.round(h / 0.9);
  for (let i = 0; i < cols; i++) {
    out.push({ shape: 'box', pos: [x - span / 2, y0 + 0.45 + i * 0.9, z], size: [0.9, 0.9, 0.9], color, mass: 1.3 });
    out.push({ shape: 'box', pos: [x + span / 2, y0 + 0.45 + i * 0.9, z], size: [0.9, 0.9, 0.9], color, mass: 1.3 });
  }
  const top = y0 + cols * 0.9;
  out.push({ shape: 'box', pos: [x, top + 0.2, z], size: [span + 1.1, 0.4, 1.0], color: 'yellow', mass: 1.6 });
  return out;
}

export const LEVELS: LevelDef[] = [
  {
    name: { zh: '基础砖墙', en: 'Basic Wall' },
    hint: { zh: '瞄准墙的正中间开炮！', en: 'Aim at the middle of the wall and fire!' },
    ammo: 5,
    targetScore: 900,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'knockCount', count: 8 },
    bricks: [
      // 开场石台：顶面 y = 0.6。砖墙砌在台上，砖掉下来有 0.6m 落差，
      // 「被打落了」一眼能看出来（原先直接砌在草地上，砖块落不落不直观）。
      { shape: 'box', pos: [0, 0.3, -26], size: [12, 0.6, 2.4], color: 'gray', static: true },
      ...wall(-4.8, 0.6, -26, 6, 4),
    ],
  },
  {
    name: { zh: '砖塔', en: 'Brick Tower' },
    hint: { zh: '打底部的支柱，把整座塔掀翻。', en: 'Hit the lower supports to topple the tower.' },
    ammo: 5,
    targetScore: 1600,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'targets' },
    bricks: [
      // 平台顶面 = 0.25 + 0.25 = 0.5，塔从 0.5 起建（原先从 0 起建，柱底埋进平台 0.5m）
      { shape: 'box', pos: [0, 0.25, -27], size: [7, 0.5, 5], color: 'gray', static: true },
      ...tower(0, -27, 6, 2.2, 0.5),
    ],
  },
  {
    name: { zh: '不稳的拱门', en: 'Unbalanced Arch' },
    hint: { zh: '拆掉一条腿，整座拱门就会塌。', en: 'Remove a leg and the whole arch collapses.' },
    ammo: 4,
    targetScore: 2000,
    twoStarAmmoLeft: 2,
    ground: 'sand',
    objective: { kind: 'knockCount', count: 14 },
    bricks: [
      // 两个拱门必须「等高 + 同 z」，横板才能同时压在两条顶梁上。
      // 原先是 3.6 / 4.5 两种高度、z 还差 2m，横板一头悬空 0.15m、一头插进顶梁 0.75m。
      ...arch(-4, -27, 3.6, 3.2, 'blue'),
      ...arch(4.5, -27, 3.6, 3.6, 'green'),
      // 顶梁顶面 = 4.0，所以横板底 = 4.0
      { shape: 'box', pos: [0.2, 4.25, -27], size: [9.5, 0.5, 1.2], color: 'orange', mass: 2.0 },
      // 横板顶面 = 4.5，所以板上砖底 = 4.5
      { shape: 'box', pos: [-1.5, 4.9, -27], size: [1.2, 0.8, 1.2], color: 'red', mass: 1.0 },
      { shape: 'box', pos: [1.5, 4.9, -27], size: [1.2, 0.8, 1.2], color: 'yellow', mass: 1.0 },
      { shape: 'cylinder', pos: [0, 5.05, -27], size: [0.55, 1.1, 0.55], color: 'purple', mass: 1.0, target: true, score: 300 },
    ],
  },
  {
    name: { zh: '平台与吊桥', en: 'Platforms & Bridges' },
    hint: { zh: '把炮弹抛过挡板，落到高台上。', en: 'Loft shots over the barrier onto the high platform.' },
    ammo: 5,
    targetScore: 2600,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'color', color: 'red', count: 4 },
    bricks: [
      // 左高台（顶面 4.0）：承载砖墙 + 桥面左端
      { shape: 'box', pos: [-7.0, 2.0, -24], size: [7.4, 4.0, 6], color: 'gray', static: true },
      // 右高台（顶面 6.0）：承载 4 块红砖（本关目标）
      { shape: 'box', pos: [7.0, 3.0, -30], size: [6.0, 6.0, 6], color: 'gray', static: true },
      // 地面挡板：逼玩家把炮弹抛起来
      { shape: 'box', pos: [0, 1.6, -22], size: [4.0, 3.2, 0.8], color: 'gray', static: true },
      // 桥面右端的支撑柱（顶面 4.0，与左台同高）
      { shape: 'box', pos: [4.0, 2.0, -24], size: [1.4, 4.0, 1.8], color: 'gray', static: true },
      // 砖墙砌在左台上（右边界 -5.12，不会碰到桥面 -4.5）
      ...wall(-9.9, 4.0, -24, 3, 3),
      // 桥面：底 4.0，左端搭左台、右端搭支撑柱
      { shape: 'box', pos: [0.5, 4.2, -24], size: [10.0, 0.4, 1.6], color: 'yellow', mass: 1.8 },
      // 桥面上的目标圆柱，底 = 4.4（桥面顶面）
      { shape: 'cylinder', pos: [0.5, 4.9, -24], size: [0.55, 1.0, 0.55], color: 'purple', mass: 1.0, target: true, score: 300 },
      // 右台上的 4 块红砖（底 = 6.0 = 右台顶面，第 3 块坐在前两块上：6.8 = 6.4 + 0.4）
      { shape: 'box', pos: [5.5, 6.4, -30], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [7.0, 6.4, -30], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [6.25, 7.2, -30], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [8.5, 6.4, -30], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
    ],
  },
  {
    name: { zh: '复合堡垒', en: 'Complex Fortress' },
    hint: { zh: '想好了再打——关键是制造连锁反应。', en: 'Plan carefully — chain reactions are the key.' },
    ammo: 6,
    targetScore: 4200,
    twoStarAmmoLeft: 2,
    ground: 'sand',
    objective: { kind: 'knockCount', count: 30 },
    bricks: [
      // 平台顶面 = 0.6，塔 / 拱门一律从 0.6 起建。
      // 原先它们从 0 起建，柱底埋进平台 0.6m，求解器把它们顶出来 →
      // 开局 0.5 秒内 31/55 块被判击倒，直接触发胜利。
      { shape: 'box', pos: [0, 0.3, -30], size: [22, 0.6, 10], color: 'gray', static: true },
      // 两个塔不生成顶部圆柱：顶面要留给大横板（withTarget = false）
      ...tower(-7, -30, 5, 2.0, 0.6, false),
      ...tower(7, -30, 5, 2.0, 0.6, false),
      // 拱门搬到 z = -30（原先在 -27，与中间的墙错开 3m，墙没东西托）并落在平台上。
      // 顶梁顶面 = 0.6 + 3 × 0.9 + 0.4 = 3.7，正好托住中间的墙。
      ...arch(0, -30, 2.7, 4.0, 'blue', 0.6),
      // 墙：底 3.7 = 拱门顶梁顶面
      ...wall(-2.1, 3.7, -30, 3, 3, 1.4),
      // 大横板：底 8.1 = 塔顶面（0.6 + 5 × 1.5），两端各搭在一条塔顶
      { shape: 'box', pos: [0, 8.3, -30], size: [15, 0.4, 1.6], color: 'orange', mass: 2.2 },
      // 板上砖底 = 8.5（大横板顶面）
      { shape: 'box', pos: [-2, 9.0, -30], size: [1.2, 1.0, 1.2], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [2, 9.0, -30], size: [1.2, 1.0, 1.2], color: 'green', mass: 1.2 },
      { shape: 'cylinder', pos: [0, 9.1, -30], size: [0.6, 1.2, 0.6], color: 'purple', mass: 1.1, target: true, score: 400 },
    ],
  },
];
