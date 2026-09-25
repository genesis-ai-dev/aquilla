/**
 * AQU-730: SQL for the read wall. See src/lib/lanes/read-wall.ts.
 *
 * A grant is a lane id. The caller sees that lane's rows and no other target
 * lane, even when another lane shares its language. Source rows are always kept.
 */

import type { SyncTokenClaims } from "../auth"
import {
  laneReadWallEnabled,
  lanesForRequestedTag,
  visibleLaneTags,
  type LaneIdentity,
  type VisibleLaneTags,
} from "../../../src/lib/lanes/read-wall"

export { laneReadWallEnabled, laneTagAllowed, visibilityCacheToken } from "../../../src/lib/lanes/read-wall"
export type { VisibleLaneTags } from "../../../src/lib/lanes/read-wall"

export async function loadTargetLanes(db: AquillaDb, projectId: string): Promise<LaneIdentity[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, legacy_tag FROM lanes
        WHERE project_id = ? AND role = 'target'`,
    )
    .bind(projectId)
    .all<{ id: string; name: string; legacy_tag: string | null }>()
  return results.map((row) => ({ id: row.id, name: row.name, legacyTag: row.legacy_tag }))
}

/**
 * Lane ids this caller may read. `null` means every lane (wall off, or
 * Maintainer / platform). An empty list means no target lane.
 */
export async function grantedLaneIds(
  _db: AquillaDb,
  _projectId: string,
  visible: VisibleLaneTags,
): Promise<readonly string[] | null> {
  if (visible === null) return null
  return [...visible]
}

/**
 * Progress asks for one lane tag. Allowed when that tag is exactly one lane
 * and that lane is among the caller's grants. A tag that matches two lanes
 * is refused.
 */
export async function canReadRequestedLane(
  db: AquillaDb,
  projectId: string,
  visible: VisibleLaneTags,
  lane: string,
): Promise<boolean> {
  if (visible === null) return true
  if (visible.size === 0) return false
  const matches = lanesForRequestedTag(await loadTargetLanes(db, projectId), lane)
  if (matches.length !== 1) return false
  return visible.has(matches[0]!.id)
}

export function visibleLanesForRead(
  flag: string | undefined,
  claims: Pick<SyncTokenClaims, "role" | "src" | "laneGrants">,
): VisibleLaneTags {
  return visibleLaneTags({
    enabled: laneReadWallEnabled(flag),
    role: claims.role,
    src: claims.src,
    laneGrants: claims.laneGrants,
  })
}

/**
 * Extra AND-clause, or null when the caller may see every lane.
 * `laneIds === null` is unrestricted. An empty list hides every target row.
 * `sideExpr` omitted means every row is a target row (validators).
 */
export function targetVisibilityClause(args: {
  laneIds: readonly string[] | null
  sideExpr?: string
  laneIdExpr: string
}): { sql: string; binds: unknown[] } | null {
  if (args.laneIds === null) return null
  if (args.laneIds.length === 0) {
    return args.sideExpr
      ? { sql: `AND ${args.sideExpr} = 'source'`, binds: [] }
      : { sql: "AND FALSE", binds: [] }
  }
  const ph = args.laneIds.map(() => "?").join(", ")
  const match = `${args.laneIdExpr} IN (${ph})`
  if (!args.sideExpr) return { sql: `AND ${match}`, binds: [...args.laneIds] }
  return { sql: `AND (${args.sideExpr} = 'source' OR ${match})`, binds: [...args.laneIds] }
}
