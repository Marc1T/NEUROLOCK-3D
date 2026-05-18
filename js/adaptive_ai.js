/* ============================================================
   adaptive_ai.js — monitors performance, adjusts difficulty
   ============================================================ */

const AdaptiveAI = (() => {

  let stats = null;
  let lastAdaptationAt = 0;
  let appliedLevel = 2;
  let waveSpeed = 1.0;
  let lastEnemiesBoost = 0;

  function init(startLevel = 2) {
    stats = {
      responseTimesMs: [],
      correctCount: 0,
      wrongCount: 0,
      streak: 0,
      avgResponseTime: 0,
      lastAccuracy: 0
    };
    lastAdaptationAt = 0;
    appliedLevel = Math.max(1, Math.min(3, startLevel));
    waveSpeed = 1.0;
  }

  function record(correct, timeMs) {
    if (!stats) init();
    stats.responseTimesMs.push(timeMs);
    if (stats.responseTimesMs.length > 20) stats.responseTimesMs.shift();
    if (correct) {
      stats.correctCount++;
      stats.streak++;
    } else {
      stats.wrongCount++;
      stats.streak = 0;
    }
    stats.avgResponseTime = stats.responseTimesMs.reduce((s, t) => s + t, 0) / stats.responseTimesMs.length;
    const tot = stats.correctCount + stats.wrongCount;
    stats.lastAccuracy = tot ? stats.correctCount / tot : 0;
  }

  // Called every N questions
  function adapt(game) {
    if (!stats) return { action: 'maintain', effects: [] };
    const total = stats.correctCount + stats.wrongCount;
    if (total < 3) return { action: 'maintain', effects: [] };

    const acc = stats.lastAccuracy;
    const avg = stats.avgResponseTime;

    let decision = { action: 'maintain', effects: [] };

    if (acc > 0.8 && avg < 3500) {
      decision = {
        action: 'increase',
        effects: ['add_enemy_wave', 'faster_enemy_speed', 'increase_question_level']
      };
      appliedLevel = Math.min(3, appliedLevel + 1);
      waveSpeed = Math.min(1.6, waveSpeed + 0.15);
      Enemies.setSpeedMultiplier(waveSpeed);
      if (game) {
        Enemies.triggerWave({ difficulty: appliedLevel });
      }
      Quiz.setLevelTarget(appliedLevel);
    } else if (acc < 0.4 || stats.wrongCount >= 4) {
      decision = {
        action: 'decrease',
        effects: ['slow_enemy_speed', 'add_timer_bonus', 'lower_question_level']
      };
      appliedLevel = Math.max(1, appliedLevel - 1);
      waveSpeed = Math.max(0.5, waveSpeed - 0.15);
      Enemies.setSpeedMultiplier(waveSpeed);
      if (game) game.addTime(5);
      Quiz.setLevelTarget(appliedLevel);
    }

    return decision;
  }

  function getStats() { return stats; }
  function getLevel() { return appliedLevel; }
  function getSpeed() { return waveSpeed; }

  return { init, record, adapt, getStats, getLevel, getSpeed };
})();
