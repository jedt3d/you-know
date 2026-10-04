// Player screen — lobby waiting room, the four answer interactions,
// reveal feedback with points, and the final result card.

import { useEffect, useState } from 'preact/hooks';
import { ApiError, sendAnswer, store } from '../api';
import { nav, useConn } from '../state';
import { Countdown, DistRows, Footer, OptionShape, Podium, Standings, Wordmark } from '../ui';
import type { SessionStateView } from '../../shared/types.ts';

function Redirect({ to }: { to: string }) {
  useEffect(() => nav(to), [to]);
  return null;
}

export default function Play({ code }: { code: string }) {
  const [player, setPlayer] = useState(() => store.player(code));
  const conn = useConn(code, { p: player?.playerToken });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const s = conn.state;

  if (!player) return <Redirect to={`/join/${code}`} />;
  if (conn.forbidden) {
    return (
      <div class="page page-center">
        <Wordmark small />
        <div class="card">
          <div class="card-title">You're out</div>
          <p class="muted">The host removed you from this game.</p>
          <button class="btn btn-primary" onClick={() => nav('/')}>
            Home
          </button>
        </div>
      </div>
    );
  }

  const submit = async (answer: unknown) => {
    if (!s || busy) return;
    setBusy(true);
    setNotice('');
    try {
      await sendAnswer(code, player.playerToken, s.questionIndex, answer);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_answered') {
        // fine — server state will catch up
      } else {
        setNotice(e instanceof Error ? e.message : 'Could not send answer');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!s) {
    return (
      <div class="page page-center">
        <Wordmark small />
        <p class="muted">Connecting…</p>
      </div>
    );
  }

  const answeredCount = s.players.filter((p) => p.answered).length;
  const you = s.you;

  return (
    <div class="page page-play">
      <header class="play-header">
        <div class="play-header-left">
          <span class="mono">{s.code}</span>
          <span class="muted small"> · {s.title}</span>
        </div>
        <div class="play-header-right">
          {you && (
            <>
              <span class="chip">{you.score.toLocaleString()} pts</span>
              <span class="chip chip-rank">#{you.rank}</span>
            </>
          )}
        </div>
      </header>

      {s.phase === 'lobby' && (
        <div class="play-body center">
          <div class="pop-in card lobby-card">
            <div class="lobby-name">{you?.name}</div>
            <div class="lobby-wait">
              <span class="dot-flash">●</span> Waiting for the host…
            </div>
            <div class="muted">
              {s.players.length} player{s.players.length === 1 ? '' : 's'} in
            </div>
          </div>
        </div>
      )}

      {s.phase === 'question' && s.question && (
        <div class="play-body">
          <div class="q-meta">
            Question {s.questionIndex + 1} of {s.questionCount}
          </div>
          <Countdown nowFn={() => conn.serverNow()} startedAt={s.questionStartedAt} limitSec={s.question.timeLimitSec} />
          <div class="play-prompt">{s.question.prompt}</div>

          {you?.answered ? (
            <div class="locked-in pop-in">
              <span class="check">✓</span> Locked in — {answeredCount}/{s.players.length} answered
            </div>
          ) : (
            <AnswerForm s={s} busy={busy} submit={submit} />
          )}
          {notice && <div class="error">{notice}</div>}
        </div>
      )}

      {s.phase === 'reveal' && you && (
        <div class="play-body center">
          <RevealFeedback s={s} />
          {s.reveal && (
            <div class="card dist-card">
              <DistRows reveal={s.reveal} />
            </div>
          )}
        </div>
      )}

      {s.phase === 'ended' && you && (
        <div class="play-body center">
          <div class="card ended-card pop-in">
            <div class="ended-rank">#{you.rank}</div>
            <div class="ended-name">{you.name}</div>
            <div class="ended-score">{you.score.toLocaleString()} points</div>
            <div class="muted small">
              {you.rank === 1 ? 'Champion! รู้มั้ย? 知ってる？' : 'Thanks for playing! รู้มั้ย? 知ってる？'}
            </div>
          </div>
          {s.players.length > 2 && <Podium players={s.players} />}
          <div class="card standings-card">
            <Standings players={s.players} highlightId={you.id} />
          </div>
        </div>
      )}
      <Footer />
    </div>
  );
}

function AnswerForm({ s, busy, submit }: { s: SessionStateView; busy: boolean; submit: (a: unknown) => void }) {
  const [text, setText] = useState('');
  const q = s.question!;

  if (q.type === 'choice') {
    return (
      <div class={`answer-grid answer-cols-${Math.min(q.options?.length ?? 2, 3)}`}>
        {(q.options ?? []).map((opt, i) => (
          <button
            key={i}
            class={`answer-btn opt-${(i % 4) + 1}`}
            disabled={busy}
            onClick={() => submit({ kind: 'choice', option: i })}
          >
            <span class="answer-shape">
              <OptionShape index={i} fg />
            </span>
            <span class="answer-text">{opt}</span>
          </button>
        ))}
      </div>
    );
  }

  if (q.type === 'truefalse') {
    return (
      <div class="answer-grid answer-cols-2">
        <button class="answer-btn answer-tf" disabled={busy} onClick={() => submit({ kind: 'truefalse', value: true })}>
          <span class="answer-tf-label">TRUE</span>
        </button>
        <button class="answer-btn answer-tf answer-tf-false" disabled={busy} onClick={() => submit({ kind: 'truefalse', value: false })}>
          <span class="answer-tf-label">FALSE</span>
        </button>
      </div>
    );
  }

  if (q.type === 'short') {
    return (
      <div class="short-form">
        <input
          class="short-input"
          value={text}
          placeholder="Type your answer…"
          maxLength={80}
          autofocus
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && submit({ kind: 'short', text: text.trim() })}
        />
        <button class="btn btn-primary btn-lg" disabled={busy || !text.trim()} onClick={() => submit({ kind: 'short', text: text.trim() })}>
          Send
        </button>
      </div>
    );
  }

  // likert
  const min = q.likertMin ?? 1;
  const max = q.likertMax ?? 5;
  const steps = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div class="likert">
      <div class="likert-row">
        {steps.map((v) => (
          <button key={v} class="likert-btn" disabled={busy} onClick={() => submit({ kind: 'likert', value: v })}>
            {v}
          </button>
        ))}
      </div>
      <div class="likert-labels">
        {steps.map((v) => (
          <span key={v} class="likert-label">
            {q.likertLabels?.[v - min]}
          </span>
        ))}
      </div>
    </div>
  );
}

function RevealFeedback({ s }: { s: SessionStateView }) {
  const you = s.you!;
  const q = s.question!;
  if (q.type === 'likert' && you.lastCorrect === null) {
    const yourValue = you.answer?.kind === 'likert' ? you.answer.value : null;
    return (
      <div class="reveal-banner neutral pop-in">
        <div class="reveal-title">You said {yourValue ?? '—'}</div>
        <div class="muted">Unscored pulse poll — no points{you.answer ? '' : ' — you sat this one out'}</div>
      </div>
    );
  }
  if (you.lastCorrect) {
    return (
      <div class="reveal-banner good pop-in">
        <div class="reveal-title">Correct! +{you.lastGained.toLocaleString()}</div>
        <div class="muted">Total {you.score.toLocaleString()} · rank #{you.rank}</div>
      </div>
    );
  }
  return (
    <div class="reveal-banner bad pop-in">
      <div class="reveal-title">{you.answered ? 'Not this time' : 'Too slow!'}</div>
      <div class="muted">
        Answer: <b>{s.reveal?.correctLabel ?? '—'}</b> · total {you.score.toLocaleString()}
      </div>
    </div>
  );
}
