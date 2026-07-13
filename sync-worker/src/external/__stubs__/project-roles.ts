// SWARM-TODO: delete after W1-A merge — replace imports with
// `db/shared/project-roles`. W1-A owns the canonical, DB-first role resolver
// shared by auth-worker + sync-worker (COMMON contract). This stub implements
// the same AD-12 max-wins logic against the live grant tables so W1-B's role
// enforcement is real in tests. The `resolveProjectRoleShared` signature MUST
// stay identical to the real module.

export interface SharedRoleResolution {
  level: number
  name: string
  source: 'override' | 'group' | 'org' | 'creator'
}

const ROLE_NAMES: Record<number, string> = {
  100: 'viewer',
  200: 'commenter',
  300: 'reviewer',
  400: 'contributor',
  500: 'project_lead',
  600: 'maintainer',
  700: 'owner',
}

async function safeFirst<T>(stmt: AquillaStatement): Promise<T | null> {
  try {
    return await stmt.first<T>()
  } catch {
    return null
  }
}

/**
 * Resolve a user's effective role on a project — max-wins across direct,
 * group, org, and creator paths (AD-12). Mirrors
 * auth-worker/src/services/project-permissions.resolveProjectRole but takes a
 * raw `AquillaDb` + numeric `userId` (no worker Env/AuthUser), which is what the
 * shared cross-worker helper exposes. Returns null when the user has no grant.
 */
export async function resolveProjectRoleShared(
  db: AquillaDb,
  projectId: string,
  userId: number,
): Promise<SharedRoleResolution | null> {
  const project = await safeFirst<{ org_id: number | null; created_by: number }>(
    db
      .prepare(`SELECT org_id, created_by FROM projects WHERE id = ?`)
      .bind(projectId),
  )
  if (!project) return null

  const [override, group, org] = await Promise.all([
    safeFirst<{ role_level: number }>(
      db
        .prepare(`SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?`)
        .bind(projectId, userId),
    ),
    safeFirst<{ role_level: number | null }>(
      db
        .prepare(
          `SELECT MAX(gpg.role_level) AS role_level
             FROM group_project_grants gpg
             JOIN group_members gm ON gm.group_id = gpg.group_id
            WHERE gpg.project_id = ? AND gm.user_id = ?`,
        )
        .bind(projectId, userId),
    ),
    project.org_id != null
      ? safeFirst<{ role_level: number }>(
          db
            .prepare(`SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?`)
            .bind(project.org_id, userId),
        )
      : Promise.resolve(null),
  ])

  const contributions: { source: SharedRoleResolution['source']; level: number }[] = []
  if (override) contributions.push({ source: 'override', level: override.role_level })
  if (group?.role_level != null) contributions.push({ source: 'group', level: group.role_level })
  if (org) contributions.push({ source: 'org', level: org.role_level })
  if (project.created_by === userId) contributions.push({ source: 'creator', level: 700 })

  if (contributions.length === 0) return null

  const priority: Record<SharedRoleResolution['source'], number> = {
    override: 4,
    group: 3,
    org: 2,
    creator: 1,
  }
  contributions.sort((a, b) => (a.level !== b.level ? b.level - a.level : priority[b.source] - priority[a.source]))
  const winner = contributions[0]
  return { level: winner.level, name: ROLE_NAMES[winner.level] ?? 'unknown', source: winner.source }
}
