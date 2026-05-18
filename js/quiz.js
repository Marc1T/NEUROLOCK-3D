/* ============================================================================
 * quiz.js — Question selection + overlay UI + scoring resolver
 *
 * Public surface:
 *   init(pack)                    — load a question pool for a run
 *   setLevelTarget(level)         — adaptive level target (1..3)
 *   setDurationConfig(mult, min)  — override timing for the whole run
 *   pick(history, options)        — weighted-random question selection
 *   open(question, trigger)       — show overlay; resolves with {answered, correct, elapsedMs, ...}
 *   getStats(history)             — mastery/weakness analysis
 *
 * Resolver shape (Promise resolves with this):
 *   { answered: boolean, correct: boolean, skipped?: boolean,
 *     timeout?: boolean, elapsedMs: number, choice: number }
 * ==========================================================================*/

const Quiz = (() => {

  /** @type {Array<object>} */
  let pool = [];
  /** @type {Set<string>} */
  let usedIds = new Set();
  let levelTarget = 2;
  let durationMultiplier = 1.0;
  let minDuration = 8;
  let openPromise = null;

  const $ = (sel) => document.querySelector(sel);

  function init(pack) {
    pool = pack.questions.slice();
    usedIds = new Set();
    levelTarget = 2;
  }

  function setLevelTarget(l) { levelTarget = Math.max(1, Math.min(3, l)); }

  function setDurationConfig(multiplier, floor) {
    durationMultiplier = multiplier || 1.0;
    minDuration = floor || 8;
  }

  /**
   * Pick the next question with weighted-random priority:
   *   • never-seen          ×3.0
   *   • previously-failed   ×2.0
   *   • slow-but-correct    ×1.5
   *   • mastered            ×0.5
   *   plus a ×1.5 bias toward the requested difficulty level.
   *
   * @param {Object<string,{seen:number,correct:number,avgTime:number}>} history
   * @param {{requiredLevel?:number}} [options]
   * @returns {object} a question record
   */
  function pick(history = {}, options = {}) {
    const candidates = pool.filter(q => !usedIds.has(q.id));
    if (!candidates.length) {
      // Recycle exhausted pool
      usedIds.clear();
      return pick(history, options);
    }
    const targetLevel = options.requiredLevel || levelTarget;

    let totalWeight = 0;
    const weights = new Array(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
      const q = candidates[i];
      const h = history[q.id];
      let w = 1.0;
      if (!h)                        w *= 3.0;
      else if (h.correct < h.seen)   w *= 2.0;
      else if (h.avgTime > 5000)     w *= 1.5;
      else                            w *= 0.5;
      const dLevel = Math.abs((q.level || 2) - targetLevel);
      if (dLevel === 0)              w *= 1.5;
      else if (dLevel === 1)         w *= 1.0;
      else                            w *= 0.5;
      weights[i] = w;
      totalWeight += w;
    }
    let r = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        usedIds.add(candidates[i].id);
        return candidates[i];
      }
    }
    const last = candidates[candidates.length - 1];
    usedIds.add(last.id);
    return last;
  }

  /**
   * Show the quiz overlay. Returns a Promise that resolves with the result.
   * Only one overlay can be open at a time (subsequent calls reject).
   */
  function open(question, trigger = 'Question') {
    if (openPromise) return openPromise;

    Audio.playQuizOpen();
    Audio.duck();

    const overlay = $('#screen-quiz');
    overlay.classList.remove('hidden');
    $('#quiz-trigger').textContent = trigger;
    $('#quiz-question').textContent = question.question;

    const choicesBox = $('#quiz-choices');
    choicesBox.innerHTML = '';
    const letters = ['A', 'B', 'C', 'D'];
    const choiceButtons = [];
    for (let i = 0; i < question.choices.length; i++) {
      const btn = document.createElement('button');
      btn.className = 'quiz-choice';
      btn.innerHTML = `<span class="letter">${letters[i]}</span><span>${escapeHtml(question.choices[i])}</span>`;
      btn.dataset.idx = i;
      choicesBox.appendChild(btn);
      choiceButtons.push(btn);
    }
    const feedback = $('#quiz-feedback');
    feedback.classList.add('hidden');
    feedback.classList.remove('correct', 'wrong');
    feedback.textContent = '';

    const barEl  = $('#quiz-timer-bar');
    const txtEl  = $('#quiz-timer-text');
    const tBox   = barEl?.parentElement; // the wrapping .quiz-timer

    const baseDuration = Math.max(question.duration || 8, minDuration);
    const duration = baseDuration * durationMultiplier * 1000;
    const startedAt = performance.now();
    let resolved = false;
    let rafId = 0;

    openPromise = new Promise((resolve) => {

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        cancelAnimationFrame(rafId);
        document.removeEventListener('keydown', handleKey, true);
        Audio.unduck();
        const wait = result.answered ? (result.correct ? Constants.QUIZ.FEEDBACK_OK_MS : Constants.QUIZ.FEEDBACK_KO_MS) : 600;
        setTimeout(() => {
          overlay.classList.add('hidden');
          openPromise = null;
          resolve(result);
        }, wait);
      };

      const handleAnswer = (idx) => {
        if (resolved) return;
        const elapsed = performance.now() - startedAt;
        const correct = idx === question.correct;
        for (let i = 0; i < choiceButtons.length; i++) {
          const b = choiceButtons[i];
          b.disabled = true;
          if (i === question.correct) b.classList.add('correct');
          if (i === idx && !correct)  b.classList.add('wrong');
        }
        feedback.classList.remove('hidden');
        feedback.classList.toggle('correct', correct);
        feedback.classList.toggle('wrong', !correct);
        feedback.textContent = (correct ? '✓ ' : '✗ ') + (question.explanation || '');
        correct ? Audio.playCorrect() : Audio.playWrong();
        finish({ answered: true, correct, elapsedMs: elapsed, choice: idx });
      };

      const handleSkip = () => {
        if (resolved) return;
        const elapsed = performance.now() - startedAt;
        Audio.playWrong();
        finish({ answered: false, skipped: true, correct: false, elapsedMs: elapsed, choice: -1 });
      };

      // Choice handlers
      for (let i = 0; i < choiceButtons.length; i++) {
        const idx = i;
        choiceButtons[i].addEventListener('click', () => handleAnswer(idx));
      }
      const skipBtn = $('#btn-quiz-skip');
      skipBtn.onclick = handleSkip;

      // Keyboard — registered in capture phase so we beat global listeners
      const handleKey = (ev) => {
        const k = ev.key.toLowerCase();
        const map = { a: 0, b: 1, c: 2, d: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
        if (k in map) {
          ev.preventDefault(); ev.stopPropagation();
          handleAnswer(map[k]);
        } else if (k === 'escape') {
          ev.preventDefault(); ev.stopPropagation();
          handleSkip();
        }
      };
      document.addEventListener('keydown', handleKey, true);

      // rAF-driven timer
      const tick = () => {
        if (resolved) return;
        const elapsed = performance.now() - startedAt;
        const left = Math.max(0, duration - elapsed);
        const pct = (left / duration) * 100;
        if (barEl) barEl.style.setProperty('--p', pct + '%');
        const sec = Math.ceil(left / 1000);
        if (txtEl) txtEl.textContent = sec + 's';

        // Urgency: red pulse below 3s
        const urgent = sec <= Constants.QUIZ.URGENCY_SECONDS;
        if (tBox) tBox.classList.toggle('urgent', urgent);

        if (left <= 0) {
          Audio.playWrong();
          finish({ answered: false, timeout: true, correct: false, elapsedMs: duration, choice: -1 });
          return;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });

    return openPromise;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function getStats(history) {
    const ids = Object.keys(history);
    if (!ids.length) return { mastery: 0, weakIds: [] };
    let mastered = 0;
    const weak = [];
    for (const id of ids) {
      const h = history[id];
      const acc = h.correct / Math.max(1, h.seen);
      if (acc >= 0.7) mastered++;
      else weak.push({ id, accuracy: acc });
    }
    weak.sort((a, b) => a.accuracy - b.accuracy);
    return { mastery: mastered / ids.length, weakIds: weak.slice(0, 5).map(w => w.id) };
  }

  return { init, pick, open, setLevelTarget, setDurationConfig, getStats };
})();
