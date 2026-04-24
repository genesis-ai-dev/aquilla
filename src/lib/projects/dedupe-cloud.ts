// Dedup cloud-project summaries against local IDB records. Two things to
// reconcile:
//  1. A project that exists in both by the same id (same canonical row in
//     frontier-db + a local IDB record created via hydration or creation).
//  2. A GitLab-imported project whose LOCAL id (generated at import time)
//     differs from the CF-native id the server assigned when /sync-token
//     auto-registered it. Both carry the same `gitlabProjectId` so we dedup
//     on that as a second key.

import type { ProjectRecord } from "@/lib/parsers/types"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

/**
 * Returns cloud projects that are NOT already represented locally (active
 * or trashed). Preserves input order.
 */
export function filterCloudOnly(
  cloudProjects: CloudProjectSummary[],
  locals: ProjectRecord[],
  trashed: ProjectRecord[]
): CloudProjectSummary[] {
  const knownIds = new Set<string>()
  const knownGitlabIds = new Set<number>()
  for (const p of [...locals, ...trashed]) {
    knownIds.add(p.id)
    const gid = p.origin?.kind === "git" ? p.origin.gitlabProjectId : null
    if (typeof gid === "number") knownGitlabIds.add(gid)
  }
  return cloudProjects.filter((cp) => {
    if (knownIds.has(cp.id)) return false
    if (cp.gitlabProjectId != null && knownGitlabIds.has(cp.gitlabProjectId)) return false
    return true
  })
}
