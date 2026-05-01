import { spawn, spawnSync } from "node:child_process"
import { existsSync, writeFileSync, rmSync, readdirSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
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
const FRONTIER_SERVER_DIR =
  process.env.FRONTIER_SERVER_DIR ?? path.join(homedir(), "frontierrnd/frontier-server")
const SYNC_WORKER_DIR = path.join(REPO_ROOT, "sync-worker")
const FRONTIER_PORT = 8787
const SYNC_WORKER_PORT = 8788
const VITE_PORT = 5173

const VERBOSE = process.env.E2E_VERBOSE === "1" || process.argv.includes("--verbose")
const LOG_DIR = path.join(REPO_ROOT, ".e2e-logs")

const cleanup: Array<() => Promise<void>> = []
const logFiles: Record<string, string> = {}

let shuttingDown = false
async function shutdown(code = 0): Promise<never> {
  if (shuttingDown) {
    // A second SIGINT during teardown — give up on graceful and exit hard.
    process.exit(code)
  }
  shuttingDown = true
  console.log("\n[e2e-up] shutting down…")
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
      const r = await fetch(url)
      if (r.status < 500) return
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}

/** Run a command and either inherit stdio (verbose) or pipe to /dev/null
 * (quiet). Output goes to the log file in quiet mode if `logLabel` is set. */
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
      // Drain so the child doesn't block on full pipes.
      c.stdout?.on("data", () => {})
      c.stderr?.on("data", () => {})
    }
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exit ${code}`))))
  })
}

/** Print the last N lines of each known log file to stderr. Used when a
 * subcommand fails so the developer can see what went wrong without
 * needing to know the log paths. */
function dumpLogs(tailLines = 80): void {
  for (const [label, file] of Object.entries(logFiles)) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, "utf-8").trimEnd().split("\n")
    const tail = lines.slice(-tailLines)
    process.stderr.write(`\n──── ${label} (last ${tail.length} lines of ${file}) ────\n`)
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
  if (!existsSync(FRONTIER_SERVER_DIR)) {
    console.error(`[e2e-up] frontier-server not found at ${FRONTIER_SERVER_DIR}`)
    console.error(`[e2e-up] set FRONTIER_SERVER_DIR or clone the repo`)
    process.exit(1)
  }
  if (!existsSync(SYNC_WORKER_DIR)) {
    console.error(`[e2e-up] sync-worker not found at ${SYNC_WORKER_DIR}`)
    process.exit(1)
  }

  // 0. Free our managed ports — survives stale processes from a prior aborted run.
  await freePort(FRONTIER_PORT)
  await freePort(SYNC_WORKER_PORT)
  await freePort(VITE_PORT)

  // Set up the log dir. Worker stdout/stderr is piped here in non-verbose
  // mode so the developer's terminal stays clean. On test failure we tail
  // these files so problems are still discoverable.
  mkdirSync(LOG_DIR, { recursive: true })
  logFiles.frontier = path.join(LOG_DIR, "frontier.log")
  logFiles.sync = path.join(LOG_DIR, "sync.log")
  logFiles.vite = path.join(LOG_DIR, "vite.log")
  logFiles.migrations = path.join(LOG_DIR, "migrations.log")
  logFiles.build = path.join(LOG_DIR, "build.log")
  console.log(`[boot 1/8] resetting wrangler local state… (logs: ${LOG_DIR}/)`)
  rmSync(path.join(FRONTIER_SERVER_DIR, ".wrangler"), { recursive: true, force: true })
  rmSync(path.join(SYNC_WORKER_DIR, ".wrangler"), { recursive: true, force: true })

  // 2. Apply frontier-db-v2 migrations (auth, orgs, members, sync-token).
  console.log("[boot 2/8] applying frontier-db-v2 migrations…")
  await runOnce(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "frontier-db-v2", "--local"],
    FRONTIER_SERVER_DIR,
    "migrations",
  )

  // 2b. Apply codex-db schema to BOTH workers' local D1.
  //
  // codex-db is shared (frontier-server reads, sync-worker writes the
  // `files`/`cells` projections on Y.Doc onSave). frontier-server owns the
  // migrations (cloudflare/codex_migrations). sync-worker doesn't list a
  // migrations_dir for it, so we apply by piping each .sql file to
  // `wrangler d1 execute` against the sync-worker's local D1.
  console.log("[boot 3/8] applying codex-db schema (both workers)…")
  await runOnce(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "codex-db", "--local"],
    FRONTIER_SERVER_DIR,
    "migrations",
  )
  const codexMigrationsDir = path.join(FRONTIER_SERVER_DIR, "cloudflare/codex_migrations")
  const codexMigrations = readdirSync(codexMigrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
  for (const m of codexMigrations) {
    await runOnce(
      "npx",
      ["wrangler", "d1", "execute", "codex-db", "--local", `--file=${path.join(codexMigrationsDir, m)}`],
      SYNC_WORKER_DIR,
      "migrations",
    )
  }

  // 3. Boot frontier-server
  console.log(`[boot 4/8] starting frontier-server on :${FRONTIER_PORT}…`)
  const frontier: SpawnedWorker = await spawnWranglerDev({
    cwd: FRONTIER_SERVER_DIR,
    port: FRONTIER_PORT,
    label: "frontier",
    env: { WRANGLER_LOCAL: "1" },
    logFile: openLogFile(logFiles.frontier),
    streamToParent: VERBOSE,
  })
  cleanup.push(() => frontier.kill())

  // 4. Boot sync-worker
  console.log(`[boot 5/8] starting sync-worker on :${SYNC_WORKER_PORT}…`)
  const sync: SpawnedWorker = await spawnWranglerDev({
    cwd: SYNC_WORKER_DIR,
    port: SYNC_WORKER_PORT,
    label: "sync",
    logFile: openLogFile(logFiles.sync),
    streamToParent: VERBOSE,
  })
  cleanup.push(() => sync.kill())

  // 5. Boot mock LLM
  console.log("[boot 6/8] starting mock LLM…")
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

  // 7. Build once, then serve via `vite preview` (static).
  //
  // Why not `vite dev`? Dev mode runs babel/react-compiler on every request,
  // keeps an HMR watcher alive, and forces re-optimize roundtrips that
  // crater CPU/RAM under E2E load. A pre-built dist is served by a plain
  // static server with ~0 ongoing CPU and ~50 MB RAM vs. several hundred MB.
  //
  // The build cost (~15-30s) pays for itself after the second spec.
  console.log("[boot 7/8] building app for test mode (one-time, ~30s)…")
  await runOnce("npx", ["vite", "build", "--mode", "test"], REPO_ROOT, "build")

  console.log(`[boot 8/8] starting Vite preview on :${VITE_PORT}…`)
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

  // 8. Hand off to Playwright. Forward extra CLI args after `--`.
  // Default to the `line` reporter for live one-line progress; user can
  // override via `npm run test:e2e -- --reporter=list` etc.
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
  // Pass the local backend URLs through to the Playwright child so test
  // helpers (seed.ts, auth.ts, AI completion spec) can read them via
  // process.env. .env.test.local handles the Vite/browser side; this
  // handles the test-runner/node side.
  const pw = spawn("npx", playwrightArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_FRONTIER_BASE: `http://127.0.0.1:${FRONTIER_PORT}`,
      VITE_SYNC_WORKER_HOST: `127.0.0.1:${SYNC_WORKER_PORT}`,
      VITE_LLM_BASE_URL: mockLLM.baseUrl,
    },
  })
  pw.on("exit", (code) => {
    if (code !== 0 && !VERBOSE) {
      // Test failed and worker logs are in files. Tail them so the dev
      // sees what went wrong without having to know the file paths.
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
