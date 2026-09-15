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

import { makeRequestCache, type RequestCache } from './request-cache'

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
  // Per-request memo (request-cache.ts): the two rows below are read at most
  // once per request however many events consult them. A fresh throwaway
  // cache when the caller has none keeps the old signature working.
  cache: RequestCache = makeRequestCache(db),
): Promise<boolean> {
  const orgId = await cache.projectOrgId(projectId)
  if (!orgId) return false

  const parsed = await cache.orgSettings(orgId)
  return parsed?.allowSelfAssignment === true
}
