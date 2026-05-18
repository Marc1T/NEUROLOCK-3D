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

  // ─── Home neural-network background ────────────────────────────────────
  // A breathing neural net: nodes drift, fire randomly, pulses travel along
  // synapses, mouse proximity activates nearby nodes. ~60 fps on a mid laptop.
  let homeBgRaf = null;
  let homeBgState = null;

  function startHomeBackground() {
    const canvas = $('#home-canvas-bg');
    if (!canvas) return;
    if (homeBgRaf) cancelAnimationFrame(homeBgRaf);

    const ctx = canvas.getContext('2d', { alpha: true });

    // ── Setup: nodes, connections (precomputed adjacency for perf), pulses
    const COLORS = ['#a87fdf', '#36c896', '#b89cff'];
    const NODE_COUNT = 64;
    const LINK_DIST = 160;        // px — visual edge threshold
    const LINK_DIST_SQ = LINK_DIST * LINK_DIST;
    const FIRE_INTERVAL_MIN = 1800; // ms
    const FIRE_INTERVAL_MAX = 5500;

    const state = {
      nodes: [],
      pulses: [],
      mouseX: -9999,
      mouseY: -9999,
      lastTs: 0
    };

    /** Initialise the network — clusters of nodes spread with soft randomness. */
    function build() {
      state.nodes.length = 0;
      const W = canvas.width, H = canvas.height;
      for (let i = 0; i < NODE_COUNT; i++) {
        state.nodes.push({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.20,
          vy: (Math.random() - 0.5) * 0.20,
          baseR: 1.3 + Math.random() * 1.8,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          activation: 0,
          nextFire: performance.now() + Math.random() * FIRE_INTERVAL_MAX
        });
      }
    }

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      build();
    };
    resize();
    window.addEventListener('resize', resize);

    // Mouse interaction — document-level (canvas has pointer-events: none)
    const onMove = (ev) => {
      const r = canvas.getBoundingClientRect();
      state.mouseX = ev.clientX - r.left;
      state.mouseY = ev.clientY - r.top;
    };
    const onLeave = () => { state.mouseX = -9999; state.mouseY = -9999; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);

    homeBgState = state;

    // ── Main loop
    const step = (ts) => {
      if (!$('#screen-home').classList.contains('active')) {
        // Pause while home is hidden — saves battery
        homeBgRaf = requestAnimationFrame(step);
        return;
      }
      const dt = state.lastTs ? Math.min(50, ts - state.lastTs) : 16;
      state.lastTs = ts;

      // Trail-fade overlay (subtle motion blur)
      ctx.fillStyle = 'rgba(10, 10, 26, 0.32)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // ── 1. Update nodes (drift, decay activation, auto-fire)
      const nodes = state.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.x += n.vx * (dt / 16.67);
        n.y += n.vy * (dt / 16.67);
        // Wrap around edges
        if (n.x < 0) n.x += canvas.width;
        if (n.x > canvas.width) n.x -= canvas.width;
        if (n.y < 0) n.y += canvas.height;
        if (n.y > canvas.height) n.y -= canvas.height;
        // Decay
        n.activation *= 0.93;

        // Mouse proximity boost
        const dxm = n.x - state.mouseX;
        const dym = n.y - state.mouseY;
        const dmSq = dxm * dxm + dym * dym;
        if (dmSq < 14400) { // 120²
          n.activation = Math.min(1, n.activation + (1 - dmSq / 14400) * 0.06);
        }

        // Auto-fire: pick a random neighbor and send a pulse
        if (ts >= n.nextFire) {
          n.activation = 1;
          n.nextFire = ts + FIRE_INTERVAL_MIN + Math.random() * (FIRE_INTERVAL_MAX - FIRE_INTERVAL_MIN);
          // Find a neighbor within LINK_DIST and emit a pulse
          const targetIdx = pickNearestNeighbor(i);
          if (targetIdx >= 0) {
            state.pulses.push({
              from: i,
              to: targetIdx,
              progress: 0,
              speed: 0.0014 + Math.random() * 0.0012, // per ms
              color: n.color,
              born: ts
            });
          }
        }
      }

      // ── 2. Draw connections (only visible pairs)
      //    Two passes: faint baseline, then bright activated edges on top.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_DIST_SQ) continue;
          // Alpha falls off with distance, boosted by node activations
          const dist = Math.sqrt(d2);
          const base = 1 - dist / LINK_DIST;          // 0..1
          const boost = Math.max(a.activation, b.activation);
          const alpha = base * (0.10 + boost * 0.55);
          ctx.strokeStyle = `rgba(168, 127, 223, ${alpha})`;
          ctx.lineWidth = 0.6 + boost * 1.0;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // ── 3. Update + draw pulses
      for (let p = state.pulses.length - 1; p >= 0; p--) {
        const pulse = state.pulses[p];
        pulse.progress += pulse.speed * dt;
        if (pulse.progress >= 1) {
          // Pulse arrived — activate target (chain firing)
          const target = nodes[pulse.to];
          if (target) target.activation = Math.min(1, target.activation + 0.85);
          state.pulses.splice(p, 1);
          continue;
        }
        const from = nodes[pulse.from];
        const to = nodes[pulse.to];
        if (!from || !to) { state.pulses.splice(p, 1); continue; }
        const px = from.x + (to.x - from.x) * pulse.progress;
        const py = from.y + (to.y - from.y) * pulse.progress;

        // Bright head with halo
        ctx.shadowColor = pulse.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = pulse.color;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(px, py, 2.8, 0, Math.PI * 2);
        ctx.fill();

        // Short tail
        const tailLen = 0.10;
        const tx = from.x + (to.x - from.x) * Math.max(0, pulse.progress - tailLen);
        const ty = from.y + (to.y - from.y) * Math.max(0, pulse.progress - tailLen);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = pulse.color;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.shadowBlur = 0;

      // ── 4. Draw nodes with activation-driven glow
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const r = n.baseR * (1 + n.activation * 0.8);
        if (n.activation > 0.05) {
          // Halo
          ctx.shadowColor = n.color;
          ctx.shadowBlur = 14 * n.activation;
        }
        ctx.fillStyle = n.color;
        ctx.globalAlpha = 0.4 + n.activation * 0.6;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;

      homeBgRaf = requestAnimationFrame(step);
    };

    /**
     * Find a near-ish neighbor (within LINK_DIST) to fire toward. We sample
     * a few random candidates rather than computing all-pairs to keep it cheap.
     */
    function pickNearestNeighbor(sourceIdx) {
      const a = state.nodes[sourceIdx];
      const N = state.nodes.length;
      let bestIdx = -1, bestSq = LINK_DIST_SQ;
      // Sample 12 random candidates
      for (let k = 0; k < 12; k++) {
        const j = (Math.random() * N) | 0;
        if (j === sourceIdx) continue;
        const b = state.nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestSq) { bestSq = d2; bestIdx = j; }
      }
      return bestIdx;
    }

    homeBgRaf = requestAnimationFrame(step);
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
      <div class="stat"><div class="stat-label">Meilleur combo</div><div class="stat-value">×${result.bestCombo || 0}</div></div>
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

  /**
   * Cinematic wave card: dramatic full-screen number + label, auto-hides.
   * @param {number} num wave number
   */
  function showWaveCard(num) {
    const el = $('#wave-card');
    const numEl = $('#wave-card-number');
    if (!el || !numEl) return;
    numEl.textContent = num;
    el.classList.remove('hidden');
    // re-trigger animation
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    setTimeout(() => el.classList.add('hidden'), 1800);
  }

  return {
    init, showScreen, toast, showResults, formatTime, showEventBanner, showWaveCard,
    showLoading, updateLoading, hideLoading
  };
})();
