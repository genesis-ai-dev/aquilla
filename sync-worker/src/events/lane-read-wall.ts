/**
 * AQU-730: SQL for the read wall. See src/lib/lanes/read-wall.ts.
 *
 * A restricted caller sees a target row when its target_lang is a granted
 * tag, or its lane's legacy_tag / name is. The default lane (legacy_tag '')
 * stays visible to someone granted that lane's name ("Spanish"), which is
 * how the lane is labeled. Source rows are always kept.
 */

import type { SyncTokenClaims } from "../auth"
import {
  laneReadWallEnabled,
  laneTagAllowed,
  visibleLaneTags,
  type VisibleLaneTags,
} from "../../../src/lib/lanes/read-wall"

export { laneReadWallEnabled, laneTagAllowed, visibilityCacheToken } from "../../../src/lib/lanes/read-wall"
export type { VisibleLaneTags } from "../../../src/lib/lanes/read-wall"

/**
 * Progress and first-open ask for one lane tag. `''` is the default lane; a
 * grant of that lane's name (the string `targetLanguage` was copied into)
 * counts, because the tag on the row is empty and the name is the language.
 */
export async function canReadRequestedLane(
  db: AquillaDb,
  projectId: string,
  visible: VisibleLaneTags,
  lane: string,
): Promise<boolean> {
  if (visible === null) return true
  if (laneTagAllowed(visible, lane)) return true
  if (lane !== "" || visible.size === 0) return false
  const lowered = [...visible].map((tag) => tag.toLowerCase())
  const placeholders = lowered.map(() => "?").join(", ")
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM lanes
        WHERE project_id = ? AND role = 'target' AND legacy_tag = ''
          AND lower(name) IN (${placeholders})
        LIMIT 1`,
    )
    .bind(projectId, ...lowered)
    .first<{ ok: number }>()
  return row != null
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
 * `sideExpr` omitted means every row is a target row (progress, validators).
 */
export function targetVisibilityClause(args: {
  visible: VisibleLaneTags
  projectId: string
  sideExpr?: string
  targetLangExpr: string
  laneIdExpr: string
}): { sql: string; binds: unknown[] } | null {
  if (args.visible === null) return null
  const tags = [...args.visible]
  if (tags.length === 0) {
    return args.sideExpr
      ? { sql: `AND ${args.sideExpr} = 'source'`, binds: [] }
      : { sql: "AND FALSE", binds: [] }
  }
  const ph = tags.map(() => "?").join(", ")
  const lowered = tags.map((tag) => tag.toLowerCase())
  const match = `(
    ${args.targetLangExpr} IN (${ph})
    OR ${args.laneIdExpr} IN (
      SELECT id FROM public.lanes
      WHERE project_id = ? AND role = 'target'
        AND (lower(COALESCE(legacy_tag, '')) IN (${ph}) OR lower(name) IN (${ph}))
    )
    OR (
      ${args.targetLangExpr} = ''
      AND EXISTS (
        SELECT 1 FROM public.lanes
        WHERE project_id = ? AND role = 'target' AND legacy_tag = ''
          AND lower(name) IN (${ph})
      )
    )
  )`
  const binds: unknown[] = [
    ...tags,
    args.projectId,
    ...lowered,
    ...lowered,
    args.projectId,
    ...lowered,
  ]
  if (!args.sideExpr) return { sql: `AND ${match}`, binds }
  return { sql: `AND (${args.sideExpr} = 'source' OR ${match})`, binds }
}
