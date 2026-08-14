/**
 * transport.ts — real ContextualTransport against the auth-worker contextual
 * run routes (contextual translation pipeline, slice D2). Mirrors
 * src/lib/agent/memory-api.ts conventions: AUTH_BASE + fetchWithTimeout +
 * `Authorization: Bearer <jwt>`, thrown Error subclasses on non-OK responses.
 *
 * Routes (being built in a parallel slice — coded to the contract, see the
 * slice D2 notes; if the server shapes drift, update here):
 *
 *   GET  /api/v2/projects/:projectId/contextual/runs?fileId=<id>
 *        → { run: ContextualRunSnapshot | null }
 *   GET  /api/v2/projects/:projectId/contextual/runs
 *        → { runs: ContextualRunRecord[] }
 *   GET  /api/v2/projects/:projectId/contextual/runs/:id/activity
 *        → { run, events, sceneBriefs, drafts, truncated }
 *          404/501 → the backend isn't deployed for this project: snapshot
 *          reports { available: false } instead of throwing.
 *   POST /api/v2/projects/:projectId/contextual/runs        { fileId } → { runId }
 *   POST /api/v2/projects/:projectId/contextual/runs/:id/pause
 *   POST /api/v2/projects/:projectId/contextual/runs/:id/resume
 *   POST /api/v2/projects/:projectId/contextual/runs/:id/terminate
 *   POST /api/v2/projects/:projectId/contextual/runs/:id/steering  { text }
 *
 * The ContextualTransport interface addresses pause/resume/terminate by runId
 * only, but the routes are project-scoped — so this module remembers the
 * projectId each runId was seen under (via fetchSnapshot/start). The store
 * mirrors a single run at a time, so this map stays tiny; it is cleared on
 * resetContextualTransportForTesting().
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import { loadSession } from "@/lib/frontier/session-store"
import {
  setContextualTransport,
  type ContextualRunSnapshot,
  type ContextualTransport,
  type ContextualTransportSnapshot,
} from "./run-store"

// ── Typed errors ────────────────────────────────────────────────────────────

/** Generic non-OK response from a contextual run route. */
export class ContextualApiError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** No active session — the caller should be behind auth, so this indicates a
 * signed-out tab (e.g. session cleared in another tab). */
export class ContextualAuthError extends ContextualApiError {
  constructor(message = "You need to be signed in to use contextual drafting.") {
    super(message, 401)
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string }
}

async function throwFromResponse(res: Response, fallback: string): Promise<never> {
  let body: ErrorEnvelope | null = null
  try {
    body = (await res.json()) as ErrorEnvelope
  } catch {
    // non-JSON error body — fall through to generic error
  }
  const message = body?.error?.message ?? fallback
  throw new ContextualApiError(`${fallback}: HTTP ${res.status} — ${message}`, res.status)
}

// ── Plumbing ────────────────────────────────────────────────────────────────

async function requireJwt(): Promise<string> {
  const session = await loadSession()
  const jwt = session?.jwt
  if (!jwt) throw new ContextualAuthError()
  return jwt
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}

function runsBase(projectId: string): string {
  return `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/runs`
}

/** runId → projectId, recorded when a run is observed (snapshot) or started.
 * Needed because the transport interface addresses runs by id alone. */
const runProjects = new Map<string, string>()

function projectForRun(runId: string): string {
  const projectId = runProjects.get(runId)
  if (!projectId) {
    // Should not happen in practice: the store only exposes runIds it got
    // from this transport's fetchSnapshot/start. Fail loudly, not silently.
    throw new ContextualApiError(`unknown run ${runId} — no project recorded for it`, 0)
  }
  return projectId
}

async function postRunCommand(runId: string, command: "pause" | "resume" | "terminate"): Promise<void> {
  const projectId = projectForRun(runId)
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${runsBase(projectId)}/${encodeURIComponent(runId)}/${command}`,
    { method: "POST", headers: authHeaders(jwt) },
  )
  if (!res.ok) return throwFromResponse(res, `${command} run failed`)
}

// ── Transport ───────────────────────────────────────────────────────────────

export const realContextualTransport: ContextualTransport = {
  async fetchSnapshot(projectId: string, fileId: string, targetLang = ""): Promise<ContextualTransportSnapshot> {
    const jwt = await requireJwt()
    const laneQuery = targetLang
      ? `&targetLang=${encodeURIComponent(targetLang)}`
      : ""
    const res = await fetchWithTimeout(
      `${runsBase(projectId)}?fileId=${encodeURIComponent(fileId)}${laneQuery}`,
      { headers: authHeaders(jwt) },
    )
    // Route not deployed / feature not enabled server-side: report the
    // backend as unavailable so the pill renders its setup state.
    if (res.status === 404 || res.status === 501) return { available: false }
    if (!res.ok) return throwFromResponse(res, "fetch contextual run failed")
    const { run } = (await res.json()) as { run?: ContextualRunSnapshot | null }
    if (run) runProjects.set(run.runId, projectId)
    return { available: true, run: run ?? null }
  },

  async start(
    projectId: string,
    fileId: string,
    anchorCellId?: string,
    targetLang = "",
  ): Promise<{ runId: string }> {
    const jwt = await requireJwt()
    const res = await fetchWithTimeout(runsBase(projectId), {
      method: "POST",
      headers: authHeaders(jwt),
      // The anchor rotates the first wave to start where the user is looking.
      body: JSON.stringify({
        fileId,
        ...(anchorCellId ? { anchorCellId } : {}),
        ...(targetLang ? { targetLang } : {}),
      }),
    })
    if (!res.ok) return throwFromResponse(res, "start contextual run failed")
    const { runId } = (await res.json()) as { runId: string }
    runProjects.set(runId, projectId)
    return { runId }
  },

  pause: (runId) => postRunCommand(runId, "pause"),
  resume: (runId) => postRunCommand(runId, "resume"),
  terminate: (runId) => postRunCommand(runId, "terminate"),
}

// ── Drafts: the run's actual output ─────────────────────────────────────────

export interface ContextualDraftRecord {
  draftId: string
  runId: string
  cellId: string
  text: string
  spanLabel?: string
}

interface DraftListRow {
  id: string
  runId: string
  cellId: string
  text: string
  provenance?: { spanId?: string } | null
}

/**
 * Pending drafts for a file. The WebSocket burst is the fast path; this is the
 * authoritative one, used on file open, on reconnect, and whenever a frame
 * reports it was truncated. Returns [] rather than throwing when the backend
 * isn't deployed — a missing review surface must not break opening a file.
 */
export async function fetchContextualDrafts(
  projectId: string,
  fileId: string,
  targetLang = "",
): Promise<ContextualDraftRecord[]> {
  const jwt = await requireJwt()
  const laneQuery = targetLang
    ? `&targetLang=${encodeURIComponent(targetLang)}`
    : ""
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/drafts` +
      `?fileId=${encodeURIComponent(fileId)}&status=proposed${laneQuery}`,
    { headers: authHeaders(jwt) },
  )
  if (res.status === 404 || res.status === 501) return []
  if (!res.ok) return throwFromResponse(res, "fetch contextual drafts failed")
  const { drafts } = (await res.json()) as { drafts?: DraftListRow[] }
  return (drafts ?? []).map((d) => ({
    draftId: d.id,
    runId: d.runId,
    cellId: d.cellId,
    text: d.text,
    ...(d.provenance?.spanId ? { spanLabel: d.provenance.spanId } : {}),
  }))
}

/**
 * Report a decision on a draft. This is a REPORT, not a gate: the caller has
 * already applied the text through its own outbox (or dismissed it), exactly
 * as a human edit would. Failure is logged, never surfaced as a blocked
 * action — the user's edit already landed.
 */
export async function reviewContextualDraft(
  projectId: string,
  draftId: string,
  action: "applied" | "rejected",
): Promise<void> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/drafts/` +
      `${encodeURIComponent(draftId)}/review`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ action }) },
  )
  if (!res.ok) return throwFromResponse(res, "review contextual draft failed")
}

// ── Project-wide autopilot (PM surface) ─────────────────────────────────────

export interface ContextualOverviewFile {
  fileId: string
  runId: string
  /** Durable run lane. Empty string is the only startable Autopilot lane;
   * non-empty values remain visible for inspecting historic runs. */
  targetLang?: string
  status: string
  doneSpans: number
  totalSpans: number
  failedSpans: number
  unitsSpent: number
  proposedDrafts: number
  appliedDrafts: number
  updatedAt: string
  lastError: string | null
}

export type ReadinessLevel = "ready" | "partial" | "missing"

export interface ReadinessItem {
  id: string
  label: string
  level: ReadinessLevel
  detail: string
  /** Project-relative path to go fix it. */
  href?: string
}

/** What autopilot knows about this project — the context an expert translator
 *  would have on the desk before drafting a line. */
export interface ContextReadiness {
  items: ReadinessItem[]
  blockingGaps: number
  ready: boolean
}

export interface ContextualOverview {
  available: boolean
  files: ContextualOverviewFile[]
  activeRuns: number
  doneSpans: number
  totalSpans: number
  failedSpans: number
  unitsSpent: number
  proposedDrafts: number
  appliedDrafts: number
  readiness?: ContextReadiness
}

/** Durable run metadata used by the activity inspector. The endpoint has
 * evolved from raw database field names (`id`, `doneSpans`) to the pill's
 * snapshot names (`runId`, `done`), so the transport normalizes both. */
export interface ContextualRunRecord {
  runId: string
  fileId: string
  status: string
  phase: string | null
  spanLabel: string | null
  done: number
  total: number
  failed: number
  unitsSpent: number
  callsSpent: number
  lastError: string | null
  createdAt: string
  updatedAt: string
  targetLang?: string
  initiatedBy?: string | null
  scopeGroup?: string | null
  anchorCellId?: string | null
  proposedDrafts?: number
  activeDirections: string[]
}

export interface ContextualRunCursor {
  createdAt: string
  runId: string
}

export interface ContextualRunListOptions {
  cursor?: ContextualRunCursor | null
  /** Restrict history to runs that still own proposed review evidence. */
  proposedOnly?: boolean
  limit?: number
}

/** One bounded page of durable run history. */
export interface ContextualRunPage {
  available: boolean
  runs: ContextualRunRecord[]
  truncated: boolean
  nextCursor: ContextualRunCursor | null
}

export interface ContextualActivityEvent {
  id: string
  runId: string
  projectId: string
  fileId: string
  kind: string
  spanId?: string
  spanLabel?: string
  status?: string
  phase?: string
  summary: string
  details: Record<string, unknown>
  createdAt: string
}

/** Full-fidelity scene brief from the activity endpoint. Fields that the
 * inspector understands are named, while the index signature deliberately
 * keeps newer evidence fields available without coupling this client to every
 * persistence column. */
export interface ContextualActivitySceneBrief {
  id?: string
  fileId?: string
  startCellId?: string
  endCellId?: string
  status?: string
  construal?: string
  l1Summary?: string | null
  ambiguityRegister?: Array<{
    id?: string
    question?: string
    evidenceCellIds?: string[]
    note?: string
    [key: string]: unknown
  }>
  provenance?: Record<string, unknown> | null
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

/** Full-fidelity staged draft. As with scene briefs, known review/evidence
 * fields are typed and unknown future fields pass through untouched. */
export interface ContextualActivityDraft {
  id?: string
  runId?: string
  fileId?: string
  cellId?: string
  sceneBriefId?: string | null
  text?: string
  status?: string
  verdicts?: Record<string, unknown> | null
  provenance?: Record<string, unknown> | null
  createdAt?: string
  reviewedAt?: string | null
  reviewedBy?: string | null
  [key: string]: unknown
}

export type ContextualDraftStatus = "proposed" | "applied" | "rejected" | "superseded"

export interface ContextualDraftCounts {
  proposed: number
  applied: number
  rejected: number
  superseded: number
}

export interface ContextualDraftCursor {
  createdAt: string
  draftId: string
}

export interface ContextualRunActivityOptions {
  draftStatus?: ContextualDraftStatus
  draftLimit?: number
  draftCursor?: ContextualDraftCursor | null
}

export interface ContextualRunActivity {
  run: ContextualRunRecord | null
  events: ContextualActivityEvent[]
  sceneBriefs: ContextualActivitySceneBrief[]
  drafts: ContextualActivityDraft[]
  truncated: boolean
  /** Per-collection bounds for precise disclosure. New servers return these;
   * legacy aggregate `truncated: true` is conservatively mapped to all three. */
  truncatedCollections?: {
    events: boolean
    sceneBriefs: boolean
    drafts: boolean
  }
  /** Authoritative per-run totals, independent of the bounded draft page. */
  draftCounts?: ContextualDraftCounts
  /** Keyset cursor for the next draft page, or null when this page is final. */
  draftNextCursor?: ContextualDraftCursor | null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function numberValue(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function normalizeRun(value: unknown): ContextualRunRecord | null {
  const row = objectValue(value)
  if (!row) return null
  const runId = stringValue(row.runId ?? row.id)
  const fileId = stringValue(row.fileId)
  if (!runId || !fileId) return null
  const directions = Array.isArray(row.activeDirections)
    ? row.activeDirections.filter((item): item is string => typeof item === "string")
    : []
  return {
    runId,
    fileId,
    status: stringValue(row.status, "unknown"),
    phase: typeof row.phase === "string" ? row.phase : null,
    spanLabel: typeof row.spanLabel === "string" ? row.spanLabel : null,
    done: numberValue(row.done ?? row.doneSpans),
    total: numberValue(row.total ?? row.totalSpans),
    failed: numberValue(row.failed ?? row.failedSpans),
    unitsSpent: numberValue(row.unitsSpent),
    callsSpent: numberValue(row.callsSpent),
    lastError: typeof row.lastError === "string" ? row.lastError : null,
    createdAt: stringValue(row.createdAt),
    updatedAt: stringValue(row.updatedAt),
    ...(typeof row.targetLang === "string" ? { targetLang: row.targetLang } : {}),
    ...(typeof row.initiatedBy === "string" || row.initiatedBy === null
      ? { initiatedBy: row.initiatedBy }
      : {}),
    ...(typeof row.scopeGroup === "string" || row.scopeGroup === null
      ? { scopeGroup: row.scopeGroup }
      : {}),
    ...(typeof row.anchorCellId === "string" || row.anchorCellId === null
      ? { anchorCellId: row.anchorCellId }
      : {}),
    ...(row.proposedDrafts !== undefined
      ? { proposedDrafts: numberValue(row.proposedDrafts) }
      : {}),
    activeDirections: directions,
  }
}

function normalizeEvent(value: unknown): ContextualActivityEvent | null {
  const row = objectValue(value)
  if (!row) return null
  const id = stringValue(row.id)
  const runId = stringValue(row.runId)
  const projectId = stringValue(row.projectId)
  const fileId = stringValue(row.fileId)
  const kind = stringValue(row.kind)
  if (!id || !runId || !kind) return null
  return {
    id,
    runId,
    projectId,
    fileId,
    kind,
    ...(typeof row.spanId === "string" ? { spanId: row.spanId } : {}),
    ...(typeof row.spanLabel === "string" ? { spanLabel: row.spanLabel } : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
    ...(typeof row.phase === "string" ? { phase: row.phase } : {}),
    summary: stringValue(row.summary, kind),
    details: objectValue(row.details) ?? {},
    createdAt: stringValue(row.createdAt),
  }
}

const EMPTY_OVERVIEW: ContextualOverview = {
  available: false,
  files: [],
  activeRuns: 0,
  doneSpans: 0,
  totalSpans: 0,
  failedSpans: 0,
  unitsSpent: 0,
  proposedDrafts: 0,
  appliedDrafts: 0,
}

/** Project-wide autopilot rollup. Reports `available: false` rather than
 *  throwing when the backend isn't deployed, so the overview renders without it. */
export async function fetchContextualOverview(projectId: string): Promise<ContextualOverview> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/overview`,
    { headers: authHeaders(jwt) },
  )
  if (res.status === 404 || res.status === 501) return EMPTY_OVERVIEW
  if (!res.ok) return throwFromResponse(res, "fetch autopilot overview failed")
  const body = (await res.json()) as Partial<ContextualOverview>
  return { ...EMPTY_OVERVIEW, ...body, available: true }
}

/** Run history for the project activity inspector. Old servers that only
 * support the file-scoped snapshot degrade to an empty history. */
export async function fetchContextualRuns(
  projectId: string,
  options: ContextualRunListOptions = {},
): Promise<ContextualRunPage> {
  const jwt = await requireJwt()
  const queryParams = new URLSearchParams()
  if (options.cursor) {
    queryParams.set("beforeCreatedAt", options.cursor.createdAt)
    queryParams.set("beforeRunId", options.cursor.runId)
  }
  if (options.proposedOnly) queryParams.set("proposedOnly", "true")
  if (options.limit !== undefined) queryParams.set("limit", String(options.limit))
  const query = queryParams.size > 0 ? `?${queryParams.toString()}` : ""
  const res = await fetchWithTimeout(`${runsBase(projectId)}${query}`, { headers: authHeaders(jwt) })
  if (res.status === 404 || res.status === 501) {
    return { available: false, runs: [], truncated: false, nextCursor: null }
  }
  if (!res.ok) return throwFromResponse(res, "fetch autopilot runs failed")
  const body = objectValue(await res.json())
  const runs = Array.isArray(body?.runs) ? body.runs : []
  const normalizedRuns = runs.flatMap((value) => {
    const run = normalizeRun(value)
    if (!run) return []
    runProjects.set(run.runId, projectId)
    return [run]
  })
  const responseCursor = objectValue(body?.nextCursor)
  // The response cursor names the boundary record. Request pagination maps
  // these values to `beforeCreatedAt` / `beforeRunId` when fetching a later
  // page. Accept the transitional query-shaped form defensively, but expose
  // the backend's public response contract.
  const createdAt = stringValue(responseCursor?.createdAt ?? responseCursor?.beforeCreatedAt)
  const runId = stringValue(responseCursor?.runId ?? responseCursor?.beforeRunId)
  return {
    available: body?.available !== false,
    runs: normalizedRuns,
    truncated: body?.truncated === true,
    nextCursor: createdAt && runId ? { createdAt, runId } : null,
  }
}

/** Evidence bundle for one durable run. Historic deployments may know the
 * run but have no event log; an empty bundle keeps the durable summary usable
 * and lets the inspector explain that deeper history was not recorded. */
export async function fetchContextualRunActivity(
  projectId: string,
  runId: string,
  options: ContextualRunActivityOptions = {},
): Promise<ContextualRunActivity> {
  const jwt = await requireJwt()
  const query = new URLSearchParams()
  if (options.draftStatus) query.set("draftStatus", options.draftStatus)
  if (options.draftLimit !== undefined) query.set("draftLimit", String(options.draftLimit))
  if (options.draftCursor) {
    query.set("draftBeforeCreatedAt", options.draftCursor.createdAt)
    query.set("draftBeforeId", options.draftCursor.draftId)
  }
  const queryString = query.size > 0 ? `?${query.toString()}` : ""
  const res = await fetchWithTimeout(
    `${runsBase(projectId)}/${encodeURIComponent(runId)}/activity${queryString}`,
    { headers: authHeaders(jwt) },
  )
  if (res.status === 404 || res.status === 501) {
    return {
      run: null,
      events: [],
      sceneBriefs: [],
      drafts: [],
      truncated: false,
      truncatedCollections: { events: false, sceneBriefs: false, drafts: false },
      draftCounts: { proposed: 0, applied: 0, rejected: 0, superseded: 0 },
      draftNextCursor: null,
    }
  }
  if (!res.ok) return throwFromResponse(res, "fetch autopilot activity failed")
  const body = objectValue(await res.json()) ?? {}
  const run = normalizeRun(body.run)
  if (run) runProjects.set(run.runId, projectId)
  const rawTruncation = objectValue(body.truncatedCollections)
    ?? objectValue(body.truncation)
    ?? objectValue(body.truncated)
  const legacyTruncated = body.truncated === true && rawTruncation === null
  const rawDraftCounts = objectValue(body.draftCounts)
  const rawDraftCursor = objectValue(body.draftNextCursor)
  const draftCursorCreatedAt = stringValue(rawDraftCursor?.createdAt)
  const draftCursorId = stringValue(rawDraftCursor?.draftId)
  const truncatedCollections = {
    events: legacyTruncated || rawTruncation?.events === true || body.eventsTruncated === true,
    sceneBriefs:
      legacyTruncated
      || rawTruncation?.sceneBriefs === true
      || body.sceneBriefsTruncated === true,
    drafts: legacyTruncated || rawTruncation?.drafts === true || body.draftsTruncated === true,
  }
  return {
    run,
    events: (Array.isArray(body.events) ? body.events : []).flatMap((value) => {
      const event = normalizeEvent(value)
      return event ? [event] : []
    }),
    sceneBriefs: (Array.isArray(body.sceneBriefs) ? body.sceneBriefs : []).filter(
      (value): value is ContextualActivitySceneBrief => objectValue(value) !== null,
    ),
    drafts: (Array.isArray(body.drafts) ? body.drafts : []).filter(
      (value): value is ContextualActivityDraft => objectValue(value) !== null,
    ),
    truncated: Object.values(truncatedCollections).some(Boolean),
    truncatedCollections,
    ...(rawDraftCounts
      ? {
          draftCounts: {
            proposed: numberValue(rawDraftCounts.proposed),
            applied: numberValue(rawDraftCounts.applied),
            rejected: numberValue(rawDraftCounts.rejected),
            superseded: numberValue(rawDraftCounts.superseded),
          },
        }
      : {}),
    draftNextCursor:
      draftCursorCreatedAt && draftCursorId
        ? { createdAt: draftCursorCreatedAt, draftId: draftCursorId }
        : null,
  }
}

export interface ProjectRunStartResult {
  scope: "project"
  scopeGroup: string
  started: { runId: string; fileId: string }[]
  skipped: { fileId: string; reason: string }[]
  totalCandidates: number
  deferred: { count: number; reason: "batch_limit" | null }
  truncated: boolean
}

/** Start autopilot on EVERY discourse file in the project that still has work.
 *  The server picks the files and divides the concurrency ceiling across them. */
export async function startProjectContextualRun(
  projectId: string,
): Promise<ProjectRunStartResult> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(runsBase(projectId), {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ scope: "project" }),
  })
  if (!res.ok) return throwFromResponse(res, "start project autopilot failed")
  const body = (await res.json()) as Partial<ProjectRunStartResult>
  const started = body.started ?? []
  const skipped = body.skipped ?? []
  const deferredCount = numberValue(body.deferred?.count)
  for (const run of started) runProjects.set(run.runId, projectId)
  return {
    scope: "project",
    scopeGroup: body.scopeGroup ?? "",
    started,
    skipped,
    totalCandidates: numberValue(body.totalCandidates ?? started.length + deferredCount),
    deferred: {
      count: deferredCount,
      reason: body.deferred?.reason === "batch_limit" ? "batch_limit" : null,
    },
    truncated: body.truncated === true || deferredCount > 0,
  }
}

/** Start a fresh file-scoped run from the inspector after a failed run. This
 * is intentionally a new run, not a claim that the server supports replaying
 * the failed run at an exact internal step. */
export async function startFileContextualRun(
  projectId: string,
  fileId: string,
  targetLang = "",
): Promise<{ runId: string }> {
  return realContextualTransport.start(projectId, fileId, undefined, targetLang)
}

export type ContextualRunCommand = "pause" | "resume" | "terminate"

/** Project-scoped controls for the inspector. Commands still pass through the
 * same role/state guards as the editor pill; the response is the authoritative
 * updated run when the server returns it. */
export async function commandContextualRun(
  projectId: string,
  runId: string,
  command: ContextualRunCommand,
): Promise<ContextualRunRecord | null> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${runsBase(projectId)}/${encodeURIComponent(runId)}/${command}`,
    { method: "POST", headers: authHeaders(jwt) },
  )
  if (!res.ok) return throwFromResponse(res, `${command} run failed`)
  const body = objectValue(await res.json())
  const run = normalizeRun(body?.run)
  if (run) runProjects.set(run.runId, projectId)
  return run
}

/**
 * Free-text steering direction for a live run ("keep the tone formal").
 * Not part of ContextualTransport (the store doesn't sequence steering); the
 * steering UI calls this directly. The server route is project-scoped —
 * POST …/contextual/steering { kind, body, runId } — and waking a parked run
 * is its job, not the client's.
 */
export async function sendContextualSteering(runId: string, text: string): Promise<void> {
  const projectId = projectForRun(runId)
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/steering`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ kind: "direction", body: text, runId }),
    },
  )
  if (!res.ok) return throwFromResponse(res, "send steering failed")
}

let _installed = false

/** Wire the real transport into the run-store. Idempotent — the pill mount
 * calls it on every render pass; only the first call does anything. */
export function installContextualTransport(): void {
  if (_installed) return
  _installed = true
  setContextualTransport(realContextualTransport)
}

/** Test-only: forget installation + run→project memory. */
export function resetContextualTransportForTesting(): void {
  _installed = false
  runProjects.clear()
}
