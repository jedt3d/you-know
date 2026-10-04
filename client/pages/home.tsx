// Home — join a game by code (open to everyone), or host: the management
// area is password-protected (AdminGate). First run sets the password;
// `?reset=1` in the URL opens the reset form.

import { useState } from 'preact/hooks';
import { createQuiz, store } from '../api';
import { nav } from '../state';
import { AdminGate } from '../admin';
import { Footer, Wordmark } from '../ui';

export default function Home() {
  return (
    <div class="page page-home">
      <Wordmark />
      <p class="tagline">Live quiz for your talk — players join with a code or QR.</p>
      <JoinCard />
      <AdminGate>{(token) => <HostCard token={token} />}</AdminGate>
      <Footer />
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

function HostCard({ token }: { token: string }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [, refresh] = useState(0);
  const quizzes = store.quizzes();
  const sessions = store.sessions().filter((s) => s.at > Date.now() - 1000 * 60 * 60 * 48);

  const host = async () => {
    setCreating(true);
    setError('');
    try {
      const q = await createQuiz('Untitled quiz', token);
      store.rememberQuiz({ id: q.id, title: q.title, editToken: q.editToken });
      nav(`/edit/${q.id}?token=${q.editToken}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create quiz');
      setCreating(false);
    }
  };

  return (
    <div class="card host-card">
      <div class="qrow">
        <div class="card-title">Host</div>
        <a class="home-row-sub admin-link" href="#/admin">
          Recorded data →
        </a>
      </div>
      <p class="muted small">Create a quiz, then go live and project it.</p>
      <button class="btn btn-secondary" disabled={creating} onClick={host}>
        {creating ? 'Creating…' : 'Create a quiz'}
      </button>

      {quizzes.length > 0 && (
        <div class="home-list">
          <div class="home-list-title">Your quizzes</div>
          {quizzes.map((q) => (
            <div class="home-row" key={q.id}>
              <button
                class="home-row-main"
                onClick={() => nav(`/edit/${q.id}?token=${q.editToken}`)}
                title="Open editor (bookmark this link — it is your only login)"
              >
                <span class="home-row-title">{q.title || 'Untitled'}</span>
                <span class="home-row-sub">Edit</span>
              </button>
              <button
                class="icon-btn"
                title="Forget this quiz on this device"
                onClick={() => {
                  store.forgetQuiz(q.id);
                  refresh((n) => n + 1);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <div class="home-list">
          <div class="home-list-title">Your live sessions</div>
          {sessions.map((s) => (
            <div class="home-row" key={s.code}>
              <button class="home-row-main" onClick={() => nav(`/host/${s.code}?h=${s.hostToken}`)}>
                <span class="home-row-title">
                  <span class="mono">{s.code}</span> — {s.title || 'Untitled'}
                </span>
                <span class="home-row-sub">Open host screen</span>
              </button>
              <button
                class="icon-btn"
                title="Forget this session on this device"
                onClick={() => {
                  store.forgetSession(s.code);
                  refresh((n) => n + 1);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div class="error">{error}</div>}
    </div>
  );
}
