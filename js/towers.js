/* ============================================================================
 * towers.js — Tower placement + targeting + projectile-based damage
 *
 * Behaviour:
 *  • Slow tower      — pure debuff, never damages, fires lightning (zap)
 *  • Destruct tower  — fires homing projectiles dealing 1 damage on impact
 *  • Shield tower    — proximity protection for the player (grants iframes)
 *
 * Projectile model: when a destruct tower fires, we spawn:
 *   1) A visual via FX.projectile() that interpolates toward the target,
 *   2) An internal "live projectile" record in `bullets[]` whose tick advances
 *      a `progress` value and applies damage on impact. The visual and the
 *      logic are intentionally decoupled — the visual reads target.x/y each
 *      frame so it tracks the moving enemy.
 * ==========================================================================*/

const Towers = (() => {

  const TILE = Constants.TILE;

  /** Frozen tower archetypes. */
  const DEFS = Object.freeze({
    slow:     Object.freeze({ range: 3.5, cooldown: 800,  damage: 0, slowMs: 1500, label: 'Ralentisseur', color: '#3593ff' }),
    destruct: Object.freeze({ range: 3.0, cooldown: 600,  damage: 1, slowMs: 0,    label: 'Destructrice', color: '#ef9f27' }),
    shield:   Object.freeze({ range: 2.5, cooldown: 1500, damage: 0, slowMs: 600,  label: 'Bouclier',     color: '#36c896' })
  });

  /** @type {Array<object>} placed towers */
  let towers = [];
  /** @type {Array<object>} in-flight projectiles (logic, not visuals) */
  let bullets = [];

  function init() {
    towers = [];
    bullets = [];
  }

  function getList() { return towers; }

  /**
   * Find an existing tower at a given cell, or null.
   */
  function listAt(tx, ty) {
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (t.x === tx && t.y === ty) return t;
    }
    return null;
  }

  /**
   * Place a new tower.
   * @param {keyof typeof DEFS} kind
   * @param {number} tx cell x
   * @param {number} ty cell y
   * @param {number} now performance.now()
   */
  function place(kind, tx, ty, now) {
    const def = DEFS[kind];
    if (!def) return null;
    const t = {
      kind, x: tx, y: ty,
      range: def.range,
      cooldown: def.cooldown,
      damage: def.damage,
      slowMs: def.slowMs,
      color: def.color,
      lastFire: now,
      spinOffset: Math.random() * Math.PI * 2
    };
    towers.push(t);
    return t;
  }

  /**
   * Per-frame tower behaviour: target acquisition + fire + bullet flight.
   *
   * @param {number} dt
   * @param {Array<object>} enemies live list (mutated by damageEnemy)
   * @param {number} now performance.now()
   * @param {object} player {x,y,iframes}
   */
  function tick(dt, enemies, now, player) {
    // Towers fire when cooled down
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (now - t.lastFire < t.cooldown) continue;

      const cx = t.x * TILE + TILE / 2;
      const cy = t.y * TILE + TILE / 2;
      const rangeSq = (t.range * TILE) * (t.range * TILE);

      // Acquire nearest enemy in range
      let target = null;
      let bestSq = rangeSq + 1;
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        const dx = e.x - cx;
        const dy = e.y - cy;
        const ds = dx * dx + dy * dy;
        if (ds < rangeSq && ds < bestSq) {
          bestSq = ds;
          target = e;
        }
      }
      if (!target) continue;

      t.lastFire = now;

      // Slow tower → instant zap + slow debuff
      if (t.kind === 'slow') {
        FX.zap(cx, cy, target.x, target.y, now);
        target.slowUntil = now + t.slowMs;
      }
      // Destruct tower → homing projectile
      else if (t.kind === 'destruct') {
        FX.projectile(cx, cy, target, t.color, now);
        bullets.push({
          target, damage: t.damage,
          x: cx, y: cy,
          ttl: 600,            // hard kill after 600ms
          born: now
        });
      }
      // Shield tower handled in player-proximity block below
    }

    // Update in-flight projectiles (logic only — visual is in FX)
    const speed = Constants.TOWER.PROJECTILE_SPEED * (dt / 1000);
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      // Expire if target died or ttl elapsed
      if (!b.target || b.target.hp <= 0 || now - b.born > b.ttl) {
        bullets.splice(i, 1);
        continue;
      }
      const dx = b.target.x - b.x;
      const dy = b.target.y - b.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < (8 * 8)) {
        // Impact — deal damage
        Enemies.damageEnemy(b.target, b.damage, now);
        FX.hitRing(b.target.x, b.target.y, now);
        bullets.splice(i, 1);
      } else {
        const dist = Math.sqrt(distSq);
        b.x += (dx / dist) * speed;
        b.y += (dy / dist) * speed;
      }
    }

    // Shield towers: grant brief iframes to nearby player
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (t.kind !== 'shield') continue;
      const cx = t.x * TILE + TILE / 2;
      const cy = t.y * TILE + TILE / 2;
      const dx = player.x - cx;
      const dy = player.y - cy;
      const rangeSq = (t.range * TILE) * (t.range * TILE);
      if (dx * dx + dy * dy < rangeSq) {
        if (player.iframes < 200) player.iframes = 200;
      }
    }
  }

  return { init, place, tick, getList, listAt, DEFS };
})();
