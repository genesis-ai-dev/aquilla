# E2E Test Suite

Playwright-driven end-to-end tests against a hermetic local backend.

## Prerequisites

- **Docker** must be running. `scripts/e2e-up.ts` (via `pnpm test:e2e`) starts a
  `postgres:16` container named `aquilla-dev-pg` on port 5432.
- **Three `pnpm install` runs** — one at the repo root, one in `auth-worker/`, one in
  `sync-worker/`:

  ```bash
  pnpm install                  # repo root
  pnpm --dir auth-worker install
  pnpm --dir sync-worker install
  ```

- `npx playwright install chromium` (once per machine).

> **Warning:** `scripts/e2e-up.ts` force-kills whatever is listening on ports 5173
> (Vite), 8787 (auth-worker), and 8788 (sync-worker) before starting. Do not run
> it while your live dev stack is using those ports.

## Quick start

```bash
# Install dependencies (see Prerequisites above)

npx playwright install chromium

# Run smoke (~2 min target)
pnpm test:e2e:smoke

# Run full suite
pnpm test:e2e

# Debug a single spec
pnpm test:e2e:ui
```

## Architecture

`scripts/e2e-up.ts` boots:
1. `auth-worker` via `wrangler dev --local` on port 8787 (identity, orgs, members,
   sync-token, `/__test__/reset`, `/__dev__/login`)
2. `sync-worker` via `wrangler dev --local` on port 8788 (event log + projection
   writer + ProjectSync DO)
3. `MockLLMServer` on a random port (OpenAI-compatible)
4. `vite --mode test` on port 5173

Both workers use
`WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev`
to point Hyperdrive at the local Docker Postgres.

Then writes `.env.test.local` (loaded by Vite via `--mode test`):
```
VITE_AUTH_BASE=http://127.0.0.1:8787
VITE_SYNC_WORKER_HOST=127.0.0.1:8788
VITE_LLM_BASE_URL=http://127.0.0.1:<random>
```

Playwright runs against `http://127.0.0.1:5173`.

## Per-test isolation

Every test calls `resetBackend()` (via the multi-user fixture or directly) which hits
`POST /__test__/reset` on `auth-worker`. That truncates user/org/project tables and
reseeds three known users (`alice`, `bob`, `carol`) plus org `Acme`. The route is gated
behind `WRANGLER_LOCAL=1`; production deploys return 404.

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

Convention: when a test uses two or more users, list `alice` first. The backend-reset
hook lives in the `alice` fixture; tests that don't include `alice` must call
`await resetBackend()` themselves.

## Dev login bypass (alternative to reset+login)

For ad-hoc specs or manual browser sessions, `auth-worker` also exposes:

- `POST /__dev__/seed`  — upsert user `dev` / org `Dev Org` / project `dev-project`.
- `POST /__dev__/login` — same upsert, returns `{ access_token, username: "dev" }`.

Same `WRANGLER_LOCAL=1` gate as `/__test__/reset`. Use this when you want a logged-in
browser without going through the alice/bob/carol fixture — e.g. exploratory specs,
debugging, manual `pnpm dev` sessions (the SignIn screen renders a "Dev login (skip
auth)" button in dev builds).

Do NOT use `/__dev__/login` for the maintained spec suite — it shares state across tests.
Stick with `resetBackend()` + the multi-user fixture for anything checked in.

## Spec naming

- `*.smoke.spec.ts` — runs on `git push`. Keep total suite <2 min.
- `*.spec.ts` — full suite, runs on `pnpm test:e2e`.
- Files under `e2e/tauri/` — manual pre-release only (not implemented in v1).

## Adding a test

See `e2e/JOURNEYS.md` for the canonical journey map and conventions.

### Deterministic waits

- Let `goto`, actions, and web-first assertions wait for browser mechanics.
- For product readiness, wait for the responsible response, URL, accessible UI
  state, or poll the authoritative API. Do not use `waitForTimeout` or
  `networkidle` as a proxy for readiness.
- Do not make required behavior optional with a caught timeout or early return.
  If the fixture should create the state, assert that it did.

The default runner prints the active test every 15 seconds. A test is bounded to
60 seconds and a shard to 30 minutes, with no retries that can turn an
intermittent failure green. Useful overrides for constrained hosts:

```bash
E2E_HEARTBEAT_MS=10000 E2E_TEST_TIMEOUT_MS=90000 pnpm test:e2e:smoke
E2E_GLOBAL_TIMEOUT_MS=2400000 E2E_STALL_TIMEOUT_MS=180000 pnpm test:e2e:smoke
```

If a shard produces no output for 30 seconds, the parent prints its PID and last
line. After `E2E_STALL_TIMEOUT_MS` (two minutes by default), it terminates the
stalled stack instead of leaving pre-push blocked indefinitely. Failure traces,
screenshots, video, and service logs are retained.

## Troubleshooting

- **`wrangler dev` won't start** → confirm `pnpm install` was run inside `auth-worker/`
  and `sync-worker/` (not just at root). Also verify `wrangler login` is current.
- **Docker not running** → `scripts/e2e-up.ts` requires Docker to start the
  `aquilla-dev-pg` Postgres container. Start Docker Desktop first.
- **`/__test__/reset` returns 404** → `auth-worker` was started without
  `WRANGLER_LOCAL=1`. `pnpm test:e2e` sets it automatically via `e2e-up.ts`; if you ran
  `wrangler dev` manually, prepend `WRANGLER_LOCAL=1`.
- **`/__dev__/login` returns 404** → same cause: `auth-worker` started without
  `WRANGLER_LOCAL=1`. `pnpm dev` (via `scripts/dev-stack.ts`) sets it automatically.
- **Tests pass alone, fail in suite** → reset isn't running or isn't truncating
  something. Verify `resetBackend()` runs in the failing test's `beforeEach`, or that
  the test uses the `alice` fixture (which triggers reset).
- **Mock LLM not connected** → `VITE_LLM_BASE_URL` isn't being passed to Vite. Check
  `.env.test.local` contents during a run; it should be regenerated each time
  `e2e-up.ts` boots.
- **Port already in use** → `e2e-up.ts` force-kills 5173/8787/8788 at startup. If it
  still fails, kill processes manually before retrying.
- **Cold-start latency** → first run is ~4–5 min on a cold machine (wrangler downloads
  workerd, browser caches build, etc.). Subsequent runs are faster.
