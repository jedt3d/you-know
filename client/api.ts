// REST helpers + local (browser) records of the user's quizzes, sessions and
// player identities. The edit/host tokens below are the product's entire auth
// model — the server never issues accounts.

import type { Question, Quiz, SessionSummary } from '../shared/types.ts';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new ApiError(String(body.error ?? 'error'), msg, res.status, body);
  }
  return body as T;
}

// ---------------------------------------------------------------- API types

export interface QuizView extends Quiz {
  editToken: string;
  live: { code: string } | null;
}

export interface CreatedQuiz {
  id: string;
  editToken: string;
  title: string;
}

export interface StartedSession {
  code: string;
  hostToken: string;
  joinUrl: string;
  hostUrl: string;
}

export interface JoinResult {
  playerId: string;
  playerToken: string;
  rejoined?: boolean;
}

export const createQuiz = (title: string) => api<CreatedQuiz>('/api/quizzes', { method: 'POST', body: JSON.stringify({ title }) });
export const getQuiz = (id: string, token: string) => api<QuizView>(`/api/quizzes/${id}?token=${encodeURIComponent(token)}`);
export const saveQuiz = (id: string, token: string, quiz: { title: string; questions: Question[] }) =>
  api<{ ok: true; savedAt: number; title: string }>(`/api/quizzes/${id}`, { method: 'PUT', body: JSON.stringify({ token, quiz }) });
export const startSession = (id: string, token: string) =>
  api<StartedSession>(`/api/quizzes/${id}/sessions`, { method: 'POST', body: JSON.stringify({ token }) });
export const getSummary = (code: string) => api<SessionSummary & { exists: boolean }>(`/api/sessions/${code}`);
export const joinSession = (code: string, name: string, playerToken?: string) =>
  api<JoinResult>(`/api/sessions/${code}/join`, { method: 'POST', body: JSON.stringify({ name, ...(playerToken ? { playerToken } : {}) }) });
export const sendAnswer = (code: string, playerToken: string, qIndex: number, answer: unknown) =>
  api<{ ok: true }>(`/api/sessions/${code}/answer`, {
    method: 'POST',
    body: JSON.stringify({ playerToken, qIndex, answer }),
  });
export const hostCmd = (code: string, hostToken: string, cmd: string, extra?: Record<string, unknown>) =>
  api<{ ok: true }>(`/api/sessions/${code}/cmd`, { method: 'POST', body: JSON.stringify({ hostToken, cmd, ...extra }) });

// ------------------------------------------------------------ localStorage

export interface QuizRef {
  id: string;
  title: string;
  editToken: string;
}

export interface SessionRef {
  code: string;
  title: string;
  hostToken: string;
  quizId: string;
  editToken: string;
  at: number;
}

export interface PlayerRef {
  playerId: string;
  playerToken: string;
  name: string;
}

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode etc.
  }
}

export const store = {
  quizzes: (): QuizRef[] => load<QuizRef[]>('yk-quizzes', []),
  rememberQuiz(q: QuizRef) {
    save('yk-quizzes', [q, ...this.quizzes().filter((x) => x.id !== q.id)].slice(0, 30));
  },
  forgetQuiz(id: string) {
    save(
      'yk-quizzes',
      this.quizzes().filter((x) => x.id !== id),
    );
  },
  sessions: (): SessionRef[] => load<SessionRef[]>('yk-sessions', []),
  rememberSession(s: SessionRef) {
    save('yk-sessions', [s, ...this.sessions().filter((x) => x.code !== s.code)].slice(0, 30));
  },
  forgetSession(code: string) {
    save(
      'yk-sessions',
      this.sessions().filter((x) => x.code !== code),
    );
  },
  sessionByCode(code: string): SessionRef | undefined {
    return this.sessions().find((s) => s.code === code);
  },
  player: (code: string): PlayerRef | null => load<PlayerRef | null>(`yk-player-${code}`, null),
  setPlayer(code: string, p: PlayerRef | null) {
    if (p) save(`yk-player-${code}`, p);
    else localStorage.removeItem(`yk-player-${code}`);
  },
};
