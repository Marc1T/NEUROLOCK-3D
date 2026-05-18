/* ============================================================
   audio.js — generative Web Audio (no external files)
   ============================================================ */

const Audio = (() => {
  let ctx = null;
  let masterGain = null;
  let prefs = { volume: 60, enabled: true };
  let criticalLoop = null;

  function init() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);
      applyPrefs();
    } catch (e) {
      console.warn('[Audio] init failed', e);
    }
  }

  function loadPrefs(p) {
    prefs = p || prefs;
    applyPrefs();
  }

  function applyPrefs() {
    if (!masterGain) return;
    const v = (prefs.enabled ? prefs.volume / 100 : 0) * 0.6;
    masterGain.gain.setValueAtTime(v, ctx.currentTime);
  }

  // Ensure ctx is alive (browsers suspend until user gesture)
  function ensure() {
    if (!ctx) init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // Core tone helper
  function tone(freq, duration, type = 'sine', vol = 0.5, attack = 0.005, release = 0.05) {
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + attack);
    gain.gain.linearRampToValueAtTime(0, t + duration);
    osc.connect(gain).connect(masterGain);
    osc.start(t);
    osc.stop(t + duration + release);
  }

  function chord(freqs, duration, type = 'sine', vol = 0.3) {
    freqs.forEach(f => tone(f, duration, type, vol));
  }

  function noise(duration, vol = 0.3) {
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.linearRampToValueAtTime(0, t + duration);
    src.connect(g).connect(masterGain);
    src.start(t);
  }

  // ---- Public sounds ----
  function playCorrect() {
    tone(523.25, 0.10, 'triangle', 0.35);
    setTimeout(() => tone(659.25, 0.14, 'triangle', 0.35), 90);
  }

  function playWrong() {
    tone(220, 0.18, 'sawtooth', 0.3);
    setTimeout(() => tone(140, 0.22, 'sawtooth', 0.3), 80);
  }

  function playClick() {
    tone(800, 0.04, 'square', 0.18);
  }

  function playDoorOpen() {
    tone(440, 0.08, 'triangle', 0.3);
    setTimeout(() => tone(554, 0.08, 'triangle', 0.3), 70);
    setTimeout(() => tone(659, 0.14, 'triangle', 0.3), 140);
  }

  function playTowerPlace() {
    tone(660, 0.05, 'square', 0.2);
    setTimeout(() => tone(330, 0.12, 'sawtooth', 0.18), 40);
  }

  function playEnemyDeath() {
    noise(0.08, 0.18);
    tone(180, 0.10, 'sawtooth', 0.18);
  }

  function playEnemyHit() {
    noise(0.04, 0.12);
  }

  function playPlayerHit() {
    tone(120, 0.20, 'square', 0.32);
    noise(0.10, 0.18);
  }

  function playGameOver() {
    tone(440, 0.25, 'triangle', 0.35);
    setTimeout(() => tone(370, 0.25, 'triangle', 0.35), 220);
    setTimeout(() => tone(294, 0.40, 'triangle', 0.35), 440);
  }

  function playVictory() {
    chord([523, 659, 784], 0.25, 'triangle', 0.25);
    setTimeout(() => chord([587, 740, 880], 0.35, 'triangle', 0.25), 240);
  }

  function startCritical() {
    if (criticalLoop) return;
    criticalLoop = setInterval(() => tone(800, 0.06, 'square', 0.18), 600);
  }

  function stopCritical() {
    if (criticalLoop) { clearInterval(criticalLoop); criticalLoop = null; }
  }

  function playSpawn() {
    tone(330, 0.06, 'square', 0.2);
    setTimeout(() => tone(220, 0.08, 'square', 0.2), 50);
  }

  function playQuizOpen() {
    tone(660, 0.06, 'sine', 0.25);
    setTimeout(() => tone(880, 0.12, 'sine', 0.25), 50);
  }

  // ---- Ambient music ----
  let ambient = null;
  function startAmbient(intensity = 0.0) {
    ensure();
    if (!ctx || ambient) return;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0, t);
    out.gain.linearRampToValueAtTime(0.10, t + 1.0);
    out.connect(masterGain);

    // Three slow oscillators making a minor chord pad
    const freqs = [110, 138.59, 164.81]; // A2, C#3, E3
    const oscs = [];
    const gains = [];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(freqs[i], t);
      // tiny detune drift
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.07 + i * 0.03;
      lfoGain.gain.value = 1.5;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start(t);
      g.gain.value = 0.18;
      osc.connect(g).connect(out);
      osc.start(t);
      oscs.push({ osc, lfo });
      gains.push(g);
    }
    // High shimmer
    const shimmer = ctx.createOscillator();
    const shimmerG = ctx.createGain();
    shimmer.type = 'sine';
    shimmer.frequency.value = 880;
    shimmerG.gain.value = 0.0;
    shimmer.connect(shimmerG).connect(out);
    shimmer.start(t);

    ambient = { out, oscs, gains, shimmer, shimmerG, intensity };
    setAmbientIntensity(intensity);
  }

  function setAmbientIntensity(level) {
    if (!ambient || !ctx) return;
    const lvl = Math.max(0, Math.min(1, level));
    ambient.intensity = lvl;
    const t = ctx.currentTime;
    // Base volume rises with intensity
    ambient.out.gain.cancelScheduledValues(t);
    ambient.out.gain.linearRampToValueAtTime(0.08 + lvl * 0.10, t + 0.6);
    // Shimmer kicks in above 0.4
    const sh = Math.max(0, lvl - 0.4) * 0.18;
    ambient.shimmerG.gain.cancelScheduledValues(t);
    ambient.shimmerG.gain.linearRampToValueAtTime(sh, t + 0.6);
  }

  function stopAmbient() {
    if (!ambient || !ctx) return;
    const t = ctx.currentTime;
    ambient.out.gain.cancelScheduledValues(t);
    ambient.out.gain.linearRampToValueAtTime(0, t + 0.5);
    setTimeout(() => {
      try {
        ambient.oscs.forEach(o => { o.osc.stop(); o.lfo.stop(); });
        ambient.shimmer.stop();
      } catch (e) {}
      ambient = null;
    }, 700);
  }

  return {
    init, loadPrefs, applyPrefs,
    playCorrect, playWrong, playClick,
    playDoorOpen, playTowerPlace,
    playEnemyDeath, playEnemyHit, playPlayerHit,
    playGameOver, playVictory,
    playSpawn, playQuizOpen,
    startCritical, stopCritical,
    startAmbient, setAmbientIntensity, stopAmbient
  };
})();
