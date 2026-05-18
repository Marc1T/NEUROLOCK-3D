/* ============================================================================
 * player.js — Player movement, collisions, input
 *
 * Position is in pixels (player center). Collision tests are run cell-by-cell
 * with axis-by-axis movement (allowing slide along walls).
 *
 * Optimisations:
 *  • Static sample-point pool reused across frames — zero allocation in canBeAt.
 *  • Early-return on out-of-bounds for fast wall-rejection.
 *
 * Closed-door semantics:
 *  • The center cell governs door passage. Samples are only used for
 *    out-of-bounds detection — this lets the player graze the door's edge
 *    so game.js can detect proximity and open the quiz overlay.
 * ==========================================================================*/

const Player = (() => {

  const TILE = Constants.TILE;
  const RADIUS = Constants.PLAYER.RADIUS;
  const PAD = Constants.PLAYER.PAD;

  /** @type {object|null} */
  let state = null;
  /** @type {object|null} */
  let mazeRef = null;
  /** @type {Set<string>} */
  let openDoors = new Set();

  /** Pre-allocated sample point pool reused by canBeAt(). */
  const SAMPLES = [
    { x: 0, y: 0 }, { x: 0, y: 0 },
    { x: 0, y: 0 }, { x: 0, y: 0 }
  ];

  /**
   * Initialise the player state. Player is spawned at maze.entrance.
   * @param {object} maze
   * @param {Set<string>} openDoorsSet shared with Game/Enemies
   * @param {{speed?:number, hp?:number}} [opts]
   */
  function init(maze, openDoorsSet, opts = {}) {
    mazeRef = maze;
    openDoors = openDoorsSet;
    state = {
      x: maze.entrance.x * TILE + TILE / 2,
      y: maze.entrance.y * TILE + TILE / 2,
      vx: 0, vy: 0,
      speed: opts.speed ?? 2.5,
      hp: opts.hp ?? 3,
      maxHp: opts.hp ?? 3,
      score: 0,
      facing: 0,
      iframes: 0
    };
    return state;
  }

  function getState() { return state; }

  /**
   * Update position from input direction.
   * @param {number} dt frame delta in ms
   * @param {{dx:number,dy:number}} inputDir raw input (will be normalised)
   */
  function update(dt, inputDir) {
    if (!state) return;
    const dx = inputDir.dx, dy = inputDir.dy;
    const mag = Math.hypot(dx, dy);

    let nx = 0, ny = 0;
    if (mag > 0.01) {
      nx = dx / mag; ny = dy / mag;
      state.facing = Math.atan2(ny, nx);
    }
    state.vx = nx; state.vy = ny;

    const sp = state.speed * (dt / 16.67); // 60fps-normalised

    // Axis-by-axis movement allows sliding along walls
    const newX = state.x + nx * sp;
    if (canBeAt(newX, state.y)) state.x = newX;

    const newY = state.y + ny * sp;
    if (canBeAt(state.x, newY)) state.y = newY;

    if (state.iframes > 0) state.iframes -= dt;
  }

  /**
   * Closed-form collision check. Closed doors block the CENTER cell only —
   * samples just guard against leaving the maze.
   * @param {number} px proposed center x
   * @param {number} py proposed center y
   * @returns {boolean} whether the player can occupy this position
   */
  function canBeAt(px, py) {
    // Reuse static sample pool
    SAMPLES[0].x = px - RADIUS; SAMPLES[0].y = py - RADIUS;
    SAMPLES[1].x = px + RADIUS; SAMPLES[1].y = py - RADIUS;
    SAMPLES[2].x = px - RADIUS; SAMPLES[2].y = py + RADIUS;
    SAMPLES[3].x = px + RADIUS; SAMPLES[3].y = py + RADIUS;

    for (let i = 0; i < 4; i++) {
      const s = SAMPLES[i];
      const sx = (s.x / TILE) | 0;       // bit-or 0 = Math.floor for positives
      const sy = (s.y / TILE) | 0;
      if (s.x < 0 || s.y < 0 || sx >= mazeRef.width || sy >= mazeRef.height) return false;
    }

    const cx = (px / TILE) | 0;
    const cy = (py / TILE) | 0;
    const cell = mazeRef.grid[cy][cx];
    if (!cell) return false;
    if (cell.type === 'door' && !openDoors.has(cell.doorId)) return false;

    const localX = px - cx * TILE;
    const localY = py - cy * TILE;

    if (cell.walls.left   && localX < RADIUS + PAD) return false;
    if (cell.walls.right  && localX > TILE - RADIUS - PAD) return false;
    if (cell.walls.top    && localY < RADIUS + PAD) return false;
    if (cell.walls.bottom && localY > TILE - RADIUS - PAD) return false;
    return true;
  }

  /** @returns {{x:number,y:number}} current cell coordinates */
  function currentCell() {
    return { x: (state.x / TILE) | 0, y: (state.y / TILE) | 0 };
  }

  /**
   * Apply damage with iframe protection. Returns true if damage landed.
   * @param {number} [amount]
   */
  function damage(amount = 1) {
    if (state.iframes > 0) return false;
    state.hp -= amount;
    state.iframes = Constants.PLAYER.IFRAMES_MS;
    return true;
  }

  function heal(amount = 1) {
    state.hp = Math.min(state.maxHp, state.hp + amount);
  }

  function addScore(n) { state.score += n; }

  return { init, getState, update, currentCell, damage, heal, addScore };
})();
