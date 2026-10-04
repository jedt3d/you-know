// Join — enter a display name for a game code, then head to the play screen.
// Supports rejoin: if this device already played this code, the old identity
// is offered by default.

import { useEffect, useState } from 'preact/hooks';
import { ApiError, getSummary, joinSession, store } from '../api';
import { nav } from '../state';
import { Footer, Wordmark } from '../ui';
import type { SessionSummary } from '../../shared/types.ts';

export default function Join({ code }: { code: string }) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState(store.player(code)?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    getSummary(code)
      .then((s) => alive && setSummary(s))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [code]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError('');
    try {
      const prior = store.player(code);
      const r = await joinSession(code, trimmed, prior?.playerToken);
      store.setPlayer(code, { playerId: r.playerId, playerToken: r.playerToken, name: trimmed });
      nav(`/play/${code}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unknown_player') {
        // stale token — retry once as a fresh player
        try {
          const r = await joinSession(code, trimmed);
          store.setPlayer(code, { playerId: r.playerId, playerToken: r.playerToken, name: trimmed });
          nav(`/play/${code}`);
          return;
        } catch (e2) {
          setError(e2 instanceof Error ? e2.message : 'Could not join');
        }
      } else {
        setError(e instanceof Error ? e.message : 'Could not join');
      }
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <div class="page page-center">
        <Wordmark />
        <div class="card">
          <div class="card-title">Game not found</div>
          <p class="muted">
            No live game with code <span class="mono">{code}</span>.
          </p>
          <button class="btn btn-primary" onClick={() => nav('/')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const inProgress = summary && (summary.phase === 'question' || summary.phase === 'reveal');

  return (
    <div class="page page-center">
      <Wordmark small />
      <div class="card join-name-card">
        <div class="join-code">
          Game PIN <span class="mono big">{code}</span>
        </div>
        {summary && <div class="muted small">{summary.title}</div>}
        {inProgress && <div class="note">Already in progress — you can still jump in!</div>}
        <label class="field-label" for="nick">
          Nickname
        </label>
        <input
          id="nick"
          class="name-input"
          value={name}
          maxLength={24}
          placeholder="Your name"
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button class="btn btn-primary btn-lg" disabled={busy || !name.trim()} onClick={submit}>
          {busy ? 'Joining…' : "Let's go"}
        </button>
        {error && <div class="error">{error}</div>}
      </div>
      <Footer />
    </div>
  );
}
