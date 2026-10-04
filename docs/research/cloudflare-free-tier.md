# Cloudflare free tier — limits that shaped this design

Researched 2026-10-04 while planning. Numbers are the free ("Free plan")
allowances; re-check before relying on them.

## Workers (request workers)

- **100,000 requests/day** (free). Each HTTP request and each WebSocket
  message in/out counts as a request.
- 10 ms CPU per invocation — plenty; this app does JSON + tiny SQLite/KV ops.
- **Workers Static Assets are free and unlimited** (bandwidth + requests),
  20,000 files per project. This is why the SPA ships as Worker assets
  instead of Cloudflare Pages.

## Pages vs Worker + assets (why we chose Worker)

Cloudflare Pages Functions share the same 100k/day free request pool as
Workers and Pages is in maintenance mode for new features; Worker Static
Assets have no request cap. One Worker = one deployable, one domain, assets
served free. Decision #5.

## Durable Objects (the realtime core)

- Free plan includes DOs with **SQLite storage** (5 GB total across DOs,
  100,000 requests/day, 13,000 GB-s duration/day).
- **WebSocket Hibernation**: while sockets are idle the DO is evicted and
  bills **zero duration**; incoming WS messages wake it (each message counts
  as a request). An idle lobby or a host presenting between rounds costs
  nothing.
- Our usage math for a 1-hour, 50-player session: ~50 WS state pushes per
  question × ~30 questions + joins ≈ 5–10k requests — well inside the cap.
- `setWebSocketAutoResponse` answers `{"t":"ping"}` without waking the DO.
- Alarms bill as requests only — one per question.

## D1 (quiz storage)

- Free: **5 million rows read/day, 100,000 rows written/day**, 5 GB storage.
- We write one row per quiz save (autosave is debounced 800 ms) and one row
  per session creation. Reads: a handful per editor load / session start /
  edit-lock check. Negligible.

## KV — deliberately unused

- Free KV allows only **1,000 writes/day** — too tight for anything
  session-scoped. D1 + DO cover everything, so KV is not used at all.

## Deploy checklist (free plan)

1. `npm run build`
2. `wrangler d1 create you-know` → paste `database_id` into `wrangler.jsonc`
3. `npm run db:migrate` (remote)
4. `npm run deploy`
5. Optional: add a custom domain in the dashboard (free, proxied)

No environment variables, no secrets, no paid bindings anywhere.
