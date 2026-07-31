// Server-backed project discovery + hydration. Lets the Dashboard show the
// cloud projects a signed-in user can access (create, owner, or invited)
// even on a fresh device with no IDB state, and lets useProject fall back
// to the server when IDB misses — so pasting a project URL into a second
// browser resolves instead of spinning "Loading..." forever.

import type { FileType, ProjectRecord } from "@/lib/parsers/types"
import { FRONTIER_API_URL } from "./sync-token"
import { fetchProjectState, type ProjectStateResponse } from "./archive"
import { UserError } from "@/lib/errors/user-error"

export interface CloudFileSummary {
  id: string
  name: string
  type: string
  cellCount: number
  bookCode?: string | null
  hasScriptureContent?: boolean
  sourceLanguage?: string | null
  targetLanguage?: string | null
  /** Timeline-segment-model order lens ('time' | 'sequence'); absent ⇒ sequence. */
  orderedBy?: string
  sourceTextDirection?: "ltr" | "rtl" | null
  targetTextDirection?: "ltr" | "rtl" | null
  /** Timeline editor: core video URL for the preview; absent/null ⇒ no video. */
  coreMediaUrl?: string | null
}

export interface CloudProjectSummary {
  id: string
  name: string
  gitlabProjectId: number | null
  /** The org this project belongs to. Present when fetched with an orgId filter. */
  orgId?: number | null
  /** AQU-473: the host org's display name, joined server-side by the list
   *  endpoint. Absent on the single-project endpoint or older servers. */
  orgName?: string | null
  /** Present on the single-project endpoint; list endpoint filters archived rows. */
  archivedAt?: string | null
  /** Present on the single-project endpoint; used to show "archived by X" in Trash. */
  archivedBy?: { id: number; username: string } | null
  /** Active/inactive lifecycle state (migration 0033). Absent = assume active
   *  (older API versions that don't return the field). */
  isActive?: boolean
  /**
   * AD-9: upstream source project id for linked-target projects. Null / absent
   * means self-contained. Returned by the single-project endpoint; list
   * endpoint may omit (older servers).
   */
  sourceProjectId?: string | null
  /**
   * AQU-696: when the caller was granted access to this project (ISO 8601),
   * from the list endpoint. Drives the "New" badge on newly-shared projects
   * (new until opened). Optional and nullable: an older worker that omits it,
   * or an own/creator project with no grant row, degrades to "not new" — never
   * to "everything is new".
   */
  grantedAt?: string | null
  /** AQU-476/478: link mode/consumes/gate/cursor. Only the single-project
   *  endpoint returns these (the list endpoint returns sourceProjectId only —
   *  the picker/settings-detail views are what need the full state). */
  sourceLinkMode?: "clone" | "live" | null
  sourceLinkConsumes?: "source" | "target" | null
  sourceLinkGate?: "head" | "validated" | null
  sourceLinkCursor?: number | null
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
    throw new UserError(res.status, body, "project")
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
  minRole?: number,
): Promise<ProjectsResult> {
  try {
    const params = new URLSearchParams()
    if (orgId != null) params.set("orgId", String(orgId))
    if (minRole != null) params.set("minRole", String(minRole))
    const qs = params.toString()
    const url = qs ? `${apiUrl}/api/v2/projects?${qs}` : `${apiUrl}/api/v2/projects`
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
  minRole?: number,
): Promise<CloudProjectSummary[]> {
  const result = await fetchAccessibleProjectsResult(jwt, orgId, apiUrl, minRole)
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
  if (!res.ok) throw new UserError(res.status, "", "project")
}

/**
 * PATCH /api/v2/projects/:id — rename a project (AQU-765). Maintainer+ only
 * (server-enforced: a contributor gets a 403). `projects.name` is the source
 * of truth every surface reads, so on success the org list, breadcrumbs,
 * portfolio, and search all reflect the new name after they refetch. Throws a
 * UserError on failure (401/403/404/…), so the caller can distinguish a
 * permission block from other failures.
 */
export async function renameProject(
  jwt: string,
  projectId: string,
  name: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new UserError(res.status, "", "project")
  return (await res.json()) as { id: string; name: string }
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
    orgId: summary.orgId ?? null,
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
      ...(f.bookCode ? { bookCode: f.bookCode } : {}),
      ...(f.hasScriptureContent ? { hasScriptureContent: true } : {}),
      ...(f.sourceLanguage ? { sourceLanguage: f.sourceLanguage } : {}),
      ...(f.targetLanguage ? { targetLanguage: f.targetLanguage } : {}),
      ...(f.orderedBy === "time" || f.orderedBy === "sequence" ? { orderedBy: f.orderedBy } : {}),
      ...(f.sourceTextDirection === "ltr" || f.sourceTextDirection === "rtl" ? { sourceTextDirection: f.sourceTextDirection } : {}),
      ...(f.targetTextDirection === "ltr" || f.targetTextDirection === "rtl" ? { targetTextDirection: f.targetTextDirection } : {}),
      ...(f.coreMediaUrl ? { coreMediaUrl: f.coreMediaUrl } : {}),
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
  // AD-9: propagate source link (null = no upstream; undefined = field absent)
  if (summary.sourceProjectId !== undefined) {
    record.sourceProjectId = summary.sourceProjectId
  }
  // AQU-476/478: propagate link mode/consumes/gate/cursor when present.
  if (summary.sourceLinkMode !== undefined) record.sourceLinkMode = summary.sourceLinkMode
  if (summary.sourceLinkConsumes !== undefined) record.sourceLinkConsumes = summary.sourceLinkConsumes
  if (summary.sourceLinkGate !== undefined) record.sourceLinkGate = summary.sourceLinkGate
  if (summary.sourceLinkCursor !== undefined) record.sourceLinkCursor = summary.sourceLinkCursor
  return record
}

/**
 * POST /api/v2/projects/:id/detach-source — detach a linked-target project
 * from its upstream source. Clears `source_project_id`, emits a
 * `project.link-source` event with null payload, and bursts source cell
 * snapshots. project_lead+ only (server-enforced).
 *
 * Returns the count of snapshottedCells on success; throws on non-2xx.
 */
export async function detachProjectSource(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<{ previousSourceProjectId: string; snapshottedCellCount: number }> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/detach-source`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
    throw new UserError(res.status, body.error ?? `HTTP ${res.status}`, "project")
  }
  return res.json() as Promise<{ previousSourceProjectId: string; snapshottedCellCount: number }>
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
  if (!res.ok) throw new UserError(res.status, "", "project")
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
  | { ok: false; reason: "not-found" | "forbidden" | "unreachable" }

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
      if (found) return { ok: true, project: found }
      // AQU-346: a 403 on the direct endpoint means the project exists but
      // this account has no access (e.g. membership was revoked) — surface
      // it distinctly so the workspace shows "you no longer have access"
      // instead of the misleading "project not found".
      return {
        ok: false,
        reason: directRes.status === 403 ? "forbidden" : "not-found",
      }
    }
    // 5xx or other server error.
    return { ok: false, reason: "unreachable" }
  } catch {
    // Network error.
    return { ok: false, reason: "unreachable" }
  }
}
