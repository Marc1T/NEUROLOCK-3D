/* ============================================================================
 * renderer.js — All canvas drawing
 *
 * Optimisations vs initial implementation:
 *  • Maze layer (floor + walls) is rasterised once into an offscreen canvas
 *    and re-rasterised ONLY on door-state changes. Composed via drawImage(),
 *    saves ~10 ms/frame on a 25×25 maze.
 *  • Vignette gradient is built once on resize, not every frame.
 *  • Camera: lerped smoothing + velocity-based lookahead so the player sees
 *    where he is going.
 *  • Particles use a 'particle' descriptor with vx/vy + gravity, fully
 *    deterministic from `born` time → no per-frame state allocations.
 * ==========================================================================*/

const Renderer = (() => {

  const TILE = Constants.TILE;

  // ─── Module state ───────────────────────────────────────────────────────
  let ctx = null;
  let canvas = null;
  let dpr = 1;
  let viewW = 0, viewH = 0;

  /** Offscreen canvas holding the rasterised maze. */
  let mazeLayer = null;
  /** State signature used to detect when the maze layer needs a rebuild. */
  let mazeSignature = '';
  /** Cached gradient — rebuilt on resize only. */
  let vignette = null;

  /** Smooth camera position + velocity-based lookahead. */
  const cam = { x: 0, y: 0, lookX: 0, lookY: 0, init: false };

  /** Screen shake state (intensity decays multiplicatively each frame). */
  const shake = { intensity: 0, decay: 0.88 };

  /** Last player position (for derivating velocity used by lookahead). */
  let lastPlayerX = 0, lastPlayerY = 0, lastPlayerT = 0;

  // ─── Palette ────────────────────────────────────────────────────────────
  const COL = Object.freeze({
    floor:      '#16162e',
    floorAlt:   '#18183a',
    wall:       '#3d3d6d',
    entrance:   '#36c896',
    exit:       '#1d9e75',
    doorClosed: '#7c5cbf',
    doorOpen:   '#36c896',
    spawn:      '#e24b4a',
    player:     '#a87fdf'
  });

  // ─── Init + resize ──────────────────────────────────────────────────────
  /**
   * Bind to a canvas element, set up resize handling and DPR scaling.
   * @param {HTMLCanvasElement} canvasEl
   */
  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d', { alpha: false });
    dpr = window.devicePixelRatio || 1;
    resize();
    window.addEventListener('resize', resize);
  }

  /** Resize handler — updates CSS + backing-store size and rebuilds vignette. */
  function resize() {
    if (!canvas) return;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    rebuildVignette();
  }

  /** Build the radial vignette gradient ONCE and reuse it. */
  function rebuildVignette() {
    if (!ctx) return;
    const g = ctx.createRadialGradient(viewW/2, viewH/2, 100, viewW/2, viewH/2, Math.max(viewW, viewH));
    g.addColorStop(0, '#12122a');
    g.addColorStop(1, '#080816');
    vignette = g;
  }

  // ─── Camera ─────────────────────────────────────────────────────────────
  /**
   * Reset camera (called on run start) so the next frame snaps to the
   * spawn point without an animated swing.
   */
  function resetCamera() {
    cam.init = false;
    cam.lookX = 0; cam.lookY = 0;
    shake.intensity = 0;
    lastPlayerT = 0;
  }

  /** Add a shake impulse (intensity in pixels — never decreases the current). */
  function triggerShake(intensity) {
    if (intensity > shake.intensity) shake.intensity = intensity;
  }

  /**
   * Compute clamped + smoothed + lookahead camera offset.
   * Updates internal state and returns {cx, cy} world-to-screen translation.
   * @param {{x:number,y:number}} player
   * @param {object} maze (only width/height are read here)
   * @param {number} now
   */
  function cameraOffset(player, maze, now) {
    const mazeW = maze.width * TILE;
    const mazeH = maze.height * TILE;

    // Derive player velocity (px/sec) for lookahead
    let vx = 0, vy = 0;
    if (lastPlayerT > 0) {
      const dt = Math.max(1, now - lastPlayerT);
      vx = ((player.x - lastPlayerX) / dt) * 1000;
      vy = ((player.y - lastPlayerY) / dt) * 1000;
    }
    lastPlayerX = player.x; lastPlayerY = player.y; lastPlayerT = now;

    // Target lookahead, capped at LOOKAHEAD_PIXELS
    const maxL = Constants.CAMERA.LOOKAHEAD_PIXELS;
    const speedMag = Math.hypot(vx, vy);
    let tLookX = 0, tLookY = 0;
    if (speedMag > 0.5) {
      const cap = Math.min(maxL, speedMag * 0.35);
      tLookX = (vx / speedMag) * cap;
      tLookY = (vy / speedMag) * cap;
    }
    const lk = Constants.CAMERA.LOOKAHEAD_LERP;
    cam.lookX += (tLookX - cam.lookX) * lk;
    cam.lookY += (tLookY - cam.lookY) * lk;

    // Base centred camera with maze-bounds clamping
    let tx = viewW / 2 - player.x - cam.lookX;
    let ty = viewH / 2 - player.y - cam.lookY;
    tx = Math.min(0, Math.max(viewW - mazeW, tx));
    ty = Math.min(0, Math.max(viewH - mazeH, ty));
    if (mazeW < viewW) tx = (viewW - mazeW) / 2;
    if (mazeH < viewH) ty = (viewH - mazeH) / 2;

    // Lerp toward target
    if (!cam.init) {
      cam.x = tx; cam.y = ty; cam.init = true;
    } else {
      const k = Constants.CAMERA.LERP;
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
    }

    // Apply screen shake AFTER lerp so it doesn't decay through smoothing
    let sx = 0, sy = 0;
    if (shake.intensity > 0.1) {
      sx = (Math.random() - 0.5) * shake.intensity;
      sy = (Math.random() - 0.5) * shake.intensity;
      shake.intensity *= shake.decay;
    } else {
      shake.intensity = 0;
    }

    return { cx: cam.x + sx, cy: cam.y + sy };
  }

  // ─── Frame helpers ──────────────────────────────────────────────────────
  /** Paint the dark base + cached vignette. */
  function clear() {
    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, viewW, viewH);
    } else {
      ctx.fillStyle = '#0a0a1a';
      ctx.fillRect(0, 0, viewW, viewH);
    }
  }

  // ─── Maze cache ─────────────────────────────────────────────────────────
  /**
   * Compute a cheap signature of (door state + maze dims) used to detect when
   * the offscreen maze layer needs rebuilding.
   */
  function computeSignature(maze, openDoorIds) {
    // Sorted door-id string keeps signature stable
    const ids = Array.from(openDoorIds).sort().join('|');
    return `${maze.width}x${maze.height}#${ids}`;
  }

  /**
   * Rebuild the offscreen maze layer. Floor tiles + walls + door overlays
   * are all painted here. The result is composited via drawImage each frame.
   */
  function rebuildMazeLayer(maze, openDoorIds) {
    const W = maze.width * TILE;
    const H = maze.height * TILE;
    if (!mazeLayer) mazeLayer = document.createElement('canvas');
    if (mazeLayer.width !== W) mazeLayer.width = W;
    if (mazeLayer.height !== H) mazeLayer.height = H;
    const c = mazeLayer.getContext('2d');
    c.clearRect(0, 0, W, H);

    // Floors
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        c.fillStyle = ((x + y) & 1) ? COL.floorAlt : COL.floor;
        c.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }

    // Walls — single pass, no shadowBlur (kept for the live overlay if needed)
    c.strokeStyle = COL.wall;
    c.lineWidth = 3;
    c.lineCap = 'square';
    c.beginPath();
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const cell = maze.grid[y][x];
        const px = x * TILE, py = y * TILE;
        if (cell.walls.top)    { c.moveTo(px, py);        c.lineTo(px + TILE, py); }
        if (cell.walls.right)  { c.moveTo(px + TILE, py); c.lineTo(px + TILE, py + TILE); }
        if (cell.walls.bottom) { c.moveTo(px, py + TILE); c.lineTo(px + TILE, py + TILE); }
        if (cell.walls.left)   { c.moveTo(px, py);        c.lineTo(px, py + TILE); }
      }
    }
    c.stroke();

    // Door tints (static part — the closed/open glyph is animated in liveLayer)
    for (const d of maze.doors) {
      const px = d.x * TILE, py = d.y * TILE;
      const isOpen = openDoorIds.has(d.id);
      c.fillStyle = isOpen ? 'rgba(54, 200, 150, 0.18)' : 'rgba(124, 92, 191, 0.45)';
      c.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
      c.strokeStyle = isOpen ? COL.doorOpen : COL.doorClosed;
      c.lineWidth = 2;
      c.strokeRect(px + 4, py + 4, TILE - 8, TILE - 8);
    }
  }

  /**
   * Composite the cached maze layer + draw animated overlays
   * (entrance pulse, exit pulse, tower spots, spawn zones, door icons).
   */
  function drawMaze(maze, openDoorIds, cam, time) {
    // Cache-invalidation check
    const sig = computeSignature(maze, openDoorIds);
    if (sig !== mazeSignature) {
      rebuildMazeLayer(maze, openDoorIds);
      mazeSignature = sig;
    }

    ctx.drawImage(mazeLayer, cam.cx, cam.cy);

    // Animated cell overlays — only viewport-visible cells iterated
    const startX = Math.max(0, Math.floor(-cam.cx / TILE));
    const startY = Math.max(0, Math.floor(-cam.cy / TILE));
    const endX = Math.min(maze.width,  Math.ceil((-cam.cx + viewW) / TILE));
    const endY = Math.min(maze.height, Math.ceil((-cam.cy + viewH) / TILE));

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const cell = maze.grid[y][x];
        const px = cam.cx + x * TILE;
        const py = cam.cy + y * TILE;
        switch (cell.type) {
          case 'entrance':   drawEntrance(px, py); break;
          case 'exit':       drawExit(px, py, time); break;
          case 'tower_spot': drawTowerSpot(px, py, time); break;
          case 'enemy_spawn':drawSpawn(px, py, time); break;
          case 'door':       drawDoorIcon(px, py, openDoorIds.has(cell.doorId), time); break;
        }
      }
    }
  }

  function drawEntrance(px, py) {
    ctx.fillStyle = 'rgba(54, 200, 150, 0.18)';
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = COL.entrance;
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('▼', px + TILE/2, py + TILE/2);
  }

  function drawExit(px, py, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t / 250);
    ctx.fillStyle = `rgba(29, 158, 117, ${0.25 + pulse * 0.25})`;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.strokeStyle = COL.exit; ctx.lineWidth = 2;
    ctx.strokeRect(px + 4, py + 4, TILE - 8, TILE - 8);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('EXIT', px + TILE/2, py + TILE/2);
  }

  function drawTowerSpot(px, py, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t / 400);
    ctx.strokeStyle = `rgba(168, 127, 223, ${0.4 + pulse * 0.3})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + 8, py + TILE/2);            ctx.lineTo(px + TILE - 8, py + TILE/2);
    ctx.moveTo(px + TILE/2, py + 8);            ctx.lineTo(px + TILE/2, py + TILE - 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px + TILE/2, py + TILE/2, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawSpawn(px, py, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t / 200);
    ctx.fillStyle = `rgba(226, 75, 74, ${0.10 + pulse * 0.15})`;
    ctx.fillRect(px, py, TILE, TILE);
  }

  function drawDoorIcon(px, py, isOpen, t) {
    if (isOpen) return;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🔒', px + TILE/2, py + TILE/2 + 2);
  }

  // ─── Player ─────────────────────────────────────────────────────────────
  /**
   * Draw the player with idle breathing, direction indicator, iframe flash.
   */
  function drawPlayer(player, cam, time) {
    const px = cam.cx + player.x;
    const py = cam.cy + player.y;
    const breath = 1 + Constants.PLAYER.BREATH_AMP * Math.sin(time / 1000 * Math.PI * 2 * Constants.PLAYER.BREATH_HZ * 0.5);
    const r = 11 * breath;

    // Iframe flash: alternate visibility roughly every 80ms
    const flashing = player.iframes > 0 && (Math.floor(time / 80) & 1);

    if (!flashing) {
      // Soft glow halo
      const grad = ctx.createRadialGradient(px, py, 2, px, py, r * 3);
      grad.addColorStop(0, 'rgba(168,127,223,0.5)');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(px - r * 3, py - r * 3, r * 6, r * 6);

      // Body
      ctx.fillStyle = COL.player;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.stroke();

      // Direction indicator
      const dirX = Math.cos(player.facing || 0) * 6;
      const dirY = Math.sin(player.facing || 0) * 6;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px + dirX, py + dirY, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ─── Enemies ────────────────────────────────────────────────────────────
  function drawEnemies(enemies, cam, time) {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const px = cam.cx + e.x;
      const py = cam.cy + e.y;

      // slowed enemies tinted blue
      const slowed = e.slowUntil > time;

      if (e.type === 'bug') {
        ctx.fillStyle = slowed ? '#80a4ff' : '#e24b4a';
        ctx.fillRect(px - 7, py - 7, 14, 14);
        ctx.strokeStyle = '#ff8a8a';
        ctx.strokeRect(px - 7, py - 7, 14, 14);
      } else if (e.type === 'virus') {
        ctx.fillStyle = slowed ? '#80a4ff' : '#ef9f27';
        ctx.beginPath();
        ctx.moveTo(px, py - 10); ctx.lineTo(px + 10, py);
        ctx.lineTo(px, py + 10); ctx.lineTo(px - 10, py);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#ffcb6e';
        ctx.stroke();
      } else if (e.type === 'glitch') {
        ctx.fillStyle = slowed ? '#80a4ff' : '#7c5cbf';
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + time / 600;
          const r = 13;
          if (k === 0) ctx.moveTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
          else         ctx.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#d1b6ff'; ctx.lineWidth = 2;
        ctx.stroke();
      }

      // HP bar
      if (e.hp < e.maxHp) {
        const w = 22;
        ctx.fillStyle = '#2a2a4a';
        ctx.fillRect(px - w/2, py - 16, w, 3);
        ctx.fillStyle = '#e24b4a';
        ctx.fillRect(px - w/2, py - 16, w * (e.hp / e.maxHp), 3);
      }
    }
  }

  // ─── Towers ─────────────────────────────────────────────────────────────
  function drawTowers(towers, cam, time) {
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      const px = cam.cx + t.x * TILE + TILE/2;
      const py = cam.cy + t.y * TILE + TILE/2;
      const r = 10;
      const ringR = (t.range || 3) * TILE;

      let col = '#3593ff';
      if (t.kind === 'destruct') col = '#ef9f27';
      else if (t.kind === 'shield') col = '#36c896';

      // Range ring (very subtle)
      ctx.strokeStyle = col + '33';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(px, py, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Base
      ctx.fillStyle = '#12122a';
      ctx.beginPath();
      ctx.arc(px, py, r + 2, 0, Math.PI * 2);
      ctx.fill();
      // Core
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      // Turret spin
      const a = time / 400 + (t.spinOffset || 0);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * 4, py + Math.sin(a) * 4);
      ctx.lineTo(px + Math.cos(a) * (r + 4), py + Math.sin(a) * (r + 4));
      ctx.stroke();
    }
  }

  // ─── FX layer ───────────────────────────────────────────────────────────
  /**
   * Render all queued effects. Effects are time-driven (life = (now-born)/duration)
   * so no per-frame state is mutated here.
   */
  function drawFx(fxList, cam, now) {
    for (let i = 0; i < fxList.length; i++) {
      const f = fxList[i];
      const life = (now - f.born) / f.duration;
      if (life > 1 || life < 0) continue;
      const fade = 1 - life;
      const sx = cam.cx + f.x;
      const sy = cam.cy + f.y;

      switch (f.type) {
        case 'hit': {
          ctx.strokeStyle = `rgba(255, 80, 80, ${fade})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx, sy, 6 + life * 14, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'kill': {
          const flash = ctx.createRadialGradient(sx, sy, 0, sx, sy, 30 * (1 + life));
          flash.addColorStop(0, `rgba(255, 255, 255, ${fade * 0.9})`);
          flash.addColorStop(0.4, `rgba(255, 200, 100, ${fade * 0.4})`);
          flash.addColorStop(1, 'transparent');
          ctx.fillStyle = flash;
          ctx.fillRect(sx - 50, sy - 50, 100, 100);
          ctx.strokeStyle = `rgba(255, 200, 100, ${fade})`;
          ctx.lineWidth = 2;
          for (let k = 0; k < 8; k++) {
            const a = k / 8 * Math.PI * 2;
            const r1 = 6 + life * 8;
            const r2 = 12 + life * 28;
            ctx.beginPath();
            ctx.moveTo(sx + Math.cos(a) * r1, sy + Math.sin(a) * r1);
            ctx.lineTo(sx + Math.cos(a) * r2, sy + Math.sin(a) * r2);
            ctx.stroke();
          }
          break;
        }
        case 'particle': {
          // Ballistic with gravity (deterministic from born)
          const tSec = (now - f.born) / 1000;
          const px = f.x + f.vx * tSec;
          const py = f.y + f.vy * tSec + 0.5 * Constants.FX.PARTICLE_GRAVITY * tSec * tSec;
          ctx.fillStyle = f.color || '#fff';
          ctx.globalAlpha = fade;
          ctx.beginPath();
          ctx.arc(cam.cx + px, cam.cy + py, (f.size || 2) * fade, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case 'tower-zap': {
          ctx.strokeStyle = `rgba(53, 147, 255, ${fade})`;
          ctx.lineWidth = 1.5 + fade * 1.5;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(cam.cx + f.tx, cam.cy + f.ty);
          ctx.stroke();
          break;
        }
        case 'projectile': {
          // Lerp from (f.x, f.y) toward live target position
          const targetX = f.target?.x ?? f.x;
          const targetY = f.target?.y ?? f.y;
          const px = f.x + (targetX - f.x) * life;
          const py = f.y + (targetY - f.y) * life;
          ctx.fillStyle = f.color;
          ctx.shadowColor = f.color;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(cam.cx + px, cam.cy + py, Constants.TOWER.PROJECTILE_RADIUS, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          break;
        }
        case 'door-open': {
          ctx.fillStyle = `rgba(54, 200, 150, ${0.7 * fade})`;
          ctx.beginPath();
          ctx.arc(sx, sy, TILE * (1 + life * 1.5), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'text': {
          ctx.fillStyle = f.color || '#fff';
          ctx.font = `bold ${f.size || 14}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.globalAlpha = fade;
          ctx.shadowColor = f.color || '#fff';
          ctx.shadowBlur = 6;
          ctx.fillText(f.text, sx, sy - life * 40);
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
          break;
        }
        case 'place': {
          ctx.strokeStyle = `rgba(168, 127, 223, ${fade})`;
          ctx.lineWidth = 2 + fade * 4;
          ctx.beginPath();
          ctx.arc(sx, sy, life * 40, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
      }
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────
  function getTile() { return TILE; }
  function getView() { return { w: viewW, h: viewH }; }

  return {
    init, clear, resize,
    cameraOffset, triggerShake, resetCamera,
    drawMaze, drawPlayer, drawEnemies, drawTowers, drawFx,
    getTile, getView
  };
})();
