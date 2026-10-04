# You Know? · รู้มั้ย? · 知ってる？

A live group quiz game in the spirit of Kahoot!, built to sit next to your
talk: run a bunch of questions, present, run another bunch. Players join from
their phones with a short code or QR. Deploys entirely on the **Cloudflare
free tier** (one Worker + D1 + hibernating Durable Objects).

- **WBasic design identity** — the five identity colors (Tungsten charcoal,
  Deep teal, Mist, Sage, Warm sand), IBM Plex Sans / Sans Thai / Sans JP type
  and IBM Plex Mono for codes, with a light ↔ dark theme toggle (light is
  the reading default; dark flips to Charcoal surfaces with Sage accents)
- **4 question types** — multiple choice (identity-colored shapes), true/false,
  short answer (normalized matching, every accepted answer counts, or tick
  accept-any to score any non-empty answer), Likert poll (unscored, or mark
  correct values in the editor for flat points)
- **Kahoot-style scoring** — 500–1000 points decaying with answer speed;
  short answers and marked Likert values score flat 1000
- **Host-paced** — questions advance when *you* click; pauses are free
- **No accounts** — your secret edit link is your login; each session gets a
  host link + 6-character join code + QR
- **Editing locks while a quiz is live**, unlocks when the game ends
- **One quiz, many sessions** — re-host the same quiz as often as you like

## Quick start (local)

```bash
npm install
npm run db:migrate:local   # create local D1 schema
npm run dev                # build client + wrangler dev → http://localhost:8787
```

Then open <http://localhost:8787>: **Create a quiz** → add questions → **Go
live** → project the host screen; players open the join URL / scan the QR.

> Your quiz edit URL contains a secret token — **bookmark it**, it is the only
> way back in (per-device lists on the home page help, but the link is the login).

Other commands:

```bash
npm run build    # client bundle → dist/client (esbuild)
npm run check    # typecheck worker + client + tests
npm test         # unit tests (node --test, native TS)
npm run e2e      # full-game E2E — needs `wrangler dev --port 8788` running
```

## Deploy to Cloudflare (free plan)

```bash
npm run build
npx wrangler d1 create you-know        # copy the printed database_id
#   → paste into wrangler.jsonc → d1_databases[0].database_id
npm run db:migrate                      # apply schema to remote D1
npm run deploy                          # → https://you-know.<your-subdomain>.workers.dev
```

No secrets or env vars are needed. Limits notes: [docs/research/cloudflare-free-tier.md](docs/research/cloudflare-free-tier.md)

## Architecture (short version)

One Worker (Hono) serves the SPA as static assets plus a JSON API, D1 stores
quizzes + a session registry (for the edit-lock), and **one hibernating
Durable Object per live session** runs the whole game: frozen quiz snapshot,
players, scores, phases (`lobby → question → reveal → … → ended`), WebSocket
state pushes with a polling fallback, and per-question alarms for the timer.
Full detail: [docs/plan.md](docs/plan.md).

```
src/        Worker: Hono routes + SessionDO
shared/     types, scoring, normalization, validation (worker + client)
client/     Preact SPA (home / join / play / host / editor)
scripts/    esbuild build script
migrations/ D1 schema
tests/      unit tests + full-game E2E
```

## Notes & quirks

- Visual design follows the [WBasic design identity](https://jedt3d.github.io/wbasic-documents/en/books/design-identity/):
  five colors, IBM Plex families, calm surfaces, color never speaking alone
  (correct/wrong carries a written heading, not just a hue). Fonts are
  self-hosted from `@fontsource` (latin + thai + japanese subsets, woff2 only).
- The project folder name contains a `?` (YouKnow?) — vite/rolldown and
  vitest treat that as a URL query separator, so the client build uses
  esbuild directly and unit tests run on Node's native TypeScript support.
- Short answers compare after NFC + case-fold + whitespace collapse + edge
  punctuation strip; Thai/Japanese combining marks are never removed.
- If WebSockets are blocked on a network, clients automatically fall back to
  2.5 s polling; actions always work over plain HTTP.

## v1 boundaries

No accounts, no media in questions, no team mode, English UI copy (the brand
is trilingual). See "Deliberately not in v1" in the plan for the full list.
