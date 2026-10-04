// Answer-text normalization for short-answer matching.
// Conservative on purpose: Thai and Japanese vowel/tone marks are semantically
// significant, so we never strip combining marks — we only do safe work:
// NFC, case-folding, whitespace collapsing and stripping edge punctuation.

const EDGE_PUNCT = /^[.,!?;:、。！？…"“”'‘’()（）「」『』·\-—]+|[.,!?;:、。！？…"“”'‘’()（）「」『』·\-—]+$/g;

export function normalizeAnswer(raw: string): string {
  return raw
    .normalize('NFC')
    .toLocaleLowerCase('und')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_PUNCT, '')
    .trim();
}

/** Display-name cleanup for players joining a session. */
export function sanitizeName(raw: string): string {
  return raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}
