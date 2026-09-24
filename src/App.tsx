import { useEffect, useRef, useState } from 'react';
import { Game, type HudState } from './game/Game';
import { LEVELS } from './game/levels';
import { AMMO, AMMO_ORDER, ammoIndex } from './game/ammo';
import {
  isUnlocked,
  markChallengePassed,
  markCleared,
  recordStars,
  resetProgress,
  useProgress,
} from './progress';
import { audio } from './game/audio';
import { UI, objectiveText, resolve, useLang, type Lang } from './i18n';

/**
 * 是否是「用手指玩」的设备。
 * 只用来决定显示哪一套操作说明 —— 触控瞄准本身不依赖它：
 * 引擎是按 pointerType 分流的，所以判断错了也不会玩不了。
 */
const IS_TOUCH =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);

/* HUD 配色与 3D 场景同源（见 art.ts 的 PALETTE / ENV）：
   奶油纸底 + 深棕描边 + 实心底部投影。刻意不用模糊阴影 —— 模糊阴影是「网页控件」，
   实心偏移投影才像剪纸 / 纸模，和低多边形的刻面是同一套视觉语言。
   ⚠️ 所有颜色必须写成字面量（bg-[#f7f1e3]），不能用 `bg-[${CONST}]` 插值：
   Tailwind 是在源码里做文本扫描的，看不到 JS 变量，插值出来的类名不会生成任何 CSS。 */

/** 卡片 / 面板的统一外壳：奶油纸底 + 深棕描边 + 实心底影 */
const CARD = 'bg-[#f7f1e3] border-2 border-[#3a3129] rounded-2xl shadow-[0_4px_0_#c8bda6]';

const Stars = ({ n, size = 'text-2xl' }: { n: number; size?: string }) => (
  <span className={`${size} leading-none`}>
    {[1, 2, 3].map((i) => (
      <span key={i} className={i <= n ? 'text-[#c9a24d]' : 'text-[#cdc5b6]'}>
        ★
      </span>
    ))}
  </span>
);

const Btn = ({ children, onClick, tone = 'blue' }: any) => {
  const tones: Record<string, string> = {
    blue: 'bg-[#5d8fa8] text-white',
    green: 'bg-[#7fa96a] text-white',
    pink: 'bg-[#d9544d] text-white',
    yellow: 'bg-[#e7c169] text-[#3a3129]',
    purple: 'bg-[#8e6e9e] text-white',
  };
  return (
    <button
      onClick={() => {
        audio.play('click');
        onClick?.();
      }}
      className={`px-4 py-2 text-sm sm:px-5 sm:py-2.5 sm:text-base rounded-2xl font-extrabold border-2 border-[#3a3129] shadow-[0_4px_0_#3a3129] active:shadow-none active:translate-y-1 transition-transform duration-75 ${tones[tone]}`}
    >
      {children}
    </button>
  );
};

/** 中 / 英 切换。两个标签用各自的语言书写（中文 / English），不随界面语言翻译。 */
const LangSwitch = ({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) => {
  const opts: { id: Lang; label: string }[] = [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
  ];
  return (
    <div className="inline-flex gap-1 rounded-2xl bg-[#efe6d2] p-1 border-2 border-[#cfc6b4]">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => {
            audio.play('click');
            onChange(o.id);
          }}
          className={`px-3 py-1.5 sm:px-4 rounded-xl text-xs sm:text-sm font-extrabold transition-colors ${
            o.id === lang ? 'bg-[#e08a45] text-white shadow-[0_2px_0_#3a3129]' : 'text-[#7a6d5c] hover:text-[#3a3129]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
};

/** 弹药点：CSS 菱形取代 ⚫ emoji —— emoji 的字形由系统决定，和 HUD 不是一套语言 */
const AmmoPips = ({ ammo, max }: { ammo: number; max: number }) => (
  <span className="inline-flex items-center gap-1">
    {Array.from({ length: max }).map((_, i) => (
      <span
        key={i}
        className={`inline-block w-2.5 h-2.5 sm:w-3 sm:h-3 rotate-45 rounded-[2px] border-2 border-[#3a3129] ${
          i < ammo ? 'bg-[#e08a45]' : 'bg-transparent'
        }`}
      />
    ))}
  </span>
);

export default function App() {
  const ref = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [paused, setPaused] = useState(false);
  const [traj, setTraj] = useState(true);
  const [sound, setSound] = useState(true);
  const [tutorial, setTutorial] = useState(true);
  /* 进度（解锁门槛 / 最好星级 / 挑战通过）—— 落在 localStorage，刷新不清零。
     语言偏好用的是另一个存储键（见 i18n.ts），两者刻意分开。 */
  const progress = useProgress();
  /* 开局提示条：每关的 lv.hint 原先只是躺在关卡数据里、界面上没人用（玩家看不到）。
     现在做成进关后浮出几秒的提示 —— 新机制（比如玻璃砖）总得有人跟玩家说一句。 */
  const [hintOn, setHintOn] = useState(true);
  const [lang, setLang] = useLang();
  const s = UI[lang];
  const tips = IS_TOUCH ? s.tipsTouch : s.tips;
  const controlsText = IS_TOUCH ? s.controlsTouch : s.controls;

  useEffect(() => {
    if (!ref.current) return;
    const g = new Game(ref.current);
    gameRef.current = g;
    g.onHud = (state) => setHud((p) => (p && JSON.stringify(p) === JSON.stringify(state) ? p : state));
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPaused((p) => !p);
    };
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('keydown', esc);
      g.dispose();
    };
  }, []);

  useEffect(() => {
    if (gameRef.current) gameRef.current.paused = paused || tutorial;
  }, [paused, tutorial]);
  useEffect(() => {
    if (gameRef.current) gameRef.current.showTraj = traj;
  }, [traj]);
  useEffect(() => audio.setEnabled(sound), [sound]);

  /* 提示条在「换关 / 关掉教程」之后重放一次。依赖只放这两个 ——
     hud 每帧都在更新（得分、进度），但内容没变时 setHud 会保持同一个对象，
     所以这里不会跟着每帧重排定时器。 */
  useEffect(() => {
    setHintOn(true);
    const t = setTimeout(() => setHintOn(false), 5200);
    return () => clearTimeout(t);
  }, [hud?.level, tutorial]);

  /* 通关就落盘。挑战模式与普通模式写的是两套记录：
     · 普通 —— 「已通关」（关卡解锁门槛读它）+ 最好星级
     · 挑战 —— 单独一条挑战通过记录，**不写普通星级**（两套判定互不干扰）
     两个写入函数都是幂等的（已为 true / 星级没变高就直接 return），
     所以这个 effect 多触发几次没有副作用。 */
  useEffect(() => {
    if (hud?.status !== 'won') return;
    const i = hud.level - 1;
    if (hud.challenge) {
      markChallengePassed(i);
      /* 一发达成本来就比普通通关更难，所以挑战通过也解锁下一关 ——
         否则打完挑战模式还得切回普通模式再打一遍才能往下走，很别扭。 */
      markCleared(i);
    } else {
      markCleared(i);
      recordStars(i, hud.stars);
    }
  }, [hud?.status, hud?.stars, hud?.level, hud?.challenge]);

  const g = gameRef.current;
  // 界面文案统一在这里按关卡序号取，引擎只负责传数值（见 i18n.ts）
  const lv = hud ? LEVELS[hud.level - 1] ?? LEVELS[0] : LEVELS[0];
  const aiming = !!hud?.aiming;
  const clearedCount = progress.cleared.filter(Boolean).length;
  const challengeCount = progress.challenge.filter(Boolean).length;
  const totalStars = progress.stars.reduce((a, b) => a + b, 0);
  /* 挑战模式的关内目标文案：积分判定的关卡（一发打不完的那种）显示积分线，
     其余显示原目标 —— 判据来自关卡数据，不在这里猜。 */
  const showScoreGoal = !!hud?.challenge && (hud?.challengeLine ?? 0) > 0;
  const goalText = showScoreGoal ? s.challengeGoal : objectiveText(lv.objective, lang);

  return (
    <div className="w-screen h-screen overflow-hidden relative bg-[#a9d3ea] select-none font-sans">
      <div ref={ref} className="absolute inset-0 cursor-crosshair" />

      {hud && (
        <>
          {/* Top HUD —— 容器本身不吃事件，只有各张卡片吃，这样卡片之间的空隙也能用来瞄准 */}
          <div className="absolute top-2 left-2 right-2 sm:top-3 sm:left-3 sm:right-3 flex justify-between items-start pointer-events-none gap-1.5 sm:gap-3">
            <div className={`pointer-events-auto ${CARD} px-3 py-1.5 sm:px-4 sm:py-2.5 max-w-[42vw] sm:max-w-none`}>
              <div className="text-[10px] sm:text-xs font-bold text-[#7a6d5c] flex items-center gap-1.5">
                <span>{s.levelLabel(hud.level, LEVELS.length)}</span>
                {hud.challenge && (
                  <span className="px-1.5 py-px rounded-md bg-[#8e6e9e] text-white text-[9px] sm:text-[10px] leading-tight">
                    {s.challengeBadge}
                  </span>
                )}
              </div>
              <div className="text-base sm:text-xl font-black text-[#3a3129] leading-tight truncate">{resolve(lv.name, lang)}</div>
              <div className="text-[11px] sm:text-sm font-bold leading-tight text-[#a8563a]">
                🎯 {goalText} <span className="text-[#7a6d5c]">({hud.objectiveProgress})</span>
              </div>
              {/* 走积分判定的关：把「积分线」和这一关原本的目标一起写出来，
                  否则玩家会以为是目标被换掉了 */}
              {showScoreGoal && (
                <div className="text-[10px] sm:text-xs font-bold leading-tight text-[#7a6d5c] truncate">
                  {s.challengeLine(hud.challengeLine)} · {objectiveText(lv.objective, lang)}
                </div>
              )}
            </div>

            <div className={`pointer-events-auto ${CARD} px-3 py-1.5 sm:px-4 sm:py-2.5 text-center`}>
              <div className="text-[10px] sm:text-xs font-bold text-[#7a6d5c]">{s.score}</div>
              <div className="text-lg sm:text-2xl font-black text-[#d9544d] leading-none">{hud.score}</div>
              <div className="text-[9px] sm:text-[11px] font-bold text-[#7a6d5c]">{s.target(hud.targetScore)}</div>
              <Stars n={hud.score >= hud.targetScore ? 3 : hud.score > hud.targetScore / 2 ? 2 : 1} size="text-[10px] sm:text-sm" />
            </div>

            <div className="flex flex-col items-end gap-1.5 sm:gap-2 pointer-events-auto">
              <div className={`${CARD} px-3 py-1.5 sm:px-4 sm:py-2.5`}>
                <div className="text-[10px] sm:text-xs font-bold text-[#7a6d5c] text-right">{s.ammo}</div>
                {/* 窄屏用数字，宽屏用菱形：弹药多时菱形会撑破小屏卡片 */}
                <div className="text-xl sm:text-2xl leading-none text-right">
                  <span className="sm:hidden font-black text-[#3a3129]">
                    {hud.ammo}
                    <span className="text-[#7a6d5c] text-sm">/{hud.maxAmmo}</span>
                  </span>
                  <span className="hidden sm:inline">
                    <AmmoPips ammo={hud.ammo} max={hud.maxAmmo} />
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5 sm:gap-2">
                <Btn tone="yellow" onClick={() => setPaused(true)}>
                  ⏸
                </Btn>
                <Btn tone="pink" onClick={() => g?.reset()}>
                  ⟳
                </Btn>
              </div>
            </div>
          </div>

          {/* 开局提示条：一句话点出这一关的关键（哪几块是玻璃、该打哪儿）。
              放在 15% 高度上，避开顶部卡片；5 秒后自己消失，不长期占屏。 */}
          {hintOn && hud.status === 'playing' && !paused && (
            <div className="absolute top-[15%] left-1/2 -translate-x-1/2 w-max max-w-[88vw] sm:max-w-[660px] pointer-events-none">
              <div className={`${CARD} px-3 py-1.5 sm:px-4 sm:py-2 text-[11px] sm:text-sm font-bold text-[#3a3129] text-center`}>
                💡 {resolve(lv.hint, lang)}
              </div>
            </div>
          )}

          {/* combo */}
          {hud.combo > 1 && hud.status === 'playing' && (
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 text-3xl sm:text-5xl font-black text-[#e7c169] drop-shadow-[0_3px_0_#3a3129] animate-pulse pointer-events-none">
              {s.combo(hud.combo)}
            </div>
          )}

          {/* crosshair —— 按住瞄准时放大变黄，给手指一个「现在松手就会打出去」的反馈 */}
          {hud.status === 'playing' && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
              <div className={`relative transition-transform duration-150 ${aiming ? 'scale-[1.6]' : 'scale-100'}`}>
                <span
                  className={`block text-2xl leading-none drop-shadow-[0_1px_2px_rgba(47,40,34,0.9)] ${
                    aiming ? 'text-[#ffd75e]' : 'text-[#f2e9d6]'
                  }`}
                >
                  ✛
                </span>
                {aiming && (
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border-2 border-[#ffd75e]" />
                )}
              </div>
            </div>
          )}

          {aiming && (
            <div className="absolute left-1/2 top-[60%] -translate-x-1/2 pointer-events-none px-4 py-1.5 rounded-full bg-[#453b31] text-[#fff6dc] font-extrabold text-xs sm:text-sm tracking-wide whitespace-nowrap border border-[#7a7166]">
              {s.aiming}
            </div>
          )}

          {/* Bottom HUD */}
          <div className="absolute bottom-2 left-2 right-2 sm:bottom-3 sm:left-3 sm:right-3 flex items-end justify-between gap-1.5 sm:gap-3 pointer-events-none">
            <div className={`pointer-events-auto ${CARD} px-3 py-2 sm:px-4 sm:py-3 max-w-[30vw] sm:max-w-none`}>
              <div className="hidden sm:block text-sm font-bold text-[#3a3129]">
                {s.yaw} <span className="text-[#5d8fa8]">{hud.yaw}°</span> · {s.pitch}{' '}
                <span className="text-[#5d8fa8]">{hud.pitch}°</span>
              </div>
              <div className="text-[10px] sm:text-xs font-bold text-[#7a6d5c] sm:mt-1 leading-tight">{controlsText}</div>
            </div>

            <div className={`pointer-events-auto ${CARD} px-3 py-2 sm:px-4 sm:py-3 w-[32vw] sm:w-[340px]`}>
              <div className="flex justify-between text-[10px] sm:text-xs font-bold text-[#7a6d5c] mb-1">
                <span>{s.power}</span>
                <span className="text-[#a8563a]">{hud.power}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={hud.power}
                onChange={(e) => g?.setPower(Number(e.target.value))}
                className="w-full accent-[#e08a45]"
              />
              <div className="flex gap-2 sm:gap-3 mt-1.5 sm:mt-2 text-[10px] sm:text-xs font-bold text-[#3a3129]">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={traj} onChange={(e) => setTraj(e.target.checked)} className="accent-[#7fa96a]" /> {s.trajectory}
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} className="accent-[#7fa96a]" /> {s.sound}
                </label>
              </div>
            </div>

            {/* 这颗按钮原先写「发射！💥」，但鼠标点画布 / 空格 / 触屏松手都能发射，
                它其实是多余的 —— 现在改成**切换弹药**（循环，见 ammo.ts 的 AMMO_ORDER）。
                那个圆点用弹药自己的颜色：内联 style 而不是 Tailwind 类名，
                因为动态色值走 `bg-[${x}]` 插值时 Tailwind 扫描不到，不会生成 CSS。 */}
            <button
              onClick={() => g?.cycleAmmo()}
              title={s.ammoDesc[hud.ammoKind]}
              className="pointer-events-auto shrink-0 flex flex-col items-center gap-0.5 px-3 py-2 sm:px-5 sm:py-3 rounded-2xl sm:rounded-3xl font-black text-white bg-[#5d8fa8] border-2 sm:border-[3px] border-[#3a3129] shadow-[0_5px_0_#3a3129] sm:shadow-[0_8px_0_#3a3129] active:shadow-none active:translate-y-1 sm:active:translate-y-2 transition-transform duration-75"
            >
              <span className="text-[9px] sm:text-[10px] font-bold opacity-90 leading-none">{s.switchAmmo}</span>
              <span className="flex items-center gap-1.5 text-xs sm:text-lg leading-none">
                <span
                  className="inline-block w-2.5 h-2.5 sm:w-3.5 sm:h-3.5 rounded-full border border-[#3a3129]"
                  style={{ background: `#${AMMO[hud.ammoKind].color.toString(16).padStart(6, '0')}` }}
                />
                {s.ammoName[hud.ammoKind]}
              </span>
              <span className="text-[9px] sm:text-[10px] font-bold opacity-90 leading-none">
                {ammoIndex(hud.ammoKind) + 1} / {AMMO_ORDER.length}
              </span>
            </button>
          </div>
        </>
      )}

      {/* Tutorial（首页：语言切换 + 挑战模式开关都在这里） */}
      {tutorial && (
        <Overlay>
          <h1 className="text-3xl sm:text-5xl font-black text-[#3a3129] mb-2">{s.title}</h1>
          <p className="text-[#7a6d5c] font-bold mb-3 sm:mb-4 text-sm sm:text-base">{s.subtitle}</p>
          <div className="flex flex-col items-center gap-2 sm:gap-3 mb-4 sm:mb-5">
            <LangSwitch lang={lang} onChange={setLang} />
            {/* 挑战模式开关。⚠️ 它会重开本关（弹药数从 5~6 变成 1，没有「半路切换」
                这种状态）。所以这里只读 hud.challenge 作为显示源，不另存一份 state。 */}
            <label className="flex items-center gap-2 cursor-pointer rounded-2xl bg-[#efe6d2] border-2 border-[#cfc6b4] px-3 py-2">
              <input
                type="checkbox"
                checked={!!hud?.challenge}
                onChange={(e) => g?.setChallenge(e.target.checked)}
                className="accent-[#8e6e9e] w-4 h-4"
              />
              <span className="text-xs sm:text-sm font-extrabold text-[#3a3129]">{s.challengeToggle}</span>
            </label>
            <p className="text-[11px] sm:text-xs font-bold text-[#7a6d5c] max-w-[42ch]">{s.challengeToggleHint}</p>
          </div>
          <ul className="text-left text-[#3a3129] font-semibold space-y-1.5 sm:space-y-2 bg-[#efe6d2] border-2 border-[#ded4bf] rounded-2xl p-4 sm:p-5 mb-4 sm:mb-5 text-xs sm:text-base">
            {tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          {clearedCount > 0 && (
            <p className="mb-3 sm:mb-4 text-[11px] sm:text-sm font-bold text-[#7a6d5c]">
              {s.progressSummary(clearedCount, LEVELS.length, totalStars, challengeCount)}
            </p>
          )}
          <Btn tone="green" onClick={() => setTutorial(false)}>
            {IS_TOUCH ? s.startTouch : s.start}
          </Btn>
        </Overlay>
      )}

      {/* Pause / 选关 */}
      {paused && !tutorial && (
        <Overlay>
          <h2 className="text-3xl sm:text-4xl font-black text-[#3a3129] mb-3">{s.pauseTitle}</h2>
          <p className="mb-4 text-[11px] sm:text-sm font-bold text-[#7a6d5c]">
            {s.progressSummary(clearedCount, LEVELS.length, totalStars, challengeCount)}
          </p>
          {/* 选关：按「完成前一关解锁下一关」上锁。锁住的用 disabled + 虚线边框，
              不用「点了没反应」—— 玩家要能一眼看出是锁着而不是坏了。 */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-5">
            {LEVELS.map((l, i) => {
              const unlocked = isUnlocked(progress, i);
              return (
                <button
                  key={i}
                  disabled={!unlocked}
                  onClick={() => {
                    audio.play('click');
                    g?.loadLevel(i);
                    setPaused(false);
                  }}
                  className={
                    unlocked
                      ? 'relative bg-[#efe6d2] hover:bg-[#e7c169] border-2 border-[#cfc6b4] rounded-xl px-3 py-2 text-[#3a3129] font-bold text-xs shadow-[0_3px_0_#c8bda6] active:shadow-none active:translate-y-[3px] transition-transform duration-75'
                      : 'relative bg-[#e6e0d2] border-2 border-dashed border-[#cfc6b4] rounded-xl px-3 py-2 text-[#a89f8e] font-bold text-xs cursor-not-allowed'
                  }
                >
                  {progress.challenge[i] && (
                    <span className="absolute top-1 right-1 text-[10px] leading-none">⚡</span>
                  )}
                  {unlocked ? (
                    <>
                      <div className="text-base font-black text-[#d9544d] leading-none">{i + 1}</div>
                      <div className="text-[10px] opacity-80">{resolve(l.name, lang)}</div>
                      <Stars n={progress.stars[i] || 0} size="text-[10px]" />
                    </>
                  ) : (
                    <>
                      <div className="text-base leading-none">🔒</div>
                      <div className="text-[10px]">{s.locked}</div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex gap-3 justify-center">
            <Btn tone="green" onClick={() => setPaused(false)}>
              {s.resume}
            </Btn>
            <Btn tone="pink" onClick={() => { g?.reset(); setPaused(false); }}>
              {s.restart}
            </Btn>
          </div>

          {/* 弹药图鉴：右下角那颗按钮只放得下一个名字，四种弹药的差别写在空间够的地方 */}
          <div className="mt-5 pt-4 border-t-2 border-[#ded4bf] text-left">
            <div className="text-xs font-bold text-[#7a6d5c] mb-2 text-center">{s.switchAmmo}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {AMMO_ORDER.map((k) => (
                <div
                  key={k}
                  className={`flex gap-2 items-start rounded-xl border-2 px-2.5 py-2 ${
                    hud?.ammoKind === k ? 'border-[#5d8fa8] bg-[#e6eef2]' : 'border-[#ded4bf] bg-[#efe6d2]'
                  }`}
                >
                  <span
                    className="mt-1 inline-block w-3 h-3 rounded-full border border-[#3a3129] shrink-0"
                    style={{ background: `#${AMMO[k].color.toString(16).padStart(6, '0')}` }}
                  />
                  <div>
                    <div className="text-[11px] sm:text-xs font-black text-[#3a3129]">{s.ammoName[k]}</div>
                    <div className="text-[10px] sm:text-[11px] font-semibold text-[#7a6d5c] leading-snug">
                      {s.ammoDesc[k]}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 pt-4 border-t-2 border-[#ded4bf] flex flex-col items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer rounded-2xl bg-[#efe6d2] border-2 border-[#cfc6b4] px-3 py-2">
              <input
                type="checkbox"
                checked={!!hud?.challenge}
                onChange={(e) => g?.setChallenge(e.target.checked)}
                className="accent-[#8e6e9e] w-4 h-4"
              />
              <span className="text-xs sm:text-sm font-extrabold text-[#3a3129]">{s.challengeToggle}</span>
            </label>
            <p className="text-[10px] sm:text-[11px] font-bold text-[#7a6d5c] max-w-[42ch]">{s.challengeToggleHint}</p>
            <div className="mt-1 text-xs font-bold text-[#7a6d5c]">{s.langLabel}</div>
            <LangSwitch lang={lang} onChange={setLang} />
            {clearedCount > 0 && (
              <button
                onClick={() => resetProgress()}
                className="mt-1 text-[10px] sm:text-xs font-bold text-[#a89f8e] underline"
              >
                {s.clearProgress}
              </button>
            )}
          </div>
        </Overlay>
      )}

      {/* Win / Lose —— 挑战模式有自己的两种结局（判据见 levels.ts 的 ChallengeRule） */}
      {hud && hud.status !== 'playing' && !paused && (
        <Overlay>
          {hud.status === 'won' ? (
            hud.challenge ? (
              <>
                <h2 className="text-4xl sm:text-5xl font-black text-[#8e6e9e] mb-2">{s.challengeWinTitle}</h2>
                <p className="text-[#3a3129] font-bold text-xl sm:text-2xl my-3">{s.scoreLine(hud.score)}</p>
                <p className="text-[#7a6d5c] text-xs sm:text-sm mb-4">{s.challengeWonLine}</p>
                <div className="flex gap-3 justify-center">
                  <Btn tone="pink" onClick={() => g?.reset()}>
                    {s.replay}
                  </Btn>
                  <Btn tone="green" onClick={() => g?.nextLevel()}>
                    {hud.level < LEVELS.length ? s.nextLevel : s.backToFirst}
                  </Btn>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-4xl sm:text-5xl font-black text-[#a8563a] mb-2">{s.wonTitle}</h2>
                <Stars n={hud.stars} size="text-5xl sm:text-6xl" />
                <p className="text-[#3a3129] font-bold text-xl sm:text-2xl my-3">{s.scoreLine(hud.score)}</p>
                <p className="text-[#7a6d5c] text-xs sm:text-sm mb-4">{s.starRule(lv.twoStarAmmoLeft, hud.targetScore)}</p>
                <div className="flex gap-3 justify-center">
                  <Btn tone="pink" onClick={() => g?.reset()}>
                    {s.replay}
                  </Btn>
                  <Btn tone="green" onClick={() => g?.nextLevel()}>
                    {hud.level < LEVELS.length ? s.nextLevel : s.backToFirst}
                  </Btn>
                </div>
              </>
            )
          ) : (
            <>
              <h2 className="text-4xl sm:text-5xl font-black text-[#3a3129] mb-2">
                {hud.challenge ? s.challengeFailTitle : s.lostTitle}
              </h2>
              <p className="text-[#3a3129] font-bold mb-1">{goalText}</p>
              <p className="text-[#7a6d5c] mb-4 text-sm sm:text-base">{s.progressLine(hud.objectiveProgress, hud.score)}</p>
              <div className="flex gap-3 justify-center">
                <Btn tone="green" onClick={() => g?.reset()}>
                  {s.tryAgain}
                </Btn>
                <Btn tone="blue" onClick={() => setPaused(true)}>
                  {s.levelSelect}
                </Btn>
              </div>
            </>
          )}
        </Overlay>
      )}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 bg-stone-900/55 backdrop-blur-sm flex items-center justify-center z-50 p-3">
      <div className="bg-[#f7f1e3] border-[3px] border-[#3a3129] rounded-[28px] p-5 sm:p-8 max-w-[92vw] sm:max-w-lg max-h-[92vh] overflow-y-auto text-center shadow-[0_10px_0_rgba(47,40,34,0.5)]">
        {children}
      </div>
    </div>
  );
}
