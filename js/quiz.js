/* ============================================================
   quiz.js — question selection, overlay UI, scoring
   ============================================================ */

const Quiz = (() => {

  let pool = [];          // all questions in current run
  let usedIds = new Set();
  let active = null;      // { question, startedAt, timerId, onResolve }
  let levelTarget = 2;
  let durationMultiplier = 1.0;
  let minDuration = 8;

  const $ = (sel) => document.querySelector(sel);

  function init(pack) {
    pool = pack.questions.slice();
    usedIds = new Set();
    active = null;
    levelTarget = 2;
  }

  function setLevelTarget(l) { levelTarget = Math.max(1, Math.min(3, l)); }

  function setDurationConfig(multiplier, floor) {
    durationMultiplier = multiplier || 1.0;
    minDuration = floor || 8;
  }

  // ---- Weighted random pick ----
  function pick(history = {}, options = {}) {
    const candidates = pool.filter(q => !usedIds.has(q.id));
    if (!candidates.length) {
      // recycle
      usedIds.clear();
      return pick(history, options);
    }

    const requiredLevel = options.requiredLevel || levelTarget;

    const weighted = candidates.map(q => {
      const h = history[q.id];
      let w = 1.0;
      if (!h) w *= 3.0;                                  // never seen
      else if (h.correct < h.seen) w *= 2.0;             // failed before
      else if (h.avgTime && h.avgTime > 5000) w *= 1.5;  // slow
      else w *= 0.5;                                     // mastered
      // bias towards target level
      if (q.level === requiredLevel) w *= 1.5;
      else if (Math.abs(q.level - requiredLevel) === 1) w *= 1.0;
      else w *= 0.5;
      return { q, w };
    });

    const total = weighted.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    for (const x of weighted) {
      r -= x.w;
      if (r <= 0) {
        usedIds.add(x.q.id);
        return x.q;
      }
    }
    const last = weighted[weighted.length - 1].q;
    usedIds.add(last.id);
    return last;
  }

  // ---- Show the quiz overlay; returns Promise resolving with {answered, correct, elapsedMs, choice} ----
  function open(question, trigger = 'Question') {
    Audio.playQuizOpen();
    const overlay = $('#screen-quiz');
    overlay.classList.remove('hidden');

    $('#quiz-trigger').textContent = trigger;
    $('#quiz-question').textContent = question.question;

    const choicesBox = $('#quiz-choices');
    choicesBox.innerHTML = '';
    const letters = ['A', 'B', 'C', 'D'];
    question.choices.forEach((text, i) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-choice';
      btn.innerHTML = `<span class="letter">${letters[i]}</span><span>${escapeHtml(text)}</span>`;
      btn.dataset.idx = i;
      choicesBox.appendChild(btn);
    });

    const feedback = $('#quiz-feedback');
    feedback.classList.add('hidden');
    feedback.textContent = '';

    const baseDuration = Math.max(question.duration || 8, minDuration);
    const duration = baseDuration * durationMultiplier * 1000;
    const startedAt = performance.now();
    let resolved = false;

    return new Promise((resolve) => {

      function finish(result) {
        if (resolved) return;
        resolved = true;
        clearInterval(timer);
        document.removeEventListener('keydown', handleKey);
        // delay close to show feedback
        setTimeout(() => {
          overlay.classList.add('hidden');
          active = null;
          resolve(result);
        }, result.answered ? (result.correct ? 800 : 1400) : 600);
      }

      function handleAnswer(idx) {
        if (resolved) return;
        const elapsed = performance.now() - startedAt;
        const correct = idx === question.correct;
        // visual feedback
        const buttons = choicesBox.querySelectorAll('.quiz-choice');
        buttons.forEach((b, i) => {
          b.disabled = true;
          if (i === question.correct) b.classList.add('correct');
          if (i === idx && !correct) b.classList.add('wrong');
        });
        feedback.classList.remove('hidden');
        feedback.classList.toggle('correct', correct);
        feedback.classList.toggle('wrong', !correct);
        feedback.textContent = (correct ? '✓ ' : '✗ ') + (question.explanation || '');
        if (correct) Audio.playCorrect(); else Audio.playWrong();
        finish({ answered: true, correct, elapsedMs: elapsed, choice: idx });
      }

      function handleSkip() {
        if (resolved) return;
        const elapsed = performance.now() - startedAt;
        Audio.playWrong();
        finish({ answered: false, skipped: true, correct: false, elapsedMs: elapsed, choice: -1 });
      }

      // attach choice handlers
      choicesBox.querySelectorAll('.quiz-choice').forEach(btn => {
        btn.addEventListener('click', () => handleAnswer(parseInt(btn.dataset.idx, 10)));
      });

      // skip button
      const skipBtn = $('#btn-quiz-skip');
      skipBtn.onclick = handleSkip;

      // keyboard shortcuts A/B/C/D
      function handleKey(ev) {
        const key = ev.key.toLowerCase();
        const map = { a: 0, b: 1, c: 2, d: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
        if (key in map) {
          ev.preventDefault();
          handleAnswer(map[key]);
        } else if (key === 'escape') {
          ev.preventDefault();
          handleSkip();
        }
      }
      document.addEventListener('keydown', handleKey);

      // visual timer
      const bar = $('#quiz-timer-bar');
      const txt = $('#quiz-timer-text');
      bar.style.setProperty('--p', '100%');
      const timer = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        const left = Math.max(0, duration - elapsed);
        const pct = (left / duration) * 100;
        bar.style.setProperty('--p', pct + '%');
        txt.textContent = Math.ceil(left / 1000) + 's';
        if (left <= 0) {
          Audio.playWrong();
          finish({ answered: false, timeout: true, correct: false, elapsedMs: duration, choice: -1 });
        }
      }, 100);

      active = { question, startedAt, resolve };
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function getStats(history) {
    const ids = Object.keys(history);
    const total = ids.length;
    if (!total) return { mastery: 0, weakIds: [] };
    let mastered = 0;
    const weak = [];
    for (const id of ids) {
      const h = history[id];
      const acc = h.correct / Math.max(1, h.seen);
      if (acc >= 0.7) mastered++;
      else weak.push({ id, accuracy: acc });
    }
    weak.sort((a, b) => a.accuracy - b.accuracy);
    return {
      mastery: mastered / total,
      weakIds: weak.slice(0, 5).map(w => w.id)
    };
  }

  return { init, pick, open, setLevelTarget, setDurationConfig, getStats };
})();
