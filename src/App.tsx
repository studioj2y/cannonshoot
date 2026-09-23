import { useEffect, useRef, useState } from 'react';
import { Game, type HudState } from './game/Game';
import { LEVELS } from './game/levels';
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

const Stars = ({ n, size = 'text-2xl' }: { n: number; size?: string }) => (
  <span className={size}>
    {[1, 2, 3].map((i) => (
      <span key={i} className={i <= n ? 'text-yellow-300' : 'text-white/25'}>
        ★
      </span>
    ))}
  </span>
);

const Btn = ({ children, onClick, tone = 'blue' }: any) => {
  const tones: Record<string, string> = {
    blue: 'from-sky-400 to-blue-600 border-blue-800',
    green: 'from-lime-400 to-green-600 border-green-800',
    pink: 'from-pink-400 to-rose-600 border-rose-800',
    yellow: 'from-amber-300 to-orange-500 border-orange-700',
  };
  return (
    <button
      onClick={() => {
        audio.play('click');
        onClick?.();
      }}
      className={`px-4 py-2 text-sm sm:px-5 sm:py-2.5 sm:text-base rounded-2xl font-extrabold text-white bg-gradient-to-b ${tones[tone]} border-b-4 active:border-b-0 active:translate-y-1 shadow-lg transition-all`}
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
    <div className="inline-flex gap-1 rounded-2xl bg-black/20 p-1">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => {
            audio.play('click');
            onChange(o.id);
          }}
          className={`px-3 py-1.5 sm:px-4 rounded-xl text-xs sm:text-sm font-extrabold transition-all ${
            o.id === lang ? 'bg-white text-indigo-700 shadow' : 'text-white/75 hover:text-white'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
};

export default function App() {
  const ref = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [paused, setPaused] = useState(false);
  const [traj, setTraj] = useState(true);
  const [sound, setSound] = useState(true);
  const [tutorial, setTutorial] = useState(true);
  const [best, setBest] = useState<Record<number, number>>({});
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

  useEffect(() => {
    if (hud?.status === 'won') setBest((b) => ({ ...b, [hud.level]: Math.max(b[hud.level] || 0, hud.stars) }));
  }, [hud?.status, hud?.stars, hud?.level]);

  const g = gameRef.current;
  // 界面文案统一在这里按关卡序号取，引擎只负责传数值（见 i18n.ts）
  const lv = hud ? LEVELS[hud.level - 1] ?? LEVELS[0] : LEVELS[0];
  const aiming = !!hud?.aiming;

  return (
    <div className="w-screen h-screen overflow-hidden relative bg-sky-300 select-none font-sans">
      <div ref={ref} className="absolute inset-0 cursor-crosshair" />

      {hud && (
        <>
          {/* Top HUD —— 容器本身不吃事件，只有各张卡片吃，这样卡片之间的空隙也能用来瞄准 */}
          <div className="absolute top-2 left-2 right-2 sm:top-3 sm:left-3 sm:right-3 flex justify-between items-start pointer-events-none gap-1.5 sm:gap-3">
            <div className="pointer-events-auto bg-white/85 backdrop-blur rounded-2xl px-3 py-1.5 sm:px-4 sm:py-2.5 shadow-xl border-b-4 border-slate-300 max-w-[42vw] sm:max-w-none">
              <div className="text-[10px] sm:text-xs font-bold text-slate-500">{s.levelLabel(hud.level, LEVELS.length)}</div>
              <div className="text-base sm:text-xl font-black text-slate-800 leading-tight truncate">{resolve(lv.name, lang)}</div>
              <div className="text-[11px] sm:text-sm font-bold text-indigo-600 leading-tight">
                🎯 {objectiveText(lv.objective, lang)}{' '}
                <span className="text-slate-500">({hud.objectiveProgress})</span>
              </div>
            </div>

            <div className="pointer-events-auto bg-white/85 backdrop-blur rounded-2xl px-3 py-1.5 sm:px-4 sm:py-2.5 shadow-xl border-b-4 border-slate-300 text-center">
              <div className="text-[10px] sm:text-xs font-bold text-slate-500">{s.score}</div>
              <div className="text-lg sm:text-2xl font-black text-orange-500 leading-none">{hud.score}</div>
              <div className="text-[9px] sm:text-[11px] font-bold text-slate-500">{s.target(hud.targetScore)}</div>
              <Stars n={hud.score >= hud.targetScore ? 3 : hud.score > hud.targetScore / 2 ? 2 : 1} size="text-[10px] sm:text-sm" />
            </div>

            <div className="flex flex-col items-end gap-1.5 sm:gap-2 pointer-events-auto">
              <div className="bg-white/85 backdrop-blur rounded-2xl px-3 py-1.5 sm:px-4 sm:py-2.5 shadow-xl border-b-4 border-slate-300">
                <div className="text-[10px] sm:text-xs font-bold text-slate-500 text-right">{s.ammo}</div>
                {/* 窄屏用数字，宽屏用圆点：弹药多时圆点会撑破小屏卡片 */}
                <div className="text-xl sm:text-2xl leading-none text-right">
                  <span className="sm:hidden font-black text-slate-700">
                    {hud.ammo}
                    <span className="text-slate-400 text-sm">/{hud.maxAmmo}</span>
                  </span>
                  <span className="hidden sm:inline">
                    {Array.from({ length: hud.maxAmmo }).map((_, i) => (
                      <span key={i} className={i < hud.ammo ? '' : 'opacity-20'}>
                        ⚫
                      </span>
                    ))}
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

          {/* combo */}
          {hud.combo > 1 && hud.status === 'playing' && (
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 text-3xl sm:text-5xl font-black text-yellow-300 drop-shadow-[0_3px_0_rgba(0,0,0,0.5)] animate-pulse pointer-events-none">
              {s.combo(hud.combo)}
            </div>
          )}

          {/* crosshair —— 按住瞄准时放大变黄，给手指一个「现在松手就会打出去」的反馈 */}
          {hud.status === 'playing' && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
              <div className={`relative transition-transform duration-150 ${aiming ? 'scale-[1.6]' : 'scale-100'}`}>
                <span
                  className={`block text-2xl leading-none ${
                    aiming ? 'text-yellow-300 drop-shadow-[0_0_6px_rgba(253,224,71,0.9)]' : 'text-white/70'
                  }`}
                >
                  ✛
                </span>
                {aiming && (
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border-2 border-yellow-300/80" />
                )}
              </div>
            </div>
          )}

          {aiming && (
            <div className="absolute left-1/2 top-[60%] -translate-x-1/2 pointer-events-none px-4 py-1.5 rounded-full bg-black/50 text-white font-extrabold text-xs sm:text-sm tracking-wide whitespace-nowrap">
              {s.aiming}
            </div>
          )}

          {/* Bottom HUD */}
          <div className="absolute bottom-2 left-2 right-2 sm:bottom-3 sm:left-3 sm:right-3 flex items-end justify-between gap-1.5 sm:gap-3 pointer-events-none">
            <div className="pointer-events-auto bg-white/85 backdrop-blur rounded-2xl px-3 py-2 sm:px-4 sm:py-3 shadow-xl border-b-4 border-slate-300 max-w-[30vw] sm:max-w-none">
              <div className="hidden sm:block text-sm font-bold text-slate-700">
                {s.yaw} <span className="text-blue-600">{hud.yaw}°</span> · {s.pitch}{' '}
                <span className="text-blue-600">{hud.pitch}°</span>
              </div>
              <div className="text-[10px] sm:text-xs font-bold text-slate-600 sm:text-slate-500 sm:mt-1 leading-tight">
                {controlsText}
              </div>
            </div>

            <div className="pointer-events-auto bg-white/85 backdrop-blur rounded-2xl px-3 py-2 sm:px-4 sm:py-3 shadow-xl border-b-4 border-slate-300 w-[32vw] sm:w-[340px]">
              <div className="flex justify-between text-[10px] sm:text-xs font-bold text-slate-500 mb-1">
                <span>{s.power}</span>
                <span className="text-orange-500">{hud.power}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={hud.power}
                onChange={(e) => g?.setPower(Number(e.target.value))}
                className="w-full accent-orange-500"
              />
              <div className="flex gap-2 sm:gap-3 mt-1.5 sm:mt-2 text-[10px] sm:text-xs font-bold text-slate-600">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={traj} onChange={(e) => setTraj(e.target.checked)} /> {s.trajectory}
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> {s.sound}
                </label>
              </div>
            </div>

            {/* 触屏上松手就会发射，这颗按钮是留给「已瞄好、想连发」和不知情的玩家的 */}
            <button
              onClick={() => g?.fire()}
              className="pointer-events-auto shrink-0 px-4 py-3 text-base sm:px-8 sm:py-5 sm:text-2xl rounded-2xl sm:rounded-3xl font-black text-white bg-gradient-to-b from-red-400 to-rose-600 border-b-4 sm:border-b-8 border-rose-800 active:border-b-0 active:translate-y-1 sm:active:translate-y-2 shadow-2xl"
            >
              {s.fire}
            </button>
          </div>
        </>
      )}

      {/* Tutorial（首页：语言切换在这里） */}
      {tutorial && (
        <Overlay>
          <h1 className="text-3xl sm:text-5xl font-black text-white drop-shadow-[0_4px_0_rgba(0,0,0,0.35)] mb-2">{s.title}</h1>
          <p className="text-white/90 font-bold mb-3 sm:mb-4 text-sm sm:text-base">{s.subtitle}</p>
          <div className="mb-4 sm:mb-5">
            <LangSwitch lang={lang} onChange={setLang} />
          </div>
          <ul className="text-left text-white font-semibold space-y-1.5 sm:space-y-2 bg-white/15 rounded-2xl p-4 sm:p-5 mb-4 sm:mb-5 text-xs sm:text-base">
            {tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          <Btn tone="green" onClick={() => setTutorial(false)}>
            {IS_TOUCH ? s.startTouch : s.start}
          </Btn>
        </Overlay>
      )}

      {/* Pause */}
      {paused && !tutorial && (
        <Overlay>
          <h2 className="text-3xl sm:text-4xl font-black text-white mb-4">{s.pauseTitle}</h2>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-5">
            {LEVELS.map((l, i) => (
              <button
                key={i}
                onClick={() => {
                  audio.play('click');
                  g?.loadLevel(i);
                  setPaused(false);
                }}
                className="bg-white/20 hover:bg-white/35 rounded-xl px-3 py-2 text-white font-bold text-xs"
              >
                <div>{i + 1}</div>
                <div className="text-[10px] opacity-80">{resolve(l.name, lang)}</div>
                <Stars n={best[i + 1] || 0} size="text-[10px]" />
              </button>
            ))}
          </div>
          <div className="flex gap-3 justify-center">
            <Btn tone="green" onClick={() => setPaused(false)}>
              {s.resume}
            </Btn>
            <Btn tone="pink" onClick={() => { g?.reset(); setPaused(false); }}>
              {s.restart}
            </Btn>
          </div>
          <div className="mt-5 pt-4 border-t border-white/20">
            <div className="text-xs font-bold text-white/60 mb-2">{s.langLabel}</div>
            <LangSwitch lang={lang} onChange={setLang} />
          </div>
        </Overlay>
      )}

      {/* Win / Lose */}
      {hud && hud.status !== 'playing' && !paused && (
        <Overlay>
          {hud.status === 'won' ? (
            <>
              <h2 className="text-4xl sm:text-5xl font-black text-yellow-300 drop-shadow-[0_4px_0_rgba(0,0,0,0.35)] mb-2">{s.wonTitle}</h2>
              <Stars n={hud.stars} size="text-5xl sm:text-6xl" />
              <p className="text-white font-bold text-xl sm:text-2xl my-3">{s.scoreLine(hud.score)}</p>
              <p className="text-white/80 text-xs sm:text-sm mb-4">{s.starRule(lv.twoStarAmmoLeft, hud.targetScore)}</p>
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
              <h2 className="text-4xl sm:text-5xl font-black text-white mb-2">{s.lostTitle}</h2>
              <p className="text-white/90 font-bold mb-1">{objectiveText(lv.objective, lang)}</p>
              <p className="text-white/70 mb-4 text-sm sm:text-base">{s.progressLine(hud.objectiveProgress, hud.score)}</p>
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
    <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-50 p-3">
      <div className="bg-gradient-to-b from-indigo-500/90 to-purple-700/90 rounded-3xl p-5 sm:p-8 max-w-[92vw] sm:max-w-lg max-h-[92vh] overflow-y-auto text-center shadow-2xl border-4 border-white/30">
        {children}
      </div>
    </div>
  );
}
