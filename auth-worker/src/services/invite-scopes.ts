// AQU-528: language-scoped invite links (Crowdin-style auto-grant-on-join).
//
// A share-link invite may carry an optional set of lane (target-language)
// scopes. When such a link is redeemed by a *new* project member, the accept
// handler auto-applies those lanes as kind='lane' rows in project_member_scopes
// (the same additive write-restriction primitive from AQU-553 / migration
// 0059), so the joiner can only translate the languages the link was minted
// for. Enforcement, sync-token embedding, and sync-worker gating already exist
// and need no change — this module only owns the invite side of the seam.
//
// Storage: a JSON-encoded string[] on project_invites.scope_lanes. A lane value
// is a target-language code; the default lane is the literal empty string ''.

import { ROLE } from "../types"
import type { Env } from "../types"
import { planLaneGrants } from "../../../src/lib/lanes/grant-backfill"
import type { LaneIdentity } from "../../../src/lib/lanes/read-wall"

/** Max distinct lanes a single invite may carry (defensive bound). */
export const MAX_INVITE_SCOPE_LANES = 50
/** Max length of a single lane (target-language) value. */
export const MAX_LANE_VALUE_LENGTH = 64

/**
 * Normalize a caller-supplied lane list for storage: trim to the bound,
 * de-dupe (order-preserving). Returns a JSON string, or null when there are no
 * lanes (an unscoped invite). `undefined`/empty both serialize to null so an
 * omitted field and an explicit `[]` behave identically (= unscoped).
 */
export function serializeScopeLanes(
  lanes: readonly string[] | undefined,
): string | null {
  if (!lanes || lanes.length === 0) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lanes) {
    // '' is the valid default lane — keep it; only collapse dupes.
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
    if (out.length >= MAX_INVITE_SCOPE_LANES) break
  }
  return out.length > 0 ? JSON.stringify(out) : null
}

/**
 * Parse the stored scope_lanes column back into a lane list. Tolerant of
 * null/garbage (a corrupt value must never blow up an accept): anything that
 * isn't a JSON array of strings yields [] (= unscoped, today's behavior).
 */
export function parseScopeLanes(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    return []
  }
}

/**
 * Apply an invite's lane scopes to a member on accept. Idempotent and additive:
 * inserts kind='lane' rows with ON CONFLICT DO NOTHING so re-redeeming the same
 * link never errors and a member who already has a lane keeps it.
 *
 * Callers must only invoke this for a *newly inserted* membership: applying a
 * lane scope to an existing unscoped member would silently narrow their access
 * from all-lanes to one lane, which the "new user signs up via link" flow never
 * intends. `finalRole` is guarded here too — a joiner resolving to
 * project_lead+ must stay unscoped per the AD-12 invariant (member-scopes CRUD
 * rejects scoping leads), so lanes are skipped in that case.
 */
export async function applyInviteLaneScopes(
  env: Env,
  projectId: string,
  userId: number,
  lanes: readonly string[],
  createdBy: number,
  finalRole: number,
): Promise<void> {
  if (finalRole >= ROLE.MAINTAINER || finalRole < ROLE.VIEWER) return

  // Project lead+ stays unscoped on the old scopes table (AD-12). An empty
  // lane list is an unscoped invite. Both still need a grant per current
  // target lane, or the write wall treats "no rows" as "no access".
  const restrictive = finalRole < ROLE.PROJECT_LEAD && lanes.length > 0
  if (restrictive) {
    const now = Date.now()
    for (const lane of lanes) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO project_member_scopes
           (project_id, user_id, kind, value, created_by, created_at)
         VALUES (?, ?, 'lane', ?, ?, ?)
         ON CONFLICT (project_id, user_id, kind, value) DO NOTHING`,
      )
        .bind(projectId, userId, lane, String(createdBy), now)
        .run()
    }
  }

  // AQU-1415: the write wall reads laneGrants (lanes.id). A tag that matches
  // zero or two lanes is skipped. An empty list grants every current lane.
  await applyInviteLaneGrants(
    env,
    projectId,
    userId,
    restrictive ? lanes : [],
    createdBy,
    finalRole,
  )
}

async function applyInviteLaneGrants(
  env: Env,
  projectId: string,
  userId: number,
  lanes: readonly string[],
  createdBy: number,
  finalRole: number,
): Promise<void> {
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT id, name, legacy_tag FROM lanes
      WHERE project_id = ? AND role = 'target'`,
  )
    .bind(projectId)
    .all<{ id: string; name: string; legacy_tag: string | null }>()
  const identities: LaneIdentity[] = results.map((row) => ({
    id: row.id,
    name: row.name,
    legacyTag: row.legacy_tag,
  }))
  const plan = planLaneGrants({
    roleLevel: finalRole,
    laneScopes: lanes,
    lanes: identities,
  })
  for (const grant of plan.grants) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles
         (project_id, user_id, lane, role_level, granted_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id, lane) DO NOTHING`,
    )
      .bind(projectId, userId, grant.laneId, grant.level, createdBy)
      .run()
  }
}
