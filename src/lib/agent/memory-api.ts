/**
 * memory-api.ts — typed fetch client for the agent memory & project-brief
 * routes (AQU-AGENT contracts §3, owner W1C; auth-worker, mounted under
 * /api/v2). Mirrors src/lib/sync/credentials.ts conventions: AUTH_BASE +
 * fetchWithTimeout + `Authorization: Bearer <jwt>`, thrown Error subclasses
 * on non-OK responses.
 *
 * SWARM-TODO(aqu-agent): this file codes against the contract doc, not a
 * live server — if W1C's route shapes drift from §3, update here and note
 * the deviation in docs/swarm/AQU-AGENT-TRACES.md.
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"

// ── Types (contract §3) ─────────────────────────────────────────────────────

export type AgentMemoryStatus = "proposed" | "approved" | "rejected" | "archived"

export interface AgentMemoryProvenance {
  runId?: string
  sessionId?: string
  credentialId?: string
}

export interface AgentMemory {
  id: string
  projectId: string
  path: string
  content: string
  status: AgentMemoryStatus
  humanEdited: boolean
  rationale: string | null
  provenance: AgentMemoryProvenance | null
  createdBy: string | null
  reviewedBy: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProposeMemoryInput {
  path: string
  content: string
  rationale?: string
  provenance?: AgentMemoryProvenance
}

export type MemoryReviewAction = "approve" | "reject"

export interface ProjectBrief {
  projectId: string
  content: string
  updatedBy: string | null
  version: number
  updatedAt: string
}

export type BriefProposalStatus = "proposed" | "approved" | "rejected"

export interface ProjectBriefProposal {
  id: string
  projectId: string
  content: string
  rationale: string | null
  status: BriefProposalStatus
  createdBy: string | null
  reviewedBy: string | null
  createdAt: string
  reviewedAt: string | null
}

// ── Typed errors ─────────────────────────────────────────────────────────────

/** Generic non-OK response the caller didn't ask to special-case. */
export class MemoryApiError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** 403 `human_edit_protected` — agent channel tried to PATCH a human-edited
 * memory row. Never thrown for the human/SPA channel (this client never
 * sends `x-aquilla-agent-run`), kept as a typed case for completeness and
 * so a server-side mistake surfaces distinctly rather than as a generic 403. */
export class HumanEditProtectedError extends MemoryApiError {
  constructor(message = "This memory was human-edited and is protected from agent changes.") {
    super(message, 403)
  }
}

/** 403 `brief_human_only` — brief PUT/proposal-review is human-only. */
export class BriefHumanOnlyError extends MemoryApiError {
  constructor(message = "The project brief can only be edited by a human.") {
    super(message, 403)
  }
}

/** 409 — the brief (or memory) changed underneath an `ifMatchVersion` write. */
export class VersionConflictError extends MemoryApiError {
  public currentVersion?: number
  constructor(message = "This was changed by someone else. Reload and try again.", currentVersion?: number) {
    super(message, 409)
    this.currentVersion = currentVersion
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string }
  currentVersion?: number
}

async function parseErrorAndThrow(res: Response, fallback: string): Promise<never> {
  let body: ErrorEnvelope | null = null
  try {
    body = (await res.json()) as ErrorEnvelope
  } catch {
    // non-JSON error body — fall through to generic error
  }
  const code = body?.error?.code
  const message = body?.error?.message ?? fallback

  if (res.status === 403 && code === "human_edit_protected") {
    throw new HumanEditProtectedError(message)
  }
  if (res.status === 403 && code === "brief_human_only") {
    throw new BriefHumanOnlyError(message)
  }
  if (res.status === 409) {
    throw new VersionConflictError(message, body?.currentVersion)
  }
  throw new MemoryApiError(`${fallback}: HTTP ${res.status} — ${message}`, res.status)
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}

// ── Agent memory ─────────────────────────────────────────────────────────────

/** GET /api/v2/projects/:projectId/agent-memory?status= (VIEWER+). Omit
 * `status` for all rows. */
export async function listAgentMemories(
  jwt: string,
  projectId: string,
  status?: AgentMemoryStatus,
): Promise<AgentMemory[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ""
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/agent-memory${qs}`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "list agent memories failed")
  return ((await res.json()) as { memories: AgentMemory[] }).memories
}

/** POST /api/v2/projects/:projectId/agent-memory (CONTRIBUTOR+). Creates a
 * `proposed` row. */
export async function proposeAgentMemory(
  jwt: string,
  projectId: string,
  input: ProposeMemoryInput,
): Promise<AgentMemory> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/agent-memory`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(input) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "propose memory failed")
  return (await res.json()) as AgentMemory
}

/** POST /api/v2/projects/:projectId/agent-memory/:id/review (PROJECT_LEAD+). */
export async function reviewAgentMemory(
  jwt: string,
  projectId: string,
  memoryId: string,
  action: MemoryReviewAction,
): Promise<AgentMemory> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/agent-memory/${encodeURIComponent(memoryId)}/review`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ action }) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "review memory failed")
  return (await res.json()) as AgentMemory
}

/** PATCH /api/v2/projects/:projectId/agent-memory/:id — human edit. Sets
 * `humanEdited=true`, bumps `version`. (PROJECT_LEAD+, or CONTRIBUTOR on own
 * proposal — server-enforced; this client just forwards.) */
export async function editAgentMemory(
  jwt: string,
  projectId: string,
  memoryId: string,
  content: string,
): Promise<AgentMemory> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/agent-memory/${encodeURIComponent(memoryId)}`,
    { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ content }) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "edit memory failed")
  return (await res.json()) as AgentMemory
}

// ── Project brief ────────────────────────────────────────────────────────────

/** GET /api/v2/projects/:projectId/brief (VIEWER+). */
export async function getProjectBrief(jwt: string, projectId: string): Promise<ProjectBrief> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/brief`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "get brief failed")
  return ((await res.json()) as { brief: ProjectBrief }).brief
}

/** PUT /api/v2/projects/:projectId/brief (PROJECT_LEAD+, humans only). Throws
 * VersionConflictError on a stale `ifMatchVersion`. */
export async function putProjectBrief(
  jwt: string,
  projectId: string,
  content: string,
  ifMatchVersion: number,
): Promise<ProjectBrief> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/brief`,
    { method: "PUT", headers: authHeaders(jwt), body: JSON.stringify({ content, ifMatchVersion }) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "update brief failed")
  return ((await res.json()) as { brief: ProjectBrief }).brief
}

/** POST /api/v2/projects/:projectId/brief/proposals (agent or human). */
export async function proposeBriefUpdate(
  jwt: string,
  projectId: string,
  content: string,
  rationale?: string,
): Promise<ProjectBriefProposal> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/brief/proposals`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ content, rationale }) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "propose brief update failed")
  return ((await res.json()) as { proposal: ProjectBriefProposal }).proposal
}

/** GET /api/v2/projects/:projectId/brief/proposals — listed for the review
 * sub-panel. Not explicitly enumerated in §3's route list but implied by
 * "Proposals sub-list (approve/reject)"; if W1C didn't wire a GET, this 404s
 * and the panel shows an empty list rather than crashing.
 * SWARM-TODO(aqu-agent): confirm this route exists once W1C lands; note any
 * gap in docs/swarm/AQU-AGENT-TRACES.md. */
export async function listBriefProposals(
  jwt: string,
  projectId: string,
  status?: BriefProposalStatus,
): Promise<ProjectBriefProposal[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ""
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/brief/proposals${qs}`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "list brief proposals failed")
  return ((await res.json()) as { proposals: ProjectBriefProposal[] }).proposals
}

/** POST /api/v2/projects/:projectId/brief/proposals/:id/review (PROJECT_LEAD+,
 * NEVER agent channel — this client is the human SPA path, so that's implicit). */
export async function reviewBriefProposal(
  jwt: string,
  projectId: string,
  proposalId: string,
  action: MemoryReviewAction,
): Promise<ProjectBriefProposal> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/brief/proposals/${encodeURIComponent(proposalId)}/review`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ action }) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "review brief proposal failed")
  return ((await res.json()) as { proposal: ProjectBriefProposal; brief?: ProjectBrief }).proposal
}
