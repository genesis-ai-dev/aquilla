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
  READ_WALL_MAINTAINER,
  scopedTargetVisibilityClause,
  visibilityCacheToken,
  visibleLaneTags,
  type LaneIdentity,
  type VisibleLaneTags,
} from "../../../src/lib/lanes/read-wall"
import { laneTagForArchiveCheck } from "../../../src/lib/lanes/archived-lane"
import { laneScopeIds, laneScopeTags } from "../../../src/lib/lanes/scope-ids"
import { laneDisplayNameSql } from "../../../db/shared/lanes"
import { wireLegacyTagSql } from "../../../db/shared/lane-sql"

export { laneReadWallEnabled, laneTagAllowed, visibilityCacheToken } from "../../../src/lib/lanes/read-wall"
export type { VisibleLaneTags } from "../../../src/lib/lanes/read-wall"

export async function loadTargetLanes(db: AquillaDb, projectId: string): Promise<LaneIdentity[]> {
  const { results } = await db
    .prepare(
      `SELECT id, ${laneDisplayNameSql("lanes")} AS name, legacy_tag FROM lanes
        WHERE project_id = ? AND role = 'target'`,
    )
    .bind(projectId)
    .all<{ id: string; name: string; legacy_tag: string | null }>()
  return results.map((row) => ({ id: row.id, name: row.name, legacyTag: row.legacy_tag }))
}

/**
 * Lane ids this caller may read. `null` means every lane (wall off, or
 * project lead / platform). An empty list means no target lane.
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
 * AQU-1039: while the read wall is off, a member who has lane scopes still
 * only reads those lanes. The wall's grant list stays the authority when it
 * is on (`wallLaneIds !== null`). Maintainer and platform are unrestricted.
 * Returns null when this caller is not limited. `token` folds into the cells
 * ETag so two members do not share a cached body.
 */
export async function scopeReadClause(
  db: AquillaDb,
  projectId: string,
  claims: Pick<SyncTokenClaims, "role" | "src" | "scopes">,
  wallLaneIds: readonly string[] | null,
): Promise<{ sql: string; binds: unknown[]; token: string } | null> {
  if (wallLaneIds !== null) return null
  if (claims.src === "platform") return null
  if (claims.role >= READ_WALL_MAINTAINER) return null
  const values = (claims.scopes ?? []).filter((scope) => scope.kind === "lane").map((scope) => scope.value)
  if (values.length === 0) return null
  const lanes = await loadTargetLanes(db, projectId)
  const ids = [...laneScopeIds(values, lanes).ids]
  const tags = [...laneScopeTags(values, lanes)]
  // The tag match resolves through the row's lane_id (lanes.legacy_tag), not
  // the projection `target_lang` column: AQU-1611b leaves that column at its
  // default ('') on every new row, so comparing it would let a '' tag match
  // every lane and a real tag match none. Both queries that take this clause
  // select from bare `cells`.
  const clause = scopedTargetVisibilityClause({
    ids,
    tags,
    sideExpr: "side",
    laneIdExpr: "lane_id",
    targetLangExpr: wireLegacyTagSql("cells"),
  })
  return { ...clause, token: visibilityCacheToken(new Set([...ids, ...tags])) }
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

/**
 * The target lanes {@link eventRowsForVisibleLanes} resolves a lane tag
 * against. Empty when the caller is unrestricted or holds no grant: neither
 * needs a tag resolved, so neither pays for the read.
 */
export async function lanesForEventWall(
  db: AquillaDb,
  projectId: string,
  visible: VisibleLaneTags,
): Promise<LaneIdentity[]> {
  if (visible === null || visible.size === 0) return []
  return loadTargetLanes(db, projectId)
}

/**
 * The id of the lane an event addresses, or null when it addresses none.
 *
 * A string `laneId` is the answer. Lane writes only began to carry one in
 * October 2026 (AQU-1612 / AQU-1902); every older event names its lane by the
 * lane's frozen tag, `targetLang`, and a text or validation write with no tag
 * addressed the default lane, whose tag is `''`. `laneTagForArchiveCheck` is
 * that rule, and the tag resolves the way the projection resolves it
 * (`laneIdResolveSql` in lane-id-sql.ts): the one target lane whose
 * `legacy_tag` is exactly the tag. A project with no such lane, or a kind that
 * names no lane (shared audio, comments), resolves nothing.
 */
function eventLaneId(kind: string, payload: unknown, lanes: readonly LaneIdentity[]): string | null {
  const laneId = (payload as { laneId?: unknown } | null)?.laneId
  if (typeof laneId === "string") return laneId
  if (laneId != null) return null
  const tag = laneTagForArchiveCheck(kind, payload)
  if (tag === null) return null
  const matches = lanes.filter((lane) => lane.legacyTag === tag)
  return matches.length === 1 ? matches[0]!.id : null
}

/**
 * Event-log rows a caller may read. The log holds every lane's text, so any
 * route that returns raw events applies this one rule: source events are never
 * hidden, and any other event is kept only when the lane it addresses
 * ({@link eventLaneId}) is granted. An event that addresses no lane, or whose
 * payload is unparseable, fails closed. `visible === null` (wall off,
 * maintainer, platform) keeps every row.
 *
 * `lanes` is the project's target lanes ({@link lanesForEventWall}). Without
 * them an event from before lane ids cannot be placed and stays hidden, which
 * is how a member lost the whole edit history of text they are granted.
 */
export function eventRowsForVisibleLanes<T extends { kind: string; payload: string }>(
  rows: readonly T[],
  visible: VisibleLaneTags,
  lanes: readonly LaneIdentity[],
): T[] {
  if (visible === null) return [...rows]
  return rows.filter((row) => {
    if (row.kind.startsWith("source.")) return true
    try {
      const laneId = eventLaneId(row.kind, JSON.parse(row.payload), lanes)
      return laneId !== null && visible.has(laneId)
    } catch {
      return false
    }
  })
}
