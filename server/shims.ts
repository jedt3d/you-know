// Node shims: run the Cloudflare-shaped code (src/index.ts + src/session-do.ts)
// unmodified on a plain Linux server.
//
//  - D1Database            → better-sqlite3 (same SQL, same prepare/bind API)
//  - DurableObjectNamespace → one in-process SessionDO per join code, state
//                            persisted to SQLite so restarts survive
//  - WebSocketPair         → a virtual in-memory pair; the "client" end gets
//                            piped to the real `ws` socket at upgrade time
//  - storage.setAlarm      → setTimeout (+ persisted timestamp, re-armed on boot)

import Database from 'better-sqlite3';

// The DO class is written against workers-types ambient globals; at runtime
// it is plain JS shaped exactly like our shim expects.
// @ts-ignore -- worker-typed module, identical runtime shape under these shims
import { SessionDO } from '../src/session-do.ts';

// ------------------------------------------------------------------ sqlite

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id         TEXT PRIMARY KEY,
      edit_token TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quizzes_edit_token ON quizzes(edit_token);
    CREATE TABLE IF NOT EXISTS sessions (
      code       TEXT PRIMARY KEY,
      quiz_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_quiz ON sessions(quiz_id);
    CREATE TABLE IF NOT EXISTS do_state (
      name     TEXT PRIMARY KEY,
      json     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      session_code TEXT NOT NULL,
      player_id    TEXT NOT NULL,
      name         TEXT NOT NULL,
      ip           TEXT,
      user_agent   TEXT,
      score        INTEGER NOT NULL DEFAULT 0,
      joined_at    INTEGER NOT NULL,
      PRIMARY KEY (session_code, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_code);
    CREATE TABLE IF NOT EXISTS answers (
      session_code TEXT NOT NULL,
      player_id    TEXT NOT NULL,
      q_index      INTEGER NOT NULL,
      answer       TEXT NOT NULL,
      correct      INTEGER,
      gained       INTEGER NOT NULL DEFAULT 0,
      answered_at  INTEGER NOT NULL,
      PRIMARY KEY (session_code, player_id, q_index)
    );
    CREATE INDEX IF NOT EXISTS idx_answers_session ON answers(session_code);
  `);
  // v0.2 session columns (SQLite has no ADD COLUMN IF NOT EXISTS)
  const cols = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has('title')) db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
  if (!cols.has('status')) db.exec(`ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'live'`);
  if (!cols.has('ended_at')) db.exec('ALTER TABLE sessions ADD COLUMN ended_at INTEGER');
  return db;
}

// ------------------------------------------------------------------ D1 shim

interface D1Result<T> {
  first<T2 = T>(): Promise<T2 | null>;
  all<T2 = T>(): Promise<{ results: T2[] }>;
  run(): Promise<{ success: true }>;
}

export function makeD1(db: Database.Database) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const ops = (...args: unknown[]): D1Result<never> => ({
        async first<T>() {
          return (stmt.get(...args) as T) ?? null;
        },
        async all<T>() {
          return { results: stmt.all(...args) as T[] };
        },
        async run() {
          stmt.run(...args);
          return { success: true } as const;
        },
      });
      // D1 allows prepare().all() with no bindings at all
      const unbound = ops();
      return { bind: ops, first: unbound.first, all: unbound.all, run: unbound.run };
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      // sequential execution; D1's transactional batch is not needed for
      // these idempotent record writes
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  };
}

// ------------------------------------------------------- virtual WebSocket

/** One end of a virtual WebSocketPair. Messages "sent" are delivered to the
 *  peer end's `_onmessage`; the DO-facing end dispatches into the class's
 *  webSocketMessage/webSocketClose handlers via the ctx shim. */
export class ShimWebSocket {
  peer: ShimWebSocket | null = null;
  private attachment: unknown = null;
  private queue: string[] = [];
  closed = false;
  _onmessage: ((data: string) => void) | null = null;
  _onclose: (() => void) | null = null;

  send(data: string): void {
    if (this.closed || !this.peer || peerClosed(this.peer)) return;
    this.peer._deliver(data);
  }

  /** data arriving at this end (peer called send) */
  _deliver(data: string): void {
    if (this.closed) return;
    // The DO sends the initial state during the upgrade, before the ws glue
    // has wired this end to the real socket — buffer until the handler lands.
    if (!this._onmessage) {
      this.queue.push(data);
      return;
    }
    this._onmessage(data);
  }

  /** Wire a handler and flush anything queued before it existed. */
  setOnmessage(fn: (data: string) => void): void {
    this._onmessage = fn;
    for (const m of this.queue.splice(0)) {
      if (this.closed) return;
      fn(m);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this._onclose?.();
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer._onclose?.();
    }
  }

  serializeAttachment(a: unknown): void {
    this.attachment = a;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

function peerClosed(p: ShimWebSocket): boolean {
  return p.closed;
}

export function WebSocketPair(): { 0: ShimWebSocket; 1: ShimWebSocket } {
  const a = new ShimWebSocket();
  const b = new ShimWebSocket();
  a.peer = b;
  b.peer = a;
  return { 0: a, 1: b };
}

// The DO constructs `new WebSocketPair()` — install the shim globally.
(globalThis as unknown as Record<string, unknown>).WebSocketPair = WebSocketPair;

// Node's Response rejects status 101 (switching protocols) — the DO returns
// `new Response(null, { status: 101, webSocket })` on upgrade. Wrap Response
// to allow it and carry the webSocket handle through to the ws glue.
const OrigResponse = globalThis.Response;
class Node101Response extends OrigResponse {
  // the ws glue reads the accepted server end from ctx.lastAccepted instead;
  // this property just mirrors the Workers shape for fidelity
  declare webSocket: WebSocket | null;
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    const status = (init as { status?: number } | undefined)?.status;
    if (status === 101) {
      super(null);
      Object.defineProperty(this, 'status', { value: 101 });
      (this as { webSocket: WebSocket | null }).webSocket =
        ((init as { webSocket?: WebSocket } | undefined)?.webSocket) ?? null;
    } else {
      super(body, init);
    }
  }
}
(globalThis as unknown as Record<string, unknown>).Response = Node101Response;

// ------------------------------------------------------------ DO namespace

interface Persisted {
  store: Record<string, unknown>;
  alarmAt: number | null;
}

type SessionLike = {
  fetch(req: Request): Promise<Response>;
  alarm(): Promise<void>;
  webSocketMessage(ws: ShimWebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: ShimWebSocket): Promise<void>;
};

class SessionCtx {
  sockets = new Set<ShimWebSocket>();
  /** the server end accepted by the most recent /ws fetch (upgrade glue reads .peer) */
  lastAccepted: ShimWebSocket | null = null;
  private alarmTimer: NodeJS.Timeout | null = null;
  alarmAt: number | null = null;
  store: Record<string, unknown> = {};

  constructor(
    private persist: () => void,
    private instance: SessionLike,
  ) {}

  storage = {
    get: async <T>(key: string): Promise<T | undefined> => this.store[key] as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      this.store[key] = value;
      this.persist();
    },
    setAlarm: async (ts: number): Promise<void> => this.arm(ts),
    deleteAlarm: async (): Promise<void> => this.arm(null),
  };

  setWebSocketAutoResponse(_s: unknown): void {
    // liveness pings are answered by the upgrade glue; nothing to do here
  }

  acceptWebSocket(ws: ShimWebSocket): void {
    this.sockets.add(ws);
    this.lastAccepted = ws;
    ws._onmessage = (data) => {
      if (data === '{"t":"ping"}') {
        ws.send('{"t":"pong"}');
        return;
      }
      void this.instance.webSocketMessage(ws, data);
    };
    ws._onclose = () => {
      this.sockets.delete(ws);
      void this.instance.webSocketClose(ws);
    };
  }

  getWebSockets(): ShimWebSocket[] {
    return [...this.sockets];
  }

  arm(ts: number | null): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    this.alarmAt = ts;
    this.persist();
    if (ts == null) return;
    const delay = Math.max(0, ts - Date.now());
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = null;
      this.alarmAt = null;
      void this.instance.alarm();
    }, delay);
  }

  hydrate(p: Persisted): void {
    this.store = p.store ?? {};
    if (p.alarmAt != null && p.alarmAt > Date.now() - 60_000) {
      this.arm(p.alarmAt);
    }
  }

  snapshot(): Persisted {
    return { store: this.store, alarmAt: this.alarmAt };
  }
}

interface Entry {
  ctx: SessionCtx;
  instance: SessionLike;
}

export class SessionNamespace {
  private entries = new Map<string, Entry>();

  constructor(private db: Database.Database) {
    // Re-arm live sessions after a restart (mid-question timers).
    const rows = this.db.prepare('SELECT name FROM do_state').all() as { name: string }[];
    for (const r of rows) this.entry(r.name);
  }

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(_id: { name: string } | string): { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
    // Namespace.get is always called right after idFromName in src/index.ts
    // (stubFor) — resolve the name lazily from the most recent id.
    const name = typeof _id === 'string' ? _id : _id.name;
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        return this.entry(name).instance.fetch(req);
      },
    };
  }

  /** Upgrade entry point used by the ws glue: runs the DO's /ws route and
   *  returns the virtual client end to pipe into the real socket. */
  async upgrade(name: string, url: URL): Promise<{ status: number; client: ShimWebSocket | null }> {
    const e = this.entry(name);
    const res = await e.instance.fetch(new Request('https://do' + url.pathname + url.search));
    const server = e.ctx.lastAccepted;
    e.ctx.lastAccepted = null;
    return { status: res.status, client: server ? server.peer : null };
  }

  private entry(name: string): Entry {
    let e = this.entries.get(name);
    if (!e) {
      const row = this.db.prepare('SELECT json FROM do_state WHERE name = ?').get(name) as
        | { json: string }
        | undefined;
      const ctx = new SessionCtx(() => this.writeState(name), null as unknown as SessionLike);
      // The class only uses ctx after construction, so back-fill the instance now.
      const instance = new SessionDO(ctx as never, {
        DB: makeD1(this.db) as unknown as D1Database,
      }) as unknown as SessionLike;
      (ctx as unknown as { instance: SessionLike }).instance = instance;
      e = { ctx, instance };
      this.entries.set(name, e);
      if (row) ctx.hydrate(JSON.parse(row.json) as Persisted);
      else this.writeState(name);
    }
    return e;
  }

  private writeState(name: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    this.db
      .prepare('INSERT INTO do_state (name, json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json')
      .run(name, JSON.stringify(e.ctx.snapshot()));
  }
}
