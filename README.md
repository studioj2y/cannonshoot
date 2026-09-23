# 彩色砖块炮台 (Color Brick Cannon)

3D 物理破坏解谜小游戏。你操控一台彩色炮台，用有限的弹药把远处的砖墙、叠塔、拱门轰塌，完成每关目标。

**界面默认中文，首页可一键切换中 / 英文**（选择会记住，刷新不丢）。

纯前端项目，**构建产物是单个自包含的 `index.html`**，可以直接丢到任意静态托管（Vercel / GitHub Pages / 对象存储 / 甚至双击本地打开）。

---

## 快速开始

```bash
npm ci          # 按锁文件安装依赖（102 个包，约 123MB）
npm run dev     # 开发服务器，默认 http://localhost:5173
npm run build   # 生产构建 → dist/index.html（单文件，约 875KB / gzip 236KB）
npm run preview # 本地预览构建产物
```

类型检查（**当前 0 错误**）：

```bash
npx tsc --noEmit
```

> ⚠️ `npm run build` 只跑 `vite build`，走 esbuild 转译，**不做类型检查**。改完代码想确认类型安全必须单独跑 `tsc --noEmit`。

---

## 操作方式

### 电脑（鼠标 / 键盘）

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

### 手机 / 平板（触屏）

| 输入 | 作用 |
|---|---|
| 手指按住画面 | 进入瞄准态（准星放大变黄 + 屏幕提示「瞄准中 · 松手发射」） |
| 按住时左右拖 | 旋转视角（手指右滑 → 视角右转） |
| 按住时上下拖 | 调仰角（手指上滑 → 抬高炮口） |
| **手指松开** | **发射** |
| 底部滑杆 | 先调好力度（发射前调，拖动时轨迹线会跟着变） |
| 右上角 ⏸ / ⟳ | 暂停 / 重开本关 |

几条容易踩的细节：

- 触控是**相对拖动**：按下的一瞬间视角不会跳到手指所在位置，是从当前角度接着转。
- 灵敏度与鼠标一致（滑过整个屏幕宽 = 转 110°），改手感只调 `Game.ts` 里的 `TOUCH_SENS`。
- 只有按在**画面**上才瞄准；按到 HUD 面板（暂停 / 重开 / 滑杆）不会。
- 多指按下去只有**第一根**手指管瞄准，第二根不会打断，也不会误发。
- 来电、系统手势打断时**不会**发射（只退出瞄准态）。
- ⚠️ **开局先往下拖**：默认仰角 22° 时炮身会挡住砖墙和轨迹线（既有构图问题，见「已知问题与待办」）。手指向下拖到 0° 左右，砖墙和预测线就都出来了。

界面上还有两个开关：**轨迹线 / Trajectory**（抛物线预测虚线）、**音效 / Sound**（WebAudio 实时合成，零音频素材）。

---

## 界面语言

默认 **中文**，首页（教程浮层）中部有 `中文 | English` 切换按钮，**暂停面板底部也有一个**（这样切错语言不用刷新就能切回来）。

| 行为 | 落地方式 |
|---|---|
| 文案存放 | 全部集中在 `src/i18n.ts`，一处文案 = 一份 `{ zh, en }` 对照 |
| 关卡名 / 关卡提示 | 放在 `levels.ts` 的关卡数据里，同样是 `{ zh, en }` 结构 |
| 关卡目标文案 | **不写死**，由 `objectiveText(objective, lang)` 按 `kind / count / color` 现场拼出 —— 改了关卡数值文案不会跟着对不上 |
| 默认值 | `zh`；未做过选择的用户进来就是中文 |
| 记忆 | 切换后写入 `localStorage['cbc:lang']`，刷新 / 重开浏览器仍生效 |
| 附带同步 | `<html lang>` 与标签页标题（`document.title`）一起切换 |
| 切换方式 | `useLang()`（内部是 `useSyncExternalStore`），所有读它的组件立即重渲染 |

**加一门语言**：给 `Lang` 加一个字面量 → 在 `UI` 里补齐同名字段 → 在 `COLOR_ZH` 补颜色词。其余代码不用动。

> 引擎层（`Game.ts`）**不产出任何界面文案**。它只通过 `HudState` 传数值与 `level` 序号，UI 自己按序号查表取文案。这样切换语言时界面会立刻更新，不存在「引擎里残留上一门语言字符串」的问题。

---

## 玩法规则

**目标类型**（`levels.ts` 里的 `Objective.kind`）：

| kind | 含义 | 使用关卡 |
|---|---|---|
| `knockCount` | 砸倒 N 块砖 | L1 / L3 / L5 |
| `targets` | 砸掉所有带 `target` 标记的砖（紫色圆柱） | L2 |
| `color` | 砸掉 N 块指定颜色的砖 | L4 |
| `knockAll` | 砸掉全部非静态砖 | *未使用（预留，`i18n.ts` 已有对应文案模板）* |
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
| 1 | Basic Wall / 基础砖墙 | 24（全可动） | 5 | 900 | 砸倒 8 块 | 草地 |
| 2 | Brick Tower / 砖塔 | 20（19 可动 + 1 静态底座） | 5 | 1600 | 砸掉塔顶紫色目标 | 草地 |
| 3 | Unbalanced Arch / 不稳的拱门 | 24（全可动） | 4 | 2000 | 砸倒 14 块 | 沙地 |
| 4 | Platforms & Bridges / 平台与吊桥 | 21（18 可动 + 3 静态平台） | 5 | 2600 | 砸掉 4 块红砖 | 草地 |
| 5 | Complex Fortress / 复合堡垒 | 56（55 可动 + 1 静态底座） | 6 | 4200 | 砸倒 30 块 | 沙地 |

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
| 多语言 | 零依赖，自己写的 `i18n.ts`（未引入 i18next 等库） |

---

## 代码结构

```
src/
├── main.tsx              (10)   React 入口
├── App.tsx              (350)   UI 层：HUD、教程/暂停/胜负浮层、力度滑杆、开关、语言切换、瞄准态反馈
├── i18n.ts              (257)   界面文案总表（中英对照）+ 语言状态 + 关卡目标文案拼装
├── index.css             (13)   Tailwind 入口 + 页面级约束（禁滚动/下拉刷新/iOS 字号放大）
├── game/
│   ├── Game.ts          (814)   引擎：渲染 / 物理 / 输入（鼠标 + 触控）/ 判定计分 / 主循环
│   ├── levels.ts        (174)   5 关数据（名称与提示为中英对照）+ wall/tower/arch 构件工厂
│   └── audio.ts         (102)   9 种合成音效（开炮/装填/命中/闷响/坍塌/胜/负/点击）
└── utils/
    └── cn.ts              (6)   clsx + tailwind-merge 工具 —— ⚠️ 全项目从未引用，脚手架残留
```

**数据流**：`Game` 每帧在自己的 `step()` 末尾调用 `onHud(state)` 把 HUD 快照推给 React，`App` 用 `JSON.stringify` 比对做短路，只在真正变化时 `setState`。UI 反向下发通过直接调 `game.fire() / reset() / setPower() / loadLevel()`。

**文案流向**：`Game.ts` 传 `level`（1 基序号）与 `objectiveProgress`（纯数字，如 `3 / 8`）；`App.tsx` 用 `LEVELS[hud.level - 1]` 取到关卡定义，再用 `resolve(lv.name, lang)` / `objectiveText(lv.objective, lang)` 转成当前语言的文案。**引擎不碰 `lang`**。

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
| 相机 | 炮台后方 6.5、上方 2.6，位置 lerp 0.25（⚠️ 默认仰角下炮身会挡住砖墙，见「已知问题」） | `Game.ts` |
| 角度上下限 | yaw ±60°，pitch −5° ~ 75°（`YAW_LIMIT` / `PITCH_MIN` / `PITCH_MAX`） | `Game.ts` |
| 触控灵敏度 | 滑过全屏宽 = 转 110°、全屏高 = 90°；手感倍率 `TOUCH_SENS = 1.0` | `Game.ts` |
| 装填冷却 | 0.45s（冷却期内按住不进瞄准态、松手也不发射） | `Game.ts` |
| 粒子上限 | 220（胜利彩带 90 片走独立通道，不占此额度） | `Game.ts` |
| 主音量 | 0.35 | `audio.ts` |
| 语言存储键 | `cbc:lang`（默认 `zh`） | `i18n.ts` |

---

## 部署到 Vercel

**可以，而且是最省事的方案。** 这是纯静态站点，不需要任何服务端函数、不需要环境变量、不需要数据库，Vercel 免费额度完全够用（构建产物只有一个 885KB 的 HTML）。

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
| `Unsupported engine` / Node 版本报错 | Vite 7 要求 Node ≥ 20.19 或 ≥ 22.12 | `package.json` 已声明 `"engines": { "node": "22.x" }`，Vercel 会据此选运行时 |

### 自定义域名

Vercel 项目 → Settings → Domains 添加即可。若要绑国内备案域名，注意 Vercel 的节点在境外，国内直连速度一般。

### Vercel 上不需要做的事

- ❌ 不需要 `rewrites` / SPA fallback：应用没有客户端路由，只有一张页面
- ❌ 不需要配置缓存头：Vercel 对静态资源默认策略已够用
- ❌ 不需要 `maxDuration` / 运行时配置：没有 Serverless Function

---

## 已知问题与待办

### 已完成

- **手机触控瞄准**（2026-09-23）：输入层由 `mousemove` / `mousedown` 换成 **Pointer Events**，按 `pointerType` 分流 —— 鼠标保持原来的「绝对位置跟随 + 点击即发射」，触控则是「**按住拖动旋转视角 + 松手发射**」。配套处理了：`touch-action:none`（否则拖动会被浏览器当成滚动）、`setPointerCapture`（手指滑出画面再松手也能收到事件）、多指只认第一根、`pointercancel`（来电 / 系统手势）不发射、装填冷却期内按住不进瞄准态。UI 加入瞄准态反馈（准星放大变黄 + 「瞄准中 · 松手发射」）与窄屏响应式布局、触屏专属操作说明。
- **中英双语界面 + 语言切换**（2026-09-23）：新增 `src/i18n.ts`，默认中文，首页与暂停面板各有切换按钮，选择持久化到 `localStorage['cbc:lang']`。同时把界面文案从引擎里剥离（`HudState` 不再含 `levelName` / `objective`），`levels.ts` 的 `Objective.text` 改为按数值派生。
- **`Game.reset()` 漏清炮弹**（2026-09-23 修复）：原代码 `for (const b of this.balls) this.removeBall(b)`，而 `removeBall` 内部会 `splice(this.balls)`，导致 `for...of` 的迭代游标跳过一半元素。残留的炮弹**既留在 cannon-es 物理世界里继续参与碰撞，又留在场景中不再同步网格**（表现为一颗冻结的黑球立在原地）。改为迭代副本 `[...this.balls]`。复现方法：连开 2~3 炮后按 `R`。

### 待确认 / 待决策（未改动）

- **L4 红砖配平**：目标是「砸掉 4 块红砖」，但场上一共有 **5 块**红砖（4 块手写 + 1 块来自 `wall()` 的 rainbow 上色），所以目标比「砸掉全部红砖」更宽松。属配平细节，不是 bug。改法二选一：目标提到 5，或把 `wall()` 的颜色序列打散掉红色。
- **HUD 右上角的星星是误导性的**：它按 `score / targetScore` 粗估（>50% 给 2 星、≥target 给 3 星），而真实星级规则看的是**剩余弹药**。两者不是一回事。但它也是局内唯一的星级反馈，直接删掉会失去信息，需要先想清楚改成什么（比如改成进度条）。
- **最高星级不持久化**：`App` 里 `best` 只是 `useState`，刷新页面即清零。**注意：语言偏好已经接了 `localStorage`，星级还没有**，两者不要混为一谈。
- **关卡提示 `hint` 已备好中英文但没人渲染**：`LevelDef.hint` 定义了却从未被 UI 读取（预留字段）。若要显示，最适合的位置是关卡开始时的短暂提示条。
- **无关卡解锁门槛**：暂停面板可以直接跳到任意一关。
- ⚠️ **默认视角下砖墙与轨迹线被炮身挡住（构图问题，等定夺）**：相机固定在炮台后方 6.5 单位、上方 2.6 单位，而默认仰角是 22°，导致炮身横在视线中央。实测：**开局只看得到天空和炮台，看不到砖墙与白色预测虚线**；把仰角往下调（鼠标下移 / 手指向下拖）到 0° 附近，两者就都出现。手机竖屏因为视野更窄，这个现象比桌面更明显。
  想改的话有几条路，但都会动到手感，所以没动：① 把默认 `pitch` 从 22 降到 0~8；② 相机偏移从 `(0, 2.6, -6.5)` 改成更靠后 / 更高（`render()` 里一行）；③ 只对触屏设备降低默认仰角。**改之前需确认要哪一种。**
- **弹药耗尽后最长空等约 9 秒**：判负要等 `allSettled()`，而炮弹要 9 秒才超时回收，最后一炮落地后如果它停在界内，会等满 9 秒才弹结算面板。
- **失焦时按键卡住**：`keydown` / `keyup` 没有 `blur` 兜底，按住 `W` 时切走窗口，炮台会一直转。
- **无 `ResizeObserver`**：只有 `window.resize` 监听，拖动 DevTools 停靠导致容器变小、而窗口尺寸没变时，canvas 不会跟着缩放。
- **材质未 dispose（影响可忽略）**：`reset()` 里砖块与粒子只 `dispose()` 了 geometry，没释放 material。但同配置材质复用同一个 shader program，实测不构成有意义的显存增长，属吹毛求疵级。
- **`src/utils/cn.ts` 是死代码**：脚手架残留，从未被 import。
- **两处无用分支**：`Objective.kind` 的 `knockAll` / `score` 无关卡使用（`i18n.ts` 已给它们备好中英文模板）；`evaluate()` 里 `finish(false)` 之前那句 `this.endTimer += dt` 是死代码。
- **`reset()` 里清粒子的循环同样建议改成迭代副本**（当前不 splice 所以没有 bug，但写法上是个陷阱）。

---

## 许可

未声明。若打算公开部署，建议补一份 LICENSE。
