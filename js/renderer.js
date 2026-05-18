/* ============================================================
   renderer.js — all Canvas drawing
   ============================================================ */

const Renderer = (() => {
  let ctx = null;
  let canvas = null;
  let dpr = 1;
  let viewW = 0, viewH = 0;
  const tile = 32;

  // Smooth camera: stored position that lerps toward target
  let smoothCam = { x: 0, y: 0, init: false };

  // Screen shake state
  let shake = { intensity: 0, decay: 0.88 };

  function triggerShake(intensity) {
    shake.intensity = Math.max(shake.intensity, intensity);
  }

  function resetCamera() {
    smoothCam.init = false;
    shake.intensity = 0;
  }

  // Palette
  const COL = {
    bgGrid:     '#0e0e22',
    wall:       '#3d3d6d',
    wallGlow:   '#2a2a4a',
    floor:      '#16162e',
    floorAlt:   '#18183a',
    entrance:   '#36c896',
    exit:       '#1d9e75',
    doorClosed: '#7c5cbf',
    doorOpen:   '#36c896',
    towerSpot:  '#444474',
    spawn:      '#e24b4a',
    path:       '#252550',
    player:     '#a87fdf',
    playerGlow: 'rgba(168,127,223,0.5)',
    text:       '#e8e8f0'
  };

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    dpr = window.devicePixelRatio || 1;
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clear() {
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, viewW, viewH);
  }

  // ---- camera helpers ----
  function cameraOffset(player, maze) {
    const mazeW = maze.width * tile;
    const mazeH = maze.height * tile;
    let cx = viewW / 2 - player.x;
    let cy = viewH / 2 - player.y;
    // Clamp inside maze bounds
    cx = Math.min(0, Math.max(viewW - mazeW, cx));
    cy = Math.min(0, Math.max(viewH - mazeH, cy));
    if (mazeW < viewW) cx = (viewW - mazeW) / 2;
    if (mazeH < viewH) cy = (viewH - mazeH) / 2;

    // Smooth lerp toward target
    if (!smoothCam.init) {
      smoothCam.x = cx; smoothCam.y = cy; smoothCam.init = true;
    } else {
      const k = 0.18;
      smoothCam.x += (cx - smoothCam.x) * k;
      smoothCam.y += (cy - smoothCam.y) * k;
    }

    // Apply screen shake
    let sx = 0, sy = 0;
    if (shake.intensity > 0.1) {
      sx = (Math.random() - 0.5) * shake.intensity;
      sy = (Math.random() - 0.5) * shake.intensity;
      shake.intensity *= shake.decay;
    } else {
      shake.intensity = 0;
    }

    return { cx: smoothCam.x + sx, cy: smoothCam.y + sy };
  }

  // ---- Draw the maze background, walls, doors, tower spots ----
  function drawMaze(maze, openDoorIds, cam, time) {
    const { cx, cy } = cam;

    // Background gradient
    const grad = ctx.createRadialGradient(viewW/2, viewH/2, 100, viewW/2, viewH/2, Math.max(viewW, viewH));
    grad.addColorStop(0, '#12122a');
    grad.addColorStop(1, '#080816');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, viewW, viewH);

    // Floor tiles
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const c = maze.grid[y][x];
        const px = cx + x * tile;
        const py = cy + y * tile;
        if (px + tile < 0 || py + tile < 0 || px > viewW || py > viewH) continue;

        // floor
        ctx.fillStyle = ((x + y) % 2 === 0) ? COL.floor : COL.floorAlt;
        ctx.fillRect(px, py, tile, tile);

        // special types
        if (c.type === 'entrance') {
          drawEntrance(px, py, time);
        } else if (c.type === 'exit') {
          drawExit(px, py, time);
        } else if (c.type === 'tower_spot') {
          drawTowerSpot(px, py, time);
        } else if (c.type === 'enemy_spawn') {
          drawSpawn(px, py, time);
        }
      }
    }

    // Walls
    ctx.strokeStyle = COL.wall;
    ctx.lineWidth = 3;
    ctx.lineCap = 'square';
    ctx.shadowColor = COL.wallGlow;
    ctx.shadowBlur = 6;
    for (let y = 0; y < maze.height; y++) {
      for (let x = 0; x < maze.width; x++) {
        const c = maze.grid[y][x];
        const px = cx + x * tile;
        const py = cy + y * tile;
        if (px + tile < -10 || py + tile < -10 || px > viewW + 10 || py > viewH + 10) continue;
        ctx.beginPath();
        if (c.walls.top)    { ctx.moveTo(px, py);        ctx.lineTo(px + tile, py); }
        if (c.walls.right)  { ctx.moveTo(px + tile, py); ctx.lineTo(px + tile, py + tile); }
        if (c.walls.bottom) { ctx.moveTo(px, py + tile); ctx.lineTo(px + tile, py + tile); }
        if (c.walls.left)   { ctx.moveTo(px, py);        ctx.lineTo(px, py + tile); }
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // Doors
    for (const d of maze.doors) {
      const c = maze.grid[d.y][d.x];
      const px = cx + d.x * tile;
      const py = cy + d.y * tile;
      const isOpen = openDoorIds.has(d.id);
      drawDoor(px, py, isOpen, time);
    }
  }

  function drawEntrance(px, py, t) {
    ctx.fillStyle = 'rgba(54, 200, 150, 0.18)';
    ctx.fillRect(px, py, tile, tile);
    ctx.fillStyle = COL.entrance;
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▼', px + tile/2, py + tile/2);
  }

  function drawExit(px, py, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t / 250);
    ctx.fillStyle = `rgba(29, 158, 117, ${0.25 + pulse * 0.25})`;
    ctx.fillRect(px, py, tile, tile);
    ctx.strokeStyle = COL.exit;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 4, py + 4, tile - 8, tile - 8);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EXIT', px + tile/2, py + tile/2);
  }

  function drawTowerSpot(px, py, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t / 400);
    ctx.strokeStyle = `rgba(168, 127, 223, ${0.4 + pulse * 0.3})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + 8, py + tile/2); ctx.lineTo(px + tile - 8, py + tile/2);
    ctx.moveTo(px + tile/2, py + 8); ctx.lineTo(px + tile/2, py + tile - 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px + tile/2, py + tile/2, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawSpawn(px, py, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t / 200);
    ctx.fillStyle = `rgba(226, 75, 74, ${0.15 + pulse * 0.2})`;
    ctx.fillRect(px, py, tile, tile);
    ctx.strokeStyle = COL.spawn;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(px + 2, py + 2, tile - 4, tile - 4);
    ctx.setLineDash([]);
  }

  function drawDoor(px, py, isOpen, t) {
    if (isOpen) {
      ctx.fillStyle = 'rgba(54, 200, 150, 0.18)';
      ctx.fillRect(px + 2, py + 2, tile - 4, tile - 4);
      ctx.strokeStyle = COL.doorOpen;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.strokeRect(px + 4, py + 4, tile - 8, tile - 8);
      ctx.setLineDash([]);
    } else {
      const pulse = 0.5 + 0.5 * Math.sin(t / 300);
      ctx.fillStyle = `rgba(124, 92, 191, ${0.5 + pulse * 0.3})`;
      ctx.fillRect(px + 4, py + 4, tile - 8, tile - 8);
      ctx.strokeStyle = COL.doorClosed;
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 4, py + 4, tile - 8, tile - 8);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔒', px + tile/2, py + tile/2 + 2);
    }
  }

  // ---- Draw the player ----
  function drawPlayer(player, cam, time) {
    const px = cam.cx + player.x;
    const py = cam.cy + player.y;
    const radius = 11;
    const pulse = 1 + 0.1 * Math.sin(time / 200);

    // glow
    const g = ctx.createRadialGradient(px, py, 2, px, py, radius * 3);
    g.addColorStop(0, COL.playerGlow);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(px - radius * 3, py - radius * 3, radius * 6, radius * 6);

    // body
    ctx.fillStyle = COL.player;
    ctx.beginPath();
    ctx.arc(px, py, radius * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // direction indicator
    ctx.fillStyle = '#fff';
    const dirX = Math.cos(player.facing || 0) * 6;
    const dirY = Math.sin(player.facing || 0) * 6;
    ctx.beginPath();
    ctx.arc(px + dirX, py + dirY, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- Draw enemies ----
  function drawEnemies(enemies, cam, time) {
    for (const e of enemies) {
      const px = cam.cx + e.x;
      const py = cam.cy + e.y;
      if (e.type === 'bug') {
        ctx.fillStyle = '#e24b4a';
        ctx.fillRect(px - 7, py - 7, 14, 14);
        ctx.strokeStyle = '#ff8a8a';
        ctx.strokeRect(px - 7, py - 7, 14, 14);
      } else if (e.type === 'virus') {
        ctx.fillStyle = '#ef9f27';
        ctx.beginPath();
        ctx.moveTo(px, py - 10);
        ctx.lineTo(px + 10, py);
        ctx.lineTo(px, py + 10);
        ctx.lineTo(px - 10, py);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#ffcb6e';
        ctx.stroke();
      } else if (e.type === 'glitch') {
        ctx.fillStyle = '#7c5cbf';
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + time / 600;
          const r = 13;
          if (i === 0) ctx.moveTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
          else ctx.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#d1b6ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // HP bar if damaged
      if (e.hp < e.maxHp) {
        const w = 22;
        ctx.fillStyle = '#2a2a4a';
        ctx.fillRect(px - w/2, py - 16, w, 3);
        ctx.fillStyle = '#e24b4a';
        ctx.fillRect(px - w/2, py - 16, w * (e.hp / e.maxHp), 3);
      }
    }
  }

  // ---- Draw towers ----
  function drawTowers(towers, cam, time) {
    for (const t of towers) {
      const px = cam.cx + t.x * tile + tile/2;
      const py = cam.cy + t.y * tile + tile/2;
      const r = 10;
      const ringR = (t.range || 3) * tile;

      let col = '#3593ff';
      if (t.kind === 'destruct') col = '#ef9f27';
      else if (t.kind === 'shield') col = '#36c896';

      // range ring (very subtle)
      ctx.strokeStyle = col + '33';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(px, py, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // base
      ctx.fillStyle = '#12122a';
      ctx.beginPath();
      ctx.arc(px, py, r + 2, 0, Math.PI * 2);
      ctx.fill();
      // core
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      // turret spin
      const a = time / 400 + (t.spinOffset || 0);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * 4, py + Math.sin(a) * 4);
      ctx.lineTo(px + Math.cos(a) * (r + 4), py + Math.sin(a) * (r + 4));
      ctx.stroke();
    }
  }

  // ---- Draw projectiles / FX ----
  function drawFx(fxList, cam, time) {
    for (const f of fxList) {
      const px = cam.cx + f.x;
      const py = cam.cy + f.y;
      const life = (time - f.born) / f.duration;
      if (life > 1) continue;
      const fade = 1 - life;

      if (f.type === 'hit') {
        ctx.strokeStyle = `rgba(255, 80, 80, ${fade})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 6 + life * 14, 0, Math.PI * 2);
        ctx.stroke();
      } else if (f.type === 'kill') {
        // central flash
        const flash = ctx.createRadialGradient(px, py, 0, px, py, 30 * (1 + life));
        flash.addColorStop(0, `rgba(255, 255, 255, ${fade * 0.9})`);
        flash.addColorStop(0.4, `rgba(255, 200, 100, ${fade * 0.4})`);
        flash.addColorStop(1, 'transparent');
        ctx.fillStyle = flash;
        ctx.fillRect(px - 50, py - 50, 100, 100);
        // burst lines
        ctx.strokeStyle = `rgba(255, 200, 100, ${fade})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * Math.PI * 2;
          const r1 = 6 + life * 8;
          const r2 = 12 + life * 28;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * r1, py + Math.sin(a) * r1);
          ctx.lineTo(px + Math.cos(a) * r2, py + Math.sin(a) * r2);
          ctx.stroke();
        }
      } else if (f.type === 'particle') {
        // ballistic particle with gravity
        const t = (time - f.born) / 1000;
        const cx = f.x + f.vx * t;
        const cy = f.y + f.vy * t + 0.5 * 200 * t * t;
        ctx.fillStyle = f.color || '#fff';
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(cam.cx + cx, cam.cy + cy, (f.size || 2) * fade, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (f.type === 'tower-zap') {
        ctx.strokeStyle = `rgba(53, 147, 255, ${fade})`;
        ctx.lineWidth = 1.5 + fade * 1.5;
        ctx.shadowColor = '#3593ff';
        ctx.shadowBlur = 8 * fade;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(cam.cx + f.tx, cam.cy + f.ty);
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (f.type === 'door-open') {
        ctx.fillStyle = `rgba(54, 200, 150, ${0.7 * fade})`;
        ctx.beginPath();
        ctx.arc(px, py, tile * (1 + life * 1.5), 0, Math.PI * 2);
        ctx.fill();
      } else if (f.type === 'text') {
        ctx.fillStyle = f.color || '#fff';
        ctx.font = `bold ${f.size || 14}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.globalAlpha = fade;
        ctx.shadowColor = f.color || '#fff';
        ctx.shadowBlur = 6;
        ctx.fillText(f.text, px, py - life * 40);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      } else if (f.type === 'place') {
        // tower placement ring
        ctx.strokeStyle = `rgba(168, 127, 223, ${fade})`;
        ctx.lineWidth = 2 + fade * 4;
        ctx.beginPath();
        ctx.arc(px, py, life * 40, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Helper: spawn a kill-burst (particles + flash text)
  function spawnKillBurst(fxList, x, y, born, color = '#ef9f27') {
    fxList.push({ type: 'kill', x, y, born, duration: 420 });
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 120;
      fxList.push({
        type: 'particle',
        x, y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 40,
        size: 2 + Math.random() * 2,
        color: Math.random() < 0.5 ? color : '#fff',
        born, duration: 500 + Math.random() * 300
      });
    }
  }

  function setTileSize(s) {
    // we stick to 32 — but expose for future tweaks
  }

  function getTile() { return tile; }
  function getView() { return { w: viewW, h: viewH }; }

  return {
    init, clear, resize,
    cameraOffset, triggerShake, resetCamera,
    drawMaze, drawPlayer, drawEnemies, drawTowers, drawFx, spawnKillBurst,
    getTile, getView
  };
})();
