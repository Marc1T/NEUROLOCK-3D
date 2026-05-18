/* ============================================================
   towers.js — placement & combat logic
   Kinds : slow, destruct, shield
   ============================================================ */

const Towers = (() => {

  const DEFS = {
    slow:     { range: 3.5, cooldown: 800,  damage: 0, slowMs: 1500, label: 'Ralentisseur', color: '#3593ff' },
    destruct: { range: 3.0, cooldown: 600,  damage: 1, slowMs: 0,    label: 'Destructrice', color: '#ef9f27' },
    shield:   { range: 2.5, cooldown: 1500, damage: 0, slowMs: 600,  label: 'Bouclier',     color: '#36c896' }
  };

  let list = [];
  let fx = [];

  function init() {
    list = [];
    fx = [];
  }

  function getList() { return list; }
  function getFx() { return fx; }

  function place(kind, tx, ty, time) {
    const def = DEFS[kind];
    if (!def) return null;
    const t = {
      kind, x: tx, y: ty,
      range: def.range,
      cooldown: def.cooldown,
      damage: def.damage,
      slowMs: def.slowMs,
      lastFire: time,
      spinOffset: Math.random() * Math.PI * 2
    };
    list.push(t);
    return t;
  }

  function pushFx(f) { fx.push(f); }

  function tick(dt, enemies, time, player) {
    const tile = 32;
    for (const t of list) {
      if (time - t.lastFire < t.cooldown) continue;

      // find a target enemy in range
      const cx = t.x * tile + tile / 2;
      const cy = t.y * tile + tile / 2;
      let target = null;
      let best = Infinity;
      for (const e of enemies) {
        const d = Math.hypot(e.x - cx, e.y - cy);
        if (d <= t.range * tile && d < best) {
          best = d;
          target = e;
        }
      }
      if (!target) continue;

      // fire
      t.lastFire = time;
      fx.push({ type: 'tower-zap', x: cx, y: cy, tx: target.x, ty: target.y, born: time, duration: 220 });

      if (t.damage > 0) {
        Enemies.damageEnemy(target, t.damage);
        fx.push({ type: 'hit', x: target.x, y: target.y, born: time, duration: 280 });
        if (target.hp <= 0) {
          fx.push({ type: 'kill', x: target.x, y: target.y, born: time, duration: 380 });
          Audio.playEnemyDeath();
        } else {
          Audio.playEnemyHit();
        }
      }
      if (t.slowMs > 0) {
        target.slowUntil = time + t.slowMs;
      }
    }

    // gc fx
    fx = fx.filter(f => time - f.born < f.duration);

    // shield aura: protect player if nearby
    if (player) {
      const px = player.x;
      const py = player.y;
      for (const t of list) {
        if (t.kind !== 'shield') continue;
        const cx = t.x * tile + tile / 2;
        const cy = t.y * tile + tile / 2;
        if (Math.hypot(px - cx, py - cy) < t.range * tile) {
          // grant 1 frame of iframes for proximity protection
          player.iframes = Math.max(player.iframes, 200);
        }
      }
    }
  }

  function listAt(tx, ty) {
    return list.find(t => t.x === tx && t.y === ty) || null;
  }

  return { init, place, tick, getList, getFx, listAt, pushFx, DEFS };
})();
