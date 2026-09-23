import { useEffect, useRef, useState } from 'react';
import { Game, type HudState } from './game/Game';
import { LEVELS } from './game/levels';
import { audio } from './game/audio';

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
      className={`px-5 py-2.5 rounded-2xl font-extrabold text-white bg-gradient-to-b ${tones[tone]} border-b-4 active:border-b-0 active:translate-y-1 shadow-lg transition-all`}
    >
      {children}
    </button>
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

  useEffect(() => {
    if (!ref.current) return;
    const g = new Game(ref.current);
    gameRef.current = g;
    g.onHud = (s) => setHud((p) => (p && JSON.stringify(p) === JSON.stringify(s) ? p : s));
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

  return (
    <div className="w-screen h-screen overflow-hidden relative bg-sky-300 select-none font-sans">
      <div ref={ref} className="absolute inset-0 cursor-crosshair" />

      {hud && (
        <>
          {/* Top HUD */}
          <div className="absolute top-3 left-3 right-3 flex justify-between items-start pointer-events-none gap-3">
            <div className="bg-white/85 backdrop-blur rounded-2xl px-4 py-2.5 shadow-xl border-b-4 border-slate-300">
              <div className="text-xs font-bold text-slate-500">
                LEVEL {hud.level} / {LEVELS.length}
              </div>
              <div className="text-xl font-black text-slate-800 leading-tight">{hud.levelName}</div>
              <div className="text-sm font-bold text-indigo-600">
                🎯 {hud.objective} <span className="text-slate-500">({hud.objectiveProgress})</span>
              </div>
            </div>

            <div className="bg-white/85 backdrop-blur rounded-2xl px-4 py-2.5 shadow-xl border-b-4 border-slate-300 text-center">
              <div className="text-xs font-bold text-slate-500">SCORE</div>
              <div className="text-2xl font-black text-orange-500 leading-none">{hud.score}</div>
              <div className="text-[11px] font-bold text-slate-500">target {hud.targetScore}</div>
              <Stars n={hud.score >= hud.targetScore ? 3 : hud.score > hud.targetScore / 2 ? 2 : 1} size="text-sm" />
            </div>

            <div className="flex flex-col items-end gap-2 pointer-events-auto">
              <div className="bg-white/85 backdrop-blur rounded-2xl px-4 py-2.5 shadow-xl border-b-4 border-slate-300">
                <div className="text-xs font-bold text-slate-500 text-right">CANNONBALLS</div>
                <div className="text-2xl leading-none">
                  {Array.from({ length: hud.maxAmmo }).map((_, i) => (
                    <span key={i} className={i < hud.ammo ? '' : 'opacity-20'}>
                      ⚫
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
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
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 text-5xl font-black text-yellow-300 drop-shadow-[0_3px_0_rgba(0,0,0,0.5)] animate-pulse pointer-events-none">
              COMBO x{hud.combo}!
            </div>
          )}

          {/* crosshair */}
          {hud.status === 'playing' && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none text-white/70 text-2xl">✛</div>
          )}

          {/* Bottom HUD */}
          <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
            <div className="bg-white/85 backdrop-blur rounded-2xl px-4 py-3 shadow-xl border-b-4 border-slate-300 text-sm font-bold text-slate-700">
              <div>
                Yaw <span className="text-blue-600">{hud.yaw}°</span> · Elevation <span className="text-blue-600">{hud.pitch}°</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">Mouse: aim · Click/Space: fire · WASD aim · Q/E power · R restart · Esc pause</div>
            </div>

            <div className="bg-white/85 backdrop-blur rounded-2xl px-4 py-3 shadow-xl border-b-4 border-slate-300 w-[340px]">
              <div className="flex justify-between text-xs font-bold text-slate-500 mb-1">
                <span>POWER</span>
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
              <div className="flex gap-3 mt-2 text-xs font-bold text-slate-600">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={traj} onChange={(e) => setTraj(e.target.checked)} /> Trajectory
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
                </label>
              </div>
            </div>

            <button
              onClick={() => g?.fire()}
              className="px-8 py-5 rounded-3xl text-2xl font-black text-white bg-gradient-to-b from-red-400 to-rose-600 border-b-8 border-rose-800 active:border-b-0 active:translate-y-2 shadow-2xl"
            >
              FIRE! 💥
            </button>
          </div>
        </>
      )}

      {/* Tutorial */}
      {tutorial && (
        <Overlay>
          <h1 className="text-5xl font-black text-white drop-shadow-[0_4px_0_rgba(0,0,0,0.35)] mb-2">🎪 Color Brick Cannon</h1>
          <p className="text-white/90 font-bold mb-4">A colorful 3D physics destruction puzzle</p>
          <ul className="text-left text-white font-semibold space-y-2 bg-white/15 rounded-2xl p-5 mb-5">
            <li>🖱️ Move the mouse to aim the cannon.</li>
            <li>🎚️ Adjust firing power with the slider, mouse wheel or Q / E.</li>
            <li>💥 Click the left mouse button (or Space) to fire.</li>
            <li>🧱 Use physics and chain reactions to knock down the structure.</li>
            <li>⌨️ A/D rotate · W/S elevate · R restart · Esc pause</li>
          </ul>
          <Btn tone="green" onClick={() => setTutorial(false)}>
            START PLAYING
          </Btn>
        </Overlay>
      )}

      {/* Pause */}
      {paused && !tutorial && (
        <Overlay>
          <h2 className="text-4xl font-black text-white mb-4">⏸ Paused</h2>
          <div className="grid grid-cols-5 gap-2 mb-5">
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
                <div className="text-[10px] opacity-80">{l.name}</div>
                <Stars n={best[i + 1] || 0} size="text-[10px]" />
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <Btn tone="green" onClick={() => setPaused(false)}>
              Resume
            </Btn>
            <Btn tone="pink" onClick={() => { g?.reset(); setPaused(false); }}>
              Restart
            </Btn>
          </div>
        </Overlay>
      )}

      {/* Win / Lose */}
      {hud && hud.status !== 'playing' && !paused && (
        <Overlay>
          {hud.status === 'won' ? (
            <>
              <h2 className="text-5xl font-black text-yellow-300 drop-shadow-[0_4px_0_rgba(0,0,0,0.35)] mb-2">LEVEL CLEAR! 🎉</h2>
              <Stars n={hud.stars} size="text-6xl" />
              <p className="text-white font-bold text-2xl my-3">Score: {hud.score}</p>
              <p className="text-white/80 text-sm mb-4">
                ⭐ objective · ⭐⭐ with {LEVELS[hud.level - 1].twoStarAmmoLeft}+ balls left · ⭐⭐⭐ also reach {hud.targetScore} pts
              </p>
              <div className="flex gap-3">
                <Btn tone="pink" onClick={() => g?.reset()}>
                  Replay
                </Btn>
                <Btn tone="green" onClick={() => g?.nextLevel()}>
                  {hud.level < LEVELS.length ? 'Next Level ▶' : 'Back to Level 1'}
                </Btn>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-5xl font-black text-white mb-2">Out of cannonballs! 😅</h2>
              <p className="text-white/90 font-bold mb-1">{hud.objective}</p>
              <p className="text-white/70 mb-4">Progress: {hud.objectiveProgress} · Score {hud.score}</p>
              <div className="flex gap-3">
                <Btn tone="green" onClick={() => g?.reset()}>
                  Try Again
                </Btn>
                <Btn tone="blue" onClick={() => setPaused(true)}>
                  Level Select
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
    <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-gradient-to-b from-indigo-500/90 to-purple-700/90 rounded-3xl p-8 max-w-lg text-center shadow-2xl border-4 border-white/30">
        {children}
      </div>
    </div>
  );
}
