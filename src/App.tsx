/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { GameMode, THEMES, ThemeColors, Question, WALL_HEIGHT, TILE_SIZE, engineModeFromGameMode, chapterForLevel, isBossLevel, chapterForWave, isBossWave, waveConfigForWave, PICKUP_CONFIGS, PickupType, AllModeStats, emptyAllStats, emptyModeStats, ACHIEVEMENTS, AchievementSnapshot } from './types';
import { DEMO_QUESTIONS, COURSE_META } from './data/demo';
import { AudioEngine } from './game/Audio';
import { ThreeEngine } from './game/ThreeEngine';
import { Maze } from './game/Maze';
import { AdaptiveAI, updateSRS } from './game/AdaptiveAI';
import { QuizOverlay } from './components/QuizOverlay';
import { CourseCreator } from './components/CourseCreator';
import { extractTextFromPDF } from './lib/pdfExtractor';
import {
  Play, Settings, UserPlus, BookOpen, ChevronRight, Key, Zap,
  Shield, Target, Clock, Brain, Cpu, Trophy, RotateCcw, Palette, Volume2, VolumeX,
  Plus, Trash2, Edit3, FileText, Sparkles, Download, Upload, X, CheckCircle,
  AlertCircle, RefreshCw, BarChart2, HelpCircle, Pause, Eye, EyeOff, Loader2
} from 'lucide-react';
import { useIsTouchDevice } from './lib/useIsTouchDevice';
import { useApiKeys, getUserApiKeys } from './lib/useApiKeys';

const THEME_STORAGE_KEY = 'neurolock_theme';
const TUTORIAL_STORAGE_KEY = 'neurolock_tutorial_done';
const STATS_STORAGE_KEY = 'neurolock_stats';
const ACHIEVEMENTS_STORAGE_KEY = 'neurolock_achievements';

function loadStats(): AllModeStats {
  try {
    const raw = localStorage.getItem(STATS_STORAGE_KEY);
    if (!raw) return emptyAllStats();
    const parsed = JSON.parse(raw);
    // Defensive merge so adding fields doesn't break loads
    const merged = emptyAllStats();
    for (const k of Object.keys(merged) as (keyof AllModeStats)[]) {
      merged[k] = { ...merged[k], ...(parsed?.[k] || {}) };
    }
    return merged;
  } catch { return emptyAllStats(); }
}

function saveStats(s: AllModeStats) {
  try { localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(s)); } catch {}
}

function loadUnlockedAchievements(): Set<string> {
  try {
    const raw = localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    const items: string[] = Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : [];
    return new Set<string>(items);
  } catch { return new Set<string>(); }
}

function saveUnlockedAchievements(set: Set<string>) {
  try { localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify([...set])); } catch {}
}

const CAMERA_LABEL = {
  follow: 'SUIVI',
  top: 'DESSUS',
  tactical: 'TACTIQUE',
  bird: 'ISO',
  cinematic: 'CINÉ',
} as const;
const HISTORY_STORAGE_KEY = 'neurolock_history';
const HISTORY_MAX = 500; // keep last N answers for stats

type StoredAnswer = { questionId: string; subject: string; level: number; wasCorrect: boolean; time: number; at: number };

function loadHistory(): StoredAnswer[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendHistory(entry: StoredAnswer) {
  try {
    const next = [...loadHistory(), entry].slice(-HISTORY_MAX);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

export default function App() {
  const [mode, setMode] = useState<GameMode>(GameMode.MENU);
  // When the user picks SURVIE or DEFENSE in the menu, we route through COURSE_SELECT
  // and remember which game mode to launch next.
  const [pendingMode, setPendingMode] = useState<GameMode>(GameMode.SURVIVAL);
  const [currentSubject, setCurrentSubject] = useState<string>('');
  const [questions, setQuestions] = useState<Question[]>(() => {
    try {
      const stored = localStorage.getItem('neurolock_custom_questions');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error("Failed to load custom questions", e);
    }
    return DEMO_QUESTIONS;
  });

  const handleUpdateQuestions = (newQuestions: Question[]) => {
    setQuestions(newQuestions);
    try {
      localStorage.setItem('neurolock_custom_questions', JSON.stringify(newQuestions));
    } catch (e) {
      console.error("Failed to save custom questions", e);
    }
  };
  const [themeKey, setThemeKeyState] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored && THEMES[stored]) return stored;
    } catch {}
    return 'cyber';
  });
  const setThemeKey = (k: string) => {
    setThemeKeyState(k);
    try { localStorage.setItem(THEME_STORAGE_KEY, k); } catch {}
  };
  const [isMuted, setIsMuted] = useState(() => AudioEngine.getMuted());
  const [showTutorial, setShowTutorial] = useState<boolean>(() => {
    try { return localStorage.getItem(TUTORIAL_STORAGE_KEY) !== '1'; } catch { return false; }
  });
  const closeTutorial = () => {
    try { localStorage.setItem(TUTORIAL_STORAGE_KEY, '1'); } catch {}
    setShowTutorial(false);
  };
  const resetTutorial = () => {
    try { localStorage.removeItem(TUTORIAL_STORAGE_KEY); } catch {}
    setShowTutorial(true);
  };
  const [highScore, setHighScore] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('neurolock_highscore') || '0');
    } catch {
      return 0;
    }
  });
  const [stats, setStats] = useState<AllModeStats>(() => loadStats());
  const [unlockedAchievements, setUnlockedAchievements] = useState<Set<string>>(() => loadUnlockedAchievements());
  const [achievementToast, setAchievementToast] = useState<typeof ACHIEVEMENTS[number] | null>(null);

  const updateStatsAndAchievements = (runSummary: {
    mode: GameMode;
    score: number;
    progression: number; // level or wave
    kills: number;
    questionsAnswered: number;
    questionsCorrect: number;
    bestCombo: number;
    accuracy: number; // 0..1
  }) => {
    const modeKey: keyof AllModeStats =
      runSummary.mode === GameMode.SURVIVAL ? 'survival' :
      runSummary.mode === GameMode.TOWER_DEFENSE ? 'tower_defense' :
      runSummary.mode === GameMode.SPRINT ? 'sprint' :
      runSummary.mode === GameMode.HEART_DEFENSE ? 'heart_defense' : 'survival';

    const next: AllModeStats = { ...stats };
    const cur = next[modeKey] ?? emptyModeStats();
    next[modeKey] = {
      bestScore: Math.max(cur.bestScore, runSummary.score),
      bestProgression: Math.max(cur.bestProgression, runSummary.progression),
      totalRuns: cur.totalRuns + 1,
      totalKills: cur.totalKills + runSummary.kills,
      totalQuestionsAnswered: cur.totalQuestionsAnswered + runSummary.questionsAnswered,
      totalQuestionsCorrect: cur.totalQuestionsCorrect + runSummary.questionsCorrect,
    };
    setStats(next);
    saveStats(next);

    // Achievement check
    const snapshot: AchievementSnapshot = {
      stats: next,
      lastRun: {
        mode: engineModeFromGameMode(runSummary.mode),
        score: runSummary.score,
        progression: runSummary.progression,
        kills: runSummary.kills,
        bestCombo: runSummary.bestCombo,
        accuracy: runSummary.accuracy,
      },
    };
    const newlyUnlocked = ACHIEVEMENTS.filter(a => !unlockedAchievements.has(a.id) && a.check(snapshot));
    if (newlyUnlocked.length > 0) {
      const updated = new Set<string>(unlockedAchievements);
      newlyUnlocked.forEach(a => updated.add(a.id));
      setUnlockedAchievements(updated);
      saveUnlockedAchievements(updated);
      // Show toasts one at a time
      setAchievementToast(newlyUnlocked[0]);
      newlyUnlocked.slice(1).forEach((a, i) => {
        window.setTimeout(() => setAchievementToast(a), (i + 1) * 3000);
      });
    }
  };

  const theme = THEMES[themeKey];

  const startGame = (newMode: GameMode) => {
    AudioEngine.init();
    AudioEngine.playClick();
    // Both gameplay modes route through the course selector for consistency.
    if (newMode === GameMode.SURVIVAL || newMode === GameMode.TOWER_DEFENSE || newMode === GameMode.SPRINT || newMode === GameMode.HEART_DEFENSE) {
      setPendingMode(newMode);
      setMode(GameMode.COURSE_SELECT);
    } else {
      setMode(newMode);
    }
  };

  const handleToggleMute = () => {
    AudioEngine.init();
    const newMuted = AudioEngine.toggleMute();
    setIsMuted(newMuted);
  };

  const handleNewScore = (score: number) => {
    if (score > highScore) {
      setHighScore(score);
      try {
        localStorage.setItem('neurolock_highscore', String(score));
      } catch (e) {
        console.error(e);
      }
    }
  };

  return (
    <div className="min-h-screen font-sans selection:bg-white/20 relative" style={{ backgroundColor: theme.bgDark, color: theme.textMain }}>
      {/* Universal Floating Controls */}
      <div className="absolute top-6 right-6 z-[120] flex gap-4 pointer-events-auto">
        <button 
          onClick={handleToggleMute}
          className="p-3 rounded-xl border backdrop-blur-xl transition-all duration-300 hover:scale-110 flex items-center justify-center shadow-lg"
          style={{ 
            backgroundColor: `${theme.bgPanel}B3`, 
            borderColor: theme.border, 
            color: isMuted ? theme.red : theme.primaryLight,
            boxShadow: `0 0 15px ${isMuted ? theme.red : theme.primary}22`
          }}
          title={isMuted ? "Réactiver le son" : "Couper le son"}
        >
          {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </button>
      </div>

      <AnimatePresence mode="wait">
        {mode === GameMode.MENU && (
          <MenuScreen onStart={startGame} theme={theme} highScore={highScore} stats={stats} />
        )}
        {mode === GameMode.COURSE_SELECT && (
          <CourseSelectScreen
            onBack={() => setMode(GameMode.MENU)}
            onStart={(q, target) => {
              setQuestions(q);
              // Use the dominant subject of the picked set as the HUD label
              const counts = q.reduce<Record<string, number>>((acc, x) => { acc[x.subject] = (acc[x.subject] || 0) + 1; return acc; }, {});
              const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
              setCurrentSubject(dominant);
              setMode(target);
            }}
            target={pendingMode}
            theme={theme}
            questions={questions}
            onUpdateQuestions={handleUpdateQuestions}
          />
        )}
        {(mode === GameMode.SURVIVAL || mode === GameMode.TOWER_DEFENSE || mode === GameMode.SPRINT || mode === GameMode.HEART_DEFENSE) && (
          <GameScreen mode={mode} questions={questions} subjectLabel={currentSubject} theme={theme} highScore={highScore} onNewScore={handleNewScore} onExit={() => setMode(GameMode.MENU)} onRunComplete={updateStatsAndAchievements} />
        )}
        {mode === GameMode.SETTINGS && (
           <SettingsScreen
            onBack={() => setMode(GameMode.MENU)}
            themeKey={themeKey}
            setThemeKey={setThemeKey}
            theme={theme}
            onResetTutorial={resetTutorial}
           />
        )}
        {mode === GameMode.TEACHER && (
           <TeacherScreen 
             onBack={() => setMode(GameMode.MENU)} 
             theme={theme} 
             questions={questions}
             onUpdateQuestions={handleUpdateQuestions}
           />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showTutorial && mode === GameMode.MENU && (
          <TutorialOverlay theme={theme} onClose={closeTutorial} />
        )}
      </AnimatePresence>

      <AchievementToast achievement={achievementToast} theme={theme} onClose={() => setAchievementToast(null)} />
    </div>
  );
}

function AchievementToast({ achievement, theme, onClose }: { achievement: typeof ACHIEVEMENTS[number] | null; theme: ThemeColors; onClose: () => void }) {
  useEffect(() => {
    if (!achievement) return;
    const t = window.setTimeout(onClose, 3200);
    return () => window.clearTimeout(t);
  }, [achievement, onClose]);

  return (
    <AnimatePresence>
      {achievement && (
        <motion.div
          initial={{ x: 360, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 360, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 24 }}
          className="fixed top-24 right-6 z-[180] max-w-sm pointer-events-auto"
        >
          <div className="flex items-center gap-3 p-4 rounded-2xl border-2 backdrop-blur-xl shadow-lg"
               style={{ backgroundColor: `${theme.bgPanel}F2`, borderColor: theme.amber, boxShadow: `0 0 30px ${theme.amber}66` }}>
            <div className="text-3xl">{achievement.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-widest font-bold mb-0.5" style={{ color: theme.amber }}>
                Haut fait débloqué
              </div>
              <div className="text-sm font-bold truncate" style={{ color: theme.textMain }}>
                {achievement.name}
              </div>
              <div className="text-[11px] truncate" style={{ color: theme.textMuted }}>
                {achievement.description}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TutorialOverlay({ theme, onClose }: { theme: ThemeColors; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const isTouch = useIsTouchDevice();
  const steps: { title: string; body: string; keys: string[] }[] = isTouch ? [
    {
      title: 'BIENVENUE',
      body: "Tu es un agent infiltré dans un labyrinthe neural. Chaque porte verrouillée cache une question : ta connaissance du cours est ton arme.",
      keys: [],
    },
    {
      title: 'BOUGER',
      body: "Pose ton pouce n'importe où sur la moitié gauche de l'écran : un joystick apparaît sous ton doigt. Glisse pour te déplacer dans la direction voulue.",
      keys: ['👆 ← moitié gauche'],
    },
    {
      title: 'TIRER',
      body: "Appuie sur le bouton ⚡ en bas à droite. Maintiens pour tirer en continu sur l'ennemi le plus proche. Tu commences avec 12 munitions.",
      keys: ['⚡'],
    },
    {
      title: 'PORTES & SOCLES',
      body: "Approche une porte rouge → un QCM s'ouvre. Touche les boutons A/B/C/D. Marche sur un socle violet et touche 🛠 pour bâtir une tour défensive.",
      keys: ['A-D', '🛠'],
    },
    {
      title: 'RÉCOMPENSES',
      body: "Bonne réponse = +6 munitions, +10 s timer, +points. Réponses consécutives = combo ×2, ×3, ×4. Touche ⏸ pour mettre en pause.",
      keys: ['⏸', '📷'],
    },
  ] : [
    {
      title: 'BIENVENUE',
      body: "Tu es un agent infiltré dans un labyrinthe neural. Chaque porte verrouillée cache une question : ta connaissance du cours est ton arme.",
      keys: [],
    },
    {
      title: 'BOUGER',
      body: "Déplace-toi avec ZQSD ou les flèches directionnelles. Le joueur glisse le long des murs — pas besoin de viser parfaitement.",
      keys: ['Z', 'Q', 'S', 'D'],
    },
    {
      title: 'TIRER',
      body: "Espace ou clic gauche tire un projectile auto-ciblé sur l'ennemi le plus proche. Tu commences avec 12 munitions.",
      keys: ['ESPACE', 'CLIC'],
    },
    {
      title: 'PORTES & SOCLES',
      body: "Approche une porte rouge → un QCM s'ouvre. Réponds avec 1/2/3/4 ou A/B/C/D. Marche sur un socle violet, presse E pour bâtir une tour défensive.",
      keys: ['1-4', 'A-D', 'E'],
    },
    {
      title: 'RÉCOMPENSES',
      body: "Bonne réponse = +6 munitions, +10 s timer, +points. Réponses consécutives = combo ×2, ×3, ×4. Pause à tout moment avec Échap.",
      keys: ['ESC'],
    },
  ];

  const current = steps[step];
  const isLast = step === steps.length - 1;

  const next = () => isLast ? onClose() : setStep(s => s + 1);
  const prev = () => setStep(s => Math.max(0, s - 1));

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] flex items-center justify-center backdrop-blur-md p-6"
      style={{ backgroundColor: `${theme.bgDark}F0` }}
    >
      <motion.div
        key={step}
        initial={{ scale: 0.95, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="max-w-lg w-full p-8 rounded-3xl border-2 backdrop-blur-xl"
        style={{ backgroundColor: theme.bgPanel, borderColor: theme.primary, boxShadow: `0 0 60px ${theme.primary}55` }}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] font-mono uppercase tracking-[0.4em]" style={{ color: theme.textMuted }}>
            DIDACTICIEL · {step + 1}/{steps.length}
          </div>
          <button onClick={onClose} className="text-[10px] font-mono uppercase tracking-wider hover:text-white transition-colors" style={{ color: theme.textMuted }}>
            Passer ✕
          </button>
        </div>

        <h2 className="text-4xl font-mono font-black tracking-tighter mt-2 mb-4" style={{ color: theme.primaryLight, textShadow: `0 0 20px ${theme.primary}66` }}>
          {current.title}
        </h2>

        <p className="text-sm leading-relaxed mb-6" style={{ color: theme.textMain }}>
          {current.body}
        </p>

        {current.keys.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            {current.keys.map(k => (
              <kbd key={k} className="px-3 py-1.5 text-xs font-mono font-bold rounded-lg border-2"
                   style={{ backgroundColor: `${theme.primary}22`, borderColor: theme.primary, color: theme.primaryLight }}>
                {k}
              </kbd>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2 border-t" style={{ borderColor: `${theme.border}60` }}>
          <div className="flex gap-1">
            {steps.map((_, i) => (
              <div key={i} className="h-1.5 rounded-full transition-all"
                   style={{ width: i === step ? 24 : 8, backgroundColor: i <= step ? theme.primary : theme.border }} />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <button onClick={prev} className="px-4 py-2 text-xs font-mono uppercase tracking-wider rounded-lg border hover:bg-white/5 transition-colors"
                      style={{ borderColor: theme.border, color: theme.textMain }}>
                Précédent
              </button>
            )}
            <button onClick={next}
                    className="px-5 py-2 text-xs font-mono font-bold uppercase tracking-wider rounded-lg text-white transition-transform hover:scale-105"
                    style={{ backgroundColor: theme.primary, boxShadow: `0 4px 14px ${theme.primary}66` }}>
              {isLast ? 'COMMENCER' : 'SUIVANT'}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function TeacherScreen({
  onBack, 
  theme, 
  questions, 
  onUpdateQuestions 
}: { 
  onBack: () => void; 
  theme: ThemeColors; 
  questions: Question[]; 
  onUpdateQuestions: (q: Question[]) => void; 
}) {
  const [tab, setTab] = useState<'ia' | 'qcm' | 'stats'>('ia');

  // AI Generator state
  const [courseText, setCourseText] = useState('');
  const [inputMode, setInputMode] = useState<'text' | 'pdf'>('text');
  const [pdfFileName, setPdfFileName] = useState<string>('');
  const [pdfProgress, setPdfProgress] = useState<string>('');
  const [pdfExtracting, setPdfExtracting] = useState(false);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const handleTeacherPDFUpload = async (file: File) => {
    setErrorMsg(null);
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMsg('Le fichier doit être un PDF (.pdf).');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg('Fichier trop volumineux (limite 20 Mo).');
      return;
    }
    setPdfFileName(file.name);
    setPdfExtracting(true);
    setPdfProgress('Lecture du PDF…');
    try {
      const result = await extractTextFromPDF(file, p => setPdfProgress(`Extraction page ${p.page} / ${p.totalPages}…`));
      if (result.text.length < 50) {
        throw new Error('PDF vide ou non textuel (peut-être scanné).');
      }
      setCourseText(result.text);
      if (!subjectTitle.trim()) {
        setSubjectTitle(file.name.replace(/\.pdf$/i, '').slice(0, 60));
      }
      setPdfProgress(`${result.pageCount} pages lues${result.truncatedAt ? ' (tronqué à 12k caractères)' : ''}.`);
    } catch (e: any) {
      setErrorMsg(e?.message || 'Impossible de lire ce PDF.');
      setPdfFileName('');
    } finally {
      setPdfExtracting(false);
    }
  };
  const [subjectTitle, setSubjectTitle] = useState('');
  const [numQuestions, setNumQuestions] = useState(10);
  const [level, setLevel] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [genLogs, setGenLogs] = useState<string[]>([]);
  const [iaResponse, setIaResponse] = useState<Question[] | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Manual QCM Editor state
  const [filterSubject, setFilterSubject] = useState('tous');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [qText, setQText] = useState('');
  const [qSubject, setQSubject] = useState('');
  const [qLevel, setQLevel] = useState(1);
  const [qChoices, setQChoices] = useState(['', '', '', '']);
  const [qCorrect, setQCorrect] = useState(0);
  const [qExplanation, setQExplanation] = useState('');
  const [qDuration, setQDuration] = useState(10);

  // Subject options
  const existingSubjects = React.useMemo(() => {
    return Array.from(new Set(questions.map(q => q.subject)));
  }, [questions]);

  // AI generator logger simulation
  const triggerAIGeneration = async () => {
    if (!courseText.trim()) {
      setErrorMsg('Veuillez saisir ou coller le contenu de votre cours pour continuer.');
      return;
    }
    setErrorMsg(null);
    setSuccessMsg(null);
    setGenerating(true);
    setGenLogs(["Initialisation de la liaison sécurisée Neurolock Core..."]);
    setIaResponse(null);

    const logSteps = [
      "Fichier volumineux détecté. Analyse syntaxique préliminaire...",
      "Connexion au réseau neuronal Gemini-3.5-Flash établie.",
      "Extraction sémantique du texte de cours (analyse conceptuelle)...",
      "Élaboration des questions pédagogiques interactives...",
      "Génération d'options de distraction plausibles (distracteurs)...",
      "Génération des explications didactiques...",
      "Finalisation du schéma sécurisé de niveau QCM..."
    ];

    let logIdx = 0;
    const logInterval = setInterval(() => {
      if (logIdx < logSteps.length) {
        setGenLogs(prev => [...prev, logSteps[logIdx]]);
        logIdx++;
      } else {
        clearInterval(logInterval);
      }
    }, 700);

    try {
      const resp = await fetch('/api/generate-questions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: courseText,
          numQuestions: numQuestions,
          userKeys: getUserApiKeys(),
        })
      });

      if (!resp.ok) {
        throw new Error(`Le serveur a retourné une erreur (Code: ${resp.status})`);
      }

      const data = await resp.json();
      clearInterval(logInterval);

      if (data.error) {
        throw new Error(data.error);
      }

      if (data.questions && data.questions.length > 0) {
        // Apply custom subject title if specified
        let generated: Question[] = data.questions.map((q: any, i: number) => ({
          ...q,
          id: `gen_${Date.now()}_${i}`,
          subject: subjectTitle.trim() || q.subject || "Cours Généré",
          level: Number(level)
        }));

        setIaResponse(generated);
        setGenLogs(prev => [...prev, "✨ COMPACTEUR DE SÉRIE COMPLÉTÉ AVEC SUCCÈS !"]);
      } else {
        throw new Error("Aucune question n'a été retournée par l'IA.");
      }
    } catch (e: any) {
      clearInterval(logInterval);
      setErrorMsg(e.message || "Impossible de joindre le service de génération IA. Vérifiez que votre serveur fonctionne.");
      setGenerating(false);
    }
  };

  const handleApplyGenerated = () => {
    if (!iaResponse) return;
    const updated = [...questions, ...iaResponse];
    onUpdateQuestions(updated);
    setSuccessMsg(`Félicitations ! ${iaResponse.length} questions Neurolock ont été fusionnées dans votre base locale.`);
    setIaResponse(null);
    setCourseText('');
    setSubjectTitle('');
    setGenerating(false);
  };

  // Delete question
  const handleDeleteQ = (id: string) => {
    const updated = questions.filter(q => q.id !== id);
    onUpdateQuestions(updated);
  };

  // Edit / Add form submission
  const handleOpenNewForm = () => {
    setEditingId(null);
    setQText('');
    setQSubject(existingSubjects[0] || 'Général');
    setQLevel(1);
    setQChoices(['', '', '', '']);
    setQCorrect(0);
    setQExplanation('');
    setQDuration(12);
    setIsFormOpen(true);
  };

  const handleOpenEditForm = (q: Question) => {
    setEditingId(q.id);
    setQText(q.question);
    setQSubject(q.subject);
    setQLevel(q.level);
    setQChoices([...q.choices]);
    setQCorrect(q.correct);
    setQExplanation(q.explanation);
    setQDuration(q.duration);
    setIsFormOpen(true);
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!qText.trim() || !qSubject.trim()) return;
    if (qChoices.some(c => !c.trim())) {
      alert('Veuillez remplir les 4 choix de réponse.');
      return;
    }

    if (editingId) {
      // Update
      const updated = questions.map(q => {
        if (q.id === editingId) {
          return {
            id: editingId,
            subject: qSubject.trim(),
            level: Number(qLevel),
            question: qText.trim(),
            choices: [...qChoices],
            correct: qCorrect,
            explanation: qExplanation.trim(),
            duration: Number(qDuration),
            tags: [qSubject.trim().toLowerCase()]
          };
        }
        return q;
      });
      onUpdateQuestions(updated);
    } else {
      // Create new
      const newQ: Question = {
        id: `man_${Date.now()}`,
        subject: qSubject.trim(),
        level: Number(qLevel),
        question: qText.trim(),
        choices: [...qChoices],
        correct: qCorrect,
        explanation: qExplanation.trim(),
        duration: Number(qDuration),
        tags: [qSubject.trim().toLowerCase()]
      };
      onUpdateQuestions([...questions, newQ]);
    }

    setIsFormOpen(false);
  };

  const handleChoiceChange = (idx: number, val: string) => {
    const updated = [...qChoices];
    updated[idx] = val;
    setQChoices(updated);
  };

  // Export questions
  const handleExportQuestions = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(questions, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href",     dataStr     );
    dlAnchorElem.setAttribute("download", "neurolock_export_questions.json");
    dlAnchorElem.click();
  };

  const filteredQList = questions.filter(q => {
    if (filterSubject === 'tous') return true;
    return q.subject === filterSubject;
  });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-screen p-8 flex flex-col items-center w-full">
      <div className="w-full max-w-5xl">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-10 w-full">
          <button onClick={onBack} className="hover:text-white flex items-center gap-2 cursor-pointer font-mono text-xs" style={{ color: theme.textMuted }}>
             <ChevronRight className="rotate-180" size={16} /> RETOUR AU MENU PRINCIPAL
          </button>
          
          <div className="inline-flex gap-2 p-1 rounded-xl border" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
            <button 
              onClick={() => { setTab('ia'); setErrorMsg(null); setSuccessMsg(null); }}
              className={`px-5 py-2 rounded-lg text-xs font-mono font-bold cursor-pointer transition-all ${tab === 'ia' ? 'text-white' : 'hover:bg-white/5'}`}
              style={{ backgroundColor: tab === 'ia' ? theme.primary : 'transparent', color: tab === 'ia' ? 'white' : theme.textMuted }}
            >
              🤖 CONFIGURATEUR IA
            </button>
            <button 
              onClick={() => { setTab('qcm'); setErrorMsg(null); setSuccessMsg(null); }}
              className={`px-5 py-2 rounded-lg text-xs font-mono font-bold cursor-pointer transition-all ${tab === 'qcm' ? 'text-white' : 'hover:bg-white/5'}`}
              style={{ backgroundColor: tab === 'qcm' ? theme.primary : 'transparent', color: tab === 'qcm' ? 'white' : theme.textMuted }}
            >
              📝 COMPILATEUR MANUEL ({questions.length})
            </button>
            <button 
              onClick={() => { setTab('stats'); setErrorMsg(null); setSuccessMsg(null); }}
              className={`px-5 py-2 rounded-lg text-xs font-mono font-bold cursor-pointer transition-all ${tab === 'stats' ? 'text-white' : 'hover:bg-white/5'}`}
              style={{ backgroundColor: tab === 'stats' ? theme.primary : 'transparent', color: tab === 'stats' ? 'white' : theme.textMuted }}
            >
              📊 ANALYSES & RAPPORTS
            </button>
          </div>
        </div>

        <h2 className="text-4xl font-mono font-bold mb-2 flex items-center gap-3">
          <span style={{ color: theme.primaryLight }}>CONSOLE</span> 
          <span style={{ color: theme.accent1 }}>ENSEIGNANT</span>
        </h2>
        <p className="text-xs font-mono mb-10 border-b pb-4 uppercase tracking-wider" style={{ color: theme.textMuted, borderColor: `${theme.border}40` }}>
          Gérez vos évaluations hybrides, intégrez vos cours par IA et observez les résultats.
        </p>

        <AnimatePresence mode="wait">
          {tab === 'ia' && (
            <motion.div key="ia-workspace" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              
              {/* Parameter form */}
              <div className="lg:col-span-7 flex flex-col gap-6">
                <div className="p-6 rounded-2xl border" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
                  <h3 className="text-lg font-bold mb-2 flex items-center gap-2" style={{ color: theme.primaryLight }}>
                    <Sparkles size={18} /> INTÉGRATION DE COURS PAR IA
                  </h3>
                  <p className="text-xs mb-6" style={{ color: theme.textMuted }}>
                    Collez le texte brut de votre cours, diapositives, ou définissez vos thèmes clés. Notre moteur IA va concevoir un QCM personnalisé.
                  </p>

                  <div className="space-y-4">
                    {/* Texte / PDF toggle */}
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-mono font-bold uppercase" style={{ color: theme.textMain }}>Source du contenu</label>
                      <div className="flex gap-1 p-1 rounded-lg border" style={{ backgroundColor: theme.bgDark, borderColor: theme.border }}>
                        <button
                          onClick={() => setInputMode('text')}
                          className="px-3 py-1 rounded text-[10px] font-mono font-bold uppercase tracking-wider transition-all flex items-center gap-1.5"
                          style={{ backgroundColor: inputMode === 'text' ? theme.primary : 'transparent', color: inputMode === 'text' ? 'white' : theme.textMuted }}
                        >
                          <FileText size={11} /> Texte
                        </button>
                        <button
                          onClick={() => setInputMode('pdf')}
                          className="px-3 py-1 rounded text-[10px] font-mono font-bold uppercase tracking-wider transition-all flex items-center gap-1.5"
                          style={{ backgroundColor: inputMode === 'pdf' ? theme.primary : 'transparent', color: inputMode === 'pdf' ? 'white' : theme.textMuted }}
                        >
                          <Upload size={11} /> PDF
                        </button>
                      </div>
                    </div>

                    {/* PDF drag-drop zone */}
                    {inputMode === 'pdf' && (
                      <div>
                        <input
                          ref={pdfInputRef}
                          type="file"
                          accept="application/pdf,.pdf"
                          className="hidden"
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleTeacherPDFUpload(f); }}
                        />
                        <div
                          role="button" tabIndex={0}
                          onClick={() => !pdfExtracting && pdfInputRef.current?.click()}
                          onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !pdfExtracting) pdfInputRef.current?.click(); }}
                          onDragOver={e => { e.preventDefault(); setPdfDragOver(true); }}
                          onDragLeave={() => setPdfDragOver(false)}
                          onDrop={e => { e.preventDefault(); setPdfDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleTeacherPDFUpload(f); }}
                          className={`w-full p-5 rounded-xl border-2 border-dashed flex flex-col items-center gap-2 transition-all ${pdfExtracting ? 'cursor-wait' : 'cursor-pointer hover:scale-[1.01]'} ${pdfDragOver ? 'scale-[1.02]' : ''}`}
                          style={{
                            backgroundColor: pdfDragOver ? `${theme.primary}33` : `${theme.bgDark}80`,
                            borderColor: pdfDragOver ? theme.primary : (pdfFileName ? theme.accent1 : theme.border),
                            color: pdfFileName ? theme.accent1 : theme.textMuted,
                            boxShadow: pdfDragOver ? `0 0 30px ${theme.primary}66` : 'none',
                          }}
                        >
                          {pdfExtracting ? <RefreshCw size={26} className="animate-spin" /> : pdfFileName ? <CheckCircle size={26} /> : <Upload size={26} />}
                          <div className="text-xs font-mono font-bold text-center">
                            {pdfDragOver ? 'Relâche pour téléverser' : pdfFileName || 'Glisse-dépose un PDF ou clique pour parcourir'}
                          </div>
                          {pdfProgress && <div className="text-[10px] font-mono opacity-70">{pdfProgress}</div>}
                          <div className="text-[9px] opacity-50 uppercase tracking-widest">≤ 20 Mo · extraction locale</div>
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-mono font-bold uppercase mb-2 flex items-center gap-2" style={{ color: theme.textMain }}>
                        {inputMode === 'pdf' ? 'Texte extrait (modifiable)' : 'Contenu du cours / Notes pédagogiques'}
                        {courseText && <span className="text-[10px] font-normal opacity-60 normal-case tracking-normal">({courseText.length.toLocaleString()} caractères)</span>}
                      </label>
                      <textarea
                        className="w-full h-48 p-4 rounded-xl border text-xs text-white focus:outline-none focus:ring-1 bg-[#090a16]/65"
                        style={{ borderColor: theme.border }}
                        placeholder={inputMode === 'pdf'
                          ? "Le texte extrait du PDF s'affichera ici. Tu peux le retoucher avant la génération."
                          : "Ex: Le protocole IP fonctionne au niveau de la couche Réseau du modèle OSI. Il permet l'adressage unique et le routage des paquets. L'adresse IPv4 est codée sur 32 bits…"}
                        value={courseText}
                        onChange={(e) => setCourseText(e.target.value)}
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-mono font-bold uppercase mb-2" style={{ color: theme.textMain }}>Sujet / Thématique</label>
                        <input 
                          type="text" 
                          placeholder="Ex: Protocole IP (Optionnel)"
                          className="w-full p-3 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none"
                          style={{ borderColor: theme.border }}
                          value={subjectTitle}
                          onChange={(e) => setSubjectTitle(e.target.value)}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-mono font-bold uppercase mb-2" style={{ color: theme.textMain }}>Difficulté du Module</label>
                        <select 
                          className="w-full p-3 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none cursor-pointer"
                          style={{ borderColor: theme.border }}
                          value={level}
                          onChange={(e) => setLevel(Number(e.target.value))}
                        >
                          <option value={1}>Niveau 1 (Simple - BTS SIO 1)</option>
                          <option value={2}>Niveau 2 (Médium - BTS SIO 2)</option>
                          <option value={3}>Niveau 3 (Expert - Spécialisation)</option>
                        </select>
                      </div>
                    </div>

                    <div className="pt-2">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-mono font-bold uppercase">Nombre de questions à générer</span>
                        <span className="text-xs font-mono font-bold" style={{ color: theme.accent1 }}>{numQuestions} questions</span>
                      </div>
                      <input 
                        type="range" min={3} max={50} step={1}
                        className="w-full accent-[#9d4edd] cursor-ew-resize"
                        value={numQuestions}
                        onChange={(e) => setNumQuestions(Number(e.target.value))}
                      />
                    </div>

                    {errorMsg && (
                      <div className="p-4 rounded-xl text-xs font-mono flex gap-2 items-center border" style={{ backgroundColor: `${theme.red}15`, borderColor: `${theme.red}30`, color: theme.redBright }}>
                        <AlertCircle size={16} /> {errorMsg}
                      </div>
                    )}

                    {successMsg && (
                      <div className="p-4 rounded-xl text-xs font-mono flex gap-2 items-center border" style={{ backgroundColor: `${theme.green}15`, borderColor: `${theme.green}30`, color: theme.green }}>
                        <CheckCircle size={16} /> {successMsg}
                      </div>
                    )}

                    {!generating ? (
                      <button 
                        onClick={triggerAIGeneration}
                        className="w-full py-4 rounded-xl font-bold font-mono text-xs tracking-wider cursor-pointer bg-gradient-to-r from-[#9d4edd] to-[#00f5d4] hover:scale-[1.01] transition-all text-black flex items-center justify-center gap-2 shadow-lg"
                      >
                        <Cpu size={16} /> CRÉER DIRECTEMENT PAR L'IA
                      </button>
                    ) : (
                      <button disabled className="w-full py-4 rounded-xl font-bold font-mono text-xs tracking-wider bg-gray-800 text-gray-500 flex items-center justify-center gap-2 border border-gray-700">
                        <RefreshCw size={16} className="animate-spin" /> PROGÈS GENERATIONNEL...
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Console monitor logs */}
              <div className="lg:col-span-5 flex flex-col gap-6">
                <div className="p-6 rounded-2xl border flex-1 flex flex-col" style={{ backgroundColor: theme.bgPanel2, borderColor: theme.border }}>
                  <h4 className="text-xs font-mono font-bold uppercase mb-4 tracking-widest flex items-center gap-2" style={{ color: theme.textMuted }}>
                    <div className={`w-2.5 h-2.5 rounded-full ${generating ? 'bg-emerald-500 animate-ping' : 'bg-gray-600'}`} />
                    MONITEUR NEURONAL IA
                  </h4>

                  {generating ? (
                    <div className="flex-1 flex flex-col justify-between font-mono text-[11px] leading-relaxed p-4 rounded-xl bg-black/60 border border-gray-800 h-80 overflow-y-auto">
                      <div className="space-y-2">
                        {genLogs.map((log, i) => (
                          <div key={i} className={i === genLogs.length - 1 ? "text-[#00f5d4] font-bold" : "text-gray-400"}>
                            &gt; {log}
                          </div>
                        ))}
                      </div>
                      
                      {iaResponse && (
                        <div className="pt-4 border-t border-gray-900 mt-4">
                          <div className="text-[#fbbf24] font-bold mb-2">QCM Neurolock prêt !</div>
                          <p className="text-[10px] text-gray-400 mb-4 font-sans">
                            Le modèle a généré {iaResponse.length} questions avec explications pour le sujet <strong className="text-white">"{subjectTitle || iaResponse[0]?.subject}"</strong>.
                          </p>
                          <button 
                            onClick={handleApplyGenerated}
                            className="w-full py-2.5 rounded-lg bg-emerald-500 text-black font-bold hover:scale-105 transition-all text-xs font-mono cursor-pointer"
                          >
                            VALIDER ET INJECTER DANS LA CLASSE
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-60">
                      <Brain size={48} className="text-violet-500 mb-4 animate-pulse" />
                      <span className="text-xs font-mono text-gray-400">En attente de transmission de cours...</span>
                    </div>
                  )}
                </div>
              </div>

            </motion.div>
          )}

          {tab === 'qcm' && (
            <QCMCompilerByCourse
              questions={questions}
              theme={theme}
              filterSubject={filterSubject}
              setFilterSubject={setFilterSubject}
              existingSubjects={existingSubjects}
              onOpenNewForm={handleOpenNewForm}
              onExportAll={handleExportQuestions}
              onEdit={handleOpenEditForm}
              onDeleteQuestion={handleDeleteQ}
              onDeleteSubject={(subjectName) => {
                if (!confirm(`Supprimer le cours « ${subjectName} » et toutes ses questions ?`)) return;
                onUpdateQuestions(questions.filter(q => q.subject !== subjectName));
              }}
              onExportSubject={(subjectName) => {
                const subset = questions.filter(q => q.subject === subjectName);
                const payload = {
                  id: `export_${Date.now()}`,
                  subject: subjectName,
                  description: `Export local du ${new Date().toLocaleDateString('fr-FR')}`,
                  version: '1.0',
                  author: 'NEUROLOCK',
                  questions: subset,
                };
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
                const el = document.createElement('a');
                el.setAttribute('href', dataStr);
                el.setAttribute('download', `neurolock_${subjectName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.json`);
                el.click();
              }}
            />
          )}

          {tab === 'stats' && (
            <StatsTab questions={questions} theme={theme} />
          )}
        </AnimatePresence>
      </div>

      {/* Manual Question overlay form (Modal) */}
      {isFormOpen && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-lg p-6 rounded-2xl border text-left flex flex-col max-h-[90vh]"
            style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}
          >
            <div className="flex justify-between items-center border-b pb-4 mb-4" style={{ borderColor: `${theme.border}50` }}>
              <h3 className="text-lg font-bold font-mono text-white flex items-center gap-2">
                <FileText size={18} style={{ color: theme.accent1 }} /> 
                {editingId ? 'MODIFIER LA QUESTION' : 'AJOUTER UNE QUESTION'}
              </h3>
              <button onClick={() => setIsFormOpen(false)} className="text-gray-400 hover:text-white cursor-pointer"><X size={18} /></button>
            </div>

            <form onSubmit={handleSaveForm} className="space-y-4 overflow-y-auto pr-2 flex-1">
              <div>
                <label className="block text-[10px] font-mono font-bold uppercase mb-1">Texte de l'interrogation (*)</label>
                <textarea 
                  required
                  rows={2}
                  className="w-full p-2.5 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none"
                  style={{ borderColor: theme.border }}
                  value={qText}
                  onChange={(e) => setQText(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-mono font-bold uppercase mb-1">Matière / Chapitre (*)</label>
                  <input 
                    required
                    type="text"
                    className="w-full p-2.5 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none"
                    style={{ borderColor: theme.border }}
                    value={qSubject}
                    onChange={(e) => setQSubject(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono font-bold uppercase mb-1">Niveau Difficulté</label>
                  <select 
                    className="w-full p-2.5 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none cursor-pointer"
                    style={{ borderColor: theme.border }}
                    value={qLevel}
                    onChange={(e) => setQLevel(Number(e.target.value))}
                  >
                    <option value={1}>1 (Facile)</option>
                    <option value={2}>2 (Médium)</option>
                    <option value={3}>3 (Difficile)</option>
                  </select>
                </div>
              </div>

              {/* Four options */}
              <div className="space-y-2">
                <label className="block text-[10px] font-mono font-bold uppercase mb-1">Options de réponse (Remplir les 4)</label>
                {qChoices.map((choice, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <span className="font-mono text-xs text-gray-500 w-5">{String.fromCharCode(65 + i)})</span>
                    <input 
                      required
                      type="text"
                      className="flex-1 p-2 rounded-lg border text-xs text-white bg-[#090a16]/40 focus:outline-none"
                      style={{ borderColor: theme.border }}
                      value={choice}
                      onChange={(e) => handleChoiceChange(i, e.target.value)}
                    />
                    <input 
                      type="radio" 
                      name="correct_choice"
                      checked={qCorrect === i}
                      onChange={() => setQCorrect(i)}
                      className="w-4 h-4 accent-emerald-500 cursor-pointer"
                      title="Définir comme réponse correcte"
                    />
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-mono font-bold uppercase mb-1">Explication Didactique</label>
                  <input 
                    type="text" 
                    className="w-full p-2.5 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none"
                    style={{ borderColor: theme.border }}
                    value={qExplanation}
                    onChange={(e) => setQExplanation(e.target.value)}
                    placeholder="Pourquoi cette réponse est correcte ?"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-mono font-bold uppercase mb-1">Durée (secs)</label>
                  <input 
                    type="number" min={5} max={60}
                    className="w-full p-2.5 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none"
                    style={{ borderColor: theme.border }}
                    value={qDuration}
                    onChange={(e) => setQDuration(Number(e.target.value))}
                  />
                </div>
              </div>

              <button 
                type="submit"
                className="w-full py-3 mt-2 rounded-xl text-black font-bold font-mono text-xs tracking-wider cursor-pointer bg-[#00f5d4] hover:scale-105 transition-all text-center"
              >
                ENREGISTRER LA CONFIGURATION DU QCM
              </button>
            </form>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}

function MenuScreen({ onStart, theme, highScore, stats }: { onStart: (m: GameMode) => void, theme: ThemeColors, highScore: number, stats: AllModeStats }) {
  const recordOf = (m: GameMode): { score: number; label: string } | null => {
    const s =
      m === GameMode.SURVIVAL ? stats.survival :
      m === GameMode.TOWER_DEFENSE ? stats.tower_defense :
      m === GameMode.SPRINT ? stats.sprint :
      m === GameMode.HEART_DEFENSE ? stats.heart_defense : null;
    if (!s || s.bestScore <= 0) return null;
    const progLabel =
      m === GameMode.SURVIVAL || m === GameMode.SPRINT ? `Niv ${s.bestProgression}` :
      `Vague ${s.bestProgression}`;
    return { score: s.bestScore, label: progLabel };
  };
  return (
    <motion.div 
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="flex flex-col items-center justify-center min-h-screen p-6 relative overflow-hidden"
    >
      <div className="absolute inset-0 opacity-10 pointer-events-none">
          <div className="absolute inset-0" style={{ backgroundImage: `radial-gradient(${theme.primary} 1px, transparent 1px)`, backgroundSize: '40px 40px' }}></div>
      </div>

      <div className="z-10 text-center">
        <motion.h1 
          className="text-7xl md:text-9xl font-mono tracking-tighter mb-2"
          initial={{ y: 20 }} animate={{ y: 0 }}
        >
          <span style={{ color: theme.primaryLight, filter: `drop-shadow(0 0 20px ${theme.primary}88)` }}>NEURO</span>
          <span style={{ color: theme.accent1, filter: `drop-shadow(0 0 20px ${theme.accent1}88)` }}>LOCK</span>
        </motion.h1>
        <p className="text-xl font-mono mb-4 italic uppercase tracking-[0.3em]" style={{ color: theme.textMuted }}>Survive. Learn. Repeat.</p>

        {highScore > 0 && (
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border mb-10 text-xs font-mono font-bold tracking-wider"
            style={{ 
              backgroundColor: `${theme.bgPanel}B3`, 
              borderColor: `${theme.primary}60`,
              color: theme.primaryLight,
              boxShadow: `0 0 25px ${theme.primary}22`
            }}
          >
            <Trophy size={14} className="text-amber-400 animate-pulse" /> RECORD INTELLECTUEL : {highScore.toLocaleString()} PTS
          </motion.div>
        )}

        <div className="flex flex-col gap-3 w-full max-w-lg mx-auto mt-2">
          <MenuButton icon={Play} label="SURVIE" sub="Labyrinthe & réflexes" record={recordOf(GameMode.SURVIVAL)} onClick={() => onStart(GameMode.SURVIVAL)} primary theme={theme} />
          <div className="grid grid-cols-3 gap-3">
            <MenuButton icon={Shield} label="DÉFENSE" sub="Vagues" record={recordOf(GameMode.TOWER_DEFENSE)} onClick={() => onStart(GameMode.TOWER_DEFENSE)} theme={theme} />
            <MenuButton icon={Clock} label="SPRINT" sub="Contre-la-montre" record={recordOf(GameMode.SPRINT)} onClick={() => onStart(GameMode.SPRINT)} theme={theme} />
            <MenuButton icon={Brain} label="CŒUR" sub="Bâtis ton armée" record={recordOf(GameMode.HEART_DEFENSE)} onClick={() => onStart(GameMode.HEART_DEFENSE)} theme={theme} />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <MenuButton icon={Settings} label="PARAMÈTRES" onClick={() => onStart(GameMode.SETTINGS)} small theme={theme} />
            <MenuButton icon={UserPlus} label="ENSEIGNANT" onClick={() => onStart(GameMode.TEACHER)} small theme={theme} />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function MenuButton({ label, sub, icon: Icon, onClick, primary, small, theme, record }: { label: string, sub?: string, icon: any, onClick: () => void, primary?: boolean, small?: boolean, theme: ThemeColors, record?: { score: number; label: string } | null }) {
  return (
    <button
      onClick={onClick}
      className="group relative flex items-center gap-4 p-4 rounded-xl border transition-all duration-300 hover:scale-[1.02]"
      style={{
        backgroundColor: primary ? `${theme.primary}22` : theme.bgPanel,
        borderColor: primary ? theme.primary : theme.border,
        boxShadow: primary ? `0 0 20px ${theme.primary}33` : 'none'
      }}
    >
      <div className={`p-3 rounded-lg flex items-center justify-center transition-all`}
           style={{
             backgroundColor: primary ? theme.primary : theme.border,
             color: primary ? 'white' : theme.textMuted,
             boxShadow: primary ? `0 0 15px ${theme.primary}` : 'none'
           }}>
        <Icon size={small ? 20 : 24} />
      </div>
      {!small && (
        <div className="flex flex-col items-start text-left flex-1 min-w-0">
          <span className="font-bold tracking-wide" style={{ color: theme.textMain }}>{label}</span>
          {sub && <span className="text-xs uppercase font-mono truncate w-full" style={{ color: theme.textMuted }}>{sub}</span>}
          {record && (
            <div className="flex items-center gap-1 text-[10px] font-mono font-bold mt-1 truncate w-full" style={{ color: theme.accent1 }}>
              <Trophy size={10} className="shrink-0" />
              <span className="truncate">{record.score.toLocaleString()} · {record.label}</span>
            </div>
          )}
        </div>
      )}
      {small && <span className="text-xs font-bold uppercase" style={{ color: theme.textMain }}>{label}</span>}
    </button>
  );
}

function CourseSelectScreen({ onBack, onStart, target, theme, questions, onUpdateQuestions }: { onBack: () => void, onStart: (q: Question[], target: GameMode) => void, target: GameMode, theme: ThemeColors, questions: Question[], onUpdateQuestions: (q: Question[]) => void }) {
  const [tab, setTab] = useState('Prédéfinis');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [showCreator, setShowCreator] = useState(false);

  // Group questions by subject
  const subjects = React.useMemo(() => {
    const map: Record<string, Question[]> = {};
    questions.forEach(q => {
      const s = q.subject || "Autres";
      if (!map[s]) map[s] = [];
      map[s].push(q);
    });
    const predefinedSubjects = new Set(COURSE_META.map(c => c.subject));
    return Object.entries(map).map(([name, list]) => {
      const isPredefined = predefinedSubjects.has(name);
      const meta = COURSE_META.find(c => c.subject === name);
      return {
        name,
        questionsList: list,
        count: list.length,
        difficulty: list[0]?.level === 1 ? "Simple" : list[0]?.level === 2 ? "Moyen" : "Difficile",
        tags: list[0]?.tags || ["Cours"],
        isPredefined,
        description: meta?.description
      };
    });
  }, [questions]);

  const handleImportJSON = () => {
    try {
      const parsed = JSON.parse(importText);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Validate question structure roughly
        const isValid = parsed.every(q => q.question && Array.isArray(q.choices) && typeof q.correct === 'number');
        if (!isValid) {
          setImportError('Format invalide. Chaque question doit avoir "question", "choices" (liste de 4 réponses) et "correct" (index 0 à 3).');
          return;
        }
        
        // Add random or defined IDs if missing
        const formatted = parsed.map((q, i) => ({
          id: q.id || `imp_${Date.now()}_${i}`,
          subject: q.subject || "Importé",
          level: typeof q.level === 'number' ? q.level : 1,
          question: q.question,
          choices: q.choices,
          correct: q.correct,
          explanation: q.explanation || "Explication générée lors du cours.",
          duration: typeof q.duration === 'number' ? q.duration : 10,
          tags: Array.isArray(q.tags) ? q.tags : ["Importé"]
        }));

        // Instantly start game with these questions!
        onStart(formatted, target);
      } else {
        setImportError('Le JSON doit être une liste de questions valide (Array).');
      }
    } catch (e: any) {
      setImportError(`Erreur de syntaxe JSON : ${e.message}`);
    }
  };

  const filteredSubjects = subjects.filter(sub => {
    if (tab === 'Prédéfinis') return sub.isPredefined;
    if (tab === 'Mes cours') return !sub.isPredefined;
    return true; // Show all for session or others
  });

  return (
    <motion.div 
      initial={{ x: 100, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -100, opacity: 0 }}
      className="min-h-screen p-8 flex flex-col items-center w-full"
    >
      <div className="w-full max-w-4xl flex justify-between items-center mb-12">
        <button onClick={onBack} className="hover:text-white flex items-center gap-2 cursor-pointer" style={{ color: theme.textMuted }}>
            <ChevronRight className="rotate-180" size={18} /> Retour au menu
        </button>
        <h2 className="text-3xl font-mono font-bold tracking-tight">CHOIX DU MODULE</h2>
        <div className="w-16"></div>
      </div>

      <div className="flex flex-col items-center gap-3 mb-10">
        <div className="text-xs font-mono uppercase tracking-[0.4em]" style={{ color: theme.accent1 }}>
          MODE {target === GameMode.TOWER_DEFENSE ? 'DÉFENSE' : 'SURVIE'} · SÉLECTIONNEZ UN COURS
        </div>
        <div className="flex gap-2 p-1 rounded-xl border overflow-x-auto max-w-full" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
          {['Prédéfinis', 'Mes cours', 'Importer'].map(t => (
            <button
              key={t} onClick={() => { setTab(t); setImportError(''); }}
              className={`px-6 py-2.5 rounded-lg text-xs font-mono font-bold tracking-wider transition-all whitespace-nowrap cursor-pointer ${tab === t ? 'text-white' : 'hover:bg-white/5'}`}
              style={{
                  backgroundColor: tab === t ? theme.primary : 'transparent',
                  boxShadow: tab === t ? `0 4px 15px ${theme.primary}55` : 'none',
                  color: tab === t ? 'white' : theme.textMuted
              }}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {tab === 'Importer' ? (
          <motion.div 
            key="import-tab"
            initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }}
            className="w-full max-w-2xl p-8 rounded-2xl border mb-16"
            style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}
          >
            <h3 className="text-lg font-bold mb-2 flex items-center gap-2" style={{ color: theme.primaryLight }}>
              <Sparkles size={18} /> IMPORTER UNE SÉRIE DE QUESTIONS
            </h3>
            <p className="text-sm mb-6" style={{ color: theme.textMuted }}>
              Collez ci-dessous le document JSON contenant vos questions Neurolock. Utile pour charger les QCM créés ou partagés par votre enseignant.
            </p>

            <textarea
              className="w-full h-44 p-4 rounded-xl border font-mono text-xs focus:outline-none focus:ring-1 bg-[#121226]/60 text-white mb-4"
              style={{ borderColor: theme.border }}
              placeholder={`[\n  {\n    "question": "Quelle est la valeur décimale du bit de poids fort dans un octet ?",\n    "choices": ["1", "128", "256", "2"],\n    "correct": 1,\n    "explanation": "Le bit de poids fort d'un octet (MSB) vaut 2¹ = 128.",\n    "subject": "Système Binaire"\n  }\n]`}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />

            {importError && (
              <div className="p-4 rounded-xl text-xs font-mono mb-4 flex gap-2 items-center border" style={{ backgroundColor: `${theme.red}15`, borderColor: `${theme.red}30`, color: theme.redBright }}>
                <AlertCircle size={16} /> {importError}
              </div>
            )}

            <button 
              onClick={handleImportJSON}
              className="w-full py-3.5 rounded-xl font-bold text-sm tracking-wider cursor-pointer font-mono bg-[#10b981] hover:scale-[1.01] transition-all text-white flex items-center justify-center gap-2"
              style={{ boxShadow: '0 4px 15px rgba(16, 185, 129, 0.3)' }}
            >
              <CheckCircle size={16} /> IMPORTER ET LANCER LA SESSION
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="grid-tab"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full max-w-5xl"
          >
            {/* "+ Créer un cours" card — first position in Mes cours so it's always visible */}
            {tab === 'Mes cours' && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                className="border-2 border-dashed rounded-2xl flex flex-col items-center justify-center p-8 transition-all cursor-pointer group min-h-[200px]"
                style={{ borderColor: theme.primary, backgroundColor: `${theme.primary}08` }}
                onClick={() => setShowCreator(true)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = `${theme.primary}1A`}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = `${theme.primary}08`}
              >
                <Sparkles style={{ color: theme.primaryLight }} className="group-hover:scale-110 transition-transform mb-3" size={42} />
                <span className="text-sm font-bold font-mono text-center" style={{ color: theme.primaryLight }}>+ Créer un cours via IA</span>
                <span className="text-[10px] font-mono opacity-60 text-center mt-1" style={{ color: theme.textMuted }}>
                  Texte direct ou PDF · Mistral / Groq
                </span>
              </motion.div>
            )}

            {filteredSubjects.length > 0 ? (
              filteredSubjects.map(sub => (
                <CourseCard
                  key={sub.name}
                  title={sub.name}
                  desc={sub.description || `Module contenant ${sub.count} questions d'évaluation interactive.`}
                  count={sub.count}
                  difficulty={sub.difficulty}
                  tags={sub.tags.slice(0, 2)}
                  onClick={() => onStart(sub.questionsList, target)}
                  theme={theme}
                  onDelete={!sub.isPredefined ? () => {
                    if (!confirm(`Supprimer le cours « ${sub.name} » et ses ${sub.count} questions ?`)) return;
                    const remaining = questions.filter(q => q.subject !== sub.name);
                    onUpdateQuestions(remaining);
                  } : undefined}
                />
              ))
            ) : (
              tab !== 'Mes cours' && (
                <div className="col-span-full border border-dashed rounded-2xl flex flex-col items-center justify-center p-12 text-center" style={{ borderColor: theme.border }}>
                  <HelpCircle size={44} className="mb-4 opacity-50" style={{ color: theme.textMuted }} />
                  <h4 className="font-bold mb-1 col-span-full w-full">Aucun cours trouvé</h4>
                  <p className="text-xs max-w-xs mx-auto col-span-full" style={{ color: theme.textMuted }}>
                    Aucun niveau prédéfini n'est disponible.
                  </p>
                </div>
              )
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showCreator && (
          <CourseCreator
            theme={theme}
            existingQuestions={questions}
            onClose={() => setShowCreator(false)}
            onCreated={(merged) => onUpdateQuestions(merged)}
            onPlayNow={(newCourseQuestions) => {
              // Launch the game immediately with just the new course's questions
              onStart(newCourseQuestions, target);
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function CourseCard({ title, desc, count, difficulty, tags, onClick, theme, onDelete }: any) {
    return (
        <div onClick={onClick} className="border p-6 rounded-2xl transition-all cursor-pointer group relative"
             style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}
             onMouseEnter={(e) => { e.currentTarget.style.borderColor = theme.primary; e.currentTarget.style.backgroundColor = theme.bgPanel2; }}
             onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.border; e.currentTarget.style.backgroundColor = theme.bgPanel; }}>
            {onDelete && (
                <button
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    className="absolute top-3 right-3 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110"
                    style={{ backgroundColor: `${theme.red}22`, color: theme.red, border: `1px solid ${theme.red}40` }}
                    title="Supprimer ce cours"
                >
                    <Trash2 size={14} />
                </button>
            )}
            <div className="flex justify-between items-start mb-4">
                <div className="p-2 rounded-lg" style={{ backgroundColor: theme.bgPanel2, color: theme.accent1 }}>
                    <BookOpen size={20} />
                </div>
                <span className="text-[10px] font-mono border px-2 py-0.5 rounded uppercase" style={{ color: theme.textMuted, borderColor: theme.border }}>{difficulty}</span>
            </div>
            <h3 className="text-xl font-bold mb-2 transition-colors group-hover:text-white" style={{ color: theme.textMain }}>{title}</h3>
            <p className="text-sm mb-6 line-clamp-2" style={{ color: theme.textMuted }}>{desc}</p>
            <div className="flex items-center justify-between text-xs font-mono">
                <span style={{ color: theme.primaryLight }}>{count} Questions</span>
                <div className="flex gap-1">
                    {tags.map((t: string) => <span key={t} className="px-2 py-0.5 rounded" style={{ backgroundColor: theme.bgDark, color: theme.textMuted }}>#{t}</span>)}
                </div>
            </div>
        </div>
    );
}

type ApiProvider = 'mistral' | 'groq';
type KeyTestState = 'idle' | 'testing' | 'ok' | 'fail';

/**
 * Inline panel inside SettingsScreen letting the player paste their own
 * Mistral / Groq keys when the deployed server has no env keys.
 * Keys are stored in localStorage via useApiKeys() and forwarded to the
 * server on each /api/generate-questions call (and tested via /api/test-key).
 */
function ApiKeysSection({ theme }: { theme: ThemeColors }) {
    const { keys, setKey, clearKey } = useApiKeys();
    const [show, setShow] = useState<{ mistral: boolean, groq: boolean }>({ mistral: false, groq: false });
    const [testState, setTestState] = useState<{ mistral: KeyTestState, groq: KeyTestState }>({ mistral: 'idle', groq: 'idle' });
    const [testMsg, setTestMsg] = useState<{ mistral: string, groq: string }>({ mistral: '', groq: '' });

    const testKey = async (provider: ApiProvider) => {
        const value = keys[provider];
        if (!value) return;
        setTestState(prev => ({ ...prev, [provider]: 'testing' }));
        setTestMsg(prev => ({ ...prev, [provider]: '' }));
        try {
            const resp = await fetch('/api/test-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, apiKey: value }),
            });
            const data = await resp.json();
            if (resp.ok && data.ok) {
                setTestState(prev => ({ ...prev, [provider]: 'ok' }));
                setTestMsg(prev => ({ ...prev, [provider]: `OK — modèle ${data.model || '?'}` }));
            } else {
                setTestState(prev => ({ ...prev, [provider]: 'fail' }));
                setTestMsg(prev => ({ ...prev, [provider]: data.error || `HTTP ${resp.status}` }));
            }
        } catch (e: any) {
            setTestState(prev => ({ ...prev, [provider]: 'fail' }));
            setTestMsg(prev => ({ ...prev, [provider]: e?.message || 'Erreur réseau' }));
        }
    };

    const renderRow = (provider: ApiProvider, label: string, placeholder: string) => {
        const value = keys[provider];
        const isShown = show[provider];
        const state = testState[provider];
        const msg = testMsg[provider];
        return (
            <div className="space-y-2">
                <label className="text-[11px] font-mono uppercase tracking-widest flex items-center justify-between" style={{ color: theme.textMuted }}>
                    <span>{label}</span>
                    {state === 'ok' && <span className="flex items-center gap-1" style={{ color: theme.green }}><CheckCircle size={12} /> Valide</span>}
                    {state === 'fail' && <span className="flex items-center gap-1" style={{ color: theme.red }}><AlertCircle size={12} /> Erreur</span>}
                </label>
                <div className="flex gap-2">
                    <div className="flex-1 relative">
                        <input
                            type={isShown ? 'text' : 'password'}
                            value={value}
                            onChange={(e) => setKey(provider, e.target.value)}
                            placeholder={placeholder}
                            spellCheck={false}
                            autoComplete="off"
                            className="w-full p-3 pr-10 rounded-xl border font-mono text-xs"
                            style={{
                                backgroundColor: theme.bgDark,
                                borderColor: state === 'ok' ? theme.green : state === 'fail' ? theme.red : theme.border,
                                color: theme.textMain,
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => setShow(prev => ({ ...prev, [provider]: !isShown }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-white/5"
                            style={{ color: theme.textMuted }}
                            aria-label={isShown ? 'Masquer' : 'Afficher'}
                        >
                            {isShown ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={() => testKey(provider)}
                        disabled={!value || state === 'testing'}
                        className="px-3 rounded-xl border font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ borderColor: theme.primary, backgroundColor: `${theme.primary}22`, color: theme.primaryLight }}
                    >
                        {state === 'testing' ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                        Tester
                    </button>
                    {value && (
                        <button
                            type="button"
                            onClick={() => {
                                clearKey(provider);
                                setTestState(prev => ({ ...prev, [provider]: 'idle' }));
                                setTestMsg(prev => ({ ...prev, [provider]: '' }));
                            }}
                            className="px-3 rounded-xl border font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5"
                            style={{ borderColor: theme.border, color: theme.textMuted }}
                            aria-label="Effacer la clé"
                        >
                            <Trash2 size={12} />
                        </button>
                    )}
                </div>
                {msg && (
                    <div className="text-[10px] font-mono leading-tight pl-1" style={{ color: state === 'ok' ? theme.green : theme.red }}>
                        {msg}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-4 pt-4">
            <label className="text-sm font-mono uppercase flex items-center gap-2" style={{ color: theme.textMuted }}>
                <Key size={16} /> Clés API IA (optionnel)
            </label>
            <div className="p-3 rounded-xl border text-[11px] font-mono leading-relaxed space-y-1.5"
                 style={{ backgroundColor: `${theme.amber}11`, borderColor: `${theme.amber}55`, color: theme.textMain }}>
                <div className="flex items-start gap-2">
                    <AlertCircle size={14} style={{ color: theme.amber }} className="shrink-0 mt-0.5" />
                    <div>
                        Si l'instance n'a pas de clés serveur (<code style={{ color: theme.accent1 }}>.env</code>),
                        colle ici les tiennes. Elles restent stockées <strong>uniquement sur cet appareil</strong> et
                        sont transmises directement aux APIs (Mistral / Groq) via le serveur, sans être enregistrées côté backend.
                    </div>
                </div>
            </div>
            {renderRow('mistral', 'Mistral (primaire)', 'mistral-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx')}
            {renderRow('groq', 'Groq (repli)', 'gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')}
            <div className="text-[10px] font-mono opacity-70" style={{ color: theme.textMuted }}>
                Obtenir une clé : <span style={{ color: theme.accent1 }}>console.mistral.ai</span> · <span style={{ color: theme.accent1 }}>console.groq.com</span>
            </div>
        </div>
    );
}

function SettingsScreen({ onBack, themeKey, setThemeKey, theme, onResetTutorial }: { onBack: () => void, themeKey: string, setThemeKey: (k: string) => void, theme: ThemeColors, onResetTutorial: () => void }) {
    const [volume, setVolumeState] = useState(() => AudioEngine.getVolume());
    const handleVolume = (v: number) => {
        AudioEngine.init();
        AudioEngine.setVolume(v);
        setVolumeState(v);
    };
    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-screen p-8 flex flex-col items-center">
            <div className="w-full max-w-2xl">
                 <button onClick={onBack} className="hover:text-white flex items-center gap-2 mb-12" style={{ color: theme.textMuted }}>
                    <ChevronRight className="rotate-180" /> Retour
                </button>
                <h2 className="text-4xl font-mono font-bold mb-12">PARAMÈTRES</h2>
                <div className="space-y-8 p-8 rounded-2xl border" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
                    <div className="space-y-4">
                        <label className="text-sm font-mono uppercase flex items-center gap-2" style={{ color: theme.textMuted }}>
                            <Palette size={16} /> Thème visuel
                        </label>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            {Object.keys(THEMES).map(k => (
                                <button
                                    key={k}
                                    onClick={() => setThemeKey(k)}
                                    className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${themeKey === k ? 'scale-105' : 'opacity-60 hover:opacity-100'}`}
                                    style={{
                                        backgroundColor: THEMES[k].bgDark,
                                        borderColor: themeKey === k ? THEMES[k].primary : THEMES[k].border
                                    }}
                                >
                                    <div className="flex gap-1">
                                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: THEMES[k].primary }} />
                                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: THEMES[k].accent1 }} />
                                    </div>
                                    <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: THEMES[k].textMain }}>{k}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-3 pt-4">
                        <label className="text-sm font-mono uppercase flex items-center justify-between" style={{ color: theme.textMuted }}>
                            <span className="flex items-center gap-2"><Volume2 size={16} /> Volume sonore</span>
                            <span className="font-bold" style={{ color: theme.accent1 }}>{Math.round(volume * 100)}%</span>
                        </label>
                        <input
                            type="range" min={0} max={100} step={1}
                            value={Math.round(volume * 100)}
                            onChange={(e) => handleVolume(Number(e.target.value) / 100)}
                            className="w-full accent-[#9d4edd] cursor-ew-resize"
                            style={{ accentColor: theme.primary }}
                        />
                    </div>

                    <div className="space-y-3 pt-4">
                        <label className="text-sm font-mono uppercase flex items-center gap-2" style={{ color: theme.textMuted }}>
                            <HelpCircle size={16} /> Didacticiel
                        </label>
                        <button
                            onClick={() => { onResetTutorial(); onBack(); }}
                            className="w-full p-3 rounded-xl border text-sm font-mono uppercase tracking-wider hover:scale-[1.01] transition-all"
                            style={{ borderColor: theme.primary, backgroundColor: `${theme.primary}11`, color: theme.primaryLight }}
                        >
                            Revoir le tutoriel
                        </button>
                    </div>

                    <ApiKeysSection theme={theme} />
                </div>
            </div>
        </motion.div>
    );
}

type AnswerHistory = { questionId: string; wasCorrect: boolean; time: number };
type QuizContext = { type: 'door' | 'tower'; data: any; questionId: string; openedAt: number };

function mazeSizeForLevel(level: number): number {
    // Level 1: 10×10, then +2 per level, capped at 18×18
    return Math.min(18, 10 + (level - 1) * 2);
}

function timerForLevel(level: number): number {
    // More time for bigger mazes
    return 180 + level * 30;
}

/** Build the title shown on the game-over overlay, mode + cause aware. */
function gameOverTitle(
    result: 'win' | 'lose',
    level: number,
    cause: 'hp' | 'timer' | 'heart' | null,
    isHeartDefense: boolean,
    isTowerDefense: boolean,
    isSprint: boolean,
    waveNumber?: number
): string {
    if (result === 'win') return `NIVEAU ${level} VAINCU`;
    if (cause === 'heart') return 'CŒUR DÉTRUIT';
    if (cause === 'timer') return isSprint ? 'TEMPS ÉCOULÉ' : 'SYNCHRONICITÉ PERDUE';
    if (cause === 'hp') return 'VITALITÉ ÉPUISÉE';
    // Fallback (shouldn't normally happen)
    if (isHeartDefense) return `VAGUE ${waveNumber ?? 0} ATTEINTE`;
    if (isTowerDefense) return `VAGUE ${waveNumber ?? 0} TENUE`;
    return 'PARTIE TERMINÉE';
}

/** Build a thematic one-liner subtitle describing the cause of death. */
function gameOverSubtitle(
    cause: 'hp' | 'timer' | 'heart' | null,
    isHeartDefense: boolean,
    isSprint: boolean,
): string {
    if (cause === 'heart') return '« Le système a percé ta dernière défense »';
    if (cause === 'hp') return '« Tes circuits ont cédé sous l\'assaut »';
    if (cause === 'timer') return isSprint
        ? '« La fenêtre d\'infiltration s\'est refermée »'
        : '« La synchronisation neuronale a expiré »';
    if (isHeartDefense) return '« Le cœur a tenu, mais pas pour toujours »';
    return '« Reconnecte-toi et retente »';
}

/** Score multiplier as a function of consecutive correct answers. */
function streakMultiplier(streak: number): number {
    if (streak <= 1) return 1;
    if (streak === 2) return 1.5;
    if (streak === 3) return 2;
    if (streak === 4) return 3;
    return 4; // capped at ×4
}

function GameScreen({ mode, questions, subjectLabel, theme, highScore, onNewScore, onExit, onRunComplete }: { mode: GameMode, questions: Question[], subjectLabel: string, theme: ThemeColors, highScore: number, onNewScore: (score: number) => void, onExit: () => void, onRunComplete: (summary: { mode: GameMode; score: number; progression: number; kills: number; questionsAnswered: number; questionsCorrect: number; bestCombo: number; accuracy: number }) => void }) {
    const isTowerDefense = mode === GameMode.TOWER_DEFENSE;
    const isSprint = mode === GameMode.SPRINT;
    const isHeartDefense = mode === GameMode.HEART_DEFENSE;
    const isProgressive = mode === GameMode.SURVIVAL || mode === GameMode.SPRINT;
    const engineMode = engineModeFromGameMode(mode);
    const modeChip = isHeartDefense ? '💗 CŒUR' : isSprint ? '⏱ SPRINT' : isTowerDefense ? '🛡 DÉFENSE' : '▶ SURVIE';
    const containerRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<ThreeEngine | null>(null);
    const usedIdsRef = useRef<Set<string>>(new Set());
    const historyRef = useRef<AnswerHistory[]>([]);
    const pendingRef = useRef<QuizContext | null>(null);
    const carryRef = useRef({ score: 0, hp: 3, ammo: 12 }); // carried between level remounts

    const [level, setLevel] = useState(1);
    const [gameState, setGameState] = useState({ score: 0, timer: isTowerDefense ? 999 : timerForLevel(1), hp: 3, ammo: 12 });
    const [engineState, setEngineState] = useState<any>(null);
    const [quizActive, setQuizActive] = useState(false);
    const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
    const [gameResult, setGameResult] = useState<'win' | 'lose' | null>(null);
    const [accuracy, setAccuracy] = useState(0);
    const [runId, setRunId] = useState(0);
    const [showLevelIntro, setShowLevelIntro] = useState(true);
    const [paused, setPaused] = useState(false);
    const [enemiesKilled, setEnemiesKilled] = useState(0);
    const [streak, setStreak] = useState(0);
    const [bestStreak, setBestStreak] = useState(0);
    const [waveIntro, setWaveIntro] = useState<number | null>(null);
    const [lossCause, setLossCause] = useState<'hp' | 'timer' | 'heart' | null>(null);
    const [deathFlash, setDeathFlash] = useState(false);
    const scoreReportedRef = useRef(false);
    const pausedRef = useRef(false);
    const isTouch = useIsTouchDevice();
    const fireIntervalRef = useRef<number | null>(null);

    const togglePause = () => {
        if (!engineRef.current) return;
        const next = !pausedRef.current;
        pausedRef.current = next;
        setPaused(next);
        engineRef.current.paused = next;
    };
    const startContinuousFire = () => {
        engineRef.current?.firePlayerShot();
        if (fireIntervalRef.current !== null) return;
        fireIntervalRef.current = window.setInterval(() => {
            engineRef.current?.firePlayerShot();
        }, 100); // 10 calls/sec, throttled by engine 0.3s cooldown
    };
    const stopContinuousFire = () => {
        if (fireIntervalRef.current !== null) {
            window.clearInterval(fireIntervalRef.current);
            fireIntervalRef.current = null;
        }
    };
    const streakRef = useRef(0);
    const bestStreakRef = useRef(0);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Reset per-run state (history persists across levels)
        pendingRef.current = null;
        scoreReportedRef.current = false;
        setQuizActive(false);
        setCurrentQuestion(null);
        setGameResult(null);
        setShowLevelIntro(true);
        setWaveIntro(null);
        setLossCause(null);
        setDeathFlash(false);

        // Heart Defense uses a fixed compact maze focused on defense; sprint scales with level
        const size = isHeartDefense ? 12 : mazeSizeForLevel(level);
        // Timer logic varies: TD/Heart effectively infinite, Sprint generous, Survival level-scaled
        const startTimer = (isTowerDefense || isHeartDefense) ? 9999 : isSprint ? timerForLevel(level) + 60 : timerForLevel(level);
        const maze = new Maze(size, size, { level });
        // In Tower Defense and Heart Defense, neutralize the exit tile (no level transition)
        if (isTowerDefense || isHeartDefense) {
          for (let yy = 0; yy < maze.height; yy++) {
            for (let xx = 0; xx < maze.width; xx++) {
              if (maze.grid[yy][xx] === 5) maze.grid[yy][xx] = 0;
            }
          }
        }
        const engine = new ThreeEngine(
            container,
            maze,
            theme,
            (type, data) => {
                if (pendingRef.current) return;
                const targetLvl = AdaptiveAI.getDifficulty(historyRef.current);
                const q = AdaptiveAI.pickQuestion(questions, targetLvl, usedIdsRef.current);
                if (!q) return;
                usedIdsRef.current.add(q.id);
                pendingRef.current = { type, data, questionId: q.id, openedAt: performance.now() };
                setCurrentQuestion(q);
                setQuizActive(true);
                AudioEngine.playClick();
            },
            (state) => setEngineState(state),
            {
                mode: engineMode,
                level,
                startScore: carryRef.current.score,
                startTimer,
                startHp: carryRef.current.hp,
                startAmmo: carryRef.current.ammo,
                onLevelComplete: (finalScore) => {
                    if (!isProgressive) return; // only Survival and Sprint advance levels
                    carryRef.current.score = finalScore + 1000;
                    carryRef.current.hp = Math.min(3, engine.player.hp + 1);
                    carryRef.current.ammo = Math.min(20, engine.player.ammo + 6);
                    setGameResult('win');
                },
                onWaveStart: (wave) => {
                    setWaveIntro(wave);
                    // auto-hide intro after 2s
                    window.setTimeout(() => {
                        setWaveIntro(curr => curr === wave ? null : curr);
                    }, 2000);
                },
                onWaveEnd: () => { /* hooks for future polish */ },
            }
        );

        engineRef.current = engine;
        engine.loop();

        // Pause handling — Escape; quick R restart at game over
        const handleEsc = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            const next = !pausedRef.current;
            pausedRef.current = next;
            setPaused(next);
            engine.paused = next;
          }
        };
        window.addEventListener('keydown', handleEsc);

        // Hide intro after 1.6s
        const introTimer = window.setTimeout(() => setShowLevelIntro(false), 1600);

        const reportScore = (score: number) => {
            if (scoreReportedRef.current) return;
            scoreReportedRef.current = true;
            onNewScore(score);
            // Persist this run's full summary for stats + achievements
            const total = historyRef.current.length;
            const correct = historyRef.current.filter(h => h.wasCorrect).length;
            const progression =
                mode === GameMode.HEART_DEFENSE || mode === GameMode.TOWER_DEFENSE
                    ? (engine.waveNumber || 0)
                    : level;
            onRunComplete({
                mode,
                score,
                progression,
                kills: engine.enemiesKilled,
                questionsAnswered: total,
                questionsCorrect: correct,
                bestCombo: bestStreakRef.current,
                accuracy: total > 0 ? correct / total : 0,
            });
        };

        const hudInterval = window.setInterval(() => {
            const correct = historyRef.current.filter(h => h.wasCorrect).length;
            const total = historyRef.current.length;
            setAccuracy(total > 0 ? (correct / total) * 100 : 0);

            setGameState({
                score: engine.player.score,
                timer: Math.max(0, Math.floor(engine.player.timer)),
                hp: engine.player.hp,
                ammo: engine.player.ammo,
            });

            if (engine.player.timer <= 0 || engine.player.hp <= 0
                || (isHeartDefense && engine.heart.hp <= 0)) {
                // Determine the exact cause (priority: heart > hp > timer)
                const cause: 'hp' | 'timer' | 'heart' =
                    isHeartDefense && engine.heart.hp <= 0 ? 'heart' :
                    engine.player.hp <= 0 ? 'hp' : 'timer';
                setLossCause(cause);
                setDeathFlash(true);
                window.setTimeout(() => setDeathFlash(false), 350);
                AudioEngine.playDeath();
                engine.shakeIntensity = 1.0; // final dramatic shake
                engine.triggerHitStop(0.25);  // brief slow-mo before everything freezes
                window.setTimeout(() => { engine.paused = true; }, 280); // freeze after the hit-stop window
                setGameResult('lose');
                reportScore(engine.player.score);
                window.clearInterval(hudInterval);
            }
        }, 200);

        return () => {
            window.removeEventListener('keydown', handleEsc);
            window.clearTimeout(introTimer);
            window.clearInterval(hudInterval);
            if (fireIntervalRef.current !== null) {
                window.clearInterval(fireIntervalRef.current);
                fireIntervalRef.current = null;
            }
            engine.stop();
            engineRef.current = null;
            pausedRef.current = false;
            setPaused(false);
        };
    }, [runId, level]);

    const handleAnswer = (correct: boolean) => {
        const engine = engineRef.current;
        const pending = pendingRef.current;
        setQuizActive(false);

        if (pending) {
            const elapsed = (performance.now() - pending.openedAt) / 1000;
            historyRef.current.push({ questionId: pending.questionId, wasCorrect: correct, time: elapsed });
            // Persist to localStorage for the Teacher console aggregations
            const q = questions.find(x => x.id === pending.questionId);
            appendHistory({
                questionId: pending.questionId,
                subject: q?.subject || 'Inconnu',
                level: q?.level || 1,
                wasCorrect: correct,
                time: elapsed,
                at: Date.now(),
            });
        }

        if (!engine || !pending) {
            pendingRef.current = null;
            if (engine) {
              engine.releaseQuizLock(correct);
              engine.clearInputs();
            }
            return;
        }

        // Update spaced-repetition state for this question (persisted)
        if (pending) updateSRS(pending.questionId, correct);

        if (correct) {
            streakRef.current += 1;
            if (streakRef.current > bestStreakRef.current) bestStreakRef.current = streakRef.current;
            setStreak(streakRef.current);
            setBestStreak(bestStreakRef.current);
            const multiplier = streakMultiplier(streakRef.current);
            engine.player.timer += 10;
            engine.player.score += Math.round(150 * multiplier);
            engine.refillAmmo();
            if (pending.type === 'tower') {
                engine.player.score += Math.round(500 * multiplier);
                if (isHeartDefense) {
                    // In Heart Defense, building a "tower" instead spawns a mobile unit that orbits the heart
                    engine.spawnArmyUnit();
                    // Also free the spot (visually it stays a spot, but we mark it occupied so it can't re-trigger)
                    pending.data.occupied = true;
                } else {
                    engine.addTower(pending.data);
                }
            } else if (pending.type === 'door') {
                engine.openDoor(pending.data);
            }
        } else {
            streakRef.current = 0;
            setStreak(0);
            engine.player.timer = Math.max(0, engine.player.timer - 8);
            // Note: QuizOverlay already played playWrong() when the wrong answer was chosen.
            // Don't play it a second time here.
        }

        pendingRef.current = null;
        engine.releaseQuizLock(correct);
        // Drop any held movement keys / inertia so the player doesn't auto-charge back
        // into the same door (which would just sit on cooldown anyway).
        engine.clearInputs();
    };

    const handleNextLevel = () => {
        setLevel(l => l + 1);
        // useEffect will reboot the engine; carryRef carries score and hp forward
    };

    const handleRestart = () => {
        carryRef.current = { score: 0, hp: 3, ammo: 12 };
        usedIdsRef.current = new Set();
        historyRef.current = [];
        streakRef.current = 0;
        bestStreakRef.current = 0;
        setStreak(0);
        setBestStreak(0);
        setLevel(1);
        setRunId(id => id + 1);
    };

    // Quick-restart via R when game over screen is shown
    useEffect(() => {
        if (!gameResult) return;
        const handler = (e: KeyboardEvent) => {
            const k = e.key.toLowerCase();
            if (k === 'r') {
                if (gameResult === 'win') {
                    handleNextLevel();
                } else {
                    handleRestart();
                }
                e.preventDefault();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [gameResult]);

    return (
        <div className="relative h-screen w-screen overflow-hidden flex items-center justify-center shadow-inner" style={{ backgroundColor: theme.bgDark }}>
            <div ref={containerRef} className={`absolute inset-0 transition-all duration-700 ${quizActive ? 'blur-md scale-105 saturate-50' : ''}`} style={{ touchAction: 'none' }} />
            
            <AnimatePresence>
                {!quizActive && (
                    <motion.div 
                        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                        className="absolute top-6 left-6 right-6 flex justify-between pointer-events-none z-50"
                    >
                        <div className="flex gap-4 items-start flex-wrap">
                            <HPBar hp={gameState.hp} max={3} theme={theme} />
                            <AmmoCounter ammo={gameState.ammo} max={20} theme={theme} />
                            {isHeartDefense && engineState?.heart && (
                                <HeartHPBar hp={engineState.heart.hp} max={engineState.heart.maxHp} theme={theme} />
                            )}
                            {isHeartDefense && (
                                <HUDStat icon={Shield} value={`${engineState?.unitsCount ?? 0}`} label="ARMÉE" color={theme.primaryLight} bg={theme.primary} theme={theme} />
                            )}
                            {(mode === GameMode.SURVIVAL || mode === GameMode.SPRINT) && (
                                <HUDStat icon={Clock} value={`${gameState.timer}s`} label="TEMPS" color={theme.amber} bg={theme.amber} theme={theme} />
                            )}
                            {isProgressive && (
                                <HUDStat icon={Brain} value={`N°${level}`} label="NIVEAU" color={theme.accent1} bg={theme.accent1} theme={theme} />
                            )}
                            {(isHeartDefense || isTowerDefense) && engineState?.wave && (
                                <HUDStat
                                    icon={Brain}
                                    value={engineState.wave.active ? `${engineState.wave.enemiesLeftInWave}` : `${Math.ceil(engineState.wave.lullSecondsLeft)}s`}
                                    label={engineState.wave.active ? `VAGUE ${engineState.wave.number}` : 'PROCHAINE VAGUE'}
                                    color={isBossWave(engineState.wave.number || 0) ? theme.red : theme.accent1}
                                    bg={isBossWave(engineState.wave.number || 0) ? theme.red : theme.accent1}
                                    theme={theme}
                                />
                            )}
                            <HUDStat icon={Target} value={CAMERA_LABEL[engineState?.cameraMode as keyof typeof CAMERA_LABEL] || 'SUIVI'} label={isTouch ? 'CAMÉRA (📷)' : 'CAMÉRA (C)'} color={theme.accent2} bg={theme.accent1} theme={theme} />

                            {!isTouch && (
                                <motion.div
                                    initial={{ x: -20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    className="hidden md:flex items-center gap-3 p-3 rounded-2xl border backdrop-blur-xl"
                                    style={{ backgroundColor: `${theme.bgPanel}A6`, borderColor: theme.primary }}
                                >
                                    <Zap size={18} style={{ color: theme.primaryLight }} />
                                    <div className="text-[10px] font-bold leading-tight uppercase font-mono" style={{ color: theme.textMain }}>
                                        <span style={{ color: theme.primaryLight }}>ESPACE/CLIC</span> tirer · <span style={{ color: theme.primaryLight }}>E</span> bâtir<br/>
                                        <span style={{ color: theme.primaryLight }}>ZQSD</span> bouger · bonne réponse = <span style={{ color: theme.accent1 }}>+6 munitions</span>
                                    </div>
                                </motion.div>
                            )}
                            {isTouch && (
                                <motion.div
                                    initial={{ x: -20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    className="hidden md:flex items-center gap-3 p-3 rounded-2xl border backdrop-blur-xl"
                                    style={{ backgroundColor: `${theme.bgPanel}A6`, borderColor: theme.primary }}
                                >
                                    <Zap size={18} style={{ color: theme.primaryLight }} />
                                    <div className="text-[10px] font-bold leading-tight uppercase font-mono" style={{ color: theme.textMain }}>
                                        <span style={{ color: theme.primaryLight }}>⚡</span> tirer · <span style={{ color: theme.primaryLight }}>🛠</span> bâtir<br/>
                                        <span style={{ color: theme.primaryLight }}>👆 gauche</span> bouger · bonne réponse = <span style={{ color: theme.accent1 }}>+6 munitions</span>
                                    </div>
                                </motion.div>
                            )}
                        </div>

                        <div className="text-right flex flex-col items-end gap-2">
                            <div className="flex items-center gap-2 px-3 py-1 rounded-full border backdrop-blur-xl text-[10px] font-mono uppercase tracking-widest font-bold"
                                 style={{ backgroundColor: `${theme.bgPanel}A6`, borderColor: `${theme.border}80`, color: theme.accent1 }}>
                                {modeChip} · {subjectLabel || 'CUSTOM'}
                            </div>
                            <AnimatePresence>
                                {streak >= 2 && (
                                    <motion.div
                                        key={`combo-${streak}`}
                                        initial={{ scale: 0.5, opacity: 0, y: -10 }}
                                        animate={{ scale: 1, opacity: 1, y: 0 }}
                                        exit={{ scale: 0.8, opacity: 0 }}
                                        transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                                        className="flex items-center gap-2 px-3 py-1 rounded-full border-2 text-xs font-mono font-black tracking-widest"
                                        style={{
                                            backgroundColor: `${theme.amber}22`,
                                            borderColor: theme.amber,
                                            color: theme.amber,
                                            boxShadow: `0 0 20px ${theme.amber}88`,
                                            textShadow: `0 0 8px ${theme.amber}`,
                                        }}
                                    >
                                        🔥 COMBO ×{streakMultiplier(streak)} <span className="opacity-70">({streak})</span>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                            <div className="text-5xl font-mono font-bold text-white tracking-tighter drop-shadow-[0_0_20px_rgba(255,255,255,0.3)]">
                                {gameState.score.toLocaleString()}
                            </div>
                            <div className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: theme.primaryLight }}>
                                SCORE {highScore > 0 && <span className="opacity-60 font-medium">/ MEILLEUR: {highScore}</span>}
                            </div>
                            <div className="text-[9px] font-mono opacity-50 uppercase tracking-widest">{isTouch ? '⏸ = PAUSE' : 'ÉCHAP = PAUSE'}</div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* MiniMap Overlay — moves on touch to avoid overlap with fire button */}
            <div className={`absolute z-[40] ${isTouch ? 'top-44 left-3 scale-90 origin-top-left' : 'bottom-6 right-6'}`}>
                {engineRef.current && <MiniMap maze={engineRef.current.maze} playerPos={engineState?.p} enemies={engineState?.e} pickups={engineState?.pickups} theme={theme} />}
            </div>

            {/* Touch controls — floating joystick zone (left half) + action buttons (right) */}
            {isTouch && !quizActive && !gameResult && !paused && (
                <>
                    <FloatingJoystickZone theme={theme} onMove={(v) => {
                        if (engineRef.current) engineRef.current.touchVector = v;
                    }} />
                    <MobileTouchControls
                        theme={theme}
                        canBuild={!!engineState?.canBuild}
                        onFireDown={startContinuousFire}
                        onFireUp={stopContinuousFire}
                        onBuild={() => engineRef.current?.requestBuildTower()}
                        onCycleCamera={() => engineRef.current?.cycleCameraMode()}
                        onPause={togglePause}
                    />
                </>
            )}

            {/* Death flash — brief red wash at the exact moment of dying */}
            <AnimatePresence>
                {deathFlash && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.55 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="absolute inset-0 z-[95] pointer-events-none"
                        style={{ backgroundColor: theme.red, mixBlendMode: 'screen' }}
                    />
                )}
            </AnimatePresence>

            <AnimatePresence>
                {gameResult && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }} className="absolute inset-0 z-[100] flex items-center justify-center p-6 backdrop-blur-md shadow-2xl overflow-y-auto" style={{ backgroundColor: `${theme.bgDark}F2` }}>
                        <div className="text-center max-w-2xl w-full my-auto">
                            <motion.div initial={{ scale: 0.8, y: 20 }} animate={{ scale: 1, y: 0 }}
                                        className={`text-5xl md:text-6xl font-mono font-bold mb-2 tracking-tighter`}
                                        style={{
                                            color: gameResult === 'win' ? theme.accent1 : theme.red,
                                            filter: `drop-shadow(0 0 20px ${gameResult === 'win' ? theme.accent1 : theme.red})`
                                        }}>
                                {gameOverTitle(gameResult, level, lossCause, isHeartDefense, isTowerDefense, isSprint, engineState?.wave?.number)}
                            </motion.div>
                            {gameResult === 'lose' && (
                                <motion.div
                                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
                                    className="text-sm md:text-base font-mono uppercase tracking-[0.3em] mb-6"
                                    style={{ color: theme.textMuted }}
                                >
                                    {gameOverSubtitle(lossCause, isHeartDefense, isSprint)}
                                </motion.div>
                            )}

                            <div className="rounded-3xl p-6 md:p-8 mb-6 space-y-5 shadow-2xl relative overflow-hidden border text-left" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
                                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-50" />

                                {gameState.score > highScore && highScore > 0 && (
                                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-amber-500/10 text-amber-300 border-amber-500/30 text-xs font-mono font-bold tracking-wider animate-bounce select-none">
                                        ✨ NOUVEAU RECORD PERSONNEL ! ✨
                                    </div>
                                )}

                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    <ReportTile label="Score" value={gameState.score.toLocaleString()} color={theme.primaryLight} theme={theme} />
                                    <ReportTile label="Précision" value={`${accuracy.toFixed(0)}%`} color={theme.accent1} theme={theme} />
                                    <ReportTile label="Meilleur combo" value={`×${streakMultiplier(bestStreak)}`} sub={`${bestStreak} d'affilée`} color={theme.amber} theme={theme} />
                                    <ReportTile label="Meilleur record" value={Math.max(highScore, gameState.score).toLocaleString()} color={theme.primary} theme={theme} />
                                </div>

                                <LearningReport history={historyRef.current} questions={questions} theme={theme} />
                            </div>

                            <div className="flex gap-4">
                                {gameResult === 'win' ? (
                                    <button onClick={handleNextLevel}
                                            className="flex-1 text-white py-5 rounded-2xl flex items-center justify-center gap-3 font-bold transition-all shadow-xl group"
                                            style={{ backgroundColor: theme.accent1, color: theme.bgDark, boxShadow: `0 10px 20px ${theme.accent1}66` }}>
                                        <ChevronRight size={22} className="group-hover:translate-x-1 transition-transform" /> NIVEAU {level + 1}
                                        <kbd className="ml-1 px-1.5 py-0.5 text-[10px] rounded font-mono font-bold opacity-80" style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}>R</kbd>
                                    </button>
                                ) : (
                                    <button onClick={handleRestart}
                                            className="flex-1 text-white py-5 rounded-2xl flex items-center justify-center gap-3 font-bold transition-all shadow-xl group"
                                            style={{ backgroundColor: theme.primary, boxShadow: `0 10px 20px ${theme.primary}44` }}>
                                        <RotateCcw size={22} className="group-hover:rotate-180 transition-transform duration-500" /> RECOMMENCER
                                        <kbd className="ml-1 px-1.5 py-0.5 text-[10px] rounded font-mono font-bold opacity-80" style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}>R</kbd>
                                    </button>
                                )}
                                <button onClick={onExit}
                                        className="flex-1 border-2 py-5 rounded-2xl font-bold transition-all uppercase tracking-widest hover:text-white"
                                        style={{ borderColor: theme.border, color: theme.textMuted }}>
                                    DECONNEXION
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {quizActive && currentQuestion && (
                     <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-transparent flex items-center justify-center p-6 z-[60]">
                         <QuizOverlay
                             question={currentQuestion}
                             theme={theme}
                             onAnswer={handleAnswer}
                             source={pendingRef.current?.type ?? 'door'}
                             currentStreak={streak}
                             streakMultiplierAhead={streakMultiplier(streak + 1)}
                         />
                     </motion.div>
                )}
            </AnimatePresence>

            {/* Pickup pickup-up toast — flashes briefly when player collects an item */}
            <PickupToast engineState={engineState} theme={theme} />

            {/* Build prompt — appears when player stands on a free tower spot */}
            <AnimatePresence>
                {engineState?.canBuild && !quizActive && !paused && !gameResult && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                        className="absolute left-1/2 -translate-x-1/2 bottom-32 z-[70] pointer-events-none"
                    >
                        <div className="flex items-center gap-3 px-5 py-3 rounded-2xl border backdrop-blur-xl"
                             style={{ backgroundColor: `${theme.bgPanel}E6`, borderColor: theme.primary, boxShadow: `0 0 30px ${theme.primary}55` }}>
                            <div className="flex items-center justify-center w-9 h-9 rounded-lg font-mono font-black text-base"
                                 style={{ backgroundColor: theme.primary, color: 'white', boxShadow: `0 0 12px ${theme.primary}` }}>
                                {isTouch ? '🛠' : 'E'}
                            </div>
                            <div>
                                <div className="text-xs font-mono font-bold uppercase tracking-wider" style={{ color: theme.textMain }}>Bâtir une tour</div>
                                <div className="text-[10px] font-mono opacity-60" style={{ color: theme.textMuted }}>
                                    {isTouch ? 'Touche 🛠 puis réponds à la question' : 'Répondez à la question pour la construire'}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Pause overlay */}
            <AnimatePresence>
                {paused && !gameResult && !quizActive && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="absolute inset-0 z-[95] flex items-center justify-center backdrop-blur-md"
                        style={{ backgroundColor: `${theme.bgDark}EE` }}
                    >
                        <div className="text-center max-w-sm w-full p-8 rounded-3xl border" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
                            <div className="text-xs font-mono uppercase tracking-[0.4em] mb-2" style={{ color: theme.textMuted }}>SYSTÈME EN ATTENTE</div>
                            <div className="text-5xl font-mono font-black mb-6 tracking-tighter" style={{ color: theme.primaryLight, textShadow: `0 0 30px ${theme.primary}` }}>
                                PAUSE
                            </div>
                            <p className="text-xs font-mono mb-6" style={{ color: theme.textMuted }}>
                                {isTouch ? (
                                    <>Touche <span style={{ color: theme.accent1 }}>REPRENDRE</span> pour continuer.</>
                                ) : (
                                    <>Appuyez sur <span style={{ color: theme.accent1 }}>ÉCHAP</span> pour reprendre.</>
                                )}
                            </p>
                            {isTouch && (
                                <button
                                    onClick={togglePause}
                                    className="w-full py-3 mb-3 rounded-xl font-bold font-mono text-xs uppercase tracking-widest text-white transition-all"
                                    style={{ backgroundColor: theme.primary, boxShadow: `0 4px 18px ${theme.primary}66` }}
                                >
                                    ▶ Reprendre
                                </button>
                            )}
                            <button
                                onClick={onExit}
                                className="w-full py-3 rounded-xl border-2 font-bold font-mono text-xs uppercase tracking-widest hover:text-white transition-all"
                                style={{ borderColor: theme.border, color: theme.textMuted }}
                            >
                                Quitter la partie
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Level intro flash */}
            <AnimatePresence>
                {showLevelIntro && !quizActive && !gameResult && !paused && (
                    <LevelIntro level={level} mazeSize={mazeSizeForLevel(level)} theme={theme} />
                )}
            </AnimatePresence>

            {/* Wave intro flash (Heart Defense + Tower Defense) */}
            <AnimatePresence>
                {waveIntro !== null && !quizActive && !gameResult && !paused && (
                    <WaveIntro wave={waveIntro} theme={theme} />
                )}
            </AnimatePresence>
        </div>
    );
}

function PickupToast({ engineState, theme }: { engineState: any; theme: ThemeColors }) {
    const recent = engineState?.recentPickup as { type: PickupType; label: string; at: number } | null | undefined;
    const [shown, setShown] = useState<{ type: PickupType; label: string; key: number } | null>(null);
    useEffect(() => {
        if (!recent) return;
        // Use the engine clock timestamp as a unique key so each new pickup retriggers the animation
        setShown({ type: recent.type, label: recent.label, key: recent.at });
        const t = window.setTimeout(() => setShown(null), 1800);
        return () => window.clearTimeout(t);
    }, [recent?.at]);
    if (!shown) return null;
    const cfg = PICKUP_CONFIGS[shown.type];
    const color = theme[cfg.themeColorKey] as string;
    return (
        <motion.div
            key={shown.key}
            initial={{ opacity: 0, y: 30, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ type: 'spring', stiffness: 380, damping: 22 }}
            className="absolute left-1/2 -translate-x-1/2 top-44 z-[70] pointer-events-none"
        >
            <div className="flex items-center gap-3 px-5 py-3 rounded-2xl border-2 backdrop-blur-xl shadow-lg"
                 style={{ backgroundColor: `${theme.bgPanel}E6`, borderColor: color, boxShadow: `0 0 30px ${color}88` }}>
                <div className="text-xl">{shown.type === 'ammo' ? '⚡' : shown.type === 'heal' ? '❤' : '★'}</div>
                <div className="text-sm font-mono font-bold tracking-wider uppercase" style={{ color, textShadow: `0 0 6px ${color}` }}>
                    {shown.label}
                </div>
            </div>
        </motion.div>
    );
}

function WaveIntro({ wave, theme }: { wave: number; theme: ThemeColors }) {
    const chapter = chapterForWave(wave);
    const boss = isBossWave(wave);
    const cfg = waveConfigForWave(wave);
    const accent = (theme[chapter.accent] as string) ?? theme.primaryLight;
    return (
        <motion.div
            initial={{ opacity: 0, scale: 1.15 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.35 }}
            className="absolute inset-0 z-[90] flex items-center justify-center pointer-events-none"
        >
            <div className="text-center backdrop-blur-md px-12 py-8 rounded-3xl border-2 max-w-md"
                 style={{
                     backgroundColor: `${theme.bgDark}DD`,
                     borderColor: boss ? theme.red : accent,
                     boxShadow: `0 0 60px ${boss ? theme.red : accent}66`,
                 }}>
                {boss && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="inline-flex items-center gap-2 px-3 py-1 mb-3 rounded-full border-2 text-[10px] font-mono font-black tracking-widest animate-pulse"
                        style={{ backgroundColor: `${theme.red}22`, borderColor: theme.red, color: theme.red }}
                    >
                        ⚠ VAGUE BOSS — RENFORTS MASSIFS
                    </motion.div>
                )}
                <div className="text-[10px] font-mono uppercase tracking-[0.5em] mb-2" style={{ color: theme.textMuted }}>
                    CHAPITRE · {chapter.name}
                </div>
                <div className="text-5xl md:text-6xl font-mono font-black tracking-tighter" style={{ color: accent, textShadow: `0 0 30px ${accent}` }}>
                    VAGUE {wave}
                </div>
                <div className="text-xs italic mt-2 mb-4" style={{ color: theme.textMain, opacity: 0.85 }}>
                    « {chapter.subtitle} »
                </div>
                <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: theme.accent1 }}>
                    {cfg.size} ennemis · vitesse {cfg.enemySpeed.toFixed(1)}
                </div>
            </div>
        </motion.div>
    );
}

function LevelIntro({ level, mazeSize, theme }: { level: number; mazeSize: number; theme: ThemeColors }) {
    const chapter = chapterForLevel(level);
    const boss = isBossLevel(level);
    const accent = (theme[chapter.accent] as string) ?? theme.primaryLight;
    return (
        <motion.div
            initial={{ opacity: 0, scale: 1.15 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.4 }}
            className="absolute inset-0 z-[90] flex items-center justify-center pointer-events-none"
        >
            <div className="text-center backdrop-blur-md px-12 py-8 rounded-3xl border-2 max-w-md"
                 style={{
                     backgroundColor: `${theme.bgDark}DD`,
                     borderColor: boss ? theme.red : accent,
                     boxShadow: `0 0 60px ${boss ? theme.red : accent}66`,
                 }}>
                {boss && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="inline-flex items-center gap-2 px-3 py-1 mb-3 rounded-full border-2 text-[10px] font-mono font-black tracking-widest animate-pulse"
                        style={{ backgroundColor: `${theme.red}22`, borderColor: theme.red, color: theme.red }}
                    >
                        ⚠ ALERTE BOSS — VAGUES INTENSES
                    </motion.div>
                )}
                <div className="text-[10px] font-mono uppercase tracking-[0.5em] mb-2" style={{ color: theme.textMuted }}>
                    CHAPITRE · {chapter.name}
                </div>
                <div className="text-5xl md:text-6xl font-mono font-black tracking-tighter" style={{ color: accent, textShadow: `0 0 30px ${accent}` }}>
                    NIVEAU {level}
                </div>
                <div className="text-xs italic mt-2 mb-4" style={{ color: theme.textMain, opacity: 0.85 }}>
                    « {chapter.subtitle} »
                </div>
                <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: theme.accent1 }}>
                    {mazeSize}×{mazeSize}
                    {boss ? ' · vagues ×1.4 · ennemis ×1.2' : level > 1 ? ' · maze enrichi' : ' · introduction'}
                </div>
            </div>
        </motion.div>
    );
}

function QCMCompilerByCourse({
  questions, theme, filterSubject, setFilterSubject, existingSubjects,
  onOpenNewForm, onExportAll, onEdit, onDeleteQuestion, onDeleteSubject, onExportSubject,
}: {
  questions: Question[];
  theme: ThemeColors;
  filterSubject: string;
  setFilterSubject: (s: string) => void;
  existingSubjects: string[];
  onOpenNewForm: () => void;
  onExportAll: () => void;
  onEdit: (q: Question) => void;
  onDeleteQuestion: (id: string) => void;
  onDeleteSubject: (subjectName: string) => void;
  onExportSubject: (subjectName: string) => void;
}) {
  const [openSubjects, setOpenSubjects] = useState<Set<string>>(() => new Set());

  // Group questions by subject (respecting the filter)
  const grouped = React.useMemo(() => {
    const filtered = filterSubject === 'tous'
      ? questions
      : questions.filter(q => q.subject === filterSubject);
    const map: Record<string, Question[]> = {};
    for (const q of filtered) {
      const s = q.subject || 'Autres';
      if (!map[s]) map[s] = [];
      map[s].push(q);
    }
    // Sort by question count descending so big chapters come first
    return Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  }, [questions, filterSubject]);

  const toggleSubject = (subject: string) => {
    setOpenSubjects(prev => {
      const next = new Set(prev);
      if (next.has(subject)) next.delete(subject); else next.add(subject);
      return next;
    });
  };

  return (
    <motion.div key="qcm-workspace" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 p-4 rounded-xl border bg-black/40" style={{ borderColor: theme.border }}>
        <div className="flex items-center gap-4 w-full md:w-auto">
          <span className="text-xs font-mono font-bold uppercase whitespace-nowrap opacity-75">Filtrer :</span>
          <select
            className="p-2.5 rounded-lg border text-xs text-white bg-[#090a16]/65 focus:outline-none cursor-pointer w-full md:w-56"
            style={{ borderColor: theme.border }}
            value={filterSubject}
            onChange={e => setFilterSubject(e.target.value)}
          >
            <option value="tous">--- Tous les cours ---</option>
            {existingSubjects.map(sub => (
              <option key={sub} value={sub}>{sub}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-2 w-full md:w-auto">
          <button
            onClick={onOpenNewForm}
            className="flex-1 md:flex-none px-4 py-2.5 rounded-lg font-mono text-xs font-bold cursor-pointer hover:scale-105 transition-all flex items-center justify-center gap-2"
            style={{ backgroundColor: theme.accent1, color: theme.bgDark }}
          >
            <Plus size={14} /> NOUVELLE QUESTION
          </button>
          <button
            onClick={onExportAll}
            className="px-4 py-2.5 rounded-lg font-mono text-xs font-bold cursor-pointer border hover:text-white transition-all flex items-center justify-center gap-2"
            style={{ borderColor: theme.border, color: theme.textMuted }}
          >
            <Download size={14} /> TOUT EXPORTER
          </button>
        </div>
      </div>

      {/* Course accordions */}
      <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
        {grouped.length > 0 ? (
          grouped.map(([subject, list]) => {
            const isOpen = openSubjects.has(subject);
            const levelCounts = list.reduce((acc, q) => { acc[q.level] = (acc[q.level] || 0) + 1; return acc; }, {} as Record<number, number>);
            return (
              <div key={subject} className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
                {/* Header */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer transition-colors hover:bg-white/[0.02]"
                  onClick={() => toggleSubject(subject)}
                >
                  <div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.primary}22`, color: theme.primaryLight }}>
                    <BookOpen size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold font-mono truncate" style={{ color: theme.textMain }}>{subject}</div>
                    <div className="flex gap-2 mt-1 text-[10px] font-mono opacity-70">
                      <span style={{ color: theme.textMuted }}>{list.length} questions</span>
                      {[1, 2, 3].map(lvl => (
                        levelCounts[lvl] > 0 && (
                          <span key={lvl} className="px-1.5 py-0.5 rounded" style={{
                            backgroundColor: lvl === 1 ? `${theme.green}20` : lvl === 2 ? `${theme.amber}20` : `${theme.red}20`,
                            color: lvl === 1 ? theme.green : lvl === 2 ? theme.amber : theme.red,
                          }}>
                            N{lvl}: {levelCounts[lvl]}
                          </span>
                        )
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={e => { e.stopPropagation(); onExportSubject(subject); }}
                      title="Exporter ce cours"
                      className="p-2 rounded-lg border transition-all hover:scale-110"
                      style={{ borderColor: theme.border, color: theme.textMuted, backgroundColor: 'transparent' }}
                    >
                      <Download size={13} />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); onDeleteSubject(subject); }}
                      title="Supprimer tout ce cours"
                      className="p-2 rounded-lg border transition-all hover:scale-110"
                      style={{ borderColor: `${theme.red}40`, color: theme.red, backgroundColor: `${theme.red}11` }}
                    >
                      <Trash2 size={13} />
                    </button>
                    <div className="p-2 transition-transform" style={{ color: theme.textMuted, transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                      <ChevronRight size={16} />
                    </div>
                  </div>
                </div>

                {/* Body — collapsible list */}
                <AnimatePresence>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="overflow-hidden"
                    >
                      <div className="p-4 pt-0 space-y-3 border-t" style={{ borderColor: `${theme.border}50` }}>
                        {list.map((q) => (
                          <div key={q.id} className="p-4 rounded-xl border flex justify-between gap-4 items-start" style={{ backgroundColor: theme.bgDark, borderColor: theme.border }}>
                            <div className="flex-1 min-w-0 space-y-2">
                              <div className="flex flex-wrap gap-2 items-center">
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded" style={{
                                  backgroundColor: q.level === 1 ? `${theme.green}20` : q.level === 2 ? `${theme.amber}20` : `${theme.red}20`,
                                  color: q.level === 1 ? theme.green : q.level === 2 ? theme.amber : theme.red,
                                }}>
                                  NIV. {q.level}
                                </span>
                                <span className="text-[10px] font-mono opacity-60" style={{ color: theme.textMuted }}>⏱ {q.duration}s</span>
                                {q.tags?.slice(0, 2).map(t => (
                                  <span key={t} className="text-[9px] font-mono px-1.5 py-0.5 rounded opacity-60" style={{ backgroundColor: theme.bgPanel2, color: theme.textMuted }}>#{t}</span>
                                ))}
                              </div>
                              <h4 className="text-sm font-bold leading-relaxed" style={{ color: theme.textMain }}>{q.question}</h4>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 pt-1">
                                {q.choices.map((c, i) => (
                                  <div key={i} className={`p-2 rounded text-[11px] font-mono border ${i === q.correct ? 'font-bold' : ''}`} style={{
                                    backgroundColor: i === q.correct ? `${theme.green}15` : `${theme.bgPanel}80`,
                                    color: i === q.correct ? theme.green : theme.textMuted,
                                    borderColor: i === q.correct ? `${theme.green}40` : 'transparent',
                                  }}>
                                    {String.fromCharCode(65 + i)}) {c}
                                  </div>
                                ))}
                              </div>
                              {q.explanation && (
                                <p className="text-[11px] italic opacity-70" style={{ color: theme.textMuted }}>💡 {q.explanation}</p>
                              )}
                            </div>
                            <div className="flex flex-col gap-2 shrink-0">
                              <button
                                onClick={() => onEdit(q)}
                                className="p-2 rounded-lg border hover:scale-110 transition-all"
                                style={{ borderColor: theme.border, color: theme.textMuted }}
                                title="Modifier"
                              >
                                <Edit3 size={13} />
                              </button>
                              <button
                                onClick={() => onDeleteQuestion(q.id)}
                                className="p-2 rounded-lg border hover:scale-110 transition-all"
                                style={{ borderColor: `${theme.red}40`, color: theme.red }}
                                title="Supprimer"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })
        ) : (
          <div className="text-center py-12 border border-dashed rounded-xl opacity-60 font-mono" style={{ borderColor: theme.border }}>
            <HelpCircle size={36} className="mx-auto mb-2" />
            Aucune question dans ce chapitre.
          </div>
        )}
      </div>
    </motion.div>
  );
}

function StatsTab({ questions, theme }: { questions: Question[]; theme: ThemeColors }) {
  const [history, setHistory] = useState<StoredAnswer[]>(() => loadHistory());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_STORAGE_KEY) setHistory(loadHistory());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const stats = React.useMemo(() => {
    const total = history.length;
    const correct = history.filter(h => h.wasCorrect).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    const avgTime = total > 0 ? history.reduce((s, h) => s + h.time, 0) / total : 0;
    const failureRate = total > 0 ? ((total - correct) / total) * 100 : 0;

    // Per-subject accuracy
    const bySubject: Record<string, { correct: number; total: number }> = {};
    for (const h of history) {
      if (!bySubject[h.subject]) bySubject[h.subject] = { correct: 0, total: 0 };
      bySubject[h.subject].total++;
      if (h.wasCorrect) bySubject[h.subject].correct++;
    }
    const subjectStats = Object.entries(bySubject).map(([name, v]) => ({
      name,
      pct: v.total > 0 ? (v.correct / v.total) * 100 : 0,
      total: v.total,
    })).sort((a, b) => b.total - a.total);

    // Level distribution in the question pool
    const byLevel = { 1: 0, 2: 0, 3: 0 };
    for (const q of questions) {
      const l = q.level as 1 | 2 | 3;
      if (l in byLevel) byLevel[l]++;
    }
    const totalLevels = Math.max(1, questions.length);

    return { total, accuracy, avgTime, failureRate, subjectStats, byLevel, totalLevels };
  }, [history, questions]);

  const handleReset = () => {
    if (!confirm("Effacer tout l'historique d'apprentissage ?")) return;
    try { localStorage.removeItem(HISTORY_STORAGE_KEY); } catch {}
    setHistory([]);
  };

  return (
    <motion.div key="stats-workspace" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} className="space-y-8">
      <div className="flex justify-between items-center">
        <div className="text-xs font-mono uppercase tracking-widest" style={{ color: theme.textMuted }}>
          {stats.total} réponses enregistrées localement
        </div>
        {stats.total > 0 && (
          <button onClick={handleReset} className="px-3 py-1.5 text-[10px] font-mono uppercase border rounded-lg hover:text-white transition-all" style={{ borderColor: theme.border, color: theme.textMuted }}>
            Réinitialiser l'historique
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard label="Taux de réussite" value={stats.total > 0 ? `${stats.accuracy.toFixed(1)}%` : '—'} pct={stats.accuracy} color="#10b981" theme={theme} />
        <StatCard label="Questions au catalogue" value={`${questions.length}`} pct={100} color="#a855f7" theme={theme} />
        <StatCard label="Temps de réponse moyen" value={stats.total > 0 ? `${stats.avgTime.toFixed(1)}s` : '—'} pct={Math.min(100, (stats.avgTime / 15) * 100)} color="#00f5d4" theme={theme} />
        <StatCard label="Taux d'échec" value={stats.total > 0 ? `${stats.failureRate.toFixed(1)}%` : '—'} pct={stats.failureRate} color="#ef4444" theme={theme} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="p-6 rounded-2xl border" style={{ backgroundColor: theme.bgPanel2, borderColor: theme.border }}>
          <h4 className="text-sm font-bold font-mono text-white mb-6 uppercase tracking-wider flex items-center gap-2">
            <BarChart2 size={16} style={{ color: theme.accent1 }} /> Réussite par chapitre
          </h4>
          {stats.subjectStats.length === 0 ? (
            <div className="text-xs font-mono opacity-60 text-center py-8" style={{ color: theme.textMuted }}>
              Aucune donnée. Jouez d'abord pour générer des statistiques.
            </div>
          ) : (
            <div className="space-y-4">
              {stats.subjectStats.map((s, i) => (
                <div key={s.name}>
                  <div className="flex justify-between items-center text-xs font-mono mb-1">
                    <span className="text-white truncate max-w-[200px]">{s.name} <span className="opacity-50">({s.total})</span></span>
                    <span style={{ color: theme.accent1 }}>{s.pct.toFixed(0)}%</span>
                  </div>
                  <div className="w-full bg-black/50 h-2 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${s.pct}%`, backgroundColor: i % 3 === 0 ? theme.primary : i % 3 === 1 ? theme.accent1 : theme.amber }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 rounded-2xl border flex flex-col" style={{ backgroundColor: theme.bgPanel2, borderColor: theme.border }}>
          <h4 className="text-sm font-bold font-mono text-white mb-4 uppercase tracking-wider flex items-center gap-2">
            <Brain size={16} style={{ color: theme.primaryLight }} /> Répartition des niveaux (catalogue)
          </h4>
          <div className="space-y-3 mt-2">
            {[1, 2, 3].map(lvl => {
              const count = stats.byLevel[lvl as 1 | 2 | 3];
              const pct = stats.totalLevels > 0 ? (count / stats.totalLevels) * 100 : 0;
              const color = lvl === 1 ? '#10b981' : lvl === 2 ? '#fbbf24' : '#ef4444';
              return (
                <div key={lvl}>
                  <div className="flex justify-between items-center text-xs font-mono mb-1">
                    <span className="text-white">Niveau {lvl} <span className="opacity-50">({count})</span></span>
                    <span style={{ color }}>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="w-full bg-black/50 h-2 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function StatCard({ label, value, pct, color, theme }: { label: string; value: string; pct: number; color: string; theme: ThemeColors }) {
  return (
    <div className="p-5 rounded-2xl border" style={{ backgroundColor: theme.bgPanel, borderColor: theme.border }}>
      <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: theme.textMuted }}>{label}</div>
      <div className="text-3xl font-mono font-bold text-white">{value}</div>
      <div className="w-full bg-black/40 h-1.5 rounded-full mt-3 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function ReportTile({ label, value, sub, color, theme }: { label: string; value: string; sub?: string; color: string; theme: ThemeColors }) {
    return (
        <div className="p-4 rounded-xl border" style={{ backgroundColor: theme.bgDark, borderColor: theme.border }}>
            <div className="text-[9px] uppercase font-mono font-bold tracking-widest" style={{ color: theme.textMuted }}>{label}</div>
            <div className="text-2xl font-mono font-bold mt-1" style={{ color }}>{value}</div>
            {sub && <div className="text-[10px] font-mono opacity-60 mt-0.5" style={{ color: theme.textMuted }}>{sub}</div>}
        </div>
    );
}

function LearningReport({ history, questions, theme }: { history: AnswerHistory[]; questions: Question[]; theme: ThemeColors }) {
    if (history.length === 0) {
        return (
            <div className="text-center py-6 border border-dashed rounded-xl text-xs font-mono opacity-60" style={{ borderColor: theme.border, color: theme.textMuted }}>
                Aucune question répondue durant cette partie.
            </div>
        );
    }

    // Group by subject
    type Entry = AnswerHistory & { q: Question };
    const enriched: Entry[] = history
        .map(h => ({ ...h, q: questions.find(q => q.id === h.questionId)! }))
        .filter(x => x.q);

    const bySubject: Record<string, { total: number; correct: number; missed: Entry[] }> = {};
    for (const e of enriched) {
        const s = e.q.subject || 'Autres';
        if (!bySubject[s]) bySubject[s] = { total: 0, correct: 0, missed: [] };
        bySubject[s].total++;
        if (e.wasCorrect) bySubject[s].correct++;
        else bySubject[s].missed.push(e);
    }
    const subjects = Object.entries(bySubject).sort((a, b) => b[1].total - a[1].total);
    const totalMissed = enriched.filter(e => !e.wasCorrect).length;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between border-t pt-4" style={{ borderColor: `${theme.border}80` }}>
                <h3 className="text-sm font-mono font-bold uppercase tracking-widest flex items-center gap-2" style={{ color: theme.accent1 }}>
                    <Brain size={16} /> Rapport d'apprentissage
                </h3>
                <span className="text-[10px] font-mono opacity-70" style={{ color: theme.textMuted }}>
                    {enriched.length - totalMissed}/{enriched.length} réussies
                </span>
            </div>

            <div className="space-y-2">
                {subjects.map(([subject, s]) => {
                    const pct = Math.round((s.correct / s.total) * 100);
                    const barColor = pct >= 80 ? theme.green : pct >= 50 ? theme.amber : theme.red;
                    return (
                        <div key={subject}>
                            <div className="flex justify-between items-center text-xs font-mono mb-1">
                                <span className="text-white truncate max-w-[60%]">{subject}</span>
                                <span style={{ color: barColor }}>{s.correct}/{s.total} · {pct}%</span>
                            </div>
                            <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: `${theme.border}80` }}>
                                <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: barColor, boxShadow: `0 0 6px ${barColor}` }} />
                            </div>
                        </div>
                    );
                })}
            </div>

            {totalMissed > 0 && (
                <details className="mt-2 group" open>
                    <summary className="cursor-pointer text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-2 select-none" style={{ color: theme.red }}>
                        <AlertCircle size={14} /> À revoir ({totalMissed})
                        <span className="text-[10px] opacity-50 group-open:hidden">▾ cliquez pour ouvrir</span>
                    </summary>
                    <div className="space-y-3 mt-3 max-h-64 overflow-y-auto pr-2">
                        {subjects.flatMap(([subject, s]) =>
                            s.missed.map((item, idx) => (
                                <div key={`${subject}-${item.questionId}-${idx}`} className="p-3 rounded-lg border text-xs space-y-1" style={{ backgroundColor: theme.bgDark, borderColor: `${theme.red}40` }}>
                                    <div className="flex justify-between items-start gap-2">
                                        <span className="font-mono font-bold text-white">{item.q.question}</span>
                                        <span className="text-[9px] font-mono opacity-50 whitespace-nowrap" style={{ color: theme.textMuted }}>{subject} · N{item.q.level}</span>
                                    </div>
                                    <div className="flex items-center gap-2 text-[11px]" style={{ color: theme.green }}>
                                        <CheckCircle size={12} /> <span className="font-mono">{item.q.choices[item.q.correct]}</span>
                                    </div>
                                    {item.q.explanation && (
                                        <div className="text-[11px] italic opacity-80" style={{ color: theme.textMuted }}>
                                            💡 {item.q.explanation}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </details>
            )}
        </div>
    );
}

function HeartHPBar({ hp, max, theme }: { hp: number; max: number; theme: ThemeColors }) {
    const pct = Math.max(0, Math.min(1, hp / max));
    const danger = pct < 0.35;
    const color = danger ? theme.red : pct < 0.7 ? theme.amber : theme.accent1;
    return (
        <div className={`flex items-center gap-3 backdrop-blur-xl border-2 p-2 pr-5 rounded-2xl shadow-[0_0_30px_rgba(0,0,0,0.5)] ${danger ? 'animate-pulse' : ''}`}
             style={{ backgroundColor: `${theme.bgPanel}A6`, borderColor: danger ? theme.red : `${color}66`, boxShadow: `0 0 20px ${color}66` }}>
            <div className="p-3 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${color}40`, color }}>
                <Brain size={20} className="drop-shadow-[0_0_8px_currentColor]" />
            </div>
            <div className="flex flex-col">
                <div className="flex items-baseline gap-2">
                    <div className="text-2xl font-mono font-bold tracking-tight" style={{ color }}>{hp}</div>
                    <div className="text-[10px] font-mono opacity-50">/ {max}</div>
                </div>
                <div className="w-28 h-1.5 rounded-full overflow-hidden mt-1" style={{ backgroundColor: `${theme.border}80` }}>
                    <div className="h-full rounded-full transition-all duration-200" style={{ width: `${pct * 100}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
                </div>
                <div className="text-[9px] font-mono uppercase font-bold tracking-widest mt-1 opacity-80" style={{ color: danger ? theme.red : theme.textMuted }}>
                    CŒUR
                </div>
            </div>
        </div>
    );
}

function AmmoCounter({ ammo, max, theme }: { ammo: number; max: number; theme: ThemeColors }) {
    const isEmpty = ammo <= 0;
    const isLow = ammo <= 3 && !isEmpty;
    const color = isEmpty ? theme.red : isLow ? theme.amber : theme.accent1;
    const pct = Math.max(0, Math.min(1, ammo / max));
    return (
        <div className={`flex items-center gap-3 backdrop-blur-xl border p-2 pr-5 rounded-2xl shadow-[0_0_30px_rgba(0,0,0,0.5)] ${isEmpty ? 'animate-pulse' : ''}`}
             style={{ backgroundColor: `${theme.bgPanel}A6`, borderColor: isEmpty ? `${theme.red}80` : `${theme.border}80` }}>
            <div className="p-3 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${color}40`, color }}>
                <Zap size={20} className="drop-shadow-[0_0_8px_currentColor]" />
            </div>
            <div className="flex flex-col">
                <div className="flex items-baseline gap-2">
                    <div className="text-2xl font-mono font-bold tracking-tight text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.4)]" style={{ color: isEmpty ? theme.red : undefined }}>
                        {ammo}
                    </div>
                    <div className="text-[10px] font-mono opacity-50">/ {max}</div>
                </div>
                <div className="w-24 h-1.5 rounded-full overflow-hidden mt-1" style={{ backgroundColor: `${theme.border}80` }}>
                    <div className="h-full rounded-full transition-all duration-200" style={{ width: `${pct * 100}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
                </div>
                <div className="text-[9px] font-mono uppercase font-bold tracking-widest mt-1 opacity-80" style={{ color: isEmpty ? theme.red : theme.textMuted }}>
                    {isEmpty ? 'VIDE — RÉPONDS' : 'MUNITIONS'}
                </div>
            </div>
        </div>
    );
}

function HPBar({ hp, max, theme }: { hp: number; max: number; theme: ThemeColors }) {
    const pct = Math.max(0, Math.min(1, hp / max));
    const color = hp <= 1 ? theme.red : hp === 2 ? theme.amber : theme.primaryLight;
    return (
        <div className="flex items-center gap-3 backdrop-blur-xl border p-2 pr-5 rounded-2xl shadow-[0_0_30px_rgba(0,0,0,0.5)]"
             style={{ backgroundColor: `${theme.bgPanel}A6`, borderColor: `${theme.border}80` }}>
            <div className="p-3 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${color}40`, color }}>
                <Shield size={20} className="drop-shadow-[0_0_8px_currentColor]" />
            </div>
            <div className="flex flex-col">
                <div className="flex gap-1 mb-1">
                    {Array.from({ length: max }).map((_, i) => (
                        <div key={i} className="w-6 h-2 rounded-sm transition-colors"
                             style={{ backgroundColor: i < hp ? color : `${theme.border}80`, boxShadow: i < hp ? `0 0 6px ${color}` : 'none' }} />
                    ))}
                </div>
                <div className="text-[9px] font-mono uppercase font-bold tracking-widest opacity-80" style={{ color: theme.textMuted }}>VITALITÉ</div>
            </div>
        </div>
    );
}

function MiniMap({ maze, playerPos, enemies, pickups, theme }: { maze: Maze, playerPos: { x: number, y: number }, enemies: { x: number, y: number }[], pickups?: { x: number, y: number, type: PickupType }[], theme: ThemeColors }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);

    const CELL = 6;
    const width = maze.width * CELL;
    const height = maze.height * CELL;

    // Pre-render the static maze layer once (per maze/theme) onto an offscreen canvas
    useEffect(() => {
        const bg = document.createElement('canvas');
        bg.width = width;
        bg.height = height;
        const ctx = bg.getContext('2d');
        if (!ctx) return;
        for (let y = 0; y < maze.height; y++) {
            for (let x = 0; x < maze.width; x++) {
                const cell = maze.grid[y][x];
                if (cell === 0) continue;
                let color = theme.bgPanel;
                let alpha = 1;
                if (cell === 1) { color = theme.border; alpha = 0.3; }
                else if (cell === 2) color = theme.red;
                else if (cell === 3) color = theme.primary;
                else if (cell === 5) color = theme.accent1;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = color;
                ctx.fillRect(x * CELL, y * CELL, CELL - 0.5, CELL - 0.5);
            }
        }
        ctx.globalAlpha = 1;
        bgCanvasRef.current = bg;
    }, [maze, theme]);

    // Redraw dynamic layer (player + enemies + pickups) on every prop change
    useEffect(() => {
        const canvas = canvasRef.current;
        const bg = bgCanvasRef.current;
        if (!canvas || !bg || !playerPos) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(bg, 0, 0);

        // Pickups (draw below enemies so enemies overlap if at same cell)
        for (const p of pickups || []) {
            const cfg = PICKUP_CONFIGS[p.type];
            const color = theme[cfg.themeColorKey] as string;
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 8;
            // Diamond shape for clear distinction from circles
            ctx.beginPath();
            ctx.moveTo(p.x * CELL, p.y * CELL - 2.5);
            ctx.lineTo(p.x * CELL + 2.5, p.y * CELL);
            ctx.lineTo(p.x * CELL, p.y * CELL + 2.5);
            ctx.lineTo(p.x * CELL - 2.5, p.y * CELL);
            ctx.closePath();
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // Enemies
        ctx.fillStyle = theme.red;
        ctx.shadowColor = theme.red;
        ctx.shadowBlur = 5;
        for (const e of enemies || []) {
            ctx.beginPath();
            ctx.arc(e.x * CELL, e.y * CELL, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Player
        ctx.fillStyle = theme.primaryLight;
        ctx.shadowColor = theme.primaryLight;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(playerPos.x * CELL, playerPos.y * CELL, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }, [playerPos, enemies, pickups, theme, width, height]);

    if (!playerPos) return null;

    return (
        <div className="backdrop-blur-xl border p-2 rounded-2xl shadow-[0_0_30px_rgba(0,0,0,0.5)] overflow-hidden"
             style={{ backgroundColor: `${theme.bgDark}E6`, borderColor: theme.border }}>
            <canvas ref={canvasRef} width={width} height={height} style={{ display: 'block', width, height }} />
            <div className="mt-2 text-[8px] font-mono text-center uppercase tracking-widest font-bold" style={{ color: theme.textMuted }}>NEURAL TOPOGRAPHY</div>
        </div>
    );
}

/**
 * Floating joystick zone — covers the left half of the screen.
 * The joystick is invisible until the player touches; on pointer-down it
 * materializes under the finger and follows it. On release it disappears.
 *
 * This is the standard mobile twin-stick control (PUBG, Genshin, COD Mobile):
 * the player never has to look for the joystick — it's where their thumb is.
 */
function FloatingJoystickZone({ onMove, theme }: { onMove: (v: { x: number, z: number }) => void, theme: ThemeColors }) {
    const [origin, setOrigin] = useState<{ x: number, y: number } | null>(null);
    const [knob, setKnob] = useState({ x: 0, y: 0 });
    const activePointerRef = useRef<number | null>(null);
    const MAX_DIST = 55; // px — radius before joystick saturates at 100% speed

    const updateFromPointer = (e: React.PointerEvent, originPt: { x: number, y: number }) => {
        const dx = e.clientX - originPt.x;
        const dy = e.clientY - originPt.y;
        const dist = Math.hypot(dx, dy);
        // clamp knob visual to the joystick ring
        const clampedDist = Math.min(dist, MAX_DIST);
        const angle = dist > 0 ? Math.atan2(dy, dx) : 0;
        setKnob({ x: Math.cos(angle) * clampedDist, y: Math.sin(angle) * clampedDist });
        // movement vector is normalized to [-1, 1]
        const nx = Math.min(Math.max(dx / MAX_DIST, -1), 1);
        const ny = Math.min(Math.max(dy / MAX_DIST, -1), 1);
        onMove({ x: nx, z: ny });
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        if (activePointerRef.current !== null) return;
        activePointerRef.current = e.pointerId;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const originPt = { x: e.clientX, y: e.clientY };
        setOrigin(originPt);
        setKnob({ x: 0, y: 0 });
        onMove({ x: 0, z: 0 });
        // subtle haptic on touchstart
        try { (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(8); } catch { /* ignore */ }
    };
    const handlePointerMove = (e: React.PointerEvent) => {
        if (activePointerRef.current !== e.pointerId || !origin) return;
        updateFromPointer(e, origin);
    };
    const handlePointerUp = (e: React.PointerEvent) => {
        if (activePointerRef.current !== e.pointerId) return;
        activePointerRef.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        setOrigin(null);
        setKnob({ x: 0, y: 0 });
        onMove({ x: 0, z: 0 });
    };

    return (
        <div
            className="absolute inset-y-0 left-0 z-[55] select-none"
            // Covers the left ~55% of the screen so the player can put their
            // thumb anywhere comfortable. The right side is reserved for action buttons.
            style={{ width: '55%', touchAction: 'none', WebkitTapHighlightColor: 'transparent' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
        >
            {origin && (
                <>
                    {/* Outer ring (joystick origin where finger first touched) */}
                    <div
                        className="absolute rounded-full border-2 pointer-events-none"
                        style={{
                            left: origin.x - 65, top: origin.y - 65,
                            width: 130, height: 130,
                            borderColor: `${theme.primaryLight}66`,
                            backgroundColor: `${theme.bgDark}55`,
                            backdropFilter: 'blur(8px)',
                            boxShadow: `0 0 24px ${theme.primary}33`,
                        }}
                    />
                    {/* Inner knob (follows the finger) */}
                    <motion.div
                        className="absolute rounded-full shadow-2xl border-2 pointer-events-none"
                        style={{
                            left: origin.x - 28, top: origin.y - 28,
                            width: 56, height: 56,
                            background: `radial-gradient(circle at 30% 30%, ${theme.primaryLight}, ${theme.primary})`,
                            borderColor: 'rgba(255,255,255,0.35)',
                            boxShadow: `0 4px 20px ${theme.primary}88`,
                        }}
                        animate={{ x: knob.x, y: knob.y }}
                        transition={{ type: 'spring', damping: 18, stiffness: 320 }}
                    />
                </>
            )}
        </div>
    );
}

/**
 * Touch action buttons for mobile play.
 * Layout (bottom-right cluster + pause/camera floating top):
 *   - FIRE (big, holds = continuous fire while pressed)
 *   - BUILD (medium, visible only when canBuild)
 *   - CAMERA cycle (small)
 *   - PAUSE (small, top-right corner)
 */
function MobileTouchControls({
    theme, canBuild, onFireDown, onFireUp, onBuild, onCycleCamera, onPause,
}: {
    theme: ThemeColors;
    canBuild: boolean;
    onFireDown: () => void;
    onFireUp: () => void;
    onBuild: () => void;
    onCycleCamera: () => void;
    onPause: () => void;
}) {
    return (
        <>
            {/* Pause + camera in the top-right corner */}
            <div className="absolute top-24 right-4 z-[60] flex flex-col gap-2 pointer-events-auto">
                <button
                    aria-label="Pause"
                    onPointerDown={(e) => { e.preventDefault(); try { navigator.vibrate?.(8); } catch {}; onPause(); }}
                    className="w-12 h-12 rounded-full border-2 backdrop-blur-md flex items-center justify-center active:scale-90 transition-transform"
                    style={{ backgroundColor: `${theme.bgPanel}CC`, borderColor: theme.border, color: theme.textMain, touchAction: 'manipulation' }}
                >
                    <Pause size={18} />
                </button>
                <button
                    aria-label="Changer caméra"
                    onPointerDown={(e) => { e.preventDefault(); try { navigator.vibrate?.(8); } catch {}; onCycleCamera(); }}
                    className="w-12 h-12 rounded-full border-2 backdrop-blur-md flex items-center justify-center active:scale-90 transition-transform"
                    style={{ backgroundColor: `${theme.bgPanel}CC`, borderColor: theme.border, color: theme.accent2, touchAction: 'manipulation' }}
                >
                    <Target size={18} />
                </button>
            </div>

            {/* Bottom-right action cluster */}
            <div className="absolute bottom-10 right-6 z-[60] flex flex-col items-end gap-3 pointer-events-auto">
                <AnimatePresence>
                    {canBuild && (
                        <motion.button
                            initial={{ opacity: 0, scale: 0.6, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.6, y: 20 }}
                            aria-label="Bâtir une tour"
                            onPointerDown={(e) => { e.preventDefault(); try { navigator.vibrate?.(12); } catch {}; onBuild(); }}
                            className="w-16 h-16 rounded-full border-2 backdrop-blur-md flex items-center justify-center font-mono font-black active:scale-90 transition-transform shadow-lg"
                            style={{ backgroundColor: `${theme.primary}CC`, borderColor: theme.primaryLight, color: 'white', boxShadow: `0 0 20px ${theme.primary}88`, touchAction: 'manipulation' }}
                        >
                            <span className="text-lg">🛠</span>
                        </motion.button>
                    )}
                </AnimatePresence>

                <button
                    aria-label="Tirer"
                    onPointerDown={(e) => { e.preventDefault(); try { navigator.vibrate?.(10); } catch {}; onFireDown(); }}
                    onPointerUp={(e) => { e.preventDefault(); onFireUp(); }}
                    onPointerCancel={() => onFireUp()}
                    onPointerLeave={() => onFireUp()}
                    className="w-24 h-24 rounded-full border-4 backdrop-blur-md flex items-center justify-center font-mono font-black active:scale-95 transition-transform shadow-2xl"
                    style={{
                        backgroundColor: `${theme.accent1}DD`,
                        borderColor: theme.accent1,
                        color: theme.bgDark,
                        boxShadow: `0 0 30px ${theme.accent1}66`,
                        touchAction: 'manipulation',
                    }}
                >
                    <Zap size={32} className="drop-shadow-lg" />
                </button>
            </div>
        </>
    );
}

function HUDStat({ icon: Icon, value, label, color, bg, theme }: any) {
    return (
        <div className="flex items-center gap-4 backdrop-blur-xl border p-2 pr-6 rounded-2xl shadow-[0_0_30px_rgba(0,0,0,0.5)] relative overflow-hidden group"
             style={{ backgroundColor: `${theme.bgPanel}A6`, borderColor: `${theme.border}80` }}>
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />
            <div className="p-3 rounded-xl transition-transform group-hover:scale-110 flex items-center justify-center shadow-inner" style={{ backgroundColor: bg + '40', color }}>
                <Icon size={20} className="drop-shadow-[0_0_8px_currentColor]" />
            </div>
            <div className="relative z-10">
                <div className="text-2xl font-mono font-bold leading-none tracking-tight text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.4)]">{value}</div>
                <div className="text-[9px] font-mono uppercase font-bold tracking-widest mt-1 opacity-80" style={{ color: theme.textMuted }}>{label}</div>
            </div>
        </div>
    );
}
