const MUTE_STORAGE_KEY = 'neurolock_muted';
const VOLUME_STORAGE_KEY = 'neurolock_volume';

class GameAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private enabled = false;
  private muted = false;
  private volume = 0.8;
  private duckFactor = 1;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_STORAGE_KEY) === '1';
      const stored = localStorage.getItem(VOLUME_STORAGE_KEY);
      if (stored !== null) {
        const v = Number(stored);
        if (Number.isFinite(v)) this.volume = Math.max(0, Math.min(1, v));
      }
    } catch {}
  }

  private applyMasterGain() {
    if (!this.masterGain || !this.ctx) return;
    const target = this.muted ? 0 : this.volume * this.duckFactor;
    this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyMasterGain();
    try { localStorage.setItem(MUTE_STORAGE_KEY, this.muted ? '1' : '0'); } catch {}
    return this.muted;
  }

  getMuted() {
    return this.muted;
  }

  getVolume() {
    return this.volume;
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyMasterGain();
    try { localStorage.setItem(VOLUME_STORAGE_KEY, String(this.volume)); } catch {}
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.volume;
    this.masterGain.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.masterGain);

    this.ambientBus = this.ctx.createGain();
    this.ambientBus.connect(this.masterGain);
    this.ambientBus.gain.value = 0.1;

    this.enabled = true;
  }

  private playTone(freq: number, type: OscillatorType, duration: number, gain = 0.1) {
    if (this.muted) return;
    if (!this.ctx || !this.sfxBus) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    osc.connect(g);
    g.connect(this.sfxBus);
    
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
    
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  playCorrect() {
    this.playTone(440, 'triangle', 0.1);
    setTimeout(() => this.playTone(660, 'triangle', 0.1), 100);
  }

  playWrong() {
    if (this.muted) return;
    if (!this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.3);
    osc.connect(g);
    g.connect(this.sfxBus);
    g.gain.setValueAtTime(0.2, now);
    g.gain.linearRampToValueAtTime(0, now + 0.3);
    osc.start();
    osc.stop(now + 0.3);
  }

  playDoorOpen() {
    this.playTone(330, 'square', 0.1);
    setTimeout(() => this.playTone(440, 'square', 0.15), 100);
  }

  playSpawn() {
    this.playTone(165, 'sine', 0.2, 0.05);
  }

  playClick() {
    this.playTone(800, 'square', 0.04, 0.05);
  }

  /** Dramatic descending wail for the death moment — 1.2 s tail. */
  playDeath() {
    if (this.muted) return;
    if (!this.ctx || !this.sfxBus) return;
    const now = this.ctx.currentTime;
    // Main sawtooth pad sliding down
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 1.2);
    osc.connect(g);
    g.connect(this.sfxBus);
    g.gain.setValueAtTime(0.3, now);
    g.gain.linearRampToValueAtTime(0, now + 1.2);
    osc.start();
    osc.stop(now + 1.2);
    // Sub bass thump for impact
    const sub = this.ctx.createOscillator();
    const sg = this.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(80, now);
    sub.frequency.exponentialRampToValueAtTime(30, now + 0.6);
    sub.connect(sg);
    sg.connect(this.sfxBus);
    sg.gain.setValueAtTime(0.35, now);
    sg.gain.linearRampToValueAtTime(0, now + 0.6);
    sub.start();
    sub.stop(now + 0.6);
  }

  duck() {
    this.duckFactor = 0.35;
    this.applyMasterGain();
  }

  unduck() {
    this.duckFactor = 1;
    this.applyMasterGain();
  }
}

export const AudioEngine = new GameAudio();
