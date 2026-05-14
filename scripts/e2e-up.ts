import { spawn, spawnSync } from "node:child_process"
import { existsSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs"
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
const AUTH_WORKER_DIR = path.join(REPO_ROOT, "apps/frontier-server")
const SYNC_WORKER_DIR = path.join(REPO_ROOT, "sync-worker")
const AUTH_PORT = 8787
const SYNC_WORKER_PORT = 8788
const VITE_PORT = 5173

const VERBOSE = process.env.E2E_VERBOSE === "1" || process.argv.includes("--verbose")
const LOG_DIR = path.join(REPO_ROOT, ".e2e-logs")

const cleanup: Array<() => Promise<void>> = []
const logFiles: Record<string, string> = {}

let shuttingDown = false
async function shutdown(code = 0): Promise<never> {
  if (shuttingDown) process.exit(code)
  shuttingDown = true
  console.log("\n[e2e-up] shutting down…")
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
      const r = await fetch(url)
      if (r.status < 500) return
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

function runOnce(
  cmd: string,
  args: string[],
  cwd: string,
  logLabel?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdio: ("inherit" | "ignore" | "pipe")[] =
      VERBOSE ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"]
    const c = spawn(cmd, args, { cwd, stdio })
    if (!VERBOSE && logLabel && logFiles[logLabel]) {
      const stream = openLogFile(logFiles[logLabel])
      c.stdout?.pipe(stream, { end: false })
      c.stderr?.pipe(stream, { end: false })
    } else if (!VERBOSE) {
      c.stdout?.on("data", () => {})
      c.stderr?.on("data", () => {})
    }
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exit ${code}`))))
  })
}

function dumpLogs(tailLines = 80): void {
  for (const [label, file] of Object.entries(logFiles)) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, "utf-8").trimEnd().split("\n")
    const tail = lines.slice(-tailLines)
    process.stderr.write(`\n──── ${label} (last ${tail.length} lines of ${file}) ────\n`)
    process.stderr.write(tail.join("\n") + "\n")
  }
}

async function freePort(port: number): Promise<void> {
  const pidsRaw = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).stdout || ""
  const pids = pidsRaw.split("\n").filter(Boolean)
  if (pids.length === 0) return
  console.log(`[e2e-up] freeing port ${port} (held by ${pids.join(", ")})…`)
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

async function main(): Promise<void> {
  if (!existsSync(AUTH_WORKER_DIR)) {
    console.error(`[e2e-up] frontier-server not found at ${AUTH_WORKER_DIR}`)
    process.exit(1)
  }
  if (!existsSync(SYNC_WORKER_DIR)) {
    console.error(`[e2e-up] sync-worker not found at ${SYNC_WORKER_DIR}`)
    process.exit(1)
  }

  // 0. Free our managed ports — survives stale processes from a prior aborted run.
  await freePort(AUTH_PORT)
  await freePort(SYNC_WORKER_PORT)
  await freePort(VITE_PORT)

  // 1. Reset wrangler local state so each E2E run starts from a known schema.
  mkdirSync(LOG_DIR, { recursive: true })
  logFiles.auth = path.join(LOG_DIR, "auth.log")
  logFiles.sync = path.join(LOG_DIR, "sync.log")
  logFiles.vite = path.join(LOG_DIR, "vite.log")
  logFiles.migrations = path.join(LOG_DIR, "migrations.log")
  logFiles.build = path.join(LOG_DIR, "build.log")
  console.log(`[boot 1/6] resetting wrangler local state… (logs: ${LOG_DIR}/)`)
  rmSync(path.join(AUTH_WORKER_DIR, ".wrangler"), { recursive: true, force: true })
  rmSync(path.join(SYNC_WORKER_DIR, ".wrangler"), { recursive: true, force: true })

  // 2. Apply the codex schema. Single D1 (`codex`) holds everything —
  //    identity, orgs, projects, members, invites, plus the file/cell
  //    projections sync-worker writes. frontier-server owns the migrations
  //    dir; in prod its deploy applies them. For local E2E each worker
  //    keeps its own .wrangler state, so we apply twice:
  //    (a) via `migrations apply` from frontier-server (tracked in d1_migrations)
  //    (b) via `d1 execute --file` from sync-worker (raw apply to its sqlite)
  console.log("[boot 2/6] applying codex schema (both workers' local D1)…")
  await runOnce(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "aquilla-db", "--local"],
    AUTH_WORKER_DIR,
    "migrations",
  )
  const migrationsDir = path.join(AUTH_WORKER_DIR, "migrations")
  const { readdirSync } = await import("node:fs")
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
  for (const m of migrationFiles) {
    await runOnce(
      "npx",
      [
        "wrangler", "d1", "execute", "aquilla-db", "--local",
        `--file=${path.join(migrationsDir, m)}`,
      ],
      SYNC_WORKER_DIR,
      "migrations",
    )
  }

  // 4. Boot frontier-server. WRANGLER_LOCAL=1 enables /__test__/reset.
  console.log(`[boot 3/6] starting frontier-server on :${AUTH_PORT}…`)
  const auth: SpawnedWorker = await spawnWranglerDev({
    cwd: AUTH_WORKER_DIR,
    port: AUTH_PORT,
    label: "auth",
    env: {
      WRANGLER_LOCAL: "1",
      // Minimum viable secrets for the routes E2E exercises. These match
      // what frontier-server reads from `env`; SYNC_SECRET_KEY is the shared
      // key for sync-token + sync-worker admin authorization.
      SECRET_KEY: "test-secret-key-do-not-use-in-prod",
      SYNC_SECRET_KEY: "test-sync-secret-key",
      SYNC_WORKER_URL: `http://127.0.0.1:${SYNC_WORKER_PORT}`,
    },
    logFile: openLogFile(logFiles.auth),
    streamToParent: VERBOSE,
  })
  cleanup.push(() => auth.kill())

  // 5. Boot sync-worker.
  console.log(`[boot 4/6] starting sync-worker on :${SYNC_WORKER_PORT}…`)
  const sync: SpawnedWorker = await spawnWranglerDev({
    cwd: SYNC_WORKER_DIR,
    port: SYNC_WORKER_PORT,
    label: "sync",
    env: {
      SYNC_SECRET_KEY: "test-sync-secret-key",
    },
    logFile: openLogFile(logFiles.sync),
    streamToParent: VERBOSE,
  })
  cleanup.push(() => sync.kill())

  // 6. Mock LLM (chat-worker stand-in for /api/v1/chat/completions).
  console.log("[boot 5/6] starting mock LLM…")
  const mockLLM = new MockLLMServer()
  await mockLLM.start()
  cleanup.push(async () => mockLLM.stop())

  // 7. Build the test bundle. VITE_AUTH_BASE is the canonical base for every
  //    codex-web → backend call now; VITE_FRONTIER_BASE is gone.
  const envFile = path.join(REPO_ROOT, ".env.test.local")
  writeFileSync(
    envFile,
    [
      `VITE_AUTH_BASE=http://127.0.0.1:${AUTH_PORT}`,
      `VITE_SYNC_WORKER_HOST=127.0.0.1:${SYNC_WORKER_PORT}`,
      `VITE_LLM_BASE_URL=${mockLLM.baseUrl}`,
      "",
    ].join("\n"),
  )
  cleanup.push(async () => rmSync(envFile, { force: true }))

  console.log("[boot 6/6] building app for test mode (one-time, ~30s)…")
  await runOnce("npx", ["vite", "build", "--mode", "test"], REPO_ROOT, "build")

  console.log(`[boot ✓] starting Vite preview on :${VITE_PORT}…`)
  const vite = spawn(
    "npx",
    ["vite", "preview", "--port", String(VITE_PORT), "--strictPort", "--mode", "test"],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  )
  attachOutput(vite, "vite", openLogFile(logFiles.vite), VERBOSE)
  cleanup.push(() => killChildTree(vite))

  await waitForUrl(`http://127.0.0.1:${VITE_PORT}/`, 30_000)

  console.log("[boot ✓] all services up, handing off to Playwright")
  console.log("")

  const playwrightArgs = [
    "playwright",
    "test",
    "--config",
    "e2e/config/playwright.config.web.ts",
  ]
  const extra = process.argv.slice(2)
  const dashDashIdx = extra.indexOf("--")
  const userArgs = dashDashIdx >= 0 ? extra.slice(dashDashIdx + 1) : []
  const userSpecifiedReporter = userArgs.some((a) => a === "--reporter" || a.startsWith("--reporter="))
  if (!userSpecifiedReporter && !process.env.CI) {
    playwrightArgs.push("--reporter=line")
  }
  playwrightArgs.push(...userArgs)
  console.log(`[run] npx ${playwrightArgs.join(" ")}`)
  // VITE_AUTH_BASE handles the Vite/browser side via .env.test.local; this
  // env handles the Playwright/node side so test helpers (seed.ts,
  // frontier-api.ts) talk to frontier-server directly.
  const pw = spawn("npx", playwrightArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_AUTH_BASE: `http://127.0.0.1:${AUTH_PORT}`,
      VITE_SYNC_WORKER_HOST: `127.0.0.1:${SYNC_WORKER_PORT}`,
      VITE_LLM_BASE_URL: mockLLM.baseUrl,
    },
  })
  pw.on("exit", (code) => {
    if (code !== 0 && !VERBOSE) {
      console.log(`\n[fail] Playwright exited ${code}. Tailing worker logs:`)
      dumpLogs()
      console.log(`\n[hint] Full logs: ${LOG_DIR}/`)
      console.log(`[hint] Re-run with --verbose to stream live: npm run test:e2e -- --verbose`)
    }
    void shutdown(code ?? 1)
  })
}

main().catch((e) => {
  console.error("[e2e-up] fatal:", e)
  void shutdown(1)
})
