import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Question, ThemeColors } from '../types';
import { extractTextFromPDF, PDFExtractionProgress } from '../lib/pdfExtractor';
import { Upload, FileText, Sparkles, X, CheckCircle, AlertCircle, RefreshCw, Cpu, Brain, Play } from 'lucide-react';

interface CourseCreatorProps {
  theme: ThemeColors;
  existingQuestions: Question[];
  onClose: () => void;
  /** Called with the merged questions when the user validates. */
  onCreated: (allQuestions: Question[]) => void;
  /** Called when the user clicks "Jouer ce cours" — receives only the newly generated questions. */
  onPlayNow?: (newCourseQuestions: Question[]) => void;
}

type Mode = 'text' | 'pdf';
type Phase = 'edit' | 'extracting' | 'generating' | 'review' | 'done';

export function CourseCreator({ theme, existingQuestions, onClose, onCreated, onPlayNow }: CourseCreatorProps) {
  const [mode, setMode] = useState<Mode>('text');
  const [phase, setPhase] = useState<Phase>('edit');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [level, setLevel] = useState(2);
  const [numQuestions, setNumQuestions] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [pdfFileName, setPdfFileName] = useState<string>('');
  const [generated, setGenerated] = useState<Question[]>([]);
  const [provider, setProvider] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePDFUpload = useCallback(async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Le fichier doit être un PDF (.pdf).');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('Fichier trop volumineux (limite 20 Mo).');
      return;
    }
    setPdfFileName(file.name);
    setPhase('extracting');
    setProgressMsg('Lecture du PDF…');
    try {
      const result = await extractTextFromPDF(file, (p: PDFExtractionProgress) => {
        setProgressMsg(`Extraction page ${p.page} / ${p.totalPages}…`);
      });
      if (result.text.length < 50) {
        throw new Error('Le PDF semble vide ou non textuel (peut-être scanné/image).');
      }
      setText(result.text);
      if (!title.trim()) {
        // Use file name without extension as default title
        setTitle(file.name.replace(/\.pdf$/i, '').slice(0, 60));
      }
      setProgressMsg(`${result.pageCount} pages lues${result.truncatedAt ? ' (texte tronqué à 12k caractères)' : ''}.`);
      setPhase('edit');
    } catch (e: any) {
      setError(e?.message || 'Impossible de lire ce PDF.');
      setPhase('edit');
    }
  }, [title]);

  const handleGenerate = useCallback(async () => {
    setError(null);
    if (!text.trim() || text.trim().length < 40) {
      setError('Saisis ou téléverse un contenu d\'au moins 40 caractères.');
      return;
    }
    if (!title.trim()) {
      setError('Donne un titre à ton cours.');
      return;
    }
    setPhase('generating');
    setProgressMsg('Connexion au moteur IA…');
    try {
      const resp = await fetch('/api/generate-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, numQuestions }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Serveur ${resp.status} : ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      if (data.error || !Array.isArray(data.questions) || data.questions.length === 0) {
        throw new Error(data.error || 'Aucune question générée par l\'IA.');
      }
      const normalized: Question[] = data.questions.map((q: any, i: number) => ({
        id: `gen_${Date.now()}_${i}`,
        subject: title.trim(),
        level: Number(level),
        question: String(q.question || ''),
        choices: Array.isArray(q.choices) ? q.choices.slice(0, 4).map(String) : [],
        correct: Number.isInteger(q.correct) ? q.correct : 0,
        explanation: String(q.explanation || ''),
        duration: Number.isFinite(q.duration) ? q.duration : 12,
        tags: Array.isArray(q.tags) ? q.tags.map(String) : [title.trim().toLowerCase()],
      })).filter(q => q.choices.length === 4 && q.question.length > 0);
      if (normalized.length === 0) {
        throw new Error('Les questions générées sont mal formées. Réessaye avec un texte plus riche.');
      }
      setGenerated(normalized);
      setProvider(data.provider || '');
      setPhase('review');
    } catch (e: any) {
      setError(e?.message || 'La génération IA a échoué.');
      setPhase('edit');
    }
  }, [text, title, level, numQuestions]);

  const handleValidate = useCallback(() => {
    if (generated.length === 0) return;
    const merged = [...existingQuestions, ...generated];
    onCreated(merged);
    setPhase('done');
  }, [generated, existingQuestions, onCreated]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[150] flex items-center justify-center p-4 backdrop-blur-md"
      style={{ backgroundColor: `${theme.bgDark}E6` }}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="w-full max-w-2xl rounded-3xl border-2 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
        style={{ backgroundColor: theme.bgPanel, borderColor: theme.primary }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: `${theme.border}60` }}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.primary}33`, color: theme.primaryLight }}>
              <Sparkles size={18} />
            </div>
            <div>
              <h2 className="text-lg font-mono font-black tracking-tight" style={{ color: theme.textMain }}>
                Créer un cours via IA
              </h2>
              <div className="text-[10px] font-mono opacity-60 uppercase tracking-widest" style={{ color: theme.textMuted }}>
                {phase === 'review' ? 'Étape 2 / 2 — Validation' : 'Étape 1 / 2 — Source du contenu'}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/5 transition-colors" style={{ color: theme.textMuted }}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <AnimatePresence mode="wait">
            {phase !== 'review' && phase !== 'done' && (
              <motion.div key="edit-phase" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-5">
                {/* Mode tabs */}
                <div className="flex gap-2 p-1 rounded-xl border w-fit" style={{ backgroundColor: theme.bgDark, borderColor: theme.border }}>
                  <button
                    onClick={() => setMode('text')}
                    className="px-4 py-1.5 rounded-lg text-xs font-mono font-bold uppercase tracking-wider transition-all flex items-center gap-2"
                    style={{
                      backgroundColor: mode === 'text' ? theme.primary : 'transparent',
                      color: mode === 'text' ? 'white' : theme.textMuted,
                    }}
                  >
                    <FileText size={13} /> Texte
                  </button>
                  <button
                    onClick={() => setMode('pdf')}
                    className="px-4 py-1.5 rounded-lg text-xs font-mono font-bold uppercase tracking-wider transition-all flex items-center gap-2"
                    style={{
                      backgroundColor: mode === 'pdf' ? theme.primary : 'transparent',
                      color: mode === 'pdf' ? 'white' : theme.textMuted,
                    }}
                  >
                    <Upload size={13} /> PDF
                  </button>
                </div>

                {/* Course title */}
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-widest mb-1 font-bold" style={{ color: theme.textMuted }}>
                    Titre du cours *
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="ex: Protocoles réseaux TCP/IP"
                    className="w-full p-3 rounded-lg border text-sm bg-[#090a16]/65 focus:outline-none"
                    style={{ borderColor: theme.border, color: theme.textMain }}
                    maxLength={60}
                  />
                </div>

                {/* PDF mode UI with drag & drop */}
                {mode === 'pdf' && (
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest mb-1 font-bold" style={{ color: theme.textMuted }}>
                      Fichier PDF
                    </label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="application/pdf,.pdf"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handlePDFUpload(file);
                      }}
                    />
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => phase !== 'extracting' && fileInputRef.current?.click()}
                      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && phase !== 'extracting') fileInputRef.current?.click(); }}
                      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={e => {
                        e.preventDefault();
                        setDragOver(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) handlePDFUpload(file);
                      }}
                      className={`w-full p-6 rounded-xl border-2 border-dashed flex flex-col items-center gap-2 transition-all ${phase === 'extracting' ? 'cursor-wait' : 'cursor-pointer hover:scale-[1.01]'} ${dragOver ? 'scale-[1.02]' : ''}`}
                      style={{
                        backgroundColor: dragOver ? `${theme.primary}33` : `${theme.bgDark}80`,
                        borderColor: dragOver ? theme.primary : (pdfFileName ? theme.accent1 : theme.border),
                        color: pdfFileName ? theme.accent1 : theme.textMuted,
                        boxShadow: dragOver ? `0 0 30px ${theme.primary}66` : 'none',
                      }}
                    >
                      {phase === 'extracting' ? (
                        <RefreshCw size={28} className="animate-spin" />
                      ) : pdfFileName ? (
                        <CheckCircle size={28} />
                      ) : (
                        <Upload size={28} />
                      )}
                      <div className="text-sm font-mono font-bold">
                        {dragOver ? 'Relâche pour téléverser' : pdfFileName || 'Glisse-dépose un PDF ici ou clique pour parcourir'}
                      </div>
                      {progressMsg && (
                        <div className="text-[11px] font-mono opacity-70">{progressMsg}</div>
                      )}
                      <div className="text-[10px] opacity-50 uppercase tracking-widest">≤ 20 Mo · texte extrait localement</div>
                    </div>
                  </div>
                )}

                {/* Text area (shows extracted PDF text or direct input) */}
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-widest mb-1 font-bold flex items-center gap-2" style={{ color: theme.textMuted }}>
                    Contenu du cours
                    {text && <span className="opacity-60 normal-case font-normal tracking-normal">({text.length.toLocaleString()} caractères)</span>}
                  </label>
                  <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder={mode === 'pdf' ? "Le texte extrait du PDF apparaîtra ici. Tu peux l'éditer avant la génération." : "Colle ici le texte de ton cours, tes notes ou un résumé. Min. 40 caractères."}
                    className="w-full h-40 p-3 rounded-lg border text-xs leading-relaxed bg-[#090a16]/65 focus:outline-none resize-none"
                    style={{ borderColor: theme.border, color: theme.textMain }}
                  />
                </div>

                {/* Level + Number of questions */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest mb-1 font-bold" style={{ color: theme.textMuted }}>
                      Difficulté
                    </label>
                    <select
                      value={level}
                      onChange={e => setLevel(Number(e.target.value))}
                      className="w-full p-3 rounded-lg border text-xs bg-[#090a16]/65 focus:outline-none cursor-pointer"
                      style={{ borderColor: theme.border, color: theme.textMain }}
                    >
                      <option value={1}>1 · Facile</option>
                      <option value={2}>2 · Moyen</option>
                      <option value={3}>3 · Difficile</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-widest mb-1 font-bold flex justify-between" style={{ color: theme.textMuted }}>
                      <span>Questions</span>
                      <span style={{ color: theme.accent1 }}>{numQuestions}</span>
                    </label>
                    <input
                      type="range" min={5} max={50} step={1}
                      value={numQuestions}
                      onChange={e => setNumQuestions(Number(e.target.value))}
                      className="w-full cursor-ew-resize mt-2"
                      style={{ accentColor: theme.primary }}
                    />
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-3 rounded-lg text-xs font-mono"
                       style={{ backgroundColor: `${theme.red}15`, color: theme.redBright, border: `1px solid ${theme.red}40` }}>
                    <AlertCircle size={14} className="shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </motion.div>
            )}

            {phase === 'generating' && (
              <motion.div key="generating-phase" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center py-12 gap-4">
                <Brain size={56} className="animate-pulse" style={{ color: theme.primaryLight }} />
                <div className="text-base font-mono font-bold" style={{ color: theme.textMain }}>L'IA génère tes questions…</div>
                <div className="text-xs font-mono opacity-70" style={{ color: theme.textMuted }}>{progressMsg}</div>
                <div className="text-[10px] font-mono opacity-50 mt-4">Mistral (primaire) → Groq (fallback)</div>
              </motion.div>
            )}

            {phase === 'review' && (
              <motion.div key="review-phase" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
                <div className="flex items-center gap-2 p-3 rounded-lg" style={{ backgroundColor: `${theme.green}15`, color: theme.green, border: `1px solid ${theme.green}40` }}>
                  <CheckCircle size={16} />
                  <div className="text-xs font-mono">
                    <strong>{generated.length} questions générées</strong>{provider && ` via ${provider}`}. Vérifie puis valide pour les ajouter à tes cours.
                  </div>
                </div>
                <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                  {generated.map((q, idx) => (
                    <div key={q.id} className="p-3 rounded-lg border text-xs space-y-2" style={{ backgroundColor: theme.bgDark, borderColor: theme.border }}>
                      <div className="flex justify-between items-start gap-2">
                        <span className="font-mono font-bold" style={{ color: theme.textMain }}>{idx + 1}. {q.question}</span>
                        <span className="text-[9px] font-mono opacity-60 whitespace-nowrap" style={{ color: theme.accent1 }}>N{q.level} · {q.duration}s</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        {q.choices.map((c, ci) => (
                          <div key={ci} className="px-2 py-1 rounded text-[11px] font-mono" style={{
                            backgroundColor: ci === q.correct ? `${theme.green}22` : 'transparent',
                            color: ci === q.correct ? theme.green : theme.textMuted,
                            border: ci === q.correct ? `1px solid ${theme.green}66` : `1px solid ${theme.border}40`,
                          }}>
                            {String.fromCharCode(65 + ci)}) {c}
                          </div>
                        ))}
                      </div>
                      {q.explanation && (
                        <div className="text-[11px] italic opacity-80" style={{ color: theme.textMuted }}>💡 {q.explanation}</div>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {phase === 'done' && (
              <motion.div key="done-phase" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-10 space-y-4">
                <motion.div
                  initial={{ scale: 0.6, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 18 }}
                  className="inline-block"
                >
                  <CheckCircle size={64} style={{ color: theme.green }} className="mx-auto" />
                </motion.div>
                <div className="text-xl font-mono font-bold" style={{ color: theme.textMain }}>Cours ajouté !</div>
                <div className="text-xs font-mono opacity-70 max-w-sm mx-auto" style={{ color: theme.textMuted }}>
                  <strong>{title}</strong> · {generated.length} questions · disponible dans <em>Mes cours</em>.
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer actions */}
        <div className="border-t px-6 py-4 flex justify-end gap-2" style={{ borderColor: `${theme.border}60` }}>
          {phase === 'edit' && (
            <>
              <button onClick={onClose} className="px-4 py-2 rounded-lg border text-xs font-mono uppercase tracking-wider hover:bg-white/5 transition-colors" style={{ borderColor: theme.border, color: theme.textMuted }}>
                Annuler
              </button>
              <button
                onClick={handleGenerate}
                disabled={!text.trim() || !title.trim() || (text.trim().length < 40)}
                className="px-5 py-2 rounded-lg text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-2 transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                style={{ backgroundColor: theme.primary, color: 'white', boxShadow: `0 4px 12px ${theme.primary}66` }}
              >
                <Cpu size={14} /> Générer avec l'IA
              </button>
            </>
          )}
          {phase === 'review' && (
            <>
              <button onClick={() => { setPhase('edit'); setGenerated([]); }} className="px-4 py-2 rounded-lg border text-xs font-mono uppercase tracking-wider hover:bg-white/5 transition-colors" style={{ borderColor: theme.border, color: theme.textMuted }}>
                Retour / Régénérer
              </button>
              <button
                onClick={handleValidate}
                className="px-5 py-2 rounded-lg text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-2 transition-all hover:scale-105"
                style={{ backgroundColor: theme.green, color: 'white', boxShadow: `0 4px 12px ${theme.green}66` }}
              >
                <CheckCircle size={14} /> Valider et ajouter
              </button>
            </>
          )}
          {phase === 'done' && (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border text-xs font-mono uppercase tracking-wider hover:bg-white/5 transition-colors"
                style={{ borderColor: theme.border, color: theme.textMuted }}
              >
                Retour aux cours
              </button>
              {onPlayNow && (
                <button
                  onClick={() => { onPlayNow(generated); onClose(); }}
                  className="px-5 py-2 rounded-lg text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-2 transition-all hover:scale-105"
                  style={{ backgroundColor: theme.accent1, color: theme.bgDark, boxShadow: `0 4px 14px ${theme.accent1}66` }}
                >
                  <Play size={14} /> Jouer ce cours
                </button>
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
