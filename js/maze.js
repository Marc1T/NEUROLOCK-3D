/* ============================================================
   maze.js — procedural labyrinth generator (Recursive Backtracker)
   Outputs : { grid, entrance, exit, doors, towerSpots, enemySpawns }
   Cell    : { walls:{top,right,bottom,left}, visited, type, doorId }
   ============================================================ */

const Maze = (() => {

  function createGrid(w, h) {
    const grid = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        row.push({
          x, y,
          walls: { top: true, right: true, bottom: true, left: true },
          visited: false,
          type: 'normal',
          doorId: null
        });
      }
      grid.push(row);
    }
    return grid;
  }

  function neighbors(grid, cell, w, h) {
    const dirs = [
      { dx: 0, dy: -1, wall: 'top',    opposite: 'bottom' },
      { dx: 1, dy: 0,  wall: 'right',  opposite: 'left'   },
      { dx: 0, dy: 1,  wall: 'bottom', opposite: 'top'    },
      { dx: -1, dy: 0, wall: 'left',   opposite: 'right'  }
    ];
    const out = [];
    for (const d of dirs) {
      const nx = cell.x + d.dx;
      const ny = cell.y + d.dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        out.push({ cell: grid[ny][nx], dir: d });
      }
    }
    return out;
  }

  function carve(grid, w, h) {
    // Iterative DFS to avoid stack overflows on big mazes
    const stack = [];
    const start = grid[0][0];
    start.visited = true;
    stack.push(start);

    while (stack.length) {
      const current = stack[stack.length - 1];
      const candidates = neighbors(grid, current, w, h).filter(n => !n.cell.visited);
      if (!candidates.length) {
        stack.pop();
        continue;
      }
      const choice = candidates[Math.floor(Math.random() * candidates.length)];
      // knock walls between current and choice.cell
      current.walls[choice.dir.wall] = false;
      choice.cell.walls[choice.dir.opposite] = false;
      choice.cell.visited = true;
      stack.push(choice.cell);
    }
  }

  /* ---- BFS shortest path between two cells (used for door placement) ---- */
  function bfs(grid, w, h, start, end) {
    const queue = [start];
    const came = new Map();
    came.set(`${start.x},${start.y}`, null);
    while (queue.length) {
      const cur = queue.shift();
      if (cur.x === end.x && cur.y === end.y) break;
      const nbrs = openNeighbors(grid, cur, w, h);
      for (const n of nbrs) {
        const k = `${n.x},${n.y}`;
        if (!came.has(k)) {
          came.set(k, cur);
          queue.push(n);
        }
      }
    }
    // reconstruct
    const path = [];
    let cur = end;
    while (cur) {
      path.push(cur);
      cur = came.get(`${cur.x},${cur.y}`);
    }
    return path.reverse();
  }

  function openNeighbors(mazeOrGrid, cell, w, h) {
    // Accept either a maze object {grid, width, height} or a raw grid array
    const g = mazeOrGrid.grid || mazeOrGrid;
    const result = [];
    if (!cell.walls.top    && cell.y > 0)     result.push(g[cell.y - 1][cell.x]);
    if (!cell.walls.right  && cell.x < w - 1) result.push(g[cell.y][cell.x + 1]);
    if (!cell.walls.bottom && cell.y < h - 1) result.push(g[cell.y + 1][cell.x]);
    if (!cell.walls.left   && cell.x > 0)     result.push(g[cell.y][cell.x - 1]);
    return result;
  }

  /* ---- Place doors evenly on the critical path ---- */
  function placeDoors(grid, path, count) {
    const doors = [];
    if (path.length < count + 2) count = Math.max(1, path.length - 2);
    const step = Math.floor(path.length / (count + 1));
    for (let i = 1; i <= count; i++) {
      const cell = path[i * step];
      if (!cell) continue;
      // avoid placing doors on entrance/exit
      if (cell.type !== 'entrance' && cell.type !== 'exit') {
        cell.type = 'door';
        cell.doorId = `door_${i}`;
        doors.push({ x: cell.x, y: cell.y, id: cell.doorId });
      }
    }
    return doors;
  }

  /* ---- Place tower spots on cells far from path ---- */
  function placeTowerSpots(grid, w, h, path, count) {
    const pathSet = new Set(path.map(c => `${c.x},${c.y}`));
    const candidates = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = grid[y][x];
        if (c.type !== 'normal') continue;
        if (pathSet.has(`${x},${y}`)) continue;
        candidates.push(c);
      }
    }
    // shuffle
    candidates.sort(() => Math.random() - 0.5);
    const spots = [];
    for (let i = 0; i < Math.min(count, candidates.length); i++) {
      candidates[i].type = 'tower_spot';
      spots.push({ x: candidates[i].x, y: candidates[i].y });
    }
    return spots;
  }

  /* ---- Place enemy spawns in corners opposite to entrance ---- */
  function placeEnemySpawns(grid, w, h) {
    const spawns = [];
    const candidates = [
      grid[h - 1][0],
      grid[0][w - 1],
      grid[h - 1][w - 1]
    ];
    for (const c of candidates) {
      if (c.type === 'normal') {
        c.type = 'enemy_spawn';
        spawns.push({ x: c.x, y: c.y });
      }
    }
    return spawns;
  }

  function generate(w, h, opts = {}) {
    const doorsCount = opts.doorsCount ?? 5;
    const towerSpotsCount = opts.towerSpotsCount ?? 10;

    const grid = createGrid(w, h);
    carve(grid, w, h);

    const entrance = grid[0][0];
    const exit = grid[h - 1][w - 1];
    entrance.type = 'entrance';
    exit.type = 'exit';

    const path = bfs(grid, w, h, entrance, exit);
    const doors = placeDoors(grid, path, doorsCount);
    const towerSpots = placeTowerSpots(grid, w, h, path, towerSpotsCount);
    const enemySpawns = placeEnemySpawns(grid, w, h);

    return {
      width: w,
      height: h,
      grid,
      entrance: { x: entrance.x, y: entrance.y },
      exit:     { x: exit.x, y: exit.y },
      doors, towerSpots, enemySpawns,
      criticalPath: path.map(c => ({ x: c.x, y: c.y }))
    };
  }

  /* ---- Helpers used at runtime ---- */
  function cellAt(maze, x, y) {
    if (x < 0 || y < 0 || x >= maze.width || y >= maze.height) return null;
    return maze.grid[y][x];
  }

  function isWalkable(maze, x, y, openDoorIds = new Set()) {
    const c = cellAt(maze, x, y);
    if (!c) return false;
    if (c.type === 'door' && !openDoorIds.has(c.doorId)) return false;
    return true;
  }

  function canMoveBetween(maze, fromX, fromY, toX, toY) {
    // Pre-condition : cells are adjacent (cardinal)
    const a = cellAt(maze, fromX, fromY);
    const b = cellAt(maze, toX, toY);
    if (!a || !b) return false;
    if (toX === fromX + 1) return !a.walls.right;
    if (toX === fromX - 1) return !a.walls.left;
    if (toY === fromY + 1) return !a.walls.bottom;
    if (toY === fromY - 1) return !a.walls.top;
    return false;
  }

  return {
    generate, cellAt, openNeighbors, isWalkable, canMoveBetween, bfs
  };
})();
