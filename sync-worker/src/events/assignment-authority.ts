// AQU-496 / AQU-1037: assignment authority resolver.
//
// `assignment.create`'s static floor (role-policy.ts REQUIRED_ROLE) is
// PROJECT_LEAD (500) — a manager assigns work to members. This resolver backs
// an opt-in carve-out: when the project's org has `allowSelfAssignment: true`
// in its org_settings blob, a below-lead member may still emit
// `assignment.create` for THEMSELVES (assigneeUserId === caller) — never for
// anyone else, and never below CONTRIBUTOR (400). Leads/maintainers are
// unaffected — their role already clears the static floor in authorize().
//
// Mirrors resolveExportFloor's shape exactly (export-floor.ts): same
// project -> org_id -> org_settings lookup, same fail-safe default on any
// missing/malformed data. Default here is `false` (leads-only), not a role
// level, because this is a boolean carve-out rather than a floor — `false`
// preserves pre-AQU-496 behavior byte-for-byte when the org hasn't opted in.

export const DEFAULT_ASSIGNMENT_MIN_ROLE = 500

export interface AssignmentAuthority {
  minRole: number
  allowSelfAssignment: boolean
}

const VALID_ROLE_LEVELS = new Set([100, 200, 300, 400, 500, 600, 700])

/**
 * Resolve both assignment policies in one project → org_settings lookup:
 * - assignmentMinRole: who may assign/reassign/unassign work for anyone.
 * - allowSelfAssignment: below-floor CONTRIBUTOR+ may create for themselves.
 *
 * Missing/malformed data preserves the historical PROJECT_LEAD floor and
 * disabled self-assignment.
 */
export async function resolveAssignmentAuthority(
  db: AquillaDb,
  projectId: string,
): Promise<AssignmentAuthority> {
  const fallback = {
    minRole: DEFAULT_ASSIGNMENT_MIN_ROLE,
    allowSelfAssignment: false,
  }
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  if (!project?.org_id) return fallback

  const settings = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string }>()

  if (!settings) return fallback

  try {
    const parsed = JSON.parse(settings.settings) as Record<string, unknown> | null
    const rawMinRole = parsed?.assignmentMinRole
    return {
      minRole:
        typeof rawMinRole === 'number' && VALID_ROLE_LEVELS.has(rawMinRole)
          ? rawMinRole
          : DEFAULT_ASSIGNMENT_MIN_ROLE,
      allowSelfAssignment: parsed?.allowSelfAssignment === true,
    }
  } catch {
    return fallback
  }
}

/** Backwards-compatible narrow resolver used by existing callers/tests. */
export async function resolveAllowSelfAssignment(
  db: AquillaDb,
  projectId: string,
): Promise<boolean> {
  return (await resolveAssignmentAuthority(db, projectId)).allowSelfAssignment
}
