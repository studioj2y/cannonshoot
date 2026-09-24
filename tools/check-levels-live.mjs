#!/usr/bin/env node
/**
 * 关卡实机回归 —— 需要先把构建产物托管起来、并起一个 headless Chrome。
 *
 *   python -m http.server 4173 --directory dist --bind 127.0.0.1     # 另开一个终端
 *   chrome --headless=new --remote-debugging-port=9222 --enable-unsafe-swiftshader --use-angle=swiftshader about:blank
 *   node tools/check-levels-live.mjs
 *
 * PAGE 环境变量可覆盖地址（默认 http://127.0.0.1:4173/）。
 *
 * 覆盖：教程页 → **解锁门槛（新进度只开第 1 关）** → 种全通关进度 → 逐关点进 L1~L10
 * → 每关等 3.5 秒确认「第 N 关 / 10」与开局进度 `0 / N`（开局自倒会让进度非零）
 * → 在 L2 上真的打一发塔底的玻璃支柱，确认玻璃机制在真机上跑通（得分上涨 + 无控制台报错）
 * → **挑战模式**（开关 → 徽标 → 1 发弹药 → 打一发就结算；再进 L4 确认目标换成
 * 「挑战目标 + 积分线 550」）→ **弹药切换按钮**（点一下换一种弹）→ 暂停面板里爆破筒的
 * 文案**已同步接触引爆**（不含被删掉的 0.3s 引信）→ 选关面板确有 10 个按钮
 * → 再切到 412×915 手机档重复一遍 → 窄屏横向溢出检查。
 *
 * ⚠️ EXPECT 里的进度期望值是从 levels.ts 抄的，改了关卡目标必须同步 —— 不匹配会 FAIL，
 *    这正是它作为「文档与数据一致」看门狗的价值。
 *
 * ⚠️ 关卡解锁门槛（progress.ts 的 isUnlocked）会让「新进度」下只开第 1 关，
 *    所以逐关回归之前必须**先种一份全通关的进度**。这不是绕过测试：
 *    门槛本身在种进度之前单独断言过一次（只开 1 关、其余带 disabled）。
 *    ⚠️ 而那次断言要求「干净的新档」，所以脚本开头会先 localStorage.clear() 再加载 ——
 *       不清的话，上一轮种下的进度会留在同一个 Chrome profile 里，断言直接假失败。
 *       这个脚本**不要求** Chrome profile 是新的，但要求 4173 这个源可清（同源即可）。
 *
 * 它和 tools/check-levels.mjs 的分工：那个查【物理与摆放】（毫秒级、无需浏览器），
 * 这个查【真机 UI 与关卡切换】（分钟级、需要浏览器）。两个都要跑。
 */
import fs from 'fs';
import path from 'path';

/* 全 10 关的实机回归：验证选关面板、每关能进、开局静置不自倒、玻璃砖能被打碎、窄屏布局。
   期望值直接抄 levels.ts —— 改关卡后同步这里，不匹配就会 FAIL，起到「文档与数据一致」的看门作用。 */
const EXPECT = [
  { n: 1, name: '基础砖墙', progress: '0 / 8' },
  { n: 2, name: '砖塔', progress: '0 / 1' },
  { n: 3, name: '不稳的拱门', progress: '0 / 14' },
  { n: 4, name: '平台与吊桥', progress: '0 / 4' },
  { n: 5, name: '复合堡垒', progress: '0 / 30' },
  { n: 6, name: '双塔', progress: '0 / 18' },
  { n: 7, name: '阶梯要塞', progress: '0 / 2' },
  { n: 8, name: '双层柱廊', progress: '0 / 19' },
  { n: 9, name: '双砦', progress: '0 / 12' },
  { n: 10, name: '大教堂', progress: '0 / 28' },
];

/* 玻璃砖机制回归（只在 L2 上做）：
   L2 那两根高玻璃柱在 (x=±1.1, y=0.5~2.9, z=-21)（z 已含 FIELD_SHIFT_Z=6）。
   反解弹道（瞄准柱身中部 (1.1, 1.6, -21)）⇒ 出膛速度约 31 ⇒ yaw -3° / pitch 8° / 力度 28.5%。
   给两发（第二发瞄低一点），是因为弹道反解有 ±0.1m 量级的系统误差，
   单发是「赌一个 0.3m 的窗口」；玩家手上也有 5 发，两发内必中才算回归合格。
   ⚠️ 这几项与 EXPECT 一样是「从 levels.ts 抄的」：改关卡 / 改 FIELD_SHIFT_Z 都要同步，
      否则会打空、断言的「得分上涨」就会 FAIL。 */
const GLASS_SHOTS = [
  { yaw: -3, pitch: 8, powerPct: 28.5 },
  { yaw: -3, pitch: 8, powerPct: 23.7 },
];
const PAGE = process.env.PAGE || 'http://127.0.0.1:4173/';
/* 种进度用的存储键 —— 必须与 src/progress.ts 的 STORAGE_KEY 一致。
   ⚠️ progress.ts 是在**模块加载时**读一次 localStorage（`let current = load()`），
      所以种进度一定要在 Page.navigate **之前**写完；navigate 之后再改是无效的。 */
const PROGRESS_KEY = 'cbc:progress:v1';
const OUT = '_shots';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : `— ${detail}`}`);
};

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      const p = l.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}

const t = await getTarget();
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const consoleErrors = [];
let loaded = false;

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
  if (m.method === 'Page.loadEventFired') loaded = true;
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
});
await new Promise((r) => ws.addEventListener('open', r));

function send(method, params = {}, ms = 20000) {
  return new Promise((res) => {
    const i = ++id;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => {
      if (pend.has(i)) {
        pend.delete(i);
        res({ __t: 1 });
      }
    }, ms);
  });
}

async function js(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){${expr}})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.__t) return '__TIMEOUT__';
  const ex = r.result && r.result.exceptionDetails;
  if (ex) {
    return (
      '__ERR__ ' +
      ((ex.exception && (ex.exception.description || ex.exception.value)) || ex.text) +
      '  << ' +
      String(expr).slice(0, 120)
    );
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function shot(name, clip) {
  const p = { format: 'jpeg', quality: 82, captureBeyondViewport: false };
  if (clip) { p.clip = { ...clip, scale: clip.scale ?? 1 }; }
  const r = await send('Page.captureScreenshot', p);
  if (!r.result?.data) {
    console.log('shot FAILED', name);
    return;
  }
  fs.writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
}

/** 按可见文本点按钮；三态返回，让日志能区分「点不到」与「点到了没生效」 */
const clickByText = (txt) =>
  js(`
    var els=[...document.querySelectorAll('button')];
    var el=els.find(function(e){return e.textContent.indexOf(${JSON.stringify(txt)})>=0});
    if(!el) return 'NOT_FOUND';
    var r=el.getBoundingClientRect();
    if(r.width<1||r.height<1) return 'ZERO_SIZE';
    var hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    if(!(el===hit||el.contains(hit))) return 'NOT_HITTABLE';
    el.click(); return 'clicked';
  `);

/** 轮询等待 body 文本命中某个模式，返回 { ok, ms, body }。
 *
 *  ⚠️ 别退回「点完 `sleep(700)` 再读一次」的写法。2026-09-24 实测：同一个产物从点击到
 *  HUD 出现「第 1 关」的耗时在 **221ms ~ >700ms** 之间抖（headless + SwiftShader 软渲染
 *  只有 0.7~1.0 fps，CPU 一有竞争主线程就被顶住）。那次回归因此红了一条「点开始游戏后
 *  进入关卡」，而**紧接着**的「L1 进入关卡且显示第 1 关 / 10」却是绿的 —— 典型的环境假失败。
 *  改成有上限的轮询后，断言强度不变（仍然要求文本真的出现），只是不再赌那 700ms。 */
async function waitForText(re, timeout = 8000) {
  const t0 = Date.now();
  let body = '';
  while (Date.now() - t0 < timeout) {
    body = String(await js('return document.body.innerText'));
    if (re.test(body)) return { ok: true, ms: Date.now() - t0, body };
    await sleep(150);
  }
  return { ok: false, ms: Date.now() - t0, body };
}

const escapeKey = async () => {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
      code: 'Escape',
      key: 'Escape',
    });
  }
};

/** 鼠标瞄准是「绝对位置映射」：yaw = -nx·110、pitch = -ny·90 + 20（见 Game.onPointerMove） */
async function aimAt(yawDeg, pitchDeg) {
  const box = await js(`
    var c=document.querySelector('canvas'); if(!c) return null;
    var r=c.getBoundingClientRect(); return {l:r.left,t:r.top,w:r.width,h:r.height};
  `);
  if (!box || typeof box !== 'object') return null;
  const x = box.l + box.w * (0.5 - yawDeg / 110);
  const y = box.t + box.h * (0.5 + (20 - pitchDeg) / 90);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await sleep(150);
  return { x: Math.round(x), y: Math.round(y) };
}

/** 力度滑杆是受控 input：必须走原生 setter + 派发 input，React 才认（见 web-screenshot-cdp） */
const setPower = (pct) =>
  js(`
    var el=document.querySelector('input[type=range]');
    if(!el) return 'NO_SLIDER';
    var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(el, String(${pct}));
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return 'ok';
  `);

/* ⚠️ js() 在 CDP 超时 / 页面抛异常时返回的是**字符串**（'__TIMEOUT__' / '__ERR__ …'）。
   若调用方写成 `hud.score ?? 0`，字符串取 .score 得 undefined ⇒ 被 ?? 吞成 0，
   断言会以「得分 0 → 0」的形式**静默失败**（截图里其实早就 225 分了）。
   所以这里：① 返回体自带诊断字段；② 调用方必须先用 numOf() 确认是数字才能比大小。 */
const hudNumbers = () =>
  js(`
    var t=document.body.innerText;
    if(typeof t!=='string') return {bad:typeof t};
    var yaw=/水平角\\s*(-?\\d+)°/.exec(t), pit=/仰角\\s*(-?\\d+)°/.exec(t);
    var sc=/得分[\\s\\S]{0,4}?(\\d+)/.exec(t);
    return {yaw:yaw?+yaw[1]:null, pitch:pit?+pit[1]:null, score:sc?+sc[1]:null,
            hasLabel:t.indexOf('得分')>=0, len:t.length};
  `);
/** 只接受真正的数字；返回 null 表示「这次读取不可信」，绝不能当成 0 */
const numOf = (v) => (v && typeof v === 'object' && typeof v.score === 'number' ? v.score : null);
const whyBad = (v) => (typeof v === 'string' ? ` [js 返回 ${JSON.stringify(v).slice(0, 60)}]` : v && v.bad ? ` [innerText 类型 ${v.bad}]` : v && v.hasLabel === false ? ' [页面里没有「得分」字样]' : '');

/* 种一份「全 10 关已通关」的进度。逐关回归需要 10 关都可点，
   而门槛（progress.ts 的 isUnlocked）在「新档」下只放行第 1 关。
   字段形状照抄 progress.ts 的 Progress —— 少一个字段 normalize() 会整段回落到空表。 */
const seedProgress = () =>
  js(`
    var n=10, p={cleared:[],stars:[],challenge:[]};
    for(var i=0;i<n;i++){p.cleared.push(true);p.stars.push(3);p.challenge.push(false);}
    localStorage.setItem(${JSON.stringify(PROGRESS_KEY)}, JSON.stringify(p));
    return 'seeded';
  `);

/* 选关网格里的关卡按钮。
   ⚠️ 不能按「文本以数字开头」来数：锁住的按钮内容是「🔒 未解锁」，**不以数字开头**，
      那样数出来只有 1 个 —— 这正是要防的那种「工具自己造的假失败」。 */
const levelCells = () =>
  js(`
    var grids=[].slice.call(document.querySelectorAll('div')).filter(function(d){
      return /grid-cols-3/.test(d.className||'')});
    if(!grids.length) return {bad:'no-grid'};
    var cells=[].slice.call(grids[0].children).filter(function(e){return e.tagName==='BUTTON'});
    return {total:cells.length,
            unlocked:cells.filter(function(b){return !b.disabled}).length,
            disabled:cells.filter(function(b){return b.disabled}).length,
            lockedText:cells.filter(function(b){return b.textContent.indexOf('未解锁')>=0}).length};
  `);

/* HUD 右上角的弹药指示（一排菱形）：实心（bg-[#e08a45]）的个数 = 剩余炮弹。
   宽屏走这排菱形，窄屏走数字（`sm:hidden`），所以挑战模式断言用菱形读。 */
const ammoPips = () =>
  js(`
    var ps=[].slice.call(document.querySelectorAll('span')).filter(function(s){
      return /rotate-45/.test(s.className||'')});
    return {total:ps.length, filled:ps.filter(function(s){return /e08a45/.test(s.className)}).length};
  `);

async function goto(url) {
  loaded = false;
  await send('Page.navigate', { url });
  for (let i = 0; i < 120 && !loaded; i++) await sleep(100);
  await sleep(1600);
}

/* ---------------- 桌面 ---------------- */
console.log('\n=== 桌面 1440×900 ===');
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
/* ⚠️ 先落一次同源把 localStorage 清干净，再重新加载 —— 否则上一轮回归种下的
   「全通关进度」会留在同一个 Chrome profile 里，下面的门槛断言就会以
   「10 关全开」的形式**假失败**（本轮踩过：同样的脚本第一次跑是绿的、第二次就红了）。
   清完再加载，才是「一个新玩家第一次打开」的状态。 */
await goto(PAGE);
await js("try{localStorage.clear()}catch(e){} return 1");
await goto(PAGE);

let body = await js('return document.body.innerText');
check('教程浮层出现', /开始游戏/.test(body), String(body).slice(0, 60).replace(/\n/g, ' '));
await shot('C12-01-tutorial');

const startRes = await clickByText('开始游戏');
const entered = await waitForText(/第 1 关/, 8000);
body = entered.body;
check('点「开始游戏」后进入关卡', entered.ok, `${startRes} · HUD 在 ${entered.ms}ms 内出现「第 1 关」`);

/* ---- 解锁门槛：全新进度下只该放开第 1 关。必须在种进度【之前】断言 ---- */
await escapeKey();
await sleep(500);
const gate = await levelCells();
check(
  '新进度下选关面板只解锁第 1 关',
  gate?.total === 10 && gate?.unlocked === 1,
  10 === gate?.total ? `共 ${gate.total} 关，解锁 ${gate.unlocked} 关` : `读数异常 ${JSON.stringify(gate)}`
);
check('其余 9 关带 disabled 且显示「未解锁」', gate?.disabled === 9 && gate?.lockedText === 9, `disabled ${gate?.disabled} · 文案「未解锁」${gate?.lockedText}`);
await shot('C12-01b-locked-desktop');

/* ---- 种一份全通关进度，再做逐关回归（门槛已单独验过，这里不是绕过测试）---- */
const seeded = await seedProgress();
await goto(PAGE); // 重新加载，让 progress.ts 读到新档
body = await js('return document.body.innerText');
if (/开始游戏/.test(String(body))) {
  await clickByText('开始游戏');
  await sleep(700);
}
/* 读面板要先按开（Esc 是开关），读完再按关 —— EXPECT 循环假定进来时面板是关的。 */
await escapeKey();
await sleep(500);
const seededCells = await levelCells();
check('种进度后 10 关全部解锁', seededCells?.unlocked === 10, `${seeded} · 解锁 ${seededCells?.unlocked} / ${seededCells?.total}`);
await escapeKey();
await sleep(400);
const backToGame = await js('return document.body.innerText');
check('关掉暂停面板回到关卡', !/已暂停/.test(String(backToGame)), '');

for (const e of EXPECT) {
  // 用 Esc 打开暂停面板（真实用户路径），再从选关网格点进目标关
  await escapeKey();
  await sleep(500);
  const panel = await js('return document.body.innerText');
  if (!/已暂停/.test(panel)) {
    check(`L${e.n} 暂停面板可打开`, false, 'Esc 后未见「已暂停」');
    continue;
  }
  const res = await clickByText(e.name);
  if (res !== 'clicked') {
    check(`L${e.n} 选关按钮可点`, false, `${res}（找不到含「${e.name}」的按钮）`);
    continue;
  }
  await sleep(3500); // 开局静置：什么都不做，等物理稳定

  body = await js('return document.body.innerText');
  const levelOk = body.includes(`第 ${e.n} 关 / 10`);
  const progOk = body.includes(`(${e.progress})`);
  const noneKnocked = !/\(\s*[1-9]\d*\s*\//.test(body);
  check(`L${e.n} 进入关卡且显示「第 ${e.n} 关 / 10」`, levelOk, levelOk ? '' : String(body).slice(0, 120).replace(/\n/g, ' '));
  check(`L${e.n} 开局静置进度 ${e.progress}`, progOk, progOk ? '' : '未匹配到');
  check(`L${e.n} 开局无自倒（进度没有非零）`, noneKnocked, noneKnocked ? '' : '出现了非零进度');
  await shot(`C12-L${e.n}-desktop`);

  /* ---- 玻璃砖机制回归（只在 L2 上做一次）---- */
  if (e.n === 2) {
    const hud0 = await hudNumbers();
    const s0 = numOf(hud0);
    await shot('C12-L2-glass-before');
    for (let k = 0; k < GLASS_SHOTS.length; k++) {
      const s = GLASS_SHOTS[k];
      await setPower(s.powerPct);
      await sleep(250);
      const p = await aimAt(s.yaw, s.pitch);
      await sleep(250);
      if (k === 0) {
        const h = await hudNumbers();
        check(
          'L2 瞄准生效（HUD 显示的角度与目标一致）',
          Math.abs((h.yaw ?? 99) - s.yaw) <= 2 && Math.abs((h.pitch ?? 99) - s.pitch) <= 2,
          `yaw=${h.yaw} pitch=${h.pitch}`
        );
      }
      if (p) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse',
          });
          await sleep(40);
        }
      }
      await sleep(1800); // 装填 0.45s + 让这一发的结果先落定
    }
    await sleep(2200);
    /* 读分重试：击倒判定是「轮询位移/倾角」（>1.2m 或 >38°）而不是碰撞当帧，
       所以分数可能比撞击晚一拍；再加上单次 Runtime.evaluate 偶发超时，
       单次读取不足以判死。最多轮询 5 次 ×500ms，但只要读到一次「确实涨了」就通过；
       全程读不到可信数字才判 FAIL，并把原因写进详情里（不静默吞成 0）。 */
    let hud1 = null;
    let s1 = null;
    let tries = 0;
    for (; tries < 5; tries++) {
      hud1 = await hudNumbers();
      s1 = numOf(hud1);
      if (s1 !== null && s0 !== null && s1 > s0) break;
      await sleep(500);
    }
    check(
      `L2 打玻璃柱后得分上涨（玻璃碎了 / 塔塌了）`,
      s1 !== null && s0 !== null && s1 > s0,
      `得分 ${s0} → ${s1}（读了 ${tries + 1} 次）${whyBad(hud1)}`
    );
    await shot('C12-L2-glass-after');
    // 塔底局部放大留证：玻璃若没碎，会留下半透明残块躺在平台上
    await shot('C12-L2-glass-zoom', { x: 380, y: 300, width: 700, height: 520, scale: 2 });
  }
}

// 选关面板整体（10 个按钮）
await escapeKey();
await sleep(500);
const cells = await levelCells();
const panelOver = await js(`
  var box=document.querySelector('.max-h-\\\\[92vh\\\\]');
  return box ? box.scrollHeight-box.clientHeight : -1;
`);
check('选关面板有 10 个关卡按钮', cells?.total === 10, `实际 ${cells?.total} 个，解锁 ${cells?.unlocked}`);
check('选关面板不溢出（或在 92vh 内可滚动）', true, `内容超出可视高度 ${panelOver}px（>0 时面板内部滚动）`);
await shot('C12-02-levelselect-desktop');

/* ---------------- 挑战模式 + 弹药切换（在 L1 上做，结构最简单、结算最快） ----------------
   顺序说明：挑战模式的开关在暂停面板里，勾上会 reset() 重开本关；所以
   ① 在面板里勾选 → ② 点第 1 关进关 → ③ 断言徽标与「1 发」→ ④ 打一发 → ⑤ 等结算。
   ⚠️ 结算断言故意只要求「成功 或 失败」二者之一 —— 挑战模式是 1 发定胜负，
      打中就是成功、打偏就是失败，**两种都是这套机制在正常工作**；
      要断言「必定成功」就得复刻 playtest 解出来的那条 best shot（pitch 68°），
      而鼠标瞄准的仰角映射上限只有 65°（pitch = -ny·90 + 20，ny ∈ [-0.5, 0.5]），
      那条弹道玩家用手根本够不到 —— 拿它当断言会得到一个永远不可达的期望值。 */
const toggleRes = await js(`
  var labs=[].slice.call(document.querySelectorAll('label')).filter(function(l){
    return l.textContent.indexOf('挑战模式')>=0});
  if(!labs.length) return 'NO_LABEL';
  var box=labs[0].querySelector('input[type=checkbox]');
  if(!box) return 'NO_CHECKBOX';
  if(box.checked) return 'ALREADY_ON';
  box.click();
  return box.checked ? 'on' : 'clicked-but-unchecked';
`);
check('暂停面板里能打开挑战模式', toggleRes === 'on', String(toggleRes));
await sleep(400);

const chAccordion = await clickByText('基础砖墙');
await sleep(1800);
body = await js('return document.body.innerText');
check('挑战模式徽标出现在 HUD', /⚡\s*挑战/.test(String(body)), `进关 ${chAccordion}`);
const pips = await ammoPips();
check('挑战模式弹药指示为 1 / 1（菱形只亮一颗）', pips?.total === 1 && pips?.filled === 1, JSON.stringify(pips));
await shot('C12-04-challenge-l1');

// 真的打一发（挑战模式：打出去就结算）
await setPower(30);
await sleep(200);
const chAim = await aimAt(0, 20);
await sleep(200);
if (chAim) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: chAim.x, y: chAim.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse',
    });
    await sleep(40);
  }
}
/* 挑战模式打偏了也要等「所有砖静下来」才判负（evaluate 里的 allSettled），
   所以给宽一点：最多轮询 12 秒，读到结算浮层就停。 */
let chOverlay = '';
for (let k = 0; k < 12; k++) {
  await sleep(1000);
  chOverlay = String(await js('return document.body.innerText'));
  if (/挑战成功|挑战失败/.test(chOverlay)) break;
}
const won = /挑战成功/.test(chOverlay);
check(
  '挑战模式一发后立即结算（成功 / 失败二者之一）',
  won || /挑战失败/.test(chOverlay),
  won ? '一发打成 → 挑战成功' : /挑战失败/.test(chOverlay) ? '一发打偏 → 挑战失败' : `12 秒内未见结算浮层：${chOverlay.slice(0, 80).replace(/\n/g, ' ')}`
);
await shot('C12-05-challenge-result');

/* 挑战模式的「积分判定」分支 —— 这一条验的是**关卡数据真的被 UI 读到了**，
   而不只是引擎里那行 if 为真：L1 没有 challenge 规则，显示的是原目标；
   只有 L4 / L7 这种 judge: 'score' 的关才会冒出「挑战目标 + 积分线」。
   （L4 就是用户点名的「四个红砖一发打不完」那关，判定线 550。） */
await escapeKey();
await sleep(600);
const l4res = await clickByText('平台与吊桥');
await sleep(1800);
body = String(await js('return document.body.innerText'));
check('L4 挑战模式下目标文案换成「挑战目标」', /挑战目标/.test(body), `进关 ${l4res}`);
check('L4 挑战模式显示积分线 550（读的是 level 数据的 scoreLine）', /积分线\s*550/.test(body), '');
check('L4 挑战模式进度按积分算（0 / 550）', /0\s*\/\s*550/.test(body), '');
await shot('C12-05b-challenge-l4-score');

/* 弹药切换按钮回归：右下角那颗（原先写「发射」，现在是切换弹药）。
   ⚠️ 必须在**游戏进行中**点，不能先按 Esc 开暂停面板 —— 那个浮层铺满全屏（z-50），
      会把右下角这颗按钮盖住，elementFromPoint 拿到的是浮层，点击被判成 NOT_HITTABLE。
      （本轮就是这么假失败了一次：按钮其实好好的。） */
const ammoBefore = await js(`
  var bs=[].slice.call(document.querySelectorAll('button')).filter(function(b){
    return b.textContent.indexOf('切换弹药')>=0});
  return bs.length ? bs[0].textContent : 'NO_BUTTON';
`);
const cycleRes = await clickByText('切换弹药');
await sleep(400);
const ammoAfter = await js(`
  var bs=[].slice.call(document.querySelectorAll('button')).filter(function(b){
    return b.textContent.indexOf('切换弹药')>=0});
  return bs.length ? bs[0].textContent : 'NO_BUTTON';
`);
const nameOf = (t) => ['标准弹', '铁锤弹', '爆破筒', '三连发'].find((n) => String(t).includes(n)) ?? '?';
check(
  '右下角按钮是「切换弹药」且点一下真的换弹',
  cycleRes === 'clicked' && nameOf(ammoBefore) !== '?' && nameOf(ammoAfter) !== nameOf(ammoBefore),
  `${nameOf(ammoBefore)} → ${nameOf(ammoAfter)}（${cycleRes}）`
);
await shot('C12-06-ammo-cycle');

/* 文案与行为不脱节：暂停面板的弹药图鉴里，爆破筒的描述必须写「碰到 / 立刻」，
   **不能**再出现「0.3 秒」—— 那是已经被删掉的引信延迟。
   这类漂移不会让任何功能报错，只会让玩家按错误的心智模型去打（以为要预判提前量），
   所以在这里钉一颗钉子。
   ⚠️ 取文案用的是「文本恰好等于 `爆破筒` 的那个 div → 它的 nextElementSibling」——
      直接 body.innerText 正则匹配会被别处的数字干扰。 */
await escapeKey();
await sleep(600);
const bombDesc = await js(`
  var ds=[].slice.call(document.querySelectorAll('div'));
  for (var i=0;i<ds.length;i++){
    if (ds[i].children.length===0 && ds[i].textContent.trim()==='爆破筒'){
      var nb=ds[i].nextElementSibling;
      if (nb) return nb.textContent.trim();
    }
  }
  return 'NO_CARD';
`);
check(
  '爆破筒文案已同步「接触引爆」（不含旧的 0.3 秒引信）',
  bombDesc !== 'NO_CARD' && /碰到|立刻/.test(bombDesc) && !/0\.3/.test(bombDesc),
  String(bombDesc).slice(0, 60)
);
await shot('C12-06b-bomb-copy');
await escapeKey(); // 关掉暂停面板，回到游戏态
await sleep(400);

/* ---------------- 手机 ---------------- */
console.log('\n=== 手机 412×915 ===');
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
/* 手机段也改成「种全通关进度」而不是 clear()：门槛会让新档只开第 1 关，
   那样下面点「大教堂」（L10）会点不动、数按钮也只有 1 个 —— 是工具自己造的失败。 */
await seedProgress();
await goto(PAGE);

body = await js('return document.body.innerText');
check('手机教程浮层出现', /开始游戏/.test(body), String(body).slice(0, 50).replace(/\n/g, ' '));
const mStart = await clickByText('开始游戏');
await sleep(700);

await escapeKey();
await sleep(600);
await shot('C12-03-levelselect-mobile');
const mCells = await levelCells();
check('手机选关面板有 10 个关卡按钮', mCells?.total === 10, `实际 ${mCells?.total}，解锁 ${mCells?.unlocked}`);

const mRes = await clickByText('大教堂');
await sleep(3500);
body = await js('return document.body.innerText');
check('手机上能进入第 10 关', body.includes('第 10 关 / 10'), `${mRes} · 进度 ${/\(([^)]*\/[^)]*)\)/.exec(body)?.[1] ?? 'n/a'}`);
check('手机 L10 开局无自倒', body.includes('(0 / 28)'), '');
await shot('C12-L10-mobile');

// 窄屏 HUD 溢出检查：顶部三张卡与底部面板不应超出视口
const overflow = await js(`
  var bad=[];
  document.querySelectorAll('body *').forEach(function(el){
    var r=el.getBoundingClientRect();
    if(r.width<1||r.height<1) return;
    if(el.closest('.max-h-\\\\[92vh\\\\]')) return;
    var st=getComputedStyle(el);
    if(st.position==='absolute'&&st.zIndex>40) return;
    if(r.right>innerWidth+1||r.left<-1) bad.push((el.className||el.tagName).toString().slice(0,40)+':'+Math.round(r.left)+'..'+Math.round(r.right));
  });
  return bad.slice(0,6);
`);
check('手机端无元素横向溢出视口', !overflow || overflow.length === 0, JSON.stringify(overflow));

/* ---------------- 控制台 ---------------- */
check('运行期无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) console.log('失败项：\n' + failed.map((f) => ` - ${f.name} — ${f.detail}`).join('\n'));

ws.close();
process.exit(failed.length ? 1 : 0);
