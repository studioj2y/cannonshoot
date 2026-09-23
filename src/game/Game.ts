import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { audio } from './audio';
import { LEVELS, type BrickDef, type LevelDef } from './levels';
import {
  ENV,
  PALETTE,
  mat,
  unlit,
  fadeMaterial,
  trailMaterial,
  flashMaterial,
  brickGeometry,
  gemGeometry,
  icoGeometry,
  prismGeometry,
  buildScenery,
  disposeArt,
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
}

interface Brick {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  def: BrickDef;
  initPos: CANNON.Vec3;
  initQuat: CANNON.Quaternion;
  knocked: boolean;
  score: number;
}

interface Ball {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  born: number;
  trail: THREE.Points;
  trailPts: THREE.Vector3[];
}

const GRAVITY = -19.6;
const MAX_SPEED = 90;
const MIN_POWER = 20;
const MAX_POWER = 60;

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
  particles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; max: number; spin: THREE.Vector3 }[] = [];

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

  constructor(private container: HTMLElement) {
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
    // 几何体共享，只释放粒子独占的材质
    for (const p of this.particles) { this.scene.remove(p.mesh); (p.mesh.material as THREE.Material).dispose(); }
    this.particles = [];

    this.scenery.setGround(this.level.ground); // 换斑块贴图 + 草叶返青 / 变干

    this.ammo = this.level.ammo;
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
      material = def.target ? unlit(ENV.gem) : mat(color, variant);
    } else {
      const [w, h, d] = def.size;
      geo = brickGeometry(w, h, d); // 倒角砖：相邻砖之间自然形成一道暗勾缝
      shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
      material = mat(color, variant);
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
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
      score: def.score ?? 100,
    };
    if (!def.static) {
      body.addEventListener('collide', (e: any) => {
        const v = e.contact.getImpactVelocityAlongNormal?.() ?? 0;
        if (Math.abs(v) > 3.5) {
          audio.play('hit', Math.min(1, Math.abs(v) / 14));
          this.spawnParticles(mesh.position, color, 5, Math.min(1, Math.abs(v) / 12));
        }
      });
    }
    this.bricks.push(brick);
  }

  // ---------- firing ----------
  get aimDir() {
    const y = THREE.MathUtils.degToRad(this.yaw);
    const p = THREE.MathUtils.degToRad(this.pitch);
    return new THREE.Vector3(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  }
  get muzzleWorld() {
    const v = new THREE.Vector3();
    this.muzzle.getWorldPosition(v);
    return v;
  }

  fire() {
    if (this.status !== 'playing' || this.paused || this.ammo <= 0 || this.reloadTimer > 0) return;
    this.ammo--;
    this.reloadTimer = 0.45;
    audio.play('fire');
    this.shake = 0.35;

    const dir = this.aimDir;
    const start = this.muzzleWorld.clone().add(dir.clone().multiplyScalar(0.6));
    const r = 0.45;
    const mesh = new THREE.Mesh(icoGeometry(r, 1), mat(ENV.ball));
    mesh.castShadow = true;
    this.scene.add(mesh);
    const body = new CANNON.Body({
      mass: 9,
      shape: new CANNON.Sphere(r),
      material: this.ballMat,
      position: new CANNON.Vec3(start.x, start.y, start.z),
      linearDamping: 0.005,
    });
    (body as any).ccdSpeedThreshold = 8;
    (body as any).ccdIterations = 6;
    body.velocity.set(dir.x * this.power, dir.y * this.power, dir.z * this.power);
    body.addEventListener('collide', (e: any) => {
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal?.() ?? 0);
      if (v > 4) {
        this.shake = Math.min(0.5, this.shake + v / 90);
        this.spawnParticles(mesh.position, 0xfff0a0, 12, 1);
        audio.play('thud');
      }
    });
    this.world.addBody(body);

    const tGeo = new THREE.BufferGeometry().setFromPoints(new Array(24).fill(0).map(() => start.clone()));
    const trail = new THREE.Points(tGeo, trailMaterial());
    this.scene.add(trail);

    this.balls.push({ mesh, body, born: performance.now(), trail, trailPts: new Array(24).fill(0).map(() => start.clone()) });
    if (this.balls.length > 6) this.removeBall(this.balls.shift()!);

    // muzzle flash + smoke
    (this.muzzle.material as THREE.MeshBasicMaterial).opacity = 1;
    this.spawnParticles(start, 0xffe066, 16, 1.2);
    this.pushHud();
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

  private spawnParticles(pos: THREE.Vector3 | CANNON.Vec3, color: number, n: number, power = 1) {
    if (this.particles.length > 220) return;
    for (let i = 0; i < n; i++) {
      // 材质必须独占（逐颗淡出），几何体走共享缓存
      const m = new THREE.Mesh(icoGeometry(0.12, 0), fadeMaterial(color));
      m.position.set(pos.x, pos.y, pos.z);
      this.scene.add(m);
      this.particles.push({
        mesh: m,
        vel: new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8).multiplyScalar(power),
        life: 0,
        max: 0.6 + Math.random() * 0.6,
        spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
      });
    }
  }

  private spawnConfetti() {
    const cols = [PALETTE.red, PALETTE.yellow, PALETTE.blue, PALETTE.green, PALETTE.purple, PALETTE.orange];
    const base = this.camera.position.clone().add(this.aimDir.clone().multiplyScalar(14));
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(brickGeometry(0.32, 0.32, 0.05), fadeMaterial(cols[i % 6]));
      m.position.set(base.x + (Math.random() - 0.5) * 24, base.y + 12 + Math.random() * 8, base.z + (Math.random() - 0.5) * 10);
      this.scene.add(m);
      this.particles.push({
        mesh: m,
        vel: new THREE.Vector3((Math.random() - 0.5) * 4, -2 - Math.random() * 2, (Math.random() - 0.5) * 4),
        life: 0,
        max: 3.5,
        spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10),
      });
    }
  }

  // ---------- scoring ----------
  private checkKnocked() {
    const now = performance.now();
    for (const b of this.bricks) {
      if (b.knocked || b.def.static) continue;
      const dist = b.body.position.distanceTo(b.initPos);
      const up = new CANNON.Vec3(0, 1, 0);
      const cur = b.body.quaternion.vmult(up, new CANNON.Vec3());
      const tilt = Math.acos(Math.max(-1, Math.min(1, cur.dot(up)))) * (180 / Math.PI);
      if (dist > 1.2 || tilt > 38) {
        b.knocked = true;
        this.knockedCount++;
        this.colorKnocked[b.def.color] = (this.colorKnocked[b.def.color] || 0) + 1;
        if (b.def.target) this.targetsKnocked++;
        if (now < this.comboUntil) this.comboCount++;
        else this.comboCount = 1;
        this.comboUntil = now + 1600;
        const bonus = this.comboCount > 1 ? Math.round(b.score * 0.25 * (this.comboCount - 1)) : 0;
        this.score += b.score + bonus;
        if (this.comboCount === 5) audio.play('collapse');
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

  objectiveProgress(): string {
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
    const done = this.objectiveDone();
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
      const ammoBonus = this.ammo * 200;
      this.score += ammoBonus;
      let s = 1;
      if (this.ammo >= this.level.twoStarAmmoLeft) s = 2;
      if (this.score >= this.level.targetScore && this.ammo >= this.level.twoStarAmmoLeft) s = 3;
      this.stars = s;
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
      const p = b.body.position;
      if (now - b.born > 9000 || p.y < -20 || Math.abs(p.x) > 120 || Math.abs(p.z) > 160 || p.z > 20) this.removeBall(b);
    }

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      p.vel.y += GRAVITY * 0.35 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      (p.mesh.material as THREE.MeshBasicMaterial).transparent = true;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - p.life / p.max);
      if (p.life > p.max) {
        this.scene.remove(p.mesh);
        // 几何体共享（art.ts 缓存），只释放粒子独占的材质
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
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
      maxAmmo: this.level.ammo,
      score: this.score,
      targetScore: this.level.targetScore,
      yaw: Math.round(this.yaw),
      pitch: Math.round(this.pitch),
      power: Math.round(((this.power - MIN_POWER) / (MAX_POWER - MIN_POWER)) * 100),
      stars: this.stars,
      status: this.status,
      combo: performance.now() < this.comboUntil ? this.comboCount : 0,
      aiming: this.aiming,
    });
  }

  setPower(pct: number) {
    this.power = MIN_POWER + (MAX_POWER - MIN_POWER) * (pct / 100);
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
    disposeArt(); // 收口 art.ts 的共享材质 / 几何体 / 贴图缓存
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}

export const LEVEL_COUNT = LEVELS.length;
