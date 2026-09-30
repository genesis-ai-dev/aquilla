// The daemon's scheduler: it owns the job state machine and nothing else.
//
// Each job walks detected → fetched → planned → done, one stage per tick, with
// the concurrency shape the pipeline can actually absorb: git fetches fan out,
// materialization fans out less (it is CPU + disk bound), and the push stage is
// strictly serial because prod has a single writer. `runOnce` drains until no
// stage has a ready job; `runForever` layers detection timers on top of the
// same drain and stops claiming on abort.
import fs from "node:fs"
import path from "node:path"
import type { DaemonConfig } from "./config"
import type { DaemonDb, JobRow, JobStage, ProjectRow } from "./db"
import type { GitLabClient, GitLabProjectLite, SyncClient } from "./http"
import type { Pacer } from "./pacer"
import type { R2Client } from "../../src/lib/migrate/r2-s3"
import type { GitLabCredentials } from "../../src/lib/migrate/gitlab/auth"
import { buildPlacementIndex, pollInbox, reconcile, registerProject, type DetectDeps, type PlacementIndex } from "./stages/detect"
import { ensureCheckout as realEnsureCheckout } from "./stages/fetch"
import { materialize as realMaterialize, type MaterializeResult } from "./stages/materialize"
import { pushJob as realPushJob, seedLedger } from "./stages/push"
import { Digest, postDiscord } from "./notify"
import { migrateProjectAudio as realMigrateAudio, type AudioResult } from "./stages/audio"
import type { AudioDeps } from "./stages/audio"

/** Stage entry points, injectable so the scheduler is testable without git,
 *  a filesystem checkout, or a live sync-worker. */
export interface StageFns {
  ensureCheckout: typeof realEnsureCheckout
  materialize: typeof realMaterialize
  pushJob: typeof realPushJob
  migrateAudio: typeof realMigrateAudio
}

export interface SchedulerCtx {
  config: DaemonConfig
  db: DaemonDb
  sync: SyncClient
  gitlab: GitLabClient
  creds: GitLabCredentials
  pacer: Pacer
  log: (m: string) => void
  digest: Digest
  r2?: R2Client
  publishStatus?: (status: Record<string, unknown>) => void
  stages?: Partial<StageFns>
}

const IDLE_SLEEP_MS = 5_000
const RESEED_INTERVAL_MS = 7 * 24 * 60 * 60_000
/** A pass that failed for at least one project must not re-enter immediately. */
const RESEED_RETRY_MS = 60 * 60_000
const DIGEST_INTERVAL_MS = 60 * 60_000
const STATUS_INTERVAL_MS = 10_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const sleepOrAbort = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
  const timer = setTimeout(done, ms)
  signal.addEventListener("abort", done, { once: true })
})

export class Scheduler {
  readonly ctx: SchedulerCtx
  /** Every stage transition this scheduler made, in order — test observability. */
  readonly stageLog: JobStage[] = []
  private readonly stages: StageFns
  private readonly plans = new Map<number, MaterializeResult>()
  private readonly forceNext = new Set<number>()
  /** Jobs that already went through one reseed-and-force-re-materialize round
   *  after a verify mismatch. Kept separate from `forceNext`, which the weekly
   *  reseed also populates for reasons that are not a failed verify. */
  private readonly reverified = new Set<number>()
  private readonly inFlight = new Set<number>()
  private readonly activeProjects = new Set<number>()
  private readonly active = new Map<number, { jobId: number; kind: string; stage: JobStage; startedAt: number; progress?: AudioResult }>()
  /** Jobs this process is done with but that stay in a non-terminal stage
   *  (dry-run leaves them at `planned`), so the drain must not re-claim them. */
  private readonly settled = new Set<number>()
  private placement: PlacementIndex | undefined
  private stopping = false
  /** Set for the duration of a `runOnce({ only })` call so `ready()` only
   *  surfaces jobs belonging to that one project — otherwise the drain in
   *  `step()` claims every ready job in the queue, not just the requested
   *  project's. */
  private projectFilter: number | undefined

  constructor(ctx: SchedulerCtx) {
    this.ctx = ctx
    this.stages = {
      ensureCheckout: ctx.stages?.ensureCheckout ?? realEnsureCheckout,
      materialize: ctx.stages?.materialize ?? realMaterialize,
      pushJob: ctx.stages?.pushJob ?? realPushJob,
      migrateAudio: ctx.stages?.migrateAudio ?? realMigrateAudio,
    }
  }

  private get clonesDir(): string { return path.join(this.ctx.config.home, "clones") }
  private get plansDir(): string { return path.join(this.ctx.config.home, "plans") }

  private ready(stage: JobStage): JobRow[] {
    const now = Date.now()
    return this.ctx.db
      .listJobs(stage)
      .filter((j) => j.next_run_at <= now && !this.inFlight.has(j.id) && !this.settled.has(j.id))
      .filter((j) => !this.activeProjects.has(j.project_id))
      .filter((j) => j.kind !== "audio" || this.ctx.config.dryRun || this.ctx.db.getProject(j.project_id)?.applied_sha === j.sha)
      .filter((j) => this.projectFilter === undefined || j.project_id === this.projectFilter)
  }

  statusSnapshot(): Record<string, unknown> {
    const summary = this.ctx.db.statusSummary()
    return {
      schemaVersion: 1,
      runner: this.ctx.config.runner,
      heartbeatAt: new Date().toISOString(),
      dryRun: this.ctx.config.dryRun,
      queue: summary,
      active: [...this.active.values()],
      lastInboxPollAt: this.ctx.db.kvGet("last_inbox_poll_at") ?? null,
      lastInboxEnqueued: Number(this.ctx.db.kvGet("last_inbox_enqueued") ?? 0),
      lastReconcileAt: this.ctx.db.kvGet("last_reconcile_at") ?? null,
      lastReconcileEnqueued: Number(this.ctx.db.kvGet("last_reconcile_enqueued") ?? 0),
      reconcileHighWaterMark: this.ctx.db.kvGet("reconcile_hwm") ?? null,
      updatedAt: new Date().toISOString(),
    }
  }

  private advance(job: JobRow, to: JobStage, patch: { plan_path?: string } = {}): void {
    this.ctx.db.advance(job.id, to, patch)
    this.stageLog.push(to)
  }

  async detectDeps(): Promise<DetectDeps> {
    const { db, sync, gitlab, creds, log } = this.ctx
    if (!this.placement) this.placement = await buildPlacementIndex(creds, sync, log)
    return { db, sync, gitlab, creds, placement: this.placement, log }
  }

  /** Force a fresh org/team + group-tree placement index on the next detect. */
  invalidatePlacement(): void { this.placement = undefined }

  async runOnce(opts: { only?: number; force?: boolean } = {}): Promise<void> {
    this.projectFilter = opts.only
    try {
      if (opts.only !== undefined) {
        const p = await this.ctx.gitlab.project(opts.only)
        if (!p) throw new Error(`GitLab project ${opts.only} not found`)
        const outcome = await registerProject(await this.detectDeps(), p, null)
        this.ctx.log(`register ${opts.only}: ${outcome}`)
      }
      while (await this.step(opts.force === true)) { /* drain */ }
    } finally {
      this.projectFilter = undefined
    }
  }

  /** One scheduling tick. Returns false when no stage had a ready job. */
  private async step(force: boolean): Promise<boolean> {
    if (this.stopping) return false
    const { fetchConcurrency, materializeConcurrency } = this.ctx.config
    const tasks: Promise<void>[] = []
    const take = (stage: JobStage, limit: number): void => {
      for (const job of this.ready(stage).slice(0, limit)) tasks.push(this.runStage(job, stage, force))
    }
    // Drain the sink first so plans do not pile up in memory.
    take("planned", 1)
    take("fetched", materializeConcurrency)
    take("detected", fetchConcurrency)
    if (tasks.length === 0) return false
    await Promise.all(tasks)
    return true
  }

  private async runStage(job: JobRow, stage: JobStage, force: boolean): Promise<void> {
    this.inFlight.add(job.id)
    this.activeProjects.add(job.project_id)
    this.active.set(job.id, { jobId: job.id, kind: job.kind, stage, startedAt: Date.now() })
    try {
      const project = this.ctx.db.getProject(job.project_id)
      if (!project) throw new Error(`no project row for gitlab id ${job.project_id}`)
      if (stage === "detected") await this.stageFetch(job, project)
      else if (stage === "fetched" && job.kind === "audio") await this.stageAudio(job, project)
      else if (stage === "fetched") await this.stageMaterialize(job, project, force)
      else if (stage === "planned") await this.stagePush(job, project)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.ctx.db.fail(job.id, msg)
      this.ctx.digest.failed++
      this.ctx.log(`job ${job.id} (project ${job.project_id}) failed at ${stage}: ${msg}`)
      this.notify(`migrate-daemon: job ${job.id} (project ${job.project_id}) failed at ${stage}: ${msg}`)
    } finally {
      this.inFlight.delete(job.id)
      this.active.delete(job.id)
      this.activeProjects.delete(job.project_id)
    }
  }

  private async glProject(gitlabId: number): Promise<GitLabProjectLite> {
    const p = await this.ctx.gitlab.project(gitlabId)
    if (!p) throw new Error(`GitLab project ${gitlabId} not found`)
    return p
  }

  private async stageFetch(job: JobRow, project: ProjectRow): Promise<void> {
    const checkoutDir = path.join(this.clonesDir, String(project.gitlab_id))
    if (job.kind === "audio" && fs.existsSync(path.join(checkoutDir, ".git"))) {
      this.advance(job, "fetched")
      return
    }
    const gl = await this.glProject(project.gitlab_id)
    const r = await this.stages.ensureCheckout(
      { clonesDir: this.clonesDir, gitlabToken: this.ctx.config.gitlabToken },
      { gitlabId: project.gitlab_id, httpUrlToRepo: gl.http_url_to_repo, branch: gl.default_branch, wantSha: job.sha },
    )
    // The checkout can legitimately be ahead of the sha that triggered the job
    // (a push landed while we cloned). Migrate the newer tree, not the stale one.
    if (r.sha !== job.sha) {
      this.ctx.db.enqueue(project.gitlab_id, "content", r.sha)
      this.ctx.db.enqueue(project.gitlab_id, "audio", r.sha)
      return
    }
    this.advance(job, "fetched")
  }

  private async stageAudio(job: JobRow, project: ProjectRow): Promise<void> {
    const r2 = this.ctx.r2
    if (!this.ctx.config.dryRun && !r2) throw new Error("R2 credentials required for audio copy")
    const active = this.active.get(job.id)
    const audioDeps: AudioDeps = {
      copyObject: async (sourceBucket, sourceKey, targetBucket, targetKey) => {
        if (!r2) throw new Error("R2 credentials required for audio copy")
        await r2.copyObject(sourceBucket, sourceKey, targetBucket, targetKey)
      },
      sync: this.ctx.sync,
      copyConcurrency: this.ctx.config.audioCopyConcurrency,
      dryRun: this.ctx.config.dryRun,
      onProgress: (progress) => {
        if (active) active.progress = {
          total: progress.total,
          copied: progress.copied,
          missingOid: 0,
          lfsMiss: progress.missing,
          failed: progress.failed,
          events: 0,
        }
      },
    }
    const result = await this.stages.migrateAudio(audioDeps, {
      project,
      dir: path.join(this.clonesDir, String(project.gitlab_id)),
    })
    if (active) active.progress = result
    if (this.ctx.config.dryRun) {
      this.settled.add(job.id)
      return
    }
    this.ctx.db.setProjectFields(project.gitlab_id, { audio_applied_sha: job.sha })
    this.ctx.db.advance(job.id, "done")
    this.stageLog.push("done")
    this.ctx.db.kvSet("last_audio_result", JSON.stringify({ projectId: project.gitlab_id, sha: job.sha, ...result, at: new Date().toISOString() }))
    this.cleanupCheckoutWhenIdle(project.gitlab_id)
  }

  private cleanupCheckoutWhenIdle(projectId: number): void {
    if (this.ctx.db.hasOpenJobs(projectId)) return
    try { fs.rmSync(path.join(this.clonesDir, String(projectId)), { recursive: true, force: true }) } catch { /* re-clone on demand */ }
  }

  private async stageMaterialize(job: JobRow, project: ProjectRow, force: boolean): Promise<void> {
    const gl = await this.glProject(project.gitlab_id)
    // parity gate only: freezes `now` so migrate-all and the daemon hash identically
    const at = process.env.MIGRATE_FIXED_NOW ? Number(process.env.MIGRATE_FIXED_NOW) : Date.now()
    const fresh = this.ctx.db.getJob(job.id) ?? job
    const plan = await this.stages.materialize(
      {
        db: this.ctx.db,
        syncBase: this.ctx.config.syncBase,
        syncSecret: this.ctx.config.syncSecret,
        plansDir: this.plansDir,
        gitlabToken: this.ctx.config.gitlabToken,
        now: () => at,
      },
      {
        job: fresh, project, dir: path.join(this.clonesDir, String(project.gitlab_id)),
        httpUrlToRepo: gl.http_url_to_repo, force: force || this.forceNext.has(job.id),
      },
    )
    this.plans.set(job.id, plan)
    this.advance(job, "planned", { plan_path: plan.planPath })
  }

  private async stagePush(job: JobRow, project: ProjectRow): Promise<void> {
    const plan = this.plans.get(job.id)
    if (!plan) {
      // Restarted mid-flight: the plan only lives in memory, so re-materialize.
      this.advance(job, "fetched")
      return
    }
    const { config, db, sync, pacer, log, digest } = this.ctx
    const fresh = db.getJob(job.id) ?? job
    const res = await this.stages.pushJob(
      { db, sync, pacer, dryRun: config.dryRun, syncBase: config.syncBase, syncSecret: config.syncSecret, log },
      { job: fresh, project, plan },
    )
    digest.pushed += res.pushed
    if (pacer.paused) digest.breakerTrips++

    if (!res.verified) {
      if (this.reverified.has(job.id)) {
        this.plans.delete(job.id)
        this.forceNext.delete(job.id)
        this.reverified.delete(job.id)
        throw new Error("verify mismatch persisted after ledger reseed and forced re-materialize")
      }
      this.forceNext.add(job.id)
      this.reverified.add(job.id)
      this.plans.delete(job.id)
      this.advance(job, "fetched")
      return
    }
    this.forceNext.delete(job.id)
    this.reverified.delete(job.id)
    this.plans.delete(job.id)
    if (config.dryRun) {
      // pushJob does not write in dry-run and leaves the job at `planned`;
      // parking it stops the drain from re-pushing the same plan forever.
      this.settled.add(job.id)
      return
    }
    // The plan has landed in prod; the file is dead weight from here on.
    try { fs.rmSync(plan.planPath) } catch { /* best-effort */ }
    db.setProjectFields(project.gitlab_id, { applied_sha: job.sha })
    this.cleanupCheckoutWhenIdle(project.gitlab_id)
    this.stageLog.push("done")
    digest.done++
  }

  private notify(text: string): void {
    const url = this.ctx.config.discordWebhookUrl
    if (url) void postDiscord(url, text)
  }

  async runForever(signal: AbortSignal): Promise<void> {
    const { config, log, digest } = this.ctx
    let nextReconcile = 0
    let nextOrgMaps = Date.now() + config.orgMapsRefreshMs
    let nextDigest = Date.now() + DIGEST_INTERVAL_MS
    signal.addEventListener("abort", () => { this.stopping = true }, { once: true })

    await this.guard("inbox", async () => log(`inbox: ${await pollInbox(await this.detectDeps())} enqueued`))
    const background = this.runBackgroundMaintenance(signal)

    while (!signal.aborted) {
      const now = Date.now()
      if (now >= nextOrgMaps) { this.invalidatePlacement(); nextOrgMaps = now + config.orgMapsRefreshMs }
      if (now >= nextReconcile) {
        nextReconcile = now + config.reconcileMs
        await this.guard("reconcile", async () => log(`reconcile: ${await reconcile(await this.detectDeps())} enqueued`))
      }
      await this.guard("reseed", () => this.weeklyReseed())
      if (now >= nextDigest) {
        nextDigest = now + DIGEST_INTERVAL_MS
        const text = digest.hourly()
        if (text && config.discordWebhookUrl) await postDiscord(config.discordWebhookUrl, text)
      }
      const did = await this.step(false)
      if (!did && !signal.aborted) await sleep(Math.min(IDLE_SLEEP_MS, config.inboxPollMs))
    }
    // Abort stops new claims; drain the current stage and background inbox call
    // before withLock releases the shared writer lease.
    await background
    log("scheduler stopped")
  }

  private async runBackgroundMaintenance(signal: AbortSignal): Promise<void> {
    const { config } = this.ctx
    let nextInbox = Date.now() + config.inboxPollMs
    let nextStatus = Date.now()
    while (!signal.aborted) {
      const now = Date.now()
      if (now >= nextStatus) {
        nextStatus = now + STATUS_INTERVAL_MS
        this.ctx.db.kvSet("heartbeat_at", new Date(now).toISOString())
        this.ctx.publishStatus?.(this.statusSnapshot())
      }
      if (now >= nextInbox) {
        nextInbox = now + config.inboxPollMs
        await this.guard("inbox", async () => this.ctx.log(`inbox: ${await pollInbox(await this.detectDeps())} enqueued`))
      }
      if (!signal.aborted) {
        const untilNext = Math.min(nextInbox, nextStatus) - Date.now()
        await sleepOrAbort(Math.max(1, untilNext), signal)
      }
    }
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try { await fn() } catch (e) { this.ctx.log(`${what} failed: ${e instanceof Error ? e.message : String(e)}`) }
  }

  /** Rebuild the local ledger from prod once a week so drift (manual ingests,
   *  a restored backup) cannot make the delta filter silently skip events.
   *
   *  Progress is persisted per project (`reseed_done:<gitlabId>`) so a restart
   *  mid-pass resumes instead of redoing ~17M ids, and a project failure is
   *  recorded and skipped rather than aborting the pass — an abort would leave
   *  `last_full_reseed` unset and make the next 5s tick restart everything.
   */
  private async weeklyReseed(): Promise<void> {
    const { db, sync, pacer, log } = this.ctx
    const now = Date.now()
    const last = Number(db.kvGet("last_full_reseed") ?? 0)
    if (Number.isFinite(last) && last > 0 && now - last < RESEED_INTERVAL_MS) return
    const nextAttempt = Number(db.kvGet("reseed_next_attempt") ?? 0)
    if (Number.isFinite(nextAttempt) && now < nextAttempt) return

    const failed: number[] = []
    for (const p of db.listProjects("ok")) {
      // Marker value is the pass's *starting* `last_full_reseed`, so a restart
      // mid-pass skips finished projects but the next weekly pass does not.
      const doneKey = `reseed_done:${p.gitlab_id}`
      if (db.kvGet(doneKey) === String(last)) continue
      try {
        const n = await seedLedger(db, sync, p, { onPage: () => pacer.acquire(1) })
        db.kvSet(doneKey, String(last))
        log(`reseed ${p.gitlab_id} (${p.aquilla_id}): ${n} events`)
        // Projection drift (an unchanged file whose orphan pass was skipped in
        // steady state) is reconciled by a forced re-materialize of every
        // project the reseed touched — see docs/MIGRATE-DAEMON.md (F4).
        const sha = p.applied_sha ?? p.head_sha
        if (sha) this.forceNext.add(db.enqueue(p.gitlab_id, "content", sha).id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        failed.push(p.gitlab_id)
        db.setProjectFields(p.gitlab_id, { last_error: `reseed failed: ${msg}` })
        log(`reseed ${p.gitlab_id} (${p.aquilla_id}) failed: ${msg}`)
        this.notify(`migrate-daemon: weekly reseed failed for project ${p.gitlab_id}: ${msg}`)
      }
    }
    // The pass is over either way: recording it stops the hot loop. A failed
    // pass additionally holds off re-entry for an hour.
    db.kvSet("reseed_failed_ids", JSON.stringify(failed))
    db.kvSet("last_full_reseed", String(Date.now()))
    db.kvSet("reseed_next_attempt", String(Date.now() + (failed.length ? RESEED_RETRY_MS : 0)))
  }
}
