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
  async fetchSnapshot(projectId: string, fileId: string): Promise<ContextualTransportSnapshot> {
    const jwt = await requireJwt()
    const res = await fetchWithTimeout(
      `${runsBase(projectId)}?fileId=${encodeURIComponent(fileId)}`,
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

  async start(projectId: string, fileId: string, anchorCellId?: string): Promise<{ runId: string }> {
    const jwt = await requireJwt()
    const res = await fetchWithTimeout(runsBase(projectId), {
      method: "POST",
      headers: authHeaders(jwt),
      // The anchor rotates the first wave to start where the user is looking.
      body: JSON.stringify({ fileId, ...(anchorCellId ? { anchorCellId } : {}) }),
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
  cellId: string
  text: string
  spanLabel?: string
}

interface DraftListRow {
  id: string
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
): Promise<ContextualDraftRecord[]> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/contextual/drafts` +
      `?fileId=${encodeURIComponent(fileId)}&status=proposed`,
    { headers: authHeaders(jwt) },
  )
  if (res.status === 404 || res.status === 501) return []
  if (!res.ok) return throwFromResponse(res, "fetch contextual drafts failed")
  const { drafts } = (await res.json()) as { drafts?: DraftListRow[] }
  return (drafts ?? []).map((d) => ({
    draftId: d.id,
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

export interface ProjectRunStartResult {
  scopeGroup: string
  started: { runId: string; fileId: string }[]
  skipped: { fileId: string; reason: string }[]
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
  const body = (await res.json()) as ProjectRunStartResult
  for (const run of body.started ?? []) runProjects.set(run.runId, projectId)
  return { scopeGroup: body.scopeGroup, started: body.started ?? [], skipped: body.skipped ?? [] }
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
