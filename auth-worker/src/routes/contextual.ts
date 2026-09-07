// Contextual translation run control (design §8, slice D1). Mounted at
// /api/v2/projects in src/index.ts:
//
//   POST /:projectId/contextual/runs                      start a run (CONTRIBUTOR)
//   GET  /:projectId/contextual/runs?fileId=              snapshot for the pill (VIEWER)
//   POST /:projectId/contextual/runs/:runId/pause|resume|terminate
//   POST /:projectId/contextual/steering                  direction / refresh_span / note
//   GET  /:projectId/contextual/drafts?fileId=            staged drafts (VIEWER)
//   GET  /:projectId/contextual/segmentation?fileId=      strategy + preview (VIEWER)
//        optional &strategy=auto|fixed&fixedSize=N        dry-run preview, no write
//   PUT  /:projectId/contextual/segmentation?fileId=      set the strategy (PROJECT_LEAD)
//   POST /:projectId/contextual/segmentation/generate     AI re-segmentation (PROJECT_LEAD)
//   POST /:projectId/contextual/drafts/:draftId/review    {action: applied|rejected}
//
// v1 execution (documented deviation): no Workflows binding — POST /runs kicks
// selfTickLoop via executionCtx.waitUntil; the loop drives lib/contextual/tick
// runOneTick until the run pauses/parks/fails or a safety cap, on its OWN
// makePostgres connection (the request-scoped AQUILLA_PG shim closes when the
// Response returns — same gotcha as routes/agent.ts). All run state lives in
// Postgres, so a dropped loop resumes exactly where it stopped.

import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE, type Env } from "../types"
import { errorJson, requireRole } from "./_contextual-helpers"
import { runAiGuard } from "../lib/ai-budget"
import { getPlatformSettingsCached } from "../lib/platform-settings"
import { creditGuard } from "../lib/credits"
import { wordCapBody, wordGuard } from "../lib/billing/words"
import { makeCostMeter } from "../lib/cost-meter"
import { notifySyncWorkerOfContextualActivity } from "../services/sync-worker-notify"
import { makePostgres, type AquillaDb } from "../../../db/shim/postgres"
import {
  getFileSegmentation,
  setFileSegmentation,
  validateSegmentationInput,
  MAX_BOUNDARIES,
  MAX_NOTE_CHARS,
  MAX_SEGMENT_SIZE,
  MIN_SEGMENT_SIZE,
  type SegmentationInput,
} from "../../../db/shared/file-segmentation"
import { selectCellPairs } from "../lib/agent/tools/select-cells"
import { segmentWithModel } from "../lib/contextual/segment-model"
import {
  createRun,
  getRun,
  getActiveRun,
  listRuns,
  requestPause,
  confirmPause,
  resumeRun,
  terminateRun,
  parkRun,
  failRun,
  appendSteering,
  readUnconsumedSteering,
  listDrafts,
  listDraftPageByRun,
  countDrafts,
  countDraftsByRun,
  reviewDraft,
  appendContextualRunEvent,
  listContextualRunEvents,
  CONTEXTUAL_EVENT_LIST_LIMIT,
  CONTEXTUAL_RUN_LIST_DEFAULT_LIMIT,
  CONTEXTUAL_RUN_LIST_MAX_LIMIT,
  claimStrandedRuns,
  listAutopilotCandidateFiles,
  listActiveAutopilotRunFiles,
  tryAcquireContextualProjectLease,
  renewContextualProjectLease,
  releaseContextualProjectLease,
  CONTEXTUAL_PROJECT_LEASE_SECONDS,
  getProjectAutopilotSummary,
  type ContextualRun,
  type ContextualProjectLease,
  type AppendContextualRunEventInput,
} from "../../../db/shared/contextual-runs"
import { getSceneBrief, listSceneBriefsByRun } from "../../../db/shared/scene-briefs"
import { isRegisteredTargetLane, loadProjectContext } from "../lib/contextual/project-context"
import { computeContextReadiness, type ContextReadiness } from "../lib/contextual/readiness"
import {
  runOneTick,
  makeLlmCall,
  resolveContextualModels,
  resolveOpenRouterUrl,
  resolveSpanSeeds,
  spanLabel,
  runStateFrame,
  persistContextualProgressFrame,
  MAX_WAVE_CONCURRENCY,
  type ContextualProgressFrame,
  type SegmentationPreviewQuery,
} from "../lib/contextual/tick"
import { friendlyScriptureLabel } from "../../../shared/span-label"
import { decorateActivityLabels, loadCellDisplayIndex } from "../lib/contextual/activity-labels"
import {
  getCachedContextualRead,
  getCachedContextualReadiness,
  invalidateContextualReads,
} from "../lib/contextual/read-cache"
import type { LlmCall } from "../lib/contextual/types"

const contextual = new Hono<AuthHonoEnv>()

/** Safety cap on server-side self-continuation. A run longer than this PARKS
 *  where it stands — it must never simply fall out of the loop still marked
 *  'running', because `resumeRun` refuses a running run and nothing could then
 *  restart it. Parked-with-spans-left is a state the sweeper knows how to
 *  wake, so long files finish unattended. */
const MAX_WAVES_PER_LOOP = 50

/** Total spans one project-wide start may drive at once, across every file.
 *  Per-file wave width is divided down to respect it — the ceiling that
 *  matters is the model provider's rate limit, not any one file's size.
 *
 *  A span is NOT one concurrent request: a high-risk span fans its verifier
 *  panel out three-wide (router.ts ALL_VERIFIERS), so peak in-flight requests
 *  are roughly 3x this number. Sized for OpenRouter by default; a self-hosted
 *  upstream with N slots needs CONTEXTUAL_MAX_CONCURRENCY <= N/3, or the
 *  surplus 429s and those retries land in the cost measurement as real work. */
const DEFAULT_MAX_PROJECT_CONCURRENCY = 12
function resolveMaxProjectConcurrency(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_PROJECT_CONCURRENCY
}
/** Files a single project-wide start will fan out to. Additional eligible
 * files are reported as deferred and become reachable on the next start. */
const MAX_PROJECT_FILES = 24

/** Activity must never become the reason a translation run wedges. Writes are
 * awaited (so they normally precede the live notification) but degrade to a
 * structured warning if a deployment briefly runs ahead of its migration. */
async function appendActivitySafely(
  db: AquillaDb,
  input: AppendContextualRunEventInput,
): Promise<void> {
  try {
    await appendContextualRunEvent(db, input)
  } catch (err) {
    console.warn(`[contextual] activity append failed for run ${input.runId}/${input.kind}:`, err)
  }
}

export async function publishRunStateOutsideTick(
  env: Env,
  db: AquillaDb,
  projectId: string,
  run: ContextualRun,
): Promise<void> {
  const frame = runStateFrame(run)
  try {
    await persistContextualProgressFrame(db, { projectId, fileId: run.fileId }, frame)
  } catch (err) {
    console.warn(`[contextual] activity append failed for run ${run.id}/run_state:`, err)
  }
  try {
    await notifySyncWorkerOfContextualActivity(env, projectId, frame)
  } catch (err) {
    // A control transition is durable before this decorative relay. Never
    // split resume/steering from the driver that will continue the run.
    console.warn(`[contextual] live notification failed for run ${run.id}/run_state:`, err)
  }
}

async function recordRunCreated(db: AquillaDb, run: ContextualRun): Promise<void> {
  await appendActivitySafely(db, {
    runId: run.id,
    projectId: run.projectId,
    fileId: run.fileId,
    kind: "run_created",
    status: "running",
    details: {
      initiatedBy: run.initiatedBy,
      scopeGroup: run.scopeGroup,
      anchorCellId: run.anchorCellId,
      targetLang: run.targetLang,
    },
  })
}

// ── The self-continuing tick loop ───────────────────────────────────────────

/** Exposed for tests: the most recent loop's completion promise, so a test
 *  can await settled background work before asserting (the PGlite harness has
 *  no executionCtx to flush). Production code never reads this. */
export const _test: { lastLoop: Promise<void> | null } = { lastLoop: null }

const PROJECT_LEASE_RETRY_MS = 500
/** A holder that just released capacity waits longer than one waiter poll
 * before trying again. That gives cross-isolate waiters a deterministic turn
 * instead of letting an early file reacquire for all 50 waves. */
const PROJECT_LEASE_REACQUIRE_YIELD_MS = PROJECT_LEASE_RETRY_MS + 250
const PROJECT_LEASE_RENEW_MS = 30_000

function waitForLeaseRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROJECT_LEASE_RETRY_MS))
}

function yieldLeaseTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROJECT_LEASE_REACQUIRE_YIELD_MS))
}

/** Wait on the durable cross-isolate capacity authority. A pause/terminate
 * must not sit behind model work: return without a lease so runOneTick can
 * observe and settle that control state immediately. */
async function waitForProjectLease(
  db: AquillaDb,
  projectId: string,
  runId: string,
  weight: number,
  limit: number,
): Promise<ContextualProjectLease | null> {
  for (;;) {
    const lease = await tryAcquireContextualProjectLease(db, {
      projectId,
      runId,
      weight,
      limit,
    })
    if (lease) return lease
    const current = await getRun(db, runId)
    if (!current || current.status !== "running") return null
    await waitForLeaseRetry()
  }
}

/**
 * Settle only control state when lease acquisition stopped waiting. This path
 * deliberately has no LLM capability: a paused run can be resumed between
 * waitForProjectLease's status read and this read, and that race must retry
 * capacity acquisition rather than execute an unleased wave.
 */
export async function settleRunWithoutProjectLease(
  db: AquillaDb,
  runId: string,
  notify: (frame: ContextualProgressFrame) => Promise<void>,
): Promise<Awaited<ReturnType<typeof runOneTick>>> {
  const current = await getRun(db, runId)
  if (!current) return { continueRun: false, status: "not_found" }
  if (current.status === "running") {
    return { continueRun: true, status: "running" }
  }
  if (current.status === "pausing") {
    const confirmed = await confirmPause(db, runId)
    if (confirmed.status === "ok") {
      try {
        await notify(runStateFrame(confirmed.run))
      } catch (err) {
        console.warn(`[contextual] live notification failed for run ${runId}/run_state:`, err)
      }
      return { continueRun: false, status: "paused" }
    }
  }
  return { continueRun: false, status: current.status }
}

/** Keep a durable lease alive while an upstream request is in flight. The
 * timer covers a single slow provider call; the wrapper checks before/after
 * every call and fails closed if another isolate has already reclaimed the
 * expired capacity. */
function leaseAwareLlm(
  db: AquillaDb,
  lease: ContextualProjectLease,
  base: LlmCall,
): { llm: LlmCall; stop: () => Promise<void> } {
  let lastRenewedAt = Date.now()
  let lost = false
  let renewal: Promise<void> | null = null

  const renew = (): Promise<void> => {
    if (renewal) return renewal
    renewal = (async () => {
      try {
        const ok = await renewContextualProjectLease(db, lease)
        if (ok) lastRenewedAt = Date.now()
        else lost = true
      } catch (err) {
        // Brief DB turbulence is tolerable while the existing lease remains
        // valid. Stop model work before its expiry can make the slot reusable.
        if (Date.now() - lastRenewedAt >= CONTEXTUAL_PROJECT_LEASE_SECONDS * 800) {
          lost = true
        }
        console.warn(`[contextual] project lease renewal failed for run ${lease.runId}:`, err)
      } finally {
        renewal = null
      }
    })()
    return renewal
  }
  const timer = setInterval(() => {
    void renew()
  }, PROJECT_LEASE_RENEW_MS)

  return {
    llm: async (request) => {
      if (Date.now() - lastRenewedAt >= PROJECT_LEASE_RENEW_MS) await renew()
      if (lost) throw new Error("project_concurrency_lease_lost")
      const response = await base(request)
      if (lost) throw new Error("project_concurrency_lease_lost")
      return response
    },
    stop: async () => {
      clearInterval(timer)
      if (renewal) await renewal
    },
  }
}

/** Run waves until the run stops continuing or the safety cap. Owns its own
 *  PG connection (env.AQUILLA_PG dies with the Response); never throws. */
async function selfTickLoop(
  env: Env,
  projectId: string,
  runId: string,
  concurrency?: number,
): Promise<void> {
  const shim = env.PG_CONNECTION_STRING ? makePostgres(env.PG_CONNECTION_STRING) : null
  const db: AquillaDb = (shim as unknown as AquillaDb) ?? env.AQUILLA_PG
  const notify = async (frame: ContextualProgressFrame) =>
    notifySyncWorkerOfContextualActivity(env, projectId, frame)
  // Dev cost meter (AQU pricing exercise): one row per model call, flushed
  // per wave. Buffered so the ledger write never lands inside the model hot
  // path and skews the latency it is recording.
  const meter = makeCostMeter(env, db)
  try {
    const settings = await getPlatformSettingsCached(env)
    const llm = makeLlmCall({
      url: resolveOpenRouterUrl(env),
      apiKey: env.OPENROUTER_API_KEY ?? "",
      models: resolveContextualModels(env, settings),
      ...(Number(env.CONTEXTUAL_MAX_INFLIGHT) > 0
        ? { maxInFlight: Math.floor(Number(env.CONTEXTUAL_MAX_INFLIGHT)) }
        : {}),
      onUsage: (u) =>
        meter.add({
          surface: "autopilot",
          runId,
          projectId,
          kind: "llm",
          label: u.label,
          spanId: u.spanId,
          tier: u.tier,
          model: u.model,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          costCents: u.costCents,
          latencyMs: u.latencyMs,
          ok: u.ok,
          ...(u.tokensPerSecond !== undefined ? { tokensPerSecond: u.tokensPerSecond } : {}),
        }),
    })
    for (let wave = 0; wave < MAX_WAVES_PER_LOOP; wave++) {
      const weight = Math.max(1, Math.min(
        resolveMaxProjectConcurrency(env.CONTEXTUAL_MAX_CONCURRENCY),
        concurrency ?? MAX_WAVE_CONCURRENCY,
      ))
      const tick = async () => {
        const lease = await waitForProjectLease(
          db,
          projectId,
          runId,
          weight,
          resolveMaxProjectConcurrency(env.CONTEXTUAL_MAX_CONCURRENCY),
        )
        if (!lease) {
          return settleRunWithoutProjectLease(db, runId, notify)
        }
        const guarded = leaseAwareLlm(db, lease, llm)
        try {
          return await runOneTick({
            db,
            runId,
            llm: guarded.llm,
            notify,
            ...(concurrency ? { concurrency } : {}),
          })
        } finally {
          await guarded.stop()
          try {
            await releaseContextualProjectLease(db, lease)
          } catch (err) {
            // Capacity fails closed until the short lease expires; completed
            // translation work must not be rewritten as a model failure.
            console.warn(`[contextual] project lease release failed for run ${runId}:`, err)
          }
        }
      }
      const result = await tick()
      await meter.flush()
      if (!result.continueRun) return
      // The lease was released in tick()'s finally. Waiters poll at the
      // shorter retry interval, so a different file/isolate gets a chance to
      // acquire before this holder begins its next wave.
      await yieldLeaseTurn()
    }
    // Cap reached with spans still queued. Park (never leave it 'running' with
    // no driver) so resume, steering, or the sweeper can pick it back up.
    const parked = await parkRun(db, runId)
    if (parked.status === "ok") {
      await publishRunStateOutsideTick(env, db, projectId, parked.run)
    }
  } catch (err) {
    // Last-resort settlement — the run must never wedge in 'running'.
    const message = err instanceof Error ? err.message : String(err)
    try {
      const failed = await failRun(db, runId, message)
      if (failed.status === "ok") {
        await publishRunStateOutsideTick(env, db, projectId, failed.run)
      }
    } catch {
      /* connection gone — the guarded transitions keep the row consistent */
    }
    console.error(`[contextual] tick loop failed for run ${runId}:`, err)
  } finally {
    // Drain before the connection closes — a return/throw above skips the
    // per-wave flush, and those rows are the tail of the run.
    await meter.flush()
    if (shim) {
      try {
        await shim.close()
      } catch {
        /* already closed */
      }
    }
  }
}

/** Kick the loop in the background. Hono throws on `c.executionCtx` when there
 *  is none (vitest) — fall back to a floating promise, tracked in _test. */
export function kickLoop(
  c: Context<AuthHonoEnv>,
  projectId: string,
  runId: string,
  concurrency?: number,
): void {
  const projectConcurrency = resolveMaxProjectConcurrency(c.env.CONTEXTUAL_MAX_CONCURRENCY)
  // Preserve runOneTick's adaptive wave sizing unless the configured project
  // ceiling is narrower than its normal six-span maximum.
  const boundedConcurrency = concurrency
    ?? (projectConcurrency < MAX_WAVE_CONCURRENCY ? projectConcurrency : undefined)
  const loop = selfTickLoop(c.env, projectId, runId, boundedConcurrency)
  _test.lastLoop = loop
  try {
    c.executionCtx.waitUntil(loop)
  } catch {
    void loop.catch(() => {})
  }
}

/** Start one loop per selected file. Each wave independently acquires the
 * durable weighted project lease; the aggregate promise also makes the real
 * route test wait for every producer, not whichever loop was kicked last. */
function kickProjectLoops(
  c: Context<AuthHonoEnv>,
  projectId: string,
  runIds: string[],
  perFileConcurrency: number,
): void {
  if (runIds.length === 0) return
  const loops = runIds.map((runId) =>
    selfTickLoop(c.env, projectId, runId, perFileConcurrency),
  )
  const settled = Promise.allSettled(loops).then(() => {})
  _test.lastLoop = settled
  try {
    c.executionCtx.waitUntil(settled)
  } catch {
    void settled.catch(() => {})
  }
}

/**
 * Restart runs whose driver died, and wake runs that parked with spans left.
 *
 * Called from the auth-worker cron (every 5 minutes). Without it, a run whose
 * Worker request ended mid-flight stays 'running' with nothing driving it —
 * unresumable, because `resumeRun` only accepts paused|parked — and the pill
 * spins until a human terminates it. Best-effort by contract: a sweep that
 * throws must never fail the cron's other work.
 */
export interface SweepResult {
  /** Runs this sweep adopted. */
  adopted: number
  /**
   * Settles when every adopted run's loop finishes.
   *
   * The caller MUST keep its Postgres connection alive until this resolves.
   * `selfTickLoop` only opens its own connection when `PG_CONNECTION_STRING`
   * is configured; otherwise it borrows `env.AQUILLA_PG`, and the cron closes
   * that in its `finally`. Without this handle the sweep would adopt runs and
   * then yank the connection out from under them — worse than not sweeping,
   * because the adoption already refreshed their heartbeats.
   */
  done: Promise<void>
}

export async function sweepStrandedContextualRuns(env: Env, limit = 10): Promise<SweepResult> {
  const db = env.AQUILLA_PG
  if (!db) return { adopted: 0, done: Promise.resolve() }
  let adopted: Awaited<ReturnType<typeof claimStrandedRuns>> = []
  try {
    adopted = await claimStrandedRuns(db, limit)
  } catch (err) {
    console.warn("[contextual] stranded-run sweep query failed:", err)
    return { adopted: 0, done: Promise.resolve() }
  }
  const byProject = new Map<string, typeof adopted>()
  for (const run of adopted) {
    const projectRuns = byProject.get(run.projectId) ?? []
    projectRuns.push(run)
    byProject.set(run.projectId, projectRuns)
  }
  const projectConcurrency = resolveMaxProjectConcurrency(env.CONTEXTUAL_MAX_CONCURRENCY)
  const projectLoops = [...byProject.entries()].map(([projectId, runs]) => {
    const perFile = Math.min(
      MAX_WAVE_CONCURRENCY,
      Math.max(1, Math.floor(projectConcurrency / runs.length)),
    )
    return Promise.allSettled(
      runs.map((run) => selfTickLoop(env, projectId, run.id, perFile)),
    ).then(() => {})
  })
  const done = Promise.allSettled(projectLoops).then(() => {})
  if (projectLoops.length > 0) _test.lastLoop = done
  return {
    adopted: adopted.length,
    done,
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

const startSchema = z.object({
  // Optional only for a project-wide start, which derives its own file list.
  fileId: z.string().min(1).optional(),
  targetLang: z.string().max(64).optional(),
  /** Cell the user was looking at — the first wave starts there. */
  anchorCellId: z.string().max(256).optional(),
  /** "file" (default) drafts one file; "project" fans out across every
   *  discourse file with work left. */
  scope: z.enum(["file", "project"]).optional(),
})

// POST /:projectId/contextual/runs — start a run (CONTRIBUTOR: this is
// translation work product). Guards mirror routes/agent.ts: AI-budget guard on
// the mid model + org credit guard BEFORE any work starts.
contextual.post(
  "/:projectId/contextual/runs",
  authMiddleware,
  zValidator("json", startSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res
    if (!c.env.OPENROUTER_API_KEY) {
      const { body, status } = errorJson("not_configured", "OPENROUTER_API_KEY is not configured", 500)
      return c.json(body, status)
    }

    const user = c.get("user")
    const body = c.req.valid("json")
    const lane = (body.targetLang ?? "").trim()
    if (!(await isRegisteredTargetLane(c.env.AQUILLA_PG, projectId, lane))) {
      const { body: err, status } = errorJson(
        "validation_failed",
        "That target-language lane is not registered on this project.",
        400,
      )
      return c.json(err, status)
    }

    const settings = await getPlatformSettingsCached(c.env)
    const models = resolveContextualModels(c.env, settings)
    const guard = await runAiGuard(models.mid, user.id, c.env.AQUILLA_PG, c.env)
    if (!guard.ok) return c.json(guard.body, guard.status)

    let orgId = 0
    try {
      const projectRow = await c.env.AQUILLA_PG
        .prepare("SELECT org_id FROM projects WHERE id = ?")
        .bind(projectId)
        .first<{ org_id: number | null }>()
      orgId = projectRow?.org_id ?? 0
    } catch {
      /* best-effort — degrade to org 0 */
    }
    const credit = await creditGuard(c.env.AQUILLA_PG, c.env, orgId, "agent")
    if (!credit.ok) {
      const { body: err, status } = errorJson(
        "credit_cap_exceeded",
        "Agent credit cap reached. Contact your org admin.",
        429,
        { reason: credit.reason },
      )
      return c.json(err, status)
    }
    const words = await wordGuard(c.env.AQUILLA_PG, orgId)
    if (!words.ok) return c.json(wordCapBody(words.reason), 429)

    const roleSnapshot = { userId: user.id, username: user.username, level: gate.level }
    // ── Project-wide start: one graph per file, all of them at once ──
    if (body.scope === "project") {
      const [candidates, activeFiles] = await Promise.all([
        listAutopilotCandidateFiles(c.env.AQUILLA_PG, projectId),
        listActiveAutopilotRunFiles(c.env.AQUILLA_PG, projectId),
      ])
      if (candidates.length === 0) {
        const { body: err, status } = errorJson(
          "validation_failed",
          "no files in this project have untranslated text to draft",
          400,
        )
        return c.json(err, status)
      }
      const activeDetailsByFile = new Map(activeFiles.map((active) => [active.fileId, active]))
      const skipped: { fileId: string; reason: string }[] = []
      const eligible = candidates.filter((file) => {
        const active = activeDetailsByFile.get(file.fileId)
        if (!active) return true
        const reason = active.status === "parked"
          ? active.workQueued
            ? "work queued"
            : "idle run owns file; review or stop it before rerunning"
          : active.status === "paused"
            ? "paused"
            : active.status === "pausing"
              ? "pause pending"
              : "already running"
        skipped.push({ fileId: file.fileId, reason })
        return false
      })
      const selected = eligible.slice(0, MAX_PROJECT_FILES)
      const deferredCount = eligible.length - selected.length
      const projectConcurrency = resolveMaxProjectConcurrency(c.env.CONTEXTUAL_MAX_CONCURRENCY)
      // Divide the global ceiling across files so a 24-file fan-out doesn't
      // multiply into 144 concurrent model calls. When there are more files
      // than slots, the durable project lease queues their waves at this ceiling.
      const perFile = selected.length > 0
        ? Math.min(
            MAX_WAVE_CONCURRENCY,
            Math.max(1, Math.floor(projectConcurrency / selected.length)),
          )
        : 1
      const scopeGroup = crypto.randomUUID()
      const started: { runId: string; fileId: string }[] = []
      try {
        for (const file of selected) {
          let made: Awaited<ReturnType<typeof createRun>>
          try {
            made = await createRun(c.env.AQUILLA_PG, {
              projectId,
              fileId: file.fileId,
              targetLang: lane,
              initiatedBy: user.username,
              roleSnapshot,
              scopeGroup,
              ...(body.anchorCellId ? { anchorCellId: body.anchorCellId } : {}),
            })
          } catch (err) {
            // A single corrupt/racing candidate must not strand earlier rows
            // or make later eligible files unreachable in this batch.
            console.error(`[contextual] project start failed for ${projectId}/${file.fileId}:`, err)
            skipped.push({ fileId: file.fileId, reason: "start_failed" })
            continue
          }
          if (made.status === "active_exists") {
            // Already running is not a failure — it is the same work in flight.
            skipped.push({ fileId: file.fileId, reason: "already running" })
            continue
          }
          await recordRunCreated(c.env.AQUILLA_PG, made.run)
          // Record ownership before the non-durable relay: even if notify is
          // briefly unavailable, finally below still gives this run a driver.
          started.push({ runId: made.run.id, fileId: file.fileId })
          try {
            await notifySyncWorkerOfContextualActivity(c.env, projectId, runStateFrame(made.run))
          } catch (err) {
            console.warn(`[contextual] project start notify failed for run ${made.run.id}:`, err)
          }
        }
      } finally {
        // Failure atomicity for the live driver: every successfully inserted
        // row is kicked even if a later candidate's DB/relay work fails.
        kickProjectLoops(
          c,
          projectId,
          started.map((run) => run.runId),
          perFile,
        )
      }
      return c.json({
        scope: "project",
        scopeGroup,
        started,
        skipped,
        totalCandidates: candidates.length,
        deferred: {
          count: deferredCount,
          reason: deferredCount > 0 ? "batch_limit" : null,
        },
        truncated: deferredCount > 0,
      }, 201)
    }

    // ── Single-file start ──
    if (!body.fileId) {
      const { body: err, status } = errorJson("validation_failed", "fileId is required", 400)
      return c.json(err, status)
    }
    const created = await createRun(c.env.AQUILLA_PG, {
      projectId,
      fileId: body.fileId,
      targetLang: lane,
      initiatedBy: user.username,
      roleSnapshot,
      ...(body.anchorCellId ? { anchorCellId: body.anchorCellId } : {}),
    })
    if (created.status === "active_exists") {
      const { body: err, status } = errorJson(
        "run_exists",
        "a contextual run is already active for this file",
        409,
        { runId: created.runId },
      )
      return c.json(err, status)
    }

    await recordRunCreated(c.env.AQUILLA_PG, created.run)
    try {
      await notifySyncWorkerOfContextualActivity(c.env, projectId, runStateFrame(created.run))
    } catch (err) {
      console.warn(`[contextual] start notify failed for run ${created.run.id}:`, err)
    }
    kickLoop(c, projectId, created.run.id)
    return c.json({ runId: created.run.id, run: created.run }, 201)
  },
)

/**
 * Serve a poll endpoint from the isolate read cache (lib/contextual/read-cache).
 * Runs AFTER the role gate — the cached body is project-scoped, never
 * user-scoped, so the gate is the only per-user work on a hit. A matching
 * `If-None-Match` answers 304 with no body; the SPA transport retains the
 * last body per URL and replays it. `no-store` keeps the browser's own HTTP
 * cache out of the loop so the conditional round-trip is explicit.
 */
async function cachedPollJson(
  c: Context<AuthHonoEnv>,
  projectId: string,
  scope: string,
  compute: () => Promise<unknown>,
): Promise<Response> {
  const cached = await getCachedContextualRead(projectId, scope, compute)
  c.header("ETag", cached.etag)
  c.header("Cache-Control", "no-store")
  if (c.req.header("If-None-Match") === cached.etag) return c.body(null, 304)
  return c.body(cached.body, 200, { "Content-Type": "application/json" })
}

/** Readiness cell counts: a full-project `cells` self-join. Off the poll hot
 *  path — cached per project for CONTEXTUAL_READINESS_TTL_MS. */
async function readinessCellCounts(
  db: AquillaDb,
  projectId: string,
): Promise<{ validated: number; untranslated: number }> {
  return getCachedContextualReadiness(projectId, async () => {
    const counts = await db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE t.validated = 1 AND COALESCE(t.value,'') <> '') AS validated,
                COUNT(*) FILTER (WHERE COALESCE(t.value,'') = '') AS untranslated
           FROM cells s
           LEFT JOIN cells t
             ON t.project_id = s.project_id AND t.file_id = s.file_id
            AND t.cell_id = s.cell_id AND t.side = 'target' AND t.target_lang = ''
          WHERE s.project_id = ? AND s.side = 'source' AND s.target_lang = ''`,
      )
      .bind(projectId)
      .first<{ validated: number; untranslated: number }>()
    return {
      validated: Number(counts?.validated ?? 0),
      untranslated: Number(counts?.untranslated ?? 0),
    }
  })
}

// GET /:projectId/contextual/overview — project-wide autopilot rollup for the
// PM surface (VIEWER: read-only observability, not a control).
contextual.get("/:projectId/contextual/overview", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  return cachedPollJson(c, projectId, "overview", async () => {
    const summary = await getProjectAutopilotSummary(c.env.AQUILLA_PG, projectId)

    // What autopilot actually KNOWS about this project. A run with no brief, no
    // key terms and no validated examples still produces confident output — the
    // most expensive kind, because nothing looks wrong until a consultant reads
    // it, and the progress numbers say "staged" either way. Reporting the gaps
    // is the only way a PM finds out before spending the run.
    let readiness: ContextReadiness | null = null
    try {
      const context = await loadProjectContext(c.env.AQUILLA_PG, projectId)
      const counts = await readinessCellCounts(c.env.AQUILLA_PG, projectId)
      readiness = computeContextReadiness({
        context,
        validatedExamples: counts.validated,
        untranslatedCells: counts.untranslated,
      })
    } catch {
      // Readiness is advisory — never fail the rollup over it.
    }

    return { available: true, ...summary, ...(readiness ? { readiness } : {}) }
  })
})

/** Snapshot shape the pill hydrates from (mirrors run-store's expectations). */
function runSnapshot(
  run: ContextualRun,
  options: { proposedDrafts: number; activeDirections?: string[] },
) {
  const activeDirections = options.activeDirections ?? []
  return {
    runId: run.id,
    fileId: run.fileId,
    status: run.status,
    targetLang: run.targetLang,
    initiatedBy: run.initiatedBy,
    scopeGroup: run.scopeGroup,
    anchorCellId: run.anchorCellId,
    // Live phase/spanLabel arrive over the DO frame channel; the snapshot only
    // carries durable state, so these hydrate as null (never undefined — the
    // SPA run-store types them string | null).
    phase: null,
    spanLabel: null,
    activeDirections,
    done: run.doneSpans,
    total: run.totalSpans,
    failed: run.failedSpans,
    unitsSpent: run.unitsSpent,
    callsSpent: run.callsSpent,
    proposedDrafts: options.proposedDrafts,
    lastError: run.lastError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

// GET /:projectId/contextual/runs?fileId= — snapshot (VIEWER: read-only).
contextual.get("/:projectId/contextual/runs", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const fileId = c.req.query("fileId")
  if (!fileId) {
    const limitRaw = c.req.query("limit")
    const limit = limitRaw === undefined
      ? CONTEXTUAL_RUN_LIST_DEFAULT_LIMIT
      : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > CONTEXTUAL_RUN_LIST_MAX_LIMIT) {
      const { body, status } = errorJson(
        "validation_failed",
        `limit must be an integer from 1 to ${CONTEXTUAL_RUN_LIST_MAX_LIMIT}`,
        400,
      )
      return c.json(body, status)
    }
    const beforeCreatedAt = c.req.query("beforeCreatedAt")
    const beforeRunId = c.req.query("beforeRunId")
    if ((beforeCreatedAt && !beforeRunId) || (!beforeCreatedAt && beforeRunId)) {
      const { body, status } = errorJson(
        "validation_failed",
        "beforeCreatedAt and beforeRunId must be supplied together",
        400,
      )
      return c.json(body, status)
    }
    if (beforeCreatedAt && !Number.isFinite(Date.parse(beforeCreatedAt))) {
      const { body, status } = errorJson("validation_failed", "beforeCreatedAt is invalid", 400)
      return c.json(body, status)
    }
    const proposedOnlyRaw = c.req.query("proposedOnly")
    if (proposedOnlyRaw !== undefined && !["true", "false"].includes(proposedOnlyRaw)) {
      const { body, status } = errorJson("validation_failed", "proposedOnly must be true or false", 400)
      return c.json(body, status)
    }
    const page = await listRuns(c.env.AQUILLA_PG, projectId, {
      limit,
      proposedOnly: proposedOnlyRaw === "true",
      ...(beforeCreatedAt && beforeRunId
        ? { before: { createdAt: beforeCreatedAt, runId: beforeRunId } }
        : {}),
    })
    return c.json({
      available: true,
      runs: page.runs.map((run) => runSnapshot(run, { proposedDrafts: run.proposedDrafts })),
      truncated: page.truncated,
      nextCursor: page.nextCursor,
    })
  }
  const targetLang = c.req.query("targetLang") ?? ""
  return cachedPollJson(c, projectId, `runs?fileId=${fileId}&targetLang=${targetLang}`, async () => {
    const active = await getActiveRun(c.env.AQUILLA_PG, projectId, fileId, targetLang)
    const latest = active
      ? null
      : (await listRuns(c.env.AQUILLA_PG, projectId, { fileId, targetLang, limit: 1 })).runs[0] ?? null
    const run = active ?? latest
    const steering = run
      ? await readUnconsumedSteering(c.env.AQUILLA_PG, { projectId, fileId, runId: run.id })
      : []
    const [draftCounts, runDraftCounts] = await Promise.all([
      countDrafts(c.env.AQUILLA_PG, projectId, fileId, targetLang),
      run
        ? countDraftsByRun(c.env.AQUILLA_PG, projectId, run.id)
        : Promise.resolve({ proposed: 0, applied: 0, rejected: 0, superseded: 0 }),
    ])
    const activeDirections = steering.filter((s) => s.kind === "direction").map((s) => s.body)
    return {
      available: true,
      run: run
        ? runSnapshot(run, { activeDirections, proposedDrafts: runDraftCounts.proposed })
        : null,
      // Kept at the top level too for consumers that never look inside `run`.
      activeDirections,
      draftCounts,
    }
  })
})

// GET /:projectId/contextual/runs/:runId/activity — durable inspector bundle
// (VIEWER). Events are the latest bounded tail in chronological order;
// evidence rows are likewise capped and make truncation explicit.
contextual.get("/:projectId/contextual/runs/:runId/activity", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const runId = c.req.param("runId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const run = await getRun(c.env.AQUILLA_PG, runId)
  if (!run || run.projectId !== projectId) {
    const { body, status } = errorJson("not_found", `run ${runId} not found`, 404)
    return c.json(body, status)
  }

  const evidenceLimit = CONTEXTUAL_EVENT_LIST_LIMIT
  const draftStatusRaw = c.req.query("draftStatus")
  const draftStatuses = ["proposed", "applied", "rejected", "superseded"] as const
  if (draftStatusRaw !== undefined && !(draftStatuses as readonly string[]).includes(draftStatusRaw)) {
    const { body, status } = errorJson("validation_failed", "draftStatus is invalid", 400)
    return c.json(body, status)
  }
  const draftStatus = draftStatusRaw as typeof draftStatuses[number] | undefined
  const draftLimitRaw = c.req.query("draftLimit")
  const draftLimit = draftLimitRaw === undefined ? evidenceLimit : Number(draftLimitRaw)
  if (!Number.isInteger(draftLimit) || draftLimit < 1 || draftLimit > evidenceLimit) {
    const { body, status } = errorJson(
      "validation_failed",
      `draftLimit must be an integer from 1 to ${evidenceLimit}`,
      400,
    )
    return c.json(body, status)
  }
  const draftBeforeCreatedAt = c.req.query("draftBeforeCreatedAt")
  const draftBeforeId = c.req.query("draftBeforeId")
  if ((draftBeforeCreatedAt && !draftBeforeId) || (!draftBeforeCreatedAt && draftBeforeId)) {
    const { body, status } = errorJson(
      "validation_failed",
      "draftBeforeCreatedAt and draftBeforeId must be supplied together",
      400,
    )
    return c.json(body, status)
  }
  if (draftBeforeCreatedAt && !Number.isFinite(Date.parse(draftBeforeCreatedAt))) {
    const { body, status } = errorJson("validation_failed", "draftBeforeCreatedAt is invalid", 400)
    return c.json(body, status)
  }
  const scope = `activity:${runId}?draftStatus=${draftStatus ?? ""}&draftLimit=${draftLimit}` +
    `&draftBeforeCreatedAt=${draftBeforeCreatedAt ?? ""}&draftBeforeId=${draftBeforeId ?? ""}`
  return cachedPollJson(c, projectId, scope, async () => {
    const [activity, briefRows, draftPage, runDraftCounts] = await Promise.all([
      listContextualRunEvents(c.env.AQUILLA_PG, { projectId, runId, limit: evidenceLimit }),
      listSceneBriefsByRun(c.env.AQUILLA_PG, projectId, runId, evidenceLimit + 1),
      listDraftPageByRun(c.env.AQUILLA_PG, projectId, runId, {
        limit: draftLimit,
        ...(draftStatus ? { status: draftStatus } : {}),
        ...(draftBeforeCreatedAt && draftBeforeId
          ? { before: { createdAt: draftBeforeCreatedAt, draftId: draftBeforeId } }
          : {}),
      }),
      countDraftsByRun(c.env.AQUILLA_PG, projectId, runId),
    ])
    const briefsTruncated = briefRows.length > evidenceLimit
    const truncatedCollections = {
      events: activity.truncated,
      sceneBriefs: briefsTruncated,
      drafts: draftPage.truncated,
    }
    const sceneBriefs = briefsTruncated ? briefRows.slice(-evidenceLimit) : briefRows
    let labelled = {
      events: activity.events,
      sceneBriefs,
      drafts: draftPage.drafts,
    }
    try {
      const cells = await loadCellDisplayIndex(c.env.AQUILLA_PG, projectId, run.fileId)
      labelled = decorateActivityLabels(labelled, cells)
    } catch (err) {
      console.warn(`[contextual] activity label lookup failed for run ${runId}:`, err)
    }
    return {
      run: runSnapshot(run, { proposedDrafts: runDraftCounts.proposed }),
      events: labelled.events,
      sceneBriefs: labelled.sceneBriefs,
      drafts: labelled.drafts,
      draftCounts: runDraftCounts,
      draftNextCursor: draftPage.nextCursor,
      truncated: Object.values(truncatedCollections).some(Boolean),
      truncatedCollections,
    }
  })
})

// POST /:projectId/contextual/runs/:runId/pause|resume|terminate — guarded
// transitions (CONTRIBUTOR). Resume re-kicks the tick loop.
contextual.post("/:projectId/contextual/runs/:runId/:action", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const runId = c.req.param("runId") ?? ""
  const action = c.req.param("action") ?? ""
  if (!["pause", "resume", "terminate"].includes(action)) {
    const { body, status } = errorJson("not_found", `unknown action "${action}"`, 404)
    return c.json(body, status)
  }
  const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
  if (!gate.ok) return gate.res

  const run = await getRun(c.env.AQUILLA_PG, runId)
  if (!run || run.projectId !== projectId) {
    const { body, status } = errorJson("not_found", `run ${runId} not found`, 404)
    return c.json(body, status)
  }

  const result =
    action === "pause"
      ? await requestPause(c.env.AQUILLA_PG, runId)
      : action === "resume"
        ? await resumeRun(c.env.AQUILLA_PG, runId)
        : await terminateRun(c.env.AQUILLA_PG, runId)
  if (result.status === "not_found") {
    const { body, status } = errorJson("not_found", `run ${runId} not found`, 404)
    return c.json(body, status)
  }
  if (result.status === "invalid_state") {
    const { body, status } = errorJson(
      "invalid_state",
      `cannot ${action} a ${result.current} run`,
      409,
      { current: result.current },
    )
    return c.json(body, status)
  }

  await publishRunStateOutsideTick(c.env, c.env.AQUILLA_PG, projectId, result.run)
  if (action === "resume") kickLoop(c, projectId, runId)
  const draftCounts = await countDraftsByRun(c.env.AQUILLA_PG, projectId, runId)
  return c.json({ run: runSnapshot(result.run, { proposedDrafts: draftCounts.proposed }) })
})

const steeringSchema = z.object({
  kind: z.enum(["direction", "refresh_span", "note"]),
  body: z.string().min(1),
  fileId: z.string().optional(),
  runId: z.string().optional(),
})

// POST /:projectId/contextual/steering — append steering (CONTRIBUTOR). A
// parked run on the target file wakes and re-kicks so the steering applies.
contextual.post(
  "/:projectId/contextual/steering",
  authMiddleware,
  zValidator("json", steeringSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res

    const user = c.get("user")
    const body = c.req.valid("json")
    const target = body.runId
      ? await getRun(c.env.AQUILLA_PG, body.runId)
      : body.fileId
        ? await getActiveRun(c.env.AQUILLA_PG, projectId, body.fileId)
        : null
    if (body.kind === "refresh_span") {
      const brief = await getSceneBrief(c.env.AQUILLA_PG, body.body.trim())
      if (
        !target ||
        target.projectId !== projectId ||
        (body.fileId !== undefined && body.fileId !== target.fileId) ||
        !brief ||
        brief.projectId !== projectId ||
        brief.fileId !== target.fileId ||
        brief.targetLang !== target.targetLang
      ) {
        const { body: err, status } = errorJson(
          "validation_failed",
          "refresh_span must reference a scene brief from the target run's file and language lane",
          400,
        )
        return c.json(err, status)
      }
    }
    const result = await appendSteering(c.env.AQUILLA_PG, {
      projectId,
      fileId: body.fileId ?? null,
      runId: body.runId ?? null,
      kind: body.kind,
      body: body.body,
      createdBy: user.username,
    })
    if (result.status === "validation_failed") {
      const { body: err, status } = errorJson("validation_failed", result.message, 400)
      return c.json(err, status)
    }

    // Wake a parked run so the new steering is consumed promptly.
    let woken: string | null = null
    if (target && target.projectId === projectId) {
      await appendActivitySafely(c.env.AQUILLA_PG, {
        runId: target.id,
        projectId,
        fileId: target.fileId,
        kind: "steering_queued",
        status: "queued",
        details: { steeringId: result.entry.id, steeringKind: result.entry.kind },
      })
    }
    if (target && target.projectId === projectId && target.status === "parked") {
      const resumed = await resumeRun(c.env.AQUILLA_PG, target.id)
      if (resumed.status === "ok") {
        woken = target.id
        await publishRunStateOutsideTick(c.env, c.env.AQUILLA_PG, projectId, resumed.run)
        kickLoop(c, projectId, target.id)
      }
    }
    // Steering changes `activeDirections`/activity without a frame unless it
    // wakes a parked run — invalidate unconditionally.
    invalidateContextualReads(projectId)
    return c.json({ steering: result.entry, ...(woken ? { wokeRunId: woken } : {}) }, 201)
  },
)

// GET /:projectId/contextual/drafts?fileId=&status=&targetLang= — staged drafts (VIEWER).
contextual.get("/:projectId/contextual/drafts", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  const fileId = c.req.query("fileId")
  if (!fileId) {
    const { body, status } = errorJson("validation_failed", "fileId is required", 400)
    return c.json(body, status)
  }
  const statusParam = c.req.query("status")
  if (statusParam && !["proposed", "applied", "rejected", "superseded"].includes(statusParam)) {
    const { body, status } = errorJson("validation_failed", `unknown status "${statusParam}"`, 400)
    return c.json(body, status)
  }
  const drafts = await listDrafts(
    c.env.AQUILLA_PG,
    projectId,
    fileId,
    statusParam as "proposed" | "applied" | "rejected" | "superseded" | undefined,
    c.req.query("targetLang") ?? "",
  )
  return c.json({ drafts })
})

const reviewSchema = z.object({ action: z.enum(["applied", "rejected"]) })

// POST /:projectId/contextual/drafts/:draftId/review — rejection handshake and
// rolling-client compatibility (CONTRIBUTOR). Current clients let the winning
// target projection mark acceptance; an older `applied` report is acknowledged
// only after that exact text is already authoritative in the owning lane.
contextual.post(
  "/:projectId/contextual/drafts/:draftId/review",
  authMiddleware,
  zValidator("json", reviewSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const draftId = c.req.param("draftId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res

    const user = c.get("user")
    const { action } = c.req.valid("json")
    // Project scoping: never review across projects through a guessed id.
    const scoped = await c.env.AQUILLA_PG
      .prepare("SELECT project_id FROM contextual_drafts WHERE id = ?")
      .bind(draftId)
      .first<{ project_id: string }>()
    if (!scoped || scoped.project_id !== projectId) {
      const { body, status } = errorJson("not_found", `draft ${draftId} not found`, 404)
      return c.json(body, status)
    }
    const result = await reviewDraft(c.env.AQUILLA_PG, {
      id: draftId,
      action,
      reviewedBy: user.username,
    })
    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `draft ${draftId} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "not_projected") {
      const { body, status } = errorJson(
        "not_projected",
        "The target commit has not been applied yet. Wait for sync to finish, then retry.",
        409,
      )
      return c.json(body, status)
    }
    if (result.status === "invalid_state") {
      const { body, status } = errorJson(
        "invalid_state",
        `draft is ${result.current}, only proposed drafts can be reviewed`,
        409,
        { current: result.current },
      )
      return c.json(body, status)
    }
    if (result.status === "already") {
      return c.json({ draft: result.draft })
    }
    await appendActivitySafely(c.env.AQUILLA_PG, {
      runId: result.draft.runId,
      projectId,
      fileId: result.draft.fileId,
      kind: "draft_reviewed",
      status: result.draft.status === "applied" ? "applied" : "rejected",
      details: {
        draftId: result.draft.id,
        cellId: result.draft.cellId,
        outcome: result.draft.status === "applied" ? "applied" : "rejected",
      },
    })
    // No live frame carries a review decision — drop the cached polls by hand.
    invalidateContextualReads(projectId)
    return c.json({ draft: result.draft })
  },
)


// ── Segmentation ────────────────────────────────────────────────────────────
//
// One row per file, no target_lang: segmentation is a property of the SOURCE,
// so every language lane of a file reads the same boundaries.
//
// The GET returns the EFFECTIVE segmentation, not just the stored setting —
// resolved through the same `resolveSpanSeeds` the run itself calls, so the
// preview a translator approves is the segmentation the autopilot will use.
// A preview computed by a second, parallel implementation would drift, and it
// would drift silently.

/** Preview spans returned inline. A long book segments into a few hundred;
 *  the count is always exact, the list is a sample. */
const SEGMENTATION_PREVIEW_LIMIT = 60

function parseSegmentationPreviewQuery(
  strategy: string | undefined,
  fixedSizeRaw: string | undefined,
): SegmentationPreviewQuery | { error: string } | undefined {
  if (!strategy) return undefined
  if (strategy !== "auto" && strategy !== "fixed") {
    return { error: "strategy must be auto or fixed" }
  }
  if (strategy === "auto") return { strategy: "auto" }
  const fixedSize = Number.parseInt(fixedSizeRaw ?? "", 10)
  if (!Number.isFinite(fixedSize) || fixedSize < MIN_SEGMENT_SIZE || fixedSize > MAX_SEGMENT_SIZE) {
    return { error: `fixedSize must be between ${MIN_SEGMENT_SIZE} and ${MAX_SEGMENT_SIZE}` }
  }
  return { strategy: "fixed", fixedSize }
}

function spanExcerpt(startCellId: string, pairs: { cellId: string; source: string }[]): string {
  const source = pairs.find((pair) => pair.cellId === startCellId)?.source ?? ""
  return source.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
}

const segmentationBoundarySchema = z.object({
  startCellId: z.string().min(1),
  endCellId: z.string().min(1),
  title: z.string().optional(),
  gist: z.string().optional(),
  depth: z.number().optional(),
})

const segmentationSchema = z
  .object({
    strategy: z.enum(["auto", "fixed", "explicit"]),
    fixedSize: z.number().optional(),
    boundaries: z.array(segmentationBoundarySchema).max(MAX_BOUNDARIES).optional(),
    note: z.string().max(MAX_NOTE_CHARS).optional(),
  })
  .strict()

contextual.get("/:projectId/contextual/segmentation", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  const fileId = c.req.query("fileId")
  if (!fileId) {
    const { body, status } = errorJson("validation_failed", "fileId is required", 400)
    return c.json(body, status)
  }

  const preview = parseSegmentationPreviewQuery(c.req.query("strategy"), c.req.query("fixedSize"))
  if (preview && "error" in preview) {
    const { body, status } = errorJson("validation_failed", preview.error, 400)
    return c.json(body, status)
  }

  const db = c.env.AQUILLA_PG
  const [segmentation, pairs] = await Promise.all([
    getFileSegmentation(db, projectId, fileId),
    selectCellPairs(db, projectId, { fileId }),
  ])
  const seeds = await resolveSpanSeeds(db, projectId, fileId, pairs, preview)
  const order = new Map(pairs.map((p, i) => [p.cellId, i]))
  const spans = seeds.map((seed) => {
    const start = order.get(seed.startCellId)
    const end = order.get(seed.endCellId)
    const rawLabel = spanLabel(seed, pairs)
    return {
      startCellId: seed.startCellId,
      endCellId: seed.endCellId,
      seedSource: seed.seedSource,
      cellCount: start === undefined || end === undefined ? 0 : end - start + 1,
      label: rawLabel ? friendlyScriptureLabel(rawLabel) : rawLabel,
      excerpt: spanExcerpt(seed.startCellId, pairs),
    }
  })

  return c.json({
    segmentation,
    limits: { minSize: MIN_SEGMENT_SIZE, maxSize: MAX_SEGMENT_SIZE, maxBoundaries: MAX_BOUNDARIES },
    effective: {
      // Which branch actually produced these spans — 'explicit' means the
      // stored list was used, anything else means it was derived.
      seedSource: spans[0]?.seedSource ?? "chunk",
      spanCount: spans.length,
      cellCount: pairs.length,
      spans: spans.slice(0, SEGMENTATION_PREVIEW_LIMIT),
      truncated: spans.length > SEGMENTATION_PREVIEW_LIMIT,
    },
  })
})

// PUT — changing how a file is cut up changes what every future run drafts, so
// it sits at the same floor as the project's other structural settings.
contextual.put(
  "/:projectId/contextual/segmentation",
  authMiddleware,
  zValidator("json", segmentationSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res
    const fileId = c.req.query("fileId")
    if (!fileId) {
      const { body, status } = errorJson("validation_failed", "fileId is required", 400)
      return c.json(body, status)
    }

    const db = c.env.AQUILLA_PG
    const input = c.req.valid("json") as SegmentationInput
    // Explicit boundaries are checked against the file's real ordered cells;
    // 'auto'/'fixed' do not need them, so only pay for the read when they do.
    const orderedCellIds =
      input.strategy === "explicit"
        ? (await selectCellPairs(db, projectId, { fileId })).map((p) => p.cellId)
        : []
    const checked = validateSegmentationInput(input, orderedCellIds)
    if (!checked.ok) {
      const { body, status } = errorJson("validation_failed", checked.error, 400)
      return c.json(body, status)
    }

    const user = c.get("user")
    const segmentation = await setFileSegmentation(
      db,
      projectId,
      fileId,
      { ...checked.value, humanEdited: true },
      user.username ?? null,
    )
    return c.json({ segmentation })
  },
)

// POST /:projectId/contextual/segmentation/generate — have a fast-tier model
// find the passages, store them as an explicit boundary list.
//
// PROJECT_LEAD, and guarded like every other paid surface here: model
// allowlist, org credit cap, word cap — all BEFORE any tokens are spent.
//
// The pass proposes break points; `buildBoundaries` turns them into the
// segmentation, so contiguity and coverage are structural. The result still
// goes through `validateSegmentationInput` before it is stored: a generator
// writing straight to the table would be the one path into this row that skips
// the check every other path takes.
contextual.post(
  "/:projectId/contextual/segmentation/generate",
  authMiddleware,
  zValidator("json", z.object({ note: z.string().max(MAX_NOTE_CHARS).optional() }).strict()),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res
    const fileId = c.req.query("fileId")
    if (!fileId) {
      const { body, status } = errorJson("validation_failed", "fileId is required", 400)
      return c.json(body, status)
    }
    if (!c.env.OPENROUTER_API_KEY) {
      const { body, status } = errorJson("not_configured", "OPENROUTER_API_KEY is not configured", 500)
      return c.json(body, status)
    }

    const db = c.env.AQUILLA_PG
    const user = c.get("user")
    const { note } = c.req.valid("json")

    const settings = await getPlatformSettingsCached(c.env)
    const models = resolveContextualModels(c.env, settings)
    // The FAST tier is the whole point of this surface — guard the model it
    // will actually call, not the one the drafting pipeline uses.
    const guard = await runAiGuard(models.fast, user.id, db, c.env)
    if (!guard.ok) return c.json(guard.body, guard.status)

    let orgId = 0
    try {
      const projectRow = await db
        .prepare("SELECT org_id FROM projects WHERE id = ?")
        .bind(projectId)
        .first<{ org_id: number | null }>()
      orgId = projectRow?.org_id ?? 0
    } catch {
      /* best-effort — degrade to org 0 */
    }
    const credit = await creditGuard(db, c.env, orgId, "agent")
    if (!credit.ok) {
      const { body: err, status } = errorJson(
        "credit_cap_exceeded",
        "Agent credit cap reached. Contact your org admin.",
        429,
        { reason: credit.reason },
      )
      return c.json(err, status)
    }
    const words = await wordGuard(db, orgId)
    if (!words.ok) return c.json(wordCapBody(words.reason), 429)

    const pairs = await selectCellPairs(db, projectId, { fileId })
    if (pairs.length === 0) {
      const { body, status } = errorJson("validation_failed", "this file has no source cells", 400)
      return c.json(body, status)
    }

    const meter = makeCostMeter(c.env, db)
    const llm = makeLlmCall({
      url: resolveOpenRouterUrl(c.env),
      apiKey: c.env.OPENROUTER_API_KEY,
      models,
      signal: c.req.raw.signal,
      onUsage: (usage) => {
        meter.add({
          surface: "autopilot",
          runId: `segment:${fileId}`,
          projectId,
          kind: "llm",
          label: usage.label,
          tier: usage.tier,
          model: usage.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          costCents: usage.costCents,
          latencyMs: usage.latencyMs,
          ok: usage.ok,
        })
      },
    })

    let result: Awaited<ReturnType<typeof segmentWithModel>>
    try {
      result = await segmentWithModel({
        pairs,
        llm,
        ...(note ? { note } : {}),
      })
    } catch (err) {
      console.error(`[contextual] segmentation pass failed for ${fileId}:`, err)
      const { body, status } = errorJson(
        "segmentation_failed",
        "The segmentation model could not be reached. Nothing was changed.",
        502,
      )
      return c.json(body, status)
    } finally {
      await meter.flush()
    }

    if (result.boundaries.length === 0) {
      const { body, status } = errorJson(
        "segmentation_failed",
        "The segmentation model returned nothing usable. Nothing was changed.",
        502,
      )
      return c.json(body, status)
    }

    const checked = validateSegmentationInput(
      {
        strategy: "explicit",
        boundaries: result.boundaries,
        generatedBy: "model",
        modelId: models.fast,
        ...(note ? { note } : {}),
      },
      pairs.map((p) => p.cellId),
    )
    if (!checked.ok) {
      // Structurally this should not happen — buildBoundaries constructs the
      // segments — so a failure here means a real defect, not bad model
      // output. Refuse rather than store something the run cannot trust.
      console.error(`[contextual] generated boundaries failed validation for ${fileId}: ${checked.error}`)
      const { body, status } = errorJson(
        "segmentation_failed",
        "The generated passages did not cover the file. Nothing was changed.",
        500,
      )
      return c.json(body, status)
    }

    // humanEdited stays false: a person ASKED for this, but did not author the
    // boundaries. The pin is what stops a later automated pass overwriting a
    // person's own division, and this is not one.
    const segmentation = await setFileSegmentation(db, projectId, fileId, checked.value, user.username ?? null)
    return c.json({
      segmentation,
      generated: { passageCount: result.boundaries.length, calls: result.calls, notes: result.notes },
    })
  },
)

export default contextual
