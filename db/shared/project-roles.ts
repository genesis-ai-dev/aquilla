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
// ORG_WIDE_ACCESS_FLOOR (maintainer) — org-level roles below this contribute
// no project access.
const ORG_WIDE_ACCESS_FLOOR = 600

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
  if (project.archived_at) return null

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
  // AQU-435: the org path fires only at Maintainer+ — a sub-maintainer
  // org_members row contributes nothing. Mirrors auth-worker's
  // project-permissions.ts::resolveProjectRole; without this floor a PAT
  // held by any org member (down to Viewer) resolved to full org-wide
  // project access via the external Agent API.
  if (org && org.role_level >= ORG_WIDE_ACCESS_FLOOR)
    contributions.push({ source: "org", level: org.role_level })
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
