// Unguessable identifier helpers (crypto-random, charset-restricted).

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I L O 0 1 — easy to read aloud
const ID_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'; // base58ish

function pick(chars: string, len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/** Public join code shown on the host screen. 28^6 ≈ 4.8e8 space. */
export const joinCode = () => pick(CODE_CHARS, 6);
/** Quiz id used in edit URLs. */
export const quizId = () => pick(ID_CHARS, 12);
/** Secret edit link token (acts as the host's login for the quiz). */
export const editToken = () => pick(ID_CHARS, 32);
/** Per-session host control token. */
export const hostToken = () => pick(ID_CHARS, 32);
/** Per-player token (rejoin identity). */
export const playerToken = () => pick(ID_CHARS, 24);
/** Player id (public within a session). */
export const playerId = () => pick(ID_CHARS, 10);

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
