# You Know? — Product & Technical Plan

**Names (locked):** You Know? (EN) · รู้มั้ย? (TH) · 知ってる？ (JA)

A small Kahoot-like live quiz game for presenting: the host runs a quiz next to
their slides, players join with a short code or QR on their phones.

---

## Locked decisions (2026-10-04, user-confirmed)

| # | Decision | Choice |
|---|----------|--------|
| 1 | **Auth** | No accounts. A secret *edit link* is the host's login for a quiz. Each live session gets its own host control link + 6-char join code. Players pick a display name only. (Cloudflare free tier friendly.) |
| 2 | **Realtime** | One hibernating Durable Object per session pushes state over WebSockets; all client actions go over plain HTTP, which doubles as the polling fallback. |
| 3 | **Pacing & scoring** | Host-paced — the host advances questions whenever they like, so a talk can be "a bunch of questions → present → another bunch" with arbitrary pauses. Multiple-choice and True/False earn 500–1000 points decaying with answer speed; short answers are exact match after normalization (flat 1000, every accepted answer counts) or accept-any mode (any non-empty answer → flat 1000); Likert is an unscored pulse poll unless the editor marks correct values (then flat 1000). One quiz can be re-hosted as many sessions as needed. |
| 4 | **Audience** | Software developers and C-level staff. 6-character unambiguous join codes, mild rate limits (60 joins/min, 200 players, 1 answer per question), no public directory. UI is polished enough to project in a boardroom. |
| 5 | **Deploy shape** | One Worker (Hono + TypeScript) serves the SPA (Workers Static Assets), the REST API, D1 and the session DO. No Pages. |
| 6 | **Quiz mutation** | **Editing is locked while any session of the quiz is running** (409). The session plays a frozen snapshot; edits apply to the next session. |
| 7 | **Admin & records (v0.2)** | Quiz management + the data view are protected by an admin password (PBKDF2 hash in the `settings` table; set on first run, `?reset=1` resets it — deliberately open). The DO writes durable records to SQLite/D1 as the game unfolds: sessions (status, ended_at), players (name, IP, user agent, score), and per-question answers (answer JSON, correct/gained, answered_at). |

## Question types

| Type | Answer UI | Scoring |
|------|-----------|---------|
| Multiple choice | 2–6 colored shape buttons (▲◆●■★⚡) | 500–1000, time-decayed |
| True / False | Two large buttons | 500–1000, time-decayed |
| Short answer | Text input (80 chars) | Normalized exact match → flat 1000; **every** accepted answer counts; or tick **accept-any** (any non-empty answer → flat 1000) |
| Likert scale | Number buttons min–max (span ≤ 9), optional labels | Unscored poll by default; checkbox-marked values (editor) → flat 1000 when answered |

Normalization: Unicode NFC → case-fold → collapse whitespace → trim → strip
edge punctuation (keeps Thai/Japanese combining marks intact).

## Visual identity

The UI is styled by the token system in [design/tokens.json](../design/tokens.json)
(v1.2.0 — documented with a change log in
[design/design-system.md](../design/design-system.md), playground at
`design/preview.html`): white canvas, gray app surface (`#EDEDED`), white
cards with soft shadows, azure accent `#0A89FF`, dark charcoal `#4A4D51`,
and Google-hued choice colors (blue = accent, red `#EA4335`, yellow `#FBBC05`
with an ink icon, green `#34A853` — True/False buttons use green/red).
Type is Questrial (Poppins + Noto Sans Thai/JP fallbacks, self-hosted);
hierarchy comes from size, never bold. Radii: cards 37, large 26, small 20,
thumbnails 17, buttons/inputs pill. Light-only by design — a dark theme
requires a deliberate dark token set first. Admin is reachable only at
`/admin`; the home page stays public.

## Architecture

```
Browser (Preact SPA, hash routing)
   │  GET /assets/*            → static assets (free)
   │  WS  /ws/:code?p=|h=      → session DO (state pushes)
   │  POST /api/sessions/...   → join / answer / host commands
   │  /api/quizzes/...         → quiz CRUD (edit-token auth)
   ▼
One Worker (Hono)
   ├── D1 "you-know": quizzes, sessions registry (edit-lock bookkeeping)
   └── SessionDO per live game (idFromName("s:"+joinCode))
         state machine: lobby → question → reveal → (next…) → ended
         storage: frozen quiz snapshot + players + scores
         WS hibernation; storage.setAlarm() ends each question on time
         auto-reveals when every connected player has answered
```

- **Join codes** are the DO name (`28^6 ≈ 4.8e8` space, no I/L/O/0/1), so no
  lookup table is needed; code collisions at create time retry.
- **Hibernation** keeps an idle session (e.g. the host presenting between
  rounds) at zero duration cost; only the per-question alarm and client
  messages bill as requests.
- **Fallbacks**: if WebSockets are blocked, clients poll
  `GET /api/sessions/:code/state` every 2.5 s and keep acting via HTTP.

## File map

| Path | Purpose |
|------|---------|
| `src/index.ts` | Hono app: quiz CRUD, session proxy, WS upgrade, assets |
| `src/session-do.ts` | Game state machine Durable Object |
| `src/ids.ts` | Join codes / secret tokens |
| `shared/` | Types, scoring, normalization, validation (used by worker + client) |
| `client/` | Preact SPA: home, join, play, host projector, editor |
| `scripts/build.mjs` | esbuild-based client build (see note) |
| `migrations/` | D1 schema |
| `tests/` | `node --test` unit tests + full-game E2E vs `wrangler dev` |

> **Build note:** the project folder contains a `?` (YouKnow?), which breaks
> vite/rolldown (they treat it as a URL query). The build therefore uses
> esbuild directly (`scripts/build.mjs`). Vitest is affected the same way, so
> unit tests use Node's native TypeScript support (`node --test`).

## v1 scope shipped

- Quiz editor with autosave, validation, reorder, secret-link banner
- Go live → lobby with join URL + QR + live player list
- All four question types end-to-end, speed-decayed scoring, podium
- Edit-lock while live; Play again / Back to quiz on the ended screen
- Player rejoin (token in localStorage), host session list on Home
- 16 unit tests + 15-step E2E covering the whole game loop

## Deliberately not in v1

Accounts, team mode, music/sonifications, question banks/import, per-question
images/media, moderation beyond kick + rate limits, localization of UI copy
(brand is trilingual, copy is English).
