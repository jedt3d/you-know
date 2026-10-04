// Scoring rules (decision: Kahoot-style, host-paced):
//  - choice + true/false: correct answers earn 500–1000 points, decaying with
//    response time (instant ≈ 1000, answering at the buzzer ≈ 500).
//  - short answer: flat 1000 — normalized exact match against the accepted
//    list (every accepted answer counts as correct), or any non-empty answer
//    when the editor ticks accept-any.
//  - likert: unscored pulse poll by default; if the editor marks correct
//    values, an answer among them earns flat 1000 (no speed decay).

import type { Answer, LikertQuestion, Question } from './types.ts';
import { normalizeAnswer } from './text.ts';

export const MAX_POINTS = 1000;
const MIN_FRACTION = 0.5;

/** Points for a correct timed answer, given elapsed time within the limit. */
export function timedPoints(elapsedMs: number, limitMs: number): number {
  const f = limitMs <= 0 ? 0 : Math.min(Math.max(0, 1 - elapsedMs / limitMs), 1);
  return Math.round((MIN_FRACTION + (1 - MIN_FRACTION) * f) * MAX_POINTS);
}

export function isLikertScored(q: LikertQuestion): boolean {
  return (q.correctValues?.length ?? 0) > 0;
}

export function isCorrectAnswer(q: Question, a: Answer): boolean {
  switch (q.type) {
    case 'choice':
      return a.kind === 'choice' && a.option === q.correct;
    case 'truefalse':
      return a.kind === 'truefalse' && a.value === q.answer;
    case 'short': {
      if (a.kind !== 'short') return false;
      if (q.acceptAny) return normalizeAnswer(a.text).length > 0;
      return q.accepted.some((x) => normalizeAnswer(x) === normalizeAnswer(a.text));
    }
    case 'likert':
      return a.kind === 'likert' && isLikertScored(q) && q.correctValues!.includes(a.value);
  }
}

/** Points earned for an answer (elapsedMs only matters for timed types). */
export function pointsFor(q: Question, a: Answer | null, elapsedMs: number): number {
  if (!a) return 0;
  if (!isCorrectAnswer(q, a)) return 0;
  if (q.type === 'short' || q.type === 'likert') return MAX_POINTS;
  return timedPoints(elapsedMs, q.timeLimitSec * 1000);
}
