// Contextual translation run control (design §8, slice D1). Mounted at
// /api/v2/projects in src/index.ts:
//
//   POST /:projectId/contextual/runs                      start a run (CONTRIBUTOR)
//   GET  /:projectId/contextual/runs?fileId=              snapshot for the pill (VIEWER)
//   POST /:projectId/contextual/runs/:runId/pause|resume|terminate
//   POST /:projectId/contextual/steering                  direction / refresh_span / note
//   GET  /:projectId/contextual/drafts?fileId=            staged drafts (VIEWER)
//   POST /:projectId/contextual/drafts/:draftId/review    {action: applied|rejected}
//
// v1 execution (documented deviation): no Workflows binding — POST /runs kicks
// selfTickLoop via executionCtx.waitUntil; the loop drives lib/contextual/tick
// runOneTick until the run pauses/parks/fails or a safety cap, on its OWN
// makePostgres connection (the request-scoped AQUILLA_PG shim closes when the
// Response returns — same gotcha as routes/agent.ts). All run state lives in
// Postgres, so a dropped loop resumes exactly where it stopped.

import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE, type Env } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { runAiGuard } from "../lib/ai-budget"
import { getPlatformSettingsCached } from "../lib/platform-settings"
import { creditGuard } from "../lib/credits"
import { notifySyncWorkerOfContextualActivity } from "../services/sync-worker-notify"
import { makePostgres, type AquillaDb } from "../../../db/shim/postgres"
import {
  createRun,
  getRun,
  getActiveRun,
  listRuns,
  requestPause,
  resumeRun,
  terminateRun,
  parkRun,
  failRun,
  appendSteering,
  readUnconsumedSteering,
  listDrafts,
  countDrafts,
  reviewDraft,
  claimStrandedRuns,
  listAutopilotCandidateFiles,
  getProjectAutopilotSummary,
  type ContextualRun,
} from "../../../db/shared/contextual-runs"
import {
  runOneTick,
  makeLlmCall,
  resolveContextualModels,
  resolveOpenRouterUrl,
  runStateFrame,
  type ContextualProgressFrame,
} from "../lib/contextual/tick"

const contextual = new Hono<AuthHonoEnv>()

/** Safety cap on server-side self-continuation. A run longer than this PARKS
 *  where it stands — it must never simply fall out of the loop still marked
 *  'running', because `resumeRun` refuses a running run and nothing could then
 *  restart it. Parked-with-spans-left is a state the sweeper knows how to
 *  wake, so long files finish unattended. */
const MAX_WAVES_PER_LOOP = 50

/** Total spans one project-wide start may drive at once, across every file.
 *  Per-file wave width is divided down to respect it — the ceiling that
 *  matters is the model provider's rate limit, not any one file's size. */
const MAX_PROJECT_CONCURRENCY = 12
/** Files a single project-wide start will fan out to. */
const MAX_PROJECT_FILES = 24

type ErrorCode =
  | "not_found"
  | "permission_denied"
  | "validation_failed"
  | "invalid_state"
  | "run_exists"
  | "credit_cap_exceeded"
  | "not_configured"

function errorJson(code: ErrorCode, message: string, status: ContentfulStatusCode, details?: unknown) {
  return {
    body: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    status,
  } as const
}

async function requireRole(
  c: Context<AuthHonoEnv>,
  projectId: string,
  floor: number,
): Promise<{ ok: true; level: number } | { ok: false; res: Response }> {
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < floor) {
    const { body, status } = errorJson(
      "permission_denied",
      "you do not have sufficient access on this project",
      403,
    )
    return { ok: false, res: c.json(body, status) }
  }
  return { ok: true, level: role.level }
}

// ── The self-continuing tick loop ───────────────────────────────────────────

/** Exposed for tests: the most recent loop's completion promise, so a test
 *  can await settled background work before asserting (the PGlite harness has
 *  no executionCtx to flush). Production code never reads this. */
export const _test: { lastLoop: Promise<void> | null } = { lastLoop: null }

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
  try {
    const settings = await getPlatformSettingsCached(env)
    const llm = makeLlmCall({
      url: resolveOpenRouterUrl(env),
      apiKey: env.OPENROUTER_API_KEY ?? "",
      models: resolveContextualModels(env, settings),
    })
    for (let wave = 0; wave < MAX_WAVES_PER_LOOP; wave++) {
      const result = await runOneTick({
        db,
        runId,
        llm,
        notify,
        ...(concurrency ? { concurrency } : {}),
      })
      if (!result.continueRun) return
    }
    // Cap reached with spans still queued. Park (never leave it 'running' with
    // no driver) so resume, steering, or the sweeper can pick it back up.
    const parked = await parkRun(db, runId)
    if (parked.status === "ok") await notify(runStateFrame(parked.run))
  } catch (err) {
    // Last-resort settlement — the run must never wedge in 'running'.
    const message = err instanceof Error ? err.message : String(err)
    try {
      const failed = await failRun(db, runId, message)
      if (failed.status === "ok") await notify(runStateFrame(failed.run))
    } catch {
      /* connection gone — the guarded transitions keep the row consistent */
    }
    console.error(`[contextual] tick loop failed for run ${runId}:`, err)
  } finally {
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
function kickLoop(
  c: Context<AuthHonoEnv>,
  projectId: string,
  runId: string,
  concurrency?: number,
): void {
  const loop = selfTickLoop(c.env, projectId, runId, concurrency)
  _test.lastLoop = loop
  try {
    c.executionCtx.waitUntil(loop)
  } catch {
    void loop.catch(() => {})
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
export async function sweepStrandedContextualRuns(env: Env, limit = 10): Promise<number> {
  const db = env.AQUILLA_PG
  if (!db) return 0
  let adopted: Awaited<ReturnType<typeof claimStrandedRuns>> = []
  try {
    adopted = await claimStrandedRuns(db, limit)
  } catch (err) {
    console.warn("[contextual] stranded-run sweep query failed:", err)
    return 0
  }
  for (const run of adopted) {
    const loop = selfTickLoop(env, run.projectId, run.id)
    _test.lastLoop = loop
    void loop.catch(() => {})
  }
  return adopted.length
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

    const roleSnapshot = { userId: user.id, username: user.username, level: gate.level }
    const lane = body.targetLang ?? ""

    // ── Project-wide start: one graph per file, all of them at once ──
    if (body.scope === "project") {
      const candidates = (
        await listAutopilotCandidateFiles(c.env.AQUILLA_PG, projectId)
      ).slice(0, MAX_PROJECT_FILES)
      if (candidates.length === 0) {
        const { body: err, status } = errorJson(
          "validation_failed",
          "no files in this project have untranslated text to draft",
          400,
        )
        return c.json(err, status)
      }
      // Divide the global ceiling across files so a 24-file fan-out doesn't
      // multiply into 144 concurrent model calls.
      const perFile = Math.max(1, Math.floor(MAX_PROJECT_CONCURRENCY / candidates.length))
      const scopeGroup = crypto.randomUUID()
      const started: { runId: string; fileId: string }[] = []
      const skipped: { fileId: string; reason: string }[] = []
      for (const file of candidates) {
        const made = await createRun(c.env.AQUILLA_PG, {
          projectId,
          fileId: file.fileId,
          targetLang: lane,
          initiatedBy: user.username,
          roleSnapshot,
          scopeGroup,
          ...(body.anchorCellId ? { anchorCellId: body.anchorCellId } : {}),
        })
        if (made.status === "active_exists") {
          // Already running is not a failure — it is the same work in flight.
          skipped.push({ fileId: file.fileId, reason: "already running" })
          continue
        }
        await notifySyncWorkerOfContextualActivity(c.env, projectId, runStateFrame(made.run))
        kickLoop(c, projectId, made.run.id, perFile)
        started.push({ runId: made.run.id, fileId: file.fileId })
      }
      return c.json({ scope: "project", scopeGroup, started, skipped }, 201)
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

    await notifySyncWorkerOfContextualActivity(c.env, projectId, runStateFrame(created.run))
    kickLoop(c, projectId, created.run.id)
    return c.json({ runId: created.run.id, run: created.run }, 201)
  },
)

// GET /:projectId/contextual/overview — project-wide autopilot rollup for the
// PM surface (VIEWER: read-only observability, not a control).
contextual.get("/:projectId/contextual/overview", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  const summary = await getProjectAutopilotSummary(c.env.AQUILLA_PG, projectId)
  return c.json({ available: true, ...summary })
})

/** Snapshot shape the pill hydrates from (mirrors run-store's expectations). */
function runSnapshot(run: ContextualRun, activeDirections: string[] = []) {
  return {
    runId: run.id,
    fileId: run.fileId,
    status: run.status,
    targetLang: run.targetLang,
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
    const runs = await listRuns(c.env.AQUILLA_PG, projectId)
    return c.json({ available: true, runs: runs.map((run) => runSnapshot(run)) })
  }
  const targetLang = c.req.query("targetLang") ?? ""
  const active = await getActiveRun(c.env.AQUILLA_PG, projectId, fileId, targetLang)
  const run = active ?? (await listRuns(c.env.AQUILLA_PG, projectId, fileId))[0] ?? null
  const steering = run
    ? await readUnconsumedSteering(c.env.AQUILLA_PG, { projectId, fileId, runId: run.id })
    : []
  const draftCounts = await countDrafts(c.env.AQUILLA_PG, projectId, fileId)
  const activeDirections = steering.filter((s) => s.kind === "direction").map((s) => s.body)
  return c.json({
    available: true,
    run: run ? runSnapshot(run, activeDirections) : null,
    // Kept at the top level too for consumers that never look inside `run`.
    activeDirections,
    draftCounts,
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

  await notifySyncWorkerOfContextualActivity(c.env, projectId, runStateFrame(result.run))
  if (action === "resume") kickLoop(c, projectId, runId)
  return c.json({ run: runSnapshot(result.run) })
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
    const target = body.runId
      ? await getRun(c.env.AQUILLA_PG, body.runId)
      : body.fileId
        ? await getActiveRun(c.env.AQUILLA_PG, projectId, body.fileId)
        : null
    if (target && target.projectId === projectId && target.status === "parked") {
      const resumed = await resumeRun(c.env.AQUILLA_PG, target.id)
      if (resumed.status === "ok") {
        woken = target.id
        await notifySyncWorkerOfContextualActivity(c.env, projectId, runStateFrame(resumed.run))
        kickLoop(c, projectId, target.id)
      }
    }
    return c.json({ steering: result.entry, ...(woken ? { wokeRunId: woken } : {}) }, 201)
  },
)

// GET /:projectId/contextual/drafts?fileId=&status= — staged drafts (VIEWER).
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
  )
  return c.json({ drafts })
})

const reviewSchema = z.object({ action: z.enum(["applied", "rejected"]) })

// POST /:projectId/contextual/drafts/:draftId/review — the review handshake
// (CONTRIBUTOR): the client applies through its own outbox, then reports
// 'applied' (or 'rejected' to dismiss).
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
    if (result.status === "invalid_state") {
      const { body, status } = errorJson(
        "invalid_state",
        `draft is ${result.current}, only proposed drafts can be reviewed`,
        409,
        { current: result.current },
      )
      return c.json(body, status)
    }
    return c.json({ draft: result.draft })
  },
)

export default contextual
