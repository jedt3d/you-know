// Hash router + realtime session connection.
//
// Receives state pushes over WebSocket (auto-reconnect, hibernation-friendly:
// the socket only listens). All actions (answers, host commands) go over
// plain HTTP, which doubles as the fallback when WebSockets are blocked —
// in that mode the client polls GET /api/sessions/:code/state.

import { useEffect, useState } from 'preact/hooks';
import type { SessionStateView } from '../shared/types.ts';

export type ConnMode = 'connecting' | 'ws' | 'poll';

export class SessionConn {
  state: SessionStateView | null = null;
  mode: ConnMode = 'connecting';
  /** Set when the poll fallback gets a 403 — player unknown/removed. */
  forbidden = false;
  offset = 0; // serverTime - Date.now() at last message
  ws: WebSocket | null = null;
  private pollTimer: number | null = null;
  private retryTimer: number | null = null;
  private attempts = 0;
  private closed = false;
  private listeners = new Set<() => void>();

  constructor(private code: string, private auth: { p?: string; h?: string }) {}

  connect() {
    this.openWs();
  }

  subscribe(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    for (const cb of this.listeners) cb();
  }

  private get query() {
    const { p, h } = this.auth;
    return h ? 'h=' + encodeURIComponent(h) : p ? 'p=' + encodeURIComponent(p) : '';
  }

  private openWs() {
    if (this.closed) return;
    this.mode = this.attempts >= 3 ? 'poll' : 'connecting';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/${this.code}?${this.query}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.mode = 'ws';
      this.stopPoll();
      this.emit();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'state') this.applyState(msg.state as SessionStateView);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = ws.onerror = () => this.scheduleRetry();
  }

  private applyState(s: SessionStateView) {
    this.state = s;
    this.offset = s.serverTime - Date.now();
    this.emit();
  }

  private scheduleRetry() {
    if (this.closed || this.retryTimer != null) return;
    this.attempts++;
    if (this.attempts >= 3) this.startPoll();
    const delay = Math.min(400 * 2 ** Math.min(this.attempts, 4), 10_000);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.openWs();
    }, delay);
    this.emit();
  }

  private startPoll() {
    if (this.pollTimer != null) return;
    this.mode = 'poll';
    this.pollOnce();
    this.pollTimer = window.setInterval(() => this.pollOnce(), 2500);
    this.emit();
  }

  private stopPoll() {
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce() {
    if (this.closed) return;
    try {
      const res = await fetch(`/api/sessions/${this.code}/state?${this.query}`);
      if (res.ok) this.applyState(await res.json());
      else if (res.status === 403) {
        this.forbidden = true;
        this.emit();
      }
    } catch {
      // offline; keep polling
    }
  }

  /** Current server time, expressed on the local clock. */
  serverNow() {
    return Date.now() + this.offset;
  }

  close() {
    this.closed = true;
    this.stopPoll();
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }
}

export function useConn(code: string, auth: { p?: string; h?: string }) {
  const [conn] = useState(() => new SessionConn(code, auth));
  const [, setTick] = useState(0);
  useEffect(() => {
    conn.connect();
    const unsub = conn.subscribe(() => setTick((t) => t + 1));
    // occasional clock re-sync (cheap; also keeps intermediaries honest)
    const sync = window.setInterval(() => {
      if (conn.mode === 'ws' && conn.ws?.readyState === WebSocket.OPEN) conn.ws.send('{"t":"sync"}');
    }, 30_000);
    return () => {
      unsub();
      clearInterval(sync);
      conn.close();
    };
  }, [conn]);
  return conn;
}

// ------------------------------------------------------------------ router

export function useRoute(): string {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || '/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const nav = (to: string) => {
  location.hash = to;
};
