// Local dev orchestrator.
//
// `pnpm dev` calls this. It boots the workspace SPA's backend Workers
// locally via `wrangler dev --local` and starts the Vite dev server with
// `VITE_AUTH_BASE` / `VITE_SYNC_WORKER_HOST` / `VITE_CHAT_BASE` pointed at
// the local Worker ports. Nothing in this script touches wrangler.toml,
// CI workflows, or remote resources — local iteration only.
//
// What runs:
//   * auth-worker   on 127.0.0.1:8788       (always — also serves /chat
//                                            since the chat-worker was folded
//                                            in on 2026-05-26)
//   * sync-worker   on 127.0.0.1:8789       (always)
//   * Vite dev      on :5173                (the existing `vite` command)
//
// Wrangler's local R2 / DO state is persisted to a single shared
// `<repo>/.wrangler-dev-state/` directory. Application data lives in the
// local Postgres instance below; D1 is no longer part of the runtime stack.
//
// First-run side effects (idempotent):
//   * Copies each backend's `.dev.vars.example` → `.dev.vars` if missing.
//   * Loads db/postgres/schema.sql into the local Postgres on first create,
//     and on every later boot reconciles drift additively (CREATE TABLE /
//     ADD COLUMN IF NOT EXISTS for anything schema.sql has that the live
//     container lacks — never drops data).
// All steps are safe to run on every boot.
//
// Lifecycle: writes a managed `.env.development.local` so the Vite client
// bundle picks up the local Worker URLs, then deletes it on shutdown so
// `pnpm dev:vite` (the bare-Vite escape hatch) returns to whatever the
// user has in `.env.local`.
//
// Flags:
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
  readFileSync,
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
import {
  finalizeArtifactBindingSchema,
  finalizeSourceBlobSchema,
  prepareArtifactBindingSchema,
} from "./dev-stack-artifact-schema"
import { parsePgSchema } from "./dev-stack-schema-parser"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

const IDENTITY_DIR = path.join(REPO_ROOT, "auth-worker")
const SYNC_DIR = path.join(REPO_ROOT, "sync-worker")

// Shared wrangler state so auth-worker + sync-worker read each other's writes
// to aquilla-db. Wrangler defaults to `<cwd>/.wrangler/state` which would
// give every worker its own sqlite — the projects auth-worker creates would
// be invisible to sync-worker.
const PERSIST_DIR = path.join(REPO_ROOT, ".wrangler-dev-state")
const LOG_DIR = path.join(REPO_ROOT, ".dev-stack-logs")

// Ports are env-overridable so a second stack can coexist with another dev-stack
// (e.g. a parallel worktree) without freePort() evicting the other's workers.
const IDENTITY_PORT = Number(process.env.DEV_STACK_IDENTITY_PORT) || 8788
const SYNC_PORT = Number(process.env.DEV_STACK_SYNC_PORT) || 8789
const DEFAULT_VITE_PORT = 5173
// Scripted OpenRouter mock (scripts/mock-openrouter.ts) — booted when the
// identity worker has no real OPENROUTER_API_KEY, so the agent/chat paths
// work end-to-end locally with a deterministic model.
const MOCK_LLM_PORT = Number(process.env.DEV_STACK_MOCK_LLM_PORT) || 9456

// D1→Neon migration (AQU-146): auth-worker + sync-worker bind HYPERDRIVE and
// swap AQUILLA_PG for a Postgres shim (see auth-worker/src/index.ts). Under
// `wrangler dev --local`, Hyperdrive is emulated against a real Postgres given
// by WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>. Without it the
// worker refuses to boot. We back that with a throwaway local Postgres so the
// dev stack works with no Neon creds and no risk to live data.
//
// Resolution: an explicit connection string in the environment wins (point at
// your own Postgres / a Neon *branch* — never prod). Otherwise we manage a
// local Docker container with the default below.
const SCHEMA_FILE = path.join(REPO_ROOT, "db", "postgres", "schema.sql")
const LOCAL_PG_CONTAINER = "aquilla-dev-pg"
const DEFAULT_LOCAL_PG_URL =
  "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
const EXTERNAL_PG_URL =
  process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ||
  process.env.LOCAL_PG_URL ||
  ""
const PG_URL = EXTERNAL_PG_URL || DEFAULT_LOCAL_PG_URL
// Only manage a Docker container when falling back to the default URL.
const MANAGE_PG_CONTAINER = !EXTERNAL_PG_URL

const args = process.argv.slice(2)
const WITHOUT_SYNC = args.includes("--no-sync")
const VERBOSE = args.includes("--verbose") || process.env.DEV_STACK_VERBOSE === "1"
const VITE_PORT_ARG = args.find((a) => a.startsWith("--vite-port="))
// Also accept bare `--port <N>` forwarded by `npm run dev -- --port 1420`
const PORT_IDX = args.indexOf("--port")
const VITE_PORT = VITE_PORT_ARG
  ? Number(VITE_PORT_ARG.split("=")[1])
  : PORT_IDX !== -1 && args[PORT_IDX + 1]
    ? Number(args[PORT_IDX + 1])
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

/** True when auth-worker/.dev.vars carries a real (non-mock) OpenRouter key. */
function identityHasRealOpenRouterKey(): boolean {
  const p = path.join(IDENTITY_DIR, ".dev.vars")
  if (!existsSync(p)) return false
  const m = readFileSync(p, "utf8").match(/^OPENROUTER_API_KEY\s*=\s*"?([^"\n]*)"?\s*$/m)
  const key = m?.[1]?.trim() ?? ""
  return key !== "" && key !== "mock"
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

/**
 * Make a local Postgres reachable at PG_URL with the schema loaded, so the
 * HYPERDRIVE-bound workers can boot. When MANAGE_PG_CONTAINER, start (or run) a
 * throwaway Docker postgres container; otherwise assume the user-supplied URL is
 * already serving and just ensure the schema. Idempotent on every boot.
 */
async function ensureLocalPostgres(): Promise<void> {
  if (MANAGE_PG_CONTAINER) {
    if (!hasDocker()) {
      throw new Error(
        "[dev-stack] Docker is required to run the local Postgres for Hyperdrive.\n" +
          "  Either start Docker Desktop, or set a connection string yourself:\n" +
          "  export LOCAL_PG_URL=postgresql://user:pass@host:5432/db   (a local PG or a Neon *branch* — never prod)",
      )
    }
    startLocalPgContainer()
  }
  await waitForPostgres(PG_URL)
  await ensurePgSchema(PG_URL)
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
}

function startLocalPgContainer(): void {
  const exists =
    (
      spawnSync(
        "docker",
        ["ps", "-aq", "--filter", `name=^/${LOCAL_PG_CONTAINER}$`],
        { encoding: "utf8" },
      ).stdout || ""
    ).trim() !== ""
  if (exists) {
    console.log(`[dev-stack] starting Postgres container ${LOCAL_PG_CONTAINER}…`)
    spawnSync("docker", ["start", LOCAL_PG_CONTAINER], { stdio: "ignore" })
    return
  }
  console.log(`[dev-stack] creating Postgres container ${LOCAL_PG_CONTAINER}…`)
  const res = spawnSync(
    "docker",
    [
      "run", "-d",
      "--name", LOCAL_PG_CONTAINER,
      "-e", "POSTGRES_USER=aquilla",
      "-e", "POSTGRES_PASSWORD=aquilla",
      "-e", "POSTGRES_DB=aquilla_dev",
      "-p", "5432:5432",
      "postgres:16",
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  )
  if (res.status !== 0) {
    throw new Error(
      `[dev-stack] failed to start Postgres container:\n${res.stderr || res.stdout}`,
    )
  }
}

async function waitForPostgres(url: string): Promise<void> {
  const { Client } = await import("pg")
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < 30_000) {
    const client = new Client({ connectionString: url })
    try {
      await client.connect()
      await client.query("select 1")
      await client.end()
      return
    } catch (err) {
      lastErr = err
      try { await client.end() } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`[dev-stack] Postgres at ${url} never became reachable: ${String(lastErr)}`)
}

async function ensurePgSchema(url: string): Promise<void> {
  const { Client } = await import("pg")
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { readFileSync } = await import("node:fs")
    const schemaSql = readFileSync(SCHEMA_FILE, "utf8")
    const { rows } = await client.query(
      "select to_regclass('public.users') as t",
    )
    if (!rows[0]?.t) {
      console.log("[dev-stack] loading Postgres schema (db/postgres/schema.sql)…")
      await client.query(schemaSql)
      return
    }
    // Schema already present: a long-lived container only ever saw the
    // schema.sql that existed when it was first created, so it drifts behind
    // as new tables/columns land (e.g. project_seq_counters, cells.ai_drafted
    // — observed 2026-06-11 as column-not-found 500s). Patch additively.
    await reconcilePgSchema(client, schemaSql)
  } finally {
    await client.end()
  }
}

function backfillMissingLocalProgress(): void {
  const result = spawnSync(
    "npx",
    ["tsx", "scripts/neon-backfill-progress.ts", "--missing-only"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, AQUILLA_DATABASE_URL: PG_URL },
      encoding: "utf8",
      stdio: VERBOSE ? "inherit" : ["ignore", "pipe", "pipe"],
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `[dev-stack] local progress backfill failed:\n${result.stderr || result.stdout}`,
    )
  }
  const output = result.stdout?.trim()
  if (output) console.log(`[dev-stack] ${output.replace(/\n/g, "\n[dev-stack] ")}`)
}

/**
 * Additive-only drift repair: create tables (plus their indexes) and add
 * columns that schema.sql has but the live container lacks. Never drops or
 * rewrites anything, so it's safe on every boot.
 */
async function reconcilePgSchema(
  client: import("pg").Client,
  schemaSql: string,
): Promise<void> {
  const { tables, indexesByTable } = parsePgSchema(schemaSql)
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`,
  )
  const live = new Map<string, Set<string>>()
  for (const r of rows as { table_name: string; column_name: string }[]) {
    if (!live.has(r.table_name)) live.set(r.table_name, new Set())
    live.get(r.table_name)!.add(r.column_name)
  }

  const run = async (sql: string, what: string): Promise<void> => {
    try {
      await client.query(sql)
    } catch (err) {
      throw new Error(
        `[dev-stack] schema reconcile failed while ${what}:\n${sql}\n${String(err)}\n` +
          `Fix by hand (e.g. the column may need a DEFAULT to backfill existing rows), ` +
          `or as a last resort delete the ${LOCAL_PG_CONTAINER} container to rebuild from scratch (loses local data).`,
      )
    }
  }

  const patched: string[] = []

  // AQU-635 (migrations 0066-0068): artifact_bindings has tenant-safe
  // composite foreign keys. A long-lived local container can have the old
  // artifacts/files tables without the matching composite unique keys. Those
  // reference keys must exist BEFORE the generic loop creates the new table;
  // otherwise Postgres rejects CREATE TABLE and the local stack cannot boot.
  if (tables.has("artifact_bindings")) {
    patched.push(...await prepareArtifactBindingSchema(client, run))
  }

  for (const [name, table] of tables) {
    const liveCols = live.get(name)
    if (!liveCols) {
      await run(table.createSql, `creating table ${name}`)
      patched.push(`created table ${name}`)
      continue
    }
    for (const col of table.columns) {
      if (liveCols.has(col.name)) continue
      await run(
        `ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS ${col.def}`,
        `adding column ${name}.${col.name}`,
      )
      patched.push(`added column ${name}.${col.name}`)
    }
  }

  // Every parsed statement carries IF NOT EXISTS, so running these for both
  // new and existing tables repairs indexes missed by older reconciler
  // versions without rebuilding healthy indexes on later boots.
  for (const [name, indexes] of indexesByTable) {
    for (const index of indexes) {
      await run(index, `ensuring an index on ${name}`)
    }
  }

  patched.push(...await finalizeSourceBlobSchema(client, run))

  if (tables.has("artifact_bindings")) {
    patched.push(...await finalizeArtifactBindingSchema(client, run))
  }

  // AQU-538 (migrations 0057 expand + 0061 contract): the cells PK gained the
  // target_lang lane. The generic loop above adds the column, but a drifted
  // container still carries the 4-column PK — and Postgres rejects
  // `ON CONFLICT (…, target_lang)` without a matching unique constraint,
  // 500-ing every commit. Local dev has no old workers serving, so we skip the
  // production expand/contract dance and rebuild the PK straight to the 5-column
  // form here; all pre-lane rows carry '' so it's trivially unique. Idempotent
  // (skipped once target_lang is in the PK).
  const { rows: pkCols } = await client.query(
    `SELECT a.attname FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'cells'::regclass AND i.indisprimary`,
  )
  if (!(pkCols as { attname: string }[]).some((r) => r.attname === "target_lang")) {
    await run(
      `ALTER TABLE cells DROP CONSTRAINT cells_pkey;
       ALTER TABLE cells ADD PRIMARY KEY (project_id, file_id, cell_id, side, target_lang)`,
      "rebuilding the cells primary key with target_lang (migrations 0057+0061)",
    )
    patched.push("rebuilt cells PK with target_lang")
  }

  // AQU-538 (migrations 0058 expand + 0062 contract): cell_validators and file_section_progress gained
  // target_lang in their PKs so validations and progress rollups are per-lane.
  // Same rationale as the cells rebuild above — the generic loop adds the
  // column, but a drifted container keeps the pre-lane PK and Postgres rejects
  // the lane-qualified `ON CONFLICT` / upsert. All pre-lane rows carry '' so
  // the new key is trivially unique. Idempotent (skipped once target_lang is
  // in the PK).
  const { rows: validatorPkCols } = await client.query(
    `SELECT a.attname FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'cell_validators'::regclass AND i.indisprimary`,
  )
  if (!(validatorPkCols as { attname: string }[]).some((r) => r.attname === "target_lang")) {
    await run(
      `ALTER TABLE cell_validators DROP CONSTRAINT cell_validators_pkey;
       ALTER TABLE cell_validators ADD PRIMARY KEY (project_id, file_id, cell_id, target_lang, username)`,
      "rebuilding the cell_validators primary key with target_lang (migrations 0058+0062)",
    )
    patched.push("rebuilt cell_validators PK with target_lang")
  }

  const { rows: progressPkCols } = await client.query(
    `SELECT a.attname FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'file_section_progress'::regclass AND i.indisprimary`,
  )
  if (!(progressPkCols as { attname: string }[]).some((r) => r.attname === "target_lang")) {
    await run(
      `ALTER TABLE file_section_progress DROP CONSTRAINT file_section_progress_pkey;
       ALTER TABLE file_section_progress ADD PRIMARY KEY (project_id, file_id, scope, section_key, target_lang)`,
      "rebuilding the file_section_progress primary key with target_lang (migrations 0058+0062)",
    )
    patched.push("rebuilt file_section_progress PK with target_lang")
  }

  if (patched.length) {
    console.log(
      `[dev-stack] local Postgres schema patched from db/postgres/schema.sql: ${patched.join(", ")}`,
    )
  }
}

function writeManagedEnvFile(): void {
  const lines = [
    ENV_FILE_HEADER,
    `VITE_AUTH_BASE=http://127.0.0.1:${IDENTITY_PORT}`,
    WITHOUT_SYNC
      ? `# VITE_SYNC_WORKER_HOST omitted — booted with --no-sync.`
      : `VITE_SYNC_WORKER_HOST=127.0.0.1:${SYNC_PORT}`,
    // Identity worker also serves /chat (folded in from the former
    // chat-worker). The prefix-strip middleware in auth-worker/src/index.ts
    // turns /chat/api/v1/... into /api/v1/... before routing — mirrors the
    // prod mount at api.aquilla.app/chat/*. (Pre-2026-05-27 this was
    // /api/chat under the aquilla.app apex; the dev URL changed to match.)
    `VITE_CHAT_BASE=http://127.0.0.1:${IDENTITY_PORT}/chat`,
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

  // Free any ports left behind by an aborted prior run.
  await freePort(IDENTITY_PORT)
  if (!WITHOUT_SYNC) await freePort(SYNC_PORT)
  await freePort(VITE_PORT)

  await ensureLocalPostgres()
  backfillMissingLocalProgress()

  // Without a real OpenRouter key, boot the scripted mock so the agent and
  // chat paths work end-to-end (deterministic model, zero cost). A real key
  // in auth-worker/.dev.vars wins — no mock, no overrides.
  const useMockLlm = !identityHasRealOpenRouterKey()
  if (useMockLlm) {
    await freePort(MOCK_LLM_PORT)
    console.log(`[dev-stack] starting mock OpenRouter on :${MOCK_LLM_PORT}… (no real OPENROUTER_API_KEY in auth-worker/.dev.vars)`)
    const mockLlm = spawn(
      "npx",
      ["tsx", "scripts/mock-openrouter.ts", String(MOCK_LLM_PORT)],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    )
    attachOutput(mockLlm, "mock-llm", openLogFile(path.join(LOG_DIR, "mock-llm.log")), VERBOSE)
    cleanup.push(() => killChildTree(mockLlm))
  }

  console.log(`[dev-stack] starting identity (auth-worker) on :${IDENTITY_PORT}…`)
  const identity: SpawnedWorker = await spawnWranglerDev({
    cwd: IDENTITY_DIR,
    port: IDENTITY_PORT,
    label: "identity",
    env: {
      // Local Hyperdrive emulation → the local Postgres ensured above. This
      // one IS a wrangler-native process-env var (not a c.env binding), so
      // `env:` (not `--var`) is correct here.
      WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: PG_URL,
    },
    // `--var` is the only reliable way to land a value in `c.env` for
    // wrangler dev — process env alone does NOT propagate through to the
    // worker's bindings. WRANGLER_LOCAL=1 unlocks /__test__/reset and
    // /__dev__/{seed,login}. NEVER set in prod.
    // ADMIN_EMAILS: allowlist the seeded dev user (dev@local.test,
    // routes/dev-seed.ts) so /admin is reachable locally — wrangler.toml's
    // list only carries the real company emails. The email step-up gate is
    // already bypassed under WRANGLER_LOCAL=1 (middleware/platform-admin.ts).
    // Mirrors e2e-up.ts, which allowlists alice@example.test the same way.
    // AQU-346: SYNC_WORKER_URL + ENVIRONMENT used to be passed via `env:`
    // (process env) like WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
    // above — but unlike that Hyperdrive var, these two ARE read from
    // `c.env` by application code (types.ts SYNC_WORKER_URL, ENVIRONMENT),
    // so process env silently never reached them, same class of bug as
    // WRANGLER_LOCAL/ADMIN_EMAILS below. Moved to `--var` so identity calling
    // the local sync-worker for archive/member-removal notifications
    // actually works instead of silently no-op'ing (SYNC_WORKER_URL unset →
    // notifySyncWorkerOfMemberRemoval early-returns).
    extraArgs: [
      "--persist-to", PERSIST_DIR,
      "--var", "WRANGLER_LOCAL:1",
      "--var", "ADMIN_EMAILS:dev@local.test",
      // Route the model calls at the scripted mock when no real key exists.
      ...(useMockLlm
        ? [
            "--var", `OPENROUTER_BASE_URL:http://127.0.0.1:${MOCK_LLM_PORT}/api/v1`,
            "--var", "OPENROUTER_API_KEY:mock",
          ]
        : []),
      // identity calls the sync worker server-side (archive/member-removal
      // notifications, live-link seed sync). Must be --var — process env
      // never reaches c.env, so the prod URL from wrangler.toml [vars] would
      // win and local calls would silently hit prod (found independently by
      // both the linked-projects and PD7 live QA passes).
      "--var", `SYNC_WORKER_URL:http://127.0.0.1:${SYNC_PORT}`,
      "--var", "ENVIRONMENT:development",
    ],
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
        // sync-worker also binds HYPERDRIVE → same local Postgres.
        WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: PG_URL,
      },
      extraArgs: ["--persist-to", PERSIST_DIR],
      logFile: openLogFile(path.join(LOG_DIR, "sync.log")),
      streamToParent: VERBOSE,
    })
    cleanup.push(() => sync!.kill())
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
    `         chat     -> http://127.0.0.1:${IDENTITY_PORT}/chat/  (served by identity worker)`,
    useMockLlm
      ? `         llm      -> http://127.0.0.1:${MOCK_LLM_PORT}/  (scripted mock — set OPENROUTER_API_KEY in auth-worker/.dev.vars for a real model)`
      : `         llm      -> OpenRouter (real key from auth-worker/.dev.vars)`,
    `         state    -> ${path.relative(REPO_ROOT, PERSIST_DIR)}/  (delete to reset local Wrangler state)`,
    "[dev-stack] press Ctrl+C to stop",
    "",
  ]
  console.log(banner.join("\n"))
}

main().catch((err) => {
  console.error("[dev-stack] boot failed:", err)
  void shutdown(1)
})
