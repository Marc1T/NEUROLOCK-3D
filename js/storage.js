/* ============================================================
   storage.js — cookie-based persistence (NO localStorage)
   - Single small values  : simple cookies
   - Large objects (courses, history) : chunked cookies
   - All values are JSON + base64 (URL-safe) encoded
   - Chunked keys use prefix__1, prefix__2, prefix__count
   ============================================================ */

const Storage = (() => {

  // ---- Low level cookie helpers ----
  const COOKIE_MAX_DAYS = 365;
  const COOKIE_CHUNK = 3500; // safe per-cookie body size (browsers cap ~4096)

  function setCookie(name, value, days = COOKIE_MAX_DAYS) {
    const exp = new Date(Date.now() + days * 86400000).toUTCString();
    document.cookie = `${name}=${value}; expires=${exp}; path=/; SameSite=Lax`;
  }

  function getCookie(name) {
    const all = document.cookie.split('; ');
    for (const c of all) {
      const idx = c.indexOf('=');
      if (idx > -1 && c.slice(0, idx) === name) {
        return c.slice(idx + 1);
      }
    }
    return null;
  }

  function deleteCookie(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }

  // ---- Encoding ----
  function encode(obj) {
    const json = JSON.stringify(obj);
    // base64 URL-safe to survive cookie parsing
    return btoa(unescape(encodeURIComponent(json)));
  }
  function decode(str) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(str))));
    } catch (e) {
      console.warn('[Storage] decode failed', e);
      return null;
    }
  }

  // ---- Public API: simple values ----
  function setValue(key, val) {
    if (val === null || val === undefined) {
      removeValue(key);
      return;
    }
    const enc = encode(val);
    if (enc.length <= COOKIE_CHUNK) {
      // Clear any old chunks for safety
      removeChunks(key);
      setCookie(`nl_${key}`, enc);
    } else {
      // Remove single-cookie version if present
      deleteCookie(`nl_${key}`);
      setChunked(key, enc);
    }
  }

  function getValue(key, fallback = null) {
    // Try chunked first (more authoritative if both exist)
    const countCookie = getCookie(`nl_${key}__count`);
    if (countCookie) {
      const n = parseInt(countCookie, 10);
      let full = '';
      for (let i = 0; i < n; i++) {
        const part = getCookie(`nl_${key}__${i}`);
        if (part === null) return fallback;
        full += part;
      }
      return decode(full) ?? fallback;
    }
    const raw = getCookie(`nl_${key}`);
    if (raw === null) return fallback;
    return decode(raw) ?? fallback;
  }

  function removeValue(key) {
    deleteCookie(`nl_${key}`);
    removeChunks(key);
  }

  function setChunked(key, encoded) {
    removeChunks(key);
    const chunks = [];
    for (let i = 0; i < encoded.length; i += COOKIE_CHUNK) {
      chunks.push(encoded.slice(i, i + COOKIE_CHUNK));
    }
    setCookie(`nl_${key}__count`, chunks.length.toString());
    chunks.forEach((c, i) => setCookie(`nl_${key}__${i}`, c));
  }

  function removeChunks(key) {
    const countCookie = getCookie(`nl_${key}__count`);
    if (!countCookie) return;
    const n = parseInt(countCookie, 10);
    for (let i = 0; i < n; i++) deleteCookie(`nl_${key}__${i}`);
    deleteCookie(`nl_${key}__count`);
  }

  // ---- Domain helpers ----
  function getSave() {
    return getValue('save', {
      playerName: '',
      totalRuns: 0,
      bestScore: 0,
      activeCourse: null,
      questionHistory: {},
      unlockedBadges: [],
      runs: []
    });
  }

  function setSave(save) {
    setValue('save', save);
  }

  function updateSave(patch) {
    const s = getSave();
    Object.assign(s, patch);
    setSave(s);
    return s;
  }

  function getApiKeys() {
    return getValue('keys', { mistral: '', groq: '', gemini: '', claude: '' });
  }

  function setApiKeys(keys) {
    setValue('keys', keys);
  }

  function getProvider() {
    return getValue('provider', 'mistral');
  }

  function setProvider(p) {
    setValue('provider', p);
  }

  function getAudioPrefs() {
    return getValue('audio', { volume: 60, enabled: true });
  }

  function setAudioPrefs(p) {
    setValue('audio', p);
  }

  // ---- Courses (potentially large) ----
  function listCourses() {
    return getValue('courses_list', []);
  }

  function saveCourse(course) {
    const list = listCourses();
    const idx = list.findIndex(c => c.id === course.id);
    if (idx >= 0) list[idx] = { id: course.id, subject: course.subject, count: course.questions.length };
    else list.push({ id: course.id, subject: course.subject, count: course.questions.length });
    setValue('courses_list', list);
    setValue(`course_${course.id}`, course);
  }

  function loadCourse(id) {
    return getValue(`course_${id}`);
  }

  function deleteCourse(id) {
    removeValue(`course_${id}`);
    const list = listCourses().filter(c => c.id !== id);
    setValue('courses_list', list);
  }

  // ---- Sessions (teacher) ----
  function saveSession(code, pack) {
    setValue(`sess_${code}`, pack);
  }

  function loadSession(code) {
    return getValue(`sess_${code}`);
  }

  // ---- Question history ----
  function recordQuestion(qid, correct, timeMs) {
    const save = getSave();
    const h = save.questionHistory[qid] || { seen: 0, correct: 0, avgTime: 0 };
    h.seen += 1;
    if (correct) h.correct += 1;
    h.avgTime = Math.round(((h.avgTime * (h.seen - 1)) + timeMs) / h.seen);
    save.questionHistory[qid] = h;
    setSave(save);
  }

  // ---- Run records ----
  function recordRun(run) {
    const save = getSave();
    save.totalRuns += 1;
    if (run.score > save.bestScore) save.bestScore = run.score;
    save.runs = save.runs || [];
    save.runs.unshift(run);
    if (save.runs.length > 20) save.runs = save.runs.slice(0, 20);
    setSave(save);
  }

  // ---- Reset ----
  function resetAll() {
    const all = document.cookie.split('; ');
    for (const c of all) {
      const idx = c.indexOf('=');
      if (idx < 0) continue;
      const name = c.slice(0, idx);
      if (name.startsWith('nl_')) deleteCookie(name);
    }
  }

  return {
    setValue, getValue, removeValue,
    getSave, setSave, updateSave,
    getApiKeys, setApiKeys,
    getProvider, setProvider,
    getAudioPrefs, setAudioPrefs,
    listCourses, saveCourse, loadCourse, deleteCourse,
    saveSession, loadSession,
    recordQuestion, recordRun,
    resetAll
  };
})();
