// Admin: password gate (setup on first run, `?reset=1` to reset, sign out)
// and the data view — quizzes (click to edit, deletable), sessions (open the
// host screen, expandable detail, deletable), players with IPs, per-answer
// records.

import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  adminLogin,
  adminOverview,
  adminSessionDetail,
  adminSetPassword,
  adminStatus,
  adminVerify,
  deleteQuiz,
  deleteSession,
  store,
  type AdminOverview,
  type AdminSessionDetail,
} from './api';
import { nav } from './state';
import { Footer } from './ui';

const wantsReset = () => /(^|[?&])reset=1/.test(location.hash.split('?')[1] ?? '');

type Phase = 'loading' | 'setup' | 'login' | 'reset' | 'ok';

/** Password gate. Renders children(token, signOut) once unlocked. */
export function AdminGate({ children }: { children: (token: string, signOut: () => void) => preact.ComponentChildren }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (wantsReset()) {
      setPhase('reset');
      return;
    }
    const stored = store.adminToken();
    if (stored) {
      adminVerify(stored)
        .then(() => {
          setToken(stored);
          setPhase('ok');
        })
        .catch(() => {
          store.setAdminToken(null);
          return adminStatus().then((s) => setPhase(s.setup ? 'setup' : 'login'));
        });
    } else {
      adminStatus()
        .then((s) => setPhase(s.setup ? 'setup' : 'login'))
        .catch(() => setPhase('login'));
    }
  }, []);

  const submit = async (password: string, mode: 'setup' | 'reset' | 'login') => {
    setBusy(true);
    setError('');
    try {
      const res = mode === 'login' ? await adminLogin(password) : await adminSetPassword(password);
      store.setAdminToken(res.token);
      setToken(res.token);
      setPhase('ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  };

  const signOut = () => {
    store.setAdminToken(null);
    setToken('');
    setPhase('login');
  };

  if (phase === 'loading') return <p class="muted">Checking…</p>;
  if (phase === 'ok') return <>{children(token, signOut)}</>;
  return <PasswordForm mode={phase} busy={busy} error={error} onSubmit={(p) => submit(p, phase)} />;
}

function PasswordForm({
  mode,
  busy,
  error,
  onSubmit,
}: {
  mode: 'setup' | 'login' | 'reset';
  busy: boolean;
  error: string;
  onSubmit: (password: string) => void;
}) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const confirming = mode !== 'login';
  const mismatch = confirming && pw !== pw2;
  const title = mode === 'setup' ? 'Set up your admin password' : mode === 'reset' ? 'Reset admin password' : 'Admin sign-in';
  const hint =
    mode === 'setup'
      ? 'First run: pick the password that protects quiz management and the data view.'
      : mode === 'reset'
        ? 'Setting a new password invalidates the old one and signs out other devices.'
        : 'Enter the admin password to manage quizzes and view recorded data.';

  return (
    <div class="card admin-gate">
      <div class="card-title">{title}</div>
      <p class="muted small">{hint}</p>
      <input
        type="password"
        placeholder="Password"
        value={pw}
        disabled={busy}
        onInput={(e) => setPw((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && !mismatch && pw && onSubmit(pw)}
      />
      {confirming && (
        <input
          type="password"
          placeholder="Repeat password"
          value={pw2}
          disabled={busy}
          onInput={(e) => setPw2((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && !mismatch && pw && onSubmit(pw)}
        />
      )}
      <button class="btn btn-primary" disabled={busy || !pw || mismatch} onClick={() => onSubmit(pw)}>
        {mode === 'login' ? 'Sign in' : 'Save password'}
      </button>
      {mismatch && <div class="error">Passwords do not match.</div>}
      {error && <div class="error">{error}</div>}
      {mode !== 'login' && (
        <p class="muted small">
          Forgot it? Come back with <code class="mono">?reset=1</code> in the URL.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- data page

const fmt = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function AdminPage() {
  return (
    <div class="page">
      <div class="edit-header">
        <button class="btn btn-ghost btn-sm" onClick={() => nav('/')}>
          ← Home
        </button>
        <div class="card-title">Admin — recorded data</div>
      </div>
      <AdminGate>{(token, signOut) => <AdminData token={token} signOut={signOut} />}</AdminGate>
      <Footer />
    </div>
  );
}

function AdminData({ token, signOut }: { token: string; signOut: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const loadOverview = () =>
    adminOverview(token)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));

  useEffect(() => {
    void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const removeQuiz = async (id: string, title: string) => {
    if (!confirm(`Delete quiz "${title}"? Its sessions and all recorded data go too.`)) return;
    try {
      await deleteQuiz(token, id);
      setError('');
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const removeSession = async (code: string) => {
    if (!confirm(`Delete session ${code}? Its players, answers and live game are removed.`)) return;
    try {
      await deleteSession(token, code);
      setError('');
      setOpen(null);
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  if (error) return <div class="error">{error}</div>;
  if (!data) return <p class="muted">Loading…</p>;

  return (
    <>
      <div class="qrow">
        <p class="muted small" style="flex:1">
          Click a quiz title to edit it; click a session row for its records.
        </p>
        <button class="btn btn-ghost btn-sm" onClick={signOut}>
          Sign out
        </button>
      </div>

      <div class="card">
        <div class="card-title">Quizzes ({data.quizzes.length})</div>
        <table class="admin-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>ID</th>
              <th>Created</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.quizzes.map((q) => (
              <tr key={q.id}>
                <td>
                  <a
                    href={`#/edit/${q.id}?token=${q.edit_token}`}
                    title="Open the editor for this quiz"
                    style="cursor:pointer;text-decoration:underline;text-decoration-color:var(--accent)"
                  >
                    {q.title}
                  </a>
                </td>
                <td class="mono small">{q.id}</td>
                <td class="small">{fmt(q.created_at)}</td>
                <td class="small">{fmt(q.updated_at)}</td>
                <td>
                  <button class="icon-btn" title="Delete quiz" onClick={() => removeQuiz(q.id, q.title)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {data.quizzes.length === 0 && (
              <tr>
                <td colspan={5} class="muted">
                  No quizzes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Sessions ({data.sessions.length})</div>
        <table class="admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Quiz</th>
              <th>Status</th>
              <th>Players</th>
              <th>Started</th>
              <th>Ended</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <Fragment key={s.code}>
                <tr class="session-row" onClick={() => setOpen(open === s.code ? null : s.code)}>
                  <td class="mono">{s.code}</td>
                  <td>{s.title}</td>
                  <td>
                    <span class={`badge ${s.status === 'live' ? 'mode-ws' : ''}`}>{s.status}</span>
                  </td>
                  <td>{s.player_count}</td>
                  <td class="small">{fmt(s.created_at)}</td>
                  <td class="small">{fmt(s.ended_at)}</td>
                  <td class="qrow" style="flex-wrap:nowrap">
                    <a class="icon-btn" title="Open host screen" href={`#/host/${s.code}?h=${s.host_token}`}>
                      ▶
                    </a>
                    <button
                      class="icon-btn"
                      title="Delete session"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeSession(s.code);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
                {open === s.code && <SessionDetail token={token} code={s.code} span={7} />}
              </Fragment>
            ))}
            {data.sessions.length === 0 && (
              <tr>
                <td colspan={7} class="muted">
                  No sessions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p class="muted small">Click a session to see players (IP, user agent) and every recorded answer.</p>
      </div>

      <div class="card">
        <div class="card-title">Recent joins ({data.players.length})</div>
        <table class="admin-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Name</th>
              <th>Score</th>
              <th>IP</th>
              <th>User agent</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {data.players.map((p) => (
              <tr key={p.session_code + p.player_id}>
                <td class="mono">{p.session_code}</td>
                <td>{p.name}</td>
                <td>{p.score.toLocaleString()}</td>
                <td class="mono small">{p.ip ?? '—'}</td>
                <td class="small ua-cell">{p.user_agent ?? '—'}</td>
                <td class="small">{fmt(p.joined_at)}</td>
              </tr>
            ))}
            {data.players.length === 0 && (
              <tr>
                <td colspan={6} class="muted">
                  No players recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SessionDetail({ token, code, span }: { token: string; code: string; span: number }) {
  const [d, setD] = useState<AdminSessionDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminSessionDetail(token, code)
      .then(setD)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load session'));
  }, [token, code]);

  if (error) return (
    <tr>
      <td colspan={span}>
        <div class="error">{error}</div>
      </td>
    </tr>
  );
  if (!d) return (
    <tr>
      <td colspan={span} class="muted">
        Loading session…
      </td>
    </tr>
  );

  return (
    <tr>
      <td colspan={span}>
        <div class="session-detail">
          <div class="home-list-title">Players &amp; scores</div>
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Score</th>
                <th>IP</th>
                <th>User agent</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {d.players.map((p) => (
                <tr key={p.player_id}>
                  <td>{p.name}</td>
                  <td>{p.score.toLocaleString()}</td>
                  <td class="mono small">{p.ip ?? '—'}</td>
                  <td class="small ua-cell">{p.user_agent ?? '—'}</td>
                  <td class="small">{fmt(p.joined_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="home-list-title">Answers</div>
          <table class="admin-table">
            <thead>
              <tr>
                <th>Q#</th>
                <th>Player</th>
                <th>Answer</th>
                <th>Outcome</th>
                <th>Points</th>
                <th>At</th>
              </tr>
            </thead>
            <tbody>
              {d.answers.map((a, i) => (
                <tr key={i}>
                  <td>{a.q_index + 1}</td>
                  <td>{a.name ?? a.player_id}</td>
                  <td class="mono small">{a.answer}</td>
                  <td>{a.correct === null ? 'unscored' : a.correct ? 'correct' : 'wrong'}</td>
                  <td>{a.gained.toLocaleString()}</td>
                  <td class="small">{fmt(a.answered_at)}</td>
                </tr>
              ))}
              {d.answers.length === 0 && (
                <tr>
                  <td colspan={6} class="muted">
                    No answers recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  );
}
