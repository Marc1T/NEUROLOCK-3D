/* ============================================================
   ui.js — screen routing, forms, course-select, settings, results, teacher
   ============================================================ */

const UI = (() => {

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let appState = {
    config: null,
    currentPack: null,
    activeProvider: 'mistral',
    apiKeys: {},
    runConfig: { timer: 120, questions: 15, difficulty: 2, adaptive: true }
  };

  // ---- Screen routing ----
  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const el = $(`#screen-${id}`);
    if (el) el.classList.add('active');
    if (id === 'home') refreshHome();
    if (id === 'course-select') refreshCourseSelect();
    if (id === 'settings') refreshSettings();
    if (id === 'teacher') refreshTeacher();
  }

  // ---- Toast ----
  function toast(msg, ms = 2400) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---- Loading overlay ----
  function showLoading(msg = 'Génération en cours…', sub = '') {
    $('#loading-msg').textContent = msg;
    $('#loading-sub').textContent = sub;
    $('#loading-overlay').classList.remove('hidden');
  }
  function updateLoading(msg, sub) {
    if (msg) $('#loading-msg').textContent = msg;
    if (sub !== undefined) $('#loading-sub').textContent = sub;
  }
  function hideLoading() {
    $('#loading-overlay').classList.add('hidden');
  }

  function setStatus(targetSel, msg, kind = 'info') {
    const el = $(targetSel);
    if (!el) return;
    el.classList.remove('hidden', 'success', 'error');
    if (kind === 'success') el.classList.add('success');
    if (kind === 'error') el.classList.add('error');
    el.textContent = msg;
  }

  // ---- Init ----
  async function init(config) {
    appState.config = config;
    AIPipeline.loadConfig(config);
    appState.apiKeys = Storage.getApiKeys();
    appState.activeProvider = Storage.getProvider() || config.defaultProvider;

    // Try loading keys.local.json (optional)
    try {
      const res = await fetch('data/keys.local.json');
      if (res.ok) {
        const keys = await res.json();
        // merge only if user didn't already set one
        for (const k of Object.keys(keys)) {
          if (keys[k] && !appState.apiKeys[k]) appState.apiKeys[k] = keys[k];
        }
        Storage.setApiKeys(appState.apiKeys);
      }
    } catch (e) { /* ok — file optional */ }

    Audio.loadPrefs(Storage.getAudioPrefs());

    wireNav();
    wireHome();
    wireCourseSelect();
    wirePreview();
    wireConfig();
    wireSettings();
    wireTeacher();
    wireResults();
    wireGameControls();

    showScreen('home');
  }

  function wireNav() {
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-nav]');
      if (t) {
        showScreen(t.dataset.nav);
        Audio.playClick();
      }
    });

    // Tabs
    document.addEventListener('click', (ev) => {
      const tab = ev.target.closest('.tab');
      if (!tab) return;
      const container = tab.closest('.screen');
      container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      container.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const panel = container.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
    });
  }

  // ---- HOME ----
  function wireHome() {}

  function refreshHome() {
    const save = Storage.getSave();
    const el = $('#home-stats');
    if (save.totalRuns > 0) {
      el.innerHTML = `
        <div>Runs : <strong style="color:var(--purple-light)">${save.totalRuns}</strong></div>
        <div>Meilleur score : <strong style="color:var(--purple-light)">${save.bestScore}</strong></div>
        ${save.playerName ? `<div>Joueur : <strong>${escapeHtml(save.playerName)}</strong></div>` : ''}
      `;
    } else {
      el.textContent = 'Première run ? Clique sur Jouer.';
    }

    // Recent runs
    const recent = $('#recent-runs');
    if (save.runs && save.runs.length) {
      const last = save.runs.slice(0, 5);
      let html = '<h4>Dernières runs</h4><div class="recent-runs-list">';
      for (const r of last) {
        const accPct = Math.round((r.accuracy || 0) * 100);
        const date = new Date(r.date || Date.now());
        const dateStr = `${date.getDate()}/${date.getMonth() + 1}`;
        html += `<div class="recent-run">
          <span class="rr-subject">${escapeHtml(r.subject || '—')}</span>
          <span class="rr-score">${r.score || 0}</span>
          <span class="rr-acc">${accPct}%</span>
          <span class="${r.victory ? 'rr-victory' : 'rr-defeat'}">${r.victory ? '✓ ' + dateStr : '✗ ' + dateStr}</span>
        </div>`;
      }
      html += '</div>';
      recent.innerHTML = html;
    } else {
      recent.innerHTML = '';
    }

    // Start home-canvas animation
    startHomeBackground();
  }

  // ---- Animated home background (particle field) ----
  let homeBgRaf = null;
  function startHomeBackground() {
    const canvas = $('#home-canvas-bg');
    if (!canvas) return;
    if (homeBgRaf) cancelAnimationFrame(homeBgRaf);

    const ctx = canvas.getContext('2d');
    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    // particle pool
    const N = 80;
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: 0.5 + Math.random() * 1.8,
        c: Math.random() < 0.3 ? '#36c896' : '#a87fdf',
        alpha: 0.2 + Math.random() * 0.6
      });
    }

    let active = true;
    const step = () => {
      if (!active) return;
      // only animate when home is active to save CPU
      if (!$('#screen-home').classList.contains('active')) {
        homeBgRaf = requestAnimationFrame(step);
        return;
      }
      ctx.fillStyle = 'rgba(10, 10, 26, 0.25)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.fillStyle = p.c;
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // faint connecting lines for close particles
      ctx.strokeStyle = 'rgba(124, 92, 191, 0.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i], b = parts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < 10000) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      homeBgRaf = requestAnimationFrame(step);
    };
    step();
  }

  // ---- COURSE SELECT ----
  function wireCourseSelect() {
    $('#btn-generate').addEventListener('click', () => generateCourse(false));
    $('#btn-generate-demo').addEventListener('click', () => generateCourse(true));

    $('#btn-session-load').addEventListener('click', () => {
      const code = $('#session-code').value.trim();
      if (!code) return toast('Entre un code');
      const pack = Storage.loadSession(code);
      if (!pack) return toast('Code session inconnu');
      loadPack(pack);
    });
    $('#btn-session-paste-load').addEventListener('click', () => {
      const raw = $('#session-paste').value.trim();
      if (!raw) return toast('Colle un JSON');
      try {
        const pack = JSON.parse(raw);
        if (!Array.isArray(pack.questions)) throw new Error('Pas de questions');
        loadPack(pack);
      } catch (e) {
        toast('JSON invalide');
      }
    });
  }

  function refreshCourseSelect() {
    // Predefined
    const predefBox = $('#predef-list');
    predefBox.innerHTML = '';
    const predefList = [
      { id: 'binaire', label: 'Binaire', desc: 'Conversions et opérations en base 2.' },
      { id: 'booleenne', label: 'Logique booléenne', desc: 'Portes logiques et tables de vérité.' },
      { id: 'hexadecimal', label: 'Hexadécimal', desc: 'Base 16, couleurs RGB.' },
      { id: 'maths_base', label: 'Maths de base', desc: 'Puissances, fractions, équations.' }
    ];
    for (const c of predefList) {
      const card = document.createElement('div');
      card.className = 'course-card';
      card.innerHTML = `<h4>${escapeHtml(c.label)}</h4><p>${escapeHtml(c.desc)}</p><span class="badge">prédéfini</span>`;
      card.addEventListener('click', async () => {
        try {
          const res = await fetch(`data/courses/${c.id}.json`);
          if (!res.ok) throw new Error('Pack introuvable');
          const pack = await res.json();
          loadPack(pack);
        } catch (e) {
          toast('Erreur chargement : ' + e.message);
        }
      });
      predefBox.appendChild(card);
    }

    // Custom
    const customBox = $('#custom-list');
    customBox.innerHTML = '';
    const list = Storage.listCourses();
    if (!list.length) {
      customBox.innerHTML = '<p class="muted">Aucun cours sauvegardé. Importe-en un via l\'onglet "Importer".</p>';
    } else {
      for (const c of list) {
        const card = document.createElement('div');
        card.className = 'course-card';
        card.innerHTML = `<h4>${escapeHtml(c.subject)}</h4><p>${c.count} questions</p>
          <span class="badge">custom</span>`;
        card.addEventListener('click', () => {
          const pack = Storage.loadCourse(c.id);
          if (pack) loadPack(pack);
        });
        const del = document.createElement('button');
        del.className = 'btn btn-danger';
        del.style.cssText = 'position:absolute;bottom:8px;right:8px;padding:4px 8px;font-size:11px';
        del.textContent = '🗑';
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (confirm('Supprimer ce cours ?')) {
            Storage.deleteCourse(c.id);
            refreshCourseSelect();
          }
        });
        card.appendChild(del);
        customBox.appendChild(card);
      }
    }
  }

  async function generateCourse(demo) {
    const subject = $('#import-subject').value.trim() || 'Cours sans titre';
    const difficulty = parseInt($('#import-difficulty').value, 10);
    const count = parseInt($('#import-count').value, 10) || 15;

    let text = $('#import-text').value.trim();
    const pdfFile = $('#import-pdf').files[0];
    const url = $('#import-url').value.trim();

    showLoading('Préparation…');

    try {
      if (!demo) {
        if (pdfFile) {
          updateLoading('Extraction PDF…', pdfFile.name);
          text = await AIPipeline.extractTextFromPDF(pdfFile);
        } else if (url) {
          updateLoading('Téléchargement URL…', url.slice(0, 60));
          text = await AIPipeline.extractTextFromURL(url);
        }
        if (!text) {
          throw new Error('Aucun texte à analyser. Colle du texte ou importe un PDF/URL.');
        }
      }

      let questions;
      if (demo) {
        updateLoading('Mode démo — génération locale', `${count} questions`);
        questions = AIPipeline.demoGenerate({ subject, count });
      } else {
        const providerLabel = AIPipeline.getProviders()[appState.activeProvider]?.label || appState.activeProvider;
        updateLoading(`Appel ${providerLabel}…`, `${count} questions de niveau ${difficulty}`);
        const apiKey = appState.apiKeys[appState.activeProvider];
        if (!apiKey) throw new Error(`Clé API ${appState.activeProvider} manquante (Paramètres).`);
        questions = await AIPipeline.generate({
          providerId: appState.activeProvider,
          apiKey, text, subject, difficulty, count
        });
      }

      const pack = {
        id: 'custom_' + Date.now().toString(36),
        subject, version: '1.0',
        author: demo ? 'NEUROLOCK Démo' : appState.activeProvider,
        questions
      };
      hideLoading();
      setStatus('#generate-status', `${questions.length} questions générées ✓`, 'success');
      loadPack(pack);
    } catch (e) {
      console.error(e);
      hideLoading();
      setStatus('#generate-status', 'Erreur : ' + e.message, 'error');
    }
  }

  // ---- PREVIEW ----
  function loadPack(pack) {
    appState.currentPack = pack;
    $('#preview-subject').textContent = pack.subject;
    $('#preview-stats').innerHTML = `
      <span><strong>${pack.questions.length}</strong> questions</span>
      <span><strong>${pack.author || '—'}</strong> auteur</span>
    `;
    const box = $('#preview-questions');
    box.innerHTML = '';
    const sample = pack.questions.slice(0, 3);
    for (const q of sample) {
      const el = document.createElement('div');
      el.className = 'preview-q';
      el.innerHTML = `
        <div class="q-meta">Niveau ${q.level} · ${(q.tags||[]).join(', ')}</div>
        <div class="q-text">${escapeHtml(q.question)}</div>
        <ol>${q.choices.map((c, i) => `<li class="${i === q.correct ? 'correct' : ''}">${escapeHtml(c)}</li>`).join('')}</ol>
        ${q.explanation ? `<div class="q-expl">→ ${escapeHtml(q.explanation)}</div>` : ''}
      `;
      box.appendChild(el);
    }
    showScreen('preview');
  }

  function wirePreview() {
    $('#btn-preview-save').addEventListener('click', () => {
      if (!appState.currentPack) return;
      Storage.saveCourse(appState.currentPack);
      toast('Cours sauvegardé !');
    });
    $('#btn-preview-play').addEventListener('click', () => {
      // pre-fill config with pack length
      $('#cfg-questions').value = Math.min(appState.currentPack.questions.length, 15);
      showScreen('config');
    });
  }

  // ---- CONFIG ----
  function wireConfig() {
    $('#btn-config-start').addEventListener('click', () => {
      appState.runConfig = {
        timer: parseInt($('#cfg-timer').value, 10) || 120,
        questions: parseInt($('#cfg-questions').value, 10) || 15,
        difficulty: parseInt($('#cfg-difficulty').value, 10) || 2,
        adaptive: $('#cfg-adaptive').checked
      };
      showScreen('game');
      Game.start(appState.currentPack, appState.runConfig);
    });
  }

  // ---- SETTINGS ----
  function wireSettings() {
    $('#btn-settings-save').addEventListener('click', () => {
      const save = Storage.getSave();
      save.playerName = $('#set-name').value.trim();
      Storage.setSave(save);
      Storage.setProvider($('#set-provider').value);
      appState.activeProvider = $('#set-provider').value;
      // collect keys
      const keys = { ...appState.apiKeys };
      $$('#provider-keys input').forEach(inp => {
        keys[inp.dataset.provider] = inp.value.trim();
      });
      Storage.setApiKeys(keys);
      appState.apiKeys = keys;
      const aud = { volume: parseInt($('#set-volume').value, 10), enabled: $('#set-audio-enabled').checked };
      Storage.setAudioPrefs(aud);
      Audio.loadPrefs(aud);
      setStatus('#settings-msg', 'Paramètres sauvegardés', 'success');
    });

    $('#btn-export-save').addEventListener('click', () => {
      const save = Storage.getSave();
      const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'neurolock-save.json');
    });

    $('#btn-reset-save').addEventListener('click', () => {
      if (!confirm('Effacer toutes les données (sauvegarde, cours, clés) ?')) return;
      Storage.resetAll();
      toast('Données effacées');
      refreshSettings();
    });
  }

  function refreshSettings() {
    const save = Storage.getSave();
    $('#set-name').value = save.playerName || '';

    const sel = $('#set-provider');
    sel.innerHTML = '';
    const providers = AIPipeline.getProviders();
    for (const id of Object.keys(providers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = providers[id].label;
      if (id === appState.activeProvider) opt.selected = true;
      sel.appendChild(opt);
    }

    const keysBox = $('#provider-keys');
    keysBox.innerHTML = '';
    for (const id of Object.keys(providers)) {
      const row = document.createElement('div');
      row.className = 'provider-key-row';
      row.innerHTML = `
        <label>${providers[id].label}</label>
        <input type="password" placeholder="Clé API…" data-provider="${id}" value="${escapeAttr(appState.apiKeys[id] || '')}">
      `;
      keysBox.appendChild(row);
    }

    const aud = Storage.getAudioPrefs();
    $('#set-volume').value = aud.volume;
    $('#set-audio-enabled').checked = aud.enabled;
  }

  // ---- TEACHER ----
  let teacherStudentRuns = [];

  function wireTeacher() {
    $('#btn-t-generate').addEventListener('click', async () => {
      const subject = $('#t-subject').value.trim() || 'Session';
      const difficulty = parseInt($('#t-difficulty').value, 10);
      const count = parseInt($('#t-count').value, 10);
      const text = $('#t-text').value.trim();
      if (!text) return toast('Colle du texte du cours');
      try {
        const apiKey = appState.apiKeys[appState.activeProvider];
        if (!apiKey) {
          toast('Clé API manquante — utilise le mode démo dans Importer');
          return;
        }
        showLoading('Génération session…', `${count} questions — ${subject}`);
        const questions = await AIPipeline.generate({
          providerId: appState.activeProvider,
          apiKey, text, subject, difficulty, count
        });
        hideLoading();
        const code = String(100000 + Math.floor(Math.random() * 900000));
        const pack = { id: 'sess_' + code, subject, version: '1.0', author: 'Enseignant', questions };
        Storage.saveSession(code, pack);
        $('#t-code').textContent = code;
        $('#t-result').classList.remove('hidden');
        appState.currentPack = pack;
        toast('Session créée !');
      } catch (e) {
        hideLoading();
        toast('Erreur : ' + e.message);
      }
    });

    $('#btn-t-export').addEventListener('click', () => {
      if (!appState.currentPack) return toast('Génère d\'abord');
      const blob = new Blob([JSON.stringify(appState.currentPack, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `${appState.currentPack.subject}-pack.json`);
    });

    $('#t-stats-import').addEventListener('change', async (ev) => {
      const files = Array.from(ev.target.files);
      for (const f of files) {
        const txt = await f.text();
        try {
          const run = JSON.parse(txt);
          teacherStudentRuns.push(run);
        } catch (e) {}
      }
      renderTeacherStats();
    });

    $('#btn-t-export-csv').addEventListener('click', () => {
      if (!teacherStudentRuns.length) return toast('Importe des résultats d\'abord');
      const rows = [['joueur', 'score', 'précision', 'temps_moyen_ms', 'questions_repondues']];
      for (const r of teacherStudentRuns) {
        rows.push([
          r.playerName || 'Anonyme',
          r.score || 0,
          ((r.accuracy || 0) * 100).toFixed(1) + '%',
          Math.round(r.avgResponseTime || 0),
          r.answeredTotal || 0
        ]);
      }
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, 'neurolock-classe.csv');
    });
  }

  function refreshTeacher() {
    // nothing dynamic on load
  }

  function renderTeacherStats() {
    const box = $('#t-stats-table');
    if (!teacherStudentRuns.length) { box.innerHTML = ''; return; }
    let html = '<table><thead><tr><th>Joueur</th><th>Score</th><th>Précision</th><th>Temps moyen</th></tr></thead><tbody>';
    for (const r of teacherStudentRuns) {
      html += `<tr>
        <td>${escapeHtml(r.playerName || 'Anonyme')}</td>
        <td>${r.score || 0}</td>
        <td>${((r.accuracy || 0) * 100).toFixed(0)}%</td>
        <td>${Math.round(r.avgResponseTime || 0)} ms</td>
      </tr>`;
    }
    html += '</tbody></table>';
    // class avg
    const avgAcc = teacherStudentRuns.reduce((s, r) => s + (r.accuracy || 0), 0) / teacherStudentRuns.length;
    html += `<p class="muted" style="margin-top:12px">Précision moyenne classe : <strong>${(avgAcc * 100).toFixed(1)}%</strong></p>`;
    box.innerHTML = html;
  }

  // ---- RESULTS ----
  function wireResults() {
    $('#btn-replay').addEventListener('click', () => {
      if (!appState.currentPack) return showScreen('course-select');
      showScreen('game');
      Game.start(appState.currentPack, appState.runConfig);
    });
  }

  function showResults(result) {
    const titleEl = $('#results-title');
    if (result.victory) {
      titleEl.textContent = 'VICTOIRE !';
      titleEl.className = 'victory';
      Audio.playVictory();
    } else {
      titleEl.textContent = 'GAME OVER';
      titleEl.className = 'defeat';
      Audio.playGameOver();
    }

    const grid = $('#results-grid');
    grid.innerHTML = `
      <div class="stat"><div class="stat-label">Score</div><div class="stat-value">${result.score}</div></div>
      <div class="stat"><div class="stat-label">Précision</div><div class="stat-value">${(result.accuracy * 100).toFixed(0)}%</div></div>
      <div class="stat"><div class="stat-label">Temps restant</div><div class="stat-value">${formatTime(result.timeLeft)}</div></div>
      <div class="stat"><div class="stat-label">Tours posées</div><div class="stat-value">${result.towersPlaced}</div></div>
      <div class="stat"><div class="stat-label">Ennemis détruits</div><div class="stat-value">${result.kills}</div></div>
      <div class="stat"><div class="stat-label">Questions</div><div class="stat-value">${result.answeredCorrect}/${result.answeredTotal}</div></div>
    `;

    // Review
    const review = $('#results-review');
    review.innerHTML = '';
    if (result.weakTags && result.weakTags.length) {
      for (const t of result.weakTags) {
        const li = document.createElement('li');
        li.textContent = t;
        review.appendChild(li);
      }
    } else {
      review.innerHTML = '<li class="muted">Tu maîtrises bien ce cours.</li>';
    }

    // Badges
    const badgesBox = $('#results-badges');
    badgesBox.innerHTML = '';
    for (const b of (result.badges || [])) {
      const el = document.createElement('span');
      el.className = 'badge-pill';
      el.textContent = b;
      badgesBox.appendChild(el);
    }

    // Persist run record
    Storage.recordRun({
      playerName: Storage.getSave().playerName || 'Anonyme',
      subject: result.subject,
      score: result.score,
      accuracy: result.accuracy,
      avgResponseTime: result.avgResponseTime,
      answeredTotal: result.answeredTotal,
      victory: result.victory,
      date: new Date().toISOString()
    });

    showScreen('results');
  }

  // ---- GAME PAUSE controls ----
  function wireGameControls() {
    $('#btn-pause').addEventListener('click', () => Game.togglePause());
    $('#btn-resume').addEventListener('click', () => Game.togglePause());
    $('#btn-abandon').addEventListener('click', () => Game.abandon());

    // Mobile dpad
    $$('#mobile-controls button').forEach(b => {
      const dir = b.dataset.dir;
      const handler = (down) => () => Game.setTouchDir(dir, down);
      b.addEventListener('touchstart', handler(true), { passive: true });
      b.addEventListener('touchend',   handler(false), { passive: true });
      b.addEventListener('mousedown',  handler(true));
      b.addEventListener('mouseup',    handler(false));
      b.addEventListener('mouseleave', handler(false));
    });
  }

  // ---- helpers ----
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g, ''); }

  function formatTime(s) {
    if (s < 0) s = 0;
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss.toString().padStart(2, '0')}`;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function showEventBanner(text, ms = 1800) {
    const el = $('#event-banner');
    el.textContent = text;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), ms);
  }

  return {
    init, showScreen, toast, showResults, formatTime, showEventBanner
  };
})();
