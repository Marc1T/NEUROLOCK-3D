import { Question } from '../types';

type Answer = { questionId: string; wasCorrect: boolean; time: number };

// Spaced repetition (SM-2 simplifié) — chaque question a un ease factor (difficulté
// subjective pour l'apprenant), un intervalle de réapparition en secondes, et la
// date de la dernière réponse. Persisté dans localStorage.
const SRS_STORAGE_KEY = 'neurolock_srs';
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
const DEFAULT_EASE = 2.5;
const DEFAULT_INTERVAL_S = 30;

export type SRSEntry = {
  ease: number;
  interval: number; // seconds
  lastAt: number;   // ms timestamp
};

function loadSRS(): Record<string, SRSEntry> {
  try {
    const raw = localStorage.getItem(SRS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveSRS(state: Record<string, SRSEntry>) {
  try { localStorage.setItem(SRS_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

/** Call after each answer to update the SM-2 state for that question. */
export function updateSRS(questionId: string, wasCorrect: boolean): void {
  const state = loadSRS();
  const entry: SRSEntry = state[questionId] ?? { ease: DEFAULT_EASE, interval: DEFAULT_INTERVAL_S, lastAt: 0 };
  if (wasCorrect) {
    entry.ease = Math.min(MAX_EASE, entry.ease + 0.1);
    entry.interval = Math.round(entry.interval * entry.ease);
  } else {
    entry.ease = Math.max(MIN_EASE, entry.ease - 0.2);
    entry.interval = DEFAULT_INTERVAL_S; // reset, the user must see it again soon
  }
  entry.lastAt = Date.now();
  state[questionId] = entry;
  saveSRS(state);
}

export const AdaptiveAI = {
  /** Returns target difficulty level (1..3) based on recent performance. */
  getDifficulty(history: Answer[]): number {
    const recent = history.slice(-5);
    if (recent.length < 3) return 1;
    const correct = recent.filter(a => a.wasCorrect).length;
    const accuracy = correct / recent.length;
    const avgTime = recent.reduce((s, a) => s + a.time, 0) / recent.length;
    if (accuracy >= 0.8 && avgTime < 5) return 3;
    if (accuracy >= 0.6) return 2;
    return 1;
  },

  /**
   * Picks a question, biased toward:
   *   1. Questions that are DUE per SM-2 (lastAt + interval < now), preferring the target level
   *   2. Same level, never seen
   *   3. Any unused question
   *   4. Reset usedIds and start over
   */
  pickQuestion(questions: Question[], level: number, usedIds: Set<string>): Question | null {
    if (questions.length === 0) return null;
    const srs = loadSRS();
    const now = Date.now();

    const isDue = (q: Question) => {
      const e = srs[q.id];
      if (!e) return false; // never seen — handled by "fresh" branches
      return now >= e.lastAt + e.interval * 1000;
    };

    // 1. Due + target level + not used this run
    const dueLevel = questions.filter(q => q.level === level && !usedIds.has(q.id) && isDue(q));
    if (dueLevel.length > 0) return pickRandom(dueLevel);

    // 2. Due any level + not used
    const dueAny = questions.filter(q => !usedIds.has(q.id) && isDue(q));
    if (dueAny.length > 0) return pickRandom(dueAny);

    // 3. Never-seen + target level + not used
    const freshLevel = questions.filter(q => q.level === level && !usedIds.has(q.id) && !srs[q.id]);
    if (freshLevel.length > 0) return pickRandom(freshLevel);

    // 4. Any not used
    const anyFresh = questions.filter(q => !usedIds.has(q.id));
    if (anyFresh.length > 0) return pickRandom(anyFresh);

    // 5. Pool exhausted — reset
    usedIds.clear();
    const reset = questions.filter(q => q.level === level);
    return pickRandom(reset.length > 0 ? reset : questions);
  },
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
