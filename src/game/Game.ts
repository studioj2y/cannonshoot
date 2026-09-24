import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { audio } from './audio';
import { LEVELS, type BrickDef, type LevelDef } from './levels';
import {
  AMMO,
  AMMO_ORDER,
  BOMB_TRIGGER_V,
  EXPLOSION_DV,
  EXPLOSION_RADIUS,
  ammoIndex,
  type AmmoDef,
  type AmmoKind,
} from './ammo';
import {
  ENV,
  FX,
  PALETTE,
  mat,
  glassMaterial,
  unlit,
  fadeMaterial,
  trailMaterial,
  flashMaterial,
  blastMaterial,
  brickGeometry,
  gemGeometry,
  icoGeometry,
  prismGeometry,
  shardGeometry,
  ringGeometry,
  dustGeometry,
  buildScenery,
  disposeArt,
  isLowPowerDevice,
  type Scenery,
} from './art';

export interface HudState {
  level: number;
  objectiveProgress: string;
  ammo: number;
  maxAmmo: number;
  score: number;
  targetScore: number;
  yaw: number;
  pitch: number;
  power: number;
  stars: number;
  status: 'playing' | 'won' | 'lost';
  combo: number;
  /** 触控设备上是否正处于「按住瞄准」状态（手指按住未松开） */
  aiming: boolean;
  /** 当前选中的弹药（UI 用它在 i18n 里查名字，引擎不产出界面文案） */
  ammoKind: AmmoKind;
  /** 是否处于挑战模式（一发定胜负） */
  challenge: boolean;
  /** 挑战模式的积分判定线；0 = 本关用「一发完成目标」判定，不显示分数进度 */
  challengeLine: number;
}

interface Brick {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  def: BrickDef;
  initPos: CANNON.Vec3;
  initQuat: CANNON.Quaternion;
  knocked: boolean;
  /** 玻璃砖已碎（已从世界与 bricks 列表里摘掉），防止同一块被记账两次 */
  shattered: boolean;
  score: number;
}

interface Ball {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  born: number;
  trail: THREE.Points;
  trailPts: THREE.Vector3[];
  /** 发射它的弹药种类。目前只用于爆破筒的接触引爆判定 */
  ammo: AmmoKind;
  /** 爆破筒是否已请求引爆（第一次有效命中时置位，由 step() 的炮弹段兑现） */
  detonate: boolean;
}

/**
 * 一颗碎屑 / 尘埃。
 *
 * ⚠️ 后五个字段（`gravity` / `grow` / `peak` / `fadePow` / `spinDamp`）是为了
 * 让「火星」「碎块」「尘埃」三种东西共用**一条**更新与回收路径而加的。
 * 默认值就是老行为（重力 0.35、不长大、峰值不透明 1、线性淡出），
 * 所以撞击碎屑 / 玻璃碴 / 彩带都不受影响。分开写三个数组会有三份回收逻辑 ——
 * 那种写法在 `reset()` 里漏掉一份就是「换了关卡还有粒子留在天上」。
 */
interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  max: number;
  spin: THREE.Vector3;
  /** 重力倍数（可为负 = 上浮，尘埃用） */
  gravity: number;
  /** 每秒缩放增量（0 = 不长） */
  grow: number;
  /** 峰值不透明度 */
  peak: number;
  /** 淡出曲线指数：1 = 线性，越大越「先亮后突然灭」 */
  fadePow: number;
  /** 每秒自旋衰减（0 = 不衰减） */
  spinDamp: number;
}

/**
 * 一次粒子发射的「长什么样」。所有字段都可选，默认值 = 老版本撞击碎屑的行为。
 * 速度模型是固定的两条：水平抖动 `(rand−0.5) × speedJitter`、向上 `rand × upBias`，
 * 整体再乘 `power`。想换「向下掉」的（彩带那种）就直接用 `addParticle()` 自己给速度。
 */
interface ParticleSpec {
  n: number;
  color: number;
  geo: THREE.BufferGeometry;
  /** 初速倍率 */
  power?: number;
  /** 重力倍数（负 = 上浮，尘埃用） */
  gravity?: number;
  /** 每秒缩放增量（0 = 不长） */
  grow?: number;
  peak?: number;
  fadePow?: number;
  /** 初始缩放的下调比例：0.3 = 在 70%~100% 之间随机 */
  sizeJitter?: number;
  lifeMin?: number;
  lifeMax?: number;
  /** 水平初速抖动上限 */
  speedJitter?: number;
  /** 向上初速上限 */
  upBias?: number;
  /** 自旋上限 */
  spin?: number;
  spinDamp?: number;
}

/**
 * 一次性爆发特效（爆心闪光 / 冲击波环）。
 * 与 `Particle` 分开是因为它们的生命周期曲线不一样 —— 它们**受时间驱动地放大**，
 * 不受重力、不受初速影响，也不需要自旋。
 * ⚠️ `billboard` 的对象每帧要转向相机：环是平面物，不转向就会在近水平机位上被压成一条线。
 */
interface Blast {
  mesh: THREE.Mesh;
  life: number;
  max: number;
  /** 起始 / 结束缩放（世界单位，环的 `s1` 必须等于 EXPLOSION_RADIUS） */
  s0: number;
  s1: number;
  peak: number;
  billboard: boolean;
}

/* ---------------- 爆炸特效参数（视觉，不影响物理判定） ----------------
   ⚠️ 与 `ammo.ts` 里那三个（EXPLOSION_RADIUS / EXPLOSION_DV / BOMB_TRIGGER_V）
      是两回事：那三个决定「砖被推多远」，这里只决定「好不好看 / 看不看得懂」。
      改这里不需要重跑任何物理工具，也不需要同步 tools/。 */
/** 爆心闪光的寿命（秒）。短到「一帧亮起、几帧熄灭」—— 拖长就变成一团糊住目标的亮斑 */
const BLAST_CORE_LIFE = 0.18;
/** 冲击波环的寿命。比闪光长，负责把「爆炸范围」这个信息留在画面上一段时间 */
const BLAST_RING_LIFE = 0.42;
/** 闪光灯的衰减时间常数（秒）：越小闪得越急 */
const BLAST_LIGHT_TAU = 0.1;
/** 闪光灯峰值强度（物理单位，decay=2 ⇒ 2m 处照度 ≈ /4） */
const BLAST_LIGHT_PEAK = 58;
/** 粒子总数上限（含所有来源）。调高会让弱机在连击时掉帧 */
const MAX_PARTICLES = 220;

const GRAVITY = -19.6;
const MAX_SPEED = 90;
const MIN_POWER = 20;
const MAX_POWER = 60;

/* 玻璃砖：撞击速度超过阈值就当场碎裂消失。
   ⚠️ 这个阈值只判「撞击」，不判静置压力（引擎本来也不算应力）——
      所以「一排玻璃砖安静地托着一块板」永远不会自己碎。
      取值 3.0：远高于求解器安顿时的抖动（<1），又低于任何一次真实命中
      （炮弹命中 20+，高处掉下来的砖 8+，连锁碰撞也有 4~6）。
      ⚠️ 改这个数要同步 tools/check-levels.mjs 与 tools/playtest.mjs。 */
const GLASS_BREAK_V = 3.0;
const GLASS_SHARD_COLOR = ENV.glass;

/* 场上的炮弹上限。三连发一次就 +3，所以这个数不能小于单次发射的球数，
   否则会出现「刚发出去的球把刚发出去的球挤掉」。 */
const MAX_BALLS = 6;

/* 视角跨度：画面「整个宽度」对应水平转 110°，「整个高度」对应仰角 90°。
   鼠标用绝对位置映射直接套这个跨度；触控把手指位移按同一跨度换算成角度，
   因此手机与电脑的手感一致。想单独调触控手感只改 TOUCH_SENS。 */
const AIM_YAW_SPAN = 110;
const AIM_PITCH_SPAN = 90;
const TOUCH_SENS = 1.0;

const YAW_LIMIT = 60;
const PITCH_MIN = -5;
const PITCH_MAX = 75;

/* 相机机位：沿瞄准方向的「水平投影」后退 CAM_BACK，再抬到固定离地高度 CAM_HEIGHT。
   注意不能用 `cannonPos + dir * -6.5` 那种写法：dir.y = sin(pitch)，仰角越高相机
   就被推得越低——22° 时 y≈1.77，75° 时 y≈-2.08 直接钻到地面以下，同时水平距离
   从 6.5 缩到 1.68，炮身顶到镜头前把砖墙和轨迹线全部挡住。 */
const CAM_BACK = 5.5;
const CAM_HEIGHT = 3.4;

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  world: CANNON.World;
  clock = new THREE.Clock();

  bricks: Brick[] = [];
  balls: Ball[] = [];
  levelGroup = new THREE.Group();
  cannon = new THREE.Group();
  barrel = new THREE.Group();
  trajLine: THREE.Line;
  landingMark!: THREE.Mesh;
  particles: Particle[] = [];
  /** 一次性爆发特效（爆心闪光 / 冲击波环）。与 particles 分开回收，见 Blast 注释 */
  blasts: Blast[] = [];
  /** 爆炸闪光灯的当前强度倍率（0~1）。每帧指数衰减，见 step() */
  private blastPulse = 0;
  /** 弱机档：粒子减半。⚠️ 闪光灯**不**在降级项里 —— 它是这次爆炸「炸了没有」的主读点 */
  private lowFx = false;

  yaw = 0; // degrees
  pitch = 22;
  power = 40;
  showTraj = true;
  paused = false;
  /** 触控：按住正在瞄准（手指未松开） */
  aiming = false;
  /** 触控：正在瞄准的那根手指的 pointerId，null = 没在瞄准 */
  private aimPointer: number | null = null;
  private aimLast = { x: 0, y: 0 };

  levelIndex = 0;
  level!: LevelDef;
  ammo = 0;
  score = 0;
  status: 'playing' | 'won' | 'lost' = 'playing';
  stars = 0;
  /** 当前选中的弹药。**跨关卡保留** —— 挑战模式只有 1 发，选哪种就是全部 */
  ammoKind: AmmoKind = 'standard';
  /* 挑战模式：每关 1 发、一发定胜负，失败即重来。
     关内判定用关卡数据里的 challenge 规则（见 levels.ts 的 ChallengeRule）。 */
  challengeMode = false;
  comboCount = 0;
  comboUntil = 0;
  knockedCount = 0;
  colorKnocked: Record<string, number> = {};
  targetsKnocked = 0;
  targetsTotal = 0;
  shake = 0;
  keys: Record<string, boolean> = {};
  reloadTimer = 0;
  confetti = false;
  onHud: (s: HudState) => void = () => {};
  private raf = 0;
  private disposed = false;
  private scenery!: Scenery;
  private groundMat: CANNON.Material;
  private brickMat: CANNON.Material;
  private ballMat: CANNON.Material;
  private endTimer = 0;
  /* 本帧内被判定要碎的玻璃砖。⚠️ 必须排队、不能当场摘 ——
     collide 回调是在 world.step() 内部触发的，那时候求解器还握着这些 body，
     当场 removeBody 属于「在遍历中改数组」。排队到 step 之后再清算是标准做法。 */
  private shatterQueue: Brick[] = [];

  constructor(private container: HTMLElement) {
    this.lowFx = isLowPowerDevice();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 500);
    // 雾色直接取天空地平线色：两者不同值会在地平线留下一道可见接缝
    this.scene.fog = new THREE.Fog(ENV.skyHorizon, 60, 220);

    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    (this.world.solver as CANNON.GSSolver).iterations = 12;
    (this.world.solver as CANNON.GSSolver).tolerance = 0.002;
    this.world.allowSleep = true;

    this.groundMat = new CANNON.Material('ground');
    this.brickMat = new CANNON.Material('brick');
    this.ballMat = new CANNON.Material('ball');
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.groundMat, this.brickMat, { friction: 0.55, restitution: 0.08 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.brickMat, this.brickMat, { friction: 0.5, restitution: 0.05 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.ballMat, this.brickMat, { friction: 0.3, restitution: 0.25 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.ballMat, this.groundMat, { friction: 0.4, restitution: 0.35 }));

    this.buildEnvironment();
    this.buildCannon();
    this.scene.add(this.levelGroup);

    const geo = new THREE.BufferGeometry().setFromPoints(new Array(40).fill(0).map(() => new THREE.Vector3()));
    this.trajLine = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: ENV.trail, dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.9 }));
    this.scene.add(this.trajLine);

    /* 落点标记：预测轨迹的终点画一个扁八棱盘。虚线本身只有 1px 宽，在手机上几乎看不见，
       加一个「靶心」才能一眼读出炮口对准了哪里。 */
    this.landingMark = new THREE.Mesh(prismGeometry(0.85, 0.85, 0.06, 8), unlit(ENV.landing, 0.6));
    this.landingMark.visible = false;
    this.scene.add(this.landingMark);

    window.addEventListener('resize', this.onResize);
    // 统一走 Pointer Events：鼠标是「绝对位置跟随 + 点击即发射」，
    // 触控是「按住拖动旋转视角 + 松手发射」，在同一个处理函数里按 pointerType 分流。
    const el = this.renderer.domElement;
    el.style.touchAction = 'none'; // 不设的话浏览器会把拖动当成滚动/缩放，中途发 pointercancel
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
    el.addEventListener('contextmenu', this.onContextMenu);
    el.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.loadLevel(0);
    this.animate();
  }

  // ---------- environment ----------
  private buildEnvironment() {
    // 天空 / 光照 / 地面 / 云 / 远山 / 树 / 岩石 / 草丛全部由 art.ts 组装，
    // 除天空与地面外都走 InstancedMesh（整个环境约 10 次绘制调用）。
    this.scenery = buildScenery(this.scene);

    // 地面物理面仍在引擎里建：美术只管画，物理只管挡，两边互不知道对方
    const gBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: this.groundMat });
    gBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(gBody);
  }

  private buildCannon() {
    /* 低多边形炮台：与场景同源的刻面几何体（无光滑圆柱）+ 受限调色板。
       ⚠️ cannon.position.y 与 muzzle.position.z 是弹道基准，改这两个数字会让
       所有关卡的落点整体偏移、调好的关卡配平失效。造型可以换，这两处不能动。 */
    const base = new THREE.Mesh(prismGeometry(1.5, 1.8, 0.65, 8), mat(PALETTE.blue));
    base.position.y = -0.85;
    base.castShadow = true;
    base.receiveShadow = true;
    this.cannon.add(base);

    const hull = new THREE.Mesh(icoGeometry(1.15, 1), mat(PALETTE.orange));
    hull.scale.set(1.2, 0.9, 1.2);
    hull.castShadow = true;
    this.cannon.add(hull);

    for (const s of [-1, 1]) {
      const wheel = new THREE.Mesh(prismGeometry(0.7, 0.7, 0.26, 8), mat(ENV.brass));
      wheel.position.set(s * 1.42, -0.72, 0);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      this.cannon.add(wheel);

      const hub = new THREE.Mesh(prismGeometry(0.2, 0.2, 0.34, 6), mat(ENV.wood));
      hub.position.copy(wheel.position);
      hub.rotation.z = Math.PI / 2;
      this.cannon.add(hub);
    }

    // 炮管：rTop 在 +y 端、经 rotation.x = -90° 后指向 -z，所以炮口那端取更小的半径
    const tube = new THREE.Mesh(prismGeometry(0.46, 0.6, 3.2, 8), mat(PALETTE.purple));
    tube.rotation.x = -Math.PI / 2;
    tube.position.z = -1.6;
    tube.castShadow = true;
    const band = new THREE.Mesh(prismGeometry(0.54, 0.54, 0.26, 8), mat(ENV.brass));
    band.rotation.x = -Math.PI / 2;
    band.position.z = -3.05;
    band.castShadow = true;
    this.barrel.add(tube, band);
    this.cannon.add(this.barrel);
    this.cannon.position.set(0, 1.6, 0);
    this.scene.add(this.cannon);

    // 炮口闪光：材质每帧单独改 opacity，必须独占（flashMaterial 不走缓存）
    this.muzzle = new THREE.Mesh(icoGeometry(0.9, 1), flashMaterial());
    this.muzzle.position.z = -3.4;
    this.barrel.add(this.muzzle);
  }
  muzzle!: THREE.Mesh;

  // ---------- level ----------
  loadLevel(i: number) {
    this.levelIndex = Math.max(0, Math.min(LEVELS.length - 1, i));
    this.level = LEVELS[this.levelIndex];
    this.reset();
  }

  reset() {
    // clear
    for (const b of this.bricks) {
      this.world.removeBody(b.body);
      this.levelGroup.remove(b.mesh);
      // 同 removeBall：几何体与材质都是 art.ts 的共享缓存，不能在这里释放
    }
    this.bricks = [];
    // 必须迭代副本：removeBall 内部会 splice(this.balls)，
    // 直接 for...of 原数组会让迭代游标跳过一半元素，残留的球体既留在物理世界里
    // 也留在场景中（网格不再同步，变成冻结的黑球继续碰撞）。
    for (const b of [...this.balls]) this.removeBall(b);
    this.balls = [];
    // 上一关排队待碎的玻璃砖必须丢掉：它们指向的 body 马上会被 removeBody，
    // 残留下来会让新一关的计分凭空多出几块
    this.shatterQueue = [];
    // 几何体共享，只释放粒子独占的材质
    for (const p of this.particles) { this.scene.remove(p.mesh); (p.mesh.material as THREE.Material).dispose(); }
    this.particles = [];
    /* 爆发特效同理。⚠️ 换关卡时不清的话，上一关的冲击波环会「冻结」在半空
       —— 它的寿命只在 step() 里推进，而 reset() 之后它已经不在任何列表里被推进了，
       于是永远停在最后一帧的缩放上，成为一块穿帮的亮片。 */
    for (const b of this.blasts) { this.scene.remove(b.mesh); (b.mesh.material as THREE.Material).dispose(); }
    this.blasts = [];
    // 闪光灯也归零：不然在爆炸当帧按「重来」，整个新关卡会顶着一片爆亮开局
    this.blastPulse = 0;
    this.scenery.blastLight.intensity = 0;

    this.scenery.setGround(this.level.ground); // 换斑块贴图 + 草叶返青 / 变干

    // 挑战模式只给 1 发（「一发定胜负」），普通模式按关卡数据给
    this.ammo = this.challengeMode ? 1 : this.level.ammo;
    this.score = 0;
    this.status = 'playing';
    this.stars = 0;
    this.knockedCount = 0;
    this.colorKnocked = {};
    this.targetsKnocked = 0;
    this.targetsTotal = 0;
    this.comboCount = 0;
    this.confetti = false;
    this.endTimer = 0;
    this.endAim(true); // 重置时若手指还按着，先退出瞄准态，否则松手会打到新一关
    this.yaw = 0;
    this.pitch = 22;
    this.power = 40;

    for (const def of this.level.bricks) this.addBrick(def);
    this.targetsTotal = this.level.bricks.filter((b) => b.target).length;
    this.pushHud();
  }

  private addBrick(def: BrickDef) {
    const color = PALETTE[def.color];
    const isGlass = def.kind === 'glass';
    /* 手作差异：按坐标算一个确定性档位（0/1/2 → 明度 ±6%），成排的砖才不像复制粘贴。
       ⚠️ 必须确定性 —— 换成随机数的话，同一块砖每次 reset() 换关卡颜色都会变。 */
    const variant = Math.abs(Math.round((def.pos[0] + def.pos[1] * 7 + def.pos[2] * 13) * 3)) % 3;
    let geo: THREE.BufferGeometry;
    let shape: CANNON.Shape;
    let material: THREE.Material;
    if (def.shape === 'cylinder') {
      const [r, h] = def.size;
      geo = gemGeometry(r, h); // 目标宝石：八面体，剪影在小屏上也认得出
      shape = new CANNON.Cylinder(r, r, h, 12);
      material = def.target ? unlit(ENV.gem) : isGlass ? glassMaterial(color, variant) : mat(color, variant);
    } else {
      const [w, h, d] = def.size;
      geo = brickGeometry(w, h, d); // 倒角砖：相邻砖之间自然形成一道暗勾缝
      shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
      material = isGlass ? glassMaterial(color, variant) : mat(color, variant);
    }
    const mesh = new THREE.Mesh(geo, material);
    /* 玻璃砖不投影：半透明的块投出一片实心黑影子最假，而且阴影是低多边形风格里
       读「体量」的主要手段 —— 不给影子，玻璃就自然被读成「轻的、透的」。 */
    mesh.castShadow = !isGlass;
    mesh.receiveShadow = true;
    mesh.position.set(...def.pos);
    if (def.rotY) mesh.rotation.y = def.rotY;
    this.levelGroup.add(mesh);

    const body = new CANNON.Body({
      mass: def.static ? 0 : def.mass ?? 1.3,
      shape,
      material: this.brickMat,
      position: new CANNON.Vec3(...def.pos),
      allowSleep: true,
      sleepSpeedLimit: 0.25,
      sleepTimeLimit: 0.6,
      linearDamping: 0.02,
      angularDamping: 0.06,
    });
    if (def.rotY) body.quaternion.setFromEuler(0, def.rotY, 0);
    this.world.addBody(body);

    const brick: Brick = {
      mesh, body, def,
      initPos: body.position.clone(),
      initQuat: body.quaternion.clone(),
      knocked: false,
      shattered: false,
      score: def.score ?? 100,
    };
    if (!def.static) {
      body.addEventListener('collide', (e: any) => {
        const v = e.contact.getImpactVelocityAlongNormal?.() ?? 0;
        /* 玻璃先判碎：碎掉之后「响一声 + 撒一把砖色碎屑」就没意义了，
           它会走自己的碎裂表现（玻璃声 + 棱柱玻璃碴）。 */
        if (isGlass) {
          if (Math.abs(v) > GLASS_BREAK_V) {
            this.queueShatter(brick);
            return;
          }
        }
        if (Math.abs(v) > 3.5) {
          audio.play('hit', Math.min(1, Math.abs(v) / 14));
          this.spawnParticles(mesh.position, color, 5, Math.min(1, Math.abs(v) / 12));
        }
      });
    }
    this.bricks.push(brick);
  }

  // ---------- glass ----------

  /** 判定要碎的玻璃砖只入队，真正的摘除在 drainShatters()（world.step 之后） */
  private queueShatter(brick: Brick) {
    if (brick.def.static || brick.shattered) return;
    brick.shattered = true; // 先置位：同一帧里可能有多个接触点，只碎一次
    this.shatterQueue.push(brick);
  }

  private drainShatters() {
    if (!this.shatterQueue.length) return;
    const queue = this.shatterQueue;
    this.shatterQueue = [];
    for (const b of queue) {
      /* ⚠️ 位置要在这里先取走：接下来 mesh 会被摘出场景、body 会被移出世界，
         之后再读 b.mesh.position 拿到的是上一帧同步的旧值，粒子就会撒错地方
         （mesh 的位置是 step 末尾按 body 同步的，而碎裂发生在 step 中间）。 */
      const at = new THREE.Vector3(b.body.position.x, b.body.position.y, b.body.position.z);
      // 先撤物理体：这一步之后它不再提供任何支撑（这正是玻璃砖的意义）
      this.world.removeBody(b.body);
      this.levelGroup.remove(b.mesh);
      /* ⚠️ 必须从 bricks 里摘掉。留着的话 allSettled() 会一直看到这个「冻住的」
         body —— 它的速度停在碎裂那一刻，永远不为 0，于是判负/判胜的收尾条件
         永远不成立，整个关卡卡在结算前。几何体与材质是 art.ts 的共享缓存，
         不能在这里 dispose（同 removeBall 的约定）。 */
      const i = this.bricks.indexOf(b);
      if (i >= 0) this.bricks.splice(i, 1);
      this.markKnocked(b);
      this.spawnParticles(at, GLASS_SHARD_COLOR, 14, 0.9, true);
    }
    audio.play('shatter', Math.min(1, 0.55 + queue.length * 0.15));
  }

  // ---------- firing ----------
  /* 分出一个「指定水平角下的方向」的版本：三连发的两颗侧边弹要各自重算方向。
     ⚠️ 偏移必须作用在 **yaw** 上再重算整个方向向量，不能直接给 dir 的 x 分量加个数 ——
        那样只改水平分量、不改 y 分量，等于把仰角一起改了（弹道整体变平）。
     偏移为 0 时返回与原实现逐位相同的结果，所以单发弹药的手感一个像素没变。 */
  private aimDirAt(yawDeg: number) {
    const y = THREE.MathUtils.degToRad(yawDeg);
    const p = THREE.MathUtils.degToRad(this.pitch);
    return new THREE.Vector3(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  }
  get aimDir() {
    return this.aimDirAt(this.yaw);
  }
  get muzzleWorld() {
    const v = new THREE.Vector3();
    this.muzzle.getWorldPosition(v);
    return v;
  }

  fire() {
    if (this.status !== 'playing' || this.paused || this.ammo <= 0 || this.reloadTimer > 0) return;
    // 一次发射 = 消耗 1 发弹药，与它打出几颗球无关（三连发也是一发）
    this.ammo--;
    this.reloadTimer = 0.45;
    audio.play('fire');
    this.shake = 0.35;

    const def = AMMO[this.ammoKind];
    const n = def.count;
    for (let i = 0; i < n; i++) {
      // 多发时按 spread 左右对称铺开：3 颗 → −spread / 0 / +spread
      const off = n > 1 ? (i - (n - 1) / 2) * (def.spread ?? 0) : 0;
      this.spawnBall(off === 0 ? this.aimDir : this.aimDirAt(this.yaw + off), def);
    }
    // 超出上限就回收最老的球（用 while 不用 if：三连发一次可能顶掉多颗）
    while (this.balls.length > MAX_BALLS) this.removeBall(this.balls[0]);

    // muzzle flash + smoke
    const start = this.muzzleWorld.clone().add(this.aimDir.clone().multiplyScalar(0.6));
    (this.muzzle.material as THREE.MeshBasicMaterial).opacity = 1;
    this.spawnParticles(start, FX.muzzle, 16, 1.2);
    this.pushHud();
  }

  /** 生成一颗炮弹。半径 / 质量 / 初速倍率全部从弹药表读（见 ammo.ts） */
  private spawnBall(dir: THREE.Vector3, def: AmmoDef) {
    const start = this.muzzleWorld.clone().add(dir.clone().multiplyScalar(0.6));
    const r = def.radius;
    const mesh = new THREE.Mesh(icoGeometry(r, 1), mat(def.color));
    mesh.castShadow = true;
    this.scene.add(mesh);
    const body = new CANNON.Body({
      mass: def.mass,
      shape: new CANNON.Sphere(r),
      material: this.ballMat,
      position: new CANNON.Vec3(start.x, start.y, start.z),
      linearDamping: 0.005,
    });
    (body as any).ccdSpeedThreshold = 8;
    (body as any).ccdIterations = 6;
    const speed = this.power * def.powerScale;
    body.velocity.set(dir.x * speed, dir.y * speed, dir.z * speed);

    const tGeo = new THREE.BufferGeometry().setFromPoints(new Array(24).fill(0).map(() => start.clone()));
    const trail = new THREE.Points(tGeo, trailMaterial());
    this.scene.add(trail);
    const ball: Ball = {
      mesh, body, born: performance.now(), trail,
      trailPts: new Array(24).fill(0).map(() => start.clone()),
      ammo: def.kind, detonate: false,
    };

    body.addEventListener('collide', (e: any) => {
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal?.() ?? 0);
      if (v > 4) {
        this.shake = Math.min(0.5, this.shake + v / 90);
        this.spawnParticles(mesh.position, FX.spark, 12, 1);
        audio.play('thud');
      }
      /* 爆破筒：命中当帧引爆。回调里**只置一个标记** —— 真正的爆炸必须在
         world.step() 之后做，见 explode()。阈值用来放过纯擦碰（法向速度近零的
         浅擦），否则球贴着平台滑一下也会炸。 */
      if (def.kind === 'bomb' && !ball.detonate && v > BOMB_TRIGGER_V) ball.detonate = true;
    });
    this.world.addBody(body);
    this.balls.push(ball);
  }

  /* 爆破筒爆炸。⚠️ 只能在 world.step() 之后调用（当前唯一调用点是 step() 里的
     炮弹清理段）。它要改一堆刚体的速度 —— 如果在 collide 回调里做，就是在求解器
     正遍历接触对的时候改速度，与玻璃碎裂是同一条纪律：回调里只记数据，
     step 之后再动世界。 */
  private explode(at: THREE.Vector3) {
    const R = EXPLOSION_RADIUS;
    for (const b of this.bricks) {
      if (b.def.static) continue;
      const p = b.body.position;
      const dx = p.x - at.x;
      const dy = p.y - at.y;
      const dz = p.z - at.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > R) continue;
      const dv = EXPLOSION_DV * (1 - d / R); // 边缘衰减到 0
      const len = Math.max(0.001, d);
      /* 按「速度增量」施加，而不是写死冲量：冲量的实际效果是 impulse / mass，
         而砖块质量各不相同（1.0 ~ 1.8），写死冲量会让轻砖飞上天、重砖纹丝不动。
         竖直方向额外抬一点，让砖「被掀翻」而不是「被推平」。 */
      const k = dv * b.body.mass;
      b.body.applyImpulse(new CANNON.Vec3((dx / len) * k, (dy / len) * 0.6 * k + 0.5 * k, (dz / len) * k));
      /* 玻璃砖：爆炸给的速度增量远超碎裂阈值 ⇒ 直接判碎。
         必须显式判，不能指望它们「炸飞之后撞到别的东西再碎」—— 悬空的玻璃砖
         被炸开之后只会飞出去，永远等不到那次碰撞。 */
      if (b.def.kind === 'glass' && dv > GLASS_BREAK_V) this.queueShatter(b);
    }

    /* ---------------- 以下是纯表现，一行都不影响上面算出来的物理 ----------------
       三种东西叠出「一声巨响」而不是「一堆橙点」，各自负责一个读图任务：
         · 闪光灯 —— 把周围的砖「照白」。这是最重要的一层：加性几何体只能亮自己，
           而借来的光会把整个结构打亮，玩家一眼就知道「刚才那一下有多近」。
         · 火星（快、小、多、暖）—— 负责「速度感 / 爆开」
         · 碎块（慢一点、大、石色）—— 负责「有实体被崩下来了」
         · 尘埃（上浮、变大、半透明灰）—— 负责「体积 / 后劲」，把画面从「一瞬间」
           拉长成「一阵子」，也是让爆炸不至于在 0.2s 内被忘掉的那一层。
       数值都在顶部常量与 emit 的实参里，弱机档只减数量（见 lowFx）。 */
    const n = this.lowFx;
    this.blastPulse = 1;
    this.scenery.blastLight.position.copy(at);
    this.spawnBlastFx(at);

    this.emit(at, {
      n: n ? 16 : 28,
      color: FX.ember,
      geo: icoGeometry(0.1, 0),
      power: 2.5,          // 火星要「射出去」，初速是碎屑的两倍量级
      gravity: 0.5,
      lifeMin: 0.3,
      lifeMax: 0.7,
      peak: 1,
      fadePow: 1.5,        // 先亮住、末尾才骤然熄 —— 线性淡出会显得软
      sizeJitter: 0.45,
      spin: 14,
    });
    this.emit(at, {
      n: n ? 8 : 16,
      color: ENV.rock,     // 用环境石色而不是砖色：碎片是「崩出来的土石」，不是目标砖
      geo: icoGeometry(0.26, 0),
      power: 1.5,
      gravity: 0.62,
      lifeMin: 0.5,
      lifeMax: 1.0,
      sizeJitter: 0.5,
      spin: 9,
    });
    this.emit(at, {
      n: n ? 7 : 14,
      color: FX.smoke,
      geo: dustGeometry(),
      power: 0.45,         // 慢慢滚出去，不是「射」出去
      gravity: -0.14,      // 负重力 = 上浮。尘埃是热的，会往上顶
      grow: 1.7,           // 一生里胀到约 2.7 倍，才像一团体积
      peak: 0.5,           // ⚠️ 峰值只到 0.5：尘埃再浓就会盖住后面的砖，
                           //    而「砖到底飞没飞」是这个游戏唯一必须看清的东西
      fadePow: 1.3,
      lifeMin: 0.9,
      lifeMax: 1.6,
      speedJitter: 3.2,
      upBias: 2.4,
      spin: 3,
      spinDamp: 0.9,       // 尘埃团自旋要很快停住，转着圈的烟最假
    });

    // 相机震动：从 0.55 提到 0.8。这是「重量」最便宜的来源，但**不能更大了** ——
    // 再往上就会让玩家在读结果的那一刻看不清落点。
    this.shake = Math.min(0.95, this.shake + 0.8);
    audio.play('boom', 1);
    // 塌方声延后 130ms 进来：先「炸」，后「塌」，才有前因后果
    setTimeout(() => audio.play('collapse'), 130);
  }

  private removeBall(b: Ball) {
    this.world.removeBody(b.body);
    this.scene.remove(b.mesh);
    this.scene.remove(b.trail);
    /* ⚠️ 不要释放 b.mesh.geometry —— 艺术几何体是 art.ts 的共享缓存，在这里单方面
       dispose 会把其它炮弹与砖块正在用的同一份几何体一起弄坏（表现为整场物体消失）。
       统一在 disposeArt() 收口。尾迹几何体是每颗炮弹独占的，必须释放。 */
    b.trail.geometry.dispose();
    const i = this.balls.indexOf(b);
    if (i >= 0) this.balls.splice(i, 1);
  }

  /**
   * 真正往 `particles` 里放一颗的地方。**只有这里构造 Particle** ——
   * 字段补全与默认值只写一遍，新增字段时不会漏掉某条发射路径（漏了就是 NaN 缩放 / 永不过期）。
   */
  private addParticle(
    mesh: THREE.Mesh,
    vel: THREE.Vector3,
    opt: { max?: number; spin?: THREE.Vector3; gravity?: number; grow?: number; peak?: number; fadePow?: number; spinDamp?: number } = {},
  ) {
    this.particles.push({
      mesh,
      vel,
      life: 0,
      max: opt.max ?? 1,
      spin: opt.spin ?? new THREE.Vector3(),
      gravity: opt.gravity ?? 0.35,
      grow: opt.grow ?? 0,
      peak: opt.peak ?? 1,
      fadePow: opt.fadePow ?? 1,
      spinDamp: opt.spinDamp ?? 0,
    });
  }

  /**
   * 发射一批粒子 —— 撞击碎屑 / 玻璃碴 / 火星 / 尘埃**共用这一条路径**。
   * 默认值刻意等于「老版本撞击碎屑」的行为（重力 0.35、不长大、线性淡出），
   * 所以老调用点换过来之后表现一模一样。
   */
  private emit(pos: THREE.Vector3 | CANNON.Vec3, spec: ParticleSpec) {
    if (this.particles.length > MAX_PARTICLES) return;
    const {
      n, color, geo,
      power = 1,
      gravity = 0.35,
      grow = 0,
      peak = 1,
      fadePow = 1,
      sizeJitter = 0,
      lifeMin = 0.6,
      lifeMax = 1.2,
      speedJitter = 8,
      upBias = 6,
      spin = 8,
      spinDamp = 0,
    } = spec;
    // 几何体共享（art.ts 缓存），材质必须独占：每颗粒子逐帧改自己的 opacity
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, fadeMaterial(color));
      m.position.set(pos.x, pos.y, pos.z);
      if (sizeJitter) m.scale.setScalar(1 - sizeJitter * Math.random());
      this.scene.add(m);
      this.addParticle(
        m,
        new THREE.Vector3(
          (Math.random() - 0.5) * speedJitter,
          Math.random() * upBias,
          (Math.random() - 0.5) * speedJitter,
        ).multiplyScalar(power),
        {
          max: lifeMin + Math.random() * (lifeMax - lifeMin),
          spin: new THREE.Vector3(Math.random() * spin, Math.random() * spin, Math.random() * spin),
          gravity,
          grow,
          peak,
          fadePow,
          spinDamp,
        },
      );
    }
  }

  /** 兼容壳①：撞击碎屑 / 玻璃碴。参数语义与旧实现完全一致，少了就少调一处 */
  private spawnParticles(pos: THREE.Vector3 | CANNON.Vec3, color: number, n: number, power = 1, shard = false) {
    this.emit(pos, { n, color, power, geo: shard ? shardGeometry() : icoGeometry(0.12, 0) });
  }

  /**
   * 爆发特效：爆心闪光 + 冲击波环。
   *
   * 两个对象的分工（这是「爆炸看起来是一声巨响，而不是一堆橙点」的关键）：
   *   · **闪光**（`billboard = false`）—— 贴在爆心的加性球，0.16s 内从 0.15R 胀到 0.6R。
   *     刻意**比判定半径小得多**：它的活是「那一下亮」，不是「告诉你炸到哪」。
   *     胀满也只有 ~2m，不会把炸飞的砖糊住 —— 玩家必须看得见「砖到底飞了没有」。
   *   · **环**（`billboard = true`）—— 0.36s 内从 0.25R 胀到 **正好 1.0R**。
   *     半径刻意对齐 `EXPLOSION_RADIUS`：玩家看几次就能学会「这个圈里都会被掀飞」，
   *     这是本次改动顺带解决的一件事 —— 原版 3.4m 的判定半径在画面上完全不可见。
   *     转向相机是必须的：环是平面物，近水平机位下不转向就会被压成一条线。
   */
  private spawnBlastFx(at: THREE.Vector3) {
    const R = EXPLOSION_RADIUS;
    /* 上限兜底：三连发 + 玻璃连环碎理论上可能在同一帧凑出好几次爆炸。
       超了就只保留最早的两个 —— 不设上限的话弱机上会瞬间多出几十个加性叠层。 */
    while (this.blasts.length > 5) {
      const old = this.blasts.shift()!;
      this.scene.remove(old.mesh);
      (old.mesh.material as THREE.Material).dispose();
    }
    const push = (mesh: THREE.Mesh, s0: number, s1: number, max: number, peak: number, billboard: boolean) => {
      mesh.position.copy(at);
      mesh.scale.setScalar(s0);
      this.scene.add(mesh);
      this.blasts.push({ mesh, life: 0, max, s0, s1, peak, billboard });
    };
    /* 爆心闪光：detail 1 才有「一团」的球感（detail 0 的二十面体棱角太利）。
       ⚠️ 终态半径刻意压在 0.68R（≈2.3m）**而不是铺满判定半径**：它是加性的不透明亮块，
          铺满就正好把「砖到底被炸飞了没有」这个唯一必须看清的信息盖住。
          真正负责「亮」的是闪光灯 —— 借来的光是照在砖上、不遮砖的。 */
    push(new THREE.Mesh(icoGeometry(1, 1), blastMaterial(FX.core)), R * 0.18, R * 0.68, BLAST_CORE_LIFE, 1, false);
    push(new THREE.Mesh(ringGeometry(), blastMaterial(FX.ring)), R * 0.22, R, BLAST_RING_LIFE, 1, true);
  }

  private spawnConfetti() {
    const cols = [PALETTE.red, PALETTE.yellow, PALETTE.blue, PALETTE.green, PALETTE.purple, PALETTE.orange];
    const base = this.camera.position.clone().add(this.aimDir.clone().multiplyScalar(14));
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(brickGeometry(0.32, 0.32, 0.05), fadeMaterial(cols[i % 6]));
      m.position.set(base.x + (Math.random() - 0.5) * 24, base.y + 12 + Math.random() * 8, base.z + (Math.random() - 0.5) * 10);
      this.scene.add(m);
      this.addParticle(m, new THREE.Vector3((Math.random() - 0.5) * 4, -2 - Math.random() * 2, (Math.random() - 0.5) * 4), {
        max: 3.5,
        spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10),
      });
    }
  }

  // ---------- scoring ----------

  /**
   * 记一次「砖没了」——被撞倒的普通砖与碎掉的玻璃砖走同一条路，只算一次。
   * 表现层（碎屑 / 音效）由调用方负责：两者要放的东西不一样。
   */
  private markKnocked(b: Brick) {
    if (b.knocked) return;
    b.knocked = true;
    this.knockedCount++;
    this.colorKnocked[b.def.color] = (this.colorKnocked[b.def.color] || 0) + 1;
    if (b.def.target) this.targetsKnocked++;
    const now = performance.now();
    if (now < this.comboUntil) this.comboCount++;
    else this.comboCount = 1;
    this.comboUntil = now + 1600;
    const bonus = this.comboCount > 1 ? Math.round(b.score * 0.25 * (this.comboCount - 1)) : 0;
    this.score += b.score + bonus;
    if (this.comboCount === 5) audio.play('collapse');
  }

  private checkKnocked() {
    for (const b of this.bricks) {
      if (b.knocked || b.def.static) continue;
      const dist = b.body.position.distanceTo(b.initPos);
      const up = new CANNON.Vec3(0, 1, 0);
      const cur = b.body.quaternion.vmult(up, new CANNON.Vec3());
      const tilt = Math.acos(Math.max(-1, Math.min(1, cur.dot(up)))) * (180 / Math.PI);
      if (dist > 1.2 || tilt > 38) {
        this.markKnocked(b);
        this.spawnParticles(b.mesh.position, PALETTE[b.def.color], 6, 0.8);
      }
    }
  }

  private objectiveDone(): boolean {
    const o = this.level.objective;
    switch (o.kind) {
      case 'knockCount': return this.knockedCount >= (o.count ?? 0);
      case 'knockAll': return this.bricks.filter((b) => !b.def.static).every((b) => b.knocked);
      case 'color': return (this.colorKnocked[o.color!] || 0) >= (o.count ?? 1);
      case 'targets': return this.targetsTotal > 0 && this.targetsKnocked >= this.targetsTotal;
      case 'score': return this.score >= this.level.targetScore;
    }
  }

  /** 挑战模式的积分判定线。0 = 本关用「一发完成目标」判定，不显示分数进度 */
  private challengeLine(): number {
    if (!this.challengeMode) return 0;
    const r = this.level.challenge;
    return r?.judge === 'score' ? r.scoreLine ?? 0 : 0;
  }

  /**
   * 挑战模式的通关判定（与普通模式分开，见 levels.ts 的 ChallengeRule）。
   * · 积分模式：一发得分达到线 **或** 直接完成了目标 —— 后半句留着，是因为
   *   万一玩家真用一发完成了那个「形态上很难完成」的目标，没有理由不算他通过。
   * · 完成模式：与普通模式同一判据（一发达成关卡目标）。
   */
  private challengeWon(): boolean {
    const line = this.challengeLine();
    const done = !!this.objectiveDone();
    return line > 0 ? this.score >= line || done : done;
  }

  objectiveProgress(): string {
    const line = this.challengeLine();
    if (line > 0) return `${Math.min(this.score, line)} / ${line}`;
    const o = this.level.objective;
    switch (o.kind) {
      case 'knockCount': return `${Math.min(this.knockedCount, o.count!)} / ${o.count}`;
      case 'color': return `${Math.min(this.colorKnocked[o.color!] || 0, o.count!)} / ${o.count}`;
      case 'targets': return `${this.targetsKnocked} / ${this.targetsTotal}`;
      case 'knockAll': return `${this.knockedCount} / ${this.bricks.filter((b) => !b.def.static).length}`;
      default: return `${this.score} / ${this.level.targetScore}`;
    }
  }

  private allSettled() {
    if (this.balls.length > 0) return false;
    return this.bricks.every((b) => b.def.static || b.body.sleepState === CANNON.Body.SLEEPING || b.body.velocity.length() < 0.6);
  }

  private evaluate(dt: number) {
    if (this.status !== 'playing') return;
    /* 挑战模式换一套判据：普通模式看「目标达成」，挑战模式还要看积分线
       （judge: 'score' 的关卡目标本身一发不可能完成，见 levels.ts）。 */
    const done = this.challengeMode ? this.challengeWon() : this.objectiveDone();
    if (done) {
      // small delay to let physics finish
      this.endTimer += dt;
      if (this.endTimer > 1.2 && this.allSettled()) this.finish(true);
      return;
    }
    this.endTimer = 0;
    if (this.ammo <= 0 && this.allSettled()) {
      this.endTimer += dt;
      this.finish(false);
    }
  }

  private finish(won: boolean) {
    this.status = won ? 'won' : 'lost';
    if (won) {
      if (this.challengeMode) {
        /* 挑战模式**不写普通星级**：它是独立的一套判定，与「⭐ / ⭐⭐ / ⭐⭐⭐」
           互不干扰（决策：挑战模式单独走自己那套）。UI 读到
           `status === 'won' && challenge` 就会把这一关记进挑战进度。
           也不加「剩余弹药 × 200」奖励 —— 挑战模式打完必然是 0 发。 */
        this.stars = 0;
      } else {
        const ammoBonus = this.ammo * 200;
        this.score += ammoBonus;
        let s = 1;
        if (this.ammo >= this.level.twoStarAmmoLeft) s = 2;
        if (this.score >= this.level.targetScore && this.ammo >= this.level.twoStarAmmoLeft) s = 3;
        this.stars = s;
      }
      this.spawnConfetti();
      audio.play('win');
    } else {
      this.stars = 0;
      audio.play('lose');
    }
    this.pushHud();
  }

  // ---------- input ----------

  /** 现在这一刻允许开炮吗（触控按住前会先问一次，避免按住半天松手是空响） */
  private canFire() {
    return this.status === 'playing' && !this.paused && this.ammo > 0 && this.reloadTimer <= 0;
  }

  private setAim(pointerId: number, on: boolean) {
    this.aimPointer = on ? pointerId : null;
    this.aiming = on;
  }

  /** 松开/作废当前瞄准（在重置关卡、组件卸载时调用，避免状态卡住） */
  private endAim(release: boolean) {
    const id = this.aimPointer;
    if (id === null) {
      this.aiming = false;
      return;
    }
    if (release) {
      try {
        this.renderer.domElement.releasePointerCapture(id);
      } catch {
        /* 指针已消失时 release 会抛错，忽略 */
      }
    }
    this.setAim(id, false);
  }

  private onResize = () => {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private onPointerDown = (e: PointerEvent) => {
    audio.init();
    // 只认直接落在 canvas 上的按下：点 HUD 面板（暂停/重开/滑杆）不该发射
    if (e.target !== this.renderer.domElement) return;

    if (e.pointerType === 'touch') {
      // 阻止本次触摸派生出兼容的 mouse 事件，也顺手挡掉默认手势
      e.preventDefault();
      if (this.aimPointer !== null) return; // 已有一根手指在瞄准，忽略后续手指
      if (!this.canFire()) return; // 打光了/装填中就别进瞄准态，免得白按
      this.setAim(e.pointerId, true);
      this.aimLast.x = e.clientX;
      this.aimLast.y = e.clientY;
      // 手指可能滑出画面再松开，捕获指针才能保证收到 pointerup
      try {
        this.renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }

    // 鼠标 / 触控笔：保持原来的「点击即发射」
    if (e.button === 0) this.fire();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.paused || this.status !== 'playing') return;
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return;

    if (e.pointerType === 'touch') {
      if (e.pointerId !== this.aimPointer) return;
      e.preventDefault();
      const dx = e.clientX - this.aimLast.x;
      const dy = e.clientY - this.aimLast.y;
      this.aimLast.x = e.clientX;
      this.aimLast.y = e.clientY;
      // 用「相对位移」而不是「手指所在位置」，这样按下的一瞬间视角不会突然跳过去。
      // 方向：手指右滑 → 视角右转；手指上滑 → 抬高炮口（与鼠标方向一致）。
      const yawPerPx = (AIM_YAW_SPAN / r.width) * TOUCH_SENS;
      const pitchPerPx = (AIM_PITCH_SPAN / r.height) * TOUCH_SENS;
      this.yaw = THREE.MathUtils.clamp(this.yaw - dx * yawPerPx, -YAW_LIMIT, YAW_LIMIT);
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * pitchPerPx, PITCH_MIN, PITCH_MAX);
      return;
    }

    // 鼠标 / 触控笔：绝对位置映射（原有手感不变）
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    this.yaw = THREE.MathUtils.clamp(-nx * AIM_YAW_SPAN, -YAW_LIMIT, YAW_LIMIT);
    this.pitch = THREE.MathUtils.clamp(-ny * AIM_PITCH_SPAN + 20, PITCH_MIN, PITCH_MAX);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || e.pointerId !== this.aimPointer) return;
    e.preventDefault();
    this.endAim(true);
    this.fire(); // 松手开炮
  };

  /** 系统吞掉了这根手指（来电、系统手势、切换 App）——只退出瞄准，不发射 */
  private onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== this.aimPointer) return;
    this.endAim(false);
  };

  /** 长按不要弹右键菜单（触屏上按住瞄准时很容易触发） */
  private onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  private onWheel = (e: WheelEvent) => {
    this.power = THREE.MathUtils.clamp(this.power - Math.sign(e.deltaY) * 1.5, MIN_POWER, MAX_POWER);
  };
  private onKeyDown = (e: KeyboardEvent) => {
    this.keys[e.key.toLowerCase()] = true;
    const k = e.key.toLowerCase();
    if (k === 'r') this.reset();
    if (k === ' ') { e.preventDefault(); this.fire(); }
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys[e.key.toLowerCase()] = false; };

  // ---------- loop ----------
  private updateTrajectory() {
    const on = this.showTraj && this.status === 'playing' && !this.paused;
    this.trajLine.visible = on;
    this.landingMark.visible = on;
    if (!on) return;
    const pts: THREE.Vector3[] = [];
    const p = this.muzzleWorld.clone();
    const v = this.aimDir.clone().multiplyScalar(this.power);
    const dt = 0.055;
    for (let i = 0; i < 40; i++) {
      pts.push(p.clone());
      v.y += GRAVITY * dt;
      p.addScaledVector(v, dt);
      if (p.y < 0.1) break;
    }
    this.trajLine.geometry.setFromPoints(pts);
    this.trajLine.computeLineDistances();
    // 落点标记贴在预测终点；y 钳到地面之上，否则与地面共面会 z-fighting 闪烁
    const last = pts[pts.length - 1];
    this.landingMark.position.set(last.x, Math.max(0.06, last.y), last.z);
  }

  private animate = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (!this.paused) this.step(dt);
    this.render();
  };

  private step(dt: number) {
    // keyboard aim
    if (this.status === 'playing') {
      const s = 55 * dt;
      if (this.keys['a']) this.yaw = THREE.MathUtils.clamp(this.yaw + s, -YAW_LIMIT, YAW_LIMIT);
      if (this.keys['d']) this.yaw = THREE.MathUtils.clamp(this.yaw - s, -YAW_LIMIT, YAW_LIMIT);
      if (this.keys['w']) this.pitch = THREE.MathUtils.clamp(this.pitch + s, PITCH_MIN, PITCH_MAX);
      if (this.keys['s']) this.pitch = THREE.MathUtils.clamp(this.pitch - s, PITCH_MIN, PITCH_MAX);
      if (this.keys['e']) this.power = THREE.MathUtils.clamp(this.power + 20 * dt, MIN_POWER, MAX_POWER);
      if (this.keys['q']) this.power = THREE.MathUtils.clamp(this.power - 20 * dt, MIN_POWER, MAX_POWER);
    }
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0 && this.ammo > 0) audio.play('load');
    }

    this.world.step(1 / 60, dt, 4);
    /* 碎裂必须在 step 之后立刻清算：一是求解器已经放手了这些 body，
       二是后面这段同步循环要按最新的 bricks 列表来跑（碎掉的砖已被摘走）。 */
    this.drainShatters();

    // clamp velocity + sync
    for (const b of this.bricks) {
      const v = b.body.velocity;
      const sp = v.length();
      if (sp > MAX_SPEED) v.scale(MAX_SPEED / sp, v);
      const av = b.body.angularVelocity;
      if (av.length() > 22) av.scale(22 / av.length(), av);
      b.mesh.position.set(b.body.position.x, b.body.position.y, b.body.position.z);
      b.mesh.quaternion.set(b.body.quaternion.x, b.body.quaternion.y, b.body.quaternion.z, b.body.quaternion.w);
      if (b.body.position.y < -30) { b.body.sleep(); }
    }

    // balls
    const now = performance.now();
    for (const b of [...this.balls]) {
      b.mesh.position.set(b.body.position.x, b.body.position.y, b.body.position.z);
      b.trailPts.pop();
      b.trailPts.unshift(b.mesh.position.clone());
      b.trail.geometry.setFromPoints(b.trailPts);
      /* 爆破筒接触引爆：命中那一帧在 collide 回调里置了 detonate，这里兑现。
         放在 world.step() **之后**是硬要求 —— explode() 要一次改一堆刚体的
         速度，在回调里做等于在求解器遍历接触对的时候改世界。
         removeBall 也在这一步做 —— 它同样会改 this.balls，而当前遍历的是副本，
         不会漏掉后面的球。 */
      if (b.detonate) {
        this.explode(b.mesh.position.clone());
        this.removeBall(b);
        continue;
      }
      const p = b.body.position;
      if (now - b.born > 9000 || p.y < -20 || Math.abs(p.x) > 120 || Math.abs(p.z) > 160 || p.z > 20) this.removeBall(b);
    }
    /* 爆炸刚刚可能把玻璃砖判碎（queueShatter）。再清一次队列，让这一步之后的
       checkKnocked() 看到的是最新的 bricks 列表 —— 否则同一块砖会先被普通击倒
       逻辑记一次账、撒一把砖色碎屑，下一帧碎裂时再撒一把玻璃碴。 */
    this.drainShatters();

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      p.vel.y += GRAVITY * p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      if (p.spinDamp) p.spin.multiplyScalar(Math.max(0, 1 - p.spinDamp * dt));
      /* 长大只在需要时做：绝大多数碎屑 `grow = 0`，每帧 setScalar 是白白的
         matrix 失效（会连带重算矩阵）。 */
      if (p.grow) p.mesh.scale.setScalar(1 + p.grow * p.life);
      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      mat.transparent = true;
      /* 淡出曲线：`fadePow` 1 = 线性（老行为），>1 = 先亮住再骤灭。
         火星用 1.5 是为了「亮一下」，尘埃用 1.3 是为了「一直在、最后化开」。 */
      mat.opacity = p.peak * Math.pow(Math.max(0, 1 - p.life / p.max), p.fadePow);
      if (p.life > p.max) {
        this.scene.remove(p.mesh);
        // 几何体共享（art.ts 缓存），只释放粒子独占的材质
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }

    /* 爆发特效（爆心闪光 / 冲击波环）：放大 + 淡出。缓出曲线让「扩张」一开始最猛，
       末尾慢慢停 —— 匀速放大的环看起来像在飘，不像在冲。 */
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.life += dt;
      const k = Math.min(1, b.life / b.max);
      const ease = 1 - Math.pow(1 - k, 2.6);
      b.mesh.scale.setScalar(b.s0 + (b.s1 - b.s0) * ease);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = b.peak * Math.pow(1 - k, 1.6);
      /* 转向相机。用 `camera.quaternion` 直接拷（而不是 lookAt）——
         lookAt 会在相机恰好在正上方/正下方时退化，而这里只关心「面片朝镜头」。 */
      if (b.billboard) b.mesh.quaternion.copy(this.camera.quaternion);
      if (b.life >= b.max) {
        this.scene.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        this.blasts.splice(i, 1);
      }
    }

    /* 爆炸闪光灯的衰减。用**指数衰减**而不是线性：线性衰减的尾段是「可见的暗下去」，
       指数衰减在人眼里更像「亮了一下就没了」。判定它是否已经暗到可以关掉，
       避免每帧给一个 0 强度的灯做无用功。 */
    if (this.blastPulse > 0) {
      this.blastPulse *= Math.exp(-dt / BLAST_LIGHT_TAU);
      if (this.blastPulse < 0.01) this.blastPulse = 0;
      this.scenery.blastLight.intensity = this.blastPulse * BLAST_LIGHT_PEAK;
    }

    const mm = this.muzzle.material as THREE.MeshBasicMaterial;
    if (mm.opacity > 0) mm.opacity = Math.max(0, mm.opacity - dt * 5);

    this.checkKnocked();
    this.evaluate(dt);
    this.updateTrajectory();
    this.pushHud();
  }

  private render() {
    // cannon orientation
    this.cannon.rotation.y = THREE.MathUtils.degToRad(this.yaw);
    // 符号必须是正号：barrel 的局部朝向是 -z，绕 +x 转 +pitch 才会把炮口抬起来
    // （aimDir 的 y 分量是 +sin(pitch)）。原先写 -pitch，炮管视觉朝下而炮弹朝上飞，
    // 两者相差 2×pitch（默认 22° 时差 44°），炮口也画在贴地的位置。
    this.barrel.rotation.x = THREE.MathUtils.degToRad(this.pitch);

    // third-person camera behind cannon: back off horizontally, then sit at a fixed height.
    // （旧写法是 addScaledVector(dir, -6.5)：dir 带 sin(pitch)，仰角越高相机越低，
    //   默认 22° 就会让炮身挡住砖墙和轨迹线，见 CAM_BACK 处的注释。）
    const dir = this.aimDir;
    const back = new THREE.Vector3(dir.x, 0, dir.z);
    if (back.lengthSq() < 1e-6) back.set(0, 0, -1); // 垂直向上瞄准时水平分量退化，兜个底
    back.normalize();
    const camPos = this.cannon.position.clone().addScaledVector(back, -CAM_BACK).add(new THREE.Vector3(0, CAM_HEIGHT, 0));
    this.camera.position.lerp(camPos, 0.25);
    const look = this.cannon.position.clone().addScaledVector(dir, 18);
    this.camera.lookAt(look);
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= 0.86;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private pushHud() {
    this.onHud({
      level: this.levelIndex + 1,
      objectiveProgress: this.objectiveProgress(),
      ammo: this.ammo,
      maxAmmo: this.challengeMode ? 1 : this.level.ammo,
      score: this.score,
      targetScore: this.level.targetScore,
      yaw: Math.round(this.yaw),
      pitch: Math.round(this.pitch),
      power: Math.round(((this.power - MIN_POWER) / (MAX_POWER - MIN_POWER)) * 100),
      stars: this.stars,
      status: this.status,
      combo: performance.now() < this.comboUntil ? this.comboCount : 0,
      aiming: this.aiming,
      ammoKind: this.ammoKind,
      challenge: this.challengeMode,
      challengeLine: this.challengeLine(),
    });
  }

  setPower(pct: number) {
    this.power = MIN_POWER + (MAX_POWER - MIN_POWER) * (pct / 100);
  }

  /** 切换弹药。跨关卡保留，也不消耗弹药 —— 它是「选打法」，不是「用道具」 */
  setAmmoKind(k: AmmoKind) {
    if (this.ammoKind === k) return;
    this.ammoKind = k;
    audio.play('click');
    this.pushHud();
  }

  cycleAmmo() {
    this.setAmmoKind(AMMO_ORDER[(ammoIndex(this.ammoKind) + 1) % AMMO_ORDER.length]);
  }

  /**
   * 挑战模式开关。⚠️ 它会 **reset() 重开本关** —— 弹药数从 5~6 变成 1，
   * 中途改会让「已经打掉几发」失去意义。切换模式 = 重新开始，语义最干净，
   * 也不会留下「一半普通模式、一半挑战模式」的状态。
   */
  setChallenge(on: boolean) {
    if (this.challengeMode === on) return;
    this.challengeMode = on;
    this.reset();
  }

  nextLevel() {
    if (this.levelIndex < LEVELS.length - 1) this.loadLevel(this.levelIndex + 1);
    else this.loadLevel(0);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    const el = this.renderer.domElement;
    this.endAim(true); // 若正按住瞄准，先释放指针捕获
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerCancel);
    el.removeEventListener('contextmenu', this.onContextMenu);
    el.removeEventListener('wheel', this.onWheel);
    // 粒子与爆发特效的材质都是**独占**的（逐帧改 opacity），必须在这里释放。
    // 几何体是 art.ts 的共享缓存，交给下面的 disposeArt() 收口。
    for (const p of this.particles) { this.scene.remove(p.mesh); (p.mesh.material as THREE.Material).dispose(); }
    this.particles = [];
    for (const b of this.blasts) { this.scene.remove(b.mesh); (b.mesh.material as THREE.Material).dispose(); }
    this.blasts = [];
    disposeArt(); // 收口 art.ts 的共享材质 / 几何体 / 贴图缓存
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}

export const LEVEL_COUNT = LEVELS.length;
