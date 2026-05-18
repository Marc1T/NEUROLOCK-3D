/* ============================================================
   game.js — main game loop, run state, glue between modules
   ============================================================ */

const Game = (() => {

  let cfg = null;
  let runState = null;
  let canvas = null;
  let lastTs = 0;
  let rafId = null;
  let input = { up: false, down: false, left: false, right: false };
  let touch = { up: false, down: false, left: false, right: false };
  let quizPending = false;
  let paused = false;

  const MOVE_KEYS = {
    up:    ['arrowup', 'w', 'z'],
    down:  ['arrowdown', 's'],
    left:  ['arrowleft', 'a', 'q'],
    right: ['arrowright', 'd']
  };
  const ACTION_KEYS = ['e', ' ', 'enter'];
  const PAUSE_KEYS = ['escape', 'p'];

  function init(globalConfig) {
    cfg = globalConfig;
    canvas = document.getElementById('game-canvas');
    Renderer.init(canvas);

    const handler = (down) => (ev) => {
      // Ignore if user is typing in an input
      const target = ev.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const k = ev.key.toLowerCase();
      let consumed = false;
      for (const dir of ['up', 'down', 'left', 'right']) {
        if (MOVE_KEYS[dir].includes(k)) {
          // Always update flags even during quiz, so released keys don't stick
          input[dir] = down && !quizPending;
          consumed = true;
        }
      }
      if (down && !quizPending) {
        if (ACTION_KEYS.includes(k)) { tryActionAt(); consumed = true; }
        if (PAUSE_KEYS.includes(k))  { togglePause(); consumed = true; }
        if (k === '?' || k === 'h')  { showHelp(); consumed = true; }
      }
      if (consumed) ev.preventDefault();
    };

    // Attach on both window and document for redundancy across browsers
    window.addEventListener('keydown', handler(true));
    window.addEventListener('keyup',   handler(false));

    // When window loses focus, release all keys (prevents sticky-key bug)
    window.addEventListener('blur', () => {
      input.up = input.down = input.left = input.right = false;
    });
  }

  function setTouchDir(dir, down) {
    if (dir === 'action') {
      if (down) tryActionAt();
      return;
    }
    touch[dir] = down;
  }

  function start(pack, runCfg) {
    Audio.init();
    if (!pack || !pack.questions?.length) {
      UI.toast('Aucun cours chargé');
      UI.showScreen('home');
      return;
    }

    paused = false;
    quizPending = false;

    // Generate maze
    const maze = Maze.generate(cfg.maze.width, cfg.maze.height, {
      doorsCount: cfg.maze.doorsCount,
      towerSpotsCount: cfg.maze.towerSpotsCount
    });

    const openDoors = new Set();

    // Init systems
    const player = Player.init(maze, openDoors, { speed: cfg.player.speed, hp: cfg.player.hp });
    Enemies.init(maze, openDoors, { firstWaveDelay: cfg.waves.firstWaveDelay, waveInterval: cfg.waves.waveInterval });
    Towers.init();
    Quiz.init(pack);
    Quiz.setLevelTarget(runCfg.difficulty);
    Quiz.setDurationConfig(cfg.quiz.durationMultiplier || 1.0, cfg.quiz.defaultDuration || 8);
    AdaptiveAI.init(runCfg.difficulty);

    runState = {
      pack,
      cfg: runCfg,
      maze,
      openDoors,
      timer: runCfg.timer,
      startTime: performance.now(),
      gameTime: 0,            // ms of ACTIVE play (excludes pause/quiz/help)
      criticalAudio: false,
      answeredTotal: 0,
      answeredCorrect: 0,
      towersPlaced: 0,
      kills: 0,
      questionsAsked: 0,
      maxQuestions: runCfg.questions,
      combo: 0,
      bestCombo: 0,
      ended: false,
      questionHistory: Storage.getSave().questionHistory || {}
    };

    // Reset visual state
    Renderer.resetCamera();

    // Subject in HUD
    document.getElementById('hud-subject').textContent = `${pack.subject} · Run`;

    // Reset wave display
    document.getElementById('wave-number').textContent = '0';
    document.getElementById('wave-countdown').textContent = '--';

    // Show help overlay first run
    if (!Storage.getValue('seen_help', false)) {
      showHelp();
    }

    // Try to ensure window focus so keys land here
    try { window.focus(); } catch (e) {}

    // Ambient music
    Audio.startAmbient(0.0);

    lastTs = performance.now();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  let helpShown = false;
  let helpPriorPaused = false;

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
    const el = document.getElementById('help-overlay');
    if (el) el.classList.add('hidden');
    helpShown = false;
    paused = helpPriorPaused;
    Storage.setValue('seen_help', true);
    try { window.focus(); } catch (e) {}
  }

  function abandon() {
    if (!runState) return;
    endRun(false);
  }

  function togglePause() {
    paused = !paused;
    document.getElementById('pause-overlay').classList.toggle('hidden', !paused);
    if (paused) {
      Audio.stopCritical();
      if (spotPromptEl) { spotPromptEl.remove(); spotPromptEl = null; }
    } else if (runState) {
      // Reset critical-audio flag so loop re-triggers it if timer still low
      runState.criticalAudio = false;
    }
  }

  // ---- Main loop ----
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!runState || runState.ended) return;

    const dt = Math.min(50, ts - lastTs);
    lastTs = ts;

    if (paused || quizPending) {
      // Draw current frame anyway (frozen). gameTime does NOT advance.
      draw(ts);
      return;
    }

    // Active-play time accumulator (excludes pause + quiz + help)
    runState.gameTime += dt;

    // ---- Timer ----
    runState.timer -= dt / 1000;
    if (runState.timer <= 0) {
      runState.timer = 0;
      endRun(false);
      return;
    }
    if (runState.timer < cfg.timer.criticalThreshold && !runState.criticalAudio) {
      runState.criticalAudio = true;
      Audio.startCritical();
    }
    if (runState.timer >= cfg.timer.criticalThreshold && runState.criticalAudio) {
      runState.criticalAudio = false;
      Audio.stopCritical();
    }

    // ---- Input → player ----
    const player = Player.getState();
    let dx = 0, dy = 0;
    if (input.left || touch.left) dx -= 1;
    if (input.right || touch.right) dx += 1;
    if (input.up || touch.up) dy -= 1;
    if (input.down || touch.down) dy += 1;
    Player.update(dt, { dx, dy });

    // ---- Trigger checks: doors and tower spots ----
    const tile = 32;
    const cx = Math.floor(player.x / tile);
    const cy = Math.floor(player.y / tile);
    const cell = Maze.cellAt(runState.maze, cx, cy);
    if (cell) {
      // Exit → victory
      if (cell.type === 'exit') {
        endRun(true);
        return;
      }

      // Door : detect proximity (player can't physically enter a closed door,
      // so check adjacent cells). Trigger when player is pressing toward door
      // and close to the boundary.
      const localX = player.x - cx * tile;
      const localY = player.y - cy * tile;
      const dirs = [
        { dx: 1, dy: 0, wall: 'right',  press: input.right || touch.right, distToBoundary: tile - localX },
        { dx: -1, dy: 0, wall: 'left',  press: input.left  || touch.left,  distToBoundary: localX },
        { dx: 0, dy: 1, wall: 'bottom', press: input.down  || touch.down,  distToBoundary: tile - localY },
        { dx: 0, dy: -1, wall: 'top',   press: input.up    || touch.up,    distToBoundary: localY }
      ];
      let touchingDoor = null;
      for (const d of dirs) {
        if (cell.walls[d.wall]) continue;            // wall between → can't reach
        if (d.distToBoundary > 16) continue;         // too far
        const adj = Maze.cellAt(runState.maze, cx + d.dx, cy + d.dy);
        if (adj && adj.type === 'door' && !runState.openDoors.has(adj.doorId)) {
          touchingDoor = adj;
          if (d.press) break; // prefer pressed direction
        }
      }
      if (touchingDoor) {
        if (runState.lastDoorAttempt !== touchingDoor.doorId) {
          runState.lastDoorAttempt = touchingDoor.doorId;
          openQuizForDoor(touchingDoor);
        }
      } else {
        runState.lastDoorAttempt = null;
      }
    }

    // ---- Enemies ----
    if (Enemies.shouldSpawnWave(runState.gameTime)) {
      const num = Enemies.triggerWave({ difficulty: runState.cfg.difficulty });
      UI.showEventBanner(`Vague ${num}`);
      Audio.playSpawn();
      Renderer.triggerShake(6);
      // Ambient ramps up with wave count
      Audio.setAmbientIntensity(Math.min(1.0, 0.2 + num * 0.18));
    }
    const events = Enemies.update(dt, player, ts);
    if (events.hitPlayer) {
      if (Player.damage(events.hitPlayer)) {
        Audio.playPlayerHit();
        Renderer.triggerShake(12);
        // combo broken by damage too
        runState.combo = 0;
        if (player.hp <= 0) {
          endRun(false);
          return;
        }
      }
    }

    // Track kills with burst FX
    const beforeList = Enemies.getList().slice();
    Towers.tick(dt, Enemies.getList(), ts, player);
    const aliveAfter = new Set(Enemies.getList().filter(e => e.hp > 0));
    const justKilled = beforeList.filter(e => !aliveAfter.has(e) || e.hp <= 0);
    for (const e of justKilled) {
      const col = e.type === 'glitch' ? '#a87fdf' : e.type === 'virus' ? '#ef9f27' : '#ff8a8a';
      Renderer.spawnKillBurst(Towers.getFx(), e.x, e.y, ts, col);
      Towers.pushFx({ type: 'text', x: e.x, y: e.y - 10, text: `+${e.scoreOnKill || 50}`, color: '#ffd76b', born: ts, duration: 900 });
      Renderer.triggerShake(4);
    }
    if (justKilled.length > 0) {
      runState.kills += justKilled.length;
      const total = justKilled.reduce((s, e) => s + (e.scoreOnKill || 50), 0);
      Player.addScore(total);
      runState.timer += cfg.timer.bonusOnKill * justKilled.length;
    }

    // ---- Draw ----
    draw(ts);
    drawMinimap();

    // ---- HUD ----
    updateHud(ts);
    updateSpotPrompt();
  }

  function draw(ts) {
    const player = Player.getState();
    Renderer.clear();
    const cam = Renderer.cameraOffset(player, runState.maze);
    Renderer.drawMaze(runState.maze, runState.openDoors, cam, ts);
    Renderer.drawTowers(Towers.getList(), cam, ts);
    Renderer.drawEnemies(Enemies.getList(), cam, ts);
    Renderer.drawFx(Towers.getFx(), cam, ts);
    Renderer.drawPlayer(player, cam, ts);
  }

  function updateHud(ts) {
    const player = Player.getState();
    // HP
    const hpBox = document.getElementById('hud-hp');
    let hp = '';
    for (let i = 0; i < player.maxHp; i++) {
      hp += `<span class="heart${i < player.hp ? '' : ' empty'}">♥</span>`;
    }
    hpBox.innerHTML = hp;

    document.getElementById('hud-score').textContent = player.score;

    // Timer
    const tEl = document.getElementById('hud-timer');
    tEl.textContent = UI.formatTime(runState.timer);
    tEl.classList.toggle('critical', runState.timer < cfg.timer.criticalThreshold);

    // Accuracy
    const total = runState.answeredTotal;
    const acc = total > 0 ? Math.round((runState.answeredCorrect / total) * 100) : 0;
    document.getElementById('hud-accuracy').textContent = total > 0 ? `${acc}%` : '--%';
    document.getElementById('hud-accuracy-bar').style.width = acc + '%';

    // Wave info — based on active-play time, not wall clock
    const remainingMs = Math.max(0, Enemies.getNextWaveAt() - runState.gameTime);
    document.getElementById('wave-number').textContent = Enemies.getWaveNumber();
    document.getElementById('wave-countdown').textContent = Math.ceil(remainingMs / 1000) + 's';

    // Combo display
    const comboBox = document.getElementById('combo-display');
    if (runState.combo >= 2) {
      const mult = comboMultiplier(runState.combo).toFixed(1);
      const cv = document.getElementById('combo-value');
      const cm = document.getElementById('combo-mult');
      if (cv.textContent !== String(runState.combo)) {
        // re-animate on update
        comboBox.style.animation = 'none';
        // force reflow
        void comboBox.offsetWidth;
        comboBox.style.animation = '';
      }
      cv.textContent = runState.combo;
      cm.textContent = '×' + mult;
      comboBox.classList.remove('hidden');
    } else {
      comboBox.classList.add('hidden');
    }
  }

  // ---- Tower-spot floating prompt ----
  let spotPromptEl = null;
  function updateSpotPrompt() {
    const player = Player.getState();
    const cx = Math.floor(player.x / 32);
    const cy = Math.floor(player.y / 32);
    const cell = Maze.cellAt(runState.maze, cx, cy);
    const onSpot = cell && cell.type === 'tower_spot' && !Towers.listAt(cx, cy);
    if (onSpot) {
      if (!spotPromptEl) {
        spotPromptEl = document.createElement('div');
        spotPromptEl.className = 'spot-prompt';
        document.getElementById('screen-game').appendChild(spotPromptEl);
      }
      spotPromptEl.textContent = 'Appuie sur [E] pour poser une tour';
      const cam = Renderer.cameraOffset(player, runState.maze);
      spotPromptEl.style.left = (cam.cx + player.x) + 'px';
      spotPromptEl.style.top  = (cam.cy + player.y) + 'px';
    } else if (spotPromptEl) {
      spotPromptEl.remove();
      spotPromptEl = null;
    }
  }

  // ---- Minimap ----
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

    // Floor cells (very faint)
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const c = maze.grid[y][x];
        let fill = '#16162e';
        if (c.type === 'entrance') fill = '#36c896';
        else if (c.type === 'exit') fill = '#1d9e75';
        else if (c.type === 'tower_spot') fill = '#444474';
        else if (c.type === 'door') fill = runState.openDoors.has(c.doorId) ? '#36c896' : '#7c5cbf';
        miniCtx.fillStyle = fill;
        miniCtx.fillRect(x * cellW, y * cellH, cellW, cellH);
      }
    }

    // Walls
    miniCtx.strokeStyle = '#3d3d6d';
    miniCtx.lineWidth = 1;
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const c = maze.grid[y][x];
        const px = x * cellW, py = y * cellH;
        miniCtx.beginPath();
        if (c.walls.top)    { miniCtx.moveTo(px, py);          miniCtx.lineTo(px + cellW, py); }
        if (c.walls.right)  { miniCtx.moveTo(px + cellW, py);  miniCtx.lineTo(px + cellW, py + cellH); }
        if (c.walls.bottom) { miniCtx.moveTo(px, py + cellH);  miniCtx.lineTo(px + cellW, py + cellH); }
        if (c.walls.left)   { miniCtx.moveTo(px, py);          miniCtx.lineTo(px, py + cellH); }
        miniCtx.stroke();
      }
    }

    // Towers
    for (const t of Towers.getList()) {
      let col = '#3593ff';
      if (t.kind === 'destruct') col = '#ef9f27';
      else if (t.kind === 'shield') col = '#36c896';
      miniCtx.fillStyle = col;
      miniCtx.fillRect(t.x * cellW + cellW * 0.2, t.y * cellH + cellH * 0.2, cellW * 0.6, cellH * 0.6);
    }

    // Enemies
    for (const e of Enemies.getList()) {
      miniCtx.fillStyle = '#e24b4a';
      const ex = (e.x / 32) * cellW;
      const ey = (e.y / 32) * cellH;
      miniCtx.fillRect(ex - 1, ey - 1, 3, 3);
    }

    // Player
    const player = Player.getState();
    const px = (player.x / 32) * cellW;
    const py = (player.y / 32) * cellH;
    miniCtx.fillStyle = '#a87fdf';
    miniCtx.beginPath();
    miniCtx.arc(px, py, 3, 0, Math.PI * 2);
    miniCtx.fill();
    miniCtx.strokeStyle = '#fff';
    miniCtx.lineWidth = 1;
    miniCtx.stroke();
  }

  // ---- Quiz triggers ----
  function openQuizForDoor(doorCell) {
    if (quizPending) return;
    quizPending = true;
    const q = Quiz.pick(runState.questionHistory);
    Quiz.open(q, `Porte ${doorCell.doorId.replace('door_', '#')}`).then(result => {
      processQuizResult(result, q, { kind: 'door', cell: doorCell });
      quizPending = false;
    });
  }

  function tryActionAt() {
    if (!runState || quizPending || paused) return;
    const player = Player.getState();
    const cx = Math.floor(player.x / 32);
    const cy = Math.floor(player.y / 32);
    const cell = Maze.cellAt(runState.maze, cx, cy);
    if (!cell) return;

    if (cell.type === 'tower_spot') {
      if (Towers.listAt(cx, cy)) {
        UI.toast('Une tour est déjà placée ici');
        return;
      }
      openQuizForTower(cx, cy);
      return;
    }

    // Adjacent closed door?
    const adjacent = [
      { dx: 1, dy: 0, wall: 'right' },
      { dx: -1, dy: 0, wall: 'left' },
      { dx: 0, dy: 1, wall: 'bottom' },
      { dx: 0, dy: -1, wall: 'top' }
    ];
    for (const d of adjacent) {
      if (cell.walls[d.wall]) continue;
      const adj = Maze.cellAt(runState.maze, cx + d.dx, cy + d.dy);
      if (adj && adj.type === 'door' && !runState.openDoors.has(adj.doorId)) {
        runState.lastDoorAttempt = adj.doorId;
        openQuizForDoor(adj);
        return;
      }
    }

    UI.toast('Rien à faire ici — trouve un emplacement de tour ✛');
  }

  function openQuizForTower(cx, cy) {
    if (quizPending) return;
    quizPending = true;
    // type depends on adaptive level
    const lvl = AdaptiveAI.getLevel();
    const kind = lvl === 1 ? 'slow' : lvl === 2 ? 'destruct' : 'shield';
    const q = Quiz.pick(runState.questionHistory, { requiredLevel: lvl });
    Quiz.open(q, `Tour ${Towers.DEFS[kind].label}`).then(result => {
      processQuizResult(result, q, { kind: 'tower', x: cx, y: cy, towerKind: kind });
      quizPending = false;
    });
  }

  function processQuizResult(result, question, context) {
    runState.answeredTotal++;
    Storage.recordQuestion(question.id, result.correct, result.elapsedMs);
    runState.questionHistory = Storage.getSave().questionHistory;
    const now = performance.now();
    const player = Player.getState();

    if (result.answered) {
      AdaptiveAI.record(result.correct, result.elapsedMs);
    }

    if (result.correct) {
      runState.answeredCorrect++;
      runState.combo++;
      if (runState.combo > runState.bestCombo) runState.bestCombo = runState.combo;

      // Combo multiplier
      const multiplier = comboMultiplier(runState.combo);
      const baseScore = 100;
      const score = Math.round(baseScore * multiplier);
      const timeBonus = cfg.timer.bonusOnCorrect;
      runState.timer += timeBonus;
      Player.addScore(score);

      // Float popups near player
      Towers.pushFx({ type: 'text', x: player.x, y: player.y - 18, text: `+${score}`, color: '#ffd76b', size: 18, born: now, duration: 1100 });
      Towers.pushFx({ type: 'text', x: player.x, y: player.y + 6, text: `+${timeBonus}s`, color: '#36c896', size: 14, born: now, duration: 1100 });
      if (runState.combo >= 3) {
        Towers.pushFx({ type: 'text', x: player.x, y: player.y - 36, text: `COMBO ×${multiplier.toFixed(1)}`, color: '#a87fdf', size: 16, born: now, duration: 1200 });
        UI.showEventBanner(`COMBO ×${runState.combo}`, 1200);
      }

      if (context.kind === 'door') {
        runState.openDoors.add(context.cell.doorId);
        Audio.playDoorOpen();
        Towers.pushFx({ type: 'door-open', x: context.cell.x * 32 + 16, y: context.cell.y * 32 + 16, born: now, duration: 500 });
        Renderer.triggerShake(3);
      } else if (context.kind === 'tower') {
        Towers.place(context.towerKind, context.x, context.y, now);
        Audio.playTowerPlace();
        runState.towersPlaced++;
        Player.addScore(50);
        Towers.pushFx({ type: 'place', x: context.x * 32 + 16, y: context.y * 32 + 16, born: now, duration: 500 });
      }
    } else {
      // Wrong / skip → break combo
      runState.combo = 0;
      const penalty = result.skipped ? cfg.timer.penaltyOnSkip : cfg.timer.penaltyOnWrong;
      runState.timer -= penalty;
      Towers.pushFx({ type: 'text', x: player.x, y: player.y - 18, text: `-${penalty}s`, color: '#ff6b6b', size: 16, born: now, duration: 1100 });
      Renderer.triggerShake(8);
    }

    runState.questionsAsked++;
    if (runState.cfg.adaptive && runState.questionsAsked % 3 === 0) {
      const dec = AdaptiveAI.adapt({ addTime: (s) => { runState.timer += s; } });
      if (dec.action !== 'maintain') {
        UI.showEventBanner(dec.action === 'increase' ? 'Pression montante' : 'Pression réduite', 1500);
      }
    }
  }

  function comboMultiplier(combo) {
    if (combo >= 10) return 3.0;
    if (combo >= 7)  return 2.5;
    if (combo >= 5)  return 2.0;
    if (combo >= 3)  return 1.5;
    return 1.0;
  }

  // ---- End run ----
  function endRun(victory) {
    if (!runState || runState.ended) return;
    runState.ended = true;
    Audio.stopCritical();
    Audio.stopAmbient();
    if (spotPromptEl) { spotPromptEl.remove(); spotPromptEl = null; }
    // hide combo display
    const cb = document.getElementById('combo-display');
    if (cb) cb.classList.add('hidden');

    const acc = runState.answeredTotal > 0 ? runState.answeredCorrect / runState.answeredTotal : 0;
    const stats = AdaptiveAI.getStats() || { avgResponseTime: 0 };

    // weak tags = tags from incorrectly answered questions
    const weakTags = computeWeakTags();
    const badges = computeBadges(victory, acc);

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
      weakTags,
      badges,
      subject: runState.pack.subject
    });
  }

  function computeWeakTags() {
    const history = runState.questionHistory;
    const tagAgg = {};
    for (const q of runState.pack.questions) {
      const h = history[q.id];
      if (!h || !h.seen) continue;
      for (const tag of (q.tags || [])) {
        if (!tagAgg[tag]) tagAgg[tag] = { correct: 0, seen: 0 };
        tagAgg[tag].correct += h.correct;
        tagAgg[tag].seen += h.seen;
      }
    }
    const arr = Object.entries(tagAgg)
      .filter(([, v]) => v.seen >= 1)
      .map(([k, v]) => ({ tag: k, acc: v.correct / v.seen, seen: v.seen }))
      .filter(x => x.acc < 0.7)
      .sort((a, b) => a.acc - b.acc)
      .slice(0, 5);
    return arr.map(x => `${x.tag} (${Math.round(x.acc * 100)}%, ${x.seen} essai${x.seen > 1 ? 's' : ''})`);
  }

  function computeBadges(victory, acc) {
    const badges = [];
    const save = Storage.getSave();
    if (!save.unlockedBadges?.includes('first_run')) badges.push('Première run');
    if (victory) badges.push('Survivant');
    if (acc === 1 && runState.answeredTotal > 0) badges.push('Sans-faute');
    if (acc >= 0.9 && runState.answeredTotal >= 5) badges.push('Lecteur affuté');
    const stats = AdaptiveAI.getStats();
    if (stats && stats.avgResponseTime < 2500 && stats.responseTimesMs.length >= 3) badges.push('Speed demon');
    if (runState.towersPlaced >= 3) badges.push('Architecte');
    if (runState.kills >= 10) badges.push('Exterminateur');
    return badges;
  }

  return { init, start, abandon, togglePause, setTouchDir };
})();
