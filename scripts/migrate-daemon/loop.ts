// The daemon's scheduler: it owns the job state machine and nothing else.
//
// Each job walks detected → fetched → planned → done, one stage per tick, with
// the concurrency shape the pipeline can actually absorb: git fetches fan out,
// materialization fans out less (it is CPU + disk bound), and the push stage is
// strictly serial because prod has a single writer. `runOnce` drains until no
// stage has a ready job; `runForever` layers detection timers on top of the
// same drain and stops claiming on abort.
import path from "node:path"
import type { DaemonConfig } from "./config"
import type { DaemonDb, JobRow, JobStage, ProjectRow } from "./db"
import type { GitLabClient, GitLabProjectLite, SyncClient } from "./http"
import type { Pacer } from "./pacer"
import type { GitLabCredentials } from "../../src/lib/migrate/gitlab/auth"
import { buildPlacementIndex, pollInbox, reconcile, registerProject, type DetectDeps, type PlacementIndex } from "./stages/detect"
import { ensureCheckout as realEnsureCheckout } from "./stages/fetch"
import { materialize as realMaterialize, type MaterializeResult } from "./stages/materialize"
import { pushJob as realPushJob, seedLedger } from "./stages/push"
import { Digest, postDiscord } from "./notify"

/** Stage entry points, injectable so the scheduler is testable without git,
 *  a filesystem checkout, or a live sync-worker. */
export interface StageFns {
  ensureCheckout: typeof realEnsureCheckout
  materialize: typeof realMaterialize
  pushJob: typeof realPushJob
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
  stages?: Partial<StageFns>
}

const IDLE_SLEEP_MS = 5_000
const RESEED_INTERVAL_MS = 7 * 24 * 60 * 60_000
const DIGEST_INTERVAL_MS = 60 * 60_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class Scheduler {
  readonly ctx: SchedulerCtx
  /** Every stage transition this scheduler made, in order — test observability. */
  readonly stageLog: JobStage[] = []
  private readonly stages: StageFns
  private readonly plans = new Map<number, MaterializeResult>()
  private readonly forceNext = new Set<number>()
  private readonly inFlight = new Set<number>()
  /** Jobs this process is done with but that stay in a non-terminal stage
   *  (dry-run leaves them at `planned`), so the drain must not re-claim them. */
  private readonly settled = new Set<number>()
  private placement: PlacementIndex | undefined
  private stopping = false

  constructor(ctx: SchedulerCtx) {
    this.ctx = ctx
    this.stages = {
      ensureCheckout: ctx.stages?.ensureCheckout ?? realEnsureCheckout,
      materialize: ctx.stages?.materialize ?? realMaterialize,
      pushJob: ctx.stages?.pushJob ?? realPushJob,
    }
  }

  private get clonesDir(): string { return path.join(this.ctx.config.home, "clones") }
  private get plansDir(): string { return path.join(this.ctx.config.home, "plans") }

  private ready(stage: JobStage): JobRow[] {
    const now = Date.now()
    return this.ctx.db
      .listJobs(stage)
      .filter((j) => j.next_run_at <= now && !this.inFlight.has(j.id) && !this.settled.has(j.id))
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
    if (opts.only !== undefined) {
      const p = await this.ctx.gitlab.project(opts.only)
      if (!p) throw new Error(`GitLab project ${opts.only} not found`)
      const outcome = await registerProject(await this.detectDeps(), p, null)
      this.ctx.log(`register ${opts.only}: ${outcome}`)
    }
    while (await this.step(opts.force === true)) { /* drain */ }
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
    try {
      const project = this.ctx.db.getProject(job.project_id)
      if (!project) throw new Error(`no project row for gitlab id ${job.project_id}`)
      if (stage === "detected") await this.stageFetch(job, project)
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
    }
  }

  private async glProject(gitlabId: number): Promise<GitLabProjectLite> {
    const p = await this.ctx.gitlab.project(gitlabId)
    if (!p) throw new Error(`GitLab project ${gitlabId} not found`)
    return p
  }

  private async stageFetch(job: JobRow, project: ProjectRow): Promise<void> {
    const gl = await this.glProject(project.gitlab_id)
    const r = await this.stages.ensureCheckout(
      { clonesDir: this.clonesDir, gitlabToken: this.ctx.config.gitlabToken },
      { gitlabId: project.gitlab_id, httpUrlToRepo: gl.http_url_to_repo, branch: gl.default_branch, wantSha: job.sha },
    )
    // The checkout can legitimately be ahead of the sha that triggered the job
    // (a push landed while we cloned). Migrate the newer tree, not the stale one.
    if (r.sha !== job.sha) this.ctx.db.enqueue(project.gitlab_id, "content", r.sha)
    this.advance(job, "fetched")
  }

  private async stageMaterialize(job: JobRow, project: ProjectRow, force: boolean): Promise<void> {
    const gl = await this.glProject(project.gitlab_id)
    const at = Date.now()
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
      if (this.forceNext.has(job.id)) {
        this.plans.delete(job.id)
        this.forceNext.delete(job.id)
        throw new Error("verify mismatch persisted after ledger reseed and forced re-materialize")
      }
      this.forceNext.add(job.id)
      this.plans.delete(job.id)
      this.advance(job, "fetched")
      return
    }
    this.forceNext.delete(job.id)
    this.plans.delete(job.id)
    if (config.dryRun) {
      // pushJob does not write in dry-run and leaves the job at `planned`;
      // parking it stops the drain from re-pushing the same plan forever.
      this.settled.add(job.id)
      return
    }
    this.stageLog.push("done")
    digest.done++
  }

  private notify(text: string): void {
    const url = this.ctx.config.discordWebhookUrl
    if (url) void postDiscord(url, text)
  }

  async runForever(signal: AbortSignal): Promise<void> {
    const { config, log, digest } = this.ctx
    let nextInbox = 0
    let nextReconcile = 0
    let nextOrgMaps = Date.now() + config.orgMapsRefreshMs
    let nextDigest = Date.now() + DIGEST_INTERVAL_MS
    signal.addEventListener("abort", () => { this.stopping = true }, { once: true })

    while (!signal.aborted) {
      const now = Date.now()
      if (now >= nextOrgMaps) { this.invalidatePlacement(); nextOrgMaps = now + config.orgMapsRefreshMs }
      if (now >= nextInbox) {
        nextInbox = now + config.inboxPollMs
        await this.guard("inbox", async () => log(`inbox: ${await pollInbox(await this.detectDeps())} enqueued`))
      }
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
      if (!did && !signal.aborted) await sleep(IDLE_SLEEP_MS)
    }
    // Abort stops new claims; in-flight stage work is already awaited by `step`.
    log("scheduler stopped")
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try { await fn() } catch (e) { this.ctx.log(`${what} failed: ${e instanceof Error ? e.message : String(e)}`) }
  }

  /** Rebuild the local ledger from prod once a week so drift (manual ingests,
   *  a restored backup) cannot make the delta filter silently skip events. */
  private async weeklyReseed(): Promise<void> {
    const { db, sync, pacer, log } = this.ctx
    const last = Number(db.kvGet("last_full_reseed") ?? 0)
    if (Number.isFinite(last) && Date.now() - last < RESEED_INTERVAL_MS) return
    for (const p of db.listProjects("ok")) {
      await pacer.acquire(1)
      const n = await seedLedger(db, sync, p)
      log(`reseed ${p.gitlab_id} (${p.aquilla_id}): ${n} events`)
    }
    db.kvSet("last_full_reseed", String(Date.now()))
  }
}
