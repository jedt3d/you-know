// Shared presentational components: wordmark, answer shapes, countdown,
// result distribution, standings, podium and the light/dark theme toggle.

import { useEffect, useState } from 'preact/hooks';
import type { PlayerPublic, RevealView } from '../shared/types.ts';

/** Light ↔ dark toggle (WBasic identity: Mist-first, Charcoal dark mode). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('yk-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#26343D' : '#F3F6F4');
  }, [theme]);
  return (
    <button class="theme-toggle" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
      {theme === 'dark' ? 'Light theme' : 'Dark theme'}
    </button>
  );
}

export function Wordmark({ small }: { small?: boolean }) {
  return (
    <div class={`wordmark ${small ? 'wordmark-small' : ''}`}>
      <span class="wm-main">
        You Know<i class="wm-q">?</i>
      </span>
      <span class="wm-sub">
        รู้มั้ย<i>?</i> · 知ってる<i>?</i>
      </span>
    </div>
  );
}

// Answer options cycle the four non-surface identity colors (Teal, Sand,
// Sage, Charcoal on light; the 4th swaps to Mist in dark). CSS vars so the
// same code serves both themes; shapes double the distinction.
export const OPTION_COLORS = ['var(--opt-1-bg)', 'var(--opt-2-bg)', 'var(--opt-3-bg)', 'var(--opt-4-bg)'];

type Shape = 'triangle' | 'diamond' | 'circle' | 'square' | 'star' | 'bolt';

export const OPTION_SHAPES: Shape[] = ['triangle', 'diamond', 'circle', 'square', 'star', 'bolt'];

function ShapeSvg({ shape, color }: { shape: Shape; color: string }) {
  const p = { style: { fill: color } };
  switch (shape) {
    case 'triangle':
      return (
        <svg viewBox="0 0 24 24" class="shape">
          <path d="M12 3 22 21 H2 Z" {...p} />
        </svg>
      );
    case 'diamond':
      return (
        <svg viewBox="0 0 24 24" class="shape">
          <path d="M12 2 22 12 12 22 2 12 Z" {...p} />
        </svg>
      );
    case 'circle':
      return (
        <svg viewBox="0 0 24 24" class="shape">
          <circle cx="12" cy="12" r="10" {...p} />
        </svg>
      );
    case 'square':
      return (
        <svg viewBox="0 0 24 24" class="shape">
          <rect x="3" y="3" width="18" height="18" rx="3" {...p} />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="0 0 24 24" class="shape">
          <path d="M12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 Z" {...p} />
        </svg>
      );
    case 'bolt':
      return (
        <svg viewBox="0 0 24 24" class="shape">
          <path d="M13 2 4 14 h6 l-1 8 9-12 h-6 Z" {...p} />
        </svg>
      );
  }
}

/** fg=true fills the shape with the option's foreground (use on its own colored button). */
export function OptionShape({ index, fg }: { index: number; fg?: boolean }) {
  const n = (index % 4) + 1;
  return <ShapeSvg shape={OPTION_SHAPES[index % 6]} color={fg ? `var(--opt-${n}-fg)` : OPTION_COLORS[index % 4]} />;
}

export function OptionTag({ index, text }: { index: number; text?: string }) {
  return (
    <span class="option-tag" style={{ background: OPTION_COLORS[index % 4] }}>
      <ShapeSvg shape={OPTION_SHAPES[index % 6]} color="var(--opt-tag-fg)" />
      {text != null && <span class="option-tag-text">{text}</span>}
    </span>
  );
}

/** Slim timer bar driven by server-synced clocks. */
export function Countdown({ nowFn, startedAt, limitSec }: { nowFn: () => number; startedAt: number; limitSec: number }) {
  const [now, setNow] = useState(nowFn);
  useEffect(() => {
    const id = setInterval(() => setNow(nowFn()), 100);
    return () => clearInterval(id);
  }, [nowFn]);
  const end = startedAt + limitSec * 1000;
  const frac = Math.max(0, Math.min(1, (end - now) / (limitSec * 1000)));
  return (
    <div class={`countdown ${frac < 0.25 ? 'danger' : ''}`}>
      <div class="countdown-fill" style={{ width: `${frac * 100}%` }} />
    </div>
  );
}

export function DistRows({ reveal }: { reveal: RevealView }) {
  const max = Math.max(1, ...reveal.rows.map((r) => r.count));
  return (
    <div class="dist">
      {reveal.kind === 'likert' && reveal.average != null && <div class="dist-average">Average: {reveal.average}</div>}
      {reveal.rows.map((r) => (
        <div class={`dist-row ${r.correct ? 'is-correct' : ''}`}>
          <div class="dist-label">
            {r.correct === true && <span class="check">✓</span>}
            {r.label}
          </div>
          <div class="dist-track">
            <div class="dist-bar" style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
          <div class="dist-count">{r.count}</div>
        </div>
      ))}
      {reveal.kind === 'short' && reveal.accepted && (
        <div class="dist-accepted">Accepted: {reveal.accepted.join(' · ')}</div>
      )}
    </div>
  );
}

export function Standings({ players, highlightId, max }: { players: PlayerPublic[]; highlightId?: string; max?: number }) {
  const list = max ? players.slice(0, max) : players;
  return (
    <div class="standings">
      {list.map((p, i) => (
        <div class={`standing ${p.id === highlightId ? 'is-you' : ''} ${i < 3 ? `top-${i + 1}` : ''}`}>
          <span class="standing-rank">{p.rank}</span>
          <span class="standing-name">{p.name}</span>
          <span class="standing-score">{p.score.toLocaleString()}</span>
        </div>
      ))}
      {list.length === 0 && <div class="muted">No players yet.</div>}
    </div>
  );
}

export function Podium({ players }: { players: PlayerPublic[] }) {
  const top = players.slice(0, 3);
  const order = [1, 0, 2]; // display 2nd, 1st, 3rd
  return (
    <div class="podium">
      {order.map((idx) => {
        const p = top[idx];
        if (!p) return <div class="pod empty" />;
        const place = idx + 1;
        return (
          <div class={`pod pod-${place}`}>
            <div class="pod-name">{p.name}</div>
            <div class="pod-score">{p.score.toLocaleString()}</div>
            <div class="pod-base">{place}</div>
          </div>
        );
      })}
    </div>
  );
}

export function Spinner() {
  return <div class="spinner" aria-label="Loading" />;
}

/** Build identity — commit + build time injected by scripts/build.mjs. */
export function Footer() {
  const t = new Date(__BUILD_TIME__);
  const when = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return (
    <footer class="app-footer">
      <span class="mono">v{__APP_VERSION__}</span> · build <span class="mono">{__BUILD_COMMIT__}</span> · {when}
    </footer>
  );
}
