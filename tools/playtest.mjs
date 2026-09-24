#!/usr/bin/env node
/**
 * 关卡难度校准 —— 用真实物理算出「一发炮弹最多能打出多少」，用来判断难度是否失控。
 *
 *   node tools/playtest.mjs                 # 全部 10 关，单发扫描（推荐）
 *   node tools/playtest.mjs 6 10            # 只测指定关
 *   node tools/playtest.mjs --shots 3       # 贪心 3 发（慢很多，慎用）
 *   node tools/playtest.mjs --grid blind    # 用盲扫网格而不是瞄准解算
 *   node tools/playtest.mjs --ammo hammer   # 换一种弹药扫（standard/hammer/bomb/triple）
 *
 * 原理：不开浏览器，在 Node 里用真实 cannon-es 复刻物理（参数照抄 Game.ts），
 * 候选炮弹不是瞎撒点，而是**瞄准每座结构最低那几块砖反解出来的弹道**
 * （R = v·cosθ·T，H = v·sinθ·T − ½gT² ⇒ v² = gR² / (2cos²θ(R·tanθ − H))），
 * 再在反解出的初速上下浮动几档，盖住阻尼与近似误差。
 *
 * ⚠️ 玻璃砖（kind: 'glass'）必须一起复刻：撞击超过 GLASS_BREAK_V 就当场消失、
 *    不再提供支撑，而且**算一块击倒**。不复刻的话，带玻璃的关卡会被严重低估
 *    （工具以为那排腿还在撑着，真机上早就没了）。
 *
 * ⚠️ **弹药同样必须复刻**（AMMO 表）。加了新弹药却没在这里补一条，**不会报错** ——
 *    工具会静默按标准弹算，给出的「一发最好」与真机不符。真机上弹药会改变
 *    半径 / 质量 / 初速倍率，爆破筒还要算爆炸，三连发要算三颗的散射。
 *    默认扫的是 standard，跨版本比较历史数字时必须用同一个 --ammo。
 *
 * ⚠️ 为什么不用全盲网格：真实 cannon-es 单步约 1.8ms，一发要跑 ~270 步，
 *    全网格 × 贪心 N 发是 O(网格 × N²) 的算法，跑一关要几十分钟。瞄准解算把
 *    候选从几百个压到几十个，且每个都「有理由」，性价比高一个量级。
 *
 * 看什么：
 *   · 【一发最好 / 可击倒】—— 这一发的「穿透力」。跨关应该落在同一带里。
 *   · 【一发最好 / 目标】—— 接近或超过 100% 说明目标太松（一发就够）。
 *   · 【弹药 × 一发最好 / 目标】—— 远小于 1 说明目标偏紧。
 */

import { build } from 'esbuild';
import * as CANNON from 'cannon-es';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- 与 Game.ts 保持一致的常量（改那边记得改这边） ---- */
const GRAVITY = -19.6;
const MIN_POWER = 20;
const MAX_POWER = 60;
const KNOCK_DIST = 1.2;
const KNOCK_TILT = 38;
const CANNON_POS = { x: 0, y: 1.6, z: 0 };
const MUZZLE_OFFSET = 3.4;   // 炮口到炮台原点（沿 aimDir）
const BALL_LEAD = 0.6;       // 出膛点再往前推一点
const START_LEAD = MUZZLE_OFFSET + BALL_LEAD; // 出膛点到炮台原点的距离 = 4.0

/* ---- 弹药表：与 src/game/ammo.ts 逐条对应（改那边记得改这边） ----
   standard 的 0.45 / 9 / 1.0 就是历史所有难度数字的基准，不要动。 */
const AMMO = {
  standard: { radius: 0.45, mass: 9, powerScale: 1.0, count: 1, spread: 0 },
  hammer: { radius: 0.62, mass: 18, powerScale: 0.88, count: 1, spread: 0 },
  bomb: { radius: 0.5, mass: 11, powerScale: 1.0, count: 1, spread: 0 },
  triple: { radius: 0.32, mass: 5, powerScale: 1.0, count: 3, spread: 7 },
};
const BOMB_TRIGGER_V = 1.5;    // 命中当帧引爆，无引信延迟（同 Game.ts）
const EXPLOSION_RADIUS = 3.4;
const EXPLOSION_DV = 14;       // 爆炸给的速度增量（中心处）

const BALL_LIFE = 9;         // 炮弹存活秒数
const MAX_BALLS = 6;         // 同场上限
const GLASS_BREAK_V = 3.0;   // 玻璃碎裂的撞击速度阈值（同 Game.ts）

/* ---- 命令行 ---- */
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const SHOTS = Number(flag('shots', 1));
const GRID = flag('grid', 'aim');
const MAX_WAIT = Number(flag('maxwait', 3));  // 单发最多等多少秒静下来
const TAIL = Number(flag('tail', 1.5));       // 收尾再跑多少秒
const SAMPLE = Number(flag('sample', 10));    // 瞄准解算采样多少块砖
const only = argv.filter((a) => /^\d+$/.test(a)).map(Number);
const SAY = argv.includes('--quiet') ? () => {} : (m) => process.stderr.write(m);

const AMMO_KIND = flag('ammo', 'standard');
if (!Object.prototype.hasOwnProperty.call(AMMO, AMMO_KIND)) {
  process.stderr.write(`未知弹药：${AMMO_KIND}（可选：${Object.keys(AMMO).join(' / ')}）\n`);
  process.exit(1);
}
const AMMO_DEF = AMMO[AMMO_KIND];

/* 仰角采样点与初速浮动档。
   ⚠️ 这两个数组是运行时间的主要开关：候选数 = 采样砖数 × 仰角数 × 初速档数，
      而真实 cannon-es 一发要跑 ~190 步（约 0.35 秒）。仰角给到 19 个、初速给 3 档时
      候选逼近 700 个，一关就要跑十几分钟。6 × 2 是「够覆盖、又不至于等到烦」的取值。 */
const PITCHES = [8, 20, 32, 44, 56, 68];
const POWER_SCALES = [0.98, 1.02];

/* ---------------- 物理世界 ---------------- */

function makeWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 12;
  world.solver.tolerance = 0.002;
  world.allowSleep = true;

  const groundMat = new CANNON.Material('ground');
  const brickMat = new CANNON.Material('brick');
  const ballMat = new CANNON.Material('ball');
  world.addContactMaterial(new CANNON.ContactMaterial(groundMat, brickMat, { friction: 0.55, restitution: 0.08 }));
  world.addContactMaterial(new CANNON.ContactMaterial(brickMat, brickMat, { friction: 0.5, restitution: 0.05 }));
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, brickMat, { friction: 0.3, restitution: 0.25 }));
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, groundMat, { friction: 0.4, restitution: 0.35 }));

  const gBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: groundMat });
  gBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(gBody);
  return { world, brickMat, ballMat };
}

function makeBricks(level, world, brickMat) {
  const items = [];
  for (const def of level.bricks) {
    const [a, b, c] = def.size;
    const shape =
      def.shape === 'cylinder' ? new CANNON.Cylinder(a, a, b, 12) : new CANNON.Box(new CANNON.Vec3(a / 2, b / 2, c / 2));
    const body = new CANNON.Body({
      mass: def.static ? 0 : def.mass ?? 1.3,
      shape,
      material: brickMat,
      position: new CANNON.Vec3(...def.pos),
      allowSleep: true,
      sleepSpeedLimit: 0.25,
      sleepTimeLimit: 0.6,
      linearDamping: 0.02,
      angularDamping: 0.06,
    });
    if (def.rotY) body.quaternion.setFromEuler(0, def.rotY, 0);
    world.addBody(body);
    const it = { def, body, initPos: body.position.clone(), initQuat: body.quaternion.clone(), shattered: false, breakQueued: false };
    if (def.kind === 'glass') {
      body.addEventListener('collide', (e) => {
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal?.() ?? 0);
        if (v > GLASS_BREAK_V) it.breakQueued = true;
      });
    }
    items.push(it);
  }
  return items;
}

function resetBricks(items) {
  for (const it of items) {
    if (it.def.static) continue;
    it.body.position.copy(it.initPos);
    it.body.quaternion.copy(it.initQuat);
    it.body.velocity.setZero();
    it.body.angularVelocity.setZero();
    it.body.force.setZero();
    it.body.torque.setZero();
    it.body.wakeUp();
    it.shattered = false;
    it.breakQueued = false;
  }
}

/** 玻璃碎裂的复刻：摘出场景 = 不再提供支撑。
 *  ⚠️ 这里是把 body 挪到 y = -500 并让它睡过去，而不是 world.removeBody ——
 *     下一轮 runPlan 还要 resetBricks 把它放回原位，真删掉就复原不了了。 */
function drainGlass(items) {
  for (const it of items) {
    if (!it.breakQueued || it.shattered || it.def.static) continue;
    it.breakQueued = false;
    it.shattered = true;
    it.body.position.set(0, -500, 0);
    it.body.velocity.setZero();
    it.body.angularVelocity.setZero();
    it.body.sleep();
  }
}

const aimDir = (yaw, pitch) => {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return { x: -Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p) };
};

/** 爆破筒爆炸的复刻 —— 与 Game.explode 用同一套算法：
 *  按「速度增量」施加（而不是写死冲量，那样轻砖飞天重砖不动）、边缘线性衰减、
 *  玻璃砖的 Δv 超过 GLASS_BREAK_V 就直接判碎（悬空玻璃被炸飞之后等不到碰撞）。 */
function explode(items, ball) {
  const at = ball.body.position;
  for (const it of items) {
    if (it.def.static || it.shattered) continue;
    const p = it.body.position;
    const dx = p.x - at.x;
    const dy = p.y - at.y;
    const dz = p.z - at.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > EXPLOSION_RADIUS) continue;
    const dv = EXPLOSION_DV * (1 - d / EXPLOSION_RADIUS);
    const len = Math.max(0.001, d);
    const k = dv * it.body.mass;
    it.body.applyImpulse(new CANNON.Vec3((dx / len) * k, (dy / len) * 0.6 * k + 0.5 * k, (dz / len) * k));
    if (it.def.kind === 'glass' && dv > GLASS_BREAK_V) it.breakQueued = true;
  }
}

/** 帧序与 Game.step 一致：先 world.step，再兑现炮弹的引爆 / 回收，最后清算碎裂。
 *  ⚠️ 爆炸必须放在 world.step **之后**（引擎里也在 step 后的炮弹清理段）——
 *     它要改一堆刚体的速度，放在 step 之前等于在求解器工作期间改速度。
 *  ⚠️ 接触引爆**没有引信倒计时**：collide 里置 detonate，这里当帧兑现。
 *  ⚠️ 炮弹的 9 秒回收与同场上限同样要照抄 Game.ts，否则第 2 发之后跟真机对不上。 */
function stepWorld(world, balls, items, dt, t) {
  world.step(dt, dt, 4);
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (b.detonate) {
      explode(items, b);
      world.removeBody(b.body);
      balls.splice(i, 1);
      continue;
    }
    if (t - b.born > BALL_LIFE) {
      world.removeBody(b.body);
      balls.splice(i, 1);
    }
  }
  // 同 Game.drainShatters：step 之后再清算本帧要碎的玻璃
  drainGlass(items);
}

/** 世界静下来了没（用于提前结束一发，省算力）
 *  ⚠️ 炮弹不能只看「在不在场上」——它要待满 9 秒才回收，而单发最多等 3 秒，
 *     按「有球就没静」写会让提前退出永不触发，整轮慢一个量级。 */
function settled(items, balls) {
  for (const b of balls) {
    if (b.body.sleepState !== CANNON.Body.SLEEPING && b.body.velocity.length() > 0.6) return false;
  }
  for (const it of items) {
    if (it.def.static || it.shattered) continue;
    if (it.body.sleepState !== CANNON.Body.SLEEPING && it.body.velocity.length() > 0.4) return false;
  }
  return true;
}

/** 发球。半径 / 质量 / 初速倍率全部从 AMMO 表读，三连发一次发 3 颗。
 *  ⚠️ 散射偏移作用在 **yaw** 上再重算整个方向向量，不能直接给 dir 的 x 分量加个数 ——
 *     那样只改水平分量、等于把仰角也改了（弹道整体变平）。 */
function fire(world, balls, ballMat, shot, t) {
  for (let i = 0; i < AMMO_DEF.count; i++) {
    const off = AMMO_DEF.count > 1 ? (i - (AMMO_DEF.count - 1) / 2) * AMMO_DEF.spread : 0;
    const dir = aimDir(shot.yaw + off, shot.pitch);
    const body = new CANNON.Body({
      mass: AMMO_DEF.mass,
      shape: new CANNON.Sphere(AMMO_DEF.radius),
      material: ballMat,
      position: new CANNON.Vec3(
        CANNON_POS.x + START_LEAD * dir.x,
        CANNON_POS.y + START_LEAD * dir.y,
        CANNON_POS.z + START_LEAD * dir.z
      ),
      linearDamping: 0.005,
    });
    body.ccdSpeedThreshold = 8;
    body.ccdIterations = 6;
    const speed = shot.power * AMMO_DEF.powerScale;
    body.velocity.set(dir.x * speed, dir.y * speed, dir.z * speed);
    const rec = { body, born: t, detonate: false };
    if (AMMO_KIND === 'bomb') {
      // 与 Game.spawnBall 一致：命中当帧引爆（阈值只用来放过纯擦碰）。
      // 没有引信倒计时 —— 关卡没有纵深，延迟等于让球掠过整个目标。
      body.addEventListener('collide', (e) => {
        if (rec.detonate) return;
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal?.() ?? 0);
        if (v > BOMB_TRIGGER_V) rec.detonate = true;
      });
    }
    world.addBody(body);
    balls.push(rec);
  }
  while (balls.length > MAX_BALLS) {
    world.removeBody(balls[0].body);
    balls.shift();
  }
}

const UP = new CANNON.Vec3(0, 1, 0);

function knockStats(items) {
  const knocked = [];
  for (const it of items) {
    if (it.def.static) continue;
    // 碎掉的玻璃砖在游戏里也算一块击倒（碎掉 = 没了），必须先判它
    if (it.shattered) {
      knocked.push(it);
      continue;
    }
    const dist = it.body.position.distanceTo(it.initPos);
    const cur = it.body.quaternion.vmult(UP, new CANNON.Vec3());
    const tilt = (Math.acos(Math.max(-1, Math.min(1, cur.dot(UP)))) * 180) / Math.PI;
    if (dist > KNOCK_DIST || tilt > KNOCK_TILT) knocked.push(it);
  }
  return knocked;
}

function runPlan(ctx, plan) {
  const { world, items, ballMat } = ctx;
  resetBricks(items);
  const balls = [];
  const dt = 1 / 60;
  let t = 0;
  /* 计分复刻 Game.ts 的 checkKnocked：每块 100 分；与上一块击倒间隔 < 1600ms
     记连击，第 k 块再加 25%×(k-1)。逐帧比对击倒数增量即可 ——
     同一帧内多块按同一时刻算，与游戏里一帧扫一遍的行为一致。 */
  let score = 0;
  let combo = 0;
  let comboUntil = -1;
  let seen = 0;
  const tick = () => {
    const n = knockStats(items).length;
    if (n <= seen) return;
    const nowMs = t * 1000;
    for (let i = seen; i < n; i++) {
      combo = nowMs < comboUntil ? combo + 1 : 1;
      comboUntil = nowMs + 1600;
      score += 100 + (combo > 1 ? Math.round(100 * 0.25 * (combo - 1)) : 0);
    }
    seen = n;
  };
  for (const shot of plan) {
    fire(world, balls, ballMat, shot, t);
    let waited = 0;
    for (let s = 0; s < MAX_WAIT * 60; s++) {
      stepWorld(world, balls, items, dt, t);
      t += dt;
      waited += dt;
      tick();
      if (waited > 0.35 && settled(items, balls)) break;
    }
  }
  for (let s = 0; s < TAIL * 60; s++) {
    stepWorld(world, balls, items, dt, t);
    t += dt;
    tick();
  }
  return { knocked: knockStats(items), score };
}

/* ---------------- 候选炮弹 ---------------- */

/** 瞄准一个点反解弹道：逐仰角算所需初速，再上下浮动几档盖住阻尼与近似误差 */
function solveShot(tx, ty, tz) {
  const dx = tx - CANNON_POS.x;
  const dz = tz - CANNON_POS.z;
  const yaw = Math.round((Math.atan2(-dx, -dz) * 180) / Math.PI * 10) / 10;
  const L = Math.hypot(dx, dz);
  const g = Math.abs(GRAVITY);
  const out = [];
  for (const p of PITCHES) {
    const pr = (p * Math.PI) / 180;
    const R = L - START_LEAD * Math.cos(pr);
    const H = ty - (CANNON_POS.y + START_LEAD * Math.sin(pr));
    if (R <= 0.5) continue;
    const den = 2 * Math.cos(pr) ** 2 * (R * Math.tan(pr) - H);
    if (den <= 1e-3) continue;
    const v = Math.sqrt((g * R * R) / den);
    if (!Number.isFinite(v)) continue;
    for (const k of POWER_SCALES) {
      const vv = Math.round(v * k * 10) / 10;
      if (vv < MIN_POWER || vv > MAX_POWER) continue;
      out.push({ yaw, pitch: p, power: vv });
    }
  }
  return out;
}

/** 从关卡里挑出「值得瞄」的砖：每座结构最低的那几块，横向铺开 */
function pickAimPoints(level, n) {
  const live = level.bricks.filter((b) => !b.static);
  const buckets = new Map();
  for (const b of live) {
    const key = Math.round(b.pos[0] / 2); // 每 2 米一档，避免全挤在同一根柱子上
    const cur = buckets.get(key);
    if (!cur || b.pos[1] < cur.pos[1]) buckets.set(key, b);
  }
  const picked = [...buckets.values()].sort((a, b) => a.pos[0] - b.pos[0]);
  if (picked.length <= n) return picked;
  const step = picked.length / n;
  return Array.from({ length: n }, (_, i) => picked[Math.floor(i * step)]);
}

function candidateGrid(level) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const k = `${c.yaw}|${c.pitch}|${c.power}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  if (GRID === 'blind') {
    for (let yaw = -30; yaw <= 30; yaw += 10)
      for (let pitch = 0; pitch <= 72; pitch += 12)
        for (let power = MIN_POWER; power <= MAX_POWER; power += 10) push({ yaw, pitch, power });
    return out;
  }
  for (const b of pickAimPoints(level, SAMPLE)) {
    for (const c of solveShot(b.pos[0], b.pos[1], b.pos[2])) push(c);
  }
  return out;
}

/* ---------------- 主流程 ---------------- */

const tmp = mkdtempSync(join(tmpdir(), 'cbc-play-'));
let LEVELS;
try {
  const out = await build({
    entryPoints: [join(ROOT, 'src/game/levels.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  });
  const p = join(tmp, 'levels.mjs');
  writeFileSync(p, out.outputFiles[0].text);
  ({ LEVELS } = await import(pathToFileURL(p).href));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const targets = LEVELS.map((lv, i) => ({ lv, n: i + 1 })).filter((t) => !only.length || only.includes(t.n));
const rows = [];

for (const { lv, n } of targets) {
  const { world, brickMat, ballMat } = makeWorld();
  const items = makeBricks(lv, world, brickMat);
  const ctx = { world, items, ballMat };
  const grid = candidateGrid(lv);

  const total = items.filter((i) => !i.def.static).length;
  const glass = items.filter((i) => i.def.kind === 'glass').length;
  const o = lv.objective;
  const need = o.count ?? (o.kind === 'targets' ? items.filter((i) => i.def.target).length : 0);

  let bestOne = 0;
  let bestShot = null;
  let bestScore = 0; // 「一发最好」那一发的实际得分
  let maxScore = 0;  // 所有候选里的单发最高分 —— 定挑战积分线看这个
  const all = [];
  for (let i = 0; i < grid.length; i++) {
    const r = runPlan(ctx, [grid[i]]);
    const k = r.knocked.length;
    all.push(k);
    if (r.score > maxScore) maxScore = r.score;
    if (k > bestOne) { bestOne = k; bestShot = grid[i]; bestScore = r.score; }
    if (i % 10 === 0) SAY(`  L${n} 扫描 ${i}/${grid.length}\r`);
  }
  /* 分布是这套复现的「体检指标」：
     如果【所有】候选都打出高分，说明多半是 resetBricks 没把世界复原干净
     （上一发的结果漏进下一发），而不是这一关真的这么好打。 */
  if (argv.includes('--dump')) {
    const hist = new Map();
    for (const k of all) hist.set(k, (hist.get(k) ?? 0) + 1);
    const line = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}块×${v}`).join('  ');
    console.log(`   [分布] ${line}`);
    console.log(`   [最好的一发] yaw ${bestShot?.yaw}° pitch ${bestShot?.pitch}° power ${bestShot?.power}`);
  }

  let curve = [bestOne];
  if (SHOTS > 1) {
    const plan = [bestShot];
    for (let k = 1; k < SHOTS; k++) {
      let best = { c: null, n: -1 };
      for (const c of grid) {
        const got = runPlan(ctx, [...plan, c]).knocked.length;
        if (got > best.n) best = { c, n: got };
      }
      plan.push(best.c);
      curve.push(best.n);
      if (best.n >= total) break;
    }
  }
  const finalKnocked = curve[curve.length - 1];
  rows.push({ n, name: lv.name.zh, total, need, kind: o.kind, ammo: lv.ammo, bestOne, finalKnocked, curve, cand: grid.length });

  console.log(
    `L${n} 《${lv.name.zh}》 可击倒 ${total}${glass ? `（含玻璃 ${glass}）` : ''} · 目标 ${o.kind} ${need} · 弹药 ${lv.ammo}\n` +
    `   一发最好 ${bestOne}/${total}（${((bestOne / total) * 100).toFixed(0)}%）` +
    ` · 占目标 ${need ? ((bestOne / need) * 100).toFixed(0) + '%' : 'n/a'}` +
    ` · 贪心 ${curve.length} 发 ${finalKnocked}/${need}` +
    ` · 候选 ${grid.length} 个 · 单发最高分 ${maxScore}（一发最好那发 ${bestScore} 分）\n`
  );
}

console.log(
  `--- 汇总（弹药 ${AMMO_KIND}：半径 ${AMMO_DEF.radius} / 质量 ${AMMO_DEF.mass} / ` +
    `初速 ×${AMMO_DEF.powerScale} / 一次 ${AMMO_DEF.count} 颗）---`
);
console.log('E = 目标 ÷ 一发最好 = 理论最少发数；E ≤ 1 说明存在「一发即胜」的弹道（见 GAME_DESIGN.md 第 3 节）');
console.log('关   | 可击倒 | 目标 | 弹药 | 一发最好 | 一发/场 | 一发/目标 |    E | 弹药×一发/目标');
for (const r of rows) {
  const a = r.bestOne / r.total;
  const b = r.need ? r.bestOne / r.need : NaN;
  const c = r.need ? (r.ammo * r.bestOne) / r.need : NaN;
  // E = 目标 ÷ 一发最好。它对「打目标物」类关卡会失真（一发最好数的是砖块数，
  // 而两个目标物分列左右时一发物理上不可能同时命中）—— 那种情况看目标物数量。
  const e = r.bestOne > 0 ? r.need / r.bestOne : NaN;
  console.log(
    `L${String(r.n).padEnd(4)}| ${String(r.total).padStart(6)} | ${String(r.need).padStart(4)} | ` +
    `${String(r.ammo).padStart(4)} | ${String(r.bestOne).padStart(8)} | ${(a * 100).toFixed(0).padStart(6)}% | ` +
    `${Number.isNaN(b) ? '   n/a' : ((b * 100).toFixed(0) + '%').padStart(8)} | ` +
    `${Number.isNaN(e) ? '  n/a' : e.toFixed(2).padStart(5)} | ` +
    `${Number.isNaN(c) ? '   n/a' : (c.toFixed(1) + '×').padStart(8)}`
  );
}
