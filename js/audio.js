/* ============================================================================
 * audio.js — Generative Web Audio (no external files)
 *
 * Public surface:
 *   init() / loadPrefs(p) / applyPrefs()
 *   playCorrect / playWrong / playClick / playDoorOpen / playTowerPlace
 *   playEnemyDeath / playEnemyHit / playPlayerHit
 *   playGameOver / playVictory / playSpawn / playQuizOpen
 *   startCritical / stopCritical  — bipping when timer is low
 *   startAmbient / setAmbientIntensity / stopAmbient
 *   duck(amount, ms) / unduck(ms)  — temporarily lower ambient + sfx
 *
 * Architecture notes:
 *  • All SFX go through `sfxBus → masterGain → destination`.
 *  • Ambient drone owns its own gain stage that responds to ducking.
 *  • Critical-beep uses a rAF poll so it pauses when the tab is hidden
 *    (browsers throttle setInterval and unfreezing causes overlapping beeps).
 * ==========================================================================*/

const Audio = (() => {

  let ctx = null;
  let masterGain = null;
  let sfxBus = null;
  let ambientBus = null;
  let prefs = { volume: 60, enabled: true };

  // Critical-beep state (rAF based)
  let criticalActive = false;
  let criticalLastBeep = 0;
  let criticalIntervalMs = 600;

  // Ambient state
  let ambient = null;

  // Duck state — multiplier applied dynamically
  let duckTarget = 1.0;
  let duckCurrent = 1.0;

  /** Lazily create the audio context (browsers require a user gesture). */
  function init() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      sfxBus = ctx.createGain();
      ambientBus = ctx.createGain();
      sfxBus.connect(masterGain);
      ambientBus.connect(masterGain);
      masterGain.connect(ctx.destination);
      applyPrefs();
      requestAnimationFrame(audioLoop);
    } catch (e) {
      console.warn('[Audio] init failed', e);
    }
  }

  function loadPrefs(p) { prefs = p || prefs; applyPrefs(); }

  function applyPrefs() {
    if (!masterGain) return;
    const v = (prefs.enabled ? prefs.volume / 100 : 0) * 0.6;
    masterGain.gain.setValueAtTime(v, ctx.currentTime);
  }

  /** Wake suspended context (needed if first sound triggered before gesture). */
  function ensure() {
    if (!ctx) init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /**
   * Master rAF loop drives the critical beep and the duck envelope.
   * Single rAF avoids the setInterval-throttling issues with hidden tabs.
   */
  function audioLoop(ts) {
    if (!ctx) return;

    // Critical beep
    if (criticalActive && ts - criticalLastBeep > criticalIntervalMs) {
      criticalLastBeep = ts;
      tone(820, 0.06, 'square', 0.18, sfxBus);
    }

    // Duck envelope (60 fps lerp toward target)
    if (Math.abs(duckCurrent - duckTarget) > 0.001) {
      duckCurrent += (duckTarget - duckCurrent) * 0.10;
      if (sfxBus) sfxBus.gain.setValueAtTime(duckCurrent, ctx.currentTime);
      if (ambientBus) ambientBus.gain.setValueAtTime(duckCurrent * (ambient ? 1 : 0), ctx.currentTime);
    }
    requestAnimationFrame(audioLoop);
  }

  // ─── Internal helpers ───────────────────────────────────────────────────
  /**
   * Spawn a one-shot tone.
   * @param {number} freq Hz
   * @param {number} duration seconds
   * @param {OscillatorType} type
   * @param {number} vol 0..1
   * @param {AudioNode} destination
   */
  function tone(freq, duration, type, vol, destination) {
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.005);
    gain.gain.linearRampToValueAtTime(0, t + duration);
    osc.connect(gain).connect(destination || sfxBus || masterGain);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  function chord(freqs, duration, type, vol) {
    for (let i = 0; i < freqs.length; i++) tone(freqs[i], duration, type, vol, sfxBus);
  }

  function noise(duration, vol) {
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.linearRampToValueAtTime(0, t + duration);
    src.connect(g).connect(sfxBus);
    src.start(t);
  }

  // ─── Public SFX ─────────────────────────────────────────────────────────
  function playCorrect() {
    tone(523.25, 0.10, 'triangle', 0.35, sfxBus);
    setTimeout(() => tone(659.25, 0.14, 'triangle', 0.35, sfxBus), 90);
  }
  function playWrong() {
    tone(220, 0.18, 'sawtooth', 0.30, sfxBus);
    setTimeout(() => tone(140, 0.22, 'sawtooth', 0.30, sfxBus), 80);
  }
  function playClick()       { tone(800, 0.04, 'square',   0.18, sfxBus); }
  function playDoorOpen()    {
    tone(440, 0.08, 'triangle', 0.30, sfxBus);
    setTimeout(() => tone(554, 0.08, 'triangle', 0.30, sfxBus),  70);
    setTimeout(() => tone(659, 0.14, 'triangle', 0.30, sfxBus), 140);
  }
  function playTowerPlace()  {
    tone(660, 0.05, 'square',   0.20, sfxBus);
    setTimeout(() => tone(330, 0.12, 'sawtooth', 0.18, sfxBus), 40);
  }
  function playEnemyDeath()  { noise(0.08, 0.18); tone(180, 0.10, 'sawtooth', 0.18, sfxBus); }
  function playEnemyHit()    { noise(0.04, 0.12); }
  function playPlayerHit()   { tone(120, 0.20, 'square', 0.32, sfxBus); noise(0.10, 0.18); }
  function playGameOver()    {
    tone(440, 0.25, 'triangle', 0.35, sfxBus);
    setTimeout(() => tone(370, 0.25, 'triangle', 0.35, sfxBus), 220);
    setTimeout(() => tone(294, 0.40, 'triangle', 0.35, sfxBus), 440);
  }
  function playVictory()     {
    chord([523, 659, 784], 0.25, 'triangle', 0.25);
    setTimeout(() => chord([587, 740, 880], 0.35, 'triangle', 0.25), 240);
  }
  function playSpawn()       {
    tone(330, 0.06, 'square', 0.20, sfxBus);
    setTimeout(() => tone(220, 0.08, 'square', 0.20, sfxBus), 50);
  }
  function playQuizOpen() {
    tone(660, 0.06, 'sine', 0.25, sfxBus);
    setTimeout(() => tone(880, 0.12, 'sine', 0.25, sfxBus), 50);
  }

  function startCritical() {
    criticalActive = true;
    criticalLastBeep = 0;
  }
  function stopCritical() { criticalActive = false; }

  // ─── Ambient drone ──────────────────────────────────────────────────────
  function startAmbient(intensity = 0.0) {
    ensure();
    if (!ctx || ambient) return;
    const t = ctx.currentTime;

    const ambGain = ctx.createGain();
    ambGain.gain.setValueAtTime(0.0, t);
    ambGain.gain.linearRampToValueAtTime(0.10, t + 1.0);
    ambGain.connect(ambientBus);

    const freqs = [110, 138.59, 164.81];
    const oscs = [];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(freqs[i], t);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.07 + i * 0.03;
      lfoGain.gain.value = 1.5;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start(t);
      g.gain.value = 0.18;
      osc.connect(g).connect(ambGain);
      osc.start(t);
      oscs.push({ osc, lfo });
    }
    const shimmer = ctx.createOscillator();
    const shimmerG = ctx.createGain();
    shimmer.type = 'sine';
    shimmer.frequency.value = 880;
    shimmerG.gain.value = 0.0;
    shimmer.connect(shimmerG).connect(ambGain);
    shimmer.start(t);

    ambient = { ambGain, oscs, shimmer, shimmerG };
    setAmbientIntensity(intensity);
  }

  function setAmbientIntensity(level) {
    if (!ambient || !ctx) return;
    const lvl = Math.max(0, Math.min(1, level));
    const t = ctx.currentTime;
    ambient.ambGain.gain.cancelScheduledValues(t);
    ambient.ambGain.gain.linearRampToValueAtTime(0.08 + lvl * 0.10, t + 0.6);
    const sh = Math.max(0, lvl - 0.4) * 0.18;
    ambient.shimmerG.gain.cancelScheduledValues(t);
    ambient.shimmerG.gain.linearRampToValueAtTime(sh, t + 0.6);
  }

  function stopAmbient() {
    if (!ambient || !ctx) return;
    const t = ctx.currentTime;
    ambient.ambGain.gain.cancelScheduledValues(t);
    ambient.ambGain.gain.linearRampToValueAtTime(0, t + 0.5);
    setTimeout(() => {
      try {
        ambient.oscs.forEach(o => { o.osc.stop(); o.lfo.stop(); });
        ambient.shimmer.stop();
      } catch (e) {}
      ambient = null;
    }, 700);
  }

  // ─── Ducking (lower everything when a quiz is open) ─────────────────────
  /**
   * Set the duck level (0..1; 1 = full volume, 0.35 = ducked).
   * @param {number} level
   */
  function setDuck(level) {
    duckTarget = Math.max(0.05, Math.min(1, level));
  }
  function duck()   { setDuck(Constants.AUDIO.DUCK_GAIN); }
  function unduck() { setDuck(1.0); }

  return {
    init, loadPrefs, applyPrefs,
    playCorrect, playWrong, playClick, playDoorOpen, playTowerPlace,
    playEnemyDeath, playEnemyHit, playPlayerHit,
    playGameOver, playVictory, playSpawn, playQuizOpen,
    startCritical, stopCritical,
    startAmbient, setAmbientIntensity, stopAmbient,
    duck, unduck, setDuck
  };
})();
