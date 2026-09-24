import * as THREE from 'three';

/* ============================================================================
   美术系统 —— 「精致 Low-Poly / 纸模微缩靶场」的规则落地
   规则源：ART_DIRECTION.md（改色、改材质、改布点前先读那份文档）

   三条硬约束（破坏它们会直接掉出这个风格）：
     1. 全场景色值只能取自本文件（`PALETTE` 砖色 / `ENV` 环境色 / `FX` 特效色）。
        Game.ts / App.tsx 里不允许出现临时十六进制色。
     2. 几何走本文件的工厂、材质走 mat() / unlit() 缓存。⚠️ 缓存是共享的，
        所以**任何地方都不许 dispose() 缓存的 geometry/material**（换关卡也不许），
        统一由 disposeArt() 在 Game.dispose() 里收口。
     3. 装饰物只是视觉、没有物理体。布点必须避开射击走廊（见 LANE），
        否则炮弹会从树里穿过去，看着像 bug。

   ⚠️ 实例化道具的着色约定：InstancedMesh 的最终颜色 = 材质色 × 实例色。
      所以「材质色负责整体色调、实例色只放中性明度抖动」——两边都放颜色会相乘变暗。
   ========================================================================== */

/* ------------------------------- 1. 调色板 ------------------------------- */

export type ColorKey = 'red' | 'yellow' | 'blue' | 'green' | 'purple' | 'orange' | 'gray';

/** 砖色组：中低饱和 + 高明度。red 是唯一高饱和 —— 它是 L4 的目标色，必须一眼可辨。 */
export const PALETTE: Record<ColorKey, number> = {
  red: 0xd9544d,
  orange: 0xe08a45,
  yellow: 0xe7c169,
  green: 0x7fa96a,
  blue: 0x5d8fa8,
  purple: 0x8e6e9e,
  gray: 0xc9c0b2,
};

/** 环境色。⚠️ 雾色直接取 skyHorizon，不单独定义 —— 两者不同值会在地平线留下接缝。 */
export const ENV = {
  skyTop: 0x4e9bd4,
  skyMid: 0xa9d3ea,
  skyHorizon: 0xe8e3d3,

  grass: 0x7bb25e,
  sand: 0xdcc189,
  dryGrass: 0xb9a06b,
  hillNear: 0x8fb6a0,
  hillFar: 0xb9cfd6,

  keyLight: 0xfff1d9,
  fillLight: 0xb9d6ff,
  hemiSky: 0xdff1ff,
  hemiGround: 0x9cb86e,

  cloud: 0xfdfbf4,
  cloudUnder: 0xeaf0f3,
  leafLight: 0x8fb573,
  leafDark: 0x6b9058,
  rock: 0x9a938a,

  metal: 0x8b93a3,
  brass: 0xc9a24d,
  wood: 0x6b5346,
  ball: 0x40444f,
  gem: 0xcfa9dd,
  /* 玻璃：砖色朝它混合后得到「带色玻璃」。⚠️ 不要拿它当砖色用 ——
     砖色组 PALETTE 是 7 个不透明色，玻璃是「材质 + 砖色」的组合，两者不是一回事。 */
  glass: 0xd6f0f5,
  trail: 0xfff0c4,
  flash: 0xfff3c4,
  landing: 0xfff6dc,
} as const;

/**
 * 瞬时特效色（VFX）。⚠️ 刻意不并进 PALETTE ——
 * PALETTE 是「砖色」，是**玩法色**（红 = L4 的目标、紫 = 目标物）。
 * 特效色只出现在寿命 0.1~1.5 秒的衰减材质上，一旦混用，
 * 「看到红色 = 这是要打的目标」这条读法就失效了。
 *
 * 色相全部落在暖橙→近白这一条带上：与场景的中低饱和冷调（天空 / 草地 / 蓝灰）
 * 形成唯一的暖色高点，爆炸才「跳」得出来。唯一的例外是 smoke —— 灰尘必须是
 * 中性灰，否则会读成「又一次火光」而不是「扬起来的土」。
 */
export const FX = {
  muzzle: 0xffe066,
  spark: 0xfff0a0,
  ember: 0xffc46a,
  core: 0xfff6d8,
  ring: 0xffb057,
  smoke: 0xb8b1a4,
} as const;

/* --------------------------- 2. 设备档与工具 ---------------------------- */

/** 手机/平板档：阴影贴图降一档、点缀数量减半。触控瞄准本身不依赖它。 */
export function isLowPowerDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches === true || (navigator.maxTouchPoints ?? 0) > 0;
}

/** 可复现的伪随机（固定种子）—— 环境外观与截图都要稳定，不用 Math.random */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 射击走廊（炮台 → 靶场）。装饰物一律不在这里布点。 */
const LANE = { xMax: 22, zMin: -70, zMax: -6 };

function inLane(x: number, z: number): boolean {
  return Math.abs(x) < LANE.xMax && z > LANE.zMin && z < LANE.zMax;
}

/* ---------------------------- 3. 资源缓存 ------------------------------ */

const matCache = new Map<string, THREE.Material>();
const geoCache = new Map<string, THREE.BufferGeometry>();
const texCache = new Map<string, THREE.Texture>();
/** 不在缓存里、但同样需要在 disposeArt() 里收口的资源（天空球、地面板等一次性对象） */
const loose: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];

/**
 * 唯一的材质家族：哑光 + 极弱高光。
 * flatShading 是关键 —— 它让每个面独立受光，才有低多边形的「刻面」感。
 * variant 0/1/2 = 明度 ±0% / +6% / −6%，给成排的砖加一点手作差异。
 */
export function mat(color: number, variant = 0): THREE.MeshPhongMaterial {
  const key = `${color}|${variant}`;
  let m = matCache.get(key) as THREE.MeshPhongMaterial | undefined;
  if (!m) {
    const c = new THREE.Color(color);
    if (variant === 1) c.multiplyScalar(1.06);
    else if (variant === 2) c.multiplyScalar(0.94);
    m = new THREE.MeshPhongMaterial({ color: c, flatShading: true, shininess: 12, specular: 0x1a1a1a });
    matCache.set(key, m);
  }
  return m;
}

/**
 * 玻璃砖 —— 与 mat() 同一个家族，但走透明通道。
 * 做法是「砖色朝 ENV.glass 混一把」（75% 左右），而不是直接换成纯玻璃色：
 * 纯玻璃色会让整排玻璃砖变成同一个颜色的塑料板，混过之后才是「带色的玻璃」，
 * 既认得出是哪一色的砖，又一眼看出它不是实心砖。
 *
 * ⚠️ 三个参数都不是随便填的：
 *   · transparent + opacity 0.6 —— 低于 0.5 就开始能看穿整面墙、读不出体量；
 *   · depthWrite 保持 true —— 关掉它会让玻璃砖的背面透出来，低多边形块会糊成一团；
 *   · shininess 撑到 130 + 近白高光 —— 玻璃与哑光砖的区别几乎全在这道高光上。
 */
export function glassMaterial(color: number, variant = 0): THREE.MeshPhongMaterial {
  const key = `glass|${color}|${variant}`;
  let m = matCache.get(key) as THREE.MeshPhongMaterial | undefined;
  if (!m) {
    const c = new THREE.Color(color);
    if (variant === 1) c.multiplyScalar(1.06);
    else if (variant === 2) c.multiplyScalar(0.94);
    c.lerp(new THREE.Color(ENV.glass), 0.75);
    m = new THREE.MeshPhongMaterial({
      color: c,
      flatShading: true,
      transparent: true,
      opacity: 0.6,
      shininess: 130,
      specular: 0xffffff,
    });
    matCache.set(key, m);
  }
  return m;
}

/** 自发光反馈（粒子 / 彩带 / 落点标记）：不受光，保持「亮块」的读感 */
export function unlit(color: number, opacity = 1): THREE.MeshBasicMaterial {
  const key = `u|${color}|${opacity}`;
  let m = matCache.get(key) as THREE.MeshBasicMaterial | undefined;
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
    if (opacity < 1) m.depthWrite = false;
    matCache.set(key, m);
  }
  return m;
}

/** 炮弹尾迹（每颗炮弹一条，材质可共享） */
export function trailMaterial(): THREE.PointsMaterial {
  let m = matCache.get('trail') as THREE.PointsMaterial | undefined;
  if (!m) {
    m = new THREE.PointsMaterial({ color: ENV.trail, size: 0.2, transparent: true, opacity: 0.55, depthWrite: false });
    matCache.set('trail', m);
  }
  return m;
}

/** 炮口闪光 —— ⚠️ 每帧单独改 opacity，必须独占材质，不能进缓存 */
export function flashMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: ENV.flash,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * 爆发特效的加性材质（爆心闪光 / 冲击波环共用）。
 *
 * ⚠️ 两条都不是随手写的：
 *   · **必须独占**（不进 matCache）—— 每个特效对象逐帧改自己的 opacity 做衰减，
 *     共享材质会让同帧的两个特效一起闪、一起灭；
 *   · **fog: false** —— 加性混合遇到雾是「在雾色之上再加亮」。留着雾的话，
 *     远处（40m+）的爆炸会一边被雾冲淡、一边又被雾色垫亮，最后糊成一团灰白的
 *     雾斑，比近处的爆炸还显眼。加性光本来也不该被大气衰减。
 *   · 同理不加 `depthWrite` —— 加性叠层写深度会把后面的粒子切掉。
 */
export function blastMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

/**
 * 云 —— 必须与砖块 / 岩石用不同的材质策略。
 * ⚠️ 坑：`IcosahedronGeometry` 是**非索引**几何体（每个三角形独占顶点），
 * 所以 `computeVertexNormals()` 永远产出逐面法线、`flatShading` 开关不起作用，
 * 刻面明暗差压不下来。云飘在天上、又高又小，一有强明暗对比就会被读成
 * 「漂浮的岩石」而不是云。低多边形云是靠**剪影 + 极低对比度**成立的，
 * 因此这里加一层自发光把暗面抬起来，让它始终是亮的。
 */
export function cloudMaterial(): THREE.MeshLambertMaterial {
  let m = matCache.get('cloud') as THREE.MeshLambertMaterial | undefined;
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xb8c6d0, flatShading: true });
    matCache.set('cloud', m);
  }
  return m;
}

/**
 * 碎屑 / 彩带 —— ⚠️ 每颗粒子逐帧改自己的 opacity 做淡出，因此**必须独占材质**，不能进缓存。
 * 若图省事用 unlit()，同色的几颗粒子会共享同一个材质实例、整批一起淡出，
 * 看起来就是「一次撞击的碎屑同时消失」，与逐颗衰减的物理感不符。
 * 独占材质由粒子自己 dispose（见 Game.step 的 particles 回收段）。
 */
export function fadeMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false });
}

function cachedGeo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

/* ---------------------------- 4. 几何工厂 ------------------------------ */

/**
 * 倒角砖 —— 低多边形风格的「饼干」块。
 * 用 1 段倒角的挤出体：相邻砖之间自然形成一道暗勾缝。
 * 直角 BoxGeometry 看起来像塑料积木，正是原来那股「原始感」的来源之一。
 * ⚠️ 总尺寸与碰撞盒一致，倒角向内收，视觉尺寸不偏离碰撞体超过 6%。
 */
export function brickGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  return cachedGeo(`brick|${w}|${h}|${d}`, () => {
    const b = Math.min(0.05, Math.min(w, h, d) * 0.12); // 倒角量
    const hw = (w - b * 2) / 2;
    const hh = (h - b * 2) / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-hw, -hh);
    shape.lineTo(hw, -hh);
    shape.lineTo(hw, hh);
    shape.lineTo(-hw, hh);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: d - b * 2,
      bevelEnabled: true,
      bevelSize: b,
      bevelThickness: b,
      bevelSegments: 1, // 只倒一段 ⇒ 保持低多边形
      curveSegments: 1,
    });
    geo.center();
    geo.computeVertexNormals();
    return geo;
  });
}

/** 目标宝石 —— 八面体（顶点朝上）。目标物必须最高明度 + 剪影明确，小屏上才认得出 */
export function gemGeometry(r: number, h: number): THREE.BufferGeometry {
  return cachedGeo(`gem|${r}|${h}`, () => {
    const g = new THREE.OctahedronGeometry(1, 0);
    g.scale(r, h / 2, r);
    g.computeVertexNormals();
    return g;
  });
}

/** 低面数多面体球（炮身、阔叶树冠） */
export function icoGeometry(r: number, detail: number): THREE.BufferGeometry {
  return cachedGeo(`ico|${r}|${detail}`, () => new THREE.IcosahedronGeometry(r, detail));
}

/** 六棱 / 八棱柱 —— 拱柱、底座、炮管、轮子全用它，避免出现光滑圆柱 */
export function prismGeometry(rTop: number, rBottom: number, h: number, sides: number): THREE.BufferGeometry {
  return cachedGeo(`prism|${rTop}|${rBottom}|${h}|${sides}`, () => new THREE.CylinderGeometry(rTop, rBottom, h, sides, 1));
}

/** 玻璃碎片 —— 三棱柱。碎裂时撒一把，棱角比通用碎屑更「锋利」，一眼看出是玻璃碴 */
export function shardGeometry(): THREE.BufferGeometry {
  return prismGeometry(0.055, 0.15, 0.32, 3);
}

/**
 * 冲击波环 —— 三棱管低面数圆环（`radialSegments = 3`）。
 * ⚠️ 为什么不是 RingGeometry（平面圆环）：平面环在近水平的机位上会被压成一条线，
 * 几乎看不见；管状环有厚度，任何角度都读得出来。
 * ⚠️ 为什么 tube 段数取 3：全场景的规矩是「不出现光滑圆柱」（见 prismGeometry），
 * 3 段管的截面是三角形，放大后是刻面的 —— 落在同一个风格里。
 *
 * 半径写 **1**，实际大小全靠 `mesh.scale` 放大 —— 这样冲击波的最大半径
 * 可以精确等于 `EXPLOSION_RADIUS`，玩家看到的边界就是判定边界。
 */
export function ringGeometry(): THREE.BufferGeometry {
  return cachedGeo('blastRing', () => new THREE.TorusGeometry(1, 0.085, 3, 20));
}

/** 尘埃团 —— 二十面体，靠 `mesh.scale` 逐帧放大 + 非等比压扁（走 icoGeometry 缓存） */
export function dustGeometry(): THREE.BufferGeometry {
  return icoGeometry(0.42, 0);
}

/** 低多边形岩石：二十面体 + 顶点扰动（形状固定，靠非等比缩放拉开差异） */
function rockGeometry(r: number): THREE.BufferGeometry {
  return cachedGeo(`rock|${r}`, () => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const rnd = rng(9137);
    for (let i = 0; i < pos.count; i++) {
      const f = 0.78 + rnd() * 0.44;
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.8, pos.getZ(i) * f);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** 远景山脉：五棱锥。⚠️ 绝不能用球体 —— 球体没有剪影特征，是原来「绿色肿块」的根源 */
function mountainGeometry(): THREE.BufferGeometry {
  return cachedGeo('mtn', () => new THREE.ConeGeometry(1, 1, 5, 1));
}

/** 云：不规则的二十面体团，同样不用球体 */
function cloudGeometry(): THREE.BufferGeometry {
  return cachedGeo('cloud', () => {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const rnd = rng(4471);
    for (let i = 0; i < pos.count; i++) {
      const f = 0.85 + rnd() * 0.3;
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.62, pos.getZ(i) * f * 0.85);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** 草叶：三棱锥。三片一簇（靠实例重复堆出簇感） */
function bladeGeometry(): THREE.BufferGeometry {
  return cachedGeo('blade', () => new THREE.ConeGeometry(0.055, 0.55, 3, 1));
}

/* ------------------------- 5. 程序化地面贴图 --------------------------- */

/**
 * 草地 / 沙地的「斑块」贴图（canvas 现场生成，零素材）。
 * 这是让地面脱离「一整块纯色塑料板」的关键：低多边形场景的地面靠色块拼接出细节。
 * 每个斑块都按 3×3 重复绘制，保证贴图四边无缝。
 */
export function groundTexture(kind: 'grass' | 'sand'): THREE.Texture {
  let t = texCache.get(kind);
  if (t) return t;

  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const base = new THREE.Color(kind === 'sand' ? ENV.sand : ENV.grass);
  const rnd = rng(kind === 'sand' ? 2027 : 1109);

  ctx.fillStyle = `#${base.getHexString()}`;
  ctx.fillRect(0, 0, S, S);

  // 明暗两族色阶：朝白两档、朝暖暗两档
  const tones: string[] = [];
  for (const [target, t1, t2] of [
    [new THREE.Color(0xffffff), 0.07, 0.13],
    [new THREE.Color(0x6b5a3a), 0.06, 0.12],
  ] as [THREE.Color, number, number][]) {
    for (const amt of [t1, t2]) tones.push(`#${base.clone().lerp(target, amt).getHexString()}`);
  }

  for (let i = 0; i < 150; i++) {
    const cx = rnd() * S;
    const cy = rnd() * S;
    const n = rnd() < 0.45 ? 4 : 3;
    const rad = 9 + rnd() * 24;
    const a0 = rnd() * Math.PI * 2;
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const a = a0 + (k * Math.PI * 2) / n + (rnd() - 0.5) * 0.6;
      const rr = rad * (0.55 + rnd() * 0.7);
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    ctx.fillStyle = tones[(rnd() * tones.length) | 0];
    // 3×3 平移绘制 ⇒ 跨边界的斑块在另一侧接上，贴图重复时看不见缝
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        ctx.beginPath();
        pts.forEach(([px, py], k) => (k ? ctx.lineTo(cx + px + ox, cy + py + oy) : ctx.moveTo(cx + px + ox, cy + py + oy)));
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // 细颗粒：远看是草皮的绒感，近看是碎点
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 320; i++) {
    ctx.fillStyle = tones[(rnd() * tones.length) | 0];
    ctx.fillRect(rnd() * S, rnd() * S, 1.6, 1.6);
  }
  ctx.globalAlpha = 1;

  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.magFilter = THREE.NearestFilter; // 保持色块边界清晰（低多边形的「拼块」感）
  t.anisotropy = 4;
  texCache.set(kind, t);
  return t;
}

/* ------------------------------ 6. 天空 ------------------------------- */

/** 天空：三段渐变（顶 / 中 / 地平线）+ 朝阳方向的暖光晕。日盘在相机背后，不入画 */
function makeSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(ENV.skyTop) },
      mid: { value: new THREE.Color(ENV.skyMid) },
      horizon: { value: new THREE.Color(ENV.skyHorizon) },
      glow: { value: new THREE.Color(ENV.keyLight) },
      sunDir: { value: new THREE.Vector3(0.52, 0.34, 0.78).normalize() },
    },
    vertexShader:
      'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 glow; uniform vec3 sunDir;
      varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, -1.0, 1.0);
        vec3 col = mix(mid, top, pow(clamp(h, 0.0, 1.0), 0.8));
        col = mix(col, horizon, exp(-abs(h) * 7.0));
        float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += glow * pow(d, 7.0) * 0.16;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const geo = new THREE.SphereGeometry(400, 24, 16);
  loose.push(material, geo);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

/* ---------------------------- 7. 光照台 ------------------------------- */

function addLights(scene: THREE.Scene, low: boolean): THREE.PointLight {
  // 半球光：天光冷、草地反弹暖，负责把暗部从死黑里拉起来
  scene.add(new THREE.HemisphereLight(ENV.hemiSky, ENV.hemiGround, 0.55));

  // 主光（带投影）：从相机右后上方斜射，影子朝远处倒 —— 砖墙的结构靠影子才读得出来
  const key = new THREE.DirectionalLight(ENV.keyLight, 1.65);
  key.position.set(26, 42, 18);
  key.castShadow = true;
  key.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  const sc = key.shadow.camera as THREE.OrthographicCamera;
  // 阴影相机对准靶场（而不是原点）：同样的贴图尺寸能换到更锐的影子
  sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 140;
  key.target.position.set(0, 0, -24);
  scene.add(key);
  scene.add(key.target);

  // 补光（不投影）：从靶场方向偏冷地扫回来，把砖块从背景里「切」出来
  const fill = new THREE.DirectionalLight(ENV.fillLight, 0.34);
  fill.position.set(-24, 16, -26);
  scene.add(fill);

  /* 爆炸闪光灯：常驻 + 强度 0，爆炸时由 Game 脉冲点亮。
     ⚠️ intensity 用的是物理单位（decay = 2 ⇒ 照度 ≈ intensity / d²）：
        取 42 意味着「离爆心 2m 处的照度约 10.5」——白天场景的主光是 1.65，
        所以这一下闪光是主光的 6 倍出头：足够把周围的砖全打亮，
        又不至于把整个画面推成一片白（那会盖住「砖被炸飞了没有」这个关键读图）。
     ⚠️ castShadow 保持 false：点光源阴影要渲染 6 面立方体贴图，
        一次性特效付不起这个成本，而且闪光期间本来就该让影子消失。 */
  const blast = new THREE.PointLight(FX.core, 0, 18, 2);
  blast.castShadow = false;
  scene.add(blast);
  return blast;
}

/* --------------------------- 8. 环境点缀 ------------------------------ */

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

function put(
  mesh: THREE.InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
  sx: number,
  sy: number,
  sz: number,
  color?: THREE.Color,
) {
  _p.set(x, y, z);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  _m.compose(_p, _q, _s);
  mesh.setMatrixAt(i, _m);
  if (color) mesh.setColorAt(i, color);
}

/** 把没用到的实例藏到地下（count 是固定的，空实例会留在原点变成一个突兀的道具） */
function hide(mesh: THREE.InstancedMesh, from: number) {
  for (let i = from; i < mesh.count; i++) put(mesh, i, 0, -9999, 0, 0, 0, 0, 0.001, 0.001, 0.001);
}

function commit(mesh: THREE.InstancedMesh) {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

/** 实例化道具：一次绘制调用画出全部同类物体（这是把环境批次压到 10 次以内的手段） */
function instanced(geo: THREE.BufferGeometry, material: THREE.Material, count: number, cast: boolean): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, material, count);
  m.castShadow = cast;
  m.receiveShadow = true;
  m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  return m;
}

/** 环境句柄：换关卡切草地 / 沙地时要换地面贴图并让草叶跟着返青或变干 */
export interface Scenery {
  ground: THREE.Mesh;
  setGround(kind: 'grass' | 'sand'): void;
  /**
   * 爆炸闪光用的点光源。**常驻场景、平时强度为 0**，爆炸时被 Game 脉冲式点亮。
   *
   * ⚠️ 绝不能在爆炸时才 `scene.add(light)`：three.js 的着色器程序是按
   * 「光源数量」缓存的，场上的灯从 3 盏变成 4 盏会让**所有材质重新编译**，
   * 表现在玩家侧就是爆炸当帧卡一下（第一次爆炸尤其明显）。常驻一个强度 0 的灯，
   * 编译只发生一次（构造时），之后只是改数值。
   */
  blastLight: THREE.PointLight;
}

/**
 * 组装整个环境：天空 + 光照 + 地面 + 云 + 远景山脉 + 树 + 岩石 + 草丛。
 * 除天空与地面外全部走 InstancedMesh，整个环境合计约 10 次绘制调用。
 */
export function buildScenery(scene: THREE.Scene): Scenery {
  const low = isLowPowerDevice();
  const blastLight = addLights(scene, low);
  scene.add(makeSky());

  /* --- 地面：600×600 是为了让边缘落在雾的远端之外，否则会看到一块悬空的地板边 --- */
  const groundMat = new THREE.MeshPhongMaterial({ map: groundTexture('grass'), flatShading: false, shininess: 4, specular: 0x0d0d0d });
  const groundGeo = new THREE.PlaneGeometry(600, 600);
  loose.push(groundMat, groundGeo);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  /* --- 云：4 团一组，高度拉开，别全挤在一个平面上 --- */
  const cloudCount = low ? 5 : 7;
  const clouds = instanced(cloudGeometry(), cloudMaterial(), cloudCount * 4, false);
  const crnd = rng(331);
  const cCol = new THREE.Color();
  for (let i = 0; i < cloudCount; i++) {
    const ang = (i / cloudCount) * Math.PI * 2 + crnd() * 0.5;
    const dist = 55 + crnd() * 120;
    const bx = Math.cos(ang) * dist;
    const bz = Math.sin(ang) * dist;
    const by = 34 + crnd() * 20;
    for (let j = 0; j < 4; j++) {
      const r = 5.2 + crnd() * 5.0;
      cCol.setHex(crnd() < 0.5 ? ENV.cloud : ENV.cloudUnder);
      put(clouds, i * 4 + j, bx + (crnd() - 0.5) * 16, by + (crnd() - 0.5) * 3, bz + (crnd() - 0.5) * 8, 0, crnd() * Math.PI, 0, r, r, r, cCol);
    }
  }
  commit(clouds);
  scene.add(clouds);

  /* --- 远景山脉：两带。远带更淡更冷 —— 大气透视是「精致」与「空旷」的分界 --- */
  const bands = [
    { count: 14, rMin: 88, rMax: 112, hMin: 13, hMax: 24, color: ENV.hillNear },
    { count: 16, rMin: 124, rMax: 158, hMin: 18, hMax: 33, color: ENV.hillFar },
  ];
  const mtns = instanced(mountainGeometry(), mat(0xffffff, 0), bands.reduce((a, b) => a + b.count, 0), false);
  const mrnd = rng(5501);
  const mCol = new THREE.Color();
  let mi = 0;
  for (const band of bands) {
    for (let i = 0; i < band.count; i++) {
      const ang = (i / band.count) * Math.PI * 2 + mrnd() * 0.4;
      const dist = band.rMin + mrnd() * (band.rMax - band.rMin);
      const h = band.hMin + mrnd() * (band.hMax - band.hMin);
      const r = h * (1.5 + mrnd() * 0.7);
      mCol.setHex(band.color).multiplyScalar(0.94 + mrnd() * 0.12);
      // 锥底沉到地平线以下一点，避免露出圆锥的底边
      put(mtns, mi++, Math.cos(ang) * dist, h / 2 - h * 0.06, Math.sin(ang) * dist, 0, mrnd() * Math.PI, 0, r, h, r, mCol);
    }
  }
  commit(mtns);
  scene.add(mtns);

  /* --- 树：松树（锥）与阔叶（多面体）两种剪影。中景主力，负责撑出纵深 --- */
  const treeCount = low ? 12 : 26;
  const trunks = instanced(prismGeometry(0.17, 0.24, 1.3, 5), mat(ENV.wood, 0), treeCount, true);
  const pineA = instanced(prismGeometry(0, 1.5, 2.2, 6), mat(ENV.leafDark, 0), treeCount, true);
  const pineB = instanced(prismGeometry(0, 1.1, 1.9, 6), mat(ENV.leafLight, 0), treeCount, true);
  const round = instanced(icoGeometry(1.15, 0), mat(ENV.leafDark, 1), treeCount, true);
  const trnd = rng(7717);
  let tr = 0;
  let pi = 0;
  let ro = 0;
  let guard = 0;
  while (tr < treeCount && guard++ < treeCount * 60) {
    const ang = trnd() * Math.PI * 2;
    const dist = 36 + trnd() * 52;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    if (inLane(x, z)) continue; // 不挡射击走廊
    const sc = 0.66 + trnd() * 0.55;
    put(trunks, tr, x, 0.65 * sc, z, 0, trnd() * Math.PI, 0, sc, sc, sc);
    if (trnd() < 0.55) {
      const s2 = sc * (0.9 + trnd() * 0.25);
      put(pineA, pi, x, 2.1 * sc, z, 0, trnd() * Math.PI, 0, s2, s2, s2);
      put(pineB, pi, x, 3.35 * sc, z, 0, trnd() * Math.PI, 0, s2 * 0.78, s2 * 0.85, s2 * 0.78);
      pi++;
    } else {
      put(round, ro, x, 2.3 * sc, z, 0, trnd() * Math.PI, 0, sc * (1 + trnd() * 0.3), sc * (0.85 + trnd() * 0.3), sc * (1 + trnd() * 0.3));
      ro++;
    }
    tr++;
  }
  hide(pineA, pi);
  hide(pineB, pi);
  hide(round, ro);
  commit(trunks);
  commit(pineA);
  commit(pineB);
  commit(round);
  scene.add(trunks, pineA, pineB, round);

  /* --- 岩石与草丛：近景的尺度参照，让草地不至于空空荡荡 --- */
  const rockCount = low ? 14 : 28;
  const rocks = instanced(rockGeometry(1), mat(ENV.rock, 0), rockCount, true);
  const rrnd = rng(2293);
  const rCol = new THREE.Color();
  let ri = 0;
  let rguard = 0;
  while (ri < rockCount && rguard++ < rockCount * 40) {
    const ang = rrnd() * Math.PI * 2;
    const dist = 11 + rrnd() * 62;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    if (Math.abs(x) < 12 && z < LANE.zMax && z > LANE.zMin) continue; // 近处别挡弹道视线
    const s = 0.42 + rrnd() * 1.1;
    rCol.setScalar(0.86 + rrnd() * 0.28); // 中性明度抖动 —— 色调由材质色负责
    put(rocks, ri++, x, s * 0.3, z, rrnd() * 0.4, rrnd() * Math.PI, rrnd() * 0.4, s, s * 0.72, s, rCol);
  }
  hide(rocks, ri);
  commit(rocks);
  scene.add(rocks);

  const tuftCount = low ? 46 : 92;
  const tufts = instanced(bladeGeometry(), mat(ENV.grass, 0), tuftCount * 3, false);
  const grnd = rng(881);
  const gCol = new THREE.Color();
  for (let i = 0; i < tuftCount; i++) {
    const ang = grnd() * Math.PI * 2;
    const dist = 3.5 + grnd() * 58;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    const s = 0.7 + grnd() * 0.9;
    gCol.setScalar(0.8 + grnd() * 0.42);
    for (let j = 0; j < 3; j++) {
      put(
        tufts,
        i * 3 + j,
        x + (grnd() - 0.5) * 0.5,
        0.24 * s,
        z + (grnd() - 0.5) * 0.5,
        (grnd() - 0.5) * 0.5,
        grnd() * Math.PI,
        (grnd() - 0.5) * 0.5,
        s,
        s,
        s,
        gCol,
      );
    }
  }
  commit(tufts);
  scene.add(tufts);

  /* --- 切地面：换斑块贴图 + 让草叶跟着地面返青 / 变干（改材质色即可，实例色是中性抖动） --- */
  const tuftMat = tufts.material as THREE.MeshPhongMaterial;
  return {
    ground,
    blastLight,
    setGround(kind) {
      groundMat.map = groundTexture(kind);
      groundMat.needsUpdate = true;
      tuftMat.color.setHex(kind === 'sand' ? ENV.dryGrass : ENV.grass);
    },
  };
}

/* --------------------------- 9. 资源回收 ------------------------------ */

/**
 * 收口所有缓存资源。只在 Game.dispose() 里调用。
 * ⚠️ 缓存是共享的，所以别在换关卡 / 删砖块时 dispose 单个 geometry / material。
 */
export function disposeArt(): void {
  for (const m of matCache.values()) m.dispose();
  for (const g of geoCache.values()) g.dispose();
  for (const t of texCache.values()) t.dispose();
  for (const o of loose) o.dispose();
  matCache.clear();
  geoCache.clear();
  texCache.clear();
  loose.length = 0;
}
