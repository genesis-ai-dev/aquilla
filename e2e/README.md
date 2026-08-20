# E2E Test Suite

Playwright-driven end-to-end tests against a hermetic local backend.

Smoke covers **~25 cross-layer product journeys** (data persistence, collab,
access, import/export contracts) — not every UI click. Toggles, dialogs, empty
states, and keyboard chrome belong in Vitest/RTL (`src/**/*.test.tsx`).

| Gate | Command | When | Budget |
| --- | --- | --- | --- |
| Affected | `pnpm test:e2e:affected` | **pre-push** | Changed smoke files + domain sentinels; skips browser for docs/unit-only pushes |
| Smoke | `pnpm test:e2e:smoke` | **merge / deploy / release** | Keep-list + surface sessions (~35 files), **<2 min** wall-clock on a warm machine |
| Full | `pnpm test:e2e` | Release / format / agent extras | Smoke + expensive `*.spec.ts` (IDML, Biblica, autopilot, access lifecycle, …) |

## Prerequisites

- **Docker** must be running. `scripts/e2e-up.ts` (via `pnpm test:e2e`) starts a
  `postgres:16` container named `aquilla-dev-pg` on port 5432.
  On a Mac that runtime is Colima (`colima start`). On a dedicated Linux CI box
  use Docker Engine — see [docs/runbooks/hetzner-ci.md](../docs/runbooks/hetzner-ci.md).
  `e2e-up.ts` execs into `aquilla-dev-pg`; it does not create the container.
  `scripts/dev-stack.ts` and `scripts/hetzner-ci/ensure-e2e-runtime.sh` do.
- **Three `pnpm install` runs** — one at the repo root, one in `auth-worker/`, one in
  `sync-worker/`:

  ```bash
  pnpm install                  # repo root
  pnpm --dir auth-worker install
  pnpm --dir sync-worker install
  ```

- `npx playwright install chromium` (once per machine).

> **Note:** `scripts/e2e-up.ts` binds its own port block (Vite **6173**, identity
> **9787**, sync **9788** for shard 0; +100 per extra shard) and frees those
> ports on shutdown. It does **not** take `pnpm dev`'s 5173/8788/8789/9456.

## Quick start

```bash
# Install dependencies (see Prerequisites above)

npx playwright install chromium

# Run the fast changed-file gate used by pre-push
pnpm test:e2e:affected

# Run every smoke journey (merge/deploy/release gate)
pnpm test:e2e:smoke

# Run full suite (smoke + expensive format/agent/access specs)
pnpm test:e2e

# Debug a single spec
pnpm test:e2e:ui
```

`test:e2e:affected` reads Git's pre-push ref stream, always includes smoke
specs changed by the pushed commits, and adds a small sentinel set for affected
product domains. It skips browser startup for docs/unit-test-only pushes. Up to
eight selected specs use a single Vite dev-mode stack; larger selections use
two or three isolated preview-mode shards. `test:e2e:smoke` runs the keep-list
in `e2e/JOURNEYS.md` (~25 files) and is required at the merge/deploy/release
boundary — not on every push.

## Smoke admission

Add a new `*.smoke.spec.ts` only when **all** of these hold:

1. A user can lose data, access, or a committed artifact if it breaks.
2. The assertion crosses at least two of: SPA, auth-worker, sync-worker,
   Postgres, R2, a second browser context.
3. No existing smoke journey already covers that contract — extend that file.

Otherwise: Vitest/RTL or a worker unit test. Prefer deleting a redundant smoke
after RTL exists over renaming it to non-smoke.

Canonical map: [`e2e/JOURNEYS.md`](./JOURNEYS.md).

## Architecture

`scripts/e2e-up.ts` boots:
1. `auth-worker` via `wrangler dev --local` on port 9787 (identity, orgs, members,
   sync-token, `/__test__/reset`, `/__dev__/login`)
2. `sync-worker` via `wrangler dev --local` on port 9788 (event log + projection
   writer + ProjectSync DO)
3. `MockLLMServer` on a random port (OpenAI-compatible)
4. `vite preview` on port 6173 (or Vite dev mode for `test:e2e:affected`)

Both workers use
`WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev`
to point Hyperdrive at the local Docker Postgres.

Then writes `.env.test.local` (loaded by Vite via `--mode test`):
```
VITE_AUTH_BASE=http://127.0.0.1:9787
VITE_SYNC_WORKER_HOST=127.0.0.1:9788
VITE_LLM_BASE_URL=http://127.0.0.1:<random>
```

Playwright runs against `http://127.0.0.1:6173`.

Workers stay **serial inside a shard** (`workers: 1`) because `/__test__/reset`
is not transactional — do not parallelize Playwright workers.

## Per-test isolation

Every test calls `resetBackend()` (via the multi-user fixture or directly) which hits
`POST /__test__/reset` on `auth-worker`. That truncates user/org/project tables and
reseeds three known users (`alice`, `bob`, `carol`) plus org `Acme`. The route is gated
behind `WRANGLER_LOCAL=1`; production deploys return 404.

Surface-session specs collapse chrome into **one** `test()` (with `test.step()`)
so N checks cost **1** `resetBackend()` via the `{ alice }` fixture — not one
reset per former micro-test. A `beforeEach` that seeds without requesting
`{ alice }` races the fixture wipe and is wrong. Files that mutate conflicting
state (e.g. teams CRUD, invite accept) stay hermetic per-test; see
[`JOURNEYS.md`](./JOURNEYS.md#surface-sessions-one-test-one-reset).

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

- `*.smoke.spec.ts` — merge/deploy smoke gate. Keep the suite to the JOURNEYS
  keep-list (~25 files, <2 min). Pre-push runs **affected**, not full smoke.
- `*.spec.ts` — full suite only (expensive format/agent/access journeys).
- Files under `e2e/tauri/` — manual pre-release only (not implemented in v1).

## Adding a test

See `e2e/JOURNEYS.md` for the canonical journey map and conventions.

### Deterministic waits

- Every standard E2E command first runs `pnpm test:e2e:guard`; a policy
  violation fails immediately, before the local stacks are built.
- Let `goto`, actions, and web-first assertions wait for browser mechanics.
- For product readiness, wait for the responsible response, URL, accessible UI
  state, or poll the authoritative API. Do not use `waitForTimeout` or
  `networkidle` as a proxy for readiness.
- Do not make required behavior optional with a caught timeout or early return.
  If the fixture should create the state, assert that it did.
- Required asynchronous assertions use the shared 10-second timeout. Cold
  application/editor hydration and multi-service workflows use a justified
  30-second readiness watchdog while still waiting on observable state. Do not
  force those through the shorter interaction budget or shorten waits merely
  to make a test fail faster; that makes the result depend on machine speed. A
  synchronous `isVisible()` probe is only for choosing between real UI
  branches, never for deciding whether required behavior should be tested.
- Never skip, fixme, or return early because a machine is slow. `skip` and
  `fixme` are reserved for documented product gaps and must cite the issue.

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
- **Port already in use** → `e2e-up.ts` force-kills only its own block
  (6173/9787/9788 for shard 0) at startup and again on shutdown. A live
  `pnpm dev` on 5173/8788/8789 is left alone. If an e2e port is still held,
  a previous shard was killed mid-boot — rerun; shutdown reaps leftovers.
- **Many specs fail in 0.0s with `ECONNREFUSED 127.0.0.1:9787`** → this is not
  a product bug in those specs. Identity (auth-worker) died mid-suite, so
  `resetBackend()` cannot reach `POST /__test__/reset`. `e2e-up` now aborts the
  shard as soon as wrangler exits instead of cascading. Check
  `.e2e-logs-s0/identity.log` (shard 1). On a Mac the Docker runtime is Colima
  (`colima start` before push); if Postgres/workerd is gone, every remaining
  test fails the same way.
- **`sync worker died` / `ENOENT: … utime …/.wrangler/registry/aquilla-sync-worker-local`**
  → Wrangler 3.114 heartbeats `utimesSync` on a user-level registry file named
  after the worker. Three smoke shards (and `pnpm dev`) used to share
  `aquilla-sync-worker-local`, so one process unlinking the file crashed the
  others. `e2e-up` now gives each stack its own `--name` and
  `WRANGLER_REGISTRY_PATH`. If you still see the default path in `sync.log`,
  the orchestrator is not the one that spawned that wrangler.
- **Cold-start latency** → first run is ~4–5 min on a cold machine (wrangler downloads
  workerd, browser caches build, etc.). Subsequent runs are faster.
