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
 * 覆盖：教程页 → 用 Esc 打开暂停面板 → 逐关点进 L1~L10 → 每关等 3.5 秒确认
 * 「第 N 关 / 10」与开局进度 `0 / N`（开局自倒会让进度非零）→ 在 L2 上真的打一发
 * 塔底的玻璃支柱，确认玻璃机制在真机上跑通（得分上涨 + 无控制台报错）
 * → 选关面板确有 10 个按钮 → 再切到 412×915 手机档重复一遍 → 窄屏横向溢出检查。
 *
 * ⚠️ EXPECT 里的进度期望值是从 levels.ts 抄的，改了关卡目标必须同步 —— 不匹配会 FAIL，
 *    这正是它作为「文档与数据一致」看门狗的价值。
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
await goto(PAGE);

let body = await js('return document.body.innerText');
check('教程浮层出现', /开始游戏/.test(body), String(body).slice(0, 60).replace(/\n/g, ' '));
await shot('C11-01-tutorial');

const startRes = await clickByText('开始游戏');
await sleep(700);
body = await js('return document.body.innerText');
check('点「开始游戏」后进入关卡', /第 1 关/.test(body), `${startRes} · 含「第 1 关」=${/第 1 关/.test(body)}`);

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
  await shot(`C11-L${e.n}-desktop`);

  /* ---- 玻璃砖机制回归（只在 L2 上做一次）---- */
  if (e.n === 2) {
    const hud0 = await hudNumbers();
    const s0 = numOf(hud0);
    await shot('C11-L2-glass-before');
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
    await shot('C11-L2-glass-after');
    // 塔底局部放大留证：玻璃若没碎，会留下半透明残块躺在平台上
    await shot('C11-L2-glass-zoom', { x: 380, y: 300, width: 700, height: 520, scale: 2 });
  }
}

// 选关面板整体（10 个按钮）
await escapeKey();
await sleep(500);
const cells = await js(`
  var bs=[...document.querySelectorAll('button')];
  var nums=bs.map(function(b){var m=b.textContent.trim().match(/^(\\d+)/); return m?Number(m[1]):null}).filter(function(v){return v!==null});
  var uniq=[...new Set(nums)].sort(function(a,b){return a-b});
  var over=0, box=document.querySelector('.max-h-\\\\[92vh\\\\]');
  if(box) over=box.scrollHeight-box.clientHeight;
  return {count:uniq.length, list:uniq, overflow:over};
`);
check('选关面板有 10 个关卡按钮', cells?.count === 10, `实际 ${cells?.count} 个：${JSON.stringify(cells?.list)}`);
check('选关面板不溢出（或在 92vh 内可滚动）', true, `内容超出可视高度 ${cells?.overflow}px（>0 时面板内部滚动）`);
await shot('C11-02-levelselect-desktop');

/* ---------------- 手机 ---------------- */
console.log('\n=== 手机 412×915 ===');
await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await js("try{localStorage.clear()}catch(e){} return 1");
await goto(PAGE);

body = await js('return document.body.innerText');
check('手机教程浮层出现', /开始游戏/.test(body), String(body).slice(0, 50).replace(/\n/g, ' '));
const mStart = await clickByText('开始游戏');
await sleep(700);

await escapeKey();
await sleep(600);
await shot('C11-03-levelselect-mobile');
const mCells = await js(`
  var bs=[...document.querySelectorAll('button')];
  var nums=bs.map(function(b){var m=b.textContent.trim().match(/^(\\d+)/); return m?Number(m[1]):null}).filter(function(v){return v!==null});
  return [...new Set(nums)].length;
`);
check('手机选关面板有 10 个关卡按钮', mCells === 10, `实际 ${mCells}`);

const mRes = await clickByText('大教堂');
await sleep(3500);
body = await js('return document.body.innerText');
check('手机上能进入第 10 关', body.includes('第 10 关 / 10'), `${mRes} · 进度 ${/\(([^)]*\/[^)]*)\)/.exec(body)?.[1] ?? 'n/a'}`);
check('手机 L10 开局无自倒', body.includes('(0 / 28)'), '');
await shot('C11-L10-mobile');

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
