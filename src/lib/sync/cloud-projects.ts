// Server-backed project discovery + hydration. Lets the Dashboard show the
// cloud projects a signed-in user can access (create, owner, or invited)
// even on a fresh device with no IDB state, and lets useProject fall back
// to the server when IDB misses — so pasting a project URL into a second
// browser resolves instead of spinning "Loading..." forever.

import type { ProjectRecord } from "@/lib/parsers/types"
import { FRONTIER_API_URL } from "./sync-token"

export interface CloudProjectSummary {
  id: string
  name: string
  gitlabProjectId: number | null
  /** Present on the single-project endpoint; list endpoint filters archived rows. */
  archivedAt?: string | null
  /** Present on the single-project endpoint; used to show "archived by X" in Trash. */
  archivedBy?: { id: number; username: string } | null
  role: {
    level: number
    name: string
    source: string
  }
}

/**
 * GET /api/v2/projects — every non-archived project the caller can access.
 * Returns [] on any non-2xx or network error (no throw) so Dashboard can
 * render local state even when offline or when the server is unreachable.
 */
export async function fetchAccessibleProjects(
  jwt: string,
  apiUrl: string = FRONTIER_API_URL
): Promise<CloudProjectSummary[]> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/projects`, {
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
 * Build a minimal `ProjectRecord` from a server summary. Required ProjectRecord
 * fields (sourceLanguage, targetLanguage, files, members) don't exist
 * server-side — they live in Y.Doc state and IDB — so we seed empty defaults.
 * Once the user opens a file, sync fills in real data on first write.
 *
 * `origin` stays undefined: cloud-hydrated records are not git-imported, and
 * ProjectOrigin requires clone metadata we don't have.
 */
export function minimalProjectRecord(summary: CloudProjectSummary): ProjectRecord {
  const record: ProjectRecord = {
    id: summary.id,
    name: summary.name,
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    syncRole: {
      level: summary.role.level,
      name: summary.role.name,
      source: summary.role.source,
      fetchedAt: new Date().toISOString(),
    },
  }
  if (summary.archivedAt) {
    record.deletedAt = summary.archivedAt
    if (summary.archivedBy?.username) record.deletedBy = summary.archivedBy.username
  }
  return record
}
