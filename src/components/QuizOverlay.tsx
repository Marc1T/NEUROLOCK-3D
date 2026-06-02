import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { Question, ThemeColors } from '../types';
import { AudioEngine } from '../game/Audio';
import { useIsTouchDevice } from '../lib/useIsTouchDevice';
import { CheckCircle2, XCircle, Clock as ClockIcon, Lock, Zap, Flame, ChevronRight } from 'lucide-react';

type QuizStatus = 'pending' | 'correct' | 'wrong' | 'timeout';
type QuizSource = 'door' | 'tower';

interface QuizOverlayProps {
  question: Question;
  theme: ThemeColors;
  onAnswer: (correct: boolean) => void;
  source?: QuizSource;
  currentStreak?: number;
  streakMultiplierAhead?: number; // multiplier the player would unlock with a correct answer
}

const MIN_DURATION = 12; // seconds — floor so even tight questions are readable

const LEVEL_LABEL: Record<number, string> = { 1: 'Facile', 2: 'Moyen', 3: 'Difficile' };
const LEVEL_COLOR_KEY: Record<number, keyof ThemeColors> = { 1: 'green', 2: 'amber', 3: 'red' };

export function QuizOverlay({
  question,
  theme,
  onAnswer,
  source = 'door',
  currentStreak = 0,
  streakMultiplierAhead,
}: QuizOverlayProps) {
  const totalDuration = Math.max(question.duration || MIN_DURATION, MIN_DURATION);
  const isTouch = useIsTouchDevice();
  const [selected, setSelected] = useState<number | null>(null);
  const [timer, setTimer] = useState(totalDuration);
  const [status, setStatus] = useState<QuizStatus>('pending');
  const statusRef = useRef<QuizStatus>('pending');

  const sourceLabel = source === 'tower' ? 'SOCLE DÉFENSIF' : 'PORTE VERROUILLÉE';
  const sourceIcon = source === 'tower' ? <Zap size={14} /> : <Lock size={14} />;

  const handleAnswer = useCallback((idx: number) => {
    if (statusRef.current !== 'pending') return;
    setSelected(idx);
    const isCorrect = idx === question.correct;
    const nextStatus: QuizStatus = isCorrect ? 'correct' : (idx === -1 ? 'timeout' : 'wrong');
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    if (isCorrect) AudioEngine.playCorrect();
    else AudioEngine.playWrong();
  }, [question.correct]);

  const handleContinue = useCallback(() => {
    onAnswer(statusRef.current === 'correct');
  }, [onAnswer]);

  // Countdown timer
  useEffect(() => {
    AudioEngine.duck();
    const interval = setInterval(() => {
      setTimer(t => {
        if (statusRef.current !== 'pending') return t; // freeze when answered
        if (t <= 0.1) {
          handleAnswer(-1);
          return 0;
        }
        return t - 0.1;
      });
    }, 100);
    return () => {
      clearInterval(interval);
      AudioEngine.unduck();
    };
  }, [handleAnswer]);

  // Keyboard shortcuts: 1-4 / A-D to answer, Enter / Space to continue after answering
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (statusRef.current === 'pending') {
        const idxFromDigit = key >= '1' && key <= '4' ? Number(key) - 1 : -1;
        const idxFromLetter = ['a', 'b', 'c', 'd'].indexOf(key);
        const idx = idxFromDigit !== -1 ? idxFromDigit : idxFromLetter;
        if (idx >= 0 && idx < question.choices.length) {
          handleAnswer(idx);
          e.preventDefault();
          e.stopPropagation();
        }
      } else {
        if (key === 'enter' || key === ' ') {
          handleContinue();
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    // capture phase so it wins over the engine's keydown (which fires shots on space)
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true } as any);
  }, [handleAnswer, handleContinue, question.choices.length]);

  const levelKey = LEVEL_COLOR_KEY[question.level] || 'amber';
  const levelColor = theme[levelKey] as string;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="max-w-2xl w-full border-2 rounded-3xl p-6 md:p-8 shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden relative backdrop-blur-2xl"
      style={{ backgroundColor: `${theme.bgPanel}F2`, borderColor: theme.border }}
    >
      {/* Status glow */}
      <div className="absolute inset-0 opacity-10 pointer-events-none transition-colors duration-500"
           style={{ backgroundColor: status === 'correct' ? theme.green : ((status === 'wrong' || status === 'timeout') ? theme.red : 'transparent') }} />

      {/* Header — source + subject + level + timer */}
      <div className="flex flex-wrap justify-between items-center gap-3 mb-6 relative z-10">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest uppercase"
               style={{ backgroundColor: source === 'tower' ? `${theme.accent1}22` : `${theme.red}22`, color: source === 'tower' ? theme.accent1 : theme.red, border: `1px solid ${source === 'tower' ? theme.accent1 : theme.red}66` }}>
            {sourceIcon} {sourceLabel}
          </div>
          <div className="px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest text-white"
               style={{ backgroundColor: theme.primary }}>
            {question.subject.toUpperCase()}
          </div>
          <div className="px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest"
               style={{ backgroundColor: `${levelColor}22`, color: levelColor, border: `1px solid ${levelColor}66` }}>
            NIV {question.level} · {LEVEL_LABEL[question.level] || '—'}
          </div>
        </div>
        <div className={`text-2xl font-mono font-bold flex items-center gap-2 ${timer < 3 && status === 'pending' ? 'animate-pulse' : ''}`}
             style={{ color: timer < 3 ? theme.red : theme.amber }}>
          <ClockIcon size={20} /> {timer.toFixed(1)}s
        </div>
      </div>

      {/* Question */}
      <h2 className="text-2xl md:text-3xl font-bold mb-6 leading-tight relative z-10" style={{ color: theme.textMain }}>
        {question.question}
      </h2>

      {/* Choices */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6 relative z-10">
        {question.choices.map((choice, i) => {
          const letter = ['A', 'B', 'C', 'D'][i];
          const isSelected = selected === i;
          const showCorrect = status !== 'pending' && i === question.correct;
          const showWrong = isSelected && (status === 'wrong');
          let bg = theme.bgDark;
          let border = theme.border;
          let color = theme.textMain;
          if (showCorrect) { bg = `${theme.green}22`; border = theme.green; color = theme.green; }
          else if (showWrong) { bg = `${theme.red}22`; border = theme.red; color = theme.red; }
          return (
            <button
              key={i}
              onClick={() => handleAnswer(i)}
              disabled={status !== 'pending'}
              className={`p-4 md:p-5 text-left rounded-2xl border-2 transition-all duration-300 group flex items-center gap-3 shadow-lg ${status === 'pending' ? 'cursor-pointer' : 'cursor-default'}`}
              style={{ backgroundColor: bg, borderColor: border, color }}
              onMouseEnter={(e) => {
                if (status === 'pending') {
                  e.currentTarget.style.borderColor = theme.primary;
                  e.currentTarget.style.backgroundColor = theme.bgPanel;
                }
              }}
              onMouseLeave={(e) => {
                if (status === 'pending') {
                  e.currentTarget.style.borderColor = theme.border;
                  e.currentTarget.style.backgroundColor = theme.bgDark;
                }
              }}
            >
              <div className="font-mono text-xs font-black w-7 h-7 flex items-center justify-center rounded-md shrink-0"
                   style={{ backgroundColor: showCorrect ? theme.green : showWrong ? theme.red : `${theme.primary}33`, color: showCorrect || showWrong ? 'white' : theme.primaryLight }}>
                {letter}
              </div>
              <span className="flex-1 font-medium text-sm md:text-base">{choice}</span>
              {showCorrect && <CheckCircle2 size={18} style={{ color: theme.green }} />}
              {showWrong && <XCircle size={18} style={{ color: theme.red }} />}
            </button>
          );
        })}
      </div>

      {/* Timer progress bar */}
      <div className="h-2 rounded-full overflow-hidden mb-4" style={{ backgroundColor: `${theme.border}44` }}>
        <motion.div
          className="h-full"
          style={{ backgroundColor: timer < 3 ? theme.red : theme.amber }}
          animate={{ width: `${(timer / totalDuration) * 100}%` }}
          transition={{ duration: 0.1 }}
        />
      </div>

      {/* Footer — context hints (combo preview, keyboard hint) */}
      {status === 'pending' && (
        <div className="flex flex-wrap justify-between items-center gap-2 text-[11px] font-mono relative z-10" style={{ color: theme.textMuted }}>
          <div className="flex items-center gap-3">
            {isTouch ? (
              <span className="opacity-70">Touche une réponse</span>
            ) : (
              <span className="opacity-70">
                <kbd className="px-1.5 py-0.5 rounded font-bold mr-1" style={{ backgroundColor: `${theme.border}80`, color: theme.textMain }}>1-4</kbd>
                ou
                <kbd className="px-1.5 py-0.5 rounded font-bold ml-1" style={{ backgroundColor: `${theme.border}80`, color: theme.textMain }}>A-D</kbd>
                répondre
              </span>
            )}
          </div>
          {currentStreak >= 1 && streakMultiplierAhead && streakMultiplierAhead > 1 && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full"
                 style={{ backgroundColor: `${theme.amber}22`, color: theme.amber, border: `1px solid ${theme.amber}66` }}>
              <Flame size={12} /> Si juste : <span className="font-black">COMBO ×{streakMultiplierAhead}</span>
            </div>
          )}
        </div>
      )}

      {/* Explanation block (after answer) */}
      {status !== 'pending' && (
        <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
                    className="p-5 rounded-2xl border flex gap-4 items-start shadow-xl mt-2 relative z-10"
                    style={{ backgroundColor: `${theme.bgDark}CC`, borderColor: status === 'correct' ? theme.green : theme.red }}>
          {status === 'correct'
            ? <CheckCircle2 size={28} style={{ color: theme.green }} className="shrink-0 mt-0.5" />
            : <XCircle size={28} style={{ color: theme.red }} className="shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0">
            <div className="font-bold mb-1 text-base md:text-lg" style={{ color: status === 'correct' ? theme.green : theme.red }}>
              {status === 'correct' ? 'SYNCHRONISATION RÉUSSIE' : (status === 'timeout' ? 'DÉLAI DÉPASSÉ' : 'ACCÈS REFUSÉ')}
            </div>
            {question.explanation && (
              <p className="text-sm leading-relaxed" style={{ color: theme.textMain }}>
                💡 {question.explanation}
              </p>
            )}
            {status !== 'correct' && (
              <p className="text-xs mt-2 font-mono" style={{ color: theme.textMuted }}>
                Bonne réponse : <span className="font-bold" style={{ color: theme.green }}>
                  {String.fromCharCode(65 + question.correct)} — {question.choices[question.correct]}
                </span>
              </p>
            )}
          </div>
          <button
            onClick={handleContinue}
            autoFocus
            className="shrink-0 px-4 py-2.5 rounded-xl font-mono text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all hover:scale-105 cursor-pointer"
            style={{ backgroundColor: status === 'correct' ? theme.green : theme.primary, color: 'white', boxShadow: `0 4px 12px ${status === 'correct' ? theme.green : theme.primary}66` }}
          >
            Continuer <ChevronRight size={14} />
            {!isTouch && (
              <kbd className="ml-1 px-1 py-0.5 text-[9px] rounded opacity-80" style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}>↵</kbd>
            )}
          </button>
        </motion.div>
      )}
    </motion.div>
  );
}
