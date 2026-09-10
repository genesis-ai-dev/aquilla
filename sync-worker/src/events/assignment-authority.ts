// AQU-496 / AQU-1037: assignment authority resolver.
//
// `assignment.create`'s static floor (role-policy.ts REQUIRED_ROLE) is
// PROJECT_LEAD (500) — a manager assigns work to members. This resolver backs
// two org-level policies read from the same org_settings blob:
//
//   - `assignmentMinRole` (AQU-1037): the org-configured floor for
//     assignment.create / reassign / unassign for ANYONE. Defaults to
//     PROJECT_LEAD when unset or off the role ladder.
//   - `allowSelfAssignment` (AQU-496): an opt-in carve-out — when `true`, a
//     below-floor member may still emit `assignment.create` for THEMSELVES
//     (assigneeUserId === caller) — never for anyone else, and never below
//     CONTRIBUTOR (400). Leads/maintainers are unaffected — their role already
//     clears the floor in authorize().
//
// Mirrors resolveExportFloor's shape exactly (export-floor.ts): same
// project -> org_id -> org_settings lookup, same fail-safe default on any
// missing/malformed data. The self-assign default is `false` (leads-only),
// not a role level, because it is a boolean carve-out rather than a floor —
// `false` preserves pre-AQU-496 behavior byte-for-byte when the org hasn't
// opted in.

import { makeRequestCache, type RequestCache } from './request-cache'

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
  // Per-request memo (request-cache.ts): the two rows below are read at most
  // once per request however many events consult them. A fresh throwaway
  // cache when the caller has none keeps the old signature working.
  cache: RequestCache = makeRequestCache(db),
): Promise<AssignmentAuthority> {
  const fallback: AssignmentAuthority = {
    minRole: DEFAULT_ASSIGNMENT_MIN_ROLE,
    allowSelfAssignment: false,
  }
  const orgId = await cache.projectOrgId(projectId)
  if (!orgId) return fallback

  // The cache resolves `null` for a missing row AND for a blob that will not
  // parse — both are "no policy configured" here, exactly as before.
  const parsed = await cache.orgSettings(orgId)
  if (!parsed) return fallback

  const rawMinRole = parsed.assignmentMinRole
  return {
    minRole:
      typeof rawMinRole === 'number' && VALID_ROLE_LEVELS.has(rawMinRole)
        ? rawMinRole
        : DEFAULT_ASSIGNMENT_MIN_ROLE,
    allowSelfAssignment: parsed.allowSelfAssignment === true,
  }
}

/**
 * Backwards-compatible narrow resolver used by existing callers/tests.
 *
 * Returns `false` (safe default — leads-only, current behavior) when:
 *   - the project has no org, OR
 *   - the org has no settings row, OR
 *   - allowSelfAssignment is missing or not exactly `true`.
 */
export async function resolveAllowSelfAssignment(
  db: AquillaDb,
  projectId: string,
  cache: RequestCache = makeRequestCache(db),
): Promise<boolean> {
  return (await resolveAssignmentAuthority(db, projectId, cache)).allowSelfAssignment
}
