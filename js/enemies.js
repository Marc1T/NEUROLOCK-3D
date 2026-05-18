/* ============================================================================
 * enemies.js — Wave management, BFS pathfinding, enemy state
 *
 * Architecture:
 *  • Enemies hold their own state. The module exposes pure functions
 *    (init/triggerWave/update/etc) and never reaches into other modules
 *    for state; events are pushed via FX (kill bursts, damage numbers).
 *  • BFS path is cached for 600ms per enemy — recomputed only when stale.
 *  • Player collision uses squared distance (sqrt avoided).
 * ==========================================================================*/

const Enemies = (() => {

  const TILE = Constants.TILE;

  /** Static definitions per enemy archetype. */
  const TYPES = Object.freeze({
    bug:    Object.freeze({ speed: 0.8,  hp: 1, damage: 1, scoreOnKill: 50,  color: '#ff8a8a' }),
    virus:  Object.freeze({ speed: 1.2,  hp: 2, damage: 1, scoreOnKill: 100, color: '#ef9f27' }),
    glitch: Object.freeze({ speed: 0.55, hp: 4, damage: 2, scoreOnKill: 250, color: '#a87fdf' })
  });

  /** @type {Array<object>} live enemies */
  let list = [];
  let mazeRef = null;
  /** @type {Set<string>} */
  let openDoorsRef = null;
  let waveNumber = 0;
  let nextWaveAt = 0;
  let waveInterval = 30000;
  let speedMultiplier = 1.0;

  /**
   * Initialise enemy pool. Resets all state.
   */
  function init(maze, openDoors, opts = {}) {
    list = [];
    mazeRef = maze;
    openDoorsRef = openDoors;
    waveNumber = 0;
    nextWaveAt = (opts.firstWaveDelay ?? 10) * 1000;
    waveInterval = (opts.waveInterval ?? 30) * 1000;
    speedMultiplier = 1.0;
  }

  function getList() { return list; }
  function getWaveNumber() { return waveNumber; }
  function getNextWaveAt() { return nextWaveAt; }
  function setSpeedMultiplier(m) { speedMultiplier = m; }
  function shouldSpawnWave(gameTime) { return gameTime >= nextWaveAt; }

  /**
   * Trigger the next wave. Composition scales with wave number + difficulty.
   * @param {{difficulty?:number}} [opts]
   * @returns {number} wave number that just started
   */
  function triggerWave(opts = {}) {
    waveNumber++;
    const spawns = mazeRef.enemySpawns;
    if (!spawns.length) return waveNumber;
    const comp = composition(waveNumber, opts.difficulty || 2);
    for (let i = 0; i < comp.length; i++) {
      const spawn = spawns[(Math.random() * spawns.length) | 0];
      spawnEnemy(comp[i], spawn.x, spawn.y);
    }
    nextWaveAt += waveInterval;
    return waveNumber;
  }

  /** Build a wave composition array (e.g. ["bug","bug","virus"]). */
  function composition(wave, difficulty) {
    const arr = [];
    const bugs = Math.min(2 + wave + difficulty, 8);
    for (let i = 0; i < bugs; i++) arr.push('bug');
    if (wave >= 2) {
      const v = Math.min(wave - 1 + difficulty - 1, 4);
      for (let i = 0; i < v; i++) arr.push('virus');
    }
    if (wave >= 3 && (wave & 1) === 1) arr.push('glitch');
    return arr;
  }

  function spawnEnemy(type, tx, ty) {
    const def = TYPES[type];
    list.push({
      type,
      x: tx * TILE + TILE / 2,
      y: ty * TILE + TILE / 2,
      vx: 0, vy: 0,
      hp: def.hp,
      maxHp: def.hp,
      damage: def.damage,
      speed: def.speed,
      scoreOnKill: def.scoreOnKill,
      color: def.color,
      pathCacheTime: 0,
      path: null,
      pathIndex: 1,
      slowUntil: 0
    });
  }

  /**
   * Cell-grid BFS from enemy to player. Skips closed doors.
   * @returns {Array<{x:number,y:number}>} path (start → end)
   */
  function findPath(fromX, fromY, toX, toY) {
    const fx = (fromX / TILE) | 0;
    const fy = (fromY / TILE) | 0;
    const tx = (toX / TILE) | 0;
    const ty = (toY / TILE) | 0;

    if (fx < 0 || fy < 0 || fx >= mazeRef.width || fy >= mazeRef.height) return null;
    if (tx < 0 || ty < 0 || tx >= mazeRef.width || ty >= mazeRef.height) return null;

    const start = mazeRef.grid[fy][fx];
    const end = mazeRef.grid[ty][tx];

    // Use a head-index queue (avoid Array.shift O(n))
    const queue = [start];
    let head = 0;
    const came = new Map();
    came.set(`${start.x},${start.y}`, null);

    while (head < queue.length) {
      const cur = queue[head++];
      if (cur === end) break;
      // Inline 4-neighbour expansion
      const x = cur.x, y = cur.y;
      if (!cur.walls.top && y > 0) {
        const n = mazeRef.grid[y - 1][x];
        if (!(n.type === 'door' && !openDoorsRef.has(n.doorId))) {
          const k = `${n.x},${n.y}`;
          if (!came.has(k)) { came.set(k, cur); queue.push(n); }
        }
      }
      if (!cur.walls.right && x < mazeRef.width - 1) {
        const n = mazeRef.grid[y][x + 1];
        if (!(n.type === 'door' && !openDoorsRef.has(n.doorId))) {
          const k = `${n.x},${n.y}`;
          if (!came.has(k)) { came.set(k, cur); queue.push(n); }
        }
      }
      if (!cur.walls.bottom && y < mazeRef.height - 1) {
        const n = mazeRef.grid[y + 1][x];
        if (!(n.type === 'door' && !openDoorsRef.has(n.doorId))) {
          const k = `${n.x},${n.y}`;
          if (!came.has(k)) { came.set(k, cur); queue.push(n); }
        }
      }
      if (!cur.walls.left && x > 0) {
        const n = mazeRef.grid[y][x - 1];
        if (!(n.type === 'door' && !openDoorsRef.has(n.doorId))) {
          const k = `${n.x},${n.y}`;
          if (!came.has(k)) { came.set(k, cur); queue.push(n); }
        }
      }
    }

    if (!came.has(`${end.x},${end.y}`)) return null;
    const path = [];
    let cur = end;
    while (cur) {
      path.push({ x: cur.x, y: cur.y });
      cur = came.get(`${cur.x},${cur.y}`);
    }
    path.reverse();
    return path;
  }

  /**
   * Update all enemies. Returns the maximum damage to apply to the player
   * this frame (or 0). Damage stacking is intentional — multiple enemy
   * contacts in one frame still only deal `max(damage)` because player
   * iframes will cover subsequent hits.
   *
   * @param {number} dt frame delta (ms)
   * @param {{x:number,y:number}} playerState
   * @param {number} time performance.now()
   * @returns {{hitPlayer:number}}
   */
  function update(dt, playerState, time) {
    let hitPlayer = 0;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.hp <= 0) continue;

      // Recompute path if stale or missing
      if (!e.path || time - e.pathCacheTime > 600) {
        e.path = findPath(e.x, e.y, playerState.x, playerState.y);
        e.pathCacheTime = time;
        e.pathIndex = 1;
      }

      // Step toward path[pathIndex]
      if (e.path && e.path.length > e.pathIndex) {
        const next = e.path[e.pathIndex];
        const targetX = next.x * TILE + TILE / 2;
        const targetY = next.y * TILE + TILE / 2;
        const dx = targetX - e.x;
        const dy = targetY - e.y;
        const distSq = dx * dx + dy * dy;

        let sp = e.speed * speedMultiplier * (dt / 16.67);
        if (e.slowUntil > time) sp *= 0.4;

        if (distSq < 4) {
          // Snap to waypoint and advance
          e.x = targetX; e.y = targetY;
          e.pathIndex++;
        } else {
          // Avoid sqrt: scale (dx,dy) by sp/sqrt(distSq) — but we need 1 sqrt anyway
          const dist = Math.sqrt(distSq);
          e.x += (dx / dist) * sp;
          e.y += (dy / dist) * sp;
        }
      }

      // Player collision via squared distance
      const dxp = e.x - playerState.x;
      const dyp = e.y - playerState.y;
      const dsq = dxp * dxp + dyp * dyp;
      if (dsq < Constants.ENEMY.PLAYER_HIT_DIST_SQ) {
        if (e.damage > hitPlayer) hitPlayer = e.damage;
        // Knockback enemy
        const ang = Math.atan2(dyp, dxp);
        const kb = Constants.ENEMY.KNOCKBACK_PX;
        e.x += Math.cos(ang) * kb;
        e.y += Math.sin(ang) * kb;
      }
    }

    // Garbage-collect dead enemies in-place (no allocation)
    let write = 0;
    for (let read = 0; read < list.length; read++) {
      if (list[read].hp > 0) {
        if (write !== read) list[write] = list[read];
        write++;
      }
    }
    list.length = write;

    return { hitPlayer };
  }

  /**
   * Apply damage to a specific enemy + spawn a floating damage number.
   * @param {object} e enemy reference
   * @param {number} amount
   * @param {number} now performance.now()
   */
  function damageEnemy(e, amount, now) {
    e.hp -= amount;
    FX.popup(e.x, e.y - 8, `-${amount}`, { color: '#ff8a8a', size: 12, duration: 700, born: now });
  }

  function killAll() { list = []; }

  return {
    init, update, triggerWave, getList, getWaveNumber,
    shouldSpawnWave, getNextWaveAt, damageEnemy, killAll,
    setSpeedMultiplier, TYPES
  };
})();
