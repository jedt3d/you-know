// Image guards shared by the Worker (authoritative) and tests.

export type ImageMime = 'image/webp' | 'image/jpeg' | 'image/png';

/** Magic-byte sniff — never trust the declared content-type. */
export function sniffImageMime(b: Uint8Array): ImageMime | null {
  // RIFF....WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  // FFD8FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // 89 PNG \r\n 0x1a \n
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png';
  return null;
}

export const IMAGE_LIMITS = {
  maxBytes: 512 * 1024, // hard cap after client-side resize
  maxPerQuiz: 50,
  maxTotalBytes: 20 * 1024 * 1024, // per quiz — future Free/Pro lever
  maxDimension: 4096,
} as const;
