import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCorrectAnswer, isLikertScored, pointsFor, timedPoints } from '../shared/scoring.ts';
import type { Question } from '../shared/types.ts';

const choice = (correct = 1): Question => ({
  id: 'q1',
  type: 'choice',
  prompt: 'Pick one',
  options: ['a', 'b', 'c'],
  correct,
  timeLimitSec: 20,
});

const tf = (answer: boolean): Question => ({ id: 'q2', type: 'truefalse', prompt: 'Yes?', answer, timeLimitSec: 10 });

const short = (accepted: string[]): Question => ({ id: 'q3', type: 'short', prompt: 'City?', accepted, timeLimitSec: 30 });

const likert: Question = { id: 'q4', type: 'likert', prompt: 'How was it?', likertMin: 1, likertMax: 5, timeLimitSec: 15 };
const likertMarked: Question = { id: 'q5', type: 'likert', prompt: 'Rate it', likertMin: 1, likertMax: 5, timeLimitSec: 15, correctValues: [4, 5] };

test('timedPoints: instant answer earns 1000', () => {
  assert.equal(timedPoints(0, 20_000), 1000);
});

test('timedPoints: decays linearly to 500 at the buzzer', () => {
  assert.equal(timedPoints(20_000, 20_000), 500);
  assert.equal(timedPoints(10_000, 20_000), 750);
  assert.equal(timedPoints(19_000, 20_000), 525);
});

test('timedPoints: clamped to [500, 1000]', () => {
  assert.equal(timedPoints(60_000, 20_000), 500);
  assert.equal(timedPoints(-5, 20_000), 1000);
});

test('grades choice by index only', () => {
  const q = choice(1);
  assert.equal(isCorrectAnswer(q, { kind: 'choice', option: 1 }), true);
  assert.equal(isCorrectAnswer(q, { kind: 'choice', option: 0 }), false);
  assert.equal(isCorrectAnswer(q, { kind: 'truefalse', value: true }), false);
});

test('grades true/false', () => {
  assert.equal(isCorrectAnswer(tf(true), { kind: 'truefalse', value: true }), true);
  assert.equal(isCorrectAnswer(tf(true), { kind: 'truefalse', value: false }), false);
});

test('short answers match after normalization', () => {
  const q = short(['Tokyo', '東京']);
  assert.equal(isCorrectAnswer(q, { kind: 'short', text: 'tokyo' }), true);
  assert.equal(isCorrectAnswer(q, { kind: 'short', text: '  TOKYO.  ' }), true);
  assert.equal(isCorrectAnswer(q, { kind: 'short', text: '東京' }), true);
  assert.equal(isCorrectAnswer(q, { kind: 'short', text: 'osaka' }), false);
});

test('likert is unscored unless values are marked', () => {
  assert.equal(isLikertScored(likert as never), false);
  assert.equal(isLikertScored(likertMarked as never), true);
  assert.equal(isCorrectAnswer(likert, { kind: 'likert', value: 3 }), false);
  assert.equal(pointsFor(likert, { kind: 'likert', value: 3 }, 0), 0);
});

test('marked likert values earn flat points when matched', () => {
  assert.equal(isCorrectAnswer(likertMarked, { kind: 'likert', value: 4 }), true);
  assert.equal(isCorrectAnswer(likertMarked, { kind: 'likert', value: 5 }), true);
  assert.equal(isCorrectAnswer(likertMarked, { kind: 'likert', value: 3 }), false);
  assert.equal(pointsFor(likertMarked, { kind: 'likert', value: 5 }, 12_000), 1000); // no speed decay
  assert.equal(pointsFor(likertMarked, { kind: 'likert', value: 1 }, 0), 0);
  assert.equal(pointsFor(likertMarked, null, 0), 0);
});

test('short answers earn flat 1000 regardless of speed', () => {
  assert.equal(pointsFor(short(['Tokyo']), { kind: 'short', text: 'Tokyo' }, 25_000), 1000);
});

test('short accept-any: every non-empty answer is correct, blank is not', () => {
  const q = { ...short([]), acceptAny: true };
  assert.equal(isCorrectAnswer(q, { kind: 'short', text: '  Absolutely anything!  ' }), true);
  assert.equal(isCorrectAnswer(q, { kind: 'short', text: '42' }), true);
  assert.equal(isCorrectAnswer(q, { kind: 'short', text: '   ' }), false);
  assert.equal(pointsFor(q, { kind: 'short', text: 'zzz' }, 29_000), 1000); // flat, no decay
});

test('timed answers decay with elapsed time; wrong answers earn 0', () => {
  const q = choice(1);
  assert.equal(pointsFor(q, { kind: 'choice', option: 1 }, 0), 1000);
  assert.equal(pointsFor(q, { kind: 'choice', option: 1 }, 10_000), 750);
  assert.equal(pointsFor(q, { kind: 'choice', option: 0 }, 0), 0);
  assert.equal(pointsFor(q, null, 0), 0);
});
