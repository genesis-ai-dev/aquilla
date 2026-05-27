# E2E Test Suite

Playwright-driven end-to-end tests against a hermetic local backend.

## Quick start

```bash
# One-time per machine
git clone git@github.com:ryderwishart/frontier-server.git ~/frontierrnd/frontier-server
cd ~/frontierrnd/frontier-server && npm install
cd -

npm install
npx playwright install chromium

# Run smoke (~2 min target)
npm run test:e2e:smoke

# Run full suite
npm run test:e2e

# Debug a single spec
npm run test:e2e:ui
```

## Architecture

`scripts/e2e-up.ts` boots:
1. `frontier-server` via `wrangler dev --local` on port 8787 (auth, orgs, members, sync-token, `/__test__/reset`)
2. `sync-worker` via `wrangler dev --local` on port 8788 (y-partyserver collab DOs)
3. `MockLLMServer` on a random port (OpenAI-compatible)
4. `vite --mode test` on port 5173

Then writes `.env.test.local` (loaded by Vite via `--mode test`):
```
VITE_FRONTIER_BASE=http://127.0.0.1:8787
VITE_SYNC_WORKER_HOST=127.0.0.1:8788
VITE_LLM_BASE_URL=http://127.0.0.1:<random>
```

Playwright runs against `http://127.0.0.1:5173`.

## Per-test isolation

Every test calls `resetBackend()` (via the multi-user fixture or directly) which hits `POST /__test__/reset` on `frontier-server`. That truncates user/org/project tables and reseeds three known users (`alice`, `bob`, `carol`) plus org `Acme`. The route is gated behind `WRANGLER_LOCAL=1`; production deploys return 404.

## Multi-user fixture

```ts
import { test, expect } from "../../helpers/multi-user"

test("collab", async ({ alice, bob }) => {
  // alice and bob are pre-authenticated Pages in separate BrowserContexts.
  // Backend is freshly reset before this test runs.
})
```

Three pre-seeded users:
- **alice** — owner of org `Acme` (auto-created by reset)
- **bob** — no org membership by default
- **carol** — no org membership by default

Convention: when a test uses two or more users, list `alice` first. The backend-reset hook lives in the `alice` fixture; tests that don't include `alice` must call `await resetBackend()` themselves.

## Dev login bypass (alternative to reset+login)

For ad-hoc specs or manual browser sessions, `auth-worker` also exposes:

- `POST /__dev__/seed`  — upsert user `dev` / org `Dev Org` / project `dev-project`.
- `POST /__dev__/login` — same upsert, returns `{ access_token, username: "dev" }`.

Same `WRANGLER_LOCAL=1` gate as `/__test__/reset`. Use this when you want a logged-in browser without going through the alice/bob/carol fixture — e.g. exploratory specs, debugging, manual `pnpm dev` sessions (the SignIn screen renders a "Dev login (skip auth)" button in dev builds).

Do NOT use `/__dev__/login` for the maintained spec suite — it shares state across tests. Stick with `resetBackend()` + the multi-user fixture for anything checked in.

## Spec naming

- `*.smoke.spec.ts` — runs on `git push`. Keep total suite <2 min.
- `*.spec.ts` — full suite, runs on `npm run test:e2e`.
- Files under `e2e/tauri/` — manual pre-release only (not implemented in v1).

## Adding a test

See `e2e/JOURNEYS.md` for the canonical journey map and conventions.

## Troubleshooting

- **`wrangler dev` won't start** → confirm `~/frontierrnd/frontier-server` exists and `wrangler login` is current. Set `FRONTIER_SERVER_DIR` if checked out elsewhere.
- **`/__test__/reset` returns 404** → `frontier-server` was started without `WRANGLER_LOCAL=1`, or you're running against an old build that doesn't have the route. Ensure the `feat/test-reset-route` PR has been merged on the frontier-server side.
- **`/__dev__/login` returns 404** → same cause: auth-worker was started without `WRANGLER_LOCAL=1`. `pnpm dev` sets it automatically; if you ran `wrangler dev` directly in `auth-worker/`, prepend `WRANGLER_LOCAL=1`.
- **Tests pass alone, fail in suite** → reset isn't running or isn't truncating something. Verify `resetBackend()` runs in the failing test's `beforeEach`, or that the test uses the `alice` fixture (which triggers reset).
- **Mock LLM not connected** → `VITE_LLM_BASE_URL` isn't being passed to Vite. Check `.env.test.local` contents during a run; it should be regenerated each time `e2e-up.ts` boots.
- **Port already in use** → another `wrangler dev` or `vite` is running. The orchestrator uses `--strictPort` so it won't silently land on a different port; kill the conflicting process first.
- **Cold-start latency** → first run is ~4-5 min on a cold machine (wrangler downloads workerd, browser caches build, etc.). Subsequent runs land near the 2-min budget.
