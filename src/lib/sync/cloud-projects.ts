// Server-backed project discovery + hydration. Lets the Dashboard show the
// cloud projects a signed-in user can access (create, owner, or invited)
// even on a fresh device with no IDB state, and lets useProject fall back
// to the server when IDB misses — so pasting a project URL into a second
// browser resolves instead of spinning "Loading..." forever.

import type { FileType, ProjectRecord } from "@/lib/parsers/types"
import { FRONTIER_API_URL } from "./sync-token"
import { fetchProjectState, type ProjectStateResponse } from "./archive"

export interface CloudFileSummary {
  id: string
  name: string
  type: string
  cellCount: number
  /** Timeline-segment-model order lens ('time' | 'sequence'); absent ⇒ sequence. */
  orderedBy?: string
}

export interface CloudProjectSummary {
  id: string
  name: string
  gitlabProjectId: number | null
  /** The org this project belongs to. Present when fetched with an orgId filter. */
  orgId?: number | null
  /** Present on the single-project endpoint; list endpoint filters archived rows. */
  archivedAt?: string | null
  /** Present on the single-project endpoint; used to show "archived by X" in Trash. */
  archivedBy?: { id: number; username: string } | null
  /** Active/inactive lifecycle state (migration 0033). Absent = assume active
   *  (older API versions that don't return the field). */
  isActive?: boolean
  role: {
    level: number
    name: string
    source: string
  }
  /** Populated by the list endpoint via a join against codex-db.files. The
   *  single-project endpoint may omit. Hydration treats absence as "unknown"
   *  rather than "empty" so we don't clobber a cached local file list. */
  files?: CloudFileSummary[]
}

/**
 * POST /api/v2/projects — create the server-side project row so the creator
 * is recognized as owner (`created_by`). REQUIRED on create: reads are
 * server-only (AD-3, no IDB fallback in useProject), so a project that exists
 * only in IndexedDB 403s the moment you open it ("not found or no access").
 * Throws on failure so the caller can surface it instead of silently leaving
 * a local-only orphan.
 */
export async function createCloudProject(
  jwt: string,
  project: { id: string; name: string; orgId?: number },
  apiUrl: string = FRONTIER_API_URL,
): Promise<void> {
  const body: Record<string, unknown> = { id: project.id, name: project.name }
  if (project.orgId != null) body.orgId = project.orgId
  const res = await fetch(`${apiUrl}/api/v2/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`create project failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
}

/**
 * Discriminated-union result for {@link fetchAccessibleProjectsResult}.
 * Callers that need to distinguish "server unreachable" from "genuinely empty
 * org" should use this variant. Callers that tolerate silent failure (e.g.
 * `useAccessibleProjects` for the invite picker) can keep using
 * {@link fetchAccessibleProjects} unchanged.
 */
export type ProjectsResult =
  | { ok: true; projects: CloudProjectSummary[] }
  | { ok: false; reason: "unreachable" | "unauthorized" | "error"; status?: number }

/**
 * GET /api/v2/projects — returns a discriminated result so callers can
 * distinguish a successful-but-empty list from a backend failure.
 * Pass `orgId` to scope the list to a specific org (appends `?orgId=N`).
 */
export async function fetchAccessibleProjectsResult(
  jwt: string,
  orgId?: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<ProjectsResult> {
  try {
    const url = orgId != null ? `${apiUrl}/api/v2/projects?orgId=${orgId}` : `${apiUrl}/api/v2/projects`
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!res.ok) {
      const reason = res.status === 401 || res.status === 403 ? "unauthorized" : "error"
      return { ok: false, reason, status: res.status }
    }
    const body = (await res.json()) as { projects?: CloudProjectSummary[] }
    return { ok: true, projects: body.projects ?? [] }
  } catch {
    // Network error — server unreachable.
    return { ok: false, reason: "unreachable" }
  }
}

/**
 * GET /api/v2/projects — every non-archived project the caller can access.
 * Pass `orgId` to scope the list to a specific org (appends `?orgId=N`).
 * Returns [] on any non-2xx or network error (no throw) so callers that
 * tolerate silent failure (e.g. invite picker) continue to work.
 *
 * @deprecated Prefer {@link fetchAccessibleProjectsResult} when the call site
 * needs to distinguish server failure from an empty list (e.g. Dashboard,
 * ProjectsList). The old comment claiming this was safe because Dashboard has
 * a "local IDB fallback" is stale — the thin-client refactor (AD-3) removed
 * that fallback.
 */
export async function fetchAccessibleProjects(
  jwt: string,
  orgId?: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<CloudProjectSummary[]> {
  const result = await fetchAccessibleProjectsResult(jwt, orgId, apiUrl)
  return result.ok ? result.projects : []
}

/**
 * GET /api/v2/projects?orgId=N&archived=true — archived (untracked) projects in
 * an org. Same access rules as the live list; returns [] on any error.
 */
export async function fetchArchivedProjects(
  jwt: string,
  orgId: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<CloudProjectSummary[]> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/projects?orgId=${orgId}&archived=true`, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!res.ok) return []
    const body = (await res.json()) as { projects?: CloudProjectSummary[] }
    return body.projects ?? []
  } catch {
    return []
  }
}

/**
 * PATCH /api/v2/projects/:id/deadline — set (ISO date string) or clear (null)
 * a project's deadline. Maintainer+ only (server-enforced). Throws on failure.
 */
export async function setProjectDeadline(
  jwt: string,
  projectId: string,
  deadline: string | null,
  apiUrl: string = FRONTIER_API_URL,
): Promise<void> {
  const res = await fetch(`${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/deadline`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ deadline }),
  })
  if (!res.ok) throw new Error(`setProjectDeadline failed: HTTP ${res.status}`)
}

/**
 * Build a minimal `ProjectRecord` from a server summary. Required ProjectRecord
 * fields (sourceLanguage, targetLanguage, files, members) don't exist
 * server-side — they live in Y.Doc state and IDB — so we seed empty defaults.
 * Once the user opens a file, sync fills in real data on first write.
 *
 * `origin` stays undefined: cloud-hydrated records are not git-imported, and
 * ProjectOrigin requires clone metadata we don't have.
 */
export function minimalProjectRecord(summary: CloudProjectSummary): ProjectRecord {
  const now = new Date().toISOString()
  const record: ProjectRecord = {
    id: summary.id,
    name: summary.name,
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: now,
    files: (summary.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      // Server sends the raw string; FileType is a union we widen back here
      // and accept "unknown" as an unexpected value rather than crashing.
      type: f.type as FileType,
      createdAt: now,
      cellCount: f.cellCount,
      ...(f.orderedBy === "time" || f.orderedBy === "sequence" ? { orderedBy: f.orderedBy } : {}),
    })),
    members: [],
    syncRole: {
      level: summary.role.level,
      name: summary.role.name,
      source: summary.role.source,
      fetchedAt: now,
    },
  }
  if (summary.archivedAt) {
    record.deletedAt = summary.archivedAt
    if (summary.archivedBy?.username) record.deletedBy = summary.archivedBy.username
  }
  // isActive absent → treat as active (backward compat with older API)
  if (summary.isActive === false) {
    record.isActive = false
  }
  return record
}

/**
 * PATCH /api/v2/projects/:id/lifecycle — set a project active or inactive.
 * project_lead+ only (server-enforced). Throws on non-2xx.
 */
export async function toggleProjectLifecycle(
  jwt: string,
  projectId: string,
  isActive: boolean,
  apiUrl: string = FRONTIER_API_URL,
): Promise<void> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/lifecycle`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ isActive }),
    },
  )
  if (!res.ok) throw new Error(`toggleProjectLifecycle failed: HTTP ${res.status}`)
}

/**
 * Resolve a single project from the server by id. Tries the single-project
 * endpoint first; falls back to the list endpoint + filter when the single
 * endpoint 404s (happens on deployments that haven't landed the Trash-era
 * `GET /:projectId` yet). Returns null when the user has no access or the
 * project doesn't exist.
 */
export async function resolveCloudProject(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<ProjectStateResponse | CloudProjectSummary | null> {
  const direct = await fetchProjectState(projectId, jwt, apiUrl)
  if (direct) return direct
  const list = await fetchAccessibleProjects(jwt, undefined, apiUrl)
  return list.find((p) => p.id === projectId) ?? null
}

/**
 * Result type for {@link resolveCloudProjectResult} — separates access
 * failures (project doesn't exist / no permission) from server failures
 * (network error / 5xx) so callers can show "not found" vs "unreachable".
 */
export type ResolveProjectResult =
  | { ok: true; project: ProjectStateResponse | CloudProjectSummary }
  | { ok: false; reason: "not-found" | "unreachable" }

/**
 * Like {@link resolveCloudProject} but returns a discriminated result
 * instead of null, so callers can distinguish "no access / 404" from
 * "server unreachable / 5xx". Used by useProject to show the right state.
 */
export async function resolveCloudProjectResult(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<ResolveProjectResult> {
  try {
    // Try the single-project endpoint first.
    const directRes = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${jwt}` } }
    )
    if (directRes.ok) {
      const project = (await directRes.json()) as ProjectStateResponse
      return { ok: true, project }
    }
    if (directRes.status === 404 || directRes.status === 403) {
      // Might be an older deployment that hasn't landed GET /:id — fall back
      // to the list endpoint before concluding "not found".
      const listResult = await fetchAccessibleProjectsResult(jwt, undefined, apiUrl)
      if (!listResult.ok) {
        // List endpoint also failed → server is down.
        return { ok: false, reason: "unreachable" }
      }
      const found = listResult.projects.find((p) => p.id === projectId)
      return found ? { ok: true, project: found } : { ok: false, reason: "not-found" }
    }
    // 5xx or other server error.
    return { ok: false, reason: "unreachable" }
  } catch {
    // Network error.
    return { ok: false, reason: "unreachable" }
  }
}
