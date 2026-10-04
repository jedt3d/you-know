// You Know? — single Worker: REST API + WebSocket upgrade + D1 (quizzes,
// session registry) + one hibernating SessionDO per live session. Static
// assets (the SPA build) are served via the ASSETS binding.

import { Hono } from 'hono';
import { SessionDO } from './session-do.ts';
import { validateQuiz } from '../shared/validate.ts';
import type { SessionSummary } from '../shared/types.ts';
import { editToken, hostToken as newHostToken, joinCode, normalizeCode, quizId } from './ids.ts';

interface Env {
  DB: D1Database;
  SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

const stubFor = (env: Env, code: string) => env.SESSION.get(env.SESSION.idFromName('s:' + code));

app.get('/api/health', (c) => c.text('ok'));

// ------------------------------------------------------------------ quizzes

app.post('/api/quizzes', async (c) => {
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
    await c.env.DB.prepare('INSERT INTO sessions (code, quiz_id, created_at) VALUES (?, ?, ?)').bind(code, row.id, Date.now()).run();
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

// ----------------------------------------------------------------- sessions

app.get('/api/sessions/:code', async (c) => {
  const res = await stubFor(c.env, normalizeCode(c.req.param('code'))).fetch('https://do/summary');
  if (res.status === 404) return c.json({ exists: false }, 404);
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/sessions/:code/join', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const res = await stubFor(c.env, normalizeCode(c.req.param('code'))).fetch('https://do/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

// WebSocket upgrade — forwarded straight into the session DO.
app.get('/ws/:code', (c) => stubFor(c.env, normalizeCode(c.req.param('code'))).fetch(c.req.raw));

// Everything else falls back to static assets (SPA).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
export { SessionDO };
