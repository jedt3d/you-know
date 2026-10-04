// Host screen — meant for the projector next to your slides. Lobby with
// join code + QR, live question with countdown, reveal with distribution and
// mini scoreboard, final podium. All actions go over HTTP (`cmd`).

import { useEffect, useMemo, useState } from 'preact/hooks';
import qrcodeLib from 'qrcode-generator';
import { hostCmd, startSession, store } from '../api';
import { nav, useConn } from '../state';
import { Countdown, DistRows, OptionShape, Podium, Standings, Wordmark } from '../ui';

type QrFn = (typeNumber: number, level: string) => {
  addData: (d: string) => void;
  make: () => void;
  createSvgTag: (o?: Record<string, unknown>) => string;
};
const qrcode = qrcodeLib as unknown as QrFn;

export default function Host({ code, hostToken, quizId }: { code: string; hostToken: string; quizId?: string }) {
  const [token] = useState(() => hostToken || store.sessionByCode(code)?.hostToken || '');
  const [error, setError] = useState('');
  const [rehosting, setRehosting] = useState(false);
  const conn = useConn(code, { h: token || undefined });
  const s = conn.state;

  // Keep the session in the local list so "Your live sessions" on Home works
  // even if this device didn't create it.
  useEffect(() => {
    if (!s || !token) return;
    const existing = store.sessionByCode(code);
    const quiz = store.quizzes().find((q) => q.id === (quizId || existing?.quizId));
    if (!existing || existing.hostToken !== token) {
      store.rememberSession({
        code,
        title: s.title,
        hostToken: token,
        quizId: existing?.quizId || quiz?.id || quizId || '',
        editToken: existing?.editToken || quiz?.editToken || '',
        at: Date.now(),
      });
    }
  }, [s?.title, s?.code, token]);

  const cmd = (name: string, extra?: Record<string, unknown>) =>
    hostCmd(code, token, name, extra).catch((e) => setError(e instanceof Error ? e.message : 'Command failed'));

  const joinUrl = `${location.origin}/#/join/${code}`;
  const qrSvg = useMemo(() => {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(joinUrl);
      qr.make();
      return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }).replace(/black/g, '#26343D');
    } catch {
      return '';
    }
  }, [joinUrl]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  if (!token) {
    return (
      <div class="page page-center">
        <Wordmark small />
        <div class="card">
          <div class="card-title">Host link required</div>
          <p class="muted">
            Open the full host URL for game <span class="mono">{code}</span> (it contains your host key), or start a session from the quiz editor.
          </p>
          <button class="btn btn-primary" onClick={() => nav('/')}>
            Home
          </button>
        </div>
      </div>
    );
  }

  if (!s) {
    return (
      <div class="page page-center">
        <Wordmark small />
        <p class="muted">Connecting…</p>
      </div>
    );
  }

  const answeredCount = s.players.filter((p) => p.answered).length;
  const ref = store.sessionByCode(code);
  const canRehost = !!ref?.quizId && !!ref?.editToken;

  const rehost = async () => {
    if (!ref) return;
    setRehosting(true);
    setError('');
    try {
      const started = await startSession(ref.quizId, ref.editToken);
      store.rememberSession({
        code: started.code,
        title: s.title,
        hostToken: started.hostToken,
        quizId: ref.quizId,
        editToken: ref.editToken,
        at: Date.now(),
      });
      nav(`/host/${started.code}?h=${started.hostToken}&q=${ref.quizId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start a new session');
      setRehosting(false);
    }
  };

  return (
    <div class={`page page-host phase-${s.phase}`}>
      <header class="host-header">
        <Wordmark small />
        <div class="host-header-mid">
          <span class="mono">{s.code}</span>
          <span class="muted"> · {s.title}</span>
        </div>
        <div class="host-header-right">
          <span class={`badge mode-${conn.mode}`}>{conn.mode === 'ws' ? 'live' : conn.mode === 'poll' ? 'polling' : '…'}</span>
          <button class="icon-btn" title="Fullscreen" onClick={toggleFullscreen}>
            ⛶
          </button>
        </div>
      </header>

      {s.phase === 'lobby' && (
        <>
          <div class="host-lobby">
            <div class="card lobby-left pop-in">
              <div class="lobby-join-label">Join the game</div>
              <div class="lobby-url mono">
                {location.host}/#/join
              </div>
              <div class="lobby-pin">{s.code}</div>
              {qrSvg ? <div class="qr" dangerouslySetInnerHTML={{ __html: qrSvg }} /> : <div class="muted small">QR unavailable</div>}
            </div>
            <div class="lobby-right">
              <div class="lobby-count">
                {s.players.length} player{s.players.length === 1 ? '' : 's'} ready
              </div>
              <div class="player-chips">
                {s.players.map((p) => (
                  <span class="chip-player pop-in" key={p.id}>
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <footer class="host-controls">
            <button class="btn btn-primary btn-lg" disabled={s.players.length === 0} onClick={() => cmd('start')}>
              Start
            </button>
            <button class="btn btn-ghost" onClick={() => cmd('end')}>
              End game
            </button>
          </footer>
        </>
      )}

      {s.phase === 'question' && s.question && (
        <>
          <div class="host-question">
            <div class="q-meta">
              Question {s.questionIndex + 1} of {s.questionCount}
            </div>
            <Countdown nowFn={() => conn.serverNow()} startedAt={s.questionStartedAt} limitSec={s.question.timeLimitSec} />
            <div class="host-prompt">{s.question.prompt}</div>
            {s.question.type === 'choice' && (
              <div class="host-options">
                {(s.question.options ?? []).map((o, i) => (
                  <div class="host-option" key={i}>
                    <OptionShape index={i} />
                    <span>{o}</span>
                  </div>
                ))}
              </div>
            )}
            {s.question.type === 'truefalse' && (
              <div class="host-options host-options-tf">
                <div class="host-option">TRUE</div>
                <div class="host-option">FALSE</div>
              </div>
            )}
            {s.question.type === 'short' && <div class="host-hint">Players are typing…</div>}
            {s.question.type === 'likert' && (
              <div class="host-hint">
                Scale {s.question.likertMin}–{s.question.likertMax}
              </div>
            )}
            <div class="answered-meter">
              {answeredCount}/{s.players.length} answered
            </div>
          </div>
          <footer class="host-controls">
            <button class="btn btn-primary btn-lg" onClick={() => cmd('reveal')}>
              Show results
            </button>
          </footer>
        </>
      )}

      {s.phase === 'reveal' && s.reveal && (
        <>
          <div class="host-reveal">
            {s.reveal.correctLabel && (
              <div class="reveal-correct pop-in">
                Answer: <b>{s.reveal.correctLabel}</b>
              </div>
            )}
            <DistRows reveal={s.reveal} />
            {s.players.length > 0 && (
              <div class="mini-board">
                <Standings players={s.players} max={5} />
              </div>
            )}
          </div>
          <footer class="host-controls">
            <button class="btn btn-primary btn-lg" onClick={() => cmd('next')}>
              {s.questionIndex + 1 < s.questionCount ? 'Next question' : 'Finish'}
            </button>
          </footer>
        </>
      )}

      {s.phase === 'ended' && (
        <>
          <div class="host-ended">
            <div class="ended-title">That's a wrap!</div>
            {s.players.length > 0 ? <Podium players={s.players} /> : <div class="muted">No players joined.</div>}
            {s.players.length > 0 && (
              <div class="card standings-card">
                <Standings players={s.players} />
              </div>
            )}
          </div>
          <footer class="host-controls">
            {canRehost && (
              <button class="btn btn-primary btn-lg" disabled={rehosting} onClick={rehost}>
                {rehosting ? 'Starting…' : 'Play again'}
              </button>
            )}
            {ref?.quizId && ref?.editToken && (
              <button class="btn btn-secondary" onClick={() => nav(`/edit/${ref.quizId}?token=${ref.editToken}`)}>
                Back to quiz
              </button>
            )}
            <button class="btn btn-ghost" onClick={() => nav('/')}>
              Home
            </button>
          </footer>
        </>
      )}

      {error && <div class="error host-error">{error}</div>}
    </div>
  );
}
