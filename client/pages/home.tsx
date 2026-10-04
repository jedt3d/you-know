// Home — join a game by code (open to everyone) or host. Admin lives only
// at /admin: if this device holds a verified admin token the Host card shows
// the server-side lists and creates quizzes directly; otherwise "Create a
// quiz" takes you to /admin to sign in first.

import { useEffect, useState } from 'preact/hooks';
import { adminOverview, adminVerify, createQuiz, store, type AdminOverview } from '../api';
import { nav } from '../state';
import { Footer, Wordmark } from '../ui';

export default function Home() {
  const [token, setToken] = useState<string | null | undefined>(undefined); // undefined = checking
  const [overview, setOverview] = useState<AdminOverview | null>(null);

  useEffect(() => {
    const t = store.adminToken();
    if (!t) {
      setToken(null);
      return;
    }
    adminVerify(t)
      .then(() => setToken(t))
      .catch(() => {
        store.setAdminToken(null);
        setToken(null);
      });
  }, []);

  useEffect(() => {
    if (!token) return;
    adminOverview(token)
      .then(setOverview)
      .catch(() => setOverview(null));
  }, [token]);

  const signOut = () => {
    store.setAdminToken(null);
    setToken(null);
    setOverview(null);
  };

  return (
    <div class="page page-home">
      <Wordmark />
      <p class="tagline">Live quiz for your talk — players join with a code or QR.</p>
      <JoinCard />
      <HostCard token={token} overview={overview} />
      <Footer signOut={token ? signOut : undefined} />
    </div>
  );
}

function JoinCard() {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const join = () => {
    if (clean.length >= 4) nav(`/join/${clean}`);
    else setError('Enter the 6-character game code.');
  };

  return (
    <div class="card join-card">
      <label class="field-label" for="code">
        Game PIN
      </label>
      <input
        id="code"
        class="code-input"
        value={code}
        placeholder="ABC123"
        maxLength={6}
        autocapitalize="characters"
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => {
          setCode((e.target as HTMLInputElement).value);
          setError('');
        }}
        onKeyDown={(e) => e.key === 'Enter' && join()}
      />
      <button class="btn btn-primary btn-lg" disabled={clean.length < 4} onClick={join}>
        Join
      </button>
      {error && <div class="error">{error}</div>}
    </div>
  );
}

function HostCard({
  token,
  overview,
}: {
  token: string | null | undefined;
  overview: AdminOverview | null;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const signedIn = !!token;
  const quizzes = overview?.quizzes ?? [];
  const sessions = overview?.sessions ?? [];

  const host = async () => {
    if (!token) {
      nav('/admin'); // admin lives only here — sign in, then come back
      return;
    }
    setCreating(true);
    setError('');
    try {
      const q = await createQuiz('Untitled quiz', token);
      nav(`/edit/${q.id}?token=${q.editToken}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create quiz');
      setCreating(false);
    }
  };

  return (
    <div class="card host-card">
      <div class="card-title">Host</div>
      <p class="muted" style="margin: 0; font-size: var(--size-meta, 0.75rem);">
        Create a quiz, then go live and project it.
      </p>
      <div>
        <button class="btn btn-secondary" disabled={creating} onClick={host}>
          {creating ? 'Creating…' : signedIn ? 'Create a quiz' : 'Create a quiz — sign in'}
        </button>
      </div>

      {signedIn && quizzes.length > 0 && (
        <div class="home-list">
          <div class="home-list-title">All quizzes ({quizzes.length})</div>
          {quizzes.map((q) => (
            <div class="home-row" key={q.id}>
              <button class="home-row-main" onClick={() => nav(`/edit/${q.id}?token=${q.edit_token}`)} title="Open editor">
                <span class="home-row-title">{q.title || 'Untitled'}</span>
                <span class="home-row-sub">Edit</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {signedIn && sessions.length > 0 && (
        <div class="home-list">
          <div class="home-list-title">Sessions ({sessions.length})</div>
          {sessions.map((s) => (
            <div class="home-row" key={s.code}>
              <button class="home-row-main" onClick={() => nav(`/host/${s.code}?h=${s.host_token}`)}>
                <span class="home-row-title">
                  <span class="mono">{s.code}</span> — {s.title || 'Untitled'}{' '}
                  <span class={`badge ${s.status === 'live' ? 'mode-ws' : ''}`}>{s.status}</span>
                </span>
                <span class="home-row-sub">Host screen</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div class="error">{error}</div>}
    </div>
  );
}
