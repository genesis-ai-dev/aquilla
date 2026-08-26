// AQU-496 / AQU-581: assignment authority resolvers.
//
// `assignment.create`'s static floor (role-policy.ts REQUIRED_ROLE) is
// PROJECT_LEAD (500) — a manager assigns work to members. Two opt-in org
// settings carve exceptions out of that floor, and both are resolved here:
//
//   allowSelfAssignment       (AQU-496) — a below-lead member may emit
//     `assignment.create` for THEMSELVES (assigneeUserId === caller), never
//     for anyone else, and never below CONTRIBUTOR (400).
//
//   allowScopedLaneAssignment (AQU-581) — a below-lead member who has been
//     given lane scopes (AQU-553) may assign work to OTHER people, but only
//     inside a target-language lane they are scoped to. This is the "mentor /
//     coordinator" grant Biblica asked for: the org names who may hand out
//     chapters in the Spanish lane without also handing them org-admin rights.
//
// Leads/maintainers are unaffected by either — their role already clears the
// static floor in authorize().
//
// Mirrors resolveExportFloor's shape exactly (export-floor.ts): same
// project -> org_id -> org_settings lookup, same fail-safe default on any
// missing/malformed data. Defaults here are `false` (leads-only), not a role
// level, because these are boolean carve-outs rather than floors — `false`
// preserves the pre-carve-out behavior byte-for-byte when the org hasn't
// opted in.

/**
 * Read one boolean key out of the project's org_settings blob.
 *
 * Returns `false` (the safe default — leads-only, pre-carve-out behavior)
 * when the project has no org, the org has no settings row, the blob will not
 * parse, or the key is anything other than exactly `true`.
 */
async function resolveOrgBooleanSetting(
  db: AquillaDb,
  projectId: string,
  key: string,
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
    const parsed = JSON.parse(settings.settings) as Record<string, unknown> | null
    return parsed?.[key] === true
  } catch {
    return false
  }
}

/**
 * AQU-496: look up the org's `allowSelfAssignment` setting for the project's
 * org.
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
  return resolveOrgBooleanSetting(db, projectId, "allowSelfAssignment")
}

/**
 * AQU-581: look up the org's `allowScopedLaneAssignment` setting for the
 * project's org — whether a lane-scoped member below PROJECT_LEAD may create
 * assignments for other people inside the lanes they are scoped to.
 *
 * Same fail-safe default as its sibling: `false` unless the org has opted in.
 * The setting alone grants nothing — authorize() additionally requires the
 * caller to carry lane scopes and the assignment's lane to be among them, so
 * flipping this on does NOT hand assignment rights to every contributor.
 */
export async function resolveAllowScopedLaneAssignment(
  db: AquillaDb,
  projectId: string,
): Promise<boolean> {
  return resolveOrgBooleanSetting(db, projectId, "allowScopedLaneAssignment")
}
