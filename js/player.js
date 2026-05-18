/* ============================================================
   player.js — movement, collisions, input
   Position is in PIXELS (not tile coords).
   Collisions are tested cell-by-cell using maze walls.
   ============================================================ */

const Player = (() => {
  const RADIUS = 11;     // collision radius
  const PAD = 1;         // tile padding so we never quite touch walls

  let state = null;
  let mazeRef = null;
  let openDoors = new Set();

  function init(maze, openDoorsSet, opts = {}) {
    mazeRef = maze;
    openDoors = openDoorsSet;
    const tile = 32;
    state = {
      x: maze.entrance.x * tile + tile / 2,
      y: maze.entrance.y * tile + tile / 2,
      vx: 0, vy: 0,
      speed: opts.speed ?? 2.5,
      hp: opts.hp ?? 3,
      maxHp: opts.hp ?? 3,
      score: 0,
      facing: 0,
      iframes: 0,
      lastDoorHit: null
    };
    return state;
  }

  function getState() { return state; }

  function update(dt, inputDir) {
    if (!state) return;
    const { dx, dy } = inputDir; // -1..1
    const tile = 32;

    // normalize
    let mag = Math.hypot(dx, dy);
    let nx = 0, ny = 0;
    if (mag > 0.01) {
      nx = dx / mag;
      ny = dy / mag;
      state.facing = Math.atan2(ny, nx);
    }

    const sp = state.speed * (dt / 16.67); // dt-normalized to 60fps base

    // Move axis-by-axis with wall collision
    const newX = state.x + nx * sp;
    if (canBeAt(newX, state.y)) state.x = newX;

    const newY = state.y + ny * sp;
    if (canBeAt(state.x, newY)) state.y = newY;

    // iframes countdown
    if (state.iframes > 0) state.iframes -= dt;
  }

  // ----- collision check: is the disc at (px,py) clear of walls? -----
  // Closed doors are treated as solid blocks ONLY for the cell containing the
  // player center — this lets the player graze the door's edge so the trigger
  // logic in game.js can detect proximity and open the quiz overlay.
  function canBeAt(px, py) {
    const tile = 32;

    // Samples just check the player isn't being pushed outside the maze
    const samples = [
      { x: px - RADIUS, y: py - RADIUS },
      { x: px + RADIUS, y: py - RADIUS },
      { x: px - RADIUS, y: py + RADIUS },
      { x: px + RADIUS, y: py + RADIUS }
    ];
    for (const s of samples) {
      const cx = Math.floor(s.x / tile);
      const cy = Math.floor(s.y / tile);
      const cell = Maze.cellAt(mazeRef, cx, cy);
      if (!cell) return false;
    }

    // The cell the player center is in determines wall + door collisions
    const cx = Math.floor(px / tile);
    const cy = Math.floor(py / tile);
    const cell = Maze.cellAt(mazeRef, cx, cy);
    if (!cell) return false;

    // Closed door = treat the whole cell as solid (don't let center enter)
    if (cell.type === 'door' && !openDoors.has(cell.doorId)) return false;

    const localX = px - cx * tile;
    const localY = py - cy * tile;

    if (cell.walls.left   && localX < RADIUS + PAD) return false;
    if (cell.walls.right  && localX > tile - RADIUS - PAD) return false;
    if (cell.walls.top    && localY < RADIUS + PAD) return false;
    if (cell.walls.bottom && localY > tile - RADIUS - PAD) return false;

    return true;
  }

  function currentCell() {
    const tile = 32;
    return { x: Math.floor(state.x / tile), y: Math.floor(state.y / tile) };
  }

  function damage(amount = 1) {
    if (state.iframes > 0) return false;
    state.hp -= amount;
    state.iframes = 800;
    return true;
  }

  function heal(amount = 1) {
    state.hp = Math.min(state.maxHp, state.hp + amount);
  }

  function addScore(n) {
    state.score += n;
  }

  return { init, getState, update, currentCell, damage, heal, addScore };
})();
