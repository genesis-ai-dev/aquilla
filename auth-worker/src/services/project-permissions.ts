// Project-permission helpers — the canonical role ladder and an AD-12
// max-wins resolver across all four grant paths:
//
//   1. Direct `project_members` row (`override`).
//   2. Group attachments: `group_project_grants` JOIN `group_members`
//      (`group`). Added in migration 0007 per spec §"Group project grant".
//   3. Org-wide grant: `org_members` when `project.org_id IS NOT NULL`
//      (`org`).
//   4. Creator fallback: `projects.created_by = user.id` → owner (`creator`).
//
// **Effective role = max(role_level) over every path that grants something.**
// Per spec 02-foundations.md AD-12, adding an explicit override at a lower
// level than the user's group/org grant does NOT demote — the higher grant
// wins. Demotion requires removing every additive grant path.
//
// Mirrored on the client at `src/lib/frontier/roles.ts` (ROLE.* and
// ROLE_NAMES). Tests will fail if these drift apart — early-warning signal
// that a coordinated update is needed.

import type { Env } from "../types"
import type { AuthUser, RoleResolution } from "../types"
import { isPlatformAdminEmail } from "../middleware/platform-admin"

export const ROLE_NAMES: Record<number, string> = {
  100: "viewer",
  200: "commenter",
  300: "reviewer",
  400: "contributor",
  500: "project_lead",
  600: "maintainer",
  700: "owner",
}

export const ALL_ROLE_LEVELS = [100, 200, 300, 400, 500, 600, 700] as const
export type RoleLevel = (typeof ALL_ROLE_LEVELS)[number]

// Capped at contributor — managerial roles never granted via tokenized URL.
export const LINK_ROLE_ALLOWED = [100, 200, 300, 400] as const
export type LinkRoleLevel = (typeof LINK_ROLE_ALLOWED)[number]

export function isCanonicalRoleLevel(n: number): n is RoleLevel {
  return (ALL_ROLE_LEVELS as readonly number[]).includes(n)
}

export function isLinkRoleLevel(n: number): n is LinkRoleLevel {
  return (LINK_ROLE_ALLOWED as readonly number[]).includes(n)
}

export type ResolvedRole = RoleResolution

/**
 * Resolve a user's effective role on a project — max-wins across direct,
 * group, org, and creator paths (AD-12).
 *
 * Archived projects return null (as if they didn't exist) so normal
 * /sync-token traffic 403s cleanly. Use `resolveProjectRoleIncludingArchived`
 * for restore / Trash-view paths where archived rows must still resolve.
 */
export async function resolveProjectRole(
  env: Env,
  user: AuthUser,
  projectId: string,
): Promise<ResolvedRole | null> {
  return resolveProjectRoleInternal(env, user, projectId, { includeArchived: false })
}

/**
 * Same as resolveProjectRole but resolves even when archived_at is set.
 * Used by archive/unarchive endpoints (an owner still owns a trashed
 * project) and by GET /:projectId for the Trash view.
 */
export async function resolveProjectRoleIncludingArchived(
  env: Env,
  user: AuthUser,
  projectId: string,
): Promise<ResolvedRole | null> {
  return resolveProjectRoleInternal(env, user, projectId, { includeArchived: true })
}

interface PathContribution {
  source: ResolvedRole["source"]
  level: number
}

/**
 * Run a `.first()` and swallow the error to null. Used for the four
 * role-resolution paths so a missing / pending-migration table on one path
 * doesn't 500 a request the other paths could have answered. Errors are
 * logged so the underlying ops issue stays visible — silently swallowed
 * here, surfaced in worker logs.
 */
async function safeFirst<T>(
  stmt: AquillaStatement,
  label: string,
): Promise<T | null> {
  try {
    return await stmt.first<T>()
  } catch (err) {
    console.warn(`[resolveProjectRole] ${label} query failed:`, err)
    return null
  }
}

async function resolveProjectRoleInternal(
  env: Env,
  user: AuthUser,
  projectId: string,
  opts: { includeArchived: boolean },
): Promise<ResolvedRole | null> {
  const project = await env.AQUILLA_PG.prepare(
    `SELECT id, org_id, created_by, archived_at FROM projects WHERE id = ?`,
  )
    .bind(projectId)
    .first<{
      id: string
      org_id: number | null
      created_by: number
      archived_at: string | null
    }>()

  if (!project) return null
  if (!opts.includeArchived && project.archived_at) return null

  // All four path queries run in parallel — they're independent reads.
  // Each path is wrapped so a single missing/pending-migration table
  // (e.g. group_project_grants before 0007 has applied on a target env)
  // degrades that path to "no contribution" rather than 500'ing the whole
  // request. The user-visible failure mode is "you don't have group access
  // on this project" — accurate when the table truly is empty/absent.
  const [override, group, org] = await Promise.all([
    safeFirst<{ role_level: number }>(
      env.AQUILLA_PG.prepare(
        `SELECT role_level FROM project_members
         WHERE project_id = ? AND user_id = ?`,
      ).bind(projectId, user.id),
      "project_members",
    ),
    safeFirst<{ role_level: number | null }>(
      env.AQUILLA_PG.prepare(
        `SELECT MAX(gpg.role_level) AS role_level
         FROM group_project_grants gpg
         JOIN group_members gm
           ON gm.group_id = gpg.group_id
         WHERE gpg.project_id = ? AND gm.user_id = ?`,
      ).bind(projectId, user.id),
      "group_project_grants",
    ),
    project.org_id != null
      ? safeFirst<{ role_level: number }>(
          env.AQUILLA_PG.prepare(
            `SELECT role_level FROM org_members
             WHERE org_id = ? AND user_id = ?`,
          ).bind(project.org_id, user.id),
          "org_members",
        )
      : Promise.resolve(null),
  ])

  const contributions: PathContribution[] = []
  if (override) contributions.push({ source: "override", level: override.role_level })
  if (group?.role_level != null)
    contributions.push({ source: "group", level: group.role_level })
  if (org) contributions.push({ source: "org", level: org.role_level })
  if (project.created_by === user.id)
    contributions.push({ source: "creator", level: 700 })
  // Platform operators (ADMIN_EMAILS allowlist) get owner-level on every
  // project — the cross-tenant support/oversight path. Lowest tie priority so
  // a genuine grant keeps attribution when the admin is also a real member.
  if (isPlatformAdminEmail(env, user.email))
    contributions.push({ source: "platform", level: 700 })

  if (contributions.length === 0) return null

  // Max-wins. On ties, declaration order (override > group > org > creator >
  // platform) wins attribution — see RoleResolution.source jsdoc.
  const sourcePriority: Record<ResolvedRole["source"], number> = {
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
  return {
    level: winner.level,
    name: ROLE_NAMES[winner.level] ?? "unknown",
    source: winner.source,
  }
}

/**
 * Source-project access check for linked target projects (AD-9 /
 * 03-data-model.md §"Source-project linking", §AD-9 "Permissions").
 *
 * When a project T is linked to upstream source project U via
 * `projects.source_project_id`, members of T receive an implicit read on
 * U's source-side cells — but no other rights on U.
 *
 * Returns true iff the user can read source cells belonging to
 * `sourceProjectId` while operating in the context of `viewerProjectId`.
 * The two valid paths:
 *   1. User is a member of `sourceProjectId` directly (any role) — full
 *      project read access trivially covers source.
 *   2. `viewerProjectId.source_project_id == sourceProjectId` AND user is
 *      a member of `viewerProjectId` — implicit read-only access via the
 *      link.
 *
 * Note: reading source from upstream does NOT grant any other rights on
 * upstream — callers must NOT use this resolver as a substitute for
 * resolveProjectRole when operating on upstream's target side, comments,
 * settings, etc.
 */
export async function canReadSourceCells(
  env: Env,
  user: AuthUser,
  args: { sourceProjectId: string; viewerProjectId: string },
): Promise<boolean> {
  // Path 1: direct membership in the source project.
  const direct = await resolveProjectRole(env, user, args.sourceProjectId)
  if (direct) return true

  // Path 2: viewer project is linked to this source AND the user is a
  // member of the viewer project.
  if (args.viewerProjectId === args.sourceProjectId) {
    // Trivial loop — viewer == source. Path 1 above would have caught
    // genuine access; if we got here, user isn't a member, so false.
    return false
  }

  const viewer = await env.AQUILLA_PG.prepare(
    "SELECT source_project_id FROM projects WHERE id = ?",
  )
    .bind(args.viewerProjectId)
    .first<{ source_project_id: string | null }>()

  if (!viewer || viewer.source_project_id !== args.sourceProjectId) {
    return false
  }

  const viewerRole = await resolveProjectRole(env, user, args.viewerProjectId)
  return viewerRole != null
}
