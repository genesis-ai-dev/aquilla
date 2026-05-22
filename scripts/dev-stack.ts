// Local dev orchestrator.
//
// `pnpm dev` calls this. It boots the workspace SPA's backend Workers
// locally via `wrangler dev --local` and starts the Vite dev server with
// `VITE_AUTH_BASE` / `VITE_SYNC_WORKER_HOST` (and optionally
// `VITE_CHAT_BASE`) pointed at the local Worker ports. Nothing in this
// script touches wrangler.toml, CI workflows, or remote resources — local
// iteration only.
//
// What runs:
//   * auth-worker   on 127.0.0.1:8788       (always)
//   * sync-worker   on 127.0.0.1:8789       (always)
//   * chat-worker   on 127.0.0.1:8790       (only with --chat)
//   * Vite dev      on :5173                (the existing `vite` command)
//
// Wrangler's local D1 / R2 / DO state is persisted to a single shared
// `<repo>/.wrangler-dev-state/` directory so auth-worker (writer for users
// /orgs/projects) and sync-worker (writer for files/cells/events) see the
// same `aquilla-db` rows — without `--persist-to`, each cwd gets its own
// isolated sqlite and the two Workers drift apart immediately.
//
// First-run side effects (idempotent):
//   * Copies each backend's `.dev.vars.example` → `.dev.vars` if missing.
//   * Applies auth-worker's D1 migrations to the local sqlite.
// Both steps are safe to run on every boot.
//
// Lifecycle: writes a managed `.env.development.local` so the Vite client
// bundle picks up the local Worker URLs, then deletes it on shutdown so
// `pnpm dev:vite` (the bare-Vite escape hatch) returns to whatever the
// user has in `.env.local`.
//
// Flags:
//   --chat       also boot chat-worker (needs OPENROUTER_API_KEY in .dev.vars)
//   --no-sync    skip sync-worker (rare; some flows need only auth)
//   --vite-port  override the Vite port (default 5173)
//   --verbose    stream each Worker's stdout/stderr to this terminal
//
// Stop with Ctrl+C. The cleanup handler kills every spawned child tree
// and removes `.env.development.local`.

import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  spawnWranglerDev,
  killChildTree,
  attachOutput,
  openLogFile,
  type SpawnedWorker,
} from "./lib/spawn-worker"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

const IDENTITY_DIR = path.join(REPO_ROOT, "auth-worker")
const SYNC_DIR = path.join(REPO_ROOT, "sync-worker")
const CHAT_DIR = path.join(REPO_ROOT, "chat-worker")

// Shared wrangler state so auth-worker + sync-worker read each other's writes
// to aquilla-db. Wrangler defaults to `<cwd>/.wrangler/state` which would
// give every worker its own sqlite — the projects auth-worker creates would
// be invisible to sync-worker.
const PERSIST_DIR = path.join(REPO_ROOT, ".wrangler-dev-state")
const LOG_DIR = path.join(REPO_ROOT, ".dev-stack-logs")

const IDENTITY_PORT = 8788
const SYNC_PORT = 8789
const CHAT_PORT = 8790
const DEFAULT_VITE_PORT = 5173

const args = process.argv.slice(2)
const WITH_CHAT = args.includes("--chat")
const WITHOUT_SYNC = args.includes("--no-sync")
const VERBOSE = args.includes("--verbose") || process.env.DEV_STACK_VERBOSE === "1"
const VITE_PORT_ARG = args.find((a) => a.startsWith("--vite-port="))
const VITE_PORT = VITE_PORT_ARG
  ? Number(VITE_PORT_ARG.split("=")[1])
  : DEFAULT_VITE_PORT

const MANAGED_ENV_FILE = path.join(REPO_ROOT, ".env.development.local")
const ENV_FILE_HEADER =
  "# Managed by scripts/dev-stack.ts — overwritten on `pnpm dev`, deleted on clean shutdown.\n" +
  "# Do not edit by hand; put persistent local overrides in `.env.local` instead.\n"

// ---------------------------------------------------------------------------
// Shutdown plumbing
// ---------------------------------------------------------------------------

const cleanup: Array<() => Promise<void> | void> = []
let shuttingDown = false

async function shutdown(code = 0): Promise<never> {
  if (shuttingDown) process.exit(code)
  shuttingDown = true
  console.log("\n[dev-stack] shutting down…")
  for (const fn of [...cleanup].reverse()) {
    try {
      await fn()
    } catch (err) {
      console.error("[dev-stack] cleanup error:", err)
    }
  }
  process.exit(code)
}

process.on("SIGINT", () => {
  void shutdown(130)
})
process.on("SIGTERM", () => {
  void shutdown(143)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDevVars(appDir: string, label: string): void {
  const target = path.join(appDir, ".dev.vars")
  const source = path.join(appDir, ".dev.vars.example")
  if (existsSync(target)) return
  if (!existsSync(source)) {
    console.warn(
      `[dev-stack] ${label}: no .dev.vars and no .dev.vars.example — the worker may fail to boot.`,
    )
    return
  }
  copyFileSync(source, target)
  console.log(
    `[dev-stack] ${label}: created .dev.vars from .dev.vars.example (edit ${path.relative(REPO_ROOT, target)} to customise).`,
  )
}

async function freePort(port: number): Promise<void> {
  const pidsRaw =
    spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).stdout || ""
  const pids = pidsRaw.split("\n").filter(Boolean)
  if (pids.length === 0) return
  console.log(
    `[dev-stack] freeing port ${port} (held by ${pids.join(", ")})…`,
  )
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM")
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 400))
  const remaining = (
    spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).stdout || ""
  )
    .split("\n")
    .filter(Boolean)
  for (const pid of remaining) {
    try {
      process.kill(Number(pid), "SIGKILL")
    } catch {
      // already gone
    }
  }
}

function applyIdentityMigrations(): void {
  // `wrangler d1 migrations apply` is idempotent — it tracks applied
  // migrations in a `d1_migrations` row and skips already-applied files.
  // Running it on every boot keeps the local sqlite in sync when the
  // user pulls new migration files.
  console.log("[dev-stack] applying identity migrations to local D1…")
  const res = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "aquilla-db",
      "--local",
      "--persist-to",
      PERSIST_DIR,
    ],
    {
      cwd: IDENTITY_DIR,
      stdio: VERBOSE ? "inherit" : ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  )
  if (res.status !== 0) {
    if (!VERBOSE) {
      process.stderr.write(res.stdout || "")
      process.stderr.write(res.stderr || "")
    }
    // Don't throw — migrations may fail if auth-worker/migrations/ is still
    // empty (Phase E not yet landed). Warn and continue so the rest of the
    // dev stack still boots.
    console.warn("[dev-stack] migration apply exited non-zero — continuing (Phase E may not be landed yet)")
  }
}

function writeManagedEnvFile(): void {
  const lines = [
    ENV_FILE_HEADER,
    `VITE_AUTH_BASE=http://127.0.0.1:${IDENTITY_PORT}`,
    WITHOUT_SYNC
      ? `# VITE_SYNC_WORKER_HOST omitted — booted with --no-sync.`
      : `VITE_SYNC_WORKER_HOST=127.0.0.1:${SYNC_PORT}`,
    WITH_CHAT
      ? `VITE_CHAT_BASE=http://127.0.0.1:${CHAT_PORT}`
      : `# VITE_CHAT_BASE omitted — pass --chat to also boot chat-worker.`,
    "",
  ]
  writeFileSync(MANAGED_ENV_FILE, lines.join("\n"))
  cleanup.push(() => {
    rmSync(MANAGED_ENV_FILE, { force: true })
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(IDENTITY_DIR)) {
    console.error(`[dev-stack] auth-worker not found at ${IDENTITY_DIR}`)
    process.exit(1)
  }
  if (!existsSync(SYNC_DIR) && !WITHOUT_SYNC) {
    console.error(`[dev-stack] sync-worker not found at ${SYNC_DIR}`)
    process.exit(1)
  }

  mkdirSync(PERSIST_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })

  // First-run prerequisites (idempotent).
  ensureDevVars(IDENTITY_DIR, "identity")
  if (!WITHOUT_SYNC) ensureDevVars(SYNC_DIR, "sync")
  if (WITH_CHAT) ensureDevVars(CHAT_DIR, "chat")

  // Free any ports left behind by an aborted prior run.
  await freePort(IDENTITY_PORT)
  if (!WITHOUT_SYNC) await freePort(SYNC_PORT)
  if (WITH_CHAT) await freePort(CHAT_PORT)
  await freePort(VITE_PORT)

  applyIdentityMigrations()

  console.log(`[dev-stack] starting identity (auth-worker) on :${IDENTITY_PORT}…`)
  const identity: SpawnedWorker = await spawnWranglerDev({
    cwd: IDENTITY_DIR,
    port: IDENTITY_PORT,
    label: "identity",
    env: {
      // identity calls the sync worker for archive notifications etc.
      // Point that at the local sync (not the prod workers.dev URL from
      // wrangler.toml [vars]).
      SYNC_WORKER_URL: `http://127.0.0.1:${SYNC_PORT}`,
      // Loud env tag so logs make it obvious this is the local dev stack.
      ENVIRONMENT: "development",
    },
    extraArgs: ["--persist-to", PERSIST_DIR],
    logFile: openLogFile(path.join(LOG_DIR, "identity.log")),
    streamToParent: VERBOSE,
  })
  cleanup.push(() => identity.kill())

  let sync: SpawnedWorker | null = null
  if (!WITHOUT_SYNC) {
    console.log(`[dev-stack] starting sync-worker on :${SYNC_PORT}…`)
    sync = await spawnWranglerDev({
      cwd: SYNC_DIR,
      port: SYNC_PORT,
      label: "sync",
      env: {
        // .dev.vars already sets SYNC_SECRET_KEY + ALLOW_UNAUTHENTICATED;
        // pass nothing extra so we don't shadow them via --var.
      },
      extraArgs: ["--persist-to", PERSIST_DIR],
      logFile: openLogFile(path.join(LOG_DIR, "sync.log")),
      streamToParent: VERBOSE,
    })
    cleanup.push(() => sync!.kill())
  }

  let chat: SpawnedWorker | null = null
  if (WITH_CHAT) {
    console.log(`[dev-stack] starting chat-worker on :${CHAT_PORT}…`)
    chat = await spawnWranglerDev({
      cwd: CHAT_DIR,
      port: CHAT_PORT,
      label: "chat",
      env: {
        ENVIRONMENT: "development",
      },
      extraArgs: ["--persist-to", PERSIST_DIR],
      logFile: openLogFile(path.join(LOG_DIR, "chat.log")),
      streamToParent: VERBOSE,
    })
    cleanup.push(() => chat!.kill())
  }

  // Write `.env.development.local` AFTER the Workers are reachable so a
  // pre-existing file from a previous crashed run doesn't leak local
  // ports to a Vite-only `pnpm dev:vite` invocation.
  writeManagedEnvFile()

  // Boot Vite with the existing dev command. We invoke `vite` directly
  // rather than `pnpm dev:vite` to avoid recursing back into this script.
  console.log(`[dev-stack] starting Vite on :${VITE_PORT}…`)
  const vite = spawn(
    "npx",
    [
      "vite",
      "--port",
      String(VITE_PORT),
      "--strictPort",
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  )
  attachOutput(
    vite,
    "vite",
    openLogFile(path.join(LOG_DIR, "vite.log")),
    // Vite output is the user-facing signal that everything is up
    // ("VITE ready", URL, HMR updates), so always stream it to the
    // parent — even without --verbose.
    true,
  )
  cleanup.push(() => killChildTree(vite))

  // If any child dies unexpectedly, tear the whole stack down.
  const watchExit = (
    sw: SpawnedWorker | null,
    label: string,
  ): void => {
    if (!sw) return
    sw.child.once("exit", (code, signal) => {
      if (shuttingDown) return
      console.error(
        `[dev-stack] ${label} exited unexpectedly (code=${code}, signal=${signal}) — shutting stack down`,
      )
      void shutdown(1)
    })
  }
  watchExit(identity, "identity")
  watchExit(sync, "sync")
  watchExit(chat, "chat")
  vite.once("exit", (code, signal) => {
    if (shuttingDown) return
    console.error(
      `[dev-stack] vite exited unexpectedly (code=${code}, signal=${signal}) — shutting stack down`,
    )
    void shutdown(1)
  })

  const banner = [
    "",
    "[dev-stack] all services up",
    `         web      -> http://127.0.0.1:${VITE_PORT}/`,
    `         identity -> http://127.0.0.1:${IDENTITY_PORT}/  (logs: ${path.relative(REPO_ROOT, path.join(LOG_DIR, "identity.log"))})`,
    sync
      ? `         sync     -> http://127.0.0.1:${SYNC_PORT}/  (logs: ${path.relative(REPO_ROOT, path.join(LOG_DIR, "sync.log"))})`
      : `         sync     -> skipped (--no-sync)`,
    chat
      ? `         chat     -> http://127.0.0.1:${CHAT_PORT}/  (logs: ${path.relative(REPO_ROOT, path.join(LOG_DIR, "chat.log"))})`
      : `         chat     -> skipped (pass --chat to boot)`,
    `         state    -> ${path.relative(REPO_ROOT, PERSIST_DIR)}/  (delete to reset local D1)`,
    "[dev-stack] press Ctrl+C to stop",
    "",
  ]
  console.log(banner.join("\n"))
}

main().catch((err) => {
  console.error("[dev-stack] boot failed:", err)
  void shutdown(1)
})
