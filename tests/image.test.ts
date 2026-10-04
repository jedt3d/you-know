import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffImageMime, IMAGE_LIMITS } from '../shared/image.ts';

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('sniffImageMime: webp by RIFF/WEBP magic', () => {
  assert.equal(sniffImageMime(WEBP), 'image/webp');
});

test('sniffImageMime: jpeg by FFD8FF', () => {
  assert.equal(sniffImageMime(JPEG), 'image/jpeg');
});

test('sniffImageMime: png by signature', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
});

test('sniffImageMime: rejects text, short buffers and jpeg look-alikes', () => {
  const text = new Uint8Array(Buffer.from('plain text pretending to be an image'));
  assert.equal(sniffImageMime(text), null);
  assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8])), null); // too short
  const fake = new Uint8Array([...JPEG]); fake[2] = 0x00; // near-miss
  assert.equal(sniffImageMime(fake), null);
});

test('image limits: 512KB cap, 50 per quiz, 20MB per quiz', () => {
  assert.equal(IMAGE_LIMITS.maxBytes, 512 * 1024);
  assert.equal(IMAGE_LIMITS.maxPerQuiz, 50);
  assert.equal(IMAGE_LIMITS.maxTotalBytes, 20 * 1024 * 1024);
});
