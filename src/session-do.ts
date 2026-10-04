// SessionDO — one hibernating Durable Object per live session.
//
// The DO owns the whole game: a frozen quiz snapshot, players, the current
// phase (lobby → question → reveal → ended), per-question answers and scores.
// Clients receive state pushes over WebSocket (hibernation API) and send
// actions (join / answer / host commands) over plain HTTP, which also serves
// as the polling fallback when WebSockets are blocked.

import type { Answer, Phase, PlayerPublic, PublicQuestion, Question, Quiz, RevealView, SessionStateView } from '../shared/types.ts';
import { sanitizeName } from '../shared/text.ts';
import { isCorrectAnswer, isLikertScored, pointsFor } from '../shared/scoring.ts';
import { LIMITS } from '../shared/validate.ts';
import { playerId as newPlayerId, playerToken as newPlayerToken } from './ids.ts';

interface Player {
  id: string;
  name: string;
  token: string;
  connected: boolean;
  score: number;
  lastGained: number;
  lastCorrect: boolean | null;
  joinedAt: number;
}

interface RecordedAnswer {
  answer: Answer;
  at: number;
}

interface SessionData {
  code: string;
  title: string;
  quiz: Quiz; // snapshot taken when the session started
  hostToken: string;
  createdAt: number;
  phase: Phase;
  qIndex: number;
  questionStartedAt: number;
  version: number;
  players: Record<string, Player>;
  answers: Record<string, RecordedAnswer>; // current question only
  kicked: Record<string, boolean>;
  joinMinute: number;
  joinCount: number;
}

type Attachment = { role: 'host' } | { role: 'player'; playerId: string } | null;

/** Slice of the Worker env the DO needs for durable record-keeping. */
interface D0Env {
  DB?: D1Database;
}

const MAX_JOINS_PER_MIN = 60;
const REVEAL_GRACE_MS = 300; // alarm fires slightly after the buzzer

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function validAnswer(q: Question, a: unknown): Answer | null {
  const x = (a ?? {}) as Record<string, unknown>;
  switch (q.type) {
    case 'choice':
      return x.kind === 'choice' && Number.isInteger(x.option) && (x.option as number) >= 0 && (x.option as number) < q.options.length
        ? { kind: 'choice', option: x.option as number }
        : null;
    case 'truefalse':
      return x.kind === 'truefalse' && typeof x.value === 'boolean' ? { kind: 'truefalse', value: x.value } : null;
    case 'short': {
      if (x.kind !== 'short' || typeof x.text !== 'string') return null;
      const text = x.text.slice(0, LIMITS.shortAnswerMaxLen).trim();
      return text ? { kind: 'short', text } : null;
    }
    case 'likert':
      return x.kind === 'likert' && Number.isInteger(x.value) && (x.value as number) >= q.likertMin && (x.value as number) <= q.likertMax
        ? { kind: 'likert', value: x.value as number }
        : null;
  }
}

export class SessionDO {
  private data: SessionData | null = null;

  constructor(private ctx: DurableObjectState, private env: D0Env = {}) {
    // Canned ping/pong responder — liveness checks never wake the DO.
    const S = (globalThis as unknown as Record<string, unknown>).WebSocketRequestResponseSerializer;
    if (typeof S === 'function') {
      this.ctx.setWebSocketAutoResponse(new (S as new (a: string, b: string) => unknown)('{"t":"ping"}', '{"t":"pong"}') as never);
    }
  }

  /** Fire-and-forget durable write — recording must never break the game. */
  private record(sql: string, ...args: unknown[]): void {
    const db = this.env.DB;
    if (!db) return;
    void db
      .prepare(sql)
      .bind(...args)
      .run()
      .catch((e) => console.error('[record]', (e as Error).message, sql.slice(0, 60)));
  }

  private recordBatch(sql: string, rows: unknown[][]): void {
    const db = this.env.DB;
    if (!db || rows.length === 0) return;
    const stmts = rows.map((r) => db.prepare(sql).bind(...r));
    // chunked: D1 caps statements per batch
    for (let i = 0; i < stmts.length; i += 50) {
      void db.batch(stmts.slice(i, i + 50)).catch((e) => console.error('[recordBatch]', (e as Error).message));
    }
  }

  // ------------------------------------------------------------ persistence

  private async load(): Promise<SessionData | null> {
    if (this.data) return this.data;
    this.data = (await this.ctx.storage.get<SessionData>('session')) ?? null;
    return this.data;
  }

  /** Persist, bump version and push state to every connected socket. */
  private async changed(): Promise<void> {
    const d = this.data!;
    d.version++;
    await this.ctx.storage.put('session', d);
    this.push();
  }

  private push(): void {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const att = this.attachment(ws);
      const role: 'host' | 'player' = att?.role === 'host' ? 'host' : 'player';
      const pid = att?.role === 'player' ? att.playerId : undefined;
      try {
        ws.send(JSON.stringify({ t: 'state', state: this.stateFor(role, pid) }));
      } catch {
        // socket closing; its close handler will clean up
      }
    }
  }

  private attachment(ws: WebSocket): Attachment {
    try {
      const a = ws.deserializeAttachment() as Attachment;
      return a && (a.role === 'host' || a.role === 'player') ? a : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ http entry

  private async readJson(req: Request): Promise<Record<string, unknown>> {
    try {
      return ((await req.json()) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    await this.load();
    try {
      if (req.method === 'POST' && url.pathname === '/create') return await this.create(await this.readJson(req));
      if (req.method === 'POST' && url.pathname === '/drop') {
        // Admin delete: wipe state + alarm; connected sockets fall away.
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.data = null;
        return json({ ok: true });
      }
      if (!this.data) return json({ error: 'not_found' }, 404);
      if (req.method === 'GET' && url.pathname === '/summary') return json(this.summary());
      if (req.method === 'GET' && url.pathname === '/state') return this.getState(url);
      if (req.method === 'GET' && url.pathname.startsWith('/ws')) return await this.acceptWs(url);
      if (req.method === 'POST' && url.pathname === '/join') return await this.join(req);
      if (req.method === 'POST' && url.pathname === '/answer') return await this.answer(await this.readJson(req));
      if (req.method === 'POST' && url.pathname === '/cmd') return await this.command(await this.readJson(req));
      return json({ error: 'bad_route' }, 404);
    } catch (e) {
      console.error('session-do error', e);
      return json({ error: 'internal' }, 500);
    }
  }

  // ------------------------------------------------------------ lifecycle

  private async create(body: Record<string, unknown>): Promise<Response> {
    if (this.data) return json({ error: 'exists' }, 409);
    const quiz = body.quiz as Quiz | undefined;
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) return json({ error: 'empty_quiz' }, 400);
    this.data = {
      code: String(body.code ?? '').slice(0, 8),
      title: String(quiz.title ?? 'Quiz').slice(0, LIMITS.titleMax),
      quiz,
      hostToken: String(body.hostToken ?? ''),
      createdAt: Date.now(),
      phase: 'lobby',
      qIndex: -1,
      questionStartedAt: 0,
      version: 1,
      players: {},
      answers: {},
      kicked: {},
      joinMinute: 0,
      joinCount: 0,
    };
    await this.ctx.storage.put('session', this.data);
    return json({ ok: true, hostToken: this.data.hostToken });
  }

  private summary() {
    const d = this.data!;
    return { exists: true, title: d.title, phase: d.phase, playerCount: Object.keys(d.players).length };
  }

  private byToken(token: string): Player | undefined {
    return Object.values(this.data!.players).find((p) => p.token === token);
  }

  // ------------------------------------------------------------ players

  private async join(req: Request): Promise<Response> {
    const d = this.data!;
    const body = await this.readJson(req);
    if (d.phase === 'ended') return json({ error: 'game_over' }, 410);
    const name = sanitizeName(String(body.name ?? ''));
    if (!name) return json({ error: 'bad_name' }, 400);

    const minute = Math.floor(Date.now() / 60_000);
    if (minute === d.joinMinute) {
      if (++d.joinCount > MAX_JOINS_PER_MIN) return json({ error: 'slow_down' }, 429);
    } else {
      d.joinMinute = minute;
      d.joinCount = 1;
    }
    if (Object.keys(d.players).length >= LIMITS.playersMax) return json({ error: 'room_full' }, 403);

    // Rejoin with an existing token keeps your score.
    const existing = body.playerToken ? this.byToken(String(body.playerToken)) : undefined;
    if (existing && !d.kicked[existing.id] && sanitizeName(String(body.name ?? '')) === existing.name) {
      await this.changed();
      return json({ playerId: existing.id, playerToken: existing.token, rejoined: true });
    }

    const id = newPlayerId();
    const token = newPlayerToken();
    const ip = req.headers.get('x-player-ip');
    const ua = req.headers.get('x-player-ua');
    d.players[id] = { id, name, token, connected: false, score: 0, lastGained: 0, lastCorrect: null, joinedAt: Date.now() };
    await this.changed();
    this.record(
      'INSERT INTO players (session_code, player_id, name, ip, user_agent, score, joined_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      d.code,
      id,
      name,
      ip,
      ua,
      Date.now(),
    );
    return json({ playerId: id, playerToken: token });
  }

  private async answer(body: Record<string, unknown>): Promise<Response> {
    const d = this.data!;
    const player = this.byToken(String(body.playerToken ?? ''));
    if (!player || d.kicked[player.id]) return json({ error: 'unknown_player' }, 403);
    if (d.phase !== 'question') return json({ error: 'not_accepting' }, 409);
    if (Number(body.qIndex) !== d.qIndex) return json({ error: 'stale_question' }, 409);
    if (d.answers[player.id]) return json({ error: 'already_answered' }, 409);

    const q = d.quiz.questions[d.qIndex];
    const answer = validAnswer(q, body.answer);
    if (!answer) return json({ error: 'bad_answer' }, 400);

    d.answers[player.id] = { answer, at: Date.now() };
    player.lastGained = 0;
    player.lastCorrect = null;

    // Auto-reveal once every connected player has answered.
    const connected = Object.values(d.players).filter((p) => p.connected && !d.kicked[p.id]);
    if (connected.length > 0 && connected.every((p) => d.answers[p.id])) {
      await this.reveal();
    } else {
      await this.changed();
    }
    return json({ ok: true });
  }

  // ------------------------------------------------------------ host

  private requireHost(body: Record<string, unknown>): boolean {
    return typeof body.hostToken === 'string' && body.hostToken === this.data!.hostToken;
  }

  private async command(body: Record<string, unknown>): Promise<Response> {
    const d = this.data!;
    if (!this.requireHost(body)) return json({ error: 'forbidden' }, 403);
    const cmd = String(body.cmd ?? '');

    switch (cmd) {
      case 'start':
        if (d.phase !== 'lobby') return json({ error: 'bad_phase' }, 409);
        await this.beginQuestion(0);
        return json({ ok: true });
      case 'reveal':
        if (d.phase !== 'question') return json({ error: 'bad_phase' }, 409);
        await this.reveal();
        return json({ ok: true });
      case 'next':
        if (d.phase !== 'reveal') return json({ error: 'bad_phase' }, 409);
        if (d.qIndex + 1 < d.quiz.questions.length) await this.beginQuestion(d.qIndex + 1);
        else await this.end();
        return json({ ok: true });
      case 'end':
        await this.end();
        return json({ ok: true });
      case 'kick': {
        const id = String(body.playerId ?? '');
        if (!d.players[id]) return json({ error: 'not_found' }, 404);
        delete d.players[id];
        delete d.answers[id];
        d.kicked[id] = true;
        const connected = Object.values(d.players).filter((p) => p.connected);
        if (d.phase === 'question' && connected.length > 0 && connected.every((p) => d.answers[p.id])) {
          await this.reveal();
        } else {
          await this.changed();
        }
        return json({ ok: true });
      }
      default:
        return json({ error: 'bad_cmd' }, 400);
    }
  }

  private async beginQuestion(i: number): Promise<void> {
    const d = this.data!;
    d.qIndex = i;
    d.phase = 'question';
    d.questionStartedAt = Date.now();
    d.answers = {};
    for (const p of Object.values(d.players)) {
      p.lastGained = 0;
      p.lastCorrect = null;
    }
    await this.changed();
    const limitMs = d.quiz.questions[i].timeLimitSec * 1000;
    await this.ctx.storage.setAlarm(d.questionStartedAt + limitMs + REVEAL_GRACE_MS);
  }

  private async reveal(): Promise<void> {
    const d = this.data!;
    if (d.phase !== 'question') return;
    const q = d.quiz.questions[d.qIndex];
    const unscored = q.type === 'likert' && !isLikertScored(q);
    const scoreRows: unknown[][] = [];
    const answerRows: unknown[][] = [];
    for (const p of Object.values(d.players)) {
      const rec = d.answers[p.id];
      if (unscored) {
        p.lastGained = 0;
        p.lastCorrect = null;
        if (rec) answerRows.push([d.code, p.id, d.qIndex, JSON.stringify(rec.answer), null, 0, rec.at]);
        continue;
      }
      if (!rec) {
        p.lastGained = 0;
        p.lastCorrect = false;
        continue;
      }
      const gained = pointsFor(q, rec.answer, rec.at - d.questionStartedAt);
      p.lastGained = gained;
      p.lastCorrect = gained > 0;
      p.score += gained;
      scoreRows.push([p.score, d.code, p.id]);
      answerRows.push([d.code, p.id, d.qIndex, JSON.stringify(rec.answer), gained > 0 ? 1 : 0, gained, rec.at]);
    }
    d.phase = 'reveal';
    await this.changed();
    // durable record — every answer with its outcome, and the running scores
    this.recordBatch(
      'UPDATE players SET score = ? WHERE session_code = ? AND player_id = ?',
      scoreRows,
    );
    this.recordBatch(
      `INSERT INTO answers (session_code, player_id, q_index, answer, correct, gained, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_code, player_id, q_index) DO UPDATE SET answer = excluded.answer, correct = excluded.correct, gained = excluded.gained, answered_at = excluded.answered_at`,
      answerRows,
    );
  }

  private async end(): Promise<void> {
    const d = this.data!;
    d.phase = 'ended';
    await this.changed();
    await this.ctx.storage.deleteAlarm();
    this.record('UPDATE sessions SET status = ?, ended_at = ? WHERE code = ?', 'ended', Date.now(), d.code);
  }

  async alarm(): Promise<void> {
    await this.load();
    const d = this.data;
    if (!d || d.phase !== 'question') return;
    const limitMs = d.quiz.questions[d.qIndex].timeLimitSec * 1000;
    if (Date.now() >= d.questionStartedAt + limitMs) await this.reveal();
  }

  // ------------------------------------------------------------ websockets

  private async acceptWs(url: URL): Promise<Response> {
    const d = this.data!;
    const h = url.searchParams.get('h');
    const p = url.searchParams.get('p');
    let attachment: Attachment = null;

    if (h) {
      if (h !== d.hostToken) return new Response('forbidden', { status: 403 });
      attachment = { role: 'host' };
    } else if (p) {
      const player = this.byToken(p);
      if (!player || d.kicked[player.id]) return new Response('unknown player', { status: 403 });
      player.connected = true;
      await this.ctx.storage.put('session', d);
      attachment = { role: 'player', playerId: player.id };
    } else {
      return new Response('unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ t: 'state', state: this.stateFor(attachment.role === 'host' ? 'host' : 'player', attachment.role === 'player' ? attachment.playerId : undefined) }));
    return new Response(null, { status: 101, webSocket: client } as Response & { webSocket: WebSocket });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const att = this.attachment(ws);
    if (!att) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.t === 'sync') {
      ws.send(JSON.stringify({ t: 'state', state: this.stateFor(att.role === 'host' ? 'host' : 'player', att.role === 'player' ? att.playerId : undefined) }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.load();
    const att = this.attachment(ws);
    if (att?.role === 'player' && this.data?.players[att.playerId]) {
      this.data.players[att.playerId].connected = false;
      await this.ctx.storage.put('session', this.data);
      this.push();
    }
  }

  // ------------------------------------------------------------ state view

  private getState(url: URL): Response {
    const d = this.data!;
    const h = url.searchParams.get('h');
    const p = url.searchParams.get('p');
    if (h) {
      if (h !== d.hostToken) return json({ error: 'forbidden' }, 403);
      return json(this.stateFor('host'));
    }
    if (p) {
      const player = this.byToken(p);
      if (!player) return json({ error: 'unknown_player' }, 403);
      return json(this.stateFor('player', player.id));
    }
    // Unauthenticated read: lobby-safe summary only.
    return json(this.summary());
  }

  private currentQuestion(): Question | null {
    const d = this.data!;
    return d.qIndex >= 0 && d.qIndex < d.quiz.questions.length ? d.quiz.questions[d.qIndex] : null;
  }

  private rankedPlayers(): PlayerPublic[] {
    const d = this.data!;
    const scores = [...new Set(Object.values(d.players).map((p) => p.score))].sort((a, b) => b - a);
    return Object.values(d.players)
      .map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        score: p.score,
        answered: !!d.answers[p.id],
        rank: scores.indexOf(p.score) + 1,
      }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  private buildReveal(q: Question): RevealView {
    const d = this.data!;
    const answers = Object.values(d.answers).map((r) => r.answer);
    if (q.type === 'choice') {
      const rows = q.options.map((label, i) => ({
        label,
        count: answers.filter((a) => a.kind === 'choice' && a.option === i).length,
        correct: i === q.correct,
      }));
      return { kind: 'choice', rows, correctLabel: q.options[q.correct] };
    }
    if (q.type === 'truefalse') {
      const t = answers.filter((a) => a.kind === 'truefalse' && a.value).length;
      const rows = [
        { label: 'True', count: t, correct: q.answer === true },
        { label: 'False', count: answers.length - t, correct: q.answer === false },
      ];
      return { kind: 'truefalse', rows, correctLabel: q.answer ? 'True' : 'False' };
    }
    if (q.type === 'short') {
      const matched = answers.filter((a) => a.kind === 'short' && isCorrectAnswer(q, a)).length;
      return {
        kind: 'short',
        rows: [
          { label: 'Correct', count: matched, correct: true },
          { label: 'Not quite', count: answers.length - matched },
        ],
        ...(q.acceptAny ? { correctLabel: 'Any answer' } : { accepted: q.accepted }),
      };
    }
    // likert — rows highlight marked values; unscored polls show none
    const scored = isLikertScored(q);
    const rows: RevealView['rows'] = [];
    let sum = 0;
    for (let v = q.likertMin; v <= q.likertMax; v++) {
      const count = answers.filter((a) => a.kind === 'likert' && a.value === v).length;
      sum += count * v;
      rows.push({ label: q.likertLabels?.[v - q.likertMin] || String(v), count, ...(scored && q.correctValues!.includes(v) ? { correct: true } : {}) });
    }
    const average = answers.length ? Math.round((sum / answers.length) * 10) / 10 : 0;
    return { kind: 'likert', rows, average, ...(scored ? { correctLabel: q.correctValues!.join(' / ') } : {}) };
  }

  stateFor(role: 'host' | 'player', playerId?: string): SessionStateView {
    const d = this.data!;
    const q = this.currentQuestion();
    const showQuestion = (d.phase === 'question' || d.phase === 'reveal') && !!q;
    let question: PublicQuestion | null = null;
    if (showQuestion && q) {
      question = {
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        timeLimitSec: q.timeLimitSec,
        ...(q.image ? { image: q.image } : {}),
        ...(q.type === 'choice' ? { options: q.options } : {}),
        ...(q.type === 'likert' ? { likertMin: q.likertMin, likertMax: q.likertMax, likertLabels: q.likertLabels } : {}),
      };
    }
    const you = role === 'player' && playerId ? d.players[playerId] : undefined;
    return {
      code: d.code,
      title: d.title,
      phase: d.phase,
      version: d.version,
      questionCount: d.quiz.questions.length,
      questionIndex: d.phase === 'lobby' ? -1 : d.phase === 'ended' ? d.quiz.questions.length : d.qIndex,
      questionStartedAt: d.questionStartedAt,
      serverTime: Date.now(),
      players: this.rankedPlayers(),
      question,
      reveal: d.phase === 'reveal' && q ? this.buildReveal(q) : null,
      you: you
        ? {
            id: you.id,
            name: you.name,
            score: you.score,
            rank: (this.rankedPlayers().find((p) => p.id === you.id)?.rank) ?? 1,
            answered: !!d.answers[you.id],
            answer: d.answers[you.id]?.answer ?? null,
            lastGained: you.lastGained,
            lastCorrect: you.lastCorrect,
          }
        : null,
    };
  }
}
