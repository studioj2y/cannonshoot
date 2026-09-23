# Color Brick Cannon

3D 物理破坏解谜小游戏。你操控一台彩色炮台，用有限的弹药把远处的砖墙、叠塔、拱门轰塌，完成每关目标。

纯前端项目，**构建产物是单个自包含的 `index.html`**，可以直接丢到任意静态托管（Vercel / GitHub Pages / 对象存储 / 甚至双击本地打开）。

---

## 快速开始

```bash
npm ci          # 按锁文件安装依赖（102 个包，约 123MB）
npm run dev     # 开发服务器，默认 http://localhost:5173
npm run build   # 生产构建 → dist/index.html（单文件，约 870KB / gzip 234KB）
npm run preview # 本地预览构建产物
```

类型检查（**当前 0 错误**）：

```bash
npx tsc --noEmit
```

> ⚠️ `npm run build` 只跑 `vite build`，走 esbuild 转译，**不做类型检查**。改完代码想确认类型安全必须单独跑 `tsc --noEmit`。

---

## 操作方式

| 输入 | 作用 |
|---|---|
| 移动鼠标 | 瞄准（水平 yaw ±60°，仰角 pitch −5° ~ 75°） |
| 左键点击 / 空格 | 开炮（有 0.45s 装填冷却） |
| `A` `D` | 左右旋转炮台 |
| `W` `S` | 上下调整仰角 |
| `Q` `E` | 减小 / 增大力度 |
| 鼠标滚轮 | 微调力度（每格 ±1.5） |
| 滑杆 | 直接设定力度（0~100% 映射到 20~60 初速度） |
| `R` | 重开当前关 |
| `Esc` | 暂停 / 继续（暂停面板内含关卡选择） |

界面上还有两个开关：**Trajectory**（抛物线预测虚线）、**Sound**（音效，WebAudio 实时合成，零音频素材）。

---

## 玩法规则

**目标类型**（`levels.ts` 里的 `Objective.kind`）：

| kind | 含义 | 使用关卡 |
|---|---|---|
| `knockCount` | 砸倒 N 块砖 | L1 / L3 / L5 |
| `targets` | 砸掉所有带 `target` 标记的砖（紫色圆柱） | L2 |
| `color` | 砸掉 N 块指定颜色的砖 | L4 |
| `knockAll` | 砸掉全部非静态砖 | *未使用（预留）* |
| `score` | 达到目标分数 | *未使用（预留）* |

**「被砸倒」的判定**：砖块的位移 > **1.2**，**或者** 倾角 > **38°**（只看局部 Y 轴，所以绕 Y 轴的水平旋转不算倒）。

**计分**：
- 每块砖基础 100 分（带 `target` 的 300 / 400 分）。
- 连击窗口 **1600ms**：窗口内连续砸倒，第 n 块额外加 `基础分 × 25% × (n−1)`；连到第 5 块播放坍塌音效。
- 通关额外奖励 **剩余弹药 × 200**。

**星级**（结算时判定）：

| 星级 | 条件 |
|---|---|
| ★ | 完成关卡目标 |
| ★★ | 完成目标 + 剩余弹药 ≥ `twoStarAmmoLeft` |
| ★★★ | 再满足 `score ≥ targetScore` |

> ⚠️ 注意：★ 判定里的 `score` **已经包含弹药奖励**（`finish()` 里先加奖励再比对），所以三星门槛实际比表面数字宽松。

**结束时机**：达成目标后不会立刻结算，需要等 `endTimer > 1.2s` **且** 场上物理全部静止（无球在场，所有非静态砖速度 < 0.6 或已休眠）。

---

## 关卡一览

| # | 名称 | 砖块 | 弹药 | 目标分 | 目标 | 地面 |
|---|---|---|---|---|---|---|
| 1 | Basic Wall | 24（全可动） | 5 | 900 | 砸倒 8 块 | 草地 |
| 2 | Brick Tower | 20（19 可动 + 1 静态底座） | 5 | 1600 | 砸掉塔顶紫色王冠 | 草地 |
| 3 | Unbalanced Arch | 24（全可动） | 4 | 2000 | 砸倒 14 块 | 沙地 |
| 4 | Platforms & Bridges | 21（18 可动 + 3 静态平台） | 5 | 2600 | 砸掉 4 块红砖 | 草地 |
| 5 | Complex Fortress | 56（55 可动 + 1 静态底座） | 6 | 4200 | 砸倒 30 块 | 沙地 |

**构件工厂**（`levels.ts`，用代码生成关卡，不手写坐标）：

- `wall(x0, y0, z, cols, rows, bw, bh, bd)` — 交错砌法的砖墙，`rainbow` 六色循环上色
- `tower(x, z, layers, base)` — 每层「双柱 + 顶板」，共 `layers` 层，塔顶自动放一个紫色 target（300 分）
- `arch(x, z, h, span, color)` — 两侧砖柱 + 顶部横梁

配色（`COLORS`）：`red #ff5a5f` `yellow #ffd23f` `blue #4cb5f5` `green #5bd68a` `purple #b07cf0` `orange #ff9f43` `gray #b8c2cc`（gray 用于静态承重件）。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 19.2.6 + TypeScript 5.9.3 |
| 构建 | Vite 7.3.2 + `vite-plugin-singlefile` 2.3.0（内联 JS/CSS → 单 HTML） |
| 样式 | Tailwind CSS 4.1.17（`@tailwindcss/vite`，`src/index.css` 只有一行 `@import "tailwindcss"`） |
| 渲染 | three 0.186（WebGL，无外部模型/贴图素材，全部程序化几何体） |
| 物理 | cannon-es 0.20（`SAPBroadphase` + `GSSolver`，迭代 12 次） |
| 音频 | 原生 WebAudio 振荡器合成，见 `audio.ts` |

---

## 代码结构

```
src/
├── main.tsx              (10)   React 入口
├── App.tsx              (275)   UI 层：HUD、教程/暂停/胜负浮层、力度滑杆、开关
├── index.css             (1)    Tailwind 入口
├── game/
│   ├── Game.ts          (694)   引擎：渲染 / 物理 / 输入 / 判定计分 / 主循环
│   ├── levels.ts        (173)   5 关数据 + wall/tower/arch 构件工厂
│   └── audio.ts         (102)   9 种合成音效（开炮/装填/命中/闷响/坍塌/胜/负/点击）
└── utils/
    └── cn.ts              (6)   clsx + tailwind-merge 工具 —— ⚠️ 全项目从未引用，脚手架残留
```

**数据流**：`Game` 每帧在自己的 `step()` 末尾调用 `onHud(state)` 把 HUD 快照推给 React，`App` 用 `JSON.stringify` 比对做短路，只在真正变化时 `setState`。UI 反向下发通过直接调 `game.fire() / reset() / setPower() / loadLevel()`。

**暂停语义**：`game.paused = paused || tutorial`。暂停时 `step()` 整个不跑（物理、输入、HUD 一起冻结），但 `render()` 仍在跑，所以画面不黑。

---

## 关键参数（调参先看这张表）

| 参数 | 值 | 位置 |
|---|---|---|
| `GRAVITY` | −19.6 m/s² | `Game.ts` |
| `MIN_POWER` / `MAX_POWER` | 20 / 60 | `Game.ts` |
| `MAX_SPEED`（砖块线速度上限） | 90（角速度上限 22） | `Game.ts` |
| 炮弹 | 质量 9，半径 0.45，阻尼 0.005，CCD 阈值 8 | `Game.ts` |
| 炮弹寿命 / 越界 | 9s / \|x\|>120、z>20、z<−160、y<−20 | `Game.ts` |
| 同场炮弹上限 | 6 | `Game.ts` |
| 击倒阈值 | 位移 1.2 / 倾角 38° | `Game.ts` |
| 连击窗口 / 加成 | 1600ms / 25% per combo | `Game.ts` |
| 弹药结算奖励 | ×200 | `Game.ts` |
| 物理步进 | `world.step(1/60, dt, 4)`，dt 上限 0.05（≈20fps 保底） | `Game.ts` |
| 接触材质 | 地面-砖 μ0.55 e0.08；砖-砖 μ0.5 e0.05；球-砖 μ0.3 e0.25；球-地 μ0.4 e0.35 | `Game.ts` |
| 轨迹预测 | dt=0.055，40 个点，y<0.1 截断 | `Game.ts` |
| 相机 | 炮台后方 6.5、上方 2.6，位置 lerp 0.25 | `Game.ts` |
| 粒子上限 | 220（胜利彩带 90 片走独立通道，不占此额度） | `Game.ts` |
| 主音量 | 0.35 | `audio.ts` |

---

## 部署到 Vercel

**可以，而且是最省事的方案。** 这是纯静态站点，不需要任何服务端函数、不需要环境变量、不需要数据库，Vercel 免费额度完全够用（构建产物只有一个 870KB 的 HTML）。

仓库内已备好 `vercel.json`（显式声明 framework= vite / buildCommand / outputDirectory，其实不写 Vercel 也能自动识别 Vite）。

### 方式 A：接 GitHub（推荐，之后 push 即自动部署）

1. 本地初始化仓库并推送到 GitHub（**这一步由你本人执行**）：

   ```bash
   git init
   git add .
   git commit -m "chore: initial commit"
   git branch -M main
   git remote add origin <你的仓库地址>
   git push -u origin main
   ```

   `.gitignore` 已配置好，`node_modules/` 与 `dist/` 不会进仓库。

   > ⚠️ **首次提交务必用 `git add .`（或 `git add -A`），不要只 add 你改动过的那几个文件。**
   > Vercel 是读 `package.json` 来判断项目类型的：仓库里一旦缺它，构建会直接死在
   > `npm error enoent Could not read package.json: /vercel/path0/package.json`，
   > 同时 Framework Preset 会只剩 `Other` 一个选项。这两个现象是同一个原因。
   > 推之前用 `git status --short` 扫一眼，确认 `package.json`、`index.html`、`src/` 都在列表里。

2. 打开 [vercel.com/new](https://vercel.com/new)，选 **Import Git Repository**，选中这个仓库。
3. Framework Preset 会自动识别为 **Vite**；确认 Build Command = `npm run build`、Output Directory = `dist`，直接 Deploy。
4. 约 1 分钟后拿到 `https://<项目名>.vercel.app`，可以直接分享给别人玩。

### 方式 B：不用 GitHub，直接 CLI 部署

```bash
npx vercel        # 首次会引导登录 + 关联项目，产出预览地址
npx vercel --prod # 部署到正式域名
```

### 部署报错排查

| 报错现象 | 原因 | 处理 |
|---|---|---|
| `ENOENT: ... open '/vercel/path0/package.json'` 且 Preset 只能选 `Other` | 仓库里没有 `package.json` —— 首次提交漏推了文件 | 补齐文件后 `git push`，Vercel 自动重新部署 |
| 构建成功但访问 404 | `Output Directory` 与实际产物目录没对上 | 确认 Output Directory = `dist`（本仓库 `vercel.json` 已声明） |
| Preset 显示 `Other` 但构建正常 | 项目创建时 Vercel 没识别出框架 | 无需处理 —— `vercel.json` 里的 `framework: "vite"` 会覆盖预设。想收拾干净就在 Settings → Build & Development Settings 手动选 Vite，或删掉项目重新 Import |

### 自定义域名

Vercel 项目 → Settings → Domains 添加即可。若要绑国内备案域名，注意 Vercel 的节点在境外，国内直连速度一般。

### Vercel 上不需要做的事

- ❌ 不需要 `rewrites` / SPA fallback：应用没有客户端路由，只有一张页面
- ❌ 不需要配置缓存头：Vercel 对静态资源默认策略已够用
- ❌ 不需要 `maxDuration` / 运行时配置：没有 Serverless Function

---

## 已知问题与待办

### 已修复

- **`Game.reset()` 漏清炮弹**（2026-09-23 修复）：原代码 `for (const b of this.balls) this.removeBall(b)`，而 `removeBall` 内部会 `splice(this.balls)`，导致 `for...of` 的迭代游标跳过一半元素。残留的炮弹**既留在 cannon-es 物理世界里继续参与碰撞，又留在场景中不再同步网格**（表现为一颗冻结的黑球立在原地）。改为迭代副本 `[...this.balls]`。复现方法：连开 2~3 炮后按 `R`。

### 待确认 / 待决策（未改动）

- **L4 红砖配平**：目标是「砸掉 4 块红砖」，但场上一共有 **5 块**红砖（4 块手写 + 1 块来自 `wall()` 的 rainbow 上色），所以目标比「砸掉全部红砖」更宽松。属配平细节，不是 bug。改法二选一：目标提到 5，或把 `wall()` 的颜色序列打散掉红色。
- **HUD 右上角的星星是误导性的**：它按 `score / targetScore` 粗估（>50% 给 2 星、≥target 给 3 星），而真实星级规则看的是**剩余弹药**。两者不是一回事。但它也是局内唯一的星级反馈，直接删掉会失去信息，需要先想清楚改成什么（比如改成进度条）。
- **最高星级不持久化**：`App` 里 `best` 只是 `useState`，刷新页面即清零，localStorage 完全没接。
- **无关卡解锁门槛**：暂停面板可以直接跳到任意一关。
- **无移动端触控**：全项目零 `touch*` / `pointer*` 事件，只有鼠标与键盘。
- **弹药耗尽后最长空等约 9 秒**：判负要等 `allSettled()`，而炮弹要 9 秒才超时回收，最后一炮落地后如果它停在界内，会等满 9 秒才弹结算面板。
- **失焦时按键卡住**：`keydown` / `keyup` 没有 `blur` 兜底，按住 `W` 时切走窗口，炮台会一直转。
- **无 `ResizeObserver`**：只有 `window.resize` 监听，拖动 DevTools 停靠导致容器变小、而窗口尺寸没变时，canvas 不会跟着缩放。
- **界面文案全英文**：`App.tsx` / `levels.ts` 里的所有目标、提示、按钮都是英文。若要面向中文用户，需要做一轮本地化。
- **材质未 dispose（影响可忽略）**：`reset()` 里砖块与粒子只 `dispose()` 了 geometry，没释放 material。但同配置材质复用同一个 shader program，实测不构成有意义的显存增长，属吹毛求疵级。
- **`src/utils/cn.ts` 是死代码**：脚手架残留，从未被 import。
- **两处无用分支**：`Objective.kind` 的 `knockAll` / `score` 无关卡使用；`evaluate()` 里 `finish(false)` 之前那句 `this.endTimer += dt` 是死代码。
- **`reset()` 里清粒子的循环同样建议改成迭代副本**（当前不 splice 所以没有 bug，但写法上是个陷阱）。

---

## 许可

未声明。若打算公开部署，建议补一份 LICENSE。
