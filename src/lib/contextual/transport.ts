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

  async start(projectId: string, fileId: string): Promise<{ runId: string }> {
    const jwt = await requireJwt()
    const res = await fetchWithTimeout(runsBase(projectId), {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ fileId }),
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
