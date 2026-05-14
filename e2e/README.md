# E2E Test Suite

Playwright-driven end-to-end tests against a hermetic local backend.

## Quick start

```bash
# One-time per machine
npm install
npx playwright install chromium

# Run smoke (~2 min target)
npm run test:e2e:smoke

# Run full suite
npm run test:e2e

# Debug a single spec
npm run test:e2e:ui
```

No external repo checkout is required — codex-auth-worker and sync-worker
both live in this repo, and the D1 schema is applied via
`auth-worker/migrations/` against a local sqlite each run.

## Architecture

`scripts/e2e-up.ts` boots:
1. `codex-auth-worker` via `wrangler dev --local` on port 8787 (auth, orgs,
   members, projects, sync-token, users, `/__test__/reset`)
2. `aquilla-sync-worker` via `wrangler dev --local` on port 8788 (y-partyserver
   collab DOs)
3. `MockLLMServer` on a random port (OpenAI-compatible)
4. `vite --mode test` on port 5173

Then writes `.env.test.local` (loaded by Vite via `--mode test`):
```
VITE_AUTH_BASE=http://127.0.0.1:8787
VITE_SYNC_WORKER_HOST=127.0.0.1:8788
VITE_LLM_BASE_URL=http://127.0.0.1:<random>
```

Playwright runs against `http://127.0.0.1:5173`.

## Schema

Single D1 (`aquilla-db`) holds everything — identity, orgs, projects,
members, invites, files, cells, events. Schema is owned by
`auth-worker/migrations/`; `wrangler d1 migrations apply aquilla-db --local`
is the canonical setup step. In prod, auth-worker's deploy applies
migrations on every deploy. Sync-worker binds the same D1 but doesn't own
migrations.

## Per-test isolation

Every test calls `resetBackend()` (via the multi-user fixture or directly)
which hits `POST /__test__/reset` on codex-auth-worker. That truncates the
user/org/project tables and reseeds three known users (`alice`, `bob`,
`carol`). The route is gated behind `WRANGLER_LOCAL=1`; production deploys
return 404.

## Multi-user fixture

```ts
import { test, expect } from "../../helpers/multi-user"

test("collab", async ({ alice, bob }) => {
  // alice and bob are pre-authenticated Pages in separate BrowserContexts.
  // Backend is freshly reset before this test runs.
})
```

Three pre-seeded users:
- **alice** — owner of a personal org (auto-created on first `/orgs/me` hit)
- **bob** — no org membership by default
- **carol** — no org membership by default

Convention: when a test uses two or more users, list `alice` first. The
backend-reset hook lives in the `alice` fixture; tests that don't include
`alice` must call `await resetBackend()` themselves.

## Spec naming

- `*.smoke.spec.ts` — runs on `git push`. Keep total suite <2 min.
- `*.spec.ts` — full suite, runs on `npm run test:e2e`.
- Files under `e2e/tauri/` — manual pre-release only (not implemented in v1).

## Adding a test

See `e2e/JOURNEYS.md` for the canonical journey map and conventions.

## Troubleshooting

- **`wrangler dev` won't start** → confirm `wrangler login` is current. The
  orchestrator targets `auth-worker/` and `sync-worker/` directly; no
  external repo checkout is needed.
- **`/__test__/reset` returns 404** → auth-worker was started without
  `WRANGLER_LOCAL=1`. e2e-up.ts sets that explicitly when it spawns the
  worker, so a 404 here means you're hitting a non-local URL.
- **Tests pass alone, fail in suite** → reset isn't running or isn't
  truncating something. Verify `resetBackend()` runs in the failing test's
  `beforeEach`, or that the test uses the `alice` fixture (which triggers
  reset).
- **Mock LLM not connected** → `VITE_LLM_BASE_URL` isn't being passed to
  Vite. Check `.env.test.local` contents during a run; it should be
  regenerated each time `e2e-up.ts` boots.
- **Port already in use** → another `wrangler dev` or `vite` is running.
  The orchestrator uses `--strictPort` so it won't silently land on a
  different port; kill the conflicting process first.
- **Cold-start latency** → first run is ~4-5 min on a cold machine
  (wrangler downloads workerd, browser caches build, etc.). Subsequent
  runs land near the 2-min budget.

## Skipping the pre-push gate

The `.husky/pre-push` hook runs `npm run test:e2e:smoke` on every push.
Set `SKIP_E2E_SMOKE=1` to skip it (e.g. for docs-only branches):

```bash
SKIP_E2E_SMOKE=1 git push
```

CI is the canonical gate; the pre-push hook is a developer convenience.
