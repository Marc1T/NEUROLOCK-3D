/* ============================================================
   enemies.js — wave management, pathfinding (BFS), updates
   ============================================================ */

const Enemies = (() => {

  const TYPES = {
    bug:    { speed: 0.8,  hp: 1, damage: 1, scoreOnKill: 50 },
    virus:  { speed: 1.2,  hp: 2, damage: 1, scoreOnKill: 100 },
    glitch: { speed: 0.55, hp: 4, damage: 2, scoreOnKill: 250 }
  };

  let list = [];
  let mazeRef = null;
  let openDoorsRef = null;
  let waveNumber = 0;
  let nextWaveAt = 0;
  let waveInterval = 30000;
  let speedMultiplier = 1.0;

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

  function setSpeedMultiplier(m) { speedMultiplier = m; }

  // ---- Spawn a wave ----
  function triggerWave(opts = {}) {
    waveNumber++;
    const spawns = mazeRef.enemySpawns;
    if (!spawns.length) return;

    // Composition by wave number + difficulty
    const comp = composition(waveNumber, opts.difficulty || 2);
    for (const e of comp) {
      const spawn = spawns[Math.floor(Math.random() * spawns.length)];
      spawnEnemy(e, spawn.x, spawn.y);
    }
    nextWaveAt += waveInterval;
    return waveNumber;
  }

  function composition(wave, difficulty) {
    const arr = [];
    const bugs = Math.min(2 + wave + difficulty, 8);
    for (let i = 0; i < bugs; i++) arr.push('bug');
    if (wave >= 2) {
      const v = Math.min(wave - 1 + difficulty - 1, 4);
      for (let i = 0; i < v; i++) arr.push('virus');
    }
    if (wave >= 3 && wave % 2 === 1) arr.push('glitch');
    return arr;
  }

  function spawnEnemy(type, tx, ty) {
    const tile = 32;
    const def = TYPES[type];
    list.push({
      type,
      x: tx * tile + tile / 2,
      y: ty * tile + tile / 2,
      vx: 0, vy: 0,
      hp: def.hp,
      maxHp: def.hp,
      damage: def.damage,
      speed: def.speed,
      scoreOnKill: def.scoreOnKill,
      pathCacheTime: 0,
      path: [],
      slowUntil: 0
    });
  }

  // ---- BFS pathfinding to player ----
  function findPath(from, to) {
    const tile = 32;
    const fx = Math.floor(from.x / tile);
    const fy = Math.floor(from.y / tile);
    const tx = Math.floor(to.x / tile);
    const ty = Math.floor(to.y / tile);
    const start = Maze.cellAt(mazeRef, fx, fy);
    const end = Maze.cellAt(mazeRef, tx, ty);
    if (!start || !end) return [];

    const queue = [start];
    const came = new Map();
    came.set(`${start.x},${start.y}`, null);

    while (queue.length) {
      const cur = queue.shift();
      if (cur.x === end.x && cur.y === end.y) break;
      for (const n of Maze.openNeighbors(mazeRef, cur, mazeRef.width, mazeRef.height)) {
        // Enemies can't cross closed doors either
        if (n.type === 'door' && !openDoorsRef.has(n.doorId)) continue;
        const k = `${n.x},${n.y}`;
        if (!came.has(k)) {
          came.set(k, cur);
          queue.push(n);
        }
      }
    }

    const path = [];
    let cur = end;
    while (cur) {
      path.push({ x: cur.x, y: cur.y });
      cur = came.get(`${cur.x},${cur.y}`);
    }
    return path.reverse();
  }

  // ---- Update all enemies, return events for game.js to consume ----
  function update(dt, playerState, time) {
    const events = { hitPlayer: false };
    const tile = 32;

    for (const e of list) {
      if (e.hp <= 0) continue;

      // recompute path every ~600ms
      if (time - e.pathCacheTime > 600 || !e.path.length) {
        e.path = findPath({ x: e.x, y: e.y }, playerState);
        e.pathCacheTime = time;
      }

      // step towards next cell in path
      if (e.path.length >= 2) {
        const next = e.path[1];
        const targetX = next.x * tile + tile / 2;
        const targetY = next.y * tile + tile / 2;
        const dx = targetX - e.x;
        const dy = targetY - e.y;
        const dist = Math.hypot(dx, dy);

        let sp = e.speed * speedMultiplier * (dt / 16.67);
        if (e.slowUntil > time) sp *= 0.4;

        if (dist > 0.5) {
          e.x += (dx / dist) * sp;
          e.y += (dy / dist) * sp;
        }
      }

      // Player collision
      const dxp = e.x - playerState.x;
      const dyp = e.y - playerState.y;
      if (Math.hypot(dxp, dyp) < 18) {
        events.hitPlayer = events.hitPlayer || e.damage;
        // knockback enemy slightly
        const ang = Math.atan2(dyp, dxp);
        e.x += Math.cos(ang) * 12;
        e.y += Math.sin(ang) * 12;
      }
    }

    // remove dead
    list = list.filter(e => e.hp > 0);

    return events;
  }

  function damageEnemy(e, amount) {
    e.hp -= amount;
  }

  function killAll() {
    list = [];
  }

  function shouldSpawnWave(time) {
    return time >= nextWaveAt;
  }

  function getNextWaveAt() { return nextWaveAt; }

  return {
    init, update, triggerWave, getList, getWaveNumber,
    shouldSpawnWave, getNextWaveAt, damageEnemy, killAll,
    setSpeedMultiplier
  };
})();
