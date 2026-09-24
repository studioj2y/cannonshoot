import { ENV, PALETTE } from './art';

/* ============================================================================
   弹药（AmmoKind）—— 与「砖种」同理，做成可扩展位而不是硬编码几种球。

   为什么需要它：只有一种球时，每关只有一条最优解 —— 玩家找到那条弹道之后
   关卡就变成背诵题。多种弹药让同一关出现多解与取舍，而且其中两种（三连发、
   爆破筒）是「单发覆盖率低的关卡」的对症解药：它们能一次处理多个独立承重
   单元，正好补上「结构散 ⇒ 一发打不完 ⇒ 目标数定不高」这个限制。

   ⚠️ 加第五种弹药要动的地方（照这个清单走，漏一处就会「数据写了但没效果」）：
     1. 这里加一个字面量 + 一条 AMMO 参数
     2. Game.ts  —— fire() 里若它有特殊行为（散射 / 接触引爆 / 穿透），在
                    spawnBall 那一路加分支（参考 bomb 的 detonate + explode）
     3. tools/   —— **playtest.mjs 的 AMMO 表**要把新弹药补上（含它的特殊行为）。
                    ⚠️ 漏了不会报错，只是工具从此与真机脱节 —— 这是这类项目里
                    最难发现的一类失真，比「工具报错」危险得多。
                    （check-levels.mjs **不开炮**，所以它不需要复刻弹药。）
     4. i18n.ts  —— ammoName / ammoDesc 各加一条中英对照
     5. 教程 tips —— 玩家得先知道它是什么
   ========================================================================== */

export type AmmoKind = 'standard' | 'hammer' | 'bomb' | 'triple';

export interface AmmoDef {
  kind: AmmoKind;
  /** 球体半径（也是碰撞半径） */
  radius: number;
  mass: number;
  /** 初速倍率：作用在力度上。射程 ∝ v²，所以 0.88 意味着射程只剩约 77% */
  powerScale: number;
  /** 一次发射几颗 */
  count: number;
  /** 多发时的左右偏移角（度）。仅 count > 1 时有意义 */
  spread?: number;
  /** 球色。取自受限调色板 / 环境色，不新造颜色 */
  color: number;
}

/* 参数定值说明（改动前先读）：
   · standard —— 基准。质量 9 / 半径 0.45 是所有关卡配平的前提，不要动。
   · hammer   —— 质量翻倍 ⇒ 动能 ×2.2，穿厚墙 / 砸静态平台边缘最有效。
                 代价是初速 ×0.88 ⇒ 射程只剩约 77%，玩家必须把力度滑杆调高，
                 因此微调余量变小（难度换威力）。不要因为「打不远」就把它调到 1.0，
                 那样它就变成纯强化，没有取舍了。
   · bomb     —— **接触引爆**：碰到东西的那一帧就炸，没有引信延迟。
                 对周围施加径向速度增量，是玻璃砖的克星（爆炸产生的 Δv 远超
                 GLASS_BREAK_V）。代价是会连带掀掉自己脚下的结构 —— 拆得干净也拆得狠。
                 ⚠️ 为什么不留引信延迟：现在的关卡都是「薄壳 + 一块平台」，
                 纵深只有一两块砖。球一碰到外壳其实就已经在结构的**外面**了，
                 再飞 0.3 秒（时速 40 米 ⇒ 12 米）就彻底掠过整个目标 —— 玩家看到的
                 是「炸了个寂寞」。改成接触引爆后爆炸中心落在结构**表面**，
                 所以它是「拆表层 / 炸玻璃」的弹药，不是「掏内部」的弹药。
   · triple   —— 三颗小子弹，两颗各偏 ±SPREAD 度。单颗动能只有标准的 55%，
                 打不动厚墙；但三颗能同时够到三个分开的承重单元。
                 精度代价：侧边两颗落点散开，打「顶部目标物」几乎不可用。 */
export const AMMO: Record<AmmoKind, AmmoDef> = {
  standard: { kind: 'standard', radius: 0.45, mass: 9, powerScale: 1.0, count: 1, color: ENV.ball },
  hammer: { kind: 'hammer', radius: 0.62, mass: 18, powerScale: 0.88, count: 1, color: ENV.metal },
  bomb: { kind: 'bomb', radius: 0.5, mass: 11, powerScale: 1.0, count: 1, color: PALETTE.red },
  triple: { kind: 'triple', radius: 0.32, mass: 5, powerScale: 1.0, count: 3, spread: 7, color: PALETTE.purple },
};

/** 切换顺序（HUD 的循环按钮按这个顺序走） */
export const AMMO_ORDER: AmmoKind[] = ['standard', 'hammer', 'bomb', 'triple'];

/** 让 UI 与工具都能拿到「第几种 / 共几种」 */
export const ammoIndex = (k: AmmoKind) => Math.max(0, AMMO_ORDER.indexOf(k));

/* 爆破筒：接触引爆的触发阈值（撞击法向速度 m/s）。
   保留它是因为 cannon-es 的 collide 对「贴地滑一下」「被别的球轻推一下」也会触发 ——
   没有阈值的话球出膛蹭到什么都炸。1.5 远低于任何一次真实命中的法向速度
   （20+），又高于求解器安顿时的抖动（<1），所以它只过滤纯擦碰。
   ⚠️ 引爆**没有延迟**：命中当帧就炸。改这个数要同步 tools/playtest.mjs。 */
export const BOMB_TRIGGER_V = 1.5;

/* 爆炸参数。⚠️ 用「速度增量」而不是「冲量」来描述强度：
   冲量的实际效果是 impulse / mass，而砖块质量各不相同（1.0 ~ 1.6），
   写冲量会让轻砖飞上天、重砖纹丝不动。按速度增量施加才可控。
   Δv = EXPLOSION_DV × (1 − 距离/半径)，边缘衰减到 0。
   ⚠️ 改这两个数要同步 tools/playtest.mjs。 */
export const EXPLOSION_RADIUS = 3.4;
export const EXPLOSION_DV = 14;

/* 爆炸的视觉表现**不在这个文件里**，也不是一个可调半径 —— 它是 Game.explode() 末尾的
   两波 spawnParticles（暖黄 24 颗 + 砖红 12 颗）+ 震屏 + collapse 音效。
   （早先这里定义过一个 EXPLOSION_FX_RADIUS，但没有任何地方读它 ——
     那种「看起来能配、调了却没效果」的常量比没有更糟，已删除。） */
