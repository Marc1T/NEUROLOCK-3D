import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

type Provider = "mistral" | "groq";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function buildPrompt(text: string, numQuestions: number) {
  return `Tu es un créateur de quiz pédagogique expert.
À partir du cours ci-dessous, génère exactement ${numQuestions} questions de QCM en français.

RÈGLES STRICTES :
- "level" est un ENTIER : 1 = simple, 2 = intermédiaire, 3 = difficile (jamais une chaîne)
- "correct" est l'INDEX entier (0 à 3) du bon choix dans le tableau "choices"
- "duration" est un entier en secondes (entre 5 et 60)
- Exactement 4 choix par question, une seule bonne réponse
- L'explication doit être courte (max 15 mots), factuelle
- Varie les types : définition, calcul, vrai/faux reformulé, application
- Si le cours est insuffisant, génère des questions sur les notions fondamentales
- Les mauvais choix doivent être plausibles

RÉPONDS UNIQUEMENT avec un JSON valide, sans markdown :
[{
  "id": "q1",
  "subject": "Nom du chapitre",
  "level": 1,
  "question": "Texte de la question ?",
  "choices": ["Choix 1", "Choix 2", "Choix 3", "Choix 4"],
  "correct": 0,
  "explanation": "Pourquoi c'est juste.",
  "duration": 10,
  "tags": ["tag1"]
}]

COURS À ANALYSER :
${text.substring(0, 8000)}`;
}

async function callOpenAICompatible(
  url: string,
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Tu réponds uniquement par un JSON brut, sans bloc markdown." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${body.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Réponse vide de l'API");
  }
  return content;
}

function extractJsonArray(raw: string): any[] {
  // Accept either a top-level array or an object that wraps one
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return JSON.parse(arrayMatch[0]);
  }
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.questions)) return parsed.questions;
  throw new Error("Format JSON non trouvé dans la réponse IA");
}

function normalizeLevel(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(3, Math.max(1, Math.round(value)));
  }
  if (typeof value === "string") {
    const s = value.toLowerCase().trim();
    if (s.startsWith("3") || s.includes("expert") || s.includes("difficile") || s.includes("avanc")) return 3;
    if (s.startsWith("2") || s.includes("moyen") || s.includes("interm")) return 2;
    if (s.startsWith("1") || s.includes("simple") || s.includes("facile") || s.includes("basique")) return 1;
  }
  return 1;
}

function normalizeQuestions(raw: any[]): any[] {
  return raw
    .filter(q => q && typeof q.question === "string" && Array.isArray(q.choices))
    .map((q, i) => ({
      id: typeof q.id === "string" && q.id.length > 0 ? q.id : `q${i + 1}`,
      subject: typeof q.subject === "string" ? q.subject : "Cours",
      level: normalizeLevel(q.level),
      question: q.question,
      choices: q.choices.slice(0, 4).map((c: unknown) => String(c)),
      correct: Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.choices.length ? q.correct : 0,
      explanation: typeof q.explanation === "string" ? q.explanation : "",
      duration: Number.isFinite(q.duration) ? Math.min(60, Math.max(5, Math.round(q.duration))) : 10,
      tags: Array.isArray(q.tags) ? q.tags.map((t: unknown) => String(t)) : [],
    }))
    .filter(q => q.choices.length === 4);
}

async function generateWithProvider(
  provider: Provider,
  prompt: string
): Promise<{ questions: any[]; provider: Provider; model: string }> {
  if (provider === "mistral") {
    const key = process.env.MISTRAL_API_KEY;
    if (!key) throw new Error("MISTRAL_API_KEY manquante");
    const model = process.env.MISTRAL_MODEL || "mistral-large-latest";
    const raw = await callOpenAICompatible(MISTRAL_URL, key, model, prompt);
    return { questions: normalizeQuestions(extractJsonArray(raw)), provider, model };
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY manquante");
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const raw = await callOpenAICompatible(GROQ_URL, key, model, prompt);
  return { questions: extractJsonArray(raw), provider, model };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "10mb" }));

  app.post("/api/generate-questions", async (req, res) => {
    const { text, numQuestions = 10 } = req.body || {};
    if (typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Champ 'text' requis" });
    }

    const prompt = buildPrompt(text, Number(numQuestions) || 10);
    const errors: string[] = [];

    for (const provider of ["mistral", "groq"] as Provider[]) {
      try {
        console.log(`[AI] Tentative via ${provider}…`);
        const result = await generateWithProvider(provider, prompt);
        console.log(`[AI] OK via ${provider} (${result.model}) → ${result.questions.length} questions`);
        return res.json({ questions: result.questions, provider: result.provider, model: result.model });
      } catch (err: any) {
        const msg = `[${provider}] ${err?.message || String(err)}`;
        console.warn(`[AI] Échec ${msg}`);
        errors.push(msg);
      }
    }

    res.status(502).json({
      error: "Aucun fournisseur IA n'a répondu correctement",
      details: errors,
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`NEUROLOCK Server running on http://localhost:${PORT}`);
    console.log(
      `[AI] Providers: Mistral=${process.env.MISTRAL_API_KEY ? "ok" : "MISSING"}, Groq=${process.env.GROQ_API_KEY ? "ok" : "MISSING"}`
    );
  });
}

startServer();
