# HANDOVER — 交接说明

> 给下一位接手这个项目的开发者（或下一个 AI 会话）。
> `README.md` 讲「现在是什么」，本文件讲「为什么长这样、改哪里会出事」。
> 最后更新：2026-09-23

---

## 1. 五分钟上手

代码只有 8 个文件、约 1800 行。**按这个顺序读**：

| 顺序 | 文件 | 读它的目的 |
|---|---|---|
| 1 | `src/game/levels.ts` | 先看数据。5 关长什么样、`wall/tower/arch` 三个工厂怎么拼关卡，读完就有大概画面 |
| 2 | `src/i18n.ts` | 再看文案。所有界面文字的中英对照、语言状态怎么存、关卡目标文案怎么拼出来 |
| 3 | `src/App.tsx` | 再看 UI。HUD 有哪些字段、有几个浮层、UI 反向下发调了哪几个方法、窄屏怎么精简 |
| 4 | `src/game/Game.ts` | 最后看引擎。先读 `constructor`（装配）→ `reset()`（初始化）→ `step()`（每帧）→ `finish()`（结算），其余都是细节；**输入在 `// ---------- input ----------` 一节，鼠标与触控都在那里** |
| 5 | `src/game/audio.ts` | 独立小模块，10 分钟看完，不用记 |

没有测试、没有构建脚本之外的工程化设施。想验证就 `tsc --noEmit` + 手动跑。

---

## 2. 引擎是怎么组织的

`Game` 是一个「一个类装下整个游戏」的写法（829 行），内部分四块，靠注释分隔：

```
buildEnvironment()   天空球 / 半球光 / 平行光+阴影 / 云 / 地面 / 远山
buildCannon()        炮台（球身+底座+轮子+炮管+炮口闪光）→ this.cannon / this.barrel / this.muzzle
loadLevel(i) → reset()   清场 → 按关卡数据建砖 → 重置状态
fire()               生成炮弹刚体 + 拖尾 + 枪口特效
checkKnocked()       每帧扫描砖块，判定是否"被砸倒"并计分
objectiveDone() / objectiveProgress() / evaluate() / finish()   目标与结算
animate → step(dt) → render()
```

### 帧序（`step()` 里的执行顺序，很重要）

```
1. 键盘瞄准（WASD/QE，仅在 status === 'playing' 时生效）
2. 装填冷却倒计时
3. world.step(1/60, dt, 4)          ← 物理推进
4. 砖块：限速 → 同步网格 → y<-30 则 sleep
5. 炮弹：同步网格 → 更新拖尾 → 判超时/越界回收
6. 粒子：积分 → 淡出 → 到期回收
7. 炮口闪光淡出
8. checkKnocked()                    ← 判定与计分
9. evaluate(dt)                      ← 胜负判定
10. updateTrajectory()               ← 预测虚线
11. pushHud()                        ← 推给 React
```

`render()` 单独负责：炮台朝向同步、第一人称相机跟随（`lerp 0.25`）、震屏、`renderer.render()`。

> 顺序上前 7 步属于「世界推进」，8~9 步属于「规则判定」，10~11 步属于「呈现」。加新功能时先想清楚它属于哪一段，不要插在物理步进之前。

### 输入层：一套 Pointer Events，两种玩法

输入**全部**走 Pointer Events（`onPointerDown / Move / Up / Cancel`，绑在 canvas 上），在同一个处理函数里按 `e.pointerType` 分流。
之所以不mouse/touch 各绑一套：触摸会派生**兼容鼠标事件**，同时绑 `mousedown` 与 `pointerdown` 会让一次按住开出两炮。

| | 鼠标 / 触控笔 | 触控（`pointerType === 'touch'`） |
|---|---|---|
| 何时改视角 | `pointermove` 随时 | **只在按住时** |
| 怎么算角度 | **绝对映射**：指针在屏上的位置决定角度 | **相对位移**：`dx/dy × 灵敏度` 累加到当前角度 |
| 按下瞬间 | 视角跳到指针对应位置 | 视角**不动**，从当前角度接着转 |
| 何时发射 | `pointerdown` 即发射 | `pointerup`（松手）发射 |

> 触控必须用相对位移：手指落点几乎不可能是「当前角度对应的屏幕位置」，用绝对映射会按下即瞬移，没法瞄。

配套的五个细节，缺一个都会出问题：

1. **`el.style.touchAction = 'none'`** —— 不设的话浏览器把拖动当滚动/缩放，中途发 `pointercancel`，瞄准直接断掉。
2. **`setPointerCapture(pointerId)`** —— 手指滑出画面再松开也能收到 `pointerup`；否则那一发永远打不出去，且 `aiming` 卡在 `true`。
3. **`pointercancel` 只退出瞄准、不发射** —— 来电、系统手势、切 App 都走这条。
4. **多指只认第一根**（`aimPointer` 存 `pointerId`）—— 第二根手指既不打断瞄准也不误发。
5. **`canFire()` 门槛** —— 装填冷却中 / 没弹药 / 已结算时不进瞄准态，避免「按半天、松手是空响」。

另外：`onPointerDown` 先判 `e.target !== renderer.domElement`（按到 HUD 面板不发射）；`reset()` 与 `dispose()` 都会调 `endAim()`，防止状态卡住。

### 状态机

两套状态，分属两侧，**别混**：

| 状态 | 归属 | 取值 | 谁控制 |
|---|---|---|---|
| `status` | `Game` | `playing` / `won` / `lost` | 只有 `evaluate()` → `finish()` 能改 |
| `paused` | `Game`（值来源是 React） | bool | `App` 通过 `game.paused = paused \|\| tutorial` 下发 |
| `paused` / `tutorial` | `App`（`useState`） | bool | 用户点击 / Esc |

暂停时 `animate()` 里 `if (!this.paused) this.step(dt)` —— 物理、输入、HUD 全部冻结，但 `render()` 照跑（所以暂停后画面仍在刷新、不会黑屏，也不会卡住轨迹线）。

---

## 3. 三类运行期对象（改代码前必看）

| 对象 | 数组 | 谁的 mesh 挂在哪 | 谁的 body 在哪 | 销毁 |
|---|---|---|---|---|
| 砖块 `Brick` | `this.bricks` | `this.levelGroup` | `world` | `reset()` 里逐个 `removeBody` + `remove(levelGroup)` + `dispose(geometry)` |
| 炮弹 `Ball` | `this.balls` | `this.scene` | `world` | `removeBall(b)`（`world.removeBody` + `scene.remove` mesh/trail + `dispose`） |
| 粒子 / 彩带 | `this.particles` | `this.scene` | 无（纯视觉，不受物理） | 到期回收，或 `reset()` 里整批清 |

### ⚠️ 陷阱一：`for...of` 遍历数组时不能边遍历边 `splice`

**这是本项目唯一踩过的真 bug**（2026-09-23 修复）：

```ts
// ❌ 错误：removeBall 内部会 splice(this.balls)，游标会跳过一半元素
for (const b of this.balls) this.removeBall(b);

// ✅ 正确：迭代副本
for (const b of [...this.balls]) this.removeBall(b);
```

后果不是崩溃，而是**静默泄漏**：漏掉的炮弹既留在物理世界里继续碰撞，又留在场景里不再同步网格（变成一颗冻结在原地的黑球）。这类 bug 只在「重开时有 2 颗以上炮弹在飞」才复现，很容易漏测。

`step()` 里的炮弹循环本来就用的是 `[...this.balls]` 副本，`reset()` 当时漏改了。**以后凡是「遍历 + 可能删除」的循环，一律先取副本。**

### ⚠️ 陷阱二：`reset()` 里清粒子的循环同样建议取副本

```ts
for (const p of this.particles) { this.scene.remove(p.mesh); p.mesh.geometry.dispose(); }
```

当前它不 splice，所以没有 bug，但「整批清理」却写成逐个删的写法本身就是下次改动的雷。

### ⚠️ 陷阱三：`pushHud()` 是每帧调用的

`step()` 末尾每帧都推一次 HUD 快照。`App` 侧用 `JSON.stringify` 比对做短路，只有内容真变了才 `setState`。所以：

- 往 `HudState` 里加字段时，**不要加每帧都在变的浮点数**（比如 `body.position.x`），否则会退化成每帧触发 React 重渲染。
- `combo` 字段目前是 `performance.now() < comboUntil ? comboCount : 0`，值在连击窗口内稳定，没问题。

### ⚠️ 陷阱四：`groundMesh` 是塞在 `this` 上的非声明字段

`buildEnvironment()` 里用 `(this as any).groundMesh = ground` 存，`reset()` 里再取出来改颜色（草地/沙地）。这是绕过类型检查的写法，IDE 找不到引用。要清理的话建议正规声明成一个 `private groundMesh!: THREE.Mesh`。

### ⚠️ 陷阱五：字段声明位置在方法之后也没关系（但别被误导）

`muzzle!: THREE.Mesh` 声明在 `buildCannon()` 之后。因为类字段总是在**构造器函数体之前**按声明顺序初始化，而 `buildCannon()` 是在构造器体里调的，所以不会被覆盖成 `undefined`。看起来像 bug，实际安全，不要「顺手修」。

### ⚠️ 陷阱六：摆砖的底面必须正好落在支撑面上（2026-09-23 全项目整改）

**这是 `levels.ts` 里最容易犯、后果最重、且完全没有报错的错误。** 每块非静态砖的底面必须**恰好**落在某个支撑面上：地面 `y=0`、静态平台的**顶面**、下方砖块的顶面、或构件工厂的顶面。既不能悬空，也不能埋进去。

- **悬空** → 求解器让它自由落体，落地冲击把周围结构一起掀翻
- **埋入** → 求解器要把重叠顶出来，同样掀翻整座结构

两者都会在开局白送击倒数。L5 曾因此**开局 0.5 秒自动胜利**（31/55 块被判击倒，而目标只要 30）。五个关卡整改前的开局自倒数：L1 `1/24`、L3 `4/24`、L4 `3/18`、L5 `31/55`。

各工厂的高度推导（`levels.ts` 顶部注释里有同一份速查）：

```
static 平台顶面 = pos.y + size.y / 2
tower(y0)  支柱底 = y0，每层净高 1.5，顶面 = y0 + layers × 1.5
arch(y0)   柱底   = y0，顶梁顶面 = y0 + cols × 0.9 + 0.4   (cols = round(h / 0.9))
wall(y0)   底砖底 = y0，每层净高 bh（垂直方向不留缝）
```

**`tower()` / `arch()` 现在都接 `y0` 参数** —— 放到平台上时必须传平台顶面高度，否则它们会从 `y=0` 起建、柱底埋进平台。加关卡加构件前，先按上面的公式算一遍。

两个衍生坑（都在 `wall()` 里踩过，现已修正）：

- **层间不能留缝**：行距取 `bh`，砖高也必须取满 `bh`。曾经砖高写 `bh * 0.95`，每层 0.04 的缝让整面墙微沉，横向扰动足以把最外侧那块砖晃到 39°（判定阈值 38°）→ 白送 1 块进度。水平方向仍留 3% 缝防穿插。
- **错缝要半砖收边**：奇数层不能把整砖整体平移半块 —— 那样每层两端各凸出半块，而这半块**正下方是空的**，开局 0.6 秒自己倾覆。正确做法是「两端半砖 + 中间 `cols-1` 块整砖」，上下层外轮廓逐毫米对齐。

### ⚠️ 陷阱七：相机**不能**沿 `aimDir` 后退（2026-09-23 修复）

```ts
// ❌ 错误：aimDir 带 sin(pitch)，仰角越高相机越矮
const camPos = cannon.position.clone().addScaledVector(dir, -6.5).add(new THREE.Vector3(0, 2.6, 0));
//                                   ↑ 沿瞄准方向后退          ↑ 再加个固定高度，救不回来

// ✅ 正确：水平后退 + 固定离地高度
const back = dir.clone().setY(0).normalize();
const camPos = cannon.position.clone().addScaledVector(back, -CAM_BACK).add(new THREE.Vector3(0, CAM_HEIGHT, 0));
```

旧写法下相机高度随 `sin(pitch)` 下沉：22°（默认）时 y=1.77，40° 时 0.02（贴地），75° 时 **−2.08（钻到地面以下）**，同时水平距离从 6.5 缩到 1.68。结果默认视角里炮身横在画面中央，把砖墙和轨迹线全部挡住（L1 遮挡率 100%）。

现取 `CAM_BACK = 5.5`、`CAM_HEIGHT = 3.4`，射线检测实测 0°~75° 全仰角遮挡率 0%，相机不再入地。选 3.4 的依据：`height` 从 2.2 提到 3.4 就够；再抬高只是让炮台更快退出画面，而**炮身露出比例几乎不随相机高度变化（28%→20%）**，代价极小。

### ⚠️ 陷阱八：`barrel.rotation.x` 的符号（2026-09-23 修复）

`barrel.rotation.x = -THREE.MathUtils.degToRad(this.pitch)` 多了一个负号，导致炮管的**视觉朝向和弹道方向相反**：pitch 22° 时炮口世界 y=0.33（应为 2.87），炮管朝下 22° 而炮弹朝上 22°，差 44°。去掉负号即可。

这个 bug 一直存在，只是长期被陷阱七掩盖 —— 相机一修好、炮身完整露出来，它立刻显形。**改动朝向类旋转量后，务必核对「炮口世界坐标」与「实际弹道方向」是否同向**（用 `muzzle.getWorldPosition()` 对比 `aimDir`，不要只看画面觉得「差不多」）。

---

## 4. 常见改动怎么做

### 加一关

改 `src/game/levels.ts` 的 `LEVELS` 数组，加一个 `LevelDef`：

```ts
{
  name: { zh: '关卡名', en: 'Level Name' },   // 中英对照，见 i18n.ts 的 LocalizedText
  hint: { zh: '一句提示', en: 'A hint' },     // ⚠️ 已备好中英文，但当前 UI 没有渲染它（预留字段）
  ammo: 5,
  targetScore: 2000,
  twoStarAmmoLeft: 2,            // 现有 5 关全是 2
  ground: 'grass' | 'sand',
  objective: { kind: 'knockCount', count: 10 },   // ⚠️ 没有 text 字段了，文案由 objectiveText() 拼
  bricks: [...wall(...), ...tower(...)],
}
```

`App.tsx` 的暂停面板用 `grid-cols-5` 排关卡按钮，**加到第 6 关需要同步改网格列数**。

> ⚠️ **别把目标文案写回关卡数据里。** 早先 `Objective` 有个 `text: string` 字段，是手写的英文句子，和 `count` 是两个独立数字 —— 改了 `count` 忘了改 `text` 就会出现「数据是打 12 块、界面上写着 8 块」的静默不一致。现在文案统一由 `i18n.ts` 的 `objectiveText(objective, lang)` 按 `kind / count / color` 现场拼，从结构上排除了这种漂移。

### 改关卡摆放 / 加构件（**先读陷阱六，别跳**）

`levels.ts` 里摆每一块砖、加每一个构件，都要满足「**底面 = 某个支撑面**」。改完**必须跑一遍开局静置验证**：

```bash
node --experimental-strip-types --no-warnings _phys.mjs 6   # 临时脚本，见下
```

它做的事是：用 `levels.ts` 的真实数据建 cannon-es 世界，**不发射任何炮弹**，空跑 6 秒，然后逐块报告位移与倾角是否越过击倒阈值。**任何一关的非零自倒数都是 bug**，不是「手感问题」——它意味着开局就白送进度（L5 曾因此直接开局胜利）。

同类检查还有个几何版（不跑物理，快得多）：逐块算「底面高度」并检查下方是否有支撑体，能抓出悬空与埋入。物理版更权威，几何版更适合改一次跑一次。

> 这两个脚本项目里**没有留档**（用一次就删）。要重建的话，核心是照抄 `Game.ts` 里 `addBrick()` 的 `Shape` 与接触材质映射，以及 `checkKnocked()` 的阈值（位移 1.2 / 倾角 38°）。

### 加一门语言 / 改文案

- **改现有文案**：只动 `src/i18n.ts` 的 `UI` 对象（界面文字）与 `COLOR_ZH`（颜色词）。`levels.ts` 里的 `name` / `hint` 也在各自关卡上。
- **加一门语言**：① `Lang` 联合类型加字面量；② `UI` 里补一个同名 key 的完整对象（TS 会强制你补齐，缺字段直接编译不过）；③ `COLOR_ZH` 补颜色词；④ `App.tsx` 的 `LangSwitch` 里加一个选项（标签用该语言自己的写法，如 `日本語`）；⑤ `i18n.ts` 的 `load()` 里放行新的存储值。
- **文案不要分散写进组件**：`App.tsx` 里只允许出现 `s.xxx` 取值，不写裸字符串。否则加语言时会漏。
- **引擎不参与翻译**：`Game.ts` 不 import `i18n.ts`，它只传 `level` 序号与 `objectiveProgress`（纯数字）。这样切语言时界面立刻更新，不会出现「引擎里还残留上一门语言」的中间态。

### 加一种砖块形状

要改三处，缺一处就运行时炸：

1. `levels.ts` 的 `BrickShape` 联合类型
2. `Game.ts` 的 `addBrick()` —— 同时给出 three 的 `BufferGeometry` **和** cannon 的 `Shape`（例如 `wedge` 目前只在类型里声明了，`addBrick()` 里没有分支，会走 `else` 当 box 处理）
3. 若是新颜色，`COLORS` 里加色值

注意 `size` 语义不统一：**box 是完整尺寸 `[w,h,d]`；cylinder 是 `[radius, height, radius]`（第三个被忽略）**。`levels.ts` 里的注释对此也含糊，改动时以 `addBrick()` 的实际读取为准。

### 调物理手感

所有可调常量集中在 `Game.ts` 顶部：

```ts
const GRAVITY = -19.6;     // 比真实重力大一倍，为了"砸得爽"
const MAX_SPEED = 90;      // 砖块线速度上限，防止穿透
const MIN_POWER = 20;
const MAX_POWER = 60;
const CAM_BACK = 5.5;      // 相机水平后退距离（⚠️ 别改成沿瞄准方向后退，见陷阱七）
const CAM_HEIGHT = 3.4;    // 相机离地高度（决定炮身露多少、挡不挡目标）
```

接触材质在 `constructor` 里集中声明（地面/砖/球两两组合的摩擦与弹性）。**加重力或调力度范围之后，一定要复查 L2 的塔是否还能被一炮推倒** —— 那关是手感最敏感的标定关。

---

## 5. 验证手段

这个项目**没有自动化测试**，验证靠三步：

```bash
npx tsc --noEmit        # 类型（当前 0 错误；vite build 不做类型检查，必须单独跑）
npm run build           # 构建（确认单文件产物仍能生成）
npm run dev             # 手动过一遍
```

手动回归清单（改引擎后建议全过一遍）：

1. 教程页 → 开始游戏 / START PLAYING 能进游戏
2. 鼠标瞄准、WASD、Q/E、滚轮、滑杆五种输入都生效
3. 连开 2~3 炮后按 `R` —— **场上不应残留任何冻结的黑球**（这是 2026-09-23 那个 bug 的复现步骤，以后每次动 `reset()` 都要测）
4. 打到目标 → 等结算浮层出现，星星数量正确
5. 打光弹药未达成目标 → 失败浮层出现（注意可能要等最多 9 秒，见 README 待办）
6. `Esc` 暂停 → 选关 → 切换关卡不残留上一关的砖
7. 缩放窗口，canvas 跟随
8. **语言切换**：首页点 `English` → 教程页 / HUD / 暂停页 / 胜负页**四处文案应同时变英文且无中文残留**；切回 `中文` 同样；刷新页面语言应记住；`<html lang>` 与标签页标题跟着变
9. **手机触控**（DevTools 设备模拟或直接上手机）：按住画面 → 准星放大变黄 + 出现「瞄准中 · 松手发射」；**按下瞬间视角不应跳变**；按住左右拖 / 上下拖 → 视角跟着转；**松手才发射**（按住期间弹药不变）；装填冷却内按住再松手不发射；**把手指拖出屏幕外再松开，那一发仍应打出去**；来电/系统手势打断时不应发射
10. **窄屏布局**：412×915 竖屏与 844×390 横屏各看一眼 —— 顶部三张卡与底部三块不应溢出、重叠或被裁掉
11. **开局静置**（**动过 `levels.ts` 就必须跑**）：进每一关，什么都不做等 3 秒，**目标进度必须是 `0 / N`**。任何一关出现非零都说明有砖块自己倒了（见陷阱六，L5 曾因此开局自动胜利）
12. **视角遮挡**（**动过相机或 `buildCannon()` 就必须看**）：默认 22° 仰角下，砖墙与白色轨迹虚线应**完整可见**；再把仰角拉到 75°，炮身不应填满画面、相机不应钻到地面以下
13. **炮管朝向**：`muzzle.getWorldPosition()` 应落在「炮弹实际飞出去的方向」上；抬到高仰角时炮管朝上而不是朝下（见陷阱八，符号写反过一次）

> 动到文案时，重点测 **HUD 与结算浮层**：它们的字来自两张不同的表 —— 界面文字在 `i18n.ts` 的 `UI`，关卡名与目标文案来自 `levels.ts` + `objectiveText()`。只改一处最容易漏。

---

## 6. 下一步候选（按建议优先级）

| # | 事项 | 说明 |
|---|---|---|
| 0 | ✅ **相机遮挡 / 关卡初始摆放 / 炮管朝向**（2026-09-23 完成） | 三项一起修完，详见 README「2026-09-23 三处修复」与本文陷阱六 / 七 / 八。**相机与摆砖是本项目最容易反复踩的两处，动之前先读陷阱** |
| 1 | **加一个关卡数据统计脚本** | 比如 `tools/level-stats.mjs`，用 `node --experimental-strip-types` 直接 import `levels.ts`，打印每关的砖数/颜色分布/静态件/目标/弹药。做关卡配平时会反复用到（L4 红砖配平、L5 的 52 块砖是否过载都要靠它给数） |
| 1.5 | **把开局静置检查留档成脚本** | 本轮验证用的 `_phys.mjs`（真实 cannon-es 空跑 6 秒、逐块报告自倒数）随用随删了。它是防「摆砖坑」复发的唯一自动化手段，建议放进 `tools/` 长期保留 —— 否则下次改关卡又要从零重建 |
| 2 | **决定 L4 目标** | 场上 5 块红砖、目标要 4 块。改目标数，或改 `wall()` 的上色序列把红剔掉 |
| 3 | **修 HUD 星星语义** | 现在是按分数粗估、与真实规则不符。建议改成「分数进度条」而不是伪星星 |
| 4 | **星级持久化** | `App` 的 `best` 接 localStorage，`key` 建议带版本号 |
| 5 | ✅ **移动端触控**（2026-09-23 完成） | 按住拖动瞄准、松手发射；HUD 已做窄屏响应式。剩余可选项：开炮时 `navigator.vibrate` 震动反馈；瞄准期间给一个「松手即发射」的蓄力表现 |
| 6 | **关卡解锁门槛** | 依赖 #4 的持久化数据 |
| 7 | **判负不要空等 9 秒** | 让 `allSettled()` 对"已静止但尚未超时"的炮弹也放行，或缩短超时 |
| 8 | **补 `"typecheck": "tsc --noEmit"` 脚本** | 并在 CI（Vercel Build Command 可改成 `npm run typecheck && npm run build`）里接上，避免类型错误悄悄进产物 |
| 9 | ✅ **文案本地化**（2026-09-23 完成） | 界面默认中文、首页可切中英文、选择持久化。剩下的可选项：把 `LevelDef.hint` 真正渲染出来（关卡开始时的提示条），以及移动端窄屏下中文文案的重排 |
| 10 | **清死代码** | `src/utils/cn.ts`（从未引用）、`Game.ts` 末尾的 `LEVEL_COUNT`（从未引用）、`Objective` 的 `knockAll`/`score` 分支、`evaluate()` 里 `finish(false)` 前那句无效的 `endTimer += dt` |

---

## 7. 部署

见 `README.md` 的「部署到 Vercel」一节。摘要：纯静态、单 HTML 产物、无环境变量、无服务端函数，Vercel 免费额度足够；GitHub 导入或 `npx vercel --prod` 二选一。仓库里已有 `vercel.json` 与 `.gitignore`。

**仓库**：已初始化并推到 `github.com/studioj2y/cannonshoot.git`（分支 `main`）。

⚠️ **首次提交时漏推过文件**（2026-09-23 已踩）：当时只 `git add` 了改动过的几个文件，结果 `package.json` / `index.html` / `tsconfig.json` / `vite.config.ts` / `src/App.tsx` 等 **11 个文件没进仓库**。Vercel 检出后报 `ENOENT /vercel/path0/package.json`，且框架预设只剩 `Other` —— 这两个现象同源：**Vercel 靠 `package.json` 判断框架**。

👉 **新仓库的首次提交一律用 `git add .`**（`.gitignore` 已排除 `node_modules/` `dist/` `_shots/`）；仓库已有完整提交后，再按「只列本次改动文件」的方式推送。
