import type { LocalizedText } from '../i18n';

export type BrickShape = 'box' | 'cylinder' | 'wedge';

/* ---------------------------------------------------------------------------
   砖种（BrickKind）—— 决定「这块砖被打中之后会怎样」，与 BrickShape（长什么样）正交。

   现在两种：
     'solid'（默认）—— 普通砖，被撞只会被推走 / 掀翻，永远继续承重
     'glass'        —— 玻璃砖，撞击速度超过阈值就**当场碎裂消失**，不再提供任何支撑
                        （阈值 GLASS_BREAK_V 在 Game.ts；只判撞击、不判静置压力，
                        所以「一堆玻璃砖静静托着一块板」不会自己垮）

   ⚠️ 加第三种砖种要动的地方（照这个清单走，漏一处就会「数据写了但没效果」）：
     1. 这里加一个字面量
     2. art.ts   —— 加它的材质工厂（颜色 / 透明 / 高光一律收在 art.ts，别写在 Game.ts）
     3. Game.ts  —— addBrick 里按 kind 选材质；若它有特殊行为，在碰撞回调里加判定
                    （参考 glass 的 queueShatter + drainShatters 那一路）
     4. tools/   —— check-levels.mjs 与 playtest.mjs 都要把新行为补进物理复刻，
                    否则这两个工具算出来的数字会与真机脱节
     5. i18n.ts  —— 新手引导里加一句，玩家得先知道它是什么
   ------------------------------------------------------------------------- */
export type BrickKind = 'solid' | 'glass';

/**
 * 砖种选择器：构件工厂用它把某几块砖指定成特殊砖种。
 *   ({ row, col }) => 'glass'   —— 这一块做成玻璃
 *   ({ row, col }) => undefined —— 普通砖（默认）
 * row / col 的语义随构件不同（见各工厂的注释），但都从 0 起算、从下往上。
 * 以后加新砖种，同一个选择器里返回新的 kind 就行，签名不用改。
 */
export type BrickPick = (ctx: { row: number; col: number }) => BrickKind | undefined;

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
  /** 砖种，省略即 'solid'。玻璃砖见文件顶部的 BrickKind 说明 */
  kind?: BrickKind;
}

export type ColorKey = 'red' | 'yellow' | 'blue' | 'green' | 'purple' | 'orange' | 'gray';

/* ⚠️ 这里曾经有一份 `COLORS: Record<ColorKey, number>`（亮色调色板）。
   美术重构后色值统一搬到 `art.ts` 的 `PALETTE`（低饱和受限调色板），这份就没人引用了 ——
   留着是隐患：以后有人往这里加颜色会发现「改了没反应」。
   改色值请改 `art.ts` 的 `PALETTE`，关卡只写 ColorKey 这类「颜色名」。 */

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
  /** 挑战模式规则。省略即 `{ judge: 'complete' }`（见 ChallengeRule 说明） */
  challenge?: ChallengeRule;
  bricks: BrickDef[];
}

/* ============================================================================
   挑战模式（Challenge Mode）—— 每关只有 1 发弹药，一发定胜负，失败即重来。

   判定基准来自「理论最少发数」`E = 目标 ÷ 一发最好`（见 GAME_DESIGN.md 第 3 节）：
     · E ≤ 1（即 ⌈E⌉ = 1）⇒ 存在一发即胜的弹道 ⇒ 用 judge: 'complete'
     · E > 1，或目标「形态上一发不可能完成」⇒ 用 judge: 'score'（积分判定）

   ⚠️ 加关卡 / 改目标时按这条自查：**「这个目标能不能用一发同时达成？」**
      不能，就必须写 judge: 'score' 并给一条 scoreLine，否则这关在挑战模式里
      变成永远通不过的死关（因为只有 1 发，目标判据永远为假）。

   ⚠️ scoreLine 的取值方法（2026-09-24 修订）：**跑 `playtest.mjs` 拿到「单发最高分」，
      再取它的约 50%**，取整到 50。
      旧公式 `一发最好 × 100 × 0.6` 只数砖块、**漏算了连击奖励**（1.6 秒窗口内每多倒
      一块 +25% 基础分），实测与真实得分差 3~4 倍 —— L7 就是因此变成「发挥 23% 即通过」的。
      **改关卡结构 ⇒ 必须重跑 playtest.mjs 并同步这两个数。**
   ========================================================================== */
export interface ChallengeRule {
  /** complete：一发达成关卡目标即通过；score：不做完成判定，改用得分线 */
  judge: 'complete' | 'score';
  /** judge === 'score' 时的通过线 */
  scoreLine?: number;
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

   ⚠️ 下面所有关卡写的是**设计坐标**（靶场摆在 z = -30 一带）。导出前会按
      FIELD_SHIFT_Z 把所有砖整体拉近炮台（见文件末尾），所以「瞄一眼关卡数据里的 z」
      和「在游戏里量到的距离」差一个常数，这是故意的，不是笔误。
   ========================================================================== */

/** 砖墙。x0 = 墙的【左边缘】（不是首块砖的中心）。
 *  pick 的 row = 第几层（0 = 最底）、col = 该层从左往右第几块（0 起算）。 */
function wall(
  x0: number, y0: number, z: number, cols: number, rows: number,
  bw = 1.6, bh = 0.8, bd = 0.9, pick?: BrickPick,
): BrickDef[] {
  const out: BrickDef[] = [];
  const full = bw * 0.97;  // 整砖实际宽度（留 3% 缝，避免相邻砖侧面互相穿插）
  const half = bw / 2;     // 半砖的标准宽度
  for (let r = 0; r < rows; r++) {
    const y = y0 + bh / 2 + r * bh;
    let i = 0;
    const push = (cx: number, w: number, mass: number, col: number) =>
      out.push({
        shape: 'box',
        pos: [cx, y, z],
        // 高度取满 bh（原先写 bh * 0.95）：层间留缝会让整面墙微沉，横向扰动足以把
        // 最外侧那块砖晃到 39°（判定阈值 38°），开局白送 1 块进度。
        size: [w, bh, bd],
        color: rainbow[(r + i++) % rainbow.length],
        mass,
        kind: pick?.({ row: r, col }),
      });

    if (r % 2 === 0) {
      for (let c = 0; c < cols; c++) push(x0 + (c + 0.5) * bw, full, 1.4, c);
    } else {
      // 奇数层 = 两端半砖 + 中间 cols-1 块整砖 ⇒ 外轮廓与偶数层逐毫米对齐。
      // ⚠️ 不能只把整砖整体平移半块（原先的写法）：那样每层两端各凸出半块砖，
      // 而这半块的【正下方是空的】——重心落在支撑区外，关卡开局静置 0.6 秒就会
      // 自己倾覆，白送一块击倒进度，且与玩家开没开炮无关。用半砖收边后，
      // 上下两层的边界完全重合，凸出问题从根上消失。
      push(x0 + half / 2, half * 0.97, 0.7, 0);
      for (let c = 0; c < cols - 1; c++) push(x0 + half + (c + 0.5) * bw, full, 1.4, c + 1);
      push(x0 + cols * bw - half / 2, half * 0.97, 0.7, cols);
    }
  }
  return out;
}

/** 叠塔。y0 = 起建高度（放在平台上时必须传平台顶面高度，否则柱底会埋进平台）。
 *  pick 的 row = 第几层（0 = 最底）、col = 0/1 两根支柱、2 楼板。目标宝石不吃 pick。 */
function tower(
  x: number, z: number, layers: number, base = 2.2, y0 = 0, withTarget = true, pick?: BrickPick,
): BrickDef[] {
  const out: BrickDef[] = [];
  let y = y0;
  for (let i = 0; i < layers; i++) {
    const w = base * (1 - i * 0.06);
    const k = (col: number) => pick?.({ row: i, col });
    // two pillars + plate
    out.push({ shape: 'box', pos: [x - w / 2, y + 0.6, z], size: [0.6, 1.2, 0.8], color: rainbow[i % 6], mass: 1.2, kind: k(0) });
    out.push({ shape: 'box', pos: [x + w / 2, y + 0.6, z], size: [0.6, 1.2, 0.8], color: rainbow[i % 6], mass: 1.2, kind: k(1) });
    out.push({ shape: 'box', pos: [x, y + 1.35, z], size: [w + 1.0, 0.3, 1.2], color: rainbow[(i + 3) % 6], mass: 1.0, kind: k(2) });
    y += 1.5;
  }
  // withTarget=false 用于「塔顶要盖别的东西」的关卡（顶面得空出来）
  if (withTarget) {
    out.push({ shape: 'cylinder', pos: [x, y + 0.5, z], size: [0.6, 1.0, 0.6], color: 'purple', mass: 1.0, target: true, score: 300 });
  }
  return out;
}

/** 拱门。y0 = 起建高度；cols 由 h 推出，顶梁顶面 = y0 + cols * 0.9 + 0.4。
 *  pick 的 row = 第几块柱石（0 = 最底），顶梁那块的 row = cols；col = 0 左腿 / 1 右腿（顶梁恒 0）。 */
function arch(x: number, z: number, h: number, span: number, color: ColorKey, y0 = 0, pick?: BrickPick): BrickDef[] {
  const out: BrickDef[] = [];
  const cols = Math.round(h / 0.9);
  for (let i = 0; i < cols; i++) {
    out.push({ shape: 'box', pos: [x - span / 2, y0 + 0.45 + i * 0.9, z], size: [0.9, 0.9, 0.9], color, mass: 1.3, kind: pick?.({ row: i, col: 0 }) });
    out.push({ shape: 'box', pos: [x + span / 2, y0 + 0.45 + i * 0.9, z], size: [0.9, 0.9, 0.9], color, mass: 1.3, kind: pick?.({ row: i, col: 1 }) });
  }
  const top = y0 + cols * 0.9;
  out.push({ shape: 'box', pos: [x, top + 0.2, z], size: [span + 1.1, 0.4, 1.0], color: 'yellow', mass: 1.6, kind: pick?.({ row: cols, col: 0 }) });
  return out;
}

/* ============================================================================
   关卡数据本体 —— 用的是设计坐标（靶场在 z = -30 一带），导出前统一按
   FIELD_SHIFT_Z 拉近炮台（见文件末尾）。x/y 是布局与承重高度，不受影响。
   ========================================================================== */
const DESIGNED_LEVELS: LevelDef[] = [
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
    hint: { zh: '底部两根支柱是玻璃砖——一撞就碎，碎掉就不再承重。', en: 'The two bottom pillars are glass — shatter them and they stop holding anything up.' },
    ammo: 5,
    targetScore: 1600,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'targets' },
    bricks: [
      // 平台顶面 = 0.25 + 0.25 = 0.5，塔从 0.5 起建（原先从 0 起建，柱底埋进平台 0.5m）
      { shape: 'box', pos: [0, 0.25, -27], size: [7, 0.5, 5], color: 'gray', static: true },
      /* 两根高玻璃柱（0.5 → 2.9，高 2.4）扛着整座塔。
         这是全游戏第一次出现玻璃砖，也是把「碎掉就不再承重」讲清楚的地方：
         塔整座架在玻璃上，玩家打碎柱子 → 塔掉 2.4m 砸在平台上（位移超过
         1.2 的判定阈值，所以整座塔都算被击倒）+ 一把玻璃碴，反馈非常干脆。

         ⚠️ 为什么不干脆把 tower 自带的底部支柱改成玻璃：那两根支柱（高 1.2）
            夹在平台顶面 0.5 与上方楼板底面 1.7 之间，球心只有 0.3m 的通过窗口 ——
            要正好穿过那道缝才碰得到，第 2 关不该考这种准头。
            把玻璃柱做高做粗（0.9 × 2.4），从下方 3.8m 之内随便打都中。 */
      { shape: 'box', pos: [-1.1, 1.7, -27], size: [0.9, 2.4, 1.2], color: 'blue', kind: 'glass', mass: 1.6 },
      { shape: 'box', pos: [1.1, 1.7, -27], size: [0.9, 2.4, 1.2], color: 'blue', kind: 'glass', mass: 1.6 },
      // 塔从柱顶 2.9 起建（柱顶面 = 1.7 + 1.2 = 2.9）。层数从 6 降到 5 ——
      // 加了 2.4m 的柱子之后，整座塔的总高（10.4）才和原来的 9.5 差不多。
      ...tower(0, -27, 5, 2.2, 2.9),
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
    /* 挑战模式用积分判定：4 块红砖堆在挡板后面的高台上，一发最多只能吃到一侧，
       「一发打掉 4 块红砖」在形态上不可靠。scoreLine = 一发最好 9 × 100 × 0.6 ≈ 550。 */
    challenge: { judge: 'score', scoreLine: 550 },
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
    hint: { zh: '中间那道墙的腰是玻璃——打碎它，上面自己就塌了。', en: 'The middle of that wall is glass — break it and the rest collapses.' },
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
      // 中间那一层（row 1）是玻璃：打碎它，上面三层砖失去支撑自己塌下来
      ...wall(-2.1, 3.7, -30, 3, 3, 1.4, 0.8, 0.9, ({ row }) => (row === 1 ? 'glass' : undefined)),
      // 大横板：底 8.1 = 塔顶面（0.6 + 5 × 1.5），两端各搭在一条塔顶
      { shape: 'box', pos: [0, 8.3, -30], size: [15, 0.4, 1.6], color: 'orange', mass: 2.2 },
      // 板上砖底 = 8.5（大横板顶面）
      { shape: 'box', pos: [-2, 9.0, -30], size: [1.2, 1.0, 1.2], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [2, 9.0, -30], size: [1.2, 1.0, 1.2], color: 'green', mass: 1.2 },
      { shape: 'cylinder', pos: [0, 9.1, -30], size: [0.6, 1.2, 0.6], color: 'purple', mass: 1.1, target: true, score: 400 },
    ],
  },

  /* ------------------------------------------------------------------------
     L6 ~ L10：场景与结构组合逐关变复杂，但**难度基本持平**。
     把握两条配平原则，别让后五关变成体力活：
       1. 目标数 ≈ 可击倒砖数的 46% ~ 51%（前五关是 33% ~ 64%，落在同一带里）
       2. 弹药数随结构数量增长，不做「弹药不变、砖数翻倍」的加难
     ------------------------------------------------------------------------ */
  {
    name: { zh: '双塔', en: 'Twin Towers' },
    hint: { zh: '两座塔被一块长板连在一起——拆掉一条腿就够了。', en: 'The towers are joined by a plank — take out one leg.' },
    ammo: 5,
    /* 目标数由 tools/playtest.mjs 实测反推，不是拍脑袋定的。本关改过两轮：
       · 靶场在 z=-28（老距离）时一发最好 19 ⇒ 目标 14（「一发/目标」136%，与最紧的 L5 持平）
       · 靶场整体拉近 6m 后一发最好涨到 26 ⇒ 目标回到 18（144%）
       距离一近，低仰角的平射能一路犁过去，单发覆盖率明显变高 —— 这就是为什么
       动 FIELD_SHIFT_Z 之后这一关必须重测。targetScore 按 120 分/块 跟着走。 */
    targetScore: 2200,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'knockCount', count: 18 },
    bricks: [
      // 平台顶面 = 0.6，两座塔一律从 0.6 起建
      { shape: 'box', pos: [0, 0.3, -28], size: [20, 0.6, 10], color: 'gray', static: true },
      // withTarget = false：塔顶面要留给大横板
      ...tower(-7, -28, 4, 2.0, 0.6, false),
      ...tower(7, -28, 4, 2.0, 0.6, false),
      // 大横板：底 6.6 = 塔顶面（0.6 + 4 × 1.5），两端各搭在一条塔顶
      { shape: 'box', pos: [0, 6.8, -28], size: [15, 0.4, 1.6], color: 'orange', mass: 2.2 },
      // 板上砖底 = 7.0（横板顶面）
      { shape: 'box', pos: [-2, 7.5, -28], size: [1.2, 1.0, 1.2], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [2, 7.5, -28], size: [1.2, 1.0, 1.2], color: 'green', mass: 1.2 },
      { shape: 'cylinder', pos: [0, 7.6, -28], size: [0.6, 1.2, 0.6], color: 'purple', mass: 1.1, target: true, score: 300 },
      // 板下的矮墙：底 0.6 = 平台顶面，顶 3.0（离板底还有 3.6，互不接触）
      ...wall(-2.1, 0.6, -28, 3, 3, 1.4),
    ],
  },
  {
    name: { zh: '阶梯要塞', en: 'Stepped Fortress' },
    hint: { zh: '左边那座拱门站在玻璃腿上——先从腿根下手。', en: 'The left arch stands on glass legs — start at the base.' },
    ammo: 5,
    targetScore: 2000,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'targets' },
    /* 挑战模式用积分判定：两个紫色目标物分列 x=−7 与 x=+7，一发物理上不可能
       同时命中 ⇒ ⌈E⌉ = 2 而不是 1（这一点用「一发最好 ÷ 砖块数」看不出来，
       正是 GAME_DESIGN.md §1.2 说的度量盲区）。

       ⚠️ 2026-09-24 从 850 上调到 1800：原值 = 14 × 100 × 0.6，那个公式只数砖块、
       **漏算了连击奖励** —— 实测这一发实际拿 3675 分（14 块全落在同一条连击链里），
       850 只要发挥 23% 就过，等于没有难度。现取「单发最高分 × 约 0.5」≈ 1800，
       相当于要求打掉 9 块且全部连击（100×9 + 25×36 = 1800），是对一发最好的 64%。 */
    challenge: { judge: 'score', scoreLine: 1800 },
    bricks: [
      // 左台顶面 2.0、右台顶面 3.0，中间那片是草地（y = 0）
      { shape: 'box', pos: [-7, 1.0, -26], size: [8, 2.0, 7], color: 'gray', static: true },
      { shape: 'box', pos: [7, 1.5, -26], size: [8, 3.0, 7], color: 'gray', static: true },
      /* 左台：拱门顶梁顶面 = 2.0 + 3.6 + 0.4 = 6.0。
         两条腿最下面两块（row 0 / 1）是玻璃 —— 打在腿根上，腿一碎整座拱门就没了，
         平台上那两颗砖和宝石直接掉下来。 */
      ...arch(-7, -26, 3.6, 4.0, 'blue', 2.0, ({ row }) => (row < 2 ? 'glass' : undefined)),
      { shape: 'box', pos: [-8.6, 6.4, -26], size: [1.2, 0.8, 1.2], color: 'red', mass: 1.1 },
      { shape: 'box', pos: [-5.4, 6.4, -26], size: [1.2, 0.8, 1.2], color: 'yellow', mass: 1.1 },
      { shape: 'cylinder', pos: [-7, 6.5, -26], size: [0.55, 1.0, 0.55], color: 'purple', mass: 1.0, target: true, score: 300 },
      // 右台：三层塔，顶面 = 3.0 + 3 × 1.5 = 7.5，塔顶自带一颗目标（y = 8.0）
      ...tower(7, -26, 3, 2.0, 3.0),
      // 中路的矮墙直接立在草地上：底 = 0，顶 = 3.2
      ...wall(-2.4, 0, -26, 3, 4, 1.4),
    ],
  },
  {
    name: { zh: '双层柱廊', en: 'Twin-Tier Colonnade' },
    hint: { zh: '中间那座拱门的腿是玻璃——碎掉，长廊就会塌腰。', en: 'The middle arch stands on glass — break it and the gallery sags.' },
    ammo: 5,
    targetScore: 2400,
    twoStarAmmoLeft: 2,
    ground: 'sand',
    objective: { kind: 'knockCount', count: 19 },
    bricks: [
      // 平台顶面 0.6；一层拱门（cols = 3）顶梁顶面 = 0.6 + 2.7 + 0.4 = 3.7
      { shape: 'box', pos: [0, 0.3, -30], size: [20, 0.6, 8], color: 'gray', static: true },
      ...arch(-7, -30, 2.7, 3.0, 'blue', 0.6),
      // 中间这座拱门的腿根（row 0 / 1）是玻璃：碎掉之后长廊中段失去支撑而塌腰，
      // 二层那两座小拱门会跟着翻下来。两侧的拱门保持实心，塌的只是中段。
      ...arch(0, -30, 2.7, 3.0, 'green', 0.6, ({ row }) => (row < 2 ? 'glass' : undefined)),
      ...arch(7, -30, 2.7, 3.0, 'orange', 0.6),
      // 长廊：底 3.7，同时落在三座拱门的顶梁上（三段支撑，端头各挑出一点也不会倾）
      { shape: 'box', pos: [0, 3.9, -30], size: [20, 0.4, 1.6], color: 'yellow', mass: 2.2 },
      // 二层小拱门（cols = 2）：底 4.1 = 长廊顶面，顶梁顶面 = 4.1 + 1.8 + 0.4 = 6.3
      ...arch(-3.5, -30, 1.8, 2.0, 'red', 4.1),
      ...arch(3.5, -30, 1.8, 2.0, 'red', 4.1),
      // 二层顶板：底 6.3，两端搭在两座小拱门的顶梁上
      { shape: 'box', pos: [0, 6.5, -30], size: [8, 0.4, 1.4], color: 'orange', mass: 1.8 },
      { shape: 'box', pos: [-2.4, 7.2, -30], size: [1.0, 1.0, 1.0], color: 'red', mass: 1.1 },
      { shape: 'box', pos: [2.4, 7.2, -30], size: [1.0, 1.0, 1.0], color: 'green', mass: 1.1 },
      { shape: 'cylinder', pos: [0, 7.2, -30], size: [0.6, 1.0, 0.6], color: 'purple', mass: 1.1, target: true, score: 300 },
      // 长廊两端各摆一颗目标——正好压在边跨拱门的上方
      { shape: 'cylinder', pos: [-7, 4.6, -30], size: [0.55, 1.0, 0.55], color: 'purple', mass: 1.0, target: true, score: 300 },
      { shape: 'cylinder', pos: [7, 4.6, -30], size: [0.55, 1.0, 0.55], color: 'purple', mass: 1.0, target: true, score: 300 },
    ],
  },
  {
    name: { zh: '双砦', en: 'Twin Keeps' },
    hint: { zh: '左右各一座要塞，中间还挡着一道矮墙。', en: 'A keep on each flank — with a low wall blocking the middle.' },
    ammo: 6,
    /* 目标数由 tools/playtest.mjs 实测反推。本关是全场最「散」的一关
       （两座塔 + 两座拱门 + 长廊 + 中路矮墙，彼此不相连），单发覆盖率天生就低：
       · 靶场在 z=-29 时一发最好 28 ⇒ 目标 20（「一发/目标」140%）
       · 拉近 6m 后一发最好掉到 17（散开的单元对落点高度极敏感，平射带不出连锁）
         ⇒ 目标 12（142%）。弹药 × 一发最好 / 目标 = 8.5×，仍在同一带里。
       如果嫌「击倒 12 块」看着配不上倒数第二关，正确做法是**改结构**
       （把几座单元用横板连起来，让连锁能跨过去），而不是把目标数调回高比例。 */
    targetScore: 1500,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'knockCount', count: 12 },
    bricks: [
      { shape: 'box', pos: [0, 0.3, -29], size: [26, 0.6, 9], color: 'gray', static: true },
      // 两座四层塔（顶面 6.6），塔顶各带一颗目标（y = 6.6 + 0.5）
      ...tower(-9, -29, 4, 2.0, 0.6),
      ...tower(9, -29, 4, 2.0, 0.6),
      // 中间一对拱门：顶梁顶面 = 0.6 + 2.7 + 0.4 = 3.7
      ...arch(-4.5, -29, 2.7, 3.0, 'blue', 0.6),
      ...arch(4.5, -29, 2.7, 3.0, 'blue', 0.6),
      // 廊板：底 3.7，两端各搭在一座拱门的顶梁上；顶面 4.1
      { shape: 'box', pos: [0, 3.9, -29], size: [11, 0.4, 1.6], color: 'orange', mass: 2.0 },
      // 板上物件的底面一律 = 4.1（板厚 0.4 ⇒ pos.y = 4.1 + 高度/2）
      { shape: 'box', pos: [-2, 4.7, -29], size: [1.2, 1.2, 1.2], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [2, 4.7, -29], size: [1.2, 1.2, 1.2], color: 'green', mass: 1.2 },
      { shape: 'cylinder', pos: [0, 4.8, -29], size: [0.6, 1.4, 0.6], color: 'purple', mass: 1.1, target: true, score: 300 },
      // 中路的矮墙：底 0.6 = 平台顶面，顶 3.0 —— 比廊板底低 0.7，互不接触
      ...wall(-1.8, 0.6, -29, 3, 3, 1.2),
    ],
  },
  {
    name: { zh: '大教堂', en: 'The Cathedral' },
    hint: { zh: '一顶大屋顶压着两塔一拱——两翼的玻璃花窗一碰就碎。', en: 'One great roof over two towers and an arch — the flank windows are glass.' },
    ammo: 6,
    targetScore: 3800,
    twoStarAmmoLeft: 2,
    ground: 'sand',
    objective: { kind: 'knockCount', count: 28 },
    bricks: [
      { shape: 'box', pos: [0, 0.3, -30], size: [26, 0.6, 10], color: 'gray', static: true },
      // 两座四层塔（顶面 6.6），顶面留给大屋顶
      ...tower(-10, -30, 4, 2.0, 0.6, false),
      ...tower(10, -30, 4, 2.0, 0.6, false),
      // 中央拱门（cols = 6）：顶梁顶面 = 0.6 + 5.4 + 0.4 = 6.4
      ...arch(0, -30, 5.4, 5.0, 'blue', 0.6),
      /* 拱心石：把 6.4 垫到 6.6，与两塔顶面齐平。
         拱门顶面天生到不了 6.6（cols 取整数，只能落在 5.8 / 6.7），
         所以大屋顶要「三点同时落地」就必须补这一块 —— 少垫 0.2 的话屋顶会先砸在
         拱顶上、再落到两塔，这一下冲击就足够把关卡开局搅乱。 */
      { shape: 'box', pos: [0, 6.5, -30], size: [2.4, 0.2, 1.2], color: 'gray', mass: 1.0 },
      // 大屋顶：底 6.6，三点支撑（左塔 / 拱心石 / 右塔）
      { shape: 'box', pos: [0, 6.8, -30], size: [22, 0.4, 1.6], color: 'orange', mass: 2.4 },
      // 屋顶上的小墙：底 7.0 = 屋顶顶面，顶 8.6
      ...wall(-2.1, 7.0, -30, 3, 2, 1.4),
      { shape: 'cylinder', pos: [0, 9.1, -30], size: [0.6, 1.0, 0.6], color: 'purple', mass: 1.1, target: true, score: 400 },
      { shape: 'box', pos: [-5, 7.5, -30], size: [1.2, 1.0, 1.2], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [5, 7.5, -30], size: [1.2, 1.0, 1.2], color: 'green', mass: 1.2 },
      // 底层两翼的矮墙（底 0.6，顶 3.0）与墙头砖。中间那排是「花窗」玻璃：
      // 打碎花窗，墙头那两块就砸下来——教堂两侧各一处，共两块。
      ...wall(-7.5, 0.6, -30, 2, 3, 1.4, 0.8, 0.9, ({ row }) => (row === 1 ? 'glass' : undefined)),
      ...wall(4.7, 0.6, -30, 2, 3, 1.4, 0.8, 0.9, ({ row }) => (row === 1 ? 'glass' : undefined)),
      { shape: 'box', pos: [-6.1, 3.5, -30], size: [1.0, 1.0, 1.0], color: 'yellow', mass: 1.1 },
      { shape: 'box', pos: [6.1, 3.5, -30], size: [1.0, 1.0, 1.0], color: 'yellow', mass: 1.1 },
    ],
  },
];

/* ============================================================================
   靶场整体位移 —— 炮台固定在原点，而设计坐标把靶场摆在 z = -30 一带，
   在第三人称相机下目标偏小。这里把所有砖的 z 统一拉近（正值 = 靠近炮台），
   一个数字就能整体调景别，不必逐关改几十处坐标。

   ⚠️ 三条规矩：
     1. 只动 z。x / y 是俯视布局与承重高度，动了要重新算贴合高度。
     2. 改完必须重跑 tools/check-levels.mjs 与 tools/playtest.mjs ——
        弹道所需初速随距离变化，「一发最好 / 目标」会跟着变。
     3. 场景装饰（树 / 岩石 / 草丛）的避让走廊在 art.ts 的 LANE 里，余量很大，
        这个数在 ±10 以内都不用动它。
   ========================================================================== */
export const FIELD_SHIFT_Z = 6;

/** 关卡数据（已应用 FIELD_SHIFT_Z）。工具与游戏一律读这个。 */
export const LEVELS: LevelDef[] = DESIGNED_LEVELS.map((lv) => ({
  ...lv,
  bricks: lv.bricks.map((b) => ({
    ...b,
    pos: [b.pos[0], b.pos[1], b.pos[2] + FIELD_SHIFT_Z] as [number, number, number],
  })),
}));
