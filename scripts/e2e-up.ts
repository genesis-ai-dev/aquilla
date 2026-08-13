import { spawn, spawnSync } from "node:child_process"
import { existsSync, writeFileSync, rmSync, copyFileSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  spawnWranglerDev,
  killChildTree,
  attachOutput,
  openLogFile,
  type SpawnedWorker,
} from "./lib/spawn-worker"
import { MockLLMServer } from "../e2e/helpers/mock-llm-server"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

// Shard support. E2E_SHARD="i/N" boots an isolated stack for shard i of N so
// several stacks can run concurrently — each gets its own ports, Postgres DB,
// wrangler state, build dir, and Playwright --shard slice. Unset (or N=1) keeps
// the original single-stack behavior byte-for-byte. K is the 0-based offset used
// to fan out ports/names. See scripts/e2e-shard.ts for the parallel runner.
const SHARD_MATCH = /^(\d+)\/(\d+)$/.exec(process.env.E2E_SHARD ?? "")
const SHARD_INDEX = SHARD_MATCH ? parseInt(SHARD_MATCH[1], 10) : 1
const SHARD_TOTAL = SHARD_MATCH ? parseInt(SHARD_MATCH[2], 10) : 1
const SHARDED = SHARD_TOTAL > 1
const K = SHARD_INDEX - 1
const SUFFIX = SHARDED ? `-s${K}` : ""
const TAG = SHARDED ? `[shard ${SHARD_INDEX}/${SHARD_TOTAL}] ` : ""

// Identity is the in-repo auth-worker (aquilla-identity) — it replaced the
// retired frontier-server and owns the full aquilla-db schema + migrations.
// It also serves /__test__/reset (gated by WRANGLER_LOCAL) and /api/v1/auth/*,
// so the e2e helpers (seed.ts, auth.ts) work against it unchanged.
const AUTH_WORKER_DIR = path.join(REPO_ROOT, "auth-worker")
const SYNC_WORKER_DIR = path.join(REPO_ROOT, "sync-worker")
// Shared wrangler local state so auth-worker (writes users/orgs/projects) and
// sync-worker (writes files/cells/events) see the same aquilla-db rows. Without
// --persist-to each cwd gets its own isolated sqlite and the two drift apart.
// Per-shard so concurrent stacks don't trample each other's DO storage.
const PERSIST_DIR = path.join(REPO_ROOT, `.wrangler-e2e-state${SUFFIX}`)
// Local Postgres used as the Hyperdrive target for e2e. Wrangler reads
// WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING> to override the
// Hyperdrive connection without needing a deployed Hyperdrive ID. The
// aquilla_e2e database is recreated from db/postgres/schema.sql on each run.
// Each shard gets its own database (aquilla_e2e_s<K>) for full isolation.
//
// The reset prefers the Docker container `aquilla-dev-pg` (the canonical
// CI/dev setup); when Docker isn't available it falls back to a local `psql`
// against the same localhost:5432 endpoint (e.g. a Homebrew Postgres dev box).
const E2E_PG_DB = `aquilla_e2e${SHARDED ? `_s${K}` : ""}`
const E2E_PG_URL = `postgresql://aquilla:aquilla@localhost:5432/${E2E_PG_DB}`
const PG_CONTAINER = "aquilla-dev-pg"
// Admin connection used only by the Docker-less reset fallback. Drop/recreate
// needs CREATE DATABASE, which the `aquilla` login role lacks, so we default to
// the OS superuser over the default unix socket (Homebrew Postgres convention).
// Override with E2E_PG_ADMIN_URL for non-standard local setups.
const E2E_PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || "postgresql:///postgres"
const HYPERDRIVE_ENV = { WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: E2E_PG_URL }
// Ports fan out by K*100 so shards never collide (8787/8788, 8887/8888, …).
const IDENTITY_PORT = 8787 + K * 100
const SYNC_WORKER_PORT = 8788 + K * 100
const VITE_PORT = 5173 + K * 100
const LEGACY_MIGRATION_MOCK_PORT = 9460 + K * 100
// Per-shard build output so concurrent `vite build`s don't overwrite one dist.
// Single-stack keeps the default `dist` so nothing else changes.
const DIST_DIR = SHARDED ? `dist-e2e-s${K}` : "dist"

const VERBOSE = process.env.E2E_VERBOSE === "1" || process.argv.includes("--verbose")
const LOG_DIR = path.join(REPO_ROOT, `.e2e-logs${SUFFIX}`)
const COMMAND_HEARTBEAT_MS = 15_000
const COMMAND_TIMEOUT_MS = 10 * 60_000

const cleanup: Array<() => Promise<void>> = []
const logFiles: Record<string, string> = {}

let shuttingDown = false
async function shutdown(code = 0): Promise<never> {
  if (shuttingDown) {
    // A second SIGINT during teardown — give up on graceful and exit hard.
    process.exit(code)
  }
  shuttingDown = true
  console.log(`\n${TAG}[e2e-up] shutting down…`)
  // Iterate a copy so the array isn't mutated.
  for (const fn of [...cleanup].reverse()) {
    try { await fn() } catch (e) { console.error(e) }
  }
  process.exit(code)
}

process.on("SIGINT", () => { void shutdown(130) })
process.on("SIGTERM", () => { void shutdown(143) })

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (r.status < 500) return
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

/** Run a command and either inherit stdio (verbose) or pipe to /dev/null
 * (quiet). Output goes to the log file in quiet mode if `logLabel` is set.
 * `env` overrides are merged onto process.env for the child. */
function runOnce(
  cmd: string,
  args: string[],
  cwd: string,
  logLabel?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdio: ("inherit" | "ignore" | "pipe")[] =
      VERBOSE ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"]
    const c = spawn(cmd, args, { cwd, stdio, env: env ? { ...process.env, ...env } : process.env })
    const startedAt = Date.now()
    const label = logLabel ?? `${cmd} ${args[0] ?? ""}`.trim()
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearInterval(heartbeat)
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1_000)
      console.log(`${TAG}[e2e-up] ${label} still running (${elapsedSeconds}s)…`)
    }, COMMAND_HEARTBEAT_MS)
    heartbeat.unref()
    const timeout = setTimeout(() => {
      const error = new Error(`${label} exceeded ${Math.round(COMMAND_TIMEOUT_MS / 60_000)} minute command timeout`)
      void killChildTree(c).finally(() => finish(error))
    }, COMMAND_TIMEOUT_MS)
    timeout.unref()
    if (!VERBOSE && logLabel && logFiles[logLabel]) {
      const stream = openLogFile(logFiles[logLabel])
      c.stdout?.pipe(stream, { end: false })
      c.stderr?.pipe(stream, { end: false })
    } else if (!VERBOSE) {
      // Drain so the child doesn't block on full pipes.
      c.stdout?.on("data", () => {})
      c.stderr?.on("data", () => {})
    }
    c.on("error", (error) => finish(error))
    c.on("exit", (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(`${cmd} ${args.join(" ")} exit ${code ?? `signal ${signal ?? "unknown"}`}`))
    })
  })
}

/** If wrangler/workerd exits mid-suite, Playwright would otherwise keep
 * going and every remaining spec would fail in 0s with ECONNREFUSED.
 * Abort the shard immediately and dump worker logs. */
function abortIfWorkerDies(worker: SpawnedWorker, label: string): void {
  worker.child.on("exit", (code, signal) => {
    if (shuttingDown) return
    const reason = code != null ? `exit ${code}` : `signal ${signal ?? "unknown"}`
    console.error(
      `\n${TAG}[fail] ${label} worker on :${worker.port} died (${reason}).\n` +
        `${TAG}[fail] Remaining tests would fail with ECONNREFUSED ${worker.port} — aborting now.\n` +
        `${TAG}[hint] Tail ${logFiles[label] ?? `${LOG_DIR}/`}. Common causes: another e2e-up / pnpm dev fighting the port, workerd OOM, or Postgres gone.`,
    )
    dumpLogs()
    void shutdown(1)
  })
}

/** Print the last N lines of each known log file to stderr. Used when a
 * subcommand fails so the developer can see what went wrong without
 * needing to know the log paths. */
function dumpLogs(tailLines = 80): void {
  for (const [label, file] of Object.entries(logFiles)) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, "utf-8").trimEnd().split("\n")
    // Cap line length — the build log contains minified asset content with
    // multi-megabyte single lines that would otherwise flood the terminal.
    const tail = lines.slice(-tailLines).map((l) => (l.length > 500 ? l.slice(0, 500) + " …[truncated]" : l))
    process.stderr.write(`\n──── ${TAG}${label} (last ${tail.length} lines of ${file}) ────\n`)
    process.stderr.write(tail.join("\n") + "\n")
  }
}

/** Free a port held by a stale process from a prior run. Non-interactive
 * SIGTERM-then-SIGKILL — anything bound to one of our managed ports is by
 * definition leftover orchestrator state. */
async function freePort(port: number): Promise<void> {
  const pidsRaw = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).stdout || ""
  const pids = pidsRaw.split("\n").filter(Boolean)
  if (pids.length === 0) return
  console.log(`${TAG}[e2e-up] freeing port ${port} (held by ${pids.join(", ")})…`)
  for (const pid of pids) {
    try { process.kill(Number(pid), "SIGTERM") } catch {}
  }
  await new Promise((r) => setTimeout(r, 500))
  const remaining = (spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).stdout || "")
    .split("\n").filter(Boolean)
  for (const pid of remaining) {
    try { process.kill(Number(pid), "SIGKILL") } catch {}
  }
}

/** Copy a worker's `.dev.vars.example` → `.dev.vars` if missing, so a fresh
 * checkout boots without a manual step. Both backends ship an example file. */
function ensureDevVars(appDir: string, label: string): void {
  const target = path.join(appDir, ".dev.vars")
  const source = path.join(appDir, ".dev.vars.example")
  if (existsSync(target)) return
  if (!existsSync(source)) {
    console.warn(`${TAG}[e2e-up] ${label}: no .dev.vars and no .dev.vars.example — the worker may fail to boot.`)
    return
  }
  copyFileSync(source, target)
  console.log(`${TAG}[e2e-up] ${label}: created .dev.vars from .dev.vars.example`)
}

/** True when the Docker-managed Postgres container is reachable. False when
 * there's no Docker daemon (the binary is missing → spawnSync status is null)
 * or the container isn't running — e.g. a Homebrew-Postgres dev machine. */
function dockerPgAvailable(): boolean {
  return spawnSync("docker", ["exec", PG_CONTAINER, "true"], { stdio: "ignore" }).status === 0
}

/** True when a local `psql` client is on PATH (the Docker-less fallback). */
function hasLocalPsql(): boolean {
  return spawnSync("psql", ["--version"], { stdio: "ignore" }).status === 0
}

/**
 * Drop + recreate the e2e database from a clean schema. Prefers the Docker
 * container (`aquilla-dev-pg`, the canonical CI/dev setup); falls back to a
 * local `psql` against localhost:5432 when Docker is unavailable. Exits the
 * process on failure — we refuse to run the suite against a stale/partial
 * schema (it manifests as confusing 500s like "column p.is_active does not
 * exist").
 *
 * ON_ERROR_STOP makes psql exit non-zero on the first error — without it a
 * failed DROP (held connections) or a partial schema apply returns 0 and the
 * suite silently runs against a stale schema.
 */
function resetE2ePostgres(): void {
  const schemaSql = readFileSync(path.join(REPO_ROOT, "db/postgres/schema.sql"))

  if (dockerPgAvailable()) {
    const dropResult = spawnSync(
      "docker",
      ["exec", PG_CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "aquilla", "-d", "postgres",
        "-c", `DROP DATABASE IF EXISTS ${E2E_PG_DB} WITH (FORCE)`, "-c", `CREATE DATABASE ${E2E_PG_DB}`],
      { stdio: ["ignore", "inherit", "inherit"] },
    )
    if (dropResult.status !== 0) {
      console.error(`${TAG}[e2e-up] ${E2E_PG_DB} drop/recreate failed (psql exit ${dropResult.status}) — refusing to run against a stale schema.`)
      process.exit(1)
    }
    // Pipe schema.sql into psql via stdin — no shell interpolation needed.
    const psqlResult = spawnSync(
      "docker",
      ["exec", "-i", PG_CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "aquilla", "-d", E2E_PG_DB],
      { input: schemaSql, stdio: ["pipe", "pipe", "pipe"] },
    )
    if (psqlResult.status !== 0) {
      console.error(`${TAG}[e2e-up] schema apply failed:`, psqlResult.stderr?.toString())
      process.exit(1)
    }
    return
  }

  // Docker-less fallback: use a local psql (e.g. Homebrew Postgres on :5432).
  if (!hasLocalPsql()) {
    console.error(
      `${TAG}[e2e-up] no Docker container 'aquilla-dev-pg' and no local 'psql' on PATH.\n` +
        "  Start Docker (with the aquilla-dev-pg container) or install a local\n" +
        "  Postgres reachable at localhost:5432 with role 'aquilla'. See e2e/README.md.",
    )
    process.exit(1)
  }
  console.log(`${TAG}[e2e-up] Docker unavailable — resetting via local psql (localhost:5432).`)
  // Drop/recreate needs CREATE DATABASE (the `aquilla` login role lacks it), so
  // run it through the admin connection and hand ownership to `aquilla` so the
  // schema apply (as aquilla) can create objects in the public schema.
  const dropResult = spawnSync(
    "psql",
    [E2E_PG_ADMIN_URL, "-v", "ON_ERROR_STOP=1",
      "-c", `DROP DATABASE IF EXISTS ${E2E_PG_DB} WITH (FORCE)`,
      "-c", `CREATE DATABASE ${E2E_PG_DB} OWNER aquilla`],
    { stdio: ["ignore", "inherit", "inherit"] },
  )
  if (dropResult.status !== 0) {
    console.error(`${TAG}[e2e-up] ${E2E_PG_DB} drop/recreate failed (psql exit ${dropResult.status}) — refusing to run against a stale schema.`)
    process.exit(1)
  }
  const psqlResult = spawnSync(
    "psql",
    [E2E_PG_URL, "-v", "ON_ERROR_STOP=1"],
    { input: schemaSql, stdio: ["pipe", "pipe", "pipe"] },
  )
  if (psqlResult.status !== 0) {
    console.error(`${TAG}[e2e-up] schema apply failed:`, psqlResult.stderr?.toString())
    process.exit(1)
  }
}

async function main(): Promise<void> {
  if (!existsSync(AUTH_WORKER_DIR)) {
    console.error(`${TAG}[e2e-up] auth-worker not found at ${AUTH_WORKER_DIR}`)
    process.exit(1)
  }
  if (!existsSync(SYNC_WORKER_DIR)) {
    console.error(`${TAG}[e2e-up] sync-worker not found at ${SYNC_WORKER_DIR}`)
    process.exit(1)
  }
  if (SHARDED) {
    console.log(`${TAG}[e2e-up] isolated stack: identity :${IDENTITY_PORT} · sync :${SYNC_WORKER_PORT} · vite :${VITE_PORT} · db ${E2E_PG_DB}`)
  }

  // The per-shard backend URLs the browser app must be built against, and the
  // node-side helpers (seed.ts, auth.ts) read. Mock LLM URL is filled in once
  // the server picks a port below. Setting these on process.env makes the
  // `vite build` child bake them in (Vite inlines VITE_*-prefixed process env).
  const browserEnv: Record<string, string> = {
    VITE_AUTH_BASE: `http://127.0.0.1:${IDENTITY_PORT}`,
    VITE_FRONTIER_BASE: `http://127.0.0.1:${IDENTITY_PORT}`,
    VITE_SYNC_WORKER_HOST: `127.0.0.1:${SYNC_WORKER_PORT}`,
    // Pin Google Drive import to unconfigured regardless of the developer's
    // .env.local — import-dialog.smoke.spec asserts the not-configured notice,
    // and real creds leaking into the e2e build would flip that panel state.
    VITE_GOOGLE_CLIENT_ID: "",
    VITE_GOOGLE_API_KEY: "",
  }

  // 0. Free our managed ports — survives stale processes from a prior aborted run.
  await freePort(IDENTITY_PORT)
  await freePort(SYNC_WORKER_PORT)
  await freePort(VITE_PORT)
  await freePort(LEGACY_MIGRATION_MOCK_PORT)

  // Set up the log dir. Worker stdout/stderr is piped here in non-verbose
  // mode so the developer's terminal stays clean. On test failure we tail
  // these files so problems are still discoverable.
  mkdirSync(LOG_DIR, { recursive: true })
  logFiles.identity = path.join(LOG_DIR, "identity.log")
  logFiles.sync = path.join(LOG_DIR, "sync.log")
  logFiles.vite = path.join(LOG_DIR, "vite.log")
  logFiles.migrations = path.join(LOG_DIR, "migrations.log")
  logFiles.build = path.join(LOG_DIR, "build.log")
  logFiles.legacyMigration = path.join(LOG_DIR, "mock-legacy-migration.log")
  // First-run prerequisites (idempotent): both workers need a .dev.vars.
  ensureDevVars(AUTH_WORKER_DIR, "identity")
  ensureDevVars(SYNC_WORKER_DIR, "sync")

  // Reset wrangler local D1 state (Durable Object storage, KV caches, etc.)
  console.log(`${TAG}[boot 1/8] resetting wrangler local state… (logs: ${LOG_DIR}/)`)
  rmSync(PERSIST_DIR, { recursive: true, force: true })
  mkdirSync(PERSIST_DIR, { recursive: true })

  // 2. Drop + recreate the e2e Postgres DB so every run starts from a clean
  //    schema. Workers use Hyperdrive → Postgres (not D1 SQLite) for all auth
  //    and sync queries, so we apply db/postgres/schema.sql here instead of
  //    wrangler d1 migrations apply.
  console.log(`${TAG}[boot 2/8] resetting ${E2E_PG_DB} postgres schema…`)
  resetE2ePostgres()

  // 3. Boot identity (auth-worker). WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
  // redirects Hyperdrive to the local Docker Postgres (aquilla_e2e) so all auth
  // SQL (Postgres syntax) executes correctly without a deployed Hyperdrive.
  // --var WRANGLER_LOCAL:1 unlocks /__test__/reset (process env alone doesn't
  // reach c.env bindings).
  // Scripted OpenRouter mock (scripts/mock-openrouter.ts) — the agent route's
  // "model brain" for e2e. Per-shard port so concurrent stacks don't clash.
  const OPENROUTER_MOCK_PORT = 9456 + K * 100
  console.log(`${TAG}[boot 3/8] starting mock OpenRouter on :${OPENROUTER_MOCK_PORT} + identity (auth-worker) on :${IDENTITY_PORT}…`)
  const openrouterMock = spawn(
    "npx",
    ["tsx", "scripts/mock-openrouter.ts", String(OPENROUTER_MOCK_PORT)],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  )
  attachOutput(openrouterMock, "mock-openrouter", openLogFile(path.join(LOG_DIR, "mock-openrouter.log")), VERBOSE)
  cleanup.push(() => killChildTree(openrouterMock))

  const legacyMigrationMock = spawn(
    "npx",
    ["tsx", "scripts/mock-legacy-migration.ts", String(LEGACY_MIGRATION_MOCK_PORT)],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  )
  attachOutput(
    legacyMigrationMock,
    "mock-legacy-migration",
    openLogFile(logFiles.legacyMigration),
    VERBOSE,
  )
  cleanup.push(() => killChildTree(legacyMigrationMock))
  await waitForUrl(
    `http://127.0.0.1:${LEGACY_MIGRATION_MOCK_PORT}/healthz`,
    30_000,
  )

  const identity: SpawnedWorker = await spawnWranglerDev({
    cwd: AUTH_WORKER_DIR,
    port: IDENTITY_PORT,
    label: "identity",
    env: { ...HYPERDRIVE_ENV },
    // ADMIN_EMAILS: site-admin identity is by account email; the admin-console
    // specs need alice to be a platform admin. Her seeded email is
    // alice@example.test (e2e/helpers/seed.ts). WRANGLER_LOCAL=1 + the unset
    // ADMIN_REQUIRE_ELEVATION here keep the step-up off so the console opens.
    // OPENROUTER_* point the agent/chat loops at the scripted mock above.
    // SYNC_WORKER_URL/ENVIRONMENT let identity reach the isolated sync worker.
    extraArgs: [
      "--persist-to", PERSIST_DIR,
      "--var", "WRANGLER_LOCAL:1",
      "--var", "ADMIN_REQUIRE_ELEVATION:false",
      "--var", "ADMIN_EMAILS:alice@example.test",
      "--var", `OPENROUTER_BASE_URL:http://127.0.0.1:${OPENROUTER_MOCK_PORT}/api/v1`,
      "--var", "OPENROUTER_API_KEY:mock",
      "--var", "LEGACY_USER_MIGRATION_ENABLED:true",
      "--var", "FRONTIER_D1_ACCOUNT_ID:e2e",
      "--var", "FRONTIER_D1_DATABASE_ID:frontier-db-v2",
      "--var", "FRONTIER_D1_API_TOKEN:e2e-d1-read",
      "--var", `FRONTIER_D1_API_BASE_URL:http://127.0.0.1:${LEGACY_MIGRATION_MOCK_PORT}/client/v4`,
      "--var", `GITLAB_URL:http://127.0.0.1:${LEGACY_MIGRATION_MOCK_PORT}`,
      "--var", "GITLAB_ADMIN_TOKEN:e2e-gitlab-admin",
      "--var", `SYNC_WORKER_URL:http://127.0.0.1:${SYNC_WORKER_PORT}`,
      "--var", "ENVIRONMENT:development",
    ],
    logFile: openLogFile(logFiles.identity),
    streamToParent: VERBOSE,
  })
  cleanup.push(() => identity.kill())
  abortIfWorkerDies(identity, "identity")

  // 4. Boot sync-worker. Same Hyperdrive override so sync SQL also hits Postgres.
  console.log(`${TAG}[boot 4/8] starting sync-worker on :${SYNC_WORKER_PORT}…`)
  const sync: SpawnedWorker = await spawnWranglerDev({
    cwd: SYNC_WORKER_DIR,
    port: SYNC_WORKER_PORT,
    label: "sync",
    env: { ...HYPERDRIVE_ENV },
    extraArgs: ["--persist-to", PERSIST_DIR],
    logFile: openLogFile(logFiles.sync),
    streamToParent: VERBOSE,
  })
  cleanup.push(() => sync.kill())
  abortIfWorkerDies(sync, "sync")

  // 5. Boot mock LLM (binds to an OS-assigned free port, so shards never clash).
  console.log(`${TAG}[boot 5/8] starting mock LLM…`)
  const mockLLM = new MockLLMServer()
  await mockLLM.start()
  cleanup.push(async () => mockLLM.stop())
  browserEnv.VITE_LLM_BASE_URL = mockLLM.baseUrl

  // 6. Write .env.test.local. The browser app reads VITE_AUTH_BASE for auth +
  // project data (auth.ts has NO VITE_FRONTIER_BASE fallback), so it must point
  // at the local identity worker or the app calls prod. VITE_FRONTIER_BASE is
  // kept for the completion-service mock-LLM fallback and the e2e helpers.
  //
  // Skipped when sharding: concurrent stacks would race on this one shared file,
  // and the build picks the URLs up from process.env (browserEnv) instead.
  if (!SHARDED) {
    const envFile = path.join(REPO_ROOT, ".env.test.local")
    writeFileSync(
      envFile,
      [
        `VITE_AUTH_BASE=${browserEnv.VITE_AUTH_BASE}`,
        `VITE_FRONTIER_BASE=${browserEnv.VITE_FRONTIER_BASE}`,
        `VITE_SYNC_WORKER_HOST=${browserEnv.VITE_SYNC_WORKER_HOST}`,
        `VITE_LLM_BASE_URL=${browserEnv.VITE_LLM_BASE_URL}`,
        "",
      ].join("\n"),
    )
    cleanup.push(async () => rmSync(envFile, { force: true }))
  }

  // 7. Build once, then serve via `vite preview` (static).
  //
  // Why not `vite dev`? Dev mode runs babel/react-compiler on every request,
  // keeps an HMR watcher alive, and forces re-optimize roundtrips that
  // crater CPU/RAM under E2E load. A pre-built dist is served by a plain
  // static server with ~0 ongoing CPU and ~50 MB RAM vs. several hundred MB.
  //
  // The build cost (~15-30s) pays for itself after the second spec. The backend
  // URLs are passed via env so each shard bakes its own (VITE_* process env is
  // inlined by Vite at build time and takes priority over .env files).
  console.log(`${TAG}[boot 7/8] building app for test mode (one-time, ~30s)…`)
  await runOnce("npx", ["vite", "build", "--mode", "test", "--outDir", DIST_DIR], REPO_ROOT, "build", browserEnv)

  console.log(`${TAG}[boot 8/8] starting Vite preview on :${VITE_PORT}…`)
  const vite = spawn(
    "npx",
    ["vite", "preview", "--port", String(VITE_PORT), "--strictPort", "--mode", "test", "--outDir", DIST_DIR],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...browserEnv },
    },
  )
  attachOutput(vite, "vite", openLogFile(logFiles.vite), VERBOSE)
  cleanup.push(() => killChildTree(vite))

  await waitForUrl(`http://127.0.0.1:${VITE_PORT}/`, 30_000)

  console.log(`${TAG}[boot ✓] all services up, handing off to Playwright`)
  console.log("")

  // 8. Hand off to Playwright. Forward extra CLI args after `--`.
  // The default config combines Playwright's line/GitHub reporter with the
  // heartbeat reporter. A caller may still override it explicitly.
  //
  // The config path is overridable via E2E_CONFIG so the same boot pipeline
  // can drive the recording harness (playwright.config.recordings.ts) without
  // duplicating the 8-step backend bring-up. Defaults to the web e2e config.
  const configPath = process.env.E2E_CONFIG ?? "e2e/config/playwright.config.web.ts"
  const playwrightArgs = [
    "playwright",
    "test",
    "--config",
    configPath,
  ]
  const extra = process.argv.slice(2)
  const dashDashIdx = extra.indexOf("--")
  const userArgs = dashDashIdx >= 0 ? extra.slice(dashDashIdx + 1) : []
  playwrightArgs.push(...userArgs)
  // When sharding, run this stack's slice and isolate artifacts so concurrent
  // shards don't fight over test-results/. Honor a user-supplied --shard.
  if (SHARDED) {
    const hasShard = userArgs.some((a) => a === "--shard" || a.startsWith("--shard="))
    if (!hasShard) playwrightArgs.push(`--shard=${SHARD_INDEX}/${SHARD_TOTAL}`)
    playwrightArgs.push(`--output=test-results${SUFFIX}`)
  }
  console.log(`${TAG}[run] npx ${playwrightArgs.join(" ")}`)
  // Pass the local backend URLs through to the Playwright child so test
  // helpers (seed.ts, auth.ts, AI completion spec) can read them via
  // process.env, and E2E_BASE_URL so the config points the browser at this
  // shard's Vite preview (the config defaults to :5173 otherwise).
  const pw = spawn("npx", playwrightArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ...browserEnv,
      E2E_BASE_URL: `http://127.0.0.1:${VITE_PORT}`,
      E2E_DATABASE_URL: E2E_PG_URL,
    },
  })
  pw.on("error", (error) => {
    console.error(`${TAG}[fail] could not start Playwright:`, error)
    void shutdown(1)
  })
  pw.on("exit", (code) => {
    if (code !== 0 && !VERBOSE) {
      // Test failed and worker logs are in files. Tail them so the dev
      // sees what went wrong without having to know the file paths.
      console.log(`\n${TAG}[fail] Playwright exited ${code}. Tailing worker logs:`)
      dumpLogs()
      console.log(`\n${TAG}[hint] Full logs: ${LOG_DIR}/`)
      console.log(`${TAG}[hint] Re-run with --verbose to stream live: npm run test:e2e -- --verbose`)
    }
    void shutdown(code ?? 1)
  })
}

main().catch((e) => {
  console.error(`${TAG}[e2e-up] fatal:`, e)
  void shutdown(1)
})
