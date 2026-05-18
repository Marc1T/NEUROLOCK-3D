/* ============================================================================
 * game.js — Main game loop + run-state glue
 *
 * Responsibilities:
 *  • Run lifecycle (start, abandon, pause, end)
 *  • Frame loop: input → physics → triggers → enemies → FX tick → draw
 *  • Hit-stop: deliberate frame freezes for impact feel (player hit, kill)
 *  • Trigger detection: walking into doors, stepping on tower spots, exit
 *  • HUD diffing: only writes to DOM when underlying values change
 *
 * Architecture:
 *  • This module is the only place that knows about all subsystems. Other
 *    modules know about FX (for visuals) and AdaptiveAI (for difficulty),
 *    but they don't reach back into game state.
 *  • Run state is stored in `runState` (resets every start).
 * ==========================================================================*/

const Game = (() => {

  const TILE = Constants.TILE;

  // ─── Module state ───────────────────────────────────────────────────────
  let cfg = null;
  let runState = null;
  let canvas = null;
  let rafId = null;
  let lastTs = 0;

  /** Input flags (keyboard) */
  const input = { up: false, down: false, left: false, right: false };
  /** Input flags (touch dpad) */
  const touch = { up: false, down: false, left: false, right: false };

  let quizPending = false;
  let paused = false;

  /** Hit-stop accumulator: ms of frozen-time still owed. */
  let hitStopMs = 0;

  // Tower-spot prompt DOM element (lazy)
  let spotPromptEl = null;

  // Help overlay state
  let helpShown = false;
  let helpPriorPaused = false;

  // ─── Key bindings ───────────────────────────────────────────────────────
  const MOVE_KEYS = Object.freeze({
    up:    ['arrowup', 'w', 'z'],
    down:  ['arrowdown', 's'],
    left:  ['arrowleft', 'a', 'q'],
    right: ['arrowright', 'd']
  });
  const ACTION_KEYS = ['e', ' ', 'enter'];
  const PAUSE_KEYS = ['escape', 'p'];

  // ─── HUD references (cached on init) ────────────────────────────────────
  const hud = {};
  /** Last-written values to detect changes and skip redundant DOM writes. */
  const hudCache = {};

  // ─── Public: init / start / abandon / pause ─────────────────────────────
  /**
   * Bind to global config and attach input handlers (called once at boot).
   */
  function init(globalConfig) {
    cfg = globalConfig;
    canvas = document.getElementById('game-canvas');
    Renderer.init(canvas);

    // Cache HUD element references
    hud.hp        = document.getElementById('hud-hp');
    hud.score     = document.getElementById('hud-score');
    hud.subject   = document.getElementById('hud-subject');
    hud.timer     = document.getElementById('hud-timer');
    hud.accuracy  = document.getElementById('hud-accuracy');
    hud.accBar    = document.getElementById('hud-accuracy-bar');
    hud.waveNum   = document.getElementById('wave-number');
    hud.waveCD    = document.getElementById('wave-countdown');
    hud.combo     = document.getElementById('combo-display');
    hud.comboVal  = document.getElementById('combo-value');
    hud.comboMult = document.getElementById('combo-mult');

    // Unified key handler — registered for both window and document
    const keyHandler = (down) => (ev) => {
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = ev.key.toLowerCase();
      let consumed = false;

      for (const dir of ['up', 'down', 'left', 'right']) {
        if (MOVE_KEYS[dir].includes(k)) {
          input[dir] = down && !quizPending;
          consumed = true;
        }
      }
      if (down && !quizPending) {
        if (ACTION_KEYS.includes(k)) { tryActionAt(); consumed = true; }
        if (PAUSE_KEYS.includes(k))  { togglePause(); consumed = true; }
        if (k === '?' || k === 'h')  { showHelp();    consumed = true; }
      }
      if (consumed) ev.preventDefault();
    };
    window.addEventListener('keydown', keyHandler(true));
    window.addEventListener('keyup',   keyHandler(false));
    // Release all keys when window loses focus (avoid sticky keys)
    window.addEventListener('blur', () => {
      input.up = input.down = input.left = input.right = false;
    });
  }

  /** Touch dpad → directional flags. */
  function setTouchDir(dir, down) {
    if (dir === 'action') { if (down) tryActionAt(); return; }
    if (dir in touch) touch[dir] = down;
  }

  /**
   * Start a new run with the given course pack and run config.
   */
  function start(pack, runCfg) {
    Audio.init();
    if (!pack || !pack.questions?.length) {
      UI.toast('Aucun cours chargé');
      UI.showScreen('home');
      return;
    }

    paused = false;
    quizPending = false;
    hitStopMs = 0;

    // Generate maze
    const maze = Maze.generate(cfg.maze.width, cfg.maze.height, {
      doorsCount: cfg.maze.doorsCount,
      towerSpotsCount: cfg.maze.towerSpotsCount
    });
    const openDoors = new Set();

    // Initialise subsystems
    Player.init(maze, openDoors, { speed: cfg.player.speed, hp: cfg.player.hp });
    Enemies.init(maze, openDoors, {
      firstWaveDelay: cfg.waves.firstWaveDelay,
      waveInterval: cfg.waves.waveInterval
    });
    Towers.init();
    FX.clear();
    Quiz.init(pack);
    Quiz.setLevelTarget(runCfg.difficulty);
    Quiz.setDurationConfig(cfg.quiz.durationMultiplier || 1.0, cfg.quiz.defaultDuration || 8);
    AdaptiveAI.init(runCfg.difficulty);

    runState = {
      pack, cfg: runCfg, maze, openDoors,
      timer: runCfg.timer,
      startTime: performance.now(),
      gameTime: 0,
      criticalAudio: false,
      answeredTotal: 0, answeredCorrect: 0,
      towersPlaced: 0, kills: 0,
      questionsAsked: 0,
      maxQuestions: runCfg.questions,
      combo: 0, bestCombo: 0,
      ended: false,
      lastDoorAttempt: null,
      questionHistory: Storage.getSave().questionHistory || {}
    };

    // Reset HUD diff cache to force first-frame update
    for (const k in hudCache) delete hudCache[k];

    // Visuals
    Renderer.resetCamera();
    if (hud.subject) hud.subject.textContent = `${pack.subject} · Run`;
    if (hud.waveNum) hud.waveNum.textContent = '0';
    if (hud.waveCD)  hud.waveCD.textContent  = '--';
    if (hud.combo)   hud.combo.classList.add('hidden');

    // Ambient music
    Audio.startAmbient(0.0);

    // First-run help
    if (!Storage.getValue('seen_help', false)) showHelp();

    try { window.focus(); } catch (e) {}

    lastTs = performance.now();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  function abandon() {
    if (!runState) return;
    endRun(false);
  }

  function togglePause() {
    if (helpShown) return;
    paused = !paused;
    document.getElementById('pause-overlay').classList.toggle('hidden', !paused);
    if (paused) {
      Audio.stopCritical();
      if (spotPromptEl) { spotPromptEl.remove(); spotPromptEl = null; }
    } else if (runState) {
      runState.criticalAudio = false; // re-trigger if still critical
    }
  }

  // ─── Help overlay ───────────────────────────────────────────────────────
  function showHelp() {
    if (helpShown) return;
    const el = document.getElementById('help-overlay');
    if (!el) return;
    helpPriorPaused = paused;
    paused = true;
    helpShown = true;
    el.classList.remove('hidden');
    document.getElementById('btn-help-close').onclick = closeHelp;
  }
  function closeHelp() {
    document.getElementById('help-overlay').classList.add('hidden');
    helpShown = false;
    paused = helpPriorPaused;
    Storage.setValue('seen_help', true);
    try { window.focus(); } catch (e) {}
  }

  // ─── Main loop ──────────────────────────────────────────────────────────
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!runState || runState.ended) return;

    let dt = Math.min(50, ts - lastTs);
    lastTs = ts;

    // Pause / quiz / help freezes: render the last frame for visual continuity
    if (paused || quizPending) {
      draw(ts);
      return;
    }

    // Hit-stop consumes dt before any sim ticks
    if (hitStopMs > 0) {
      hitStopMs -= dt;
      dt = 0;
    }

    runState.gameTime += dt;

    // ─── Timer ────────────────────────────────────────────────────────────
    runState.timer -= dt / 1000;
    if (runState.timer <= 0) {
      runState.timer = 0;
      endRun(false);
      return;
    }
    // Critical audio onset / offset
    if (runState.timer < cfg.timer.criticalThreshold && !runState.criticalAudio) {
      runState.criticalAudio = true;
      Audio.startCritical();
    } else if (runState.timer >= cfg.timer.criticalThreshold && runState.criticalAudio) {
      runState.criticalAudio = false;
      Audio.stopCritical();
    }

    // ─── Input → player ───────────────────────────────────────────────────
    const player = Player.getState();
    const dx = (input.left || touch.left ? -1 : 0) + (input.right || touch.right ? 1 : 0);
    const dy = (input.up   || touch.up   ? -1 : 0) + (input.down  || touch.down  ? 1 : 0);
    Player.update(dt, { dx, dy });

    // ─── Triggers (doors, exit) ───────────────────────────────────────────
    handleTriggers(player);
    if (runState.ended) return;

    // ─── Enemies + waves ──────────────────────────────────────────────────
    if (Enemies.shouldSpawnWave(runState.gameTime)) {
      const num = Enemies.triggerWave({ difficulty: runState.cfg.difficulty });
      UI.showWaveCard(num);
      Audio.playSpawn();
      Renderer.triggerShake(Constants.SHAKE.WAVE_SPAWN);
      Audio.setAmbientIntensity(Math.min(1.0, 0.2 + num * 0.18));
      hitStopMs = Constants.HIT_STOP.WAVE_START;
    }

    const events = Enemies.update(dt, player, ts);
    if (events.hitPlayer > 0) {
      if (Player.damage(events.hitPlayer)) {
        Audio.playPlayerHit();
        Renderer.triggerShake(Constants.SHAKE.PLAYER_HIT);
        hitStopMs = Constants.HIT_STOP.PLAYER_HIT;
        runState.combo = 0;
        if (player.hp <= 0) { endRun(false); return; }
      }
    }

    // ─── Towers + projectiles ─────────────────────────────────────────────
    const enemiesBefore = Enemies.getList().slice();
    Towers.tick(dt, Enemies.getList(), ts, player);
    detectAndRewardKills(enemiesBefore, ts);

    // ─── FX list housekeeping (evict expired) ─────────────────────────────
    FX.tick(ts);

    // ─── Draw + HUD ───────────────────────────────────────────────────────
    draw(ts);
    drawMinimap();
    updateHud();
    updateSpotPrompt();
  }

  // ─── Trigger handling (doors, exit) ─────────────────────────────────────
  function handleTriggers(player) {
    const cx = (player.x / TILE) | 0;
    const cy = (player.y / TILE) | 0;
    const cell = Maze.cellAt(runState.maze, cx, cy);
    if (!cell) return;

    if (cell.type === 'exit') {
      endRun(true);
      return;
    }

    // Door proximity check: adjacent cell + open wall + pressing toward it
    const localX = player.x - cx * TILE;
    const localY = player.y - cy * TILE;

    let touched = null;
    if (!cell.walls.right  && localX > TILE - 16) touched = neighborDoor(cx, cy, 1, 0, touched, player);
    if (!cell.walls.left   && localX < 16)        touched = neighborDoor(cx, cy, -1, 0, touched, player);
    if (!cell.walls.bottom && localY > TILE - 16) touched = neighborDoor(cx, cy, 0, 1, touched, player);
    if (!cell.walls.top    && localY < 16)        touched = neighborDoor(cx, cy, 0, -1, touched, player);

    if (touched) {
      if (runState.lastDoorAttempt !== touched.doorId) {
        runState.lastDoorAttempt = touched.doorId;
        openQuizForDoor(touched);
      }
    } else {
      runState.lastDoorAttempt = null;
    }
  }

  /** Returns the neighbouring cell if it's a closed door, else current `best`. */
  function neighborDoor(cx, cy, dx, dy, best, player) {
    const adj = Maze.cellAt(runState.maze, cx + dx, cy + dy);
    if (!adj || adj.type !== 'door' || runState.openDoors.has(adj.doorId)) return best;
    // Prefer the door that matches the pressed direction (richer UX)
    const pressingDir =
      (dx === 1 && (input.right || touch.right)) ||
      (dx === -1 && (input.left || touch.left))  ||
      (dy === 1 && (input.down || touch.down))   ||
      (dy === -1 && (input.up || touch.up));
    if (!best) return adj;
    return pressingDir ? adj : best;
  }

  // ─── Action key (E / Space) ─────────────────────────────────────────────
  function tryActionAt() {
    if (!runState || quizPending || paused) return;
    const player = Player.getState();
    const cx = (player.x / TILE) | 0;
    const cy = (player.y / TILE) | 0;
    const cell = Maze.cellAt(runState.maze, cx, cy);
    if (!cell) return;

    if (cell.type === 'tower_spot') {
      if (Towers.listAt(cx, cy)) { UI.toast('Une tour est déjà placée ici'); return; }
      openQuizForTower(cx, cy);
      return;
    }
    // Adjacent closed-door fallback
    const tryDir = (dx, dy, wall) => {
      if (cell.walls[wall]) return false;
      const adj = Maze.cellAt(runState.maze, cx + dx, cy + dy);
      if (adj && adj.type === 'door' && !runState.openDoors.has(adj.doorId)) {
        runState.lastDoorAttempt = adj.doorId;
        openQuizForDoor(adj);
        return true;
      }
      return false;
    };
    if (tryDir(1, 0, 'right'))  return;
    if (tryDir(-1, 0, 'left'))  return;
    if (tryDir(0, 1, 'bottom')) return;
    if (tryDir(0, -1, 'top'))   return;

    UI.toast('Rien à faire ici — trouve un emplacement de tour ✛');
  }

  // ─── Quiz lifecycle ─────────────────────────────────────────────────────
  function openQuizForDoor(doorCell) {
    if (quizPending) return;
    quizPending = true;
    const q = Quiz.pick(runState.questionHistory);
    Quiz.open(q, `Porte ${doorCell.doorId.replace('door_', '#')}`).then(result => {
      processQuizResult(result, q, { kind: 'door', cell: doorCell });
      quizPending = false;
    });
  }
  function openQuizForTower(cx, cy) {
    if (quizPending) return;
    quizPending = true;
    const lvl = AdaptiveAI.getLevel();
    const towerKind = lvl === 1 ? 'slow' : lvl === 2 ? 'destruct' : 'shield';
    const q = Quiz.pick(runState.questionHistory, { requiredLevel: lvl });
    Quiz.open(q, `Tour ${Towers.DEFS[towerKind].label}`).then(result => {
      processQuizResult(result, q, { kind: 'tower', x: cx, y: cy, towerKind });
      quizPending = false;
    });
  }

  /**
   * Resolve a quiz result: update score, combo, timer, place tower / open door.
   * Split into helpers to keep this function readable.
   */
  function processQuizResult(result, question, context) {
    runState.answeredTotal++;
    Storage.recordQuestion(question.id, result.correct, result.elapsedMs);
    runState.questionHistory = Storage.getSave().questionHistory;
    const now = performance.now();
    const player = Player.getState();

    if (result.answered) AdaptiveAI.record(result.correct, result.elapsedMs);

    if (result.correct) resolveCorrect(context, now, player);
    else                resolveWrong(result, now, player);

    runState.questionsAsked++;
    if (runState.cfg.adaptive && runState.questionsAsked % 3 === 0) {
      const dec = AdaptiveAI.adapt({ addTime: (s) => { runState.timer += s; } });
      if (dec.action !== 'maintain') {
        UI.showEventBanner(dec.action === 'increase' ? 'Pression montante' : 'Pression réduite', 1500);
      }
    }
  }

  function resolveCorrect(context, now, player) {
    runState.answeredCorrect++;
    runState.combo++;
    if (runState.combo > runState.bestCombo) runState.bestCombo = runState.combo;

    const mult = comboMultiplier(runState.combo);
    const score = Math.round(100 * mult);
    const timeBonus = cfg.timer.bonusOnCorrect;
    runState.timer += timeBonus;
    Player.addScore(score);

    FX.popup(player.x, player.y - 18, `+${score}`, { color: '#ffd76b', size: 18, duration: 1100, born: now });
    FX.popup(player.x, player.y + 6,  `+${timeBonus}s`, { color: '#36c896', size: 14, duration: 1100, born: now });

    if (runState.combo >= 3) {
      FX.popup(player.x, player.y - 36, `COMBO ×${mult.toFixed(1)}`, { color: '#a87fdf', size: 16, duration: 1200, born: now });
      UI.showEventBanner(`COMBO ×${runState.combo}`, 1200);
    }

    if (context.kind === 'door') {
      runState.openDoors.add(context.cell.doorId);
      Audio.playDoorOpen();
      FX.doorOpen(context.cell.x * TILE + TILE / 2, context.cell.y * TILE + TILE / 2, now);
      Renderer.triggerShake(Constants.SHAKE.DOOR_OPEN);
    } else if (context.kind === 'tower') {
      Towers.place(context.towerKind, context.x, context.y, now);
      Audio.playTowerPlace();
      runState.towersPlaced++;
      Player.addScore(50);
      FX.placeRing(context.x * TILE + TILE / 2, context.y * TILE + TILE / 2, now);
    }
  }

  function resolveWrong(result, now, player) {
    runState.combo = 0;
    const penalty = result.skipped ? cfg.timer.penaltyOnSkip : cfg.timer.penaltyOnWrong;
    runState.timer -= penalty;
    FX.popup(player.x, player.y - 18, `-${penalty}s`, { color: '#ff6b6b', size: 16, duration: 1100, born: now });
    Renderer.triggerShake(Constants.SHAKE.WRONG_ANSWER);
    hitStopMs = Constants.HIT_STOP.WRONG_ANSWER;
  }

  /** Compute combo multiplier from the constants table. */
  function comboMultiplier(combo) {
    const tiers = Constants.COMBO_TIERS;
    for (let i = 0; i < tiers.length; i++) {
      if (combo >= tiers[i].min) return tiers[i].mult;
    }
    return 1.0;
  }

  // ─── Kill detection (compare enemy snapshots before/after tower tick) ───
  function detectAndRewardKills(snapshot, now) {
    const alive = new Set();
    const list = Enemies.getList();
    for (let i = 0; i < list.length; i++) {
      if (list[i].hp > 0) alive.add(list[i]);
    }
    let killed = 0;
    let totalScore = 0;
    for (let i = 0; i < snapshot.length; i++) {
      const e = snapshot[i];
      if (!alive.has(e) || e.hp <= 0) {
        killed++;
        totalScore += e.scoreOnKill || 50;
        FX.killBurst(e.x, e.y, now, e.color || '#ef9f27');
        FX.popup(e.x, e.y - 10, `+${e.scoreOnKill || 50}`, { color: '#ffd76b', size: 14, duration: 900, born: now });
        Renderer.triggerShake(Constants.SHAKE.ENEMY_KILL);
      }
    }
    if (killed > 0) {
      runState.kills += killed;
      Player.addScore(totalScore);
      runState.timer += cfg.timer.bonusOnKill * killed;
      hitStopMs = Math.max(hitStopMs, Constants.HIT_STOP.ENEMY_KILL);
    }
  }

  // ─── Drawing ────────────────────────────────────────────────────────────
  /** Cached camera result for the current frame — read by updateSpotPrompt. */
  let frameCam = { cx: 0, cy: 0 };

  function draw(ts) {
    const player = Player.getState();
    Renderer.clear();
    frameCam = Renderer.cameraOffset(player, runState.maze, ts);
    Renderer.drawMaze(runState.maze, runState.openDoors, frameCam, ts);
    Renderer.drawTowers(Towers.getList(), frameCam, ts);
    Renderer.drawEnemies(Enemies.getList(), frameCam, ts);
    Renderer.drawFx(FX.list(), frameCam, ts);
    Renderer.drawPlayer(player, frameCam, ts);
  }

  // ─── HUD (diffed writes) ────────────────────────────────────────────────
  function updateHud() {
    const player = Player.getState();
    // HP — rebuild only if hp count changed
    if (hudCache.hp !== player.hp) {
      hudCache.hp = player.hp;
      let html = '';
      for (let i = 0; i < player.maxHp; i++) {
        html += `<span class="heart${i < player.hp ? '' : ' empty'}">♥</span>`;
      }
      hud.hp.innerHTML = html;
    }
    // Score
    if (hudCache.score !== player.score) {
      hudCache.score = player.score;
      hud.score.textContent = player.score;
    }
    // Timer (rounded seconds avoid 60Hz churn)
    const tSec = Math.ceil(runState.timer);
    if (hudCache.timer !== tSec) {
      hudCache.timer = tSec;
      hud.timer.textContent = UI.formatTime(runState.timer);
    }
    const critical = runState.timer < cfg.timer.criticalThreshold;
    if (hudCache.critical !== critical) {
      hudCache.critical = critical;
      hud.timer.classList.toggle('critical', critical);
    }
    // Accuracy
    const total = runState.answeredTotal;
    const acc = total > 0 ? Math.round((runState.answeredCorrect / total) * 100) : 0;
    if (hudCache.acc !== acc) {
      hudCache.acc = acc;
      hud.accuracy.textContent = total > 0 ? `${acc}%` : '--%';
      hud.accBar.style.width = acc + '%';
    }
    // Wave
    const remainingS = Math.ceil(Math.max(0, Enemies.getNextWaveAt() - runState.gameTime) / 1000);
    const waveN = Enemies.getWaveNumber();
    if (hudCache.waveNum !== waveN)   { hudCache.waveNum = waveN; hud.waveNum.textContent = waveN; }
    if (hudCache.waveCD !== remainingS) { hudCache.waveCD = remainingS; hud.waveCD.textContent = remainingS + 's'; }
    // Combo display
    if (runState.combo >= 2) {
      const mult = comboMultiplier(runState.combo).toFixed(1);
      if (hudCache.comboVal !== runState.combo) {
        hudCache.comboVal = runState.combo;
        hud.comboVal.textContent = runState.combo;
        hud.comboMult.textContent = '×' + mult;
        // re-trigger CSS animation by toggling
        hud.combo.classList.remove('hidden');
        hud.combo.style.animation = 'none';
        // eslint-disable-next-line no-unused-expressions
        void hud.combo.offsetWidth;
        hud.combo.style.animation = '';
      }
    } else if (!hudCache.comboHidden) {
      hudCache.comboHidden = true;
      hudCache.comboVal = -1;
      hud.combo.classList.add('hidden');
    }
    if (runState.combo >= 2 && hudCache.comboHidden) hudCache.comboHidden = false;
  }

  // ─── Floating tower-spot prompt ─────────────────────────────────────────
  function updateSpotPrompt() {
    const player = Player.getState();
    const cx = (player.x / TILE) | 0;
    const cy = (player.y / TILE) | 0;
    const cell = Maze.cellAt(runState.maze, cx, cy);
    const onSpot = cell && cell.type === 'tower_spot' && !Towers.listAt(cx, cy);
    if (onSpot) {
      if (!spotPromptEl) {
        spotPromptEl = document.createElement('div');
        spotPromptEl.className = 'spot-prompt';
        spotPromptEl.textContent = 'Appuie sur [E] pour poser une tour';
        document.getElementById('screen-game').appendChild(spotPromptEl);
      }
      // Reuse the camera computed for this frame to avoid double-stepping lerp
      spotPromptEl.style.left = (frameCam.cx + player.x) + 'px';
      spotPromptEl.style.top  = (frameCam.cy + player.y) + 'px';
    } else if (spotPromptEl) {
      spotPromptEl.remove();
      spotPromptEl = null;
    }
  }

  // ─── Minimap ────────────────────────────────────────────────────────────
  let miniCtx = null;
  function drawMinimap() {
    const mini = document.getElementById('minimap');
    if (!mini) return;
    if (!miniCtx) miniCtx = mini.getContext('2d');
    const W = mini.width, H = mini.height;
    const maze = runState.maze;
    const cellW = W / maze.width;
    const cellH = H / maze.height;

    miniCtx.fillStyle = '#0a0a1a';
    miniCtx.fillRect(0, 0, W, H);

    // Floors w/ type tints
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const c = maze.grid[y][x];
        let fill = '#16162e';
        if      (c.type === 'entrance')    fill = '#36c896';
        else if (c.type === 'exit')        fill = '#1d9e75';
        else if (c.type === 'tower_spot')  fill = '#444474';
        else if (c.type === 'door')        fill = runState.openDoors.has(c.doorId) ? '#36c896' : '#7c5cbf';
        miniCtx.fillStyle = fill;
        miniCtx.fillRect(x * cellW, y * cellH, cellW, cellH);
      }
    }
    // Walls
    miniCtx.strokeStyle = '#3d3d6d';
    miniCtx.lineWidth = 1;
    miniCtx.beginPath();
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const c = maze.grid[y][x];
        const px = x * cellW, py = y * cellH;
        if (c.walls.top)    { miniCtx.moveTo(px, py);         miniCtx.lineTo(px + cellW, py); }
        if (c.walls.right)  { miniCtx.moveTo(px + cellW, py); miniCtx.lineTo(px + cellW, py + cellH); }
        if (c.walls.bottom) { miniCtx.moveTo(px, py + cellH); miniCtx.lineTo(px + cellW, py + cellH); }
        if (c.walls.left)   { miniCtx.moveTo(px, py);         miniCtx.lineTo(px, py + cellH); }
      }
    }
    miniCtx.stroke();
    // Towers
    const towers = Towers.getList();
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      miniCtx.fillStyle = t.color;
      miniCtx.fillRect(t.x * cellW + cellW * 0.2, t.y * cellH + cellH * 0.2, cellW * 0.6, cellH * 0.6);
    }
    // Enemies
    const en = Enemies.getList();
    miniCtx.fillStyle = '#e24b4a';
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      miniCtx.fillRect((e.x / TILE) * cellW - 1, (e.y / TILE) * cellH - 1, 3, 3);
    }
    // Player
    const player = Player.getState();
    const px = (player.x / TILE) * cellW;
    const py = (player.y / TILE) * cellH;
    miniCtx.fillStyle = '#a87fdf';
    miniCtx.beginPath();
    miniCtx.arc(px, py, 3, 0, Math.PI * 2);
    miniCtx.fill();
    miniCtx.strokeStyle = '#fff'; miniCtx.lineWidth = 1; miniCtx.stroke();
  }

  // ─── End-of-run resolution ──────────────────────────────────────────────
  function endRun(victory) {
    if (!runState || runState.ended) return;
    runState.ended = true;
    Audio.stopCritical();
    Audio.stopAmbient();
    if (spotPromptEl) { spotPromptEl.remove(); spotPromptEl = null; }
    if (hud.combo) hud.combo.classList.add('hidden');

    const acc = runState.answeredTotal > 0 ? runState.answeredCorrect / runState.answeredTotal : 0;
    const stats = AdaptiveAI.getStats() || { avgResponseTime: 0 };

    UI.showResults({
      victory,
      score: Player.getState().score,
      accuracy: acc,
      timeLeft: runState.timer,
      answeredCorrect: runState.answeredCorrect,
      answeredTotal: runState.answeredTotal,
      avgResponseTime: stats.avgResponseTime || 0,
      towersPlaced: runState.towersPlaced,
      kills: runState.kills,
      bestCombo: runState.bestCombo,
      weakTags: computeWeakTags(),
      badges: computeBadges(victory, acc),
      subject: runState.pack.subject
    });
  }

  function computeWeakTags() {
    const history = runState.questionHistory;
    const tagAgg = {};
    for (let i = 0; i < runState.pack.questions.length; i++) {
      const q = runState.pack.questions[i];
      const h = history[q.id];
      if (!h || !h.seen) continue;
      const tags = q.tags || [];
      for (let j = 0; j < tags.length; j++) {
        const t = tags[j];
        if (!tagAgg[t]) tagAgg[t] = { correct: 0, seen: 0 };
        tagAgg[t].correct += h.correct;
        tagAgg[t].seen    += h.seen;
      }
    }
    const arr = [];
    for (const k in tagAgg) {
      const v = tagAgg[k];
      if (v.seen === 0) continue;
      const acc = v.correct / v.seen;
      if (acc < 0.7) arr.push({ tag: k, acc, seen: v.seen });
    }
    arr.sort((a, b) => a.acc - b.acc);
    return arr.slice(0, 5).map(x => `${x.tag} (${Math.round(x.acc * 100)}%, ${x.seen} essai${x.seen > 1 ? 's' : ''})`);
  }

  function computeBadges(victory, acc) {
    const badges = [];
    if (victory) badges.push('Survivant');
    if (acc === 1 && runState.answeredTotal > 0) badges.push('Sans-faute');
    if (acc >= 0.9 && runState.answeredTotal >= 5) badges.push('Lecteur affuté');
    const stats = AdaptiveAI.getStats();
    if (stats && stats.avgResponseTime < 2500 && stats.responseTimesMs.length >= 3) badges.push('Speed demon');
    if (runState.towersPlaced >= 3) badges.push('Architecte');
    if (runState.kills >= 10) badges.push('Exterminateur');
    if (runState.bestCombo >= 5) badges.push(`Combo ×${runState.bestCombo}`);
    return badges;
  }

  // ─── Public API ─────────────────────────────────────────────────────────
  return { init, start, abandon, togglePause, setTouchDir };
})();
