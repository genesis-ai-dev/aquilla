// AQU-2455: a member removed from a project (or from the team that was their only
// path) while the editor is open. The first refused save is the reliable
// signal — the live `member.removed` frame is best-effort. Archived and frozen
// projects use the same mint 403 and must not take this path.

import { forgetPortfolioProject } from "@/lib/frontier/portfolio-seed"
import { ALL_ORGS_PARAM, orgHomePath, orgProjectsPath } from "@/lib/navigation/org-paths"

const NAMED_MINT_DENIALS = [
  "No access to project",
  "Project is archived",
  "Project is frozen",
] as const

/** Pull the auth-worker's `{ error }` string off a sync-token failure body. */
export function syncTokenDenialMessage(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim()
    } catch {
      return null
    }
    return null
  }
  return trimmed.slice(0, 300)
}

/**
 * What the outbox stores for a mint 403. Named server denials are kept so an
 * archived or frozen project is not later read as lost access. Anything else
 * keeps the historical generic reason (a body-less 403, or a proxy "Forbidden").
 */
export function mint403QuarantineReason(error: string | null | undefined): string {
  const text = error?.trim()
  if (!text) return "no access to this change's project"
  for (const phrase of NAMED_MINT_DENIALS) {
    if (text === phrase || text.includes(phrase)) return phrase
  }
  return "no access to this change's project"
}

/**
 * The refusal means this account can no longer open the project. Role, scope,
 * lane, validation, elevation, archived, and frozen refusals are not this.
 */
export function isLostProjectAccess(reason: string | null | undefined): boolean {
  if (!reason) return false
  const text = reason.toLowerCase()
  if (text.includes("archived") || text.includes("frozen") || text.includes("elevation")) {
    return false
  }
  if (text.includes("membership revoked")) return true
  if (text.includes("no access to project")) return true
  return text === "no access to this change's project"
}

/** Where the back control on the refusal screen goes after a mid-session removal. */
export function revokedOpenProjectListPath(
  activeOrgId: number | null,
  isAllOrgs: boolean,
): string {
  if (isAllOrgs || activeOrgId == null) return orgHomePath(ALL_ORGS_PARAM)
  return orgProjectsPath(activeOrgId)
}

/**
 * Drop the project from this tab's portfolio paint, ask the accessible-project
 * directory to reload, and open the org project list. The list's own fetch
 * replaces that paint; forgetting first is what keeps the old row (and its
 * stats) off the first frame.
 */
export function leaveRevokedOpenProject(args: {
  jwt: string | null
  projectId: string
  activeOrgId: number | null
  isAllOrgs: boolean
  refreshAccessibleProjects: () => void | Promise<unknown>
  navigate: (path: string) => void
}): void {
  if (args.jwt && args.projectId) forgetPortfolioProject(args.jwt, args.projectId)
  void args.refreshAccessibleProjects()
  args.navigate(revokedOpenProjectListPath(args.activeOrgId, args.isAllOrgs))
}
