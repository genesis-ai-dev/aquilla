// AQU-496 / AQU-581 / AQU-1037: assignment authority resolver.
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
//   - `allowScopedLaneAssignment` (AQU-581): a second, narrower opt-in
//     carve-out — when `true`, a below-floor member (CONTRIBUTOR 400+) who
//     carries lane scopes (AQU-553) may emit `assignment.create` for OTHER
//     people, but ONLY inside a target-language lane they are scoped to. This
//     is the "mentor / coordinator" grant: the org names who may hand out
//     chapters in the Spanish lane without also handing them org-admin
//     rights. The setting alone grants nothing — authorize() additionally
//     requires the caller to carry lane scopes covering the assignment.
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
  /** AQU-581: the lane-delegate carve-out's org setting. Default false. */
  allowScopedLaneAssignment: boolean
}

const VALID_ROLE_LEVELS = new Set([100, 200, 300, 400, 500, 600, 700])

/**
 * Resolve both assignment policies in one project → org_settings lookup:
 * - assignmentMinRole: who may assign/reassign/unassign work for anyone.
 * - allowSelfAssignment: below-floor CONTRIBUTOR+ may create for themselves.
 * - allowScopedLaneAssignment (AQU-581): below-floor CONTRIBUTOR+ who carry
 *   lane scopes may create for OTHERS inside those lanes.
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
    allowScopedLaneAssignment: false,
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
    allowScopedLaneAssignment: parsed.allowScopedLaneAssignment === true,
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

/**
 * AQU-581: look up the org's `allowScopedLaneAssignment` setting for the
 * project's org — whether a lane-scoped member below the assignment floor may
 * create assignments for other people inside the lanes they are scoped to.
 *
 * Same fail-safe default as its AQU-496 sibling: `false` unless the org has
 * opted in. The setting alone grants nothing — authorize() additionally
 * requires the caller to carry lane scopes and the assignment's lane to be
 * among them, so flipping this on does NOT hand assignment rights to every
 * contributor.
 */
export async function resolveAllowScopedLaneAssignment(
  db: AquillaDb,
  projectId: string,
  cache: RequestCache = makeRequestCache(db),
): Promise<boolean> {
  return (await resolveAssignmentAuthority(db, projectId, cache)).allowScopedLaneAssignment
}
