// AQU-496: self-assignment authority resolver.
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

/**
 * Look up the org's `allowSelfAssignment` setting for the project's org.
 *
 * Returns `false` (safe default — leads-only, current behavior) when:
 *   - the project has no org, OR
 *   - the org has no settings row, OR
 *   - allowSelfAssignment is missing or not exactly `true`.
 */
export async function resolveAllowSelfAssignment(
  db: AquillaDb,
  projectId: string,
): Promise<boolean> {
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  if (!project?.org_id) return false

  const settings = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string }>()

  if (!settings) return false

  try {
    const parsed = JSON.parse(settings.settings)
    return parsed?.allowSelfAssignment === true
  } catch {
    return false
  }
}
