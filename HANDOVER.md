# HANDOVER — 交接说明

> 给下一位接手这个项目的开发者（或下一个 AI 会话）。
> `README.md` 讲「现在是什么」，本文件讲「为什么长这样、改哪里会出事」。
> 最后更新：2026-09-23

---

## 1. 五分钟上手

代码只有 6 个文件、约 1260 行。**按这个顺序读**：

| 顺序 | 文件 | 读它的目的 |
|---|---|---|
| 1 | `src/game/levels.ts` | 先看数据。5 关长什么样、`wall/tower/arch` 三个工厂怎么拼关卡，读完就有大概画面 |
| 2 | `src/App.tsx` | 再看 UI。HUD 有哪些字段、有几个浮层、UI 反向下发调了哪几个方法 |
| 3 | `src/game/Game.ts` | 最后看引擎。先读 `constructor`（装配）→ `reset()`（初始化）→ `step()`（每帧）→ `finish()`（结算），其余都是细节 |
| 4 | `src/game/audio.ts` | 独立小模块，10 分钟看完，不用记 |

没有测试、没有构建脚本之外的工程化设施。想验证就 `tsc --noEmit` + 手动跑。

---

## 2. 引擎是怎么组织的

`Game` 是一个「一个类装下整个游戏」的写法（691 行），内部分四块，靠注释分隔：

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

---

## 4. 常见改动怎么做

### 加一关

改 `src/game/levels.ts` 的 `LEVELS` 数组，加一个 `LevelDef`：

```ts
{
  name: '关卡名',
  hint: '一句提示',              // ⚠️ 定义了但当前 UI 没有渲染它（预留字段）
  ammo: 5,
  targetScore: 2000,
  twoStarAmmoLeft: 2,            // 现有 5 关全是 2
  ground: 'grass' | 'sand',
  objective: { kind: 'knockCount', count: 10, text: 'Knock down 10 bricks' },
  bricks: [...wall(...), ...tower(...)],
}
```

`App.tsx` 的暂停面板用 `grid-cols-5` 排关卡按钮，**加到第 6 关需要同步改网格列数**。

### 加一种砖块形状

要改三处，缺一处就运行时炸：

1. `levels.ts` 的 `BrickShape` 联合类型
2. `Game.ts` 的 `addBrick()` —— 同时给出 three 的 `BufferGeometry` **和** cannon 的 `Shape`（例如 `wedge` 目前只在类型里声明了，`addBrick()` 里没有分支，会走 `else` 当 box 处理）
3. 若是新颜色，`COLORS` 里加色值

注意 `size` 语义不统一：**box 是完整尺寸 `[w,h,d]`；cylinder 是 `[radius, height, radius]`（第三个被忽略）**。`levels.ts` 里的注释对此也含糊，改动时以 `addBrick()` 的实际读取为准。

### 调物理手感

所有可调常量集中在 `Game.ts` 顶部：

```ts
const GRAVITY = -19.6;   // 比真实重力大一倍，为了"砸得爽"
const MAX_SPEED = 90;    // 砖块线速度上限，防止穿透
const MIN_POWER = 20;
const MAX_POWER = 60;
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

1. 教程页 → START PLAYING 能进游戏
2. 鼠标瞄准、WASD、Q/E、滚轮、滑杆五种输入都生效
3. 连开 2~3 炮后按 `R` —— **场上不应残留任何冻结的黑球**（这是 2026-09-23 那个 bug 的复现步骤，以后每次动 `reset()` 都要测）
4. 打到目标 → 等结算浮层出现，星星数量正确
5. 打光弹药未达成目标 → 失败浮层出现（注意可能要等最多 9 秒，见 README 待办）
6. `Esc` 暂停 → 选关 → 切换关卡不残留上一关的砖
7. 缩放窗口，canvas 跟随

---

## 6. 下一步候选（按建议优先级）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **加一个关卡数据统计脚本** | 比如 `tools/level-stats.mjs`，用 `node --experimental-strip-types` 直接 import `levels.ts`，打印每关的砖数/颜色分布/静态件/目标/弹药。做关卡配平时会反复用到（L4 红砖配平、L5 的 56 块砖是否过载都要靠它给数） |
| 2 | **决定 L4 目标** | 场上 5 块红砖、目标要 4 块。改目标数，或改 `wall()` 的上色序列把红剔掉 |
| 3 | **修 HUD 星星语义** | 现在是按分数粗估、与真实规则不符。建议改成「分数进度条」而不是伪星星 |
| 4 | **星级持久化** | `App` 的 `best` 接 localStorage，`key` 建议带版本号 |
| 5 | **移动端触控** | 需要新增 pointer 事件 → 瞄准/开炮，以及给 HUD 做响应式重排（当前 HUD 是硬编码三栏 flex，窄屏会挤） |
| 6 | **关卡解锁门槛** | 依赖 #4 的持久化数据 |
| 7 | **判负不要空等 9 秒** | 让 `allSettled()` 对"已静止但尚未超时"的炮弹也放行，或缩短超时 |
| 8 | **补 `"typecheck": "tsc --noEmit"` 脚本** | 并在 CI（Vercel Build Command 可改成 `npm run typecheck && npm run build`）里接上，避免类型错误悄悄进产物 |
| 9 | **文案本地化** | 界面全英文，若面向中文用户需要一轮中文化 |
| 10 | **清死代码** | `src/utils/cn.ts`（从未引用）、`Game.ts` 末尾的 `LEVEL_COUNT`（从未引用）、`Objective` 的 `knockAll`/`score` 分支、`evaluate()` 里 `finish(false)` 前那句无效的 `endTimer += dt` |

---

## 7. 部署

见 `README.md` 的「部署到 Vercel」一节。摘要：纯静态、单 HTML 产物、无环境变量、无服务端函数，Vercel 免费额度足够；GitHub 导入或 `npx vercel --prod` 二选一。仓库里已有 `vercel.json` 与 `.gitignore`。

**注意**：本项目当前**尚未初始化 git 仓库**。要接 Vercel 的自动部署需要先 `git init` 并推到 GitHub。
