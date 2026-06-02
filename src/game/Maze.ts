import { TILE_SIZE, MAZE_SIZE, MazeAlgorithm, braidingForLevel, mazeAlgorithmForLevel, roomCountForLevel } from '../types';

type Cell = { x: number; y: number };

export type MazeOptions = {
  level?: number;
  algorithm?: MazeAlgorithm;
  braidProbability?: number;
  roomCount?: number;
  randomizeEntryExit?: boolean;
};

export class Maze {
  // 0: clear, 1: wall, 2: door, 3: tower spot, 4: entry, 5: exit
  grid: number[][];
  width: number;
  height: number;
  doors: { x: number; y: number; open: boolean }[] = [];
  towerSpots: { x: number; y: number; occupied: boolean }[] = [];
  spawns: Cell[] = [];
  entry: Cell;
  exit: Cell;
  level: number;
  algorithm: MazeAlgorithm;

  constructor(w = MAZE_SIZE, h = MAZE_SIZE, options: MazeOptions = {}) {
    this.width = w * 2 + 1;
    this.height = h * 2 + 1;
    this.grid = Array(this.height).fill(0).map(() => Array(this.width).fill(1));
    this.level = Math.max(1, options.level ?? 1);
    this.algorithm = options.algorithm ?? mazeAlgorithmForLevel(this.level);

    // Default entry/exit (overridden by setEntryExitForLevel later if randomized)
    this.entry = { x: 1, y: 1 };
    this.exit = { x: this.width - 2, y: this.height - 2 };

    const braid = options.braidProbability ?? braidingForLevel(this.level);
    const rooms = options.roomCount ?? roomCountForLevel(this.level);
    const randomize = options.randomizeEntryExit ?? this.level >= 2;

    this.generate(w, h, braid, rooms, randomize);
  }

  generate(w: number, h: number, braidProbability: number, roomCount: number, randomizeEntryExit: boolean) {
    // 1. Carve corridors with recursive DFS
    this.generateDFS(w, h);

    // 2. Braid: remove some dead-end walls so the maze has loops (more interesting routing)
    this.braid(braidProbability);

    // 3. Optionally carve open rooms — breaks the monotony of single-tile corridors
    if (roomCount > 0) this.carveRooms(roomCount);

    // 4. Pick entry/exit (random diagonal corners from L2+, fixed top-left/bottom-right at L1)
    if (randomizeEntryExit) this.pickDiagonalEntryExit();
    this.grid[this.entry.y][this.entry.x] = 4;
    this.grid[this.exit.y][this.exit.x] = 5;

    // 5. Place doors at corridor bottlenecks on the entry→exit path, towers at intersections
    this.placeDoorsAndSpots();

    // 6. Spawns: 3 corners that aren't the entry, in priority order — enemies converge
    this.placeSpawns();
  }

  private generateDFS(w: number, h: number) {
    const stack: [number, number][] = [[0, 0]];
    const visited = new Set<string>();
    visited.add('0,0');

    while (stack.length > 0) {
      const [currX, currY] = stack[stack.length - 1];
      const neighbors: [number, number][] = [];
      const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
      for (const [dx, dy] of dirs) {
        const nx = currX + dx, ny = currY + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !visited.has(`${nx},${ny}`)) {
          neighbors.push([nx, ny]);
        }
      }
      if (neighbors.length > 0) {
        const [nextX, nextY] = neighbors[Math.floor(Math.random() * neighbors.length)];
        this.grid[currY * 2 + 1][currX * 2 + 1] = 0;
        this.grid[nextY * 2 + 1][nextX * 2 + 1] = 0;
        this.grid[currY + nextY + 1][currX + nextX + 1] = 0;
        visited.add(`${nextX},${nextY}`);
        stack.push([nextX, nextY]);
      } else {
        stack.pop();
      }
    }
  }

  private braid(probability: number) {
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        if (this.grid[y][x] === 1) {
          const horizontal = this.grid[y][x - 1] === 0 && this.grid[y][x + 1] === 0;
          const vertical = this.grid[y - 1][x] === 0 && this.grid[y + 1][x] === 0;
          if ((horizontal || vertical) && Math.random() < probability) {
            this.grid[y][x] = 0;
          }
        }
      }
    }
  }

  /** Carve N small open rooms (3×3) into the maze. Each room is connected because it
   *  intersects existing corridors (DFS already covers every odd cell). */
  private carveRooms(count: number) {
    const tries = count * 4;
    let placed = 0;
    let attempts = 0;
    const rooms: { x: number; y: number; w: number; h: number }[] = [];
    while (placed < count && attempts < tries) {
      attempts++;
      const rw = 3;
      const rh = 3;
      // Anchor at odd indices to align with the DFS corridor grid
      const ox = 1 + 2 * Math.floor(Math.random() * Math.floor((this.width - rw - 2) / 2));
      const oy = 1 + 2 * Math.floor(Math.random() * Math.floor((this.height - rh - 2) / 2));
      // Keep rooms away from each other (Chebyshev distance ≥ 4)
      const tooClose = rooms.some(r => Math.max(Math.abs(r.x - ox), Math.abs(r.y - oy)) < 4);
      if (tooClose) continue;
      // Don't overwrite entry/exit
      const overlapsKeyCells =
        (ox <= this.entry.x && this.entry.x < ox + rw && oy <= this.entry.y && this.entry.y < oy + rh) ||
        (ox <= this.exit.x && this.exit.x < ox + rw && oy <= this.exit.y && this.exit.y < oy + rh);
      if (overlapsKeyCells) continue;

      for (let dy = 0; dy < rh; dy++) {
        for (let dx = 0; dx < rw; dx++) {
          this.grid[oy + dy][ox + dx] = 0;
        }
      }
      rooms.push({ x: ox, y: oy, w: rw, h: rh });
      placed++;
    }
  }

  /** Place entry and exit at diagonally-opposite corners chosen at random. */
  private pickDiagonalEntryExit() {
    const corners: Cell[] = [
      { x: 1, y: 1 },
      { x: this.width - 2, y: 1 },
      { x: 1, y: this.height - 2 },
      { x: this.width - 2, y: this.height - 2 },
    ];
    const entryIdx = Math.floor(Math.random() * corners.length);
    this.entry = corners[entryIdx];
    // Diagonal opposite: the corner that differs on BOTH axes
    const diag = corners.find(c => c.x !== this.entry.x && c.y !== this.entry.y)!;
    this.exit = diag;
  }

  private placeSpawns() {
    const candidates: Cell[] = [
      { x: 1, y: 1 },
      { x: this.width - 2, y: 1 },
      { x: 1, y: this.height - 2 },
      { x: this.width - 2, y: this.height - 2 },
    ];
    const spawns: Cell[] = [];
    for (const c of candidates) {
      if (c.x === this.entry.x && c.y === this.entry.y) continue;
      if (!this.isWalkableCell(c.x, c.y)) continue;
      spawns.push(c);
    }
    // Fallback to entry if every corner is unwalkable (very small mazes)
    this.spawns = spawns.length > 0 ? spawns : [this.entry];
  }

  /** Returns the count of walkable (non-wall) 4-neighbours of (x,y). */
  private cellDegree(x: number, y: number): number {
    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    let d = 0;
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
      if (this.grid[ny][nx] !== 1) d++;
    }
    return d;
  }

  /** Public: returns the corridor axis at a cell, treating doors as walkable for orientation. */
  corridorAxisAt(x: number, y: number): 'h' | 'v' {
    const left = x > 0 && this.grid[y][x - 1] !== 1;
    const right = x < this.width - 1 && this.grid[y][x + 1] !== 1;
    // Vertical corridor = the door's wide axis is N-S, so the door panel runs East-West (perpendicular)
    // We return the AXIS THE CORRIDOR runs along; the renderer reads this to orient the panel.
    if (left || right) return 'h';
    return 'v';
  }

  /** Returns the type of corridor at (x,y): 'h' = horizontal, 'v' = vertical, null otherwise. */
  private corridorAxis(x: number, y: number): 'h' | 'v' | null {
    const left = x > 0 && this.grid[y][x - 1] !== 1;
    const right = x < this.width - 1 && this.grid[y][x + 1] !== 1;
    const up = y > 0 && this.grid[y - 1][x] !== 1;
    const down = y < this.height - 1 && this.grid[y + 1][x] !== 1;
    if (left && right && !up && !down) return 'h';
    if (up && down && !left && !right) return 'v';
    return null;
  }

  /** Pure-walkability BFS path (ignores doors/state — used during generation). */
  private rawBfsPath(start: Cell, end: Cell): Cell[] {
    if (start.x === end.x && start.y === end.y) return [start];
    const prev = new Map<string, string | null>();
    prev.set(`${start.x},${start.y}`, null);
    const queue: Cell[] = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.x === end.x && cur.y === end.y) break;
      const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx, ny = cur.y + dy;
        const key = `${nx},${ny}`;
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        if (this.grid[ny][nx] === 1) continue;
        if (prev.has(key)) continue;
        prev.set(key, `${cur.x},${cur.y}`);
        queue.push({ x: nx, y: ny });
      }
    }
    // Reconstruct
    const path: Cell[] = [];
    let k: string | null = `${end.x},${end.y}`;
    if (!prev.has(k)) return [];
    while (k) {
      const [sx, sy] = k.split(',').map(Number);
      path.unshift({ x: sx, y: sy });
      k = prev.get(k) ?? null;
    }
    return path;
  }

  /**
   * Place doors at corridor bottlenecks along the entry→exit path,
   * and tower spots at intersections (degree ≥ 3) scattered around the maze.
   */
  private placeDoorsAndSpots() {
    const path = this.rawBfsPath(this.entry, this.exit);

    // Door candidates: corridor cells (single-tile-wide passage) on the main path,
    // excluding the cells adjacent to entry/exit so the first/last steps aren't gated.
    const candidates: Cell[] = [];
    for (let i = 2; i < path.length - 2; i++) {
      const c = path[i];
      if (this.corridorAxis(c.x, c.y) !== null) {
        candidates.push(c);
      }
    }

    // Pick evenly-spaced candidates to spread doors across the run
    const targetDoors = Math.min(7, Math.max(3, Math.floor(candidates.length / 4)));
    const placed: Cell[] = [];
    if (candidates.length > 0 && targetDoors > 0) {
      const step = candidates.length / targetDoors;
      for (let i = 0; i < targetDoors; i++) {
        const c = candidates[Math.floor(i * step)];
        // Avoid placing two doors adjacent to each other
        if (placed.some(p => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) <= 1)) continue;
        placed.push(c);
      }
    }
    for (const c of placed) {
      this.grid[c.y][c.x] = 2;
      this.doors.push({ x: c.x, y: c.y, open: false });
    }

    // Tower spots: intersections (degree ≥ 3). Scattered, not too clustered.
    const intersections: Cell[] = [];
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        if (this.grid[y][x] !== 0) continue;
        if (this.cellDegree(x, y) >= 3) intersections.push({ x, y });
      }
    }
    // Shuffle (Fisher-Yates) for variety, then pick keeping a min distance of 2
    for (let i = intersections.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [intersections[i], intersections[j]] = [intersections[j], intersections[i]];
    }
    const targetSpots = 12;
    for (const c of intersections) {
      if (this.towerSpots.length >= targetSpots) break;
      if (this.towerSpots.some(s => Math.abs(s.x - c.x) + Math.abs(s.y - c.y) < 3)) continue;
      this.grid[c.y][c.x] = 3;
      this.towerSpots.push({ x: c.x, y: c.y, occupied: false });
    }

    // Fallback: if we couldn't reach the target via intersections (small maze), top up randomly
    let fallback = 0;
    while (this.towerSpots.length < Math.min(8, targetSpots) && fallback < 200) {
      fallback++;
      const rx = 1 + Math.floor(Math.random() * (this.width - 2));
      const ry = 1 + Math.floor(Math.random() * (this.height - 2));
      if (this.grid[ry][rx] !== 0) continue;
      if (this.towerSpots.some(s => Math.abs(s.x - rx) + Math.abs(s.y - ry) < 3)) continue;
      this.grid[ry][rx] = 3;
      this.towerSpots.push({ x: rx, y: ry, occupied: false });
    }
  }

  private isWalkableCell(x: number, y: number) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    const t = this.grid[y][x];
    return t !== 1;
  }

  // BFS Pathfinding for enemies
  getPath(startX: number, startY: number, endX: number, endY: number): [number, number][] {
    const start = [Math.floor(startX), Math.floor(startY)];
    const end = [Math.floor(endX), Math.floor(endY)];
    if (start[0] === end[0] && start[1] === end[1]) return [];

    const queue: [number, number, [number, number][]][] = [[start[0], start[1], []]];
    const visited = new Set<string>();
    visited.add(`${start[0]},${start[1]}`);

    while (queue.length > 0) {
      const [x, y, path] = queue.shift()!;
      if (x === end[0] && y === end[1]) return path;

      const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        const posKey = `${nx},${ny}`;
        if (
          nx >= 0 && nx < this.width && ny >= 0 && ny < this.height &&
          !visited.has(posKey) && this.grid[ny][nx] !== 1
        ) {
          if (this.grid[ny][nx] === 2) {
            const door = this.doors.find(d => d.x === nx && d.y === ny);
            if (door && !door.open) continue;
          }
          visited.add(posKey);
          queue.push([nx, ny, [...path, [nx, ny]]]);
        }
      }
    }
    return [];
  }

  isWall(x: number, y: number) {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) return true;
    const tile = this.grid[ty][tx];
    if (tile === 1) return true;
    if (tile === 2) {
      const door = this.doors.find(d => d.x === tx && d.y === ty);
      return door ? !door.open : true;
    }
    return false;
  }
}
