/* ============================================================
   ai_pipeline.js — multi-provider question generation
   Providers : mistral, groq, gemini, claude
   Input source : free text, PDF (pdf.js), URL (CORS proxy)
   ============================================================ */

const AIPipeline = (() => {

  let providers = {};
  let defaultProvider = 'mistral';

  function loadConfig(cfg) {
    providers = cfg.providers || {};
    defaultProvider = cfg.defaultProvider || 'mistral';
  }

  function getProviders() { return providers; }

  // ---- Prompt builder ----
  function buildPrompt(text, subject, difficulty, count) {
    const desc = {
      1: 'simples (reconnaissance directe, une opération)',
      2: 'intermédiaires (2 à 3 étapes de raisonnement)',
      3: 'difficiles (analyse, déduction, application complexe)'
    }[difficulty] || 'intermédiaires';

    return `Tu es un créateur de quiz pédagogique expert.
À partir du cours ci-dessous, génère exactement ${count} questions de QCM en français.

RÈGLES STRICTES :
- Difficulté : ${desc}
- 4 choix par question, une seule bonne réponse
- L'explication doit être courte (max 15 mots), factuelle
- Varie les types : définition, calcul, vrai/faux reformulé, application
- Si le cours est insuffisant, génère des questions sur les notions fondamentales de "${subject}"
- Les mauvais choix doivent être plausibles

RÉPONDS UNIQUEMENT avec un JSON valide, sans markdown, sans commentaire :
[
  {
    "id": "q001",
    "subject": "${subject}",
    "level": ${difficulty},
    "question": "...",
    "choices": ["...", "...", "...", "..."],
    "correct": 0,
    "explanation": "...",
    "duration": 8,
    "tags": ["..."]
  }
]

COURS À ANALYSER :
${text.slice(0, 8000)}`;
  }

  // ---- Provider-specific request builders ----
  async function callMistral(prompt, apiKey, cfg) {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.6
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Mistral error ${res.status}`);
    return data.choices?.[0]?.message?.content || '';
  }

  async function callGroq(prompt, apiKey, cfg) {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.5,
        response_format: { type: 'json_object' }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Groq error ${res.status}`);
    return data.choices?.[0]?.message?.content || '';
  }

  async function callGemini(prompt, apiKey, cfg) {
    const url = `${cfg.endpoint}?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 4096 }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini error ${res.status}`);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async function callClaude(prompt, apiKey, cfg) {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude error ${res.status}`);
    return data.content?.[0]?.text || '';
  }

  // ---- Main entrypoint ----
  async function generate(opts) {
    const {
      providerId = defaultProvider,
      apiKey,
      text,
      subject = 'Inconnu',
      difficulty = 2,
      count = 15
    } = opts;

    const cfg = providers[providerId];
    if (!cfg) throw new Error(`Provider inconnu : ${providerId}`);
    if (!apiKey) throw new Error(`Clé API manquante pour ${cfg.label}. Va dans Paramètres.`);

    const prompt = buildPrompt(text || '', subject, difficulty, count);

    let raw = '';
    if (providerId === 'mistral') raw = await callMistral(prompt, apiKey, cfg);
    else if (providerId === 'groq') raw = await callGroq(prompt, apiKey, cfg);
    else if (providerId === 'gemini') raw = await callGemini(prompt, apiKey, cfg);
    else if (providerId === 'claude') raw = await callClaude(prompt, apiKey, cfg);
    else throw new Error(`Pas d'implémentation pour ${providerId}`);

    return parseQuestions(raw, subject);
  }

  function parseQuestions(raw, subject) {
    // strip code fences
    let clean = raw.replace(/```json|```/g, '').trim();

    // Try to extract a JSON array if the model wrapped it in prose
    const arrStart = clean.indexOf('[');
    const arrEnd = clean.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      clean = clean.slice(arrStart, arrEnd + 1);
    } else {
      // Some providers (groq json_object) return an object {questions: [...]}
      const objStart = clean.indexOf('{');
      const objEnd = clean.lastIndexOf('}');
      if (objStart >= 0 && objEnd > objStart) {
        try {
          const obj = JSON.parse(clean.slice(objStart, objEnd + 1));
          if (Array.isArray(obj.questions)) return normalize(obj.questions, subject);
          // try other common keys
          for (const k of Object.keys(obj)) {
            if (Array.isArray(obj[k])) return normalize(obj[k], subject);
          }
        } catch (e) {}
      }
    }

    let arr;
    try { arr = JSON.parse(clean); }
    catch (e) {
      throw new Error('Réponse IA non-parsable. Réessaye ou change de fournisseur.');
    }
    if (!Array.isArray(arr)) throw new Error('La réponse IA n\'est pas un tableau.');
    return normalize(arr, subject);
  }

  function normalize(arr, subject) {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i];
      if (!q || !q.question || !Array.isArray(q.choices) || q.choices.length < 2) continue;
      out.push({
        id: q.id || `q_${Date.now().toString(36)}_${i}`,
        subject: q.subject || subject,
        level: Number(q.level) || 2,
        question: String(q.question),
        choices: q.choices.slice(0, 4).map(String),
        correct: Math.max(0, Math.min(3, Number(q.correct) || 0)),
        explanation: String(q.explanation || ''),
        duration: Number(q.duration) || 8,
        tags: Array.isArray(q.tags) ? q.tags : []
      });
    }
    if (!out.length) throw new Error('Aucune question valide générée.');
    return out;
  }

  // ---- Source extractors ----
  async function extractTextFromPDF(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('pdf.js non chargé');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let full = '';
    const maxPages = Math.min(pdf.numPages, 12);
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      full += content.items.map(it => it.str).join(' ') + '\n';
    }
    return full;
  }

  async function extractTextFromURL(url) {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error('Échec du proxy CORS');
    const data = await res.json();
    const parser = new DOMParser();
    const doc = parser.parseFromString(data.contents, 'text/html');
    doc.querySelectorAll('script, style, nav, footer, header, noscript').forEach(el => el.remove());
    const main = doc.querySelector('main, article, .content, #content');
    const text = (main ? main.innerText : doc.body?.innerText) || '';
    return text.slice(0, 8000);
  }

  // ---- Demo mode (no API call) ----
  function demoGenerate({ subject = 'Démo', count = 10 } = {}) {
    const base = [
      ['Quelle est la capitale de la France ?', ['Lyon', 'Paris', 'Marseille', 'Bordeaux'], 1, 'Paris est la capitale.'],
      ['2 + 2 × 3 = ?', ['10', '8', '12', '6'], 1, 'Multiplication d\'abord : 2 + 6 = 8.'],
      ['Couleur primaire ?', ['Vert', 'Orange', 'Rouge', 'Violet'], 2, 'Le rouge est primaire.'],
      ['Auteur du Petit Prince ?', ['Camus', 'Sartre', 'Saint-Exupéry', 'Hugo'], 2, 'Antoine de Saint-Exupéry.'],
      ['Année du débarquement ?', ['1942', '1944', '1945', '1939'], 1, '6 juin 1944.'],
      ['Symbole du fer ?', ['Fe', 'Fr', 'Au', 'Fi'], 0, 'Fer = Fe.'],
      ['Plus grand océan ?', ['Atlantique', 'Indien', 'Pacifique', 'Arctique'], 2, 'Pacifique : plus de 165M km².'],
      ['Théorème de Pythagore : c² =', ['a + b', 'a² + b²', 'a × b', '(a+b)²'], 1, 'Somme des carrés des côtés.'],
      ['Langue officielle du Brésil ?', ['Espagnol', 'Portugais', 'Anglais', 'Français'], 1, 'Portugais.'],
      ['HTML est un', ['langage de programmation', 'protocole', 'langage de balisage', 'framework'], 2, 'HyperText Markup Language.'],
      ['1 km = ? mètres', ['100', '500', '1000', '10000'], 2, '1 kilomètre = 1000 m.'],
      ['Inventeur du téléphone ?', ['Edison', 'Bell', 'Tesla', 'Marconi'], 1, 'Alexander Graham Bell, 1876.'],
      ['Couleur du sang oxygéné ?', ['Bleu', 'Vert', 'Rouge clair', 'Rouge foncé'], 2, 'Rouge clair = oxygéné.'],
      ['Premier président des USA ?', ['Lincoln', 'Jefferson', 'Washington', 'Adams'], 2, 'George Washington, 1789.'],
      ['10² = ?', ['20', '100', '1000', '10'], 1, '10 × 10 = 100.']
    ];
    const out = [];
    for (let i = 0; i < count; i++) {
      const [q, c, ok, ex] = base[i % base.length];
      out.push({
        id: `demo_${i}`,
        subject,
        level: 1 + (i % 3),
        question: q,
        choices: c,
        correct: ok,
        explanation: ex,
        duration: 8,
        tags: ['démo']
      });
    }
    return out;
  }

  return {
    loadConfig, getProviders,
    generate, parseQuestions,
    extractTextFromPDF, extractTextFromURL,
    demoGenerate
  };
})();
