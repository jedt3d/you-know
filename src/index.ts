// You Know? — single Worker: REST API + WebSocket upgrade + D1 (quizzes,
// session registry, admin settings, game records) + one hibernating SessionDO
// per live session. Static assets (the SPA build) are served via ASSETS.

import { Hono } from 'hono';
import { SessionDO } from './session-do.ts';
import { validateQuiz } from '../shared/validate.ts';
import type { SessionSummary } from '../shared/types.ts';
import { editToken, hostToken as newHostToken, joinCode, normalizeCode, quizId } from './ids.ts';

interface Env {
  DB: D1Database;
  SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Set by the self-host adapter (server/node.ts): the client's IP. */
  remoteIp?: string;
}

const app = new Hono<{ Bindings: Env }>();

const stubFor = (env: Env, code: string) => env.SESSION.get(env.SESSION.idFromName('s:' + code));

app.get('/api/health', (c) => c.text('ok'));

// -------------------------------------------------------------------- admin

// Settings live in D1 (a `settings` key/value table): the admin password as a
// PBKDF2 hash and the session token issued on setup/login. The client keeps
// the token in localStorage and sends it as `x-admin-token`.

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex
    ? new Uint8Array((saltHex.match(/../g) ?? []).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return hex(salt.buffer as ArrayBuffer) + ':' + hex(bits);
}

function randomToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(24)).buffer as ArrayBuffer);
}

function randomId(len: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(len)).buffer as ArrayBuffer);
}

app.get('/api/admin/status', async (c) => {
  return c.json({ setup: (await getSetting(c.env, 'admin_hash')) === null });
});

// Set up (first run) or reset (?reset=1) the admin password. Deliberately
// open per the product decision: a self-hosted app where the URL parameter
// is the recovery path.
app.post('/api/admin/password', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const password = String(body?.password ?? '');
  if (password.length < 8) return c.json({ error: 'weak_password', message: 'Use at least 8 characters.' }, 400);
  const hash = await hashPassword(password);
  const token = randomToken();
  await putSetting(c.env, 'admin_hash', hash);
  await putSetting(c.env, 'admin_token', token);
  return c.json({ token });
});

app.post('/api/admin/login', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const stored = await getSetting(c.env, 'admin_hash');
  if (!stored) return c.json({ error: 'setup_required' }, 409);
  const candidate = await hashPassword(String(body?.password ?? ''), stored.split(':')[0]);
  if (candidate !== stored) return c.json({ error: 'forbidden' }, 403);
  // reuse the existing token so other devices stay logged in
  let token = await getSetting(c.env, 'admin_token');
  if (!token) {
    token = randomToken();
    await putSetting(c.env, 'admin_token', token);
  }
  return c.json({ token });
});

async function requireAdmin(c: any): Promise<Response | null> {
  const token = c.req.header('x-admin-token') ?? '';
  const valid = token && (await getSetting(c.env, 'admin_token')) === token;
  if (!valid) return c.json({ error: 'forbidden' }, 403);
  return null;
}

app.get('/api/admin/verify', async (c) => {
  const denied = await requireAdmin(c);
  return denied ?? c.json({ ok: true });
});

/** Everything the admin page shows: quizzes, sessions, players (with IP). */
app.get('/api/admin/overview', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const quizzes = await c.env.DB.prepare(
    'SELECT id, title, edit_token, created_at, updated_at FROM quizzes ORDER BY created_at DESC',
  ).all<{ id: string; title: string; edit_token: string; created_at: number; updated_at: number }>();
  const sessions = await c.env.DB.prepare(`
    SELECT s.code, s.quiz_id, s.title, s.status, s.created_at, s.ended_at, s.host_token,
           (SELECT COUNT(*) FROM players p WHERE p.session_code = s.code) AS player_count
    FROM sessions s ORDER BY s.created_at DESC LIMIT 100`).all();
  const players = await c.env.DB.prepare(
    'SELECT session_code, player_id, name, ip, user_agent, score, joined_at FROM players ORDER BY joined_at DESC LIMIT 500',
  ).all();
  return c.json({ quizzes: quizzes.results ?? [], sessions: sessions.results ?? [], players: players.results ?? [] });
});

/** One session in detail: every recorded answer with its outcome. */
app.get('/api/admin/sessions/:code', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const code = normalizeCode(c.req.param('code'));
  const session = await c.env.DB.prepare('SELECT code, quiz_id, title, status, created_at, ended_at FROM sessions WHERE code = ?')
    .bind(code)
    .first();
  if (!session) return c.json({ error: 'not_found' }, 404);
  const players = await c.env.DB.prepare(
    'SELECT player_id, name, ip, user_agent, score, joined_at FROM players WHERE session_code = ? ORDER BY score DESC, joined_at',
  )
    .bind(code)
    .all();
  const answers = await c.env.DB.prepare(
    `SELECT a.player_id, p.name, a.q_index, a.answer, a.correct, a.gained, a.answered_at
     FROM answers a LEFT JOIN players p ON p.session_code = a.session_code AND p.player_id = a.player_id
     WHERE a.session_code = ? ORDER BY a.q_index, a.answered_at`,
  )
    .bind(code)
    .all();
  return c.json({ session, players: players.results ?? [], answers: answers.results ?? [] });
});

// ------------------------------------------------------------------ quizzes

app.post('/api/quizzes', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const title = String(body?.title ?? '').trim().slice(0, 120) || 'Untitled quiz';
  const id = quizId();
  const token = editToken();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO quizzes (id, edit_token, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, token, title, JSON.stringify({ questions: [] }), now, now)
    .run();
  return c.json({ id, editToken: token, title });
});

interface QuizRow {
  id: string;
  edit_token: string;
  title: string;
  data: string;
}

async function quizRow(env: Env, id: string): Promise<QuizRow | null> {
  return await env.DB.prepare('SELECT id, edit_token, title, data FROM quizzes WHERE id = ?').bind(id).first<QuizRow>();
}

/** Any session of this quiz still running? (Decision: editing is locked then.) */
async function liveSession(env: Env, quizId: string): Promise<{ code: string } | null> {
  const rows = await env.DB.prepare('SELECT code FROM sessions WHERE quiz_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(quizId)
    .all<{ code: string }>();
  for (const r of rows.results ?? []) {
    try {
      const res = await stubFor(env, r.code).fetch('https://do/summary');
      if (res.ok) {
        const s = (await res.json()) as SessionSummary;
        if (s.phase !== 'ended') return { code: r.code };
      }
    } catch {
      // session DO unreachable — treat as not live
    }
  }
  return null;
}

app.get('/api/quizzes/:id', async (c) => {
  const token = c.req.query('token') ?? '';
  const row = await quizRow(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.edit_token !== token) return c.json({ error: 'forbidden' }, 403);
  const data = JSON.parse(row.data) as { questions: unknown[] };
  const live = await liveSession(c.env, row.id);
  return c.json({
    id: row.id,
    title: row.title,
    editToken: token,
    questions: data.questions,
    live: live ? { code: live.code } : null,
  });
});

app.put('/api/quizzes/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const row = await quizRow(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.edit_token !== String(body?.token ?? '')) return c.json({ error: 'forbidden' }, 403);

  const live = await liveSession(c.env, row.id);
  if (live) return c.json({ error: 'locked', code: live.code, message: `A live session (${live.code}) is running — finish it before editing.` }, 409);

  const v = validateQuiz(row.id, body?.quiz);
  if (!v.ok || !v.quiz) return c.json({ error: 'invalid', errors: v.errors }, 400);
  await c.env.DB.prepare('UPDATE quizzes SET title = ?, data = ?, updated_at = ? WHERE id = ?')
    .bind(v.quiz.title, JSON.stringify({ questions: v.quiz.questions }), Date.now(), row.id)
    .run();
  return c.json({ ok: true, savedAt: Date.now(), title: v.quiz.title });
});

app.post('/api/quizzes/:id/sessions', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const row = await quizRow(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.edit_token !== String(body?.token ?? '')) return c.json({ error: 'forbidden' }, 403);

  // Snapshot from the stored quiz (not the client's copy) — session plays a frozen version.
  const stored = JSON.parse(row.data) as { questions?: unknown[] };
  const v = validateQuiz(row.id, { title: row.title, questions: stored.questions ?? [] });
  if (!v.ok || !v.quiz) return c.json({ error: 'invalid', errors: v.errors }, 400);

  let created: { code: string; hostToken: string } | null = null;
  for (let attempt = 0; attempt < 6 && !created; attempt++) {
    const code = joinCode();
    const res = await stubFor(c.env, code).fetch('https://do/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, hostToken: newHostToken(), quiz: v.quiz }),
    });
    if (res.status === 409) continue; // code already in use — try another
    if (!res.ok) return c.json({ error: 'create_failed' }, 500);
    const out = (await res.json()) as { hostToken: string };
    created = { code, hostToken: out.hostToken };
    await c.env.DB.prepare('INSERT INTO sessions (code, quiz_id, created_at, title, status, host_token) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(code, row.id, Date.now(), v.quiz.title, 'live', created.hostToken)
      .run();
  }
  if (!created) return c.json({ error: 'code_collision' }, 500);

  const origin = new URL(c.req.url).origin;
  return c.json({
    code: created.code,
    hostToken: created.hostToken,
    joinUrl: `${origin}/#/join/${created.code}`,
    hostUrl: `${origin}/#/host/${created.code}?h=${created.hostToken}`,
  });
});

// Deleting a quiz removes its sessions and all recorded rows. Refused while
// any session of the quiz is still live (same rule as editing).
app.delete('/api/quizzes/:id', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const id = c.req.param('id');
  const row = await quizRow(c.env, id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const live = await liveSession(c.env, id);
  if (live) return c.json({ error: 'locked', code: live.code, message: `A live session (${live.code}) is running — end it before deleting.` }, 409);

  const sess = await c.env.DB.prepare('SELECT code FROM sessions WHERE quiz_id = ?').bind(id).all<{ code: string }>();
  const codes = (sess.results ?? []).map((r) => r.code);
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50);
    await c.env.DB.batch([
      ...chunk.map((code) => c.env.DB.prepare('DELETE FROM answers WHERE session_code = ?').bind(code)),
      ...chunk.map((code) => c.env.DB.prepare('DELETE FROM players WHERE session_code = ?').bind(code)),
    ]);
  }
  await c.env.DB.prepare('DELETE FROM sessions WHERE quiz_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM quizzes WHERE id = ?').bind(id).run();
  return c.json({ ok: true, deletedSessions: codes.length });
});

// ----------------------------------------------------------------- sessions

app.get('/api/sessions/:code', async (c) => {
  const res = await stubFor(c.env, normalizeCode(c.req.param('code'))).fetch('https://do/summary');
  if (res.status === 404) return c.json({ exists: false }, 404);
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/sessions/:code/join', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  // Forward where the player came from — the DO writes it to the players table.
  const fwd: Record<string, string> = { 'content-type': 'application/json' };
  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.env.remoteIp;
  if (ip) fwd['x-player-ip'] = ip;
  const ua = c.req.header('user-agent');
  if (ua) fwd['x-player-ua'] = ua;
  const res = await stubFor(c.env, normalizeCode(c.req.param('code'))).fetch('https://do/join', {
    method: 'POST',
    headers: fwd,
    body: JSON.stringify(body ?? {}),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/sessions/:code/answer', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const res = await stubFor(c.env, normalizeCode(c.req.param('code'))).fetch('https://do/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/sessions/:code/cmd', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const res = await stubFor(c.env, normalizeCode(c.req.param('code'))).fetch('https://do/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.get('/api/sessions/:code/state', async (c) => {
  const search = new URL(c.req.url).search;
  const res = await stubFor(c.env, normalizeCode(c.req.param('code'))).fetch('https://do/state' + search);
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

// Admin: drop a session entirely — DO state plus every recorded row.
app.delete('/api/sessions/:code', async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  const code = normalizeCode(c.req.param('code'));
  try {
    await stubFor(c.env, code).fetch('https://do/drop', { method: 'POST' });
  } catch {
    // DO unreachable — rows still go
  }
  await c.env.DB.prepare('DELETE FROM answers WHERE session_code = ?').bind(code).run();
  await c.env.DB.prepare('DELETE FROM players WHERE session_code = ?').bind(code).run();
  await c.env.DB.prepare('DELETE FROM sessions WHERE code = ?').bind(code).run();
  return c.json({ ok: true });
});

// WebSocket upgrade — forwarded straight into the session DO.
app.get('/ws/:code', (c) => stubFor(c.env, normalizeCode(c.req.param('code'))).fetch(c.req.raw));

// Everything else falls back to static assets (SPA).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
export { SessionDO };
