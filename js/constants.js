/* ============================================================================
 * constants.js — Game tuning constants
 *
 * Single source of truth for all numerical tuning values. Modifying gameplay
 * feel should require ONE change here, not a hunt through 8 modules.
 *
 * Anything that depends on data/config.json (initial timer, wave intervals)
 * stays in config.json. This file holds non-configurable internals.
 * ==========================================================================*/

const Constants = Object.freeze({

  /** Tile size in pixels. Everything else derives from this. */
  TILE: 32,

  /** Player physical / movement constants. */
  PLAYER: Object.freeze({
    RADIUS: 11,
    PAD: 1,
    IFRAMES_MS: 800,
    BREATH_AMP: 0.10,         // breathing scale amplitude
    BREATH_HZ: 1.6
  }),

  /** Camera smoothing + lookahead. */
  CAMERA: Object.freeze({
    LERP: 0.18,
    LOOKAHEAD_PIXELS: 80,     // max offset toward movement direction
    LOOKAHEAD_LERP: 0.06      // how slowly lookahead settles
  }),

  /** Screen shake intensities by event. */
  SHAKE: Object.freeze({
    PLAYER_HIT: 12,
    WRONG_ANSWER: 8,
    WAVE_SPAWN: 6,
    DOOR_OPEN: 3,
    ENEMY_KILL: 4
  }),

  /** Hit-stop (freeze frame) duration in ms per event. */
  HIT_STOP: Object.freeze({
    PLAYER_HIT: 120,
    WRONG_ANSWER: 80,
    ENEMY_KILL: 30,
    WAVE_START: 100
  }),

  /** Combo multipliers — must be sorted descending by threshold. */
  COMBO_TIERS: [
    { min: 10, mult: 3.0 },
    { min: 7,  mult: 2.5 },
    { min: 5,  mult: 2.0 },
    { min: 3,  mult: 1.5 }
  ],

  /** FX bookkeeping. */
  FX: Object.freeze({
    MAX_PARTICLES: 240,       // hard cap; oldest evicted past this
    PARTICLE_GRAVITY: 200
  }),

  /** Tower constants. Damage/cooldown still come from Towers.DEFS but
   *  projectile visuals belong here. */
  TOWER: Object.freeze({
    PROJECTILE_SPEED: 360,    // px/sec
    PROJECTILE_RADIUS: 4
  }),

  /** Enemy collision (squared distance to avoid sqrt). */
  ENEMY: Object.freeze({
    PLAYER_HIT_DIST_SQ: 18 * 18,
    KNOCKBACK_PX: 12
  }),

  /** Quiz UI tuning. */
  QUIZ: Object.freeze({
    URGENCY_SECONDS: 3,       // pulse red when remaining < this
    FEEDBACK_OK_MS: 800,
    FEEDBACK_KO_MS: 1400
  }),

  /** Audio ducking when quiz is open (multiplier on master gain). */
  AUDIO: Object.freeze({
    DUCK_GAIN: 0.35,
    DUCK_RAMP_MS: 220
  }),

  /** Storage caps so cookies don't grow forever. */
  STORAGE: Object.freeze({
    MAX_QUESTION_HISTORY: 500,
    MAX_RUN_RECORDS: 20
  })
});
