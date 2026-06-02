/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ThemeColors = {
  bgDark: string;
  bgPanel: string;
  bgPanel2: string;
  border: string;
  borderBright: string;
  primary: string;
  primaryLight: string;
  accent1: string;
  accent2: string;
  amber: string;
  red: string;
  redBright: string;
  green: string;
  floor: string;
  textMain: string;
  textMuted: string;
};

export const THEMES: Record<string, ThemeColors> = {
  cyber: {
    bgDark: '#02020a',
    bgPanel: '#242548',
    bgPanel2: '#121235',
    border: '#2a2a4a',
    borderBright: '#4f4fbb',
    primary: '#9d4edd',
    primaryLight: '#c77dff',
    accent1: '#00f5d4',
    accent2: '#7bf11c',
    amber: '#ff9e00',
    red: '#ff0054',
    redBright: '#ff5400',
    green: '#00f5d4',
    floor: '#e8e8ff',
    textMain: '#f8f9fa',
    textMuted: '#9e9e9e',
  },
  emerald: {
    bgDark: '#020a05',
    bgPanel: '#204a35',
    bgPanel2: '#122515',
    border: '#1f4525',
    borderBright: '#4fbb6a',
    primary: '#10b981',
    primaryLight: '#34d399',
    accent1: '#fbbf24',
    accent2: '#60a5fa',
    amber: '#f59e0b',
    red: '#ef4444',
    redBright: '#f87171',
    green: '#10b981',
    floor: '#ecfdf5',
    textMain: '#f0fdf4',
    textMuted: '#9ca3af',
  },
  crimson: {
    bgDark: '#0a0202',
    bgPanel: '#5c1c1c',
    bgPanel2: '#251212',
    border: '#451f1f',
    borderBright: '#bb4f4f',
    primary: '#e11d48',
    primaryLight: '#fb7185',
    accent1: '#22d3ee',
    accent2: '#f472b6',
    amber: '#fbbf24',
    red: '#991b1b',
    redBright: '#dc2626',
    green: '#22d3ee',
    floor: '#fff1f2',
    textMain: '#fff1f2',
    textMuted: '#9ca3af',
  },
  classic: {
    bgDark: '#0f172a',
    bgPanel: '#475a75',
    bgPanel2: '#334155',
    border: '#475569',
    borderBright: '#64748b',
    primary: '#3b82f6',
    primaryLight: '#60a5fa',
    accent1: '#f59e0b',
    accent2: '#10b981',
    amber: '#d97706',
    red: '#ef4444',
    redBright: '#f87171',
    green: '#10b981',
    floor: '#f1f5f9',
    textMain: '#f8fafc',
    textMuted: '#94a3b8',
  }
};

export const TILE_SIZE = 4;
export const WALL_HEIGHT = 2.5;
export const MAZE_SIZE = 15;

export enum GameMode {
  MENU = 'MENU',
  COURSE_SELECT = 'COURSE_SELECT',
  SURVIVAL = 'SURVIVAL',
  TOWER_DEFENSE = 'TOWER_DEFENSE',
  SPRINT = 'SPRINT',
  HEART_DEFENSE = 'HEART_DEFENSE',
  TEACHER = 'TEACHER',
  SETTINGS = 'SETTINGS',
}

/** Engine-side mode tag — short string for runtime branching. */
export type EngineMode = 'survival' | 'tower_defense' | 'sprint' | 'heart_defense';

export function engineModeFromGameMode(m: GameMode): EngineMode {
  switch (m) {
    case GameMode.SPRINT: return 'sprint';
    case GameMode.HEART_DEFENSE: return 'heart_defense';
    case GameMode.TOWER_DEFENSE: return 'tower_defense';
    default: return 'survival';
  }
}

// ─────────────────────────── Level / chapter system ─────────────────────────────

export type MazeAlgorithm = 'dfs' | 'dfs_rooms';

export type Chapter = {
  name: string;       // displayed in level intro
  subtitle: string;   // short flavor text
  accent: keyof ThemeColors; // theme color key used for the chapter chip
};

const CHAPTERS: { from: number; to: number; chapter: Chapter }[] = [
  { from: 1, to: 2,  chapter: { name: 'INITIATION',       subtitle: 'Apprends les protocoles',     accent: 'accent1' } },
  { from: 3, to: 4,  chapter: { name: 'SURCHARGE',        subtitle: 'Le système se densifie',      accent: 'amber'   } },
  { from: 5, to: 6,  chapter: { name: 'CŒUR DU SYSTÈME',  subtitle: 'Pénétration profonde',         accent: 'primaryLight' } },
  { from: 7, to: 9,  chapter: { name: 'OVERRIDE',         subtitle: 'Reprends le contrôle',         accent: 'redBright' } },
  { from: 10, to: 99, chapter: { name: 'FINALE',          subtitle: 'Au-delà de la machine',        accent: 'green'   } },
];

export function chapterForLevel(level: number): Chapter {
  const entry = CHAPTERS.find(c => level >= c.from && level <= c.to);
  return entry?.chapter ?? CHAPTERS[CHAPTERS.length - 1].chapter;
}

/** Boss levels every 3 — denser waves, faster enemies, special intro. */
export function isBossLevel(level: number): boolean {
  return level >= 3 && level % 3 === 0;
}

/** Pick the maze algorithm for a given level. */
export function mazeAlgorithmForLevel(level: number): MazeAlgorithm {
  if (level <= 2) return 'dfs';
  return 'dfs_rooms';
}

/** Braiding probability — how aggressively dead ends are punched into loops. */
export function braidingForLevel(level: number): number {
  if (level <= 2) return 0.15;
  if (level <= 4) return 0.25;
  if (level <= 6) return 0.35;
  return 0.45;
}

/** Number of open rooms carved into the maze. */
export function roomCountForLevel(level: number): number {
  if (level <= 2) return 0;
  if (level <= 5) return 2;
  return 3;
}

// ───────────────────────────── Wave system (HD + TD) ─────────────────────────────

export type WaveConfig = {
  size: number;          // number of enemies that will spawn in this wave
  spawnInterval: number; // seconds between two spawns within the wave
  enemySpeed: number;    // base speed for enemies in this wave
  isBoss: boolean;
};

/** Boss waves every 3rd, starting at wave 3. */
export function isBossWave(wave: number): boolean {
  return wave >= 3 && wave % 3 === 0;
}

export function waveConfigForWave(wave: number): WaveConfig {
  const w = Math.max(1, wave);
  const boss = isBossWave(w);
  return {
    size: 5 + Math.floor(w * 1.5) + (boss ? 6 : 0),
    spawnInterval: Math.max(0.4, 0.85 - w * 0.04),
    enemySpeed: 2.0 + w * 0.15 + (boss ? 0.5 : 0),
    isBoss: boss,
  };
}

// ─────────────────────────── Pickup / exploration system ────────────────────────

export type PickupType = 'ammo' | 'heal' | 'score';

export type PickupConfig = {
  type: PickupType;
  themeColorKey: keyof ThemeColors;
  label: string;
  short: string; // mini label for HUD chip
  weight: number; // probability weight for random rolls
  effectValue: number;
};

export const PICKUP_CONFIGS: Record<PickupType, PickupConfig> = {
  ammo:  { type: 'ammo',  themeColorKey: 'accent1',    label: '+5 MUNITIONS', short: '+5 AMMO', weight: 5, effectValue: 5 },
  score: { type: 'score', themeColorKey: 'amber',      label: '+500 SCORE',   short: '+500 PTS', weight: 3, effectValue: 500 },
  heal:  { type: 'heal',  themeColorKey: 'redBright',  label: '+1 PV',        short: '+1 HP',    weight: 1, effectValue: 1 },
};

// ────────────────────────────── Enemy variants ────────────────────────────────

export type EnemyType = 'drone' | 'swift' | 'brute' | 'boss';

export type EnemyConfig = {
  type: EnemyType;
  label: string;
  themeColorKey: keyof ThemeColors;
  hp: number;
  speedMultiplier: number; // applied on top of wave base speed
  scaleMultiplier: number; // visual size
  scoreValue: number;
};

export const ENEMY_CONFIGS: Record<EnemyType, EnemyConfig> = {
  drone: { type: 'drone', label: 'Drone',  themeColorKey: 'red',         hp: 1, speedMultiplier: 1.0, scaleMultiplier: 1.0, scoreValue: 100 },
  swift: { type: 'swift', label: 'Swift',  themeColorKey: 'redBright',   hp: 1, speedMultiplier: 1.7, scaleMultiplier: 0.7, scoreValue: 150 },
  brute: { type: 'brute', label: 'Brute',  themeColorKey: 'amber',       hp: 3, speedMultiplier: 0.6, scaleMultiplier: 1.5, scoreValue: 250 },
  boss:  { type: 'boss',  label: 'Élite',  themeColorKey: 'primary',     hp: 8, speedMultiplier: 0.9, scaleMultiplier: 2.0, scoreValue: 800 },
};

function weightedRoll<T extends string>(weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  let total = 0;
  for (const [, w] of entries) total += w;
  if (total <= 0) return entries[0][0];
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[0][0];
}

/** Pick an enemy type for a wave-mode spawn. Boss waves guarantee 1 boss mid-wave. */
export function rollEnemyTypeForWave(wave: number, indexInWave: number, totalInWave: number): EnemyType {
  const boss = isBossWave(wave);
  // Guarantee one boss mob mid-wave on boss waves
  if (boss && indexInWave === Math.floor(totalInWave / 2)) return 'boss';

  const weights: Record<EnemyType, number> =
    boss     ? { drone: 5, swift: 4, brute: 3, boss: 0 } :
    wave <= 1 ? { drone: 10, swift: 0, brute: 0, boss: 0 } :
    wave <= 3 ? { drone: 7, swift: 3, brute: 0, boss: 0 } :
                { drone: 5, swift: 3, brute: 2, boss: 0 };
  return weightedRoll(weights);
}

// ────────────────────────────── Stats & achievements ──────────────────────────

export type ModeStats = {
  bestScore: number;
  bestProgression: number; // best level (Survival/Sprint) or best wave (TD/HD)
  totalRuns: number;
  totalKills: number;
  totalQuestionsAnswered: number;
  totalQuestionsCorrect: number;
};

export type AllModeStats = {
  survival: ModeStats;
  tower_defense: ModeStats;
  sprint: ModeStats;
  heart_defense: ModeStats;
};

export function emptyModeStats(): ModeStats {
  return {
    bestScore: 0,
    bestProgression: 0,
    totalRuns: 0,
    totalKills: 0,
    totalQuestionsAnswered: 0,
    totalQuestionsCorrect: 0,
  };
}

export function emptyAllStats(): AllModeStats {
  return {
    survival: emptyModeStats(),
    tower_defense: emptyModeStats(),
    sprint: emptyModeStats(),
    heart_defense: emptyModeStats(),
  };
}

export type AchievementDef = {
  id: string;
  name: string;
  description: string;
  icon: string; // emoji
  check: (snapshot: AchievementSnapshot) => boolean;
};

export type AchievementSnapshot = {
  stats: AllModeStats;
  lastRun: {
    mode: EngineMode;
    score: number;
    progression: number;
    kills: number;
    bestCombo: number;
    accuracy: number; // 0..1
  } | null;
};

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_blood',   name: 'Premier Sang',     description: 'Tuer ton premier ennemi.',                  icon: '🩸', check: s => s.lastRun !== null && s.lastRun.kills >= 1 },
  { id: 'sharpshooter',  name: 'Tireur d\'élite',  description: 'Atteindre 100 kills cumulés.',              icon: '🎯', check: s => totalKillsAcrossModes(s.stats) >= 100 },
  { id: 'survivor',      name: 'Survivant',        description: 'Atteindre le niveau 5 en Survie.',          icon: '🏃', check: s => s.stats.survival.bestProgression >= 5 },
  { id: 'wave_master',   name: 'Maître des vagues', description: 'Tenir 8 vagues en Défense ou Cœur.',       icon: '🌊', check: s => s.stats.tower_defense.bestProgression >= 8 || s.stats.heart_defense.bestProgression >= 8 },
  { id: 'combo_x4',      name: 'Combo Critique',   description: 'Décrocher un combo ×4 en partie.',           icon: '🔥', check: s => s.lastRun !== null && s.lastRun.bestCombo >= 5 },
  { id: 'scholar',       name: 'Érudit',           description: 'Répondre à 50 questions cumulées.',          icon: '🧠', check: s => totalQuestionsAcrossModes(s.stats) >= 50 },
];

function totalKillsAcrossModes(s: AllModeStats): number {
  return s.survival.totalKills + s.tower_defense.totalKills + s.sprint.totalKills + s.heart_defense.totalKills;
}
function totalQuestionsAcrossModes(s: AllModeStats): number {
  return s.survival.totalQuestionsAnswered + s.tower_defense.totalQuestionsAnswered + s.sprint.totalQuestionsAnswered + s.heart_defense.totalQuestionsAnswered;
}

/** Pick an enemy type for Survival's continuous spawn, by level. */
export function rollEnemyTypeForLevel(level: number): EnemyType {
  const weights: Record<EnemyType, number> =
    level <= 2 ? { drone: 10, swift: 0, brute: 0, boss: 0 } :
    level <= 4 ? { drone: 7,  swift: 3, brute: 0, boss: 0 } :
                 { drone: 5,  swift: 3, brute: 2, boss: 0 };
  return weightedRoll(weights);
}

export function rollPickupType(): PickupType {
  const list = Object.values(PICKUP_CONFIGS);
  const total = list.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of list) {
    r -= p.weight;
    if (r <= 0) return p.type;
  }
  return 'ammo';
}

/** Wave chapter — same narrative structure as levels but tuned to wave counts. */
export function chapterForWave(wave: number): Chapter {
  if (wave <= 2) return { name: 'CONTACT',        subtitle: 'Le système réagit',         accent: 'accent1' };
  if (wave <= 5) return { name: 'ASSAUT',         subtitle: 'Les vagues s’intensifient', accent: 'amber' };
  if (wave <= 8) return { name: 'SURCHARGE',      subtitle: 'Le cœur vacille',           accent: 'primaryLight' };
  if (wave <= 11) return { name: 'OVERRIDE',      subtitle: 'Tiens la ligne',            accent: 'redBright' };
  return { name: 'TRANSCENDANCE',                 subtitle: 'Tu es la dernière barrière',  accent: 'green' };
}

export interface Question {
  id: string;
  subject: string;
  level: number; // 1, 2, 3
  question: string;
  choices: string[];
  correct: number;
  explanation: string;
  duration: number;
  tags: string[];
}

