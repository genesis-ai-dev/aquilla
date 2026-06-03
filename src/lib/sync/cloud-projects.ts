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
 * GET /api/v2/projects — every non-archived project the caller can access.
 * Pass `orgId` to scope the list to a specific org (appends `?orgId=N`).
 * Returns [] on any non-2xx or network error (no throw) so Dashboard can
 * render local state even when offline or when the server is unreachable.
 */
export async function fetchAccessibleProjects(
  jwt: string,
  orgId?: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<CloudProjectSummary[]> {
  try {
    const url = orgId != null ? `${apiUrl}/api/v2/projects?orgId=${orgId}` : `${apiUrl}/api/v2/projects`
    const res = await fetch(url, {
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
  return record
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
