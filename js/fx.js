/* ============================================================================
 * fx.js — Central visual-effects bus
 *
 * All transient visuals (hits, kills, score popups, tower zaps, projectiles)
 * flow through this module. Producers push effect descriptors here; the
 * renderer consumes the list each frame. The list is capped to avoid
 * unbounded growth and is GC-friendly (manual splice, no filter()).
 *
 * Effect descriptor shape (varies by `type`):
 *   { type, x, y, born, duration, ...typeSpecificFields }
 *
 * Public API is intentionally narrow:
 *   FX.push(effect)          — queue any effect
 *   FX.list()                — get the live array (do not mutate length)
 *   FX.tick(nowMs)           — evict expired effects in-place
 *   FX.clear()               — wipe all (used on run start)
 *   Convenience spawners (FX.killBurst, FX.popup, FX.zap, ...)
 * ==========================================================================*/

const FX = (() => {

  /** @type {Array<object>} active effects (oldest first) */
  const effects = [];

  /**
   * Push a new effect. Caps the list at MAX_PARTICLES (oldest evicted).
   * @param {object} fx effect descriptor (must have born + duration)
   */
  function push(fx) {
    effects.push(fx);
    // Cap with shift batch (manual, avoids splice cost on each add)
    const max = Constants.FX.MAX_PARTICLES;
    if (effects.length > max) {
      effects.splice(0, effects.length - max);
    }
  }

  /** @returns {Array<object>} live array (read-only intent) */
  function list() { return effects; }

  /**
   * Evict expired effects in-place. O(n), no allocations.
   * @param {number} now performance.now() reference
   */
  function tick(now) {
    let write = 0;
    for (let read = 0; read < effects.length; read++) {
      const f = effects[read];
      if (now - f.born < f.duration) {
        if (write !== read) effects[write] = f;
        write++;
      }
    }
    effects.length = write;
  }

  /** Clear all effects (on run start / abandon). */
  function clear() { effects.length = 0; }

  // ─── Convenience spawners ───────────────────────────────────────────────

  /**
   * Kill burst: central flash + 12 ballistic particles.
   * @param {number} x world-space x
   * @param {number} y world-space y
   * @param {number} now performance.now()
   * @param {string} color primary particle color
   */
  function killBurst(x, y, now, color = '#ef9f27') {
    push({ type: 'kill', x, y, born: now, duration: 420 });
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 120;
      push({
        type: 'particle',
        x, y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 40,
        size: 2 + Math.random() * 2,
        color: Math.random() < 0.5 ? color : '#fff',
        born: now,
        duration: 500 + Math.random() * 300
      });
    }
  }

  /**
   * Floating text popup that drifts upward and fades.
   * @param {number} x
   * @param {number} y
   * @param {string} text
   * @param {object} [opts] { color, size, duration, born }
   */
  function popup(x, y, text, opts = {}) {
    push({
      type: 'text',
      x, y, text,
      color: opts.color || '#fff',
      size: opts.size || 14,
      born: opts.born || performance.now(),
      duration: opts.duration || 1100
    });
  }

  /**
   * Tower → enemy zap (instant lightning).
   * @param {number} fromX
   * @param {number} fromY
   * @param {number} toX
   * @param {number} toY
   * @param {number} now
   */
  function zap(fromX, fromY, toX, toY, now) {
    push({
      type: 'tower-zap',
      x: fromX, y: fromY, tx: toX, ty: toY,
      born: now, duration: 200
    });
  }

  /**
   * Homing projectile (visual only; logic in towers.js).
   * @param {number} fromX
   * @param {number} fromY
   * @param {object} target enemy reference (read x/y next frames)
   * @param {string} color
   * @param {number} now
   */
  function projectile(fromX, fromY, target, color, now) {
    push({
      type: 'projectile',
      x: fromX, y: fromY,
      target,
      color: color || '#3593ff',
      progress: 0,
      born: now,
      duration: 600
    });
  }

  /**
   * Hit ring at a target's position.
   * @param {number} x
   * @param {number} y
   * @param {number} now
   */
  function hitRing(x, y, now) {
    push({ type: 'hit', x, y, born: now, duration: 280 });
  }

  /**
   * Door-opening shockwave.
   * @param {number} x cell-center x in pixels
   * @param {number} y cell-center y in pixels
   * @param {number} now
   */
  function doorOpen(x, y, now) {
    push({ type: 'door-open', x, y, born: now, duration: 500 });
  }

  /**
   * Tower placement ring.
   * @param {number} x
   * @param {number} y
   * @param {number} now
   */
  function placeRing(x, y, now) {
    push({ type: 'place', x, y, born: now, duration: 500 });
  }

  return {
    push, list, tick, clear,
    killBurst, popup, zap, projectile, hitRing, doorOpen, placeRing
  };
})();
