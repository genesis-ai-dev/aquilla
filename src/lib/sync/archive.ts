// Client helpers for frontier-server's project archive endpoints. The archive
// ("move to Trash") action is server-authoritative for cloud-synced projects
// so all collaborators see the tombstone. Purely local projects (no server
// row) get a 404 — callers should fall through to an IDB-only tombstone.

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
  archivedAt: string | null
  archivedBy: { id: number; username: string } | null
  role: { level: number; name: string; source: string }
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
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
