// Shared max-wins project-role resolution for the Agent API (AQU-533 §2 —
// "live role/membership resolution on every call"). Lives in db/shared/ so the
// command/permission layer can resolve a caller's effective project role
// without importing an auth-worker-internal service (which depends on
// auth-worker's Env / AuthUser shapes and its platform-admin middleware).
//
// SWARM-TODO(AQU-533): this is a faithful PORT of
// auth-worker/src/services/project-permissions.ts::resolveProjectRole — the SQL
// and the AD-12 max-wins semantics are duplicated on purpose so the two layers
// stay decoupled during the Agent-API build-out. Once the command layer is the
// single caller, collapse auth-worker's resolver onto this one (or vice-versa)
// and delete the duplicate. Until then, changes to the role-resolution SQL MUST
// be mirrored in both files.
//
// Differences from the auth-worker original, by design:
//   - Takes the bare `AquillaDb` handle, not auth-worker's `Env`.
//   - Takes a minimal `{ id, email? }` user, not the fully-hydrated AuthUser.
//   - The platform-admin allowlist is passed in as `adminEmails` (comma-
//     separated) rather than read from an env binding — auth-worker's
//     isPlatformAdminEmail isn't importable here.

import type { AquillaDb, AquillaStatement } from "../shim/postgres"

// AQU-435: mirrors auth-worker/src/services/project-permissions.ts's
// ORG_WIDE_ACCESS_FLOOR (maintainer) — org-level roles below this open no
// project on their own.
export const ORG_WIDE_ACCESS_FLOOR = 600

/**
 * AQU-1274: how much the org path contributes to max-wins.
 *
 * AQU-435 made a sub-maintainer `org_members` row contribute *nothing*, which
 * conflated two separate questions:
 *
 *   (a) may an org grant OPEN a project the user has no other path into?
 *       — correctly Maintainer+ only; that is what AQU-435 was about.
 *   (b) may an org grant raise the LEVEL on a project the user already
 *       reaches by another path? — collateral damage: it was silenced too.
 *
 * The result was a silent demotion. A Project Lead (500) on the org who
 * reaches a project through a team attached at Contributor (400) resolved to
 * 400: her higher org role was dropped on the floor, which is exactly the
 * demotion AD-12 max-wins forbids ("adding a grant at a lower role does not
 * demote"). Reported live by the Biblica ETT Pattani Malay team.
 *
 * So a sub-floor org role contributes its level iff:
 *
 *   1. a **team (group) grant already opens the project** — the user gains no
 *      project they could not already see, so AQU-435's visibility floor is
 *      fully intact (a sub-maintainer org member with no other path still
 *      resolves to null and still 403s); and
 *   2. there is **no direct `project_members` row** — an explicit per-person,
 *      per-project grant is a deliberate decision and must still be able to
 *      restrict someone below their org role. Only the bulk team attachment,
 *      which is routinely left at the Contributor default, stops demoting.
 *
 * Returns the level the org path contributes, or null for no contribution.
 */
export function orgPathContribution(args: {
  orgLevel: number | null
  hasDirectGrant: boolean
  hasGroupGrant: boolean
}): number | null {
  const { orgLevel, hasDirectGrant, hasGroupGrant } = args
  if (orgLevel == null) return null
  // Maintainer+ is an access path in its own right (AQU-435, unchanged).
  if (orgLevel >= ORG_WIDE_ACCESS_FLOOR) return orgLevel
  // Below the floor: never creates access, and never overrides an explicit
  // per-project grant. It only stops a team attachment from demoting.
  if (hasDirectGrant || !hasGroupGrant) return null
  return orgLevel
}

const ROLE_NAMES: Record<number, string> = {
  100: "viewer",
  200: "commenter",
  300: "reviewer",
  400: "contributor",
  500: "project_lead",
  600: "maintainer",
  700: "owner",
}

/** Resolved role with attribution — mirrors auth-worker's RoleResolution. */
export interface SharedRoleResolution {
  level: number
  name: string
  source: "override" | "group" | "org" | "creator" | "platform"
}

interface PathContribution {
  source: SharedRoleResolution["source"]
  level: number
}

/** Parse `ADMIN_EMAILS`-style allowlist into a set of trimmed, lowercased emails. */
function parseAdminEmails(adminEmails: string | undefined): Set<string> {
  return new Set(
    (adminEmails ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  )
}

/**
 * Run a `.first()` and swallow the error to null, so a missing / pending-
 * migration table on one path doesn't 500 a request the other paths could have
 * answered. Mirrors safeFirst in the auth-worker original.
 */
async function safeFirst<T>(stmt: AquillaStatement, label: string): Promise<T | null> {
  try {
    return await stmt.first<T>()
  } catch (err) {
    console.warn(`[resolveProjectRoleShared] ${label} query failed:`, err)
    return null
  }
}

/**
 * Resolve a user's effective role on a project — max-wins across direct
 * (override), group, org, creator, and platform paths (AD-12). Archived
 * projects resolve to null. Returns `{ level, source }` (name derivable from
 * level via ROLE_NAMES); null when the user has no contributing path.
 *
 * @param adminEmails comma-separated ADMIN_EMAILS allowlist; when the user's
 *        email is on it, they get owner-level (700) on every project (lowest
 *        tie priority, so a genuine grant keeps attribution).
 */
export async function resolveProjectRoleShared(
  db: AquillaDb,
  user: { id: string; email?: string | null },
  projectId: string,
  adminEmails?: string,
): Promise<{ level: number; source: string } | null> {
  return resolveProjectRoleSharedInternal(db, user, projectId, adminEmails, false)
}

/**
 * Same as resolveProjectRoleShared, but resolves even when `archived_at` is
 * set. Mirrors auth-worker's resolveProjectRoleIncludingArchived, which the
 * archive / unarchive / rename endpoints use: an owner still owns a trashed
 * project, and unarchiving one is impossible if the resolver denies every
 * archived row. Use ONLY on lifecycle paths that must reach a trashed project;
 * ordinary read/write authority stays on resolveProjectRoleShared.
 */
export async function resolveProjectRoleIncludingArchivedShared(
  db: AquillaDb,
  user: { id: string; email?: string | null },
  projectId: string,
  adminEmails?: string,
): Promise<{ level: number; source: string } | null> {
  return resolveProjectRoleSharedInternal(db, user, projectId, adminEmails, true)
}

async function resolveProjectRoleSharedInternal(
  db: AquillaDb,
  user: { id: string; email?: string | null },
  projectId: string,
  adminEmails: string | undefined,
  includeArchived: boolean,
): Promise<{ level: number; source: string } | null> {
  const project = await db
    .prepare(`SELECT id, org_id, created_by, archived_at FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{
      id: string
      org_id: number | null
      created_by: number
      archived_at: string | null
    }>()

  if (!project) return null
  if (project.archived_at && !includeArchived) return null

  // All four grant-path queries run in parallel — independent reads. Each is
  // wrapped so a single missing/pending-migration table degrades that path to
  // "no contribution" rather than 500'ing the whole request.
  const [override, group, org] = await Promise.all([
    safeFirst<{ role_level: number }>(
      db
        .prepare(
          `SELECT role_level FROM project_members
           WHERE project_id = ? AND user_id = ?`,
        )
        .bind(projectId, user.id),
      "project_members",
    ),
    safeFirst<{ role_level: number | null }>(
      db
        .prepare(
          `SELECT MAX(gpg.role_level) AS role_level
           FROM group_project_grants gpg
           JOIN group_members gm
             ON gm.group_id = gpg.group_id
           WHERE gpg.project_id = ? AND gm.user_id = ?`,
        )
        .bind(projectId, user.id),
      "group_project_grants",
    ),
    project.org_id != null
      ? safeFirst<{ role_level: number }>(
          db
            .prepare(
              `SELECT role_level FROM org_members
               WHERE org_id = ? AND user_id = ?`,
            )
            .bind(project.org_id, user.id),
          "org_members",
        )
      : Promise.resolve(null),
  ])

  const contributions: PathContribution[] = []
  if (override) contributions.push({ source: "override", level: override.role_level })
  if (group?.role_level != null)
    contributions.push({ source: "group", level: group.role_level })
  // AQU-435 / AQU-1274: Maintainer+ is an access path on its own; below that
  // the org role only keeps a team attachment from demoting someone. Without
  // the floor a PAT held by any org member (down to Viewer) resolved to full
  // org-wide project access via the external Agent API — see
  // orgPathContribution for the full rule.
  const orgContribution = orgPathContribution({
    orgLevel: org?.role_level ?? null,
    hasDirectGrant: override != null,
    hasGroupGrant: group?.role_level != null,
  })
  if (orgContribution != null)
    contributions.push({ source: "org", level: orgContribution })
  if (String(project.created_by) === String(user.id))
    contributions.push({ source: "creator", level: 700 })
  // Platform operators (ADMIN_EMAILS allowlist) get owner-level on every
  // project — the cross-tenant support/oversight path. Lowest tie priority so a
  // genuine grant keeps attribution when the admin is also a real member.
  const email = user.email?.trim().toLowerCase()
  if (email && parseAdminEmails(adminEmails).has(email))
    contributions.push({ source: "platform", level: 700 })

  if (contributions.length === 0) return null

  // Max-wins. On ties, declaration order (override > group > org > creator >
  // platform) wins attribution.
  const sourcePriority: Record<SharedRoleResolution["source"], number> = {
    override: 4,
    group: 3,
    org: 2,
    creator: 1,
    platform: 0,
  }
  contributions.sort((a, b) => {
    if (a.level !== b.level) return b.level - a.level
    return sourcePriority[b.source] - sourcePriority[a.source]
  })
  const winner = contributions[0]
  return { level: winner.level, source: winner.source }
}

/** Human-readable name for a role level (mirrors auth-worker ROLE_NAMES). */
export function roleNameForLevelShared(level: number): string {
  return ROLE_NAMES[level] ?? "unknown"
}
