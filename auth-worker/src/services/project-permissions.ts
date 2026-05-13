// Project-permission helpers — the canonical role ladder and a three-tier
// project-role resolver. Mirrors frontier-server's
// `cloudflare/src/services/project-permissions.ts` minus the GitLab fallback
// tier: codex-web has no GitLab integration, so projects without an
// override/creator/org row simply return null.
//
// Mirrored on the client at `src/lib/frontier/roles.ts` (ROLE.* and
// ROLE_NAMES). Roles.test.ts will fail if these drift apart — that's the
// early-warning signal that a coordinated update is needed.

import type { Env } from "../types"
import type { AuthUser } from "../types"

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

export interface ResolvedRole {
  level: number
  name: string
  source: "override" | "creator" | "org"
}

/**
 * Resolve a user's role on a codex project. Three-tier:
 *   1. D1 project_members override wins when present (source: "override").
 *   2. Else: projects.created_by == user.id implies owner (source: "creator").
 *   3. Else: org_members row for projects.org_id grants role on every project
 *      in that org (source: "org").
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

async function resolveProjectRoleInternal(
  env: Env,
  user: AuthUser,
  projectId: string,
  opts: { includeArchived: boolean },
): Promise<ResolvedRole | null> {
  const project = await env.AQUILLA_DB.prepare(
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

  // Tier 1: explicit override.
  const override = await env.AQUILLA_DB.prepare(
    "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?",
  )
    .bind(projectId, user.id)
    .first<{ role_level: number }>()

  if (override) {
    return {
      level: override.role_level,
      name: ROLE_NAMES[override.role_level] ?? "unknown",
      source: "override",
    }
  }

  // Tier 2: implicit owner via created_by.
  if (project.created_by === user.id) {
    return { level: 700, name: "owner", source: "creator" }
  }

  // Tier 3: org membership grants role on every project in that org.
  if (project.org_id != null) {
    const orgRow = await env.AQUILLA_DB.prepare(
      "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
    )
      .bind(project.org_id, user.id)
      .first<{ role_level: number }>()
    if (orgRow) {
      return {
        level: orgRow.role_level,
        name: ROLE_NAMES[orgRow.role_level] ?? "unknown",
        source: "org",
      }
    }
  }

  return null
}
