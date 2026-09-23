type Kind = 'fire' | 'load' | 'hit' | 'thud' | 'collapse' | 'win' | 'lose' | 'click';

export class AudioManager {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  enabled = true;
  private last: Record<string, number> = {};

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      /* no audio */
    }
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? 0.35 : 0;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol = 0.5, slideTo?: number) {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol = 0.4, freq = 900) {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
  }

  play(kind: Kind, intensity = 1) {
    this.init();
    if (!this.ctx) return;
    const now = performance.now();
    const gap = kind === 'hit' || kind === 'thud' ? 45 : 0;
    if (gap && now - (this.last[kind] || 0) < gap) return;
    this.last[kind] = now;
    switch (kind) {
      case 'fire':
        this.noise(0.35, 0.6, 1200);
        this.tone(220, 0.25, 'sawtooth', 0.35, 70);
        break;
      case 'load':
        this.tone(520, 0.08, 'square', 0.18);
        break;
      case 'hit':
        this.tone(300 + Math.random() * 300, 0.12, 'triangle', 0.25 * intensity, 120);
        this.noise(0.08, 0.15 * intensity, 2200);
        break;
      case 'thud':
        this.tone(140 + Math.random() * 60, 0.15, 'sine', 0.25, 60);
        break;
      case 'collapse':
        this.noise(0.8, 0.5, 600);
        this.tone(120, 0.7, 'sawtooth', 0.2, 50);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.25, 'triangle', 0.4), i * 120));
        break;
      case 'lose':
        [400, 340, 280, 200].forEach((f, i) => setTimeout(() => this.tone(f, 0.28, 'sine', 0.35), i * 140));
        break;
      case 'click':
        this.tone(880, 0.06, 'square', 0.2);
        break;
    }
  }
}

export const audio = new AudioManager();
