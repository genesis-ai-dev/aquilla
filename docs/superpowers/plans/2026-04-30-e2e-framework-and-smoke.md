# E2E Framework + Smoke Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the E2E test framework — hermetic local backend via `wrangler dev`, multi-user Playwright fixture, page objects, smoke suite (~10 specs), pre-push gate, and AI-discoverability docs — so that `git push` blocks on a green smoke run and AI coders extend the suite as part of feature work.

**Architecture:** Playwright (Chromium) drives the Vite-served web app. A Node orchestrator (`scripts/e2e-up.ts`) boots two `wrangler dev` workers (`frontier-server`, `sync-worker`), the existing `MockLLMServer`, and Vite, writing a `.env.test.local` so the app talks to local backends. Per-test reset hits a new `/__test__/reset` route on `frontier-server` that's gated to local-only by env. Three pre-authenticated user fixtures (`alice`, `bob`, `carol`) let specs drive multi-user flows from one test. Pre-push hook runs `*.smoke.spec.ts` under a 2-min budget.

**Tech Stack:** Playwright 1.59, Vite 8, Wrangler 4, Hono (frontier-server), husky, tsx, TypeScript.

**Companion plans (out of scope here):**
- Plan 2: full coverage — remaining specs from `docs/superpowers/specs/2026-04-30-e2e-release-gate-suite-design.md`. Each journey is 1-3 tasks; can be added incrementally once this plan ships.
- Plan 3: Tauri smoke via `tauri-driver` against a built `.app`.

**Pre-requisites:**
- `~/frontierrnd/frontier-server` checkout exists (per the design's `FRONTIER_SERVER_DIR` default).
- Wrangler authenticated; user has run `wrangler dev` against `frontier-server` at least once.
- macOS (the only documented dev platform; nothing in this plan blocks Linux but it's untested).

---

## Task 1: Make `FRONTIER_BASE` env-overridable

**Files:**
- Modify: `src/lib/frontier/auth.ts:4`
- Test: `src/lib/frontier/auth.test.ts`

- [ ] **Step 1: Read the current test to confirm pattern**

Run: `cat src/lib/frontier/auth.test.ts | head -30`
Expected: existing tests use `vi.stubGlobal("fetch", ...)` and assert against `https://api.frontierrnd.com/...` URLs.

- [ ] **Step 2: Add a failing test that asserts `FRONTIER_BASE` honours `VITE_FRONTIER_BASE`**

Append to `src/lib/frontier/auth.test.ts`:

```ts
import { vi, describe, it, expect, afterEach } from "vitest"

describe("FRONTIER_BASE env override", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("uses VITE_FRONTIER_BASE when set", async () => {
    vi.stubEnv("VITE_FRONTIER_BASE", "http://127.0.0.1:8787")
    vi.resetModules()
    const mod = await import("./auth")
    expect(mod.FRONTIER_BASE).toBe("http://127.0.0.1:8787")
  })

  it("falls back to api.frontierrnd.com when env is unset", async () => {
    vi.stubEnv("VITE_FRONTIER_BASE", "")
    vi.resetModules()
    const mod = await import("./auth")
    expect(mod.FRONTIER_BASE).toBe("https://api.frontierrnd.com")
  })
})
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run src/lib/frontier/auth.test.ts -t "FRONTIER_BASE env override"`
Expected: 2 tests fail because `FRONTIER_BASE` is hard-coded.

- [ ] **Step 4: Update `src/lib/frontier/auth.ts:4`**

Replace:
```ts
export const FRONTIER_BASE = "https://api.frontierrnd.com";
```
with:
```ts
export const FRONTIER_BASE =
  ((import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")) ??
  "https://api.frontierrnd.com";
```

- [ ] **Step 5: Re-run tests**

Run: `npx vitest run src/lib/frontier/auth.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/frontier/auth.ts src/lib/frontier/auth.test.ts
git commit -m "feat(frontier): make FRONTIER_BASE overridable via VITE_FRONTIER_BASE

Required for E2E suite to point at local wrangler dev instance."
```

---

## Task 2: Make `FRONTIER_CHAT_URL` and frontier health URL env-overridable

**Files:**
- Modify: `src/lib/completion/completion-service.ts:10`
- Modify: `src/lib/completion/frontier-health.ts:10`

- [ ] **Step 1: Inspect current usage**

Run: `grep -n "api.frontierrnd.com" src/lib/completion/`
Expected: two hits — `completion-service.ts:10` (FRONTIER_CHAT_URL) and `frontier-health.ts:10` (HEALTH_URL).

- [ ] **Step 2: Update `completion-service.ts:10`**

Replace:
```ts
export const FRONTIER_CHAT_URL = "https://api.frontierrnd.com/api/v1/chat/completions"
```
with:
```ts
const FRONTIER_BASE_OVERRIDE =
  (import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")
export const FRONTIER_CHAT_URL = `${FRONTIER_BASE_OVERRIDE ?? "https://api.frontierrnd.com"}/api/v1/chat/completions`
```

- [ ] **Step 3: Update `frontier-health.ts:10`**

Replace:
```ts
const HEALTH_URL = "https://api.frontierrnd.com/api/v2/health"
```
with:
```ts
const FRONTIER_BASE_OVERRIDE =
  (import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "")
const HEALTH_URL = `${FRONTIER_BASE_OVERRIDE ?? "https://api.frontierrnd.com"}/api/v2/health`
```

- [ ] **Step 4: Verify all unit tests still pass**

Run: `npm run test`
Expected: all green. (Existing tests stub `fetch` so URL changes don't break them.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/completion/completion-service.ts src/lib/completion/frontier-health.ts
git commit -m "feat(completion): honour VITE_FRONTIER_BASE for chat + health URLs"
```

---

## Task 3: Audit remaining hard-coded backend URLs

**Files:**
- Read-only audit, may modify: `src/lib/sync/sync-token.ts` (already env-aware — verify)

- [ ] **Step 1: Grep for any remaining hard-coded production URLs**

Run: `grep -rn "api\.frontierrnd\.com\|aquilla-sync-worker\.blue-darkness" src/ --include="*.ts" --include="*.tsx"`
Expected: only matches inside comments, JSX user-facing strings, and test mocks. If any executable code still uses the hard-coded URL, apply the same `VITE_FRONTIER_BASE` pattern.

- [ ] **Step 2: Confirm `sync-token.ts` already honours `VITE_FRONTIER_API_URL`**

Run: `grep -n "VITE_FRONTIER_API_URL\|VITE_FRONTIER_BASE" src/lib/sync/sync-token.ts`
Expected: the file reads `VITE_FRONTIER_API_URL`. Standardise: change to read `VITE_FRONTIER_BASE` so the suite has one env var, not two.

Apply at `src/lib/sync/sync-token.ts:7`:

Replace:
```ts
export const FRONTIER_API_URL =
  (import.meta.env.VITE_FRONTIER_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "https://api.frontierrnd.com"
```
with:
```ts
export const FRONTIER_API_URL =
  (import.meta.env.VITE_FRONTIER_BASE as string | undefined)?.replace(/\/+$/, "") ??
  "https://api.frontierrnd.com"
```

- [ ] **Step 3: Re-run all unit tests**

Run: `npm run test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sync/sync-token.ts
git commit -m "refactor(sync): standardise on VITE_FRONTIER_BASE env var

Drops the second VITE_FRONTIER_API_URL alias. Suite now needs one
env var to redirect all frontier-server traffic locally."
```

---

## Task 4: Restructure `e2e/` directory

**Files:**
- Create: `e2e/config/`, `e2e/specs/`, `e2e/helpers/page-objects/`, `e2e/tauri/`
- Move: `e2e/helpers.ts` → `e2e/helpers/legacy.ts` (will be replaced in Task 9)
- Move: `e2e/mock-llm-server.ts` → `e2e/helpers/mock-llm-server.ts`
- Move: existing specs into `e2e/specs/<area>/<journey>.spec.ts`
- Move: `playwright.config.ts` → `e2e/config/playwright.config.web.ts`
- Delete: `playwright.autofix.config.ts` (separate experiment, out of scope)
- Delete: `e2e-autofix/` directory
- Modify: `package.json` (script paths)

- [ ] **Step 1: Create new directory structure**

```bash
mkdir -p e2e/config e2e/specs/auth e2e/specs/projects e2e/specs/orgs e2e/specs/editor e2e/specs/rules e2e/specs/validation e2e/specs/ai e2e/specs/collab e2e/helpers/page-objects e2e/tauri
```

- [ ] **Step 2: Move existing files**

```bash
git mv e2e/helpers.ts e2e/helpers/legacy.ts
git mv e2e/mock-llm-server.ts e2e/helpers/mock-llm-server.ts
git mv e2e/dashboard.spec.ts e2e/specs/projects/crud.spec.ts
git mv e2e/project-lifecycle.spec.ts e2e/specs/editor/import-and-edit.spec.ts
git mv e2e/validation.spec.ts e2e/specs/validation/validate.spec.ts
git mv e2e/ai-completion.spec.ts e2e/specs/ai/completion.spec.ts
git mv playwright.config.ts e2e/config/playwright.config.web.ts
git rm -r e2e-autofix playwright.autofix.config.ts
```

- [ ] **Step 3: Fix import paths in moved spec files**

For each moved spec, the path `./helpers` → `../../helpers/legacy`. Run:

```bash
sed -i '' 's|from "./helpers"|from "../../helpers/legacy"|g' e2e/specs/projects/crud.spec.ts e2e/specs/editor/import-and-edit.spec.ts e2e/specs/validation/validate.spec.ts e2e/specs/ai/completion.spec.ts
sed -i '' 's|from "./mock-llm-server"|from "../../helpers/mock-llm-server"|g' e2e/specs/ai/completion.spec.ts
```

- [ ] **Step 4: Fix fixture paths in moved spec files**

The fixtures resolution `resolve(__dirname, "fixtures/sample.md")` was relative to `e2e/`; it's now `e2e/specs/<area>/`. Update:

```bash
sed -i '' 's|"fixtures/sample.md"|"../../fixtures/sample.md"|g' e2e/specs/editor/import-and-edit.spec.ts e2e/specs/validation/validate.spec.ts e2e/specs/ai/completion.spec.ts
```

- [ ] **Step 5: Update playwright config to point at new layout**

Edit `e2e/config/playwright.config.web.ts`:

```ts
import { defineConfig, devices } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../..")

export default defineConfig({
  testDir: path.resolve(REPO_ROOT, "e2e/specs"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,

  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  // No webServer here — scripts/e2e-up.ts owns boot.
})
```

- [ ] **Step 6: Update package.json scripts**

In `package.json`, replace existing test:e2e scripts with:

```json
"test:e2e:smoke": "tsx scripts/e2e-up.ts -- --grep '\\.smoke\\.spec\\.ts$'",
"test:e2e": "tsx scripts/e2e-up.ts",
"test:e2e:ui": "tsx scripts/e2e-up.ts -- --ui",
"test:e2e:debug": "tsx scripts/e2e-up.ts -- --debug",
"test:e2e:tauri": "playwright test --config e2e/config/playwright.config.tauri.ts"
```

(Note: `e2e-up.ts` and `playwright.config.tauri.ts` don't exist yet — see Tasks 5 and Plan 3. The `tauri` script will fail until Plan 3 ships; that's expected.)

- [ ] **Step 7: Verify type-check still passes**

Run: `npx tsc -b --noEmit`
Expected: no new errors. (Existing specs may have stale types from the move; if so, it's a path issue, fix the import.)

- [ ] **Step 8: Commit**

```bash
git add -A e2e package.json
git commit -m "chore(e2e): restructure into config/specs/helpers/tauri layout

Moves existing 4 specs into e2e/specs/<area>/, helpers under e2e/helpers/,
config under e2e/config/. Drops e2e-autofix experiment. Sets baseURL to
the Vite dev server (5173); webServer ownership moves to e2e-up.ts in
the next task."
```

---

## Task 5: Write the orchestrator (`scripts/e2e-up.ts`)

**Files:**
- Create: `scripts/e2e-up.ts`
- Create: `scripts/lib/spawn-worker.ts`
- Create: `.gitignore` entries for `.env.test.local` and `e2e/.auth/`

- [ ] **Step 1: Add gitignore entries**

Append to `.gitignore`:
```
# E2E suite — local-only state
.env.test.local
e2e/.auth/
test-results/
playwright-report/
```

- [ ] **Step 2: Create `scripts/lib/spawn-worker.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process"

export interface SpawnedWorker {
  child: ChildProcess
  port: number
  kill: () => Promise<void>
}

export async function spawnWranglerDev(opts: {
  cwd: string
  port: number
  label: string
  env?: Record<string, string>
}): Promise<SpawnedWorker> {
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--port", String(opts.port), "--ip", "127.0.0.1"],
    {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  child.stdout?.on("data", (b) => process.stdout.write(`[${opts.label}] ${b}`))
  child.stderr?.on("data", (b) => process.stderr.write(`[${opts.label}] ${b}`))

  // Wait for the worker to be reachable
  const start = Date.now()
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/`)
      if (r.status < 500) break
    } catch {
      // not yet reachable
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  return {
    child,
    port: opts.port,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.killed) return resolve()
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL")
          resolve()
        }, 5_000)
      }),
  }
}
```

- [ ] **Step 3: Create `scripts/e2e-up.ts`**

```ts
import { spawn } from "node:child_process"
import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { spawnWranglerDev, type SpawnedWorker } from "./lib/spawn-worker"
import { MockLLMServer } from "../e2e/helpers/mock-llm-server"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const FRONTIER_SERVER_DIR =
  process.env.FRONTIER_SERVER_DIR ?? path.join(homedir(), "frontierrnd/frontier-server")
const SYNC_WORKER_DIR = path.join(REPO_ROOT, "sync-worker")
const FRONTIER_PORT = 8787
const SYNC_WORKER_PORT = 8788
const VITE_PORT = 5173

const cleanup: Array<() => Promise<void>> = []

async function shutdown(code = 0) {
  console.log("\n[e2e-up] shutting down…")
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.error(e) }
  }
  process.exit(code)
}

process.on("SIGINT", () => shutdown(130))
process.on("SIGTERM", () => shutdown(143))

async function main() {
  if (!existsSync(FRONTIER_SERVER_DIR)) {
    console.error(`[e2e-up] frontier-server not found at ${FRONTIER_SERVER_DIR}`)
    console.error(`[e2e-up] set FRONTIER_SERVER_DIR or clone the repo`)
    process.exit(1)
  }

  // 1. Reset frontier-server local D1 by deleting wrangler state
  const wranglerStateDir = path.join(FRONTIER_SERVER_DIR, ".wrangler")
  console.log(`[e2e-up] resetting wrangler local state at ${wranglerStateDir}`)
  rmSync(wranglerStateDir, { recursive: true, force: true })

  // 2. Apply migrations
  console.log("[e2e-up] applying frontier-server migrations…")
  await runOnce("npx", ["wrangler", "d1", "migrations", "apply", "frontier-db-v2", "--local"], FRONTIER_SERVER_DIR)

  // 3. Boot frontier-server
  console.log(`[e2e-up] starting frontier-server on :${FRONTIER_PORT}…`)
  const frontier: SpawnedWorker = await spawnWranglerDev({
    cwd: FRONTIER_SERVER_DIR,
    port: FRONTIER_PORT,
    label: "frontier",
    env: { WRANGLER_LOCAL: "1" },
  })
  cleanup.push(() => frontier.kill())

  // 4. Boot sync-worker
  console.log(`[e2e-up] starting sync-worker on :${SYNC_WORKER_PORT}…`)
  const sync: SpawnedWorker = await spawnWranglerDev({
    cwd: SYNC_WORKER_DIR,
    port: SYNC_WORKER_PORT,
    label: "sync",
  })
  cleanup.push(() => sync.kill())

  // 5. Boot mock LLM
  console.log("[e2e-up] starting mock LLM…")
  const mockLLM = new MockLLMServer()
  await mockLLM.start()
  cleanup.push(async () => mockLLM.stop())

  // 6. Write .env.test.local
  const envFile = path.join(REPO_ROOT, ".env.test.local")
  writeFileSync(
    envFile,
    [
      `VITE_FRONTIER_BASE=http://127.0.0.1:${FRONTIER_PORT}`,
      `VITE_SYNC_WORKER_HOST=127.0.0.1:${SYNC_WORKER_PORT}`,
      `VITE_LLM_BASE_URL=${mockLLM.baseUrl}`,
      "",
    ].join("\n"),
  )
  cleanup.push(async () => rmSync(envFile, { force: true }))
  console.log(`[e2e-up] wrote ${envFile}`)

  // 7. Boot Vite
  console.log(`[e2e-up] starting Vite on :${VITE_PORT}…`)
  const vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MODE: "test" },
  })
  vite.stdout?.on("data", (b) => process.stdout.write(`[vite] ${b}`))
  vite.stderr?.on("data", (b) => process.stderr.write(`[vite] ${b}`))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        if (vite.killed) return resolve()
        vite.once("exit", () => resolve())
        vite.kill("SIGTERM")
        setTimeout(() => { if (!vite.killed) vite.kill("SIGKILL"); resolve() }, 5_000)
      }),
  )

  // Wait for Vite ready
  await waitForUrl(`http://127.0.0.1:${VITE_PORT}/`, 30_000)

  // 8. Hand off to Playwright
  const playwrightArgs = ["playwright", "test", "--config", "e2e/config/playwright.config.web.ts"]
  // Forward extra CLI args after `--`
  const extra = process.argv.slice(2)
  const dashDashIdx = extra.indexOf("--")
  if (dashDashIdx >= 0) playwrightArgs.push(...extra.slice(dashDashIdx + 1))
  console.log(`[e2e-up] running: npx ${playwrightArgs.join(" ")}`)
  const pw = spawn("npx", playwrightArgs, { cwd: REPO_ROOT, stdio: "inherit" })
  pw.on("exit", (code) => shutdown(code ?? 1))
}

function runOnce(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: "inherit" })
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
  })
}

async function waitForUrl(url: string, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

main().catch((e) => {
  console.error("[e2e-up] fatal:", e)
  shutdown(1)
})
```

- [ ] **Step 4: Verify type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit scripts/e2e-up.ts scripts/lib/spawn-worker.ts`
Expected: no errors. (If `tsconfig.node.json` doesn't include scripts/, add `"include": ["scripts/**/*.ts", ...]` to it.)

- [ ] **Step 5: Smoke-test the orchestrator without Playwright**

Run: `tsx scripts/e2e-up.ts -- --list`
Expected: orchestrator boots frontier, sync, mock LLM, Vite, then runs `playwright test --list`. Confirm:
- All four labels appear in output (`[frontier]`, `[sync]`, mock LLM ready line, `[vite]`).
- `.env.test.local` exists during run.
- On Ctrl-C, `.env.test.local` is removed and child processes exit.

- [ ] **Step 6: Commit**

```bash
git add scripts/ e2e/ .gitignore
git commit -m "feat(e2e): orchestrator boots local frontier-server + sync-worker + Vite

scripts/e2e-up.ts owns the full local backend stack so Playwright can
run hermetically against wrangler dev. Writes .env.test.local pointing
the app at local ports, tears down on exit."
```

---

## Task 6: Add `/__test__/reset` route to frontier-server

**Files:** (in `~/frontierrnd/frontier-server/`)
- Create: `cloudflare/src/routes/__test__.ts`
- Modify: `cloudflare/src/index.ts` (mount route)

> **Note:** This task edits the sibling `frontier-server` repo. Open a PR there, review, and merge before continuing. The new branch can be checked out locally; `e2e-up.ts` boots whatever's currently checked out.

- [ ] **Step 1: Inspect existing routes for the standard shape**

Run: `cat ~/frontierrnd/frontier-server/cloudflare/src/routes/users.ts | head -30`
Expected: A `Hono<{ Bindings: Env }>()` instance with route handlers.

- [ ] **Step 2: Create `cloudflare/src/routes/__test__.ts`**

```ts
import { Hono } from "hono"
import type { Env } from "../types"

const app = new Hono<{ Bindings: Env }>()

// Gate every route in this file behind WRANGLER_LOCAL=1.
app.use("*", async (c, next) => {
  if (c.env.WRANGLER_LOCAL !== "1") {
    return c.text("Not Found", 404)
  }
  await next()
})

const SEED_USERS = [
  { username: "alice", email: "alice@example.test", password: "alice-test-pw" },
  { username: "bob",   email: "bob@example.test",   password: "bob-test-pw" },
  { username: "carol", email: "carol@example.test", password: "carol-test-pw" },
]

app.post("/reset", async (c) => {
  const db = c.env.DB
  // Truncate user-owned data. Order matters for FK.
  await db.batch([
    db.prepare("DELETE FROM project_members"),
    db.prepare("DELETE FROM org_members"),
    db.prepare("DELETE FROM organizations"),
    db.prepare("DELETE FROM projects"),
    db.prepare("DELETE FROM users"),
  ])

  // Seed users via the standard register flow so password hashing matches prod.
  for (const u of SEED_USERS) {
    const r = await fetch(`${new URL(c.req.url).origin}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(u),
    })
    if (!r.ok) {
      return c.json({ error: `seed ${u.username} failed: HTTP ${r.status}` }, 500)
    }
  }

  // Pre-create org "Acme" owned by alice.
  const alice = (await db.prepare("SELECT id FROM users WHERE username = ?").bind("alice").first<{ id: number }>())!
  const org = await db
    .prepare("INSERT INTO organizations (name, created_by) VALUES (?, ?) RETURNING id")
    .bind("Acme", alice.id)
    .first<{ id: number }>()
  await db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)").bind(org!.id, alice.id, "owner").run()

  return c.json({
    ok: true,
    users: SEED_USERS.map(({ password: _p, ...rest }) => rest),
    org: { id: org!.id, name: "Acme" },
  })
})

export default app
```

- [ ] **Step 3: Mount the route in `cloudflare/src/index.ts`**

Add to imports:
```ts
import testReset from "./routes/__test__"
```

Add to route mounts (somewhere alongside the other `app.route(...)` calls):
```ts
app.route("/__test__", testReset)
```

- [ ] **Step 4: Verify schema matches**

Inspect `cloudflare/migrations/` for the latest migration file to confirm column names used in the seed (`username`, `email`, `password` for users; `name`, `created_by` for organizations; `org_id`, `user_id`, `role` for org_members). If any column differs, update the SQL in step 2 to match.

- [ ] **Step 5: Add a test from the codex-web-app side**

Add to `e2e/helpers/seed.ts` (will be created in Task 7):

```ts
// covered by Task 7
```

For now, manually verify in step 6.

- [ ] **Step 6: Manual smoke test**

In one terminal:
```bash
cd ~/frontierrnd/frontier-server
WRANGLER_LOCAL=1 npx wrangler d1 migrations apply frontier-db-v2 --local
WRANGLER_LOCAL=1 npx wrangler dev --local --port 8787
```

In another:
```bash
curl -X POST http://127.0.0.1:8787/__test__/reset
```

Expected: JSON `{ ok: true, users: [...], org: { id, name: "Acme" } }`. Run twice; second call should succeed identically (truncate-then-seed).

- [ ] **Step 7: Verify the gate**

Without `WRANGLER_LOCAL=1`:
```bash
cd ~/frontierrnd/frontier-server
unset WRANGLER_LOCAL
npx wrangler dev --local --port 8787
# in another terminal:
curl -i -X POST http://127.0.0.1:8787/__test__/reset
```

Expected: HTTP 404. This guards prod against accidentally exposing the route.

- [ ] **Step 8: Commit (in the frontier-server repo, on a new branch + PR)**

```bash
cd ~/frontierrnd/frontier-server
git checkout -b feat/test-reset-route
git add cloudflare/src/routes/__test__.ts cloudflare/src/index.ts
git commit -m "feat(test): add /__test__/reset route for hermetic E2E

Truncates user/org/project tables and reseeds three known users
(alice/bob/carol) plus org Acme. Gated behind WRANGLER_LOCAL=1 so
production deploys reject it with 404."
git push -u origin feat/test-reset-route
gh pr create --title "feat(test): /__test__/reset for codex-web-app E2E" --body "Adds a local-only seed/reset route. Required by the codex-web-app E2E suite for per-test hermeticity. Gated behind WRANGLER_LOCAL=1; production returns 404."
```

After PR merges, return to codex-web-app and continue.

---

## Task 7: Seed helper that calls `/__test__/reset`

**Files:**
- Create: `e2e/helpers/seed.ts`

- [ ] **Step 1: Create `e2e/helpers/seed.ts`**

```ts
const FRONTIER_BASE =
  process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

export interface SeedUser {
  username: "alice" | "bob" | "carol"
  email: string
  password: string
}

export const SEED_USERS: SeedUser[] = [
  { username: "alice", email: "alice@example.test", password: "alice-test-pw" },
  { username: "bob",   email: "bob@example.test",   password: "bob-test-pw" },
  { username: "carol", email: "carol@example.test", password: "carol-test-pw" },
]

/** Hits the /__test__/reset route to truncate + reseed the local D1. */
export async function resetBackend(): Promise<void> {
  const r = await fetch(`${FRONTIER_BASE}/__test__/reset`, { method: "POST" })
  if (!r.ok) {
    throw new Error(`backend reset failed: HTTP ${r.status} — ${await r.text()}`)
  }
}

/** Lookup a seed user by username. */
export function seedUser(name: SeedUser["username"]): SeedUser {
  const u = SEED_USERS.find((x) => x.username === name)
  if (!u) throw new Error(`unknown seed user: ${name}`)
  return u
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.app.json --noEmit e2e/helpers/seed.ts`
Expected: no errors. (Add `e2e/**/*` to `tsconfig.app.json`'s `include` if needed.)

- [ ] **Step 3: Commit**

```bash
git add e2e/helpers/seed.ts
git commit -m "feat(e2e): seed helper for /__test__/reset"
```

---

## Task 8: Auth helper that produces pre-authenticated `storageState`

**Files:**
- Create: `e2e/helpers/auth.ts`

- [ ] **Step 1: Create `e2e/helpers/auth.ts`**

```ts
import { type APIRequestContext, type Browser, type Page, request as pwRequest } from "@playwright/test"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { seedUser, type SeedUser } from "./seed"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, "../.auth")

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

interface AuthResponse {
  access_token: string
  token_type: string
  gitlab_token: string
  gitlab_url: string
}

/** Logs the seed user in via API and writes a Playwright storageState file
 * for that user. Returns the path to the file. */
export async function ensureAuthState(username: SeedUser["username"]): Promise<string> {
  const file = path.join(AUTH_DIR, `${username}.json`)
  const u = seedUser(username)

  // Always re-mint so storageState matches the just-reset DB.
  const ctx = await pwRequest.newContext()
  const r = await ctx.post(`${FRONTIER_BASE}/api/v1/auth/token`, {
    data: { username: u.username, password: u.password },
  })
  if (!r.ok()) {
    throw new Error(`login ${username} failed: HTTP ${r.status()} — ${await r.text()}`)
  }
  const auth = (await r.json()) as AuthResponse

  // Mirror what the app does in saveSession: store the FrontierSession in IndexedDB.
  // Cheap path: use Playwright's storageState origins to seed localStorage marker
  // and rely on app boot to lift the session from IDB. Since IDB can't be seeded
  // via storageState directly, we instead add a custom origin entry that signSetup
  // reads on first paint. The simpler reliable approach is to navigate to / and
  // inject the session via page.evaluate. We'll do that in the multi-user fixture.
  // For now this helper just verifies the API works and persists the JWT to a file
  // the fixture will read.
  await fs.writeFile(file, JSON.stringify({
    username: u.username,
    jwt: auth.access_token,
    gitlabToken: auth.gitlab_token,
    gitlabUrl: auth.gitlab_url,
  }, null, 2))
  await ctx.dispose()
  return file
}

export interface PersistedSession {
  username: string
  jwt: string
  gitlabToken: string
  gitlabUrl: string
}

export async function readPersistedSession(username: SeedUser["username"]): Promise<PersistedSession> {
  const file = path.join(AUTH_DIR, `${username}.json`)
  return JSON.parse(await fs.readFile(file, "utf-8"))
}

/** Inject the FrontierSession into IndexedDB on the given page so the app
 * boots already-authenticated. Run after page.goto("/"). */
export async function injectSession(page: Page, session: PersistedSession): Promise<void> {
  await page.evaluate(async (s) => {
    // Mirror saveSession in src/lib/frontier/session-store.ts: open the
    // "codex-frontier" IDB and put the session under the "current" key.
    const open = indexedDB.open("codex-frontier", 1)
    open.onupgradeneeded = () => {
      open.result.createObjectStore("session")
    }
    await new Promise<void>((res, rej) => {
      open.onsuccess = () => res()
      open.onerror = () => rej(open.error)
    })
    const db = open.result
    const tx = db.transaction("session", "readwrite")
    tx.objectStore("session").put({
      jwt: s.jwt,
      gitlabToken: s.gitlabToken,
      gitlabUrl: s.gitlabUrl,
      username: s.username,
      createdAt: new Date().toISOString(),
    }, "current")
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    db.close()
    localStorage.setItem("codex:onboardingComplete", "true")
  }, session)
  // Reload so the app picks up the seeded session
  await page.reload()
  await page.waitForLoadState("networkidle")
}
```

- [ ] **Step 2: Verify the IDB layout matches `session-store.ts`**

Run: `cat src/lib/frontier/session-store.ts | head -40`
Expected: confirms IDB name (`codex-frontier`), object store (`session`), key (`current`). If they differ, update step 1's `injectSession`.

- [ ] **Step 3: Commit**

```bash
git add e2e/helpers/auth.ts
git commit -m "feat(e2e): auth helper to API-login + inject session into IDB

ensureAuthState(username) calls the seed user's login endpoint and
writes the JWT to e2e/.auth/<user>.json. injectSession(page, ...)
seeds it into the page's IndexedDB so the app boots authenticated."
```

---

## Task 9: Multi-user test fixture

**Files:**
- Create: `e2e/helpers/multi-user.ts`

- [ ] **Step 1: Create `e2e/helpers/multi-user.ts`**

```ts
import { test as base, expect, type Browser, type Page } from "@playwright/test"
import { resetBackend } from "./seed"
import { ensureAuthState, injectSession, readPersistedSession } from "./auth"

export interface AuthedPage extends Page {
  username: "alice" | "bob" | "carol"
}

interface Fixtures {
  alice: AuthedPage
  bob: AuthedPage
  carol: AuthedPage
}

async function makeAuthedPage(browser: Browser, username: "alice" | "bob" | "carol"): Promise<AuthedPage> {
  await ensureAuthState(username)
  const session = await readPersistedSession(username)
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto("/")
  await injectSession(page, session)
  return Object.assign(page, { username }) as AuthedPage
}

/** Resets the backend before every test (hermetic per-test isolation),
 * then provides on-demand pre-authenticated Pages for alice, bob, carol.
 * Each fixture instantiates lazily — a test that only uses { alice }
 * never spins up bob or carol. */
export const test = base.extend<Fixtures>({
  // Worker-scoped reset: run before each test. Cheap (~50ms) so we don't optimise.
  // eslint-disable-next-line no-empty-pattern
  alice: async ({ browser }, use) => {
    await resetBackend()
    use(await makeAuthedPage(browser, "alice"))
  },
  bob: async ({ browser }, use) => use(await makeAuthedPage(browser, "bob")),
  carol: async ({ browser }, use) => use(await makeAuthedPage(browser, "carol")),
})

export { expect }
```

> **Note on the reset placement:** Backend reset belongs in `alice` because tests using multi-user fixture always need at least `alice`. We avoid double-resetting when bob or carol is also requested by only calling `resetBackend()` in `alice`. For tests that use `bob` or `carol` *without* `alice`, the test must `await resetBackend()` manually in its own `beforeEach`. The convention in this suite: any spec using two users always lists `alice` first.

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.app.json --noEmit e2e/helpers/multi-user.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add e2e/helpers/multi-user.ts
git commit -m "feat(e2e): multi-user test fixture (alice/bob/carol)

Per-test backend reset + lazy pre-authenticated Pages. Specs import
{ test, expect } from this module to drive multi-user flows from a
single test."
```

---

## Task 10: Page object — `Dashboard`

**Files:**
- Create: `e2e/helpers/page-objects/Dashboard.ts`

- [ ] **Step 1: Create `e2e/helpers/page-objects/Dashboard.ts`**

```ts
import { type Page, expect } from "@playwright/test"

export interface CreateProjectOpts {
  name?: string
  source?: string
  target?: string
}

export class Dashboard {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/")
    await this.page.waitForLoadState("networkidle")
  }

  async createProject(opts: CreateProjectOpts = {}): Promise<string> {
    const name = opts.name ?? `Project ${Date.now()}`
    const source = opts.source ?? "en"
    const target = opts.target ?? "fr"

    await this.page.getByRole("button", { name: /new project/i }).click()
    await this.page.getByLabel("Project Name").fill(name)
    await this.page.getByLabel("Source Language").fill(source)
    await this.page.getByLabel("Target Language").fill(target)
    await this.page.getByRole("button", { name: "Create Project" }).click()

    await expect(this.page.getByText(name)).toBeVisible({ timeout: 5_000 })
    return name
  }

  async openProject(name: string): Promise<void> {
    await this.page.getByText(name).click()
    await expect(this.page.locator("aside")).toBeVisible({ timeout: 10_000 })
    const setupSheet = this.page.getByRole("dialog", { name: /project setup/i })
    if (await setupSheet.isVisible().catch(() => false)) {
      await this.page.keyboard.press("Escape")
      await expect(setupSheet).not.toBeVisible({ timeout: 3_000 })
    }
  }

  async deleteProject(name: string): Promise<void> {
    const card = this.page.locator(`text=${name}`).first()
    await card.hover()
    await card.locator("..").getByRole("button", { name: /more/i }).click()
    await this.page.getByRole("menuitem", { name: /delete|trash/i }).click()
    await this.page.getByRole("button", { name: /confirm|delete/i }).click()
    await expect(this.page.getByText(name)).not.toBeVisible({ timeout: 5_000 })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add e2e/helpers/page-objects/Dashboard.ts
git commit -m "feat(e2e): Dashboard page object"
```

---

## Task 11: Page object — `Workspace`

**Files:**
- Create: `e2e/helpers/page-objects/Workspace.ts`

- [ ] **Step 1: Create `e2e/helpers/page-objects/Workspace.ts`**

```ts
import { type Page, type Locator, expect } from "@playwright/test"

export class Workspace {
  constructor(private readonly page: Page) {}

  async importFile(filePath: string): Promise<void> {
    await this.page.getByRole("button", { name: /^Import$/i }).click()
    await expect(this.page.getByText("Import Files")).toBeVisible({ timeout: 5_000 })
    await this.page.locator('input[type="file"]').setInputFiles(filePath)
    await expect(this.page.getByText("Import Files")).not.toBeVisible({ timeout: 15_000 })
  }

  async openFileBySubstring(nameSubstring: string): Promise<void> {
    await this.page
      .locator("aside")
      .locator("div")
      .filter({ hasText: new RegExp(nameSubstring, "i") })
      .filter({ has: this.page.locator('button[aria-label="File actions"]') })
      .first()
      .click()
  }

  async waitForEditor(): Promise<void> {
    await expect(this.page.locator("[data-cell-id]").first()).toBeVisible({ timeout: 10_000 })
  }

  cellRow(index = 0): Locator {
    return this.page.locator("[data-cell-id]").nth(index)
  }

  async editCell(index: number, text: string): Promise<void> {
    const row = this.cellRow(index)
    const target = row.locator(".tiptap [contenteditable], textarea").first()
    await target.click()
    await this.page.keyboard.type(text)
    await this.page.locator("aside").click() // blur
  }

  async readCell(index: number): Promise<string> {
    const row = this.cellRow(index)
    return (await row.textContent()) ?? ""
  }

  async validateCell(index: number): Promise<void> {
    const row = this.cellRow(index)
    const validationButton = row.locator("button[title*='Health']").first()
    await expect(validationButton).toBeVisible({ timeout: 10_000 })
    await validationButton.click()
    const validateAction = this.page.getByRole("button", { name: /validate/i })
    if (await validateAction.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await validateAction.click()
    }
    await expect(row.locator(".text-emerald-500").first()).toBeVisible({ timeout: 10_000 })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add e2e/helpers/page-objects/Workspace.ts
git commit -m "feat(e2e): Workspace page object"
```

---

## Task 12: Smoke spec — login

**Files:**
- Create: `e2e/specs/auth/login.smoke.spec.ts`

- [ ] **Step 1: Create `e2e/specs/auth/login.smoke.spec.ts`**

```ts
import { test, expect } from "@playwright/test"
import { resetBackend, seedUser } from "../../helpers/seed"

test.beforeEach(async () => {
  await resetBackend()
})

test("seed user can log in via the UI and lands on dashboard", async ({ page }) => {
  await page.goto("/login")
  const u = seedUser("alice")
  await page.getByLabel(/username/i).fill(u.username)
  await page.getByLabel(/password/i).fill(u.password)
  await page.getByRole("button", { name: /log in|sign in/i }).click()

  // Land on dashboard — h1 (brand) becomes visible
  await expect(page.locator("h1")).toBeVisible({ timeout: 10_000 })
  // The username should appear in the account switcher
  await expect(page.getByText(u.username)).toBeVisible({ timeout: 5_000 })
})
```

- [ ] **Step 2: Verify the login route exists at `/login`**

Run: `grep -rn "path=\"/login\"\|<Route.*login" src/`
Expected: a route definition matching `/login`. If it's at a different path (e.g. `/sign-in`), update the `page.goto` accordingly.

- [ ] **Step 3: Run the smoke spec end-to-end**

Run: `npm run test:e2e:smoke`
Expected: `e2e-up.ts` boots the stack, Playwright runs the one matching spec, it passes.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/auth/login.smoke.spec.ts
git commit -m "test(e2e): smoke — seed user logs in via UI"
```

---

## Task 13: Smoke spec — create project

**Files:**
- Rename + edit: `e2e/specs/projects/crud.spec.ts` → `e2e/specs/projects/create.smoke.spec.ts`

- [ ] **Step 1: Rewrite the create test against the new fixture / page object**

```bash
git mv e2e/specs/projects/crud.spec.ts e2e/specs/projects/create.smoke.spec.ts
```

Replace its contents with:

```ts
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"

test("alice creates a project and it appears on her dashboard", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Smoke ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await expect(alice.getByText(name)).toBeVisible({ timeout: 5_000 })
})
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e:smoke -- --grep "alice creates a project"`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/projects/
git commit -m "test(e2e): smoke — alice creates a project (uses multi-user fixture)"
```

---

## Task 14: Smoke spec — file import + cell edit persists

**Files:**
- Rename + edit: `e2e/specs/editor/import-and-edit.spec.ts` → `e2e/specs/editor/import-and-edit.smoke.spec.ts`

- [ ] **Step 1: Rewrite against the new fixture / page objects**

```bash
git mv e2e/specs/editor/import-and-edit.spec.ts e2e/specs/editor/import-and-edit.smoke.spec.ts
```

Replace its contents with:

```ts
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice imports markdown, edits a cell, and the edit persists across reload", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Editor ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const text = `Hello e2e ${Date.now()}`
  await ws.editCell(0, text)

  // Reload and assert the text survived
  await alice.reload()
  await alice.waitForLoadState("networkidle")
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(text, { timeout: 5_000 })
})
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e:smoke -- --grep "imports markdown"`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/editor/
git commit -m "test(e2e): smoke — import markdown + cell edit persists"
```

---

## Task 15: Smoke spec — AI completion (mock LLM)

**Files:**
- Rename + edit: `e2e/specs/ai/completion.spec.ts` → `e2e/specs/ai/completion.smoke.spec.ts`

- [ ] **Step 1: Rewrite to use the mock LLM via `VITE_LLM_BASE_URL`**

```bash
git mv e2e/specs/ai/completion.spec.ts e2e/specs/ai/completion.smoke.spec.ts
```

Replace its contents with:

```ts
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("sparkle button fills target cell from mock LLM", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AI ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "es" })
  await dash.openProject(name)

  // Configure the project to use the local mock LLM via Settings page
  const url = alice.url()
  const projectId = url.split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/settings`)
  await alice.locator("details").filter({ hasText: "Advanced LLM settings" }).locator("summary").click()
  await alice.locator("input[name='provider'][type='radio']").last().check()
  const endpointInput = alice.locator("#ep")
  const llmBase = process.env.VITE_LLM_BASE_URL ?? ""
  expect(llmBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  await endpointInput.fill(llmBase)
  await endpointInput.blur()
  await alice.getByRole("button", { name: "Connect" }).click()
  await expect(alice.getByText("Connected")).toBeVisible({ timeout: 10_000 })

  // Back to workspace, import, complete
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await alice.locator("button[title*='Generate translation']").first().click()

  await expect(
    alice.locator("[data-cell-id]").first().locator("textarea, .tiptap"),
  ).toContainText("Traducción de prueba", { timeout: 15_000 })
})
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e:smoke -- --grep "sparkle button"`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/ai/
git commit -m "test(e2e): smoke — sparkle button fills cell from mock LLM"
```

---

## Task 16: Smoke spec — validate cell

**Files:**
- Rename + edit: `e2e/specs/validation/validate.spec.ts` → `e2e/specs/validation/validate.smoke.spec.ts`

- [ ] **Step 1: Rewrite using new fixture / page objects**

```bash
git mv e2e/specs/validation/validate.spec.ts e2e/specs/validation/validate.smoke.spec.ts
```

Replace contents:

```ts
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice validates a cell and the indicator turns emerald", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Validate ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await ws.editCell(0, "Test translation")
  await ws.validateCell(0)
})
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e:smoke -- --grep "validates a cell"`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/validation/
git commit -m "test(e2e): smoke — validate cell turns indicator emerald"
```

---

## Task 17: Smoke spec — two-user collab (file propagation)

**Files:**
- Create: `e2e/specs/collab/file-propagation.smoke.spec.ts`

- [ ] **Step 1: Create the spec**

```ts
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice imports a file; bob (added as member) sees it propagate", async ({ alice, bob }) => {
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `Collab ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)

  // Add bob as a project member via the Members page
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]!
  await alice.goto(`/project/${projectId}/members`)
  await alice.getByRole("button", { name: /add member|invite/i }).click()
  await alice.getByLabel(/username/i).fill("bob")
  await alice.getByRole("button", { name: /add|invite|confirm/i }).click()
  await expect(alice.getByText("bob")).toBeVisible({ timeout: 5_000 })

  // Alice imports
  await alice.goto(`/project/${projectId}`)
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()

  // Bob navigates to the same project
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await expect(bob.getByText(name)).toBeVisible({ timeout: 15_000 })
  await bobDash.openProject(name)
  // The file should appear in bob's sidebar within the partyserver propagation window
  await expect(
    bob.locator("aside").locator("div").filter({ hasText: /sample/i }),
  ).toBeVisible({ timeout: 20_000 })
})
```

- [ ] **Step 2: Verify the Members page route exists**

Run: `grep -rn "members" src/App.tsx src/pages/MembersPage.tsx | head -5`
Expected: a route at `/project/:id/members` that renders `MembersPage`. If the path differs, update step 1's `goto`.

- [ ] **Step 3: Run**

Run: `npm run test:e2e:smoke -- --grep "alice imports a file; bob"`
Expected: pass. (May be flaky if the partyserver propagation timing is tight; bump the 20s if needed.)

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/collab/
git commit -m "test(e2e): smoke — file propagates from alice to bob via partyserver"
```

---

## Task 18: Smoke spec — two-user concurrent cell edit

**Files:**
- Create: `e2e/specs/collab/concurrent-edit.smoke.spec.ts`

- [ ] **Step 1: Create the spec**

```ts
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice's edit on cell 0 is visible in bob's open editor within 5s", async ({ alice, bob }) => {
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `Concurrent ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]!
  await alice.goto(`/project/${projectId}/members`)
  await alice.getByRole("button", { name: /add member|invite/i }).click()
  await alice.getByLabel(/username/i).fill("bob")
  await alice.getByRole("button", { name: /add|invite|confirm/i }).click()

  await alice.goto(`/project/${projectId}`)
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()

  // Bob opens the same project + file
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await bobDash.openProject(name)
  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()

  // Alice types
  const text = `from-alice-${Date.now()}`
  await aliceWs.editCell(0, text)

  // Bob sees it
  await expect(bobWs.cellRow(0)).toContainText(text, { timeout: 5_000 })
})
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e:smoke -- --grep "alice's edit on cell 0"`
Expected: pass. If timing is tight, bump the inner timeout to 10s.

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/collab/
git commit -m "test(e2e): smoke — concurrent cell edit propagates alice → bob"
```

---

## Task 19: Smoke spec — add member to org

**Files:**
- Create: `e2e/specs/orgs/members.smoke.spec.ts`

- [ ] **Step 1: Inspect the org members UI**

Run: `grep -rn "addOrgMember\|add.*member\|invite.*org" src/pages/MembersPage.tsx src/lib/frontier/orgs.ts | head -10`
Expected: a function/handler that posts to org members. Identify the UI element to click.

- [ ] **Step 2: Create the spec (placeholder selectors — refine after step 1)**

```ts
import { test, expect } from "../../helpers/multi-user"

test("alice (Acme owner) adds bob to her org and bob sees Acme on his dashboard", async ({ alice, bob }) => {
  // alice navigates to her org members page (Acme is pre-seeded by /__test__/reset)
  await alice.goto("/")
  await alice.getByRole("button", { name: /Acme/i }).first().click()
  await alice.getByRole("link", { name: /members/i }).click()
  await alice.getByRole("button", { name: /add member|invite/i }).click()
  await alice.getByLabel(/username/i).fill("bob")
  await alice.getByRole("button", { name: /add|invite|confirm/i }).click()
  await expect(alice.getByText("bob")).toBeVisible({ timeout: 5_000 })

  // bob reloads — Acme should now appear in his org switcher
  await bob.goto("/")
  await bob.reload()
  await expect(bob.getByText(/Acme/i)).toBeVisible({ timeout: 10_000 })
})
```

- [ ] **Step 3: Run + adjust selectors as needed**

Run: `npm run test:e2e:smoke -- --grep "Acme owner"`
Expected: pass after selector refinement.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/orgs/
git commit -m "test(e2e): smoke — alice adds bob to org Acme; bob sees it"
```

---

## Task 20: Smoke spec — define rule + see violation

**Files:**
- Create: `e2e/specs/rules/violation.smoke.spec.ts`

- [ ] **Step 1: Inspect the rules UI**

Run: `grep -rn "addRule\|defineRule\|new rule" src/pages src/components/RulesPanel* 2>/dev/null | head -10`
Expected: identify the route and the "new rule" UI affordance. The simplest rule to define for a smoke test is a built-in like "double-space" or "repeated-word" (see [docs/superpowers/specs/2026-04-21-auto-correct-rule-violations-design.md](docs/superpowers/specs/2026-04-21-auto-correct-rule-violations-design.md) for naming).

- [ ] **Step 2: Create the spec**

```ts
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice enables double-space rule and sees a violation surfaced in editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Rules ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  // Open Rules page (route confirmed: /project/:id/rules → RulesPage)
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]!
  await alice.goto(`/project/${projectId}/rules`)
  // Enable the built-in double-space check
  await alice.getByRole("switch", { name: /double.space/i }).check()

  // Back to workspace, import, type a violation
  await alice.goto(`/project/${projectId}`)
  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  await ws.editCell(0, "this  has  double  spaces") // intentional doubles

  // Expect a violation indicator on the row (data-violation or red ring)
  await expect(ws.cellRow(0).locator("[data-violation], .text-red-500").first()).toBeVisible({ timeout: 5_000 })
})
```

- [ ] **Step 3: Run + adjust selectors**

Run: `npm run test:e2e:smoke -- --grep "double-space"`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/rules/
git commit -m "test(e2e): smoke — enable double-space rule, see violation"
```

---

## Task 21: `e2e/JOURNEYS.md` — canonical journey map

**Files:**
- Create: `e2e/JOURNEYS.md`

- [ ] **Step 1: Create the journey map**

```md
# E2E User-Journey Map

> The canonical mapping of user journeys to spec files. AI coders: when adding a feature, grep this file by keyword. If your feature touches a journey here, **extend that spec**. If it's new, **add a row + new spec**.

| Area        | Journey                                              | Spec                                                                           | Smoke? |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ | :----: |
| Auth        | Seed user logs in via UI                             | `e2e/specs/auth/login.smoke.spec.ts`                                          |   ✅   |
| Auth        | Sign up new account                                  | _gap — Plan 2_                                                                |        |
| Auth        | Password reset request                               | _gap — Plan 2_                                                                |        |
| Auth        | Switch between two signed-in accounts                | _gap — Plan 2_                                                                |        |
| Onboarding  | First-run flow to dashboard                          | _gap — Plan 2_                                                                |        |
| Projects    | Create project, appears on dashboard                 | `e2e/specs/projects/create.smoke.spec.ts`                                     |   ✅   |
| Projects    | Open / delete / restore from trash                   | _gap — Plan 2_                                                                |        |
| Orgs        | Create org                                           | _gap — Plan 2_                                                                |        |
| Orgs        | Add member to org, member sees it                    | `e2e/specs/orgs/members.smoke.spec.ts`                                        |   ✅   |
| Orgs        | Remove member, change role                           | _gap — Plan 2_                                                                |        |
| Orgs        | Send & accept invite                                 | _gap — Plan 2_                                                                |        |
| Editor      | Import markdown, edit cell, persists across reload   | `e2e/specs/editor/import-and-edit.smoke.spec.ts`                              |   ✅   |
| Editor      | Cmd+K search                                         | _gap — Plan 2_                                                                |        |
| Editor      | Virtualization scroll integrity                      | _gap — Plan 2_                                                                |        |
| Rules       | Enable built-in rule, see violation in editor        | `e2e/specs/rules/violation.smoke.spec.ts`                                     |   ✅   |
| Rules       | Define custom rule                                   | _gap — Plan 2_                                                                |        |
| Rules       | Auto-correct a violation                             | _gap — Plan 2_                                                                |        |
| Validation  | Validate a cell, indicator turns emerald             | `e2e/specs/validation/validate.smoke.spec.ts`                                 |   ✅   |
| Validation  | History persists across navigation                   | _gap — Plan 2_                                                                |        |
| AI          | Sparkle button fills cell from mock LLM              | `e2e/specs/ai/completion.smoke.spec.ts`                                       |   ✅   |
| Collab      | File propagates from alice to bob                    | `e2e/specs/collab/file-propagation.smoke.spec.ts`                             |   ✅   |
| Collab      | Concurrent cell edit propagates alice → bob          | `e2e/specs/collab/concurrent-edit.smoke.spec.ts`                              |   ✅   |
| Collab      | Conflict resolution on same cell                     | _gap — Plan 2_                                                                |        |
| Collab      | Member presence indicators                           | _gap — Plan 2_                                                                |        |
| Comments    | Add / edit / resolve comment                         | _gap — Plan 2_                                                                |        |
| Sharing     | Generate invite link / join project via link        | _gap — Plan 2_                                                                |        |
| Audio/Video | Import audio file                                    | _gap — Plan 2_                                                                |        |
| Audio/Video | Subtitles flow                                       | _gap — Plan 2_                                                                |        |
| Settings    | Settings sync between two browsers                   | _gap — Plan 2_                                                                |        |
| Settings    | Settings persist across reload                       | _gap — Plan 2_                                                                |        |
| Export      | Export to each supported format                      | _gap — Plan 2_                                                                |        |
| Tauri       | Native dialogs / deeplink / updater / fs / keychain  | _gap — Plan 3_                                                                |        |

## How to add a journey

1. Pick the right `<area>` directory under `e2e/specs/`. If your journey doesn't fit any existing area, create a new folder.
2. Filename convention: `<journey>.spec.ts` for full-suite, `<journey>.smoke.spec.ts` for the pre-push gate.
3. Use `import { test, expect } from "../../helpers/multi-user"` if your test needs `alice`/`bob`/`carol`. Use `import { test, expect } from "@playwright/test"` for single-user, plus `await resetBackend()` in your own `beforeEach`.
4. Reuse page objects under `e2e/helpers/page-objects/`. Add a new one if no existing class fits.
5. Add a row to this table.
6. Run `npm run test:e2e:smoke` (or full `npm run test:e2e`) to verify.
```

- [ ] **Step 2: Commit**

```bash
git add e2e/JOURNEYS.md
git commit -m "docs(e2e): canonical user-journey map for AI discoverability"
```

---

## Task 22: `e2e/README.md`

**Files:**
- Create: `e2e/README.md`

- [ ] **Step 1: Create the README**

```md
# E2E Test Suite

Playwright-driven end-to-end tests against a hermetic local backend.

## Quick start

```bash
# One-time per machine
git clone git@github.com:frontier-rnd/frontier-server ~/frontierrnd/frontier-server
cd ~/frontierrnd/frontier-server && npm install
cd -

npm install
npx playwright install chromium

# Run smoke (~2 min)
npm run test:e2e:smoke

# Run full suite
npm run test:e2e

# Debug a single spec
npm run test:e2e:ui
```

## Architecture

`scripts/e2e-up.ts` boots:
1. `frontier-server` via `wrangler dev --local` on port 8787 (auth, orgs, members, sync-token)
2. `sync-worker` via `wrangler dev --local` on port 8788 (y-partyserver collab DOs)
3. `MockLLMServer` on a random port (OpenAI-compatible)
4. `vite` on port 5173

Then writes `.env.test.local`:
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

Three pre-seeded users: `alice` (org owner), `bob`, `carol`.

## Spec naming

- `*.smoke.spec.ts` — runs on `git push`. Keep total suite <2 min.
- `*.spec.ts` — full suite, runs on `npm run test:e2e`.
- Files under `e2e/tauri/` — manual pre-release only.

## Adding a test

See `e2e/JOURNEYS.md` for the canonical journey map and conventions.

## Troubleshooting

- **`wrangler dev` won't start** → confirm `~/frontierrnd/frontier-server` exists and `wrangler login` is current. Set `FRONTIER_SERVER_DIR` if checked out elsewhere.
- **`/__test__/reset` returns 404** → `frontier-server` was started without `WRANGLER_LOCAL=1`, or you're running against an old build that doesn't have the route.
- **Tests pass alone, fail in suite** → reset isn't running or isn't truncating something. Verify `resetBackend()` runs in the failing test's `beforeEach`.
- **Mock LLM not connected** → `VITE_LLM_BASE_URL` isn't being passed to Vite. Check `.env.test.local` contents during a run.
```

- [ ] **Step 2: Commit**

```bash
git add e2e/README.md
git commit -m "docs(e2e): suite README — quickstart, architecture, troubleshooting"
```

---

## Task 23: `AGENTS.md` — repo-root rules for AI coders

**Files:**
- Create: `AGENTS.md` at repo root

- [ ] **Step 1: Create `AGENTS.md`**

```md
# AGENTS.md

Rules for any AI coding assistant working in this repo (Claude Code, Cursor, Copilot, Aider, etc.).

## Testing — non-negotiable

Before claiming any feature is complete:

1. **Run the smoke suite.** `npm run test:e2e:smoke` must pass. The pre-push hook enforces this; do not bypass with `--no-verify` unless explicitly told to.
2. **If your change touches a journey listed in `e2e/JOURNEYS.md`, extend the matching spec OR add a new spec under `e2e/specs/<area>/`.**
3. **New user-facing journey = new row in `e2e/JOURNEYS.md` AND a new spec.**
4. **Reuse helpers** in `e2e/helpers/page-objects/`. Do not duplicate selectors. If no page object fits, add one.
5. Tests run against a **local `wrangler dev` instance** of `frontier-server`, not the production backend. See `e2e/README.md` for setup.

## Conventions

- Spec naming: `*.smoke.spec.ts` for the pre-push gate (<2 min total budget across all smoke specs); `*.spec.ts` for the full suite.
- Multi-user tests: import `{ test, expect } from "../../helpers/multi-user"`.
- Single-user tests: import from `@playwright/test` and call `resetBackend()` in your own `beforeEach`.
- Page objects: one class per surface, methods are user-intent verbs (`createProject`, `editCell`, not `clickButton1`).
- Selectors: prefer `getByRole`, `getByLabel`, then data attributes (`data-cell-id`); avoid CSS class selectors except for verifying a specific visual state (e.g. `text-emerald-500` for "validated").

## Out of scope for tests

- Snapshots (under redesign) — see Plan 2.
- Cross-browser. Chromium only for v1.
- Tauri shell — see Plan 3 for the separate `tauri-driver` suite.

## Project-level conventions

- Whenever a feature exists in both the VS Code extension and this app, mirror the extension's conventions. (See `~/.claude/projects/-Users-ryderwishart-prototypes-codex-web-app/memory/MEMORY.md`.)
- GitLab sync is transitional (legacy compat only). Don't build on top of it.
- The sync stack is y-partyserver on Cloudflare Durable Objects + R2; identity/permissions live in `frontier-server`.

## Useful slash commands

- `/e2e-add` — scaffold a new E2E spec from template (added in Task 24).
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): repo-root rules for AI coders

Pre-push smoke is non-negotiable; new user journeys require both a row
in e2e/JOURNEYS.md and a spec. Page-object reuse + multi-user fixture
conventions documented."
```

---

## Task 24: `/e2e-add` slash command

**Files:**
- Create: `.claude/commands/e2e-add.md`

- [ ] **Step 1: Create the command**

```md
---
description: Scaffold a new E2E spec from template
argument-hint: <area> <journey-slug> [--smoke]
---

You are scaffolding a new Playwright E2E spec for codex-web-app.

Arguments: $ARGUMENTS

Steps:

1. Parse `$ARGUMENTS` into `<area>` (one of: auth, projects, orgs, editor, rules, validation, ai, collab, comments, sharing, audio-video, settings, export) and `<journey-slug>` (kebab-case, e.g. `password-reset`).
2. If `--smoke` is present, the filename is `<journey-slug>.smoke.spec.ts`. Otherwise `<journey-slug>.spec.ts`.
3. The full path is `e2e/specs/<area>/<filename>`.
4. Confirm the directory exists: `ls e2e/specs/<area>/` — create it with `mkdir -p` if not.
5. Read `e2e/JOURNEYS.md` to confirm there's no existing spec for this journey. If there is, ask the user whether to extend it instead.
6. Decide whether the test needs multi-user. If so, import from `../../helpers/multi-user`; otherwise from `@playwright/test`.
7. Write the spec using this template:

```ts
import { test, expect } from "../../helpers/multi-user" // OR @playwright/test
// import { Dashboard } from "../../helpers/page-objects/Dashboard"
// import { Workspace } from "../../helpers/page-objects/Workspace"

test("<journey description in plain English>", async ({ alice /* or page */ }) => {
  // 1. arrange — call helpers / page objects to reach the starting state
  // 2. act    — perform the user action under test
  // 3. assert — verify visible UI state with expect(...).toBeVisible/toContainText/etc.
})
```

8. Add a row to `e2e/JOURNEYS.md` under the right Area section, with a one-line journey description and the filepath.
9. Run the new spec to confirm it actually fails (no fake green from missing UI elements): `npm run test:e2e -- --grep "<journey description>"`.
10. Hand control back to the user with the failing test output.

Do NOT implement the test body for them — leave the arrange/act/assert comments. The user will fill it in.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/e2e-add.md
git commit -m "feat(claude): /e2e-add slash command scaffolds new E2E spec"
```

---

## Task 25: Pre-push hook via husky

**Files:**
- Modify: `package.json` (add `husky`, `prepare` script, `lint-staged` not needed)
- Create: `.husky/pre-push`

- [ ] **Step 1: Install husky**

Run: `npm install --save-dev husky@^9`
Expected: husky added to devDependencies.

- [ ] **Step 2: Add `prepare` script**

In `package.json` `"scripts"`:
```json
"prepare": "husky"
```

- [ ] **Step 3: Run prepare to install hooks**

Run: `npm run prepare`
Expected: `.husky/_/` directory created.

- [ ] **Step 4: Create `.husky/pre-push`**

```sh
#!/usr/bin/env sh

echo "[pre-push] running E2E smoke (npm run test:e2e:smoke)…"
npm run test:e2e:smoke
status=$?

if [ $status -ne 0 ]; then
  echo ""
  echo "❌ E2E smoke failed. Push blocked."
  echo "   Debug: npm run test:e2e:ui"
  echo "   Bypass (NOT recommended): git push --no-verify"
  exit $status
fi

echo "[pre-push] ✅ smoke passed"
exit 0
```

Then: `chmod +x .husky/pre-push`

- [ ] **Step 5: Verify the hook fires**

Run: `git push --dry-run origin feat/e2e-release-gate-suite`
Expected: hook runs, smoke passes, dry-run completes. (If smoke is slow on first run because wrangler cold-starts, document the cold-start cost in `e2e/README.md` — already done in Task 22.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .husky/
git commit -m "chore(husky): pre-push hook runs E2E smoke

git push is blocked when npm run test:e2e:smoke fails. Bypass with
--no-verify only if you know what you're doing."
```

---

## Task 26: End-to-end verification + cleanup

**Files:**
- Verify (no edits)
- Possibly delete: stale fixtures or unused legacy helpers

- [ ] **Step 1: Confirm `e2e/helpers/legacy.ts` has no remaining importers**

Run: `grep -rn "from.*helpers/legacy" e2e/`
Expected: zero hits. (Tasks 12-20 should have replaced all legacy helper imports with page objects.)

If any remain, refactor them onto page objects (extend `Dashboard` or `Workspace` rather than keeping the loose helper).

- [ ] **Step 2: Delete the legacy helper**

```bash
git rm e2e/helpers/legacy.ts
```

- [ ] **Step 3: Run the full smoke suite**

Run: `npm run test:e2e:smoke`
Expected: all 9 smoke specs pass. Total time <2 min on a warm machine. First cold run may take 4-5 min (wrangler cold start + first browser cache).

- [ ] **Step 4: Run the full (non-smoke) suite**

Run: `npm run test:e2e`
Expected: all specs pass. (Currently this is just the smoke specs since Plan 2 hasn't filled in the gaps.)

- [ ] **Step 5: Verify pre-push gate works on a real push**

```bash
git push origin feat/e2e-release-gate-suite
```
Expected: hook runs, smoke passes, push completes.

- [ ] **Step 6: Verify the gate actually blocks**

Introduce a deliberate failure to confirm the hook isn't a no-op. In `e2e/specs/auth/login.smoke.spec.ts`, change the expected username from `alice` to `aliceXXX`. Then:

```bash
git add -A
git commit -m "test: deliberate failure to verify pre-push blocks"
git push origin feat/e2e-release-gate-suite
```
Expected: hook prints failure, push is blocked.

Revert:
```bash
git reset --hard HEAD~1
```

- [ ] **Step 7: Final cleanup commit**

```bash
git add -A
git commit -m "chore(e2e): remove legacy helper after migration to page objects"
```

---

## Acceptance criteria

After Task 26, the following must hold:

- [ ] `npm run test:e2e:smoke` runs end-to-end on a clean macOS dev machine in <2 min, all green.
- [ ] `git push` is blocked when smoke fails (verified in Task 26 step 6).
- [ ] `AGENTS.md` and `e2e/JOURNEYS.md` exist and an AI agent reading them can locate the right spec for an arbitrary feature.
- [ ] A failing test produces: `trace.zip` (on retry), screenshot, video on retry. Located in `test-results/` (gitignored).
- [ ] Multi-user fixture is verified: `e2e/specs/collab/concurrent-edit.smoke.spec.ts` drives two `Page`s and the assertion succeeds.
- [ ] Per-test isolation is verified: each smoke spec passes when run in isolation (`npm run test:e2e:smoke -- --grep "<single test name>"`) and in suite.
- [ ] `/__test__/reset` route on `frontier-server` is merged to that repo's main and gated behind `WRANGLER_LOCAL=1`.
