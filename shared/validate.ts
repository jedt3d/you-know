// Quiz validation shared by the Worker (authoritative) and the editor UI
// (instant feedback). Everything out of range is clamped or rejected so a
// quiz snapshot stored in a session DO is always safe to render.

import type { Question, QuestionImage, Quiz } from './types.ts';

export const LIMITS = {
  titleMin: 1,
  titleMax: 120,
  promptMax: 500,
  optionMinLen: 1,
  optionMaxLen: 120,
  optionsMin: 2,
  optionsMax: 6,
  acceptedMin: 1,
  acceptedMax: 8,
  acceptedMaxLen: 80,
  shortAnswerMaxLen: 80,
  likertSpanMax: 9,
  timeMin: 5,
  timeMax: 120,
  timeDefault: 20,
  questionsMax: 100,
  playersMax: 200,
} as const;

export interface ValidationResult {
  ok: boolean;
  errors: string[]; // human-readable, indexed by question where possible
  quiz?: Quiz; // sanitized copy
}

function str(x: unknown, max: number): string {
  if (typeof x !== 'string') return '';
  return x.normalize('NFC').trim().slice(0, max);
}

function clampTime(x: unknown): number {
  const n = typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : LIMITS.timeDefault;
  return Math.min(Math.max(n, LIMITS.timeMin), LIMITS.timeMax);
}

/** Shape-check the optional image reference (ownership is verified server-side). */
function cleanImage(x: unknown): { image?: QuestionImage } {
  if (!x || typeof x !== 'object') return {};
  const r = x as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.slice(0, 40) : '';
  const width = Math.round(Number(r.width));
  const height = Math.round(Number(r.height));
  if (!id || !Number.isFinite(width) || !Number.isFinite(height)) return {};
  if (width < 1 || width > 4096 || height < 1 || height > 4096) return {};
  return { image: { id, width, height } };
}

export function validateQuiz(id: string, raw: unknown): ValidationResult {
  const errors: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const title = str(r.title, LIMITS.titleMax);
  if (!title) errors.push('Quiz needs a title.');

  const rawQuestions = Array.isArray(r.questions) ? r.questions : [];
  if (rawQuestions.length === 0) errors.push('Add at least one question.');
  if (rawQuestions.length > LIMITS.questionsMax) errors.push(`At most ${LIMITS.questionsMax} questions.`);

  const questions: Question[] = [];
  rawQuestions.forEach((rq, i) => {
    const q = (rq ?? {}) as Record<string, unknown>;
    const where = `Q${i + 1}`;
    const prompt = str(q.prompt, LIMITS.promptMax);
    if (!prompt) errors.push(`${where}: prompt is empty.`);
    const timeLimitSec = clampTime(q.timeLimitSec);
    const base = { id: str(q.id, 40) || `q${i}`, prompt, timeLimitSec, ...cleanImage(q.image) };

    switch (q.type) {
      case 'choice': {
        const opts = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, LIMITS.optionMaxLen));
        const options = opts.slice(0, LIMITS.optionsMax).filter((o) => o.length > 0);
        if (options.length < LIMITS.optionsMin) {
          errors.push(`${where}: needs at least ${LIMITS.optionsMin} non-empty options.`);
          break;
        }
        const correct = Math.min(Math.max(typeof q.correct === 'number' ? Math.trunc(q.correct) : 0, 0), options.length - 1);
        questions.push({ ...base, type: 'choice', options, correct });
        break;
      }
      case 'truefalse': {
        questions.push({ ...base, type: 'truefalse', answer: q.answer !== false });
        break;
      }
      case 'short': {
        const acceptAny = q.acceptAny === true;
        const accepted = (Array.isArray(q.accepted) ? q.accepted : [])
          .map((a) => str(a, LIMITS.acceptedMaxLen))
          .filter((a) => a.length > 0)
          .slice(0, LIMITS.acceptedMax);
        if (!acceptAny && accepted.length < LIMITS.acceptedMin) errors.push(`${where}: needs at least one accepted answer.`);
        else questions.push({ ...base, type: 'short', accepted, ...(acceptAny ? { acceptAny: true } : {}) });
        break;
      }
      case 'likert': {
        const likertMin = typeof q.likertMin === 'number' ? Math.round(q.likertMin) : 1;
        const likertMaxRaw = typeof q.likertMax === 'number' ? Math.round(q.likertMax) : 5;
        const likertMax = Math.min(likertMaxRaw, likertMin + LIMITS.likertSpanMax);
        if (likertMax <= likertMin) {
          errors.push(`${where}: likert range is empty.`);
          break;
        }
        const labels = Array.isArray(q.likertLabels)
          ? (q.likertLabels as unknown[]).map((l) => str(l, 40)).slice(0, likertMax - likertMin + 1)
          : undefined;
        const correctValues = Array.isArray(q.correctValues)
          ? [...new Set(
              (q.correctValues as unknown[]).filter(
                (v): v is number => Number.isInteger(v) && (v as number) >= likertMin && (v as number) <= likertMax,
              ),
            )].sort((a, b) => a - b)
          : undefined;
        questions.push({
          ...base,
          type: 'likert',
          likertMin,
          likertMax,
          ...(labels ? { likertLabels: labels } : {}),
          ...(correctValues && correctValues.length ? { correctValues } : {}),
        });
        break;
      }
      default:
        errors.push(`${where}: unknown question type.`);
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], quiz: { id, title, questions } };
}
