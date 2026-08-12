// Client helpers for frontier-server's project archive endpoints. The archive
// ("move to Trash") action is server-authoritative for cloud-synced projects
// so all collaborators see the tombstone. Purely local projects (no server
// row) get a 404 — callers should fall through to an IDB-only tombstone.

import type { CloudFileSummary } from "./cloud-projects"
import { messageForStatus, UserError } from "../errors/user-error"
import { FRONTIER_API_URL } from "./sync-token"

export interface ArchiveSuccess {
  kind: "archived"
  archivedAt: string
  archivedBy: { id: number; username: string }
}

export interface UnarchiveSuccess {
  kind: "restored"
}

export interface ArchiveLocalOnly {
  kind: "local-only"
}

export interface ArchiveForbidden {
  kind: "forbidden"
  /** e.g. "only owners can archive a project" */
  message?: string
}

export interface ArchiveError {
  kind: "error"
  status: number
  message: string
}

export type ArchiveResult = ArchiveSuccess | ArchiveLocalOnly | ArchiveForbidden | ArchiveError
export type UnarchiveResult = UnarchiveSuccess | ArchiveLocalOnly | ArchiveForbidden | ArchiveError

export interface ProjectStateResponse {
  id: string
  name: string
  gitlabProjectId: number | null
  orgId: number | null
  /** AQU-822: the org's effective termbase-edit floor (absent on older servers). */
  termbaseEditMinRole?: number | null
  archivedAt: string | null
  archivedBy: { id: number; username: string } | null
  /** Active/inactive lifecycle (migration 0033). Absent = active (compat). */
  isActive?: boolean
  /**
   * AD-9: upstream source project id for linked-target projects. Null / absent
   * means self-contained (or is itself a source).
   */
  sourceProjectId?: string | null
  /** AQU-476/478: link mode — 'clone' (one-time snapshot) | 'live' (subscribed,
   *  mirrors upstream changes). Null/absent for self-contained projects. */
  sourceLinkMode?: "clone" | "live" | null
  /** AQU-476/478: which upstream lane becomes this project's source —
   *  'source' (sibling-language case) | 'target' (chain case). */
  sourceLinkConsumes?: "source" | "target" | null
  /** AQU-476/478: for target-consumption links, which upstream target state
   *  propagates — 'head' (every commit) | 'validated' (only validated heads). */
  sourceLinkGate?: "head" | "validated" | null
  /** AQU-476/478: max upstream server_seq this project has mirrored so far. */
  sourceLinkCursor?: number | null
  role: { level: number; name: string; source: string }
  /** AQU-507: designated Project Manager (null = unassigned; absent = older
   *  server). Distinct from the member roster / permission ladder. */
  pm?: { id: number; username: string } | null
  /** Populated by the codex-db.files join. Optional only because old
   *  deployments may not have shipped the join yet — current servers
   *  always return at least []. */
  files?: CloudFileSummary[]
}

/**
 * AQU-820: ProjectOverview / ArchivedProjects render this string verbatim, so
 * it has to be ours. The server's `error` is untranslated and the old
 * `HTTP ${status}` fallback was a bare diagnostic; `messageForStatus` maps the
 * status to a keyed sentence and keeps the server text on `.raw` for DevTools.
 */
async function parseError(res: Response): Promise<string> {
  let raw = ""
  try {
    const body = (await res.json()) as { error?: string }
    raw = body.error ?? ""
  } catch {
    // non-JSON body — the status alone decides the message
  }
  return messageForStatus(res.status, raw, "project").message
}

export async function archiveProjectRemote(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<ArchiveResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/archive`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    }
  )
  if (res.ok) {
    const body = (await res.json()) as {
      archivedAt: string
      archivedBy: { id: number; username: string }
    }
    return { kind: "archived", archivedAt: body.archivedAt, archivedBy: body.archivedBy }
  }
  if (res.status === 404) return { kind: "local-only" }
  if (res.status === 403) {
    return { kind: "forbidden", message: await parseError(res) }
  }
  return { kind: "error", status: res.status, message: await parseError(res) }
}

export async function unarchiveProjectRemote(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<UnarchiveResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/archive`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    }
  )
  if (res.ok) return { kind: "restored" }
  if (res.status === 404) return { kind: "local-only" }
  if (res.status === 403) {
    return { kind: "forbidden", message: await parseError(res) }
  }
  return { kind: "error", status: res.status, message: await parseError(res) }
}

export interface LinkProjectSourceResult {
  projectId: string
  sourceProjectId: string
  mode: "clone" | "live"
  consumes: "source" | "target"
  gate: "head" | "validated"
  previousSourceProjectId: string | null
  /** AQU-476/QA-BUG-1: true if the server-side seed (clone snapshot or the
   *  first live mirror sync) actually ran. False means the caller should
   *  fall back to `triggerLinkSync` before assuming content is present —
   *  older servers that predate this field are treated as `false` (the
   *  caller's fallback then self-heals unconditionally, which is harmless:
   *  `/link/sync` no-ops for clone and re-syncing live is idempotent). */
  seeded?: boolean
}

/**
 * AQU-478: POST /api/v2/projects/:id/link-source — create a project link.
 * project_lead(500)+ on the DOWNSTREAM project (server-enforced). For
 * `mode: 'live'` the auth-worker seeds the new project via the first mirror
 * sync (AQU-476 §5) as part of this same call — files/cells arrive with
 * provenance set. Throws `UserError` on non-2xx (mirrors createCloudProject).
 */
export async function linkProjectSource(
  jwt: string,
  projectId: string,
  input: {
    sourceProjectId: string
    mode: "clone" | "live"
    consumes?: "source" | "target"
    gate?: "head" | "validated"
  },
  apiUrl: string = FRONTIER_API_URL,
): Promise<LinkProjectSourceResult> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/link-source`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(input),
    },
  )
  if (!res.ok) {
    // Actually a UserError, as the doc above promises — its message is the
    // keyed status sentence and the server body stays on `.raw`/`.cause`.
    throw new UserError(res.status, await res.text().catch(() => ""), "project")
  }
  return (await res.json()) as LinkProjectSourceResult
}

/**
 * AQU-476/QA-BUG-1: client-side seed self-heal for `mode: 'live'` links.
 * `linkProjectSource` already triggers this server-side and awaits it — this
 * is the fallback for when that trigger reports `seeded: false` (sync-worker
 * unreachable, config drift, etc.) or when it's called from a project-open
 * path where the project has 0 files (see `ProjectWorkspace`'s zero-file
 * self-heal). Mints a `__project__`-scoped sync-token (the established
 * sentinel for project-level, non-file-scoped calls — see
 * useComments/useProjectHealth/outbox-flush) rather than requiring an open
 * file, since a freshly linked project may have none yet.
 *
 * Best-effort: swallows errors (returns false) — staleness/self-heal is a
 * soft signal, never something that should block navigation into the project.
 */
export async function triggerLinkSync(
  jwt: string,
  projectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<boolean> {
  try {
    const tokenRes = await fetch(`${apiUrl}/api/v2/sync-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ projectId, fileId: "__project__" }),
    })
    if (!tokenRes.ok) return false
    const { token } = (await tokenRes.json()) as { token: string }

    const { syncWorkerHttpOrigin } = await import("./sync-worker-url")
    const syncRes = await fetch(
      `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/link/sync`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    )
    return syncRes.ok
  } catch {
    return false
  }
}

/** Fetches server state for a project, including archive metadata and the
 * caller's role. Returns null for 404 / 403 (the Dashboard treats those as
 * "no server row" and falls back to local state). */
export async function fetchProjectState(
  projectId: string,
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<ProjectStateResponse | null> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    }
  )
  if (!res.ok) return null
  return (await res.json()) as ProjectStateResponse
}
