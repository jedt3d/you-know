import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, sanitizeName } from '../shared/text.ts';

test('normalizeAnswer is case- and whitespace-insensitive', () => {
  assert.equal(normalizeAnswer('  Tokyo '), 'tokyo');
  assert.equal(normalizeAnswer('New   York'), 'new york');
});

test('normalizeAnswer strips edge punctuation but keeps inner punctuation', () => {
  assert.equal(normalizeAnswer('Tokyo.'), 'tokyo');
  assert.equal(normalizeAnswer('!Tokyo!'), 'tokyo');
  assert.equal(normalizeAnswer('done-code'), 'done-code');
});

test('normalizeAnswer handles Thai and Japanese text', () => {
  assert.equal(normalizeAnswer('กรุงเทพมหานคร'), 'กรุงเทพมหานคร');
  assert.equal(normalizeAnswer(' 東京 '), '東京');
  assert.equal(normalizeAnswer('知ってる？'), '知ってる');
});

test('normalizeAnswer applies NFC composition', () => {
  const decomposed = 'e\u0301clair'; // é as e + combining acute
  assert.equal(normalizeAnswer(decomposed), normalizeAnswer('éclair'));
});

test('normalizeAnswer does not collapse distinct answers', () => {
  assert.notEqual(normalizeAnswer('tokyo'), normalizeAnswer('tokyoo'));
});

test('sanitizeName trims, collapses spaces, caps length', () => {
  assert.equal(sanitizeName('  Ada   Lovelace '), 'Ada Lovelace');
  assert.equal(sanitizeName('x'.repeat(40)).length, 24);
});

test('sanitizeName removes control characters, keeps non-latin names', () => {
  assert.equal(sanitizeName('bad\u0007name'), 'badname');
  assert.equal(sanitizeName('สมชาย'), 'สมชาย');
  assert.equal(sanitizeName('ゆき'), 'ゆき');
});
