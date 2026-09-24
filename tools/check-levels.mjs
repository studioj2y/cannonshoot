#!/usr/bin/env node
/**
 * 关卡自检工具 —— 改完 levels.ts 必跑。
 *
 *   node tools/check-levels.mjs           # 全部关卡
 *   node tools/check-levels.mjs 6 7 10    # 只查指定关（1 起算）
 *
 * 做两件事：
 *   A. 摆放静检（纯几何、瞬间出结果）
 *      检查每块【非静态】砖的底面是否正好落在某个支撑面上。
 *      悬空 → 自由落体砸翻邻居；埋入 → 求解器把它顶出来。两种都会在开局白送击倒数。
 *   B. 开局空跑（真实 cannon-es，不开炮跑 6 秒）
 *      参数逐条照抄 Game.ts（重力 / 求解器 / 四组接触材质 / 砖块阻尼 / 判定阈值），
 *      任何非零的自倒数都是 bug，不是手感问题。
 *      玻璃砖（kind: 'glass'）同样复刻：撞击超过 GLASS_BREAK_V 就当场消失。
 *      ⚠️ 开局就有玻璃砖自己碎掉 = 白送击倒数，与「自倒」同级，一律算不通过。
 *      ⚠️ 本工具**不开炮**，所以不需要复刻弹药（半径 / 质量 / 初速 / 爆炸）
 *         —— 那部分在 playtest.mjs 里，改 ammo.ts 时同步那一个。
 *
 * ⚠️ 工具的几何近似：只按 AABB 判重叠，非轴对齐的砖（rotY）会偏保守。
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
const KNOCK_DIST = 1.2;   // 位移阈值
const KNOCK_TILT = 38;    // 倾角阈值（度）
const GLASS_BREAK_V = 3.0; // 玻璃碎裂的撞击速度阈值
const RUN_SECONDS = 6;

/* ---------------- A. 摆放静检 ---------------- */

/** 取一块砖的 XZ 占位与【顶面】高度。静检只关心轴对齐包围盒。 */
function extent(def) {
  const [a, b, c] = def.size;
  if (def.shape === 'cylinder') {
    const r = a;
    return { minX: -r, maxX: r, minZ: -r, maxZ: r, h: b, top: def.pos[1] + b / 2 };
  }
  return { minX: -a / 2, maxX: a / 2, minZ: -c / 2, maxZ: c / 2, h: b, top: def.pos[1] + b / 2 };
}

function overlapArea(a, b) {
  const dx = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const dz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return dx > 0.02 && dz > 0.02 ? dx * dz : 0;
}

const fmt = (v) => (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';

function lintLayout(level) {
  const problems = [];
  const boxes = level.bricks.map((def, i) => {
    const e = extent(def);
    return {
      i, def, e,
      minX: def.pos[0] + e.minX, maxX: def.pos[0] + e.maxX,
      minZ: def.pos[2] + e.minZ, maxZ: def.pos[2] + e.maxZ,
      bottom: def.pos[1] - e.h / 2,
      top: def.pos[1] + e.h / 2,
    };
  });

  for (const b of boxes) {
    if (b.def.static) continue;
    const eps = 0.045; // 允许的贴合误差
    let supported = Math.abs(b.bottom) < eps; // 地面 y = 0
    let bestGap = Math.abs(b.bottom);
    for (const o of boxes) {
      if (o === b) continue;
      if (Math.abs(o.top - b.bottom) > eps) continue;
      if (overlapArea(b, o) <= 0) continue;
      supported = true;
      break;
    }
    for (const o of boxes) {
      if (o === b) continue;
      const gap = Math.abs(o.top - b.bottom);
      if (gap < bestGap && overlapArea(b, o) > 0) bestGap = gap;
    }
    if (!supported) {
      problems.push({
        i: b.i,
        msg: `底面 y=${fmt(b.bottom)} 下方没有支撑面（最近支撑面差 ${fmt(bestGap)}）`,
        where: `pos=[${b.def.pos.map(fmt).join(', ')}] color=${b.def.color}${b.def.target ? ' TARGET' : ''}`,
      });
    }
  }
  return problems;
}

/* ---------------- B. 开局空跑 ---------------- */

function simulate(level) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.solver.iterations = 12;
  world.solver.tolerance = 0.002;
  world.allowSleep = true;

  const groundMat = new CANNON.Material('ground');
  const brickMat = new CANNON.Material('brick');
  world.addContactMaterial(new CANNON.ContactMaterial(groundMat, brickMat, { friction: 0.55, restitution: 0.08 }));
  world.addContactMaterial(new CANNON.ContactMaterial(brickMat, brickMat, { friction: 0.5, restitution: 0.05 }));

  const gBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: groundMat });
  gBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(gBody);

  const items = [];
  for (const def of level.bricks) {
    const [a, b, c] = def.size;
    let shape;
    if (def.shape === 'cylinder') shape = new CANNON.Cylinder(a, a, b, 12);
    else shape = new CANNON.Box(new CANNON.Vec3(a / 2, b / 2, c / 2));

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
    const it = { def, body, initPos: body.position.clone(), shattered: false, breakQueued: false };
    // 与 Game.addBrick 的玻璃判定一致：撞击超过阈值就排队等碎裂
    if (def.kind === 'glass') {
      body.addEventListener('collide', (e) => {
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal?.() ?? 0);
        if (v > GLASS_BREAK_V) it.breakQueued = true;
      });
    }
    items.push(it);
  }

  const steps = Math.round(RUN_SECONDS * 60);
  for (let s = 0; s < steps; s++) {
    world.step(1 / 60, 1 / 60, 4);
    // 与 Game.drainShatters 一致：step 之后再清算，摘掉物理体 = 不再提供支撑
    for (const it of items) {
      if (!it.breakQueued || it.shattered) continue;
      it.breakQueued = false;
      it.shattered = true;
      world.removeBody(it.body);
      it.body.position.set(0, -500, 0); // 挪出画面，别再跟地面的碰撞检测纠缠
    }
  }

  const up = new CANNON.Vec3(0, 1, 0);
  const knocked = [];
  const shattered = [];
  for (const it of items) {
    if (it.def.static) continue;
    if (it.shattered) {
      shattered.push(it);
      continue;
    }
    const dist = it.body.position.distanceTo(it.initPos);
    const cur = it.body.quaternion.vmult(up, new CANNON.Vec3());
    const tilt = (Math.acos(Math.max(-1, Math.min(1, cur.dot(up)))) * 180) / Math.PI;
    if (dist > KNOCK_DIST || tilt > KNOCK_TILT) {
      knocked.push({ ...it, dist, tilt });
    }
  }
  return { total: items.filter((b) => !b.def.static).length, glass: items.filter((b) => b.def.kind === 'glass').length, knocked, shattered };
}

/* ---------------- 主流程 ---------------- */

const tmp = mkdtempSync(join(tmpdir(), 'cbc-lv-'));
let LEVELS;
try {
  const out = await build({
    entryPoints: [join(ROOT, 'src/game/levels.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  });
  const modPath = join(tmp, 'levels.mjs');
  writeFileSync(modPath, out.outputFiles[0].text);
  ({ LEVELS } = await import(pathToFileURL(modPath).href));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const only = process.argv.slice(2).map(Number).filter((n) => n >= 1);
const targets = LEVELS.map((lv, i) => ({ lv, n: i + 1 })).filter((t) => !only.length || only.includes(t.n));

let failed = 0;
for (const { lv, n } of targets) {
  const lint = lintLayout(lv);
  const { total, glass, knocked, shattered } = simulate(lv);
  const objKind = lv.objective.kind;
  const need = lv.objective.count ?? (objKind === 'targets' ? lv.bricks.filter((b) => b.target).length : 0);
  // 玻璃碎了在游戏里也算「击倒」（碎掉 = 没了），所以判开局即胜要把两笔一起算
  const gone = knocked.length + shattered.length;
  const autoWin = need > 0 && (objKind === 'knockCount' || objKind === 'color') && gone >= need;

  const bad = lint.length > 0 || knocked.length > 0 || shattered.length > 0;
  if (bad) failed++;

  console.log(
    `\n${bad ? '❌' : '✅'} L${n} 《${lv.name.zh}》 砖数 ${lv.bricks.length}（可击倒 ${total}${glass ? `，玻璃 ${glass}` : ''}）` +
    ` 目标 ${objKind}${need ? ` ${need}` : ''}  弹药 ${lv.ammo}`
  );

  if (lint.length) {
    console.log(`   摆放静检：${lint.length} 处底面没有支撑面`);
    for (const p of lint.slice(0, 12)) console.log(`     · #${p.i} ${p.msg}  ${p.where}`);
    if (lint.length > 12) console.log(`     · …另有 ${lint.length - 12} 处`);
  } else {
    console.log('   摆放静检：全部贴合 ✓');
  }

  if (knocked.length) {
    console.log(`   空跑 ${RUN_SECONDS}s：${knocked.length} 块自倒${autoWin ? '  ⚠️ 开局即达成目标（会直接判胜）' : ''}`);
    for (const k of knocked.slice(0, 12)) {
      console.log(
        `     · #${k.def.pos.join(',')} 位移 ${k.dist.toFixed(2)} 倾角 ${k.tilt.toFixed(1)}°` +
        `  color=${k.def.color}${k.def.target ? ' TARGET' : ''}`
      );
    }
    if (knocked.length > 12) console.log(`     · …另有 ${knocked.length - 12} 块`);
  } else {
    console.log(`   空跑 ${RUN_SECONDS}s：自倒 0 块 ✓`);
  }

  if (shattered.length) {
    console.log(`   空跑 ${RUN_SECONDS}s：${shattered.length} 块玻璃自碎（撞击阈值被静置抖动触发）${autoWin ? '  ⚠️ 开局即达成目标' : ''}`);
    for (const s of shattered.slice(0, 12)) {
      console.log(`     · #${s.def.pos.join(',')} color=${s.def.color} kind=glass`);
    }
  } else if (glass) {
    console.log('   空跑 6s：玻璃自碎 0 块 ✓');
  }
}

console.log(`\n${failed ? `❌ ${failed}/${targets.length} 关未通过` : `✅ ${targets.length}/${targets.length} 关全部通过`}`);
process.exit(failed ? 1 : 0);
