/* ============================================================
   main.js — boot the app
   ============================================================ */

(async function boot() {
  // Cookies don't persist on the file:// protocol in most browsers.
  if (location.protocol === 'file:') {
    console.warn(
      '%c[NEUROLOCK] You opened the file directly (file://). Cookies will NOT persist.\n' +
      'Run a tiny local server instead:\n' +
      '  npx live-server\n' +
      'or\n' +
      '  python -m http.server',
      'color:#ef9f27;font-weight:bold'
    );
  }

  // Load config (fallback to baked-in defaults if fetch fails when opened via file://)
  let config = null;
  try {
    const res = await fetch('data/config.json');
    if (res.ok) config = await res.json();
  } catch (e) { /* fall through */ }

  if (!config) {
    console.warn('[NEUROLOCK] Could not load data/config.json (probably opened via file://). Using defaults.');
    config = {
      maze: { width: 25, height: 25, tileSize: 32, doorsCount: 5, towerSpotsCount: 10 },
      timer: { initial: 240, bonusOnCorrect: 10, penaltyOnWrong: 4, penaltyOnSkip: 6, bonusOnKill: 3, criticalThreshold: 45 },
      quiz: { defaultDuration: 10, durationMultiplier: 1.5, questionsPerRun: 15 },
      waves: { firstWaveDelay: 25, waveInterval: 60 },
      canvas: { targetFPS: 60, backgroundColor: '#0a0a1a' },
      player: { speed: 2.5, hp: 3 },
      providers: {
        mistral: { label: 'Mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
        groq:    { label: 'Groq',    endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant' },
        gemini:  { label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', model: 'gemini-1.5-flash' },
        claude:  { label: 'Anthropic Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-4-5-20251001' }
      },
      defaultProvider: 'mistral'
    };
  }

  // Init modules
  Game.init(config);
  await UI.init(config);

  // Resume audio on first user gesture (browsers requirement)
  const resumeAudio = () => {
    Audio.init();
    document.removeEventListener('click', resumeAudio);
    document.removeEventListener('keydown', resumeAudio);
    document.removeEventListener('touchstart', resumeAudio);
  };
  document.addEventListener('click', resumeAudio);
  document.addEventListener('keydown', resumeAudio);
  document.addEventListener('touchstart', resumeAudio);
})();
