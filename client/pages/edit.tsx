// Quiz editor. Autosaves (debounced) over PUT. While any session of this quiz
// is live, the server locks editing (409) — the editor flips to read-only with
// a banner. The edit URL itself is the host's only "login".

import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, getQuiz, saveQuiz, startSession, store } from '../api';
import { nav } from '../state';
import { validateQuiz } from '../../shared/validate.ts';
import type { Question, Quiz } from '../../shared/types.ts';
import { OptionShape, Wordmark } from '../ui';

const TIME_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const TYPE_LABEL: Record<Question['type'], string> = {
  choice: 'Multiple choice',
  truefalse: 'True / False',
  short: 'Short answer',
  likert: 'Likert scale',
};
const rid = () => Math.random().toString(36).slice(2, 10);

function newQuestion(type: Question['type']): Question {
  const base = { id: rid(), prompt: '', timeLimitSec: 20 };
  switch (type) {
    case 'choice':
      return { ...base, type: 'choice', options: ['', '', '', ''], correct: 0 };
    case 'truefalse':
      return { ...base, type: 'truefalse', answer: true };
    case 'short':
      return { ...base, type: 'short', accepted: [''] };
    case 'likert':
      return { ...base, type: 'likert', likertMin: 1, likertMax: 5 };
  }
}

export default function Edit({ id, token }: { id: string; token: string }) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'saving' | 'saved' | 'error' | 'notfound'>('loading');
  const [errors, setErrors] = useState<string[]>([]);
  const [goingLive, setGoingLive] = useState(false);
  const [copied, setCopied] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    getQuiz(id, token)
      .then((q) => {
        setQuiz({ id: q.id, title: q.title, questions: q.questions });
        setLive(q.live?.code ?? null);
        dirty.current = false;
        setStatus('saved');
      })
      .catch((e) => {
        setStatus('notfound');
        setErrors([e instanceof Error ? e.message : 'Could not load quiz']);
      });
  }, [id, token]);

  // While a session is live, keep re-checking so the lock banner lifts by
  // itself the moment the game ends (the server is authoritative on writes).
  useEffect(() => {
    if (!live) return;
    const poll = window.setInterval(async () => {
      try {
        const q = await getQuiz(id, token);
        if (!q.live) setLive(null);
      } catch {
        // transient error — keep polling
      }
    }, 5000);
    return () => clearInterval(poll);
  }, [live, id, token]);

  useEffect(() => {
    if (!quiz || status === 'loading' || status === 'notfound' || !dirty.current || live) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setStatus('saving');
      try {
        await saveQuiz(id, token, { title: quiz.title, questions: quiz.questions });
        dirty.current = false;
        setStatus('saved');
        setErrors([]);
        store.rememberQuiz({ id, title: quiz.title, editToken: token });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'locked') {
          setLive(String((e.detail as { code?: string })?.code ?? ''));
          setStatus('error');
          setErrors(['Editing is locked while a live session is running.']);
        } else {
          setStatus('error');
          const errs = e instanceof ApiError ? (e.detail as { errors?: unknown } | undefined)?.errors : undefined;
          setErrors(Array.isArray(errs) ? (errs as string[]) : [e instanceof Error ? e.message : 'Save failed']);
        }
      }
    }, 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz]);

  const locked = live != null && live !== '';
  const v = quiz ? validateQuiz(id, quiz) : null;
  const valid = !!v?.ok;

  const apply = (next: Quiz) => {
    dirty.current = true;
    setQuiz(next);
  };
  const patchQuestion = (idx: number, patch: Partial<Question>) => {
    if (!quiz) return;
    apply({ ...quiz, questions: quiz.questions.map((q, i) => (i === idx ? ({ ...q, ...patch } as Question) : q)) });
  };
  const addQuestion = (type: Question['type']) => {
    if (!quiz) return;
    apply({ ...quiz, questions: [...quiz.questions, newQuestion(type)] });
  };
  const removeQuestion = (idx: number) => {
    if (!quiz) return;
    apply({ ...quiz, questions: quiz.questions.filter((_, i) => i !== idx) });
  };
  const moveQuestion = (idx: number, dir: -1 | 1) => {
    if (!quiz) return;
    const j = idx + dir;
    if (j < 0 || j >= quiz.questions.length) return;
    const qs = [...quiz.questions];
    [qs[idx], qs[j]] = [qs[j], qs[idx]];
    apply({ ...quiz, questions: qs });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — link is visible in the address bar anyway
    }
  };

  const goLive = async () => {
    if (!quiz || !valid || locked) return;
    setGoingLive(true);
    try {
      const started = await startSession(id, token);
      store.rememberSession({ code: started.code, title: quiz.title, hostToken: started.hostToken, quizId: id, editToken: token, at: Date.now() });
      nav(`/host/${started.code}?h=${started.hostToken}&q=${id}`);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : 'Could not go live']);
      setGoingLive(false);
    }
  };

  if (status === 'notfound' || (status === 'loading' && !quiz)) {
    return (
      <div class="page page-center">
        <Wordmark small />
        <div class="card">
          <div class="card-title">{status === 'loading' ? 'Loading…' : 'Quiz not found'}</div>
          {errors.length > 0 && <p class="muted">{errors[0]}</p>}
          <button class="btn btn-primary" onClick={() => nav('/')}>
            Home
          </button>
        </div>
      </div>
    );
  }
  if (!quiz) return null;

  return (
    <div class="page page-edit">
      <header class="edit-header">
        <button class="btn btn-ghost btn-sm" onClick={() => nav('/')}>
          ← Home
        </button>
        <input
          class="title-input"
          value={quiz.title}
          maxLength={120}
          placeholder="Quiz title"
          disabled={locked}
          onInput={(e) => apply({ ...quiz, title: (e.target as HTMLInputElement).value })}
        />
        <span class={`save-state save-${status}`}>
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : status === 'error' ? 'Save failed' : ''}
        </span>
        <button class="btn btn-primary" disabled={!valid || locked || goingLive} onClick={goLive}>
          {goingLive ? 'Starting…' : 'Go live'}
        </button>
      </header>

      <div class="card edit-link-card">
        <div class="small muted">This secret link is your only login — bookmark it.</div>
        <div class="edit-link-row">
          <input class="mono edit-link" readonly value={location.href} onFocus={(e) => (e.target as HTMLInputElement).select()} />
          <button class="btn btn-secondary btn-sm" onClick={copyLink}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>

      {locked && (
        <div class="card locked-banner">
          <div>
            <b>Live session running ({live}).</b> Editing is locked until the game ends.
          </div>
          <button class="btn btn-secondary btn-sm" onClick={() => nav(`/host/${live}`)}>
            Open host screen
          </button>
        </div>
      )}

      {!valid && v && v.errors.length > 0 && status !== 'error' && (
        <div class="card issues-card">
          <b>Before going live:</b>
          <ul>
            {v.errors.slice(0, 6).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {status === 'error' && errors.length > 0 && (
        <div class="error">
          {errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      <div class="questions">
        {quiz.questions.map((q, i) => (
          <QuestionCard key={q.id} q={q} idx={i} total={quiz.questions.length} locked={locked} patch={patchQuestion} remove={removeQuestion} move={moveQuestion} />
        ))}
      </div>

      <div class="card add-questions">
        <div class="card-title">Add a question</div>
        <div class="add-buttons">
          {(Object.keys(TYPE_LABEL) as Question['type'][]).map((t) => (
            <button key={t} class="btn btn-secondary" disabled={locked} onClick={() => addQuestion(t)}>
              + {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  idx,
  total,
  locked,
  patch,
  remove,
  move,
}: {
  q: Question;
  idx: number;
  total: number;
  locked: boolean;
  patch: (idx: number, patch: Partial<Question>) => void;
  remove: (idx: number) => void;
  move: (idx: number, dir: -1 | 1) => void;
}) {
  return (
    <div class="card qcard">
      <div class="qcard-head">
        <span class="qnum">{idx + 1}</span>
        <span class={`type-badge type-${q.type}`}>{TYPE_LABEL[q.type]}</span>
        <span class="qcard-actions">
          <button class="icon-btn" disabled={locked || idx === 0} title="Move up" onClick={() => move(idx, -1)}>
            ↑
          </button>
          <button class="icon-btn" disabled={locked || idx === total - 1} title="Move down" onClick={() => move(idx, 1)}>
            ↓
          </button>
          <button class="icon-btn" disabled={locked} title="Delete" onClick={() => remove(idx)}>
            ✕
          </button>
        </span>
      </div>

      <textarea
        class="prompt-input"
        value={q.prompt}
        maxLength={500}
        rows={2}
        placeholder="Ask something…"
        disabled={locked}
        onInput={(e) => patch(idx, { prompt: (e.target as HTMLTextAreaElement).value })}
      />

      <div class="qrow">
        <label class="field-label">Time limit</label>
        <select disabled={locked} value={q.timeLimitSec} onChange={(e) => patch(idx, { timeLimitSec: Number((e.target as HTMLSelectElement).value) })}>
          {TIME_OPTIONS.map((t) => (
            <option value={t}>{t}s</option>
          ))}
        </select>
      </div>

      {q.type === 'choice' && (
        <div class="options-editor">
          {q.options.map((opt, oi) => (
            <div class="option-edit-row" key={oi}>
              <label class={`correct-pick ${q.correct === oi ? 'is-correct' : ''}`} title="Mark as correct">
                <input
                  type="radio"
                  name={`correct-${q.id}`}
                  checked={q.correct === oi}
                  disabled={locked}
                  onChange={() => patch(idx, { correct: oi } as Partial<Question>)}
                />
                <OptionShape index={oi} />
              </label>
              <input
                class="option-input"
                value={opt}
                maxLength={120}
                placeholder={`Option ${oi + 1}`}
                disabled={locked}
                onInput={(e) => {
                  const options = [...q.options];
                  options[oi] = (e.target as HTMLInputElement).value;
                  patch(idx, { options });
                }}
              />
              <button
                class="icon-btn"
                disabled={locked || q.options.length <= 2}
                title="Remove option"
                onClick={() => {
                  const options = q.options.filter((_, k) => k !== oi);
                  patch(idx, { options, correct: Math.min(q.correct, options.length - 1) } as Partial<Question>);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          {q.options.length < 6 && (
            <button class="btn btn-ghost btn-sm" disabled={locked} onClick={() => patch(idx, { options: [...q.options, ''] })}>
              + option
            </button>
          )}
        </div>
      )}

      {q.type === 'truefalse' && (
        <div class="tf-editor">
          <span class="field-label">Correct answer</span>
          <div class="tf-pills">
            <button class={`pill ${q.answer ? 'pill-on' : ''}`} disabled={locked} onClick={() => patch(idx, { answer: true } as Partial<Question>)}>
              True
            </button>
            <button class={`pill ${!q.answer ? 'pill-on' : ''}`} disabled={locked} onClick={() => patch(idx, { answer: false } as Partial<Question>)}>
              False
            </button>
          </div>
        </div>
      )}

      {q.type === 'short' && (
        <div class={`options-editor ${q.acceptAny ? 'any-mode' : ''}`}>
          <label class="check-row">
            <input
              type="checkbox"
              checked={!!q.acceptAny}
              disabled={locked}
              onChange={(e) => patch(idx, { acceptAny: (e.target as HTMLInputElement).checked } as Partial<Question>)}
            />
            <span>Accept any answer — everyone who submits something gets full points</span>
          </label>
          <span class="field-label">
            {q.acceptAny
              ? 'Accepted answers (not used while accept-any is on)'
              : 'Accepted answers — every one of them counts as correct (case & spacing ignored)'}
          </span>
          {q.accepted.map((a, ai) => (
            <div class="option-edit-row" key={ai}>
              <input
                class="option-input"
                value={a}
                maxLength={80}
                placeholder={`Answer ${ai + 1}`}
                disabled={locked || !!q.acceptAny}
                onInput={(e) => {
                  const accepted = [...q.accepted];
                  accepted[ai] = (e.target as HTMLInputElement).value;
                  patch(idx, { accepted } as Partial<Question>);
                }}
              />
              <button
                class="icon-btn"
                disabled={locked || !!q.acceptAny || q.accepted.length <= 1}
                title="Remove"
                onClick={() => patch(idx, { accepted: q.accepted.filter((_, k) => k !== ai) } as Partial<Question>)}
              >
                ✕
              </button>
            </div>
          ))}
          {q.accepted.length < 8 && (
            <button
              class="btn btn-ghost btn-sm"
              disabled={locked || !!q.acceptAny}
              onClick={() => patch(idx, { accepted: [...q.accepted, ''] } as Partial<Question>)}
            >
              + accepted answer
            </button>
          )}
        </div>
      )}

      {q.type === 'likert' && (
        <div class="likert-editor">
          <div class="qrow">
            <label class="field-label">Scale</label>
            <select
              disabled={locked}
              value={q.likertMin}
              onChange={(e) => {
                const likertMin = Number((e.target as HTMLSelectElement).value);
                patch(idx, { likertMin, likertMax: Math.max(q.likertMax, likertMin + 1), likertLabels: undefined, correctValues: undefined } as Partial<Question>);
              }}
            >
              {[0, 1, 2, 3].map((n) => (
                <option value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span class="muted">to</span>
            <select
              disabled={locked}
              value={q.likertMax}
              onChange={(e) => patch(idx, { likertMax: Number((e.target as HTMLSelectElement).value), likertLabels: undefined, correctValues: undefined } as Partial<Question>)}
            >
              {Array.from({ length: 9 }, (_, k) => q.likertMin + 1 + k)
                .filter((n) => n <= 10)
                .map((n) => (
                  <option value={n}>{n}</option>
                ))}
            </select>
          </div>
          <span class="field-label">Tick the value(s) that count as correct (+1,000 each). Leave all unticked for an unscored poll.</span>
          <div class="likert-values-editor">
            {Array.from({ length: q.likertMax - q.likertMin + 1 }, (_, k) => k).map((k) => {
              const value = q.likertMin + k;
              const checked = q.correctValues?.includes(value) ?? false;
              return (
                <div class="likert-value-row" key={k}>
                  <label class={`likert-correct ${checked ? 'is-correct' : ''}`} title="Counts as correct">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={(e) => {
                        const set = new Set(q.correctValues ?? []);
                        if ((e.target as HTMLInputElement).checked) set.add(value);
                        else set.delete(value);
                        const vals = [...set].sort((a, b) => a - b);
                        patch(idx, { correctValues: vals.length ? vals : undefined } as Partial<Question>);
                      }}
                    />
                    <span class="likert-value-num">{value}</span>
                  </label>
                  <input
                    class="option-input likert-label-input"
                    value={q.likertLabels?.[k] ?? ''}
                    maxLength={40}
                    placeholder={`label (optional)`}
                    disabled={locked}
                    onInput={(e) => {
                      const labels = Array.from({ length: q.likertMax - q.likertMin + 1 }, (_, j) => q.likertLabels?.[j] ?? '');
                      labels[k] = (e.target as HTMLInputElement).value;
                      patch(idx, { likertLabels: labels.some((l) => l.trim()) ? labels : undefined } as Partial<Question>);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
