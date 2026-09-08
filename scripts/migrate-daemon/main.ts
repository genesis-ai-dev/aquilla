// CLI entrypoint for the migrate daemon. Parses args, wires the stages, and
// holds the same R2 run lock `scripts/migrate-all.ts --apply` takes — the two
// are mutually exclusive writers against the same prod project set.
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { loadConfig, type DaemonConfig } from "./config"
import { DaemonDb } from "./db"
import { GitLabClient, SyncClient } from "./http"
import { Pacer } from "./pacer"
import { Scheduler } from "./loop"
import { Digest, postDiscord } from "./notify"
import { buildPlacementIndex, reconcile } from "./stages/detect"
import { seedLedger } from "./stages/push"
import { installMigrateRunnerHeader } from "../lib/migrate-runner-header"
import { resolveCredentialsFromEnv } from "../../src/lib/migrate/gitlab/auth"
import { R2Client } from "../../src/lib/migrate/r2-s3"
import { LockHeldError, RunLock } from "../../src/lib/migrate/run-lock"

// Copied from scripts/migrate-all.ts so both writers contend for the same lease.
const DEST_BUCKET = process.env.R2_DEST_BUCKET ?? "aquilla-snapshots"
const LOCK_KEY = process.env.MIGRATE_LOCK_KEY ?? "_migrate/audio-migrate-state.lock"
const LOCK_TTL_MS = 30 * 60_000
const LOCK_HEARTBEAT_MS = 5 * 60_000
const lockHolder = (): string =>
  `${process.env.GITHUB_RUN_ID ? `gh-run-${process.env.GITHUB_RUN_ID}` : os.hostname()}#${process.pid}`

export type Command = "daemon" | "once" | "status" | "reconcile" | "seed-ledger"
export interface Args {
  cmd: Command
  only?: number
  kind: "content"
  dryRun: boolean
  force: boolean
}
const COMMANDS: Command[] = ["daemon", "once", "status", "reconcile", "seed-ledger"]

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const args: Args = { cmd: "daemon", kind: "content", dryRun: env.DRY_RUN === "1", force: false }
  let i = 0
  if (argv[0] && !argv[0].startsWith("--")) {
    const cmd = argv[0] as Command
    if (!COMMANDS.includes(cmd)) throw new Error(`unknown command "${argv[0]}" (expected ${COMMANDS.join(" | ")})`)
    args.cmd = cmd
    i = 1
  }
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--force") args.force = true
    else if (a === "--only") {
      const n = Number(argv[++i])
      if (!Number.isInteger(n)) throw new Error("--only requires a numeric GitLab project id")
      args.only = n
    } else if (a === "--kind") {
      const k = argv[++i]
      if (k !== "content") throw new Error(`--kind ${String(k)} is not supported (content only)`)
    } else throw new Error(`unknown flag "${a}"`)
  }
  return args
}

const log = (m: string): void => console.log(new Date().toISOString(), m)

async function build(config: DaemonConfig) {
  const db = new DaemonDb(path.join(config.home, "daemon.db"))
  const sync = new SyncClient(config.syncBase, config.syncSecret, config.runner)
  const gitlab = new GitLabClient(config.gitlabUrl, config.gitlabToken)
  const creds = await resolveCredentialsFromEnv(process.env)
  const pacer = new Pacer({
    eventsPerSec: config.pushEventsPerSec, chunkStart: config.chunkStart,
    chunkMin: config.chunkMin, chunkMax: config.chunkMax,
  })
  const digest = new Digest()
  return { db, sync, gitlab, creds, pacer, digest, scheduler: new Scheduler({ config, db, sync, gitlab, creds, pacer, log, digest }) }
}

function acquireLock(config: DaemonConfig): RunLock | null {
  if (config.dryRun) return null
  if (!config.r2) {
    throw new Error("R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY required (the run lock lives in R2)")
  }
  const client = new R2Client(config.r2)
  return new RunLock({
    store: {
      get: (k) => client.getObject(DEST_BUCKET, k),
      put: (k, body, o) => client.putObject(DEST_BUCKET, k, body, o),
      delete: (k) => client.deleteObject(DEST_BUCKET, k),
    },
    key: LOCK_KEY,
    holder: lockHolder(),
    ttlMs: LOCK_TTL_MS,
  })
}

/** Acquire, heartbeat, and release the run lock around `fn`. */
/**
 * Acquire, heartbeat, and release the run lock around `fn`.
 *
 * By default a SIGINT/SIGTERM releases the lock and exits immediately (fine
 * for the short-lived one-shot commands). Pass `onSignal` to instead let the
 * caller drain in-flight work first (e.g. abort a scheduler loop) — the lock
 * heartbeat keeps running and the lock is released exactly once, after `fn`
 * resolves. A second signal during that drain force-exits right away.
 */
export interface ProcLike {
  on(event: NodeJS.Signals, listener: (sig: NodeJS.Signals) => void): unknown
  off(event: NodeJS.Signals, listener: (sig: NodeJS.Signals) => void): unknown
  exit(code?: number): never
}

export async function withLock(
  config: DaemonConfig,
  fn: (release: () => Promise<void>) => Promise<void>,
  opts: {
    onSignal?: (sig: NodeJS.Signals) => void
    /** Test seam: override the acquired lock (bypasses R2/config.dryRun). `undefined` uses `acquireLock(config)`. */
    lock?: RunLock | null
    /** Test seam: override signal wiring and process.exit. Defaults to the real `process`. */
    proc?: ProcLike
  } = {},
): Promise<void> {
  const proc: ProcLike = opts.proc ?? (process as unknown as ProcLike)
  const lock = opts.lock !== undefined ? opts.lock : acquireLock(config)
  if (lock) {
    try {
      await lock.acquire()
    } catch (e) {
      if (e instanceof LockHeldError) { console.error(`✗ ${e.message}`); proc.exit(2) }
      throw e
    }
    log(`run lock acquired: ${DEST_BUCKET}/${LOCK_KEY} (holder ${lockHolder()}, lease ${LOCK_TTL_MS / 60_000}m)`)
  }
  const beat = lock
    ? setInterval(() => void lock.heartbeat().catch((e) => log(`! lock heartbeat failed: ${String(e)}`)), LOCK_HEARTBEAT_MS)
    : null
  beat?.unref()
  const release = async (): Promise<void> => { if (beat) clearInterval(beat); await lock?.release() }

  let draining = false
  const hardExit = (sig: NodeJS.Signals): void => {
    void release().finally(() => proc.exit(sig === "SIGINT" ? 130 : 143))
  }
  const onSignal = (sig: NodeJS.Signals): void => {
    if (!opts.onSignal) { hardExit(sig); return }
    if (draining) { log(`! second ${sig} received while draining — exiting immediately`); hardExit(sig); return }
    draining = true
    log(`${sig} received — draining in-flight work before releasing the lock`)
    opts.onSignal(sig)
  }
  proc.on("SIGINT", onSignal)
  proc.on("SIGTERM", onSignal)
  try {
    await fn(release)
  } finally {
    proc.off("SIGINT", onSignal)
    proc.off("SIGTERM", onSignal)
    await release()
  }
}

async function cmdDaemon(config: DaemonConfig): Promise<void> {
  const { scheduler, digest } = await build(config)
  const ac = new AbortController()
  let signal: NodeJS.Signals | undefined
  await withLock(
    config,
    async () => {
      if (config.discordWebhookUrl) await postDiscord(config.discordWebhookUrl, `migrate-daemon started (${config.runner})`)
      await scheduler.runForever(ac.signal)
      const tail = digest.hourly()
      if (tail && config.discordWebhookUrl) await postDiscord(config.discordWebhookUrl, tail)
    },
    { onSignal: (sig) => { signal = sig; ac.abort() } },
  )
  if (signal) process.exit(signal === "SIGINT" ? 130 : 143)
}

async function cmdOnce(config: DaemonConfig, args: Args): Promise<number> {
  const { scheduler, db } = await build(config)
  await withLock(config, async () => { await scheduler.runOnce({ only: args.only, force: args.force }) })
  const failed = db.listJobs().filter((j) => j.attempts > 0 && j.error !== null && j.stage !== "done")
  const done = db.listJobs("done").length
  log(`once: ${done} job(s) done, ${db.listJobs("planned").length} planned, ${failed.length} with errors`)
  for (const j of failed) log(`  job ${j.id} project ${j.project_id}: ${j.error}`)
  return failed.length ? 1 : 0
}

function cmdStatus(config: DaemonConfig): void {
  const db = new DaemonDb(path.join(config.home, "daemon.db"))
  const projects = db.listProjects()
  const byStatus = new Map<string, number>()
  for (const p of projects) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1)
  console.log(`projects: ${projects.length} total — ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`)
  for (const p of projects) {
    if (p.status === "ok") continue
    console.log(`  ${p.status} ${p.gitlab_id} ${p.namespace}/${p.name}${p.last_error ? `: ${p.last_error}` : ""}`)
  }
  const jobs = db.listJobs()
  const byStage = new Map<string, number>()
  for (const j of jobs) byStage.set(j.stage, (byStage.get(j.stage) ?? 0) + 1)
  console.log(`jobs: ${jobs.length} total — ${[...byStage].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`)
  for (const j of jobs) {
    if (j.attempts === 0 && !j.error) continue
    console.log(`  job ${j.id} project ${j.project_id} ${j.stage} attempts=${j.attempts} next=${new Date(j.next_run_at).toISOString()}${j.error ? ` error=${j.error}` : ""}`)
  }
  const pacer = new Pacer({
    eventsPerSec: config.pushEventsPerSec, chunkStart: config.chunkStart,
    chunkMin: config.chunkMin, chunkMax: config.chunkMax,
  })
  console.log(`pacer (fresh — live pacer state is per-process): ${JSON.stringify(pacer.snapshot())}`)
  console.log(`ledger rows: ${projects.reduce((n, p) => n + db.ledgerCount(p.gitlab_id), 0)}`)
  for (const k of ["inbox_cursor", "reconcile_hwm", "last_full_reseed"]) console.log(`kv ${k}: ${db.kvGet(k) ?? "(unset)"}`)
  db.close()
}

async function cmdReconcile(config: DaemonConfig): Promise<void> {
  const { db, sync, gitlab, creds } = await build(config)
  const placement = await buildPlacementIndex(creds, sync, log)
  log(`reconcile: ${await reconcile({ db, sync, gitlab, creds, placement, log })} enqueued`)
  db.close()
}

async function cmdSeedLedger(config: DaemonConfig, args: Args): Promise<void> {
  const { db, sync, pacer } = await build(config)
  const targets = args.only !== undefined
    ? db.listProjects().filter((p) => p.gitlab_id === args.only)
    : db.listProjects("ok")
  for (const p of targets) {
    await pacer.acquire(1)
    log(`seed-ledger ${p.gitlab_id} (${p.aquilla_id}): ${await seedLedger(db, sync, p)} events`)
  }
  db.close()
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const config = loadConfig(process.env, { dryRun: args.dryRun })
  if (!process.env.MIGRATE_RUNNER) process.env.MIGRATE_RUNNER = config.runner
  installMigrateRunnerHeader()
  switch (args.cmd) {
    case "daemon": await cmdDaemon(config); return 0
    case "once": return await cmdOnce(config, args)
    case "status": cmdStatus(config); return 0
    case "reconcile": await cmdReconcile(config); return 0
    case "seed-ledger": await cmdSeedLedger(config, args); return 0
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) },
  )
}
