import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuiz } from '../shared/validate.ts';

const base = { id: 'quiz1', title: 'T' };

test('short question requires an accepted answer unless accept-any is on', () => {
  const strict = validateQuiz('quiz1', { ...base, questions: [{ id: 'q1', type: 'short', prompt: 'P?', timeLimitSec: 20, accepted: [] }] });
  assert.equal(strict.ok, false);

  const any = validateQuiz('quiz1', {
    ...base,
    questions: [{ id: 'q1', type: 'short', prompt: 'P?', timeLimitSec: 20, accepted: [], acceptAny: true }],
  });
  assert.equal(any.ok, true);
  assert.deepEqual(any.quiz!.questions[0], { id: 'q1', type: 'short', prompt: 'P?', timeLimitSec: 20, accepted: [], acceptAny: true });
});

test('accept-any keeps the accepted list for when it is toggled off', () => {
  const r = validateQuiz('quiz1', {
    ...base,
    questions: [{ id: 'q1', type: 'short', prompt: 'P?', timeLimitSec: 20, accepted: ['Tokyo', ''], acceptAny: true }],
  });
  assert.equal(r.ok, true);
  const q = r.quiz!.questions[0];
  assert.equal(q.type, 'short');
  if (q.type === 'short') {
    assert.deepEqual(q.accepted, ['Tokyo']);
    assert.equal(q.acceptAny, true);
  }
});

test('accept-any flag is dropped when not exactly true', () => {
  const r = validateQuiz('quiz1', {
    ...base,
    questions: [{ id: 'q1', type: 'short', prompt: 'P?', timeLimitSec: 20, accepted: ['Tokyo'], acceptAny: 'yes' }],
  });
  assert.equal(r.ok, true);
  const q = r.quiz!.questions[0];
  assert.equal(q.type, 'short');
  if (q.type === 'short') assert.equal(q.acceptAny, undefined);
});
