/**
 * AQU-1240: SQL fragments that resolve or match a row's opaque `lanes.id`.
 *
 * Qualify `public.lanes` so these can be inlined into statements whose WITH
 * list already names a CTE `lanes` (progress-projection groups by tag under
 * that name). Row identity is `lane_id`. `target_lang` remains the legacy tag.
 */

import type { AquillaDb } from '../../../db/shim/postgres'

/**
 * Scalar subquery for a projected row's `lane_id` from (project, side, tag).
 *
 * Live projection and rebuild/replay resolve IDENTICALLY — both run this SQL
 * against the same `lanes` side table (not mutated by event replay). With no
 * matching lane the subquery is NULL (additive column, migration 0097).
 *
 *   - side='source' -> the project's single `role='source'` lane.
 *   - side='target' -> the `role='target'` lane whose `legacy_tag` matches.
 *
 * The caller MUST splice {@link laneIdResolveBinds} at the lane_id value's
 * bind position. ON CONFLICT callers COALESCE so a resolved id is never
 * regressed to NULL by a later lanes-less write.
 */
export function laneIdResolveSql(side: 'source' | 'target'): string {
  return side === 'source'
    ? `(SELECT id FROM public.lanes WHERE project_id = ? AND role = 'source')`
    : `(SELECT id FROM public.lanes WHERE project_id = ? AND role = 'target' AND legacy_tag = ?)`
}

/** Binds for {@link laneIdResolveSql}, in the order its `?` placeholders appear. */
export function laneIdResolveBinds(
  side: 'source' | 'target',
  projectId: string,
  laneTag: string,
): unknown[] {
  return side === 'source' ? [projectId] : [projectId, laneTag]
}

/**
 * Same resolution as {@link laneIdResolveSql}, but the project (and tag) come
 * from SQL expressions already in scope — no extra binds. Used by INSERT…
 * SELECT paths (import-reconcile, progress) where `project_id` is a column.
 */
export function laneIdResolveFromColSql(
  side: 'source' | 'target',
  projectCol: string,
  tagCol?: string,
): string {
  return side === 'source'
    ? `(SELECT id FROM public.lanes WHERE project_id = ${projectCol} AND role = 'source')`
    : `(SELECT id FROM public.lanes WHERE project_id = ${projectCol} AND role = 'target' AND legacy_tag = ${tagCol})`
}

/**
 * artifact_bindings resolution (slice 8): a 'source' binding_role -> the
 * project's single source lane; any other role -> the target lane whose
 * legacy_tag matches the inbound lane tag. Mirrors the backfill's
 * ARTIFACT_BINDINGS rule (scripts/neon-backfill-lanes.ts). AQU-1611's expand
 * step keeps `target_lang`; this resolver fills `lane_id` from the tag the
 * caller still sends. Returns NULL when the project's lanes do not exist,
 * which the NOT NULL column then rejects. The caller MUST splice
 * {@link laneIdResolveBindingBinds}.
 */
export function laneIdResolveBindingSql(): string {
  return `(SELECT id FROM public.lanes WHERE project_id = ?
    AND ( (? = 'source' AND role = 'source')
       OR (? <> 'source' AND role = 'target' AND legacy_tag = ?) )
    LIMIT 1)`
}

/**
 * The column an `artifact_bindings` upsert names in `ON CONFLICT`.
 *
 * Migration 0134 added `artifact_bindings_lane_member_key` on `lane_id`.
 * AQU-1611 (0155) dropped the tag-keyed UNIQUE with the `target_lang` column,
 * so the conflict target is `lane_id`.
 */
export async function artifactBindingConflictColumn(
  _db: AquillaDb,
): Promise<"lane_id"> {
  return "lane_id"
}

/** Binds for {@link laneIdResolveBindingSql}: projectId, role, role, targetLang. */
export function laneIdResolveBindingBinds(
  projectId: string,
  bindingRole: string,
  targetLang: string,
): unknown[] {
  return [projectId, bindingRole, bindingRole, targetLang]
}

/**
 * Match a target-lane tag to `lane_id`. `lane_id` is NOT NULL, so there is
 * no `target_lang` fallback. Binds: projectId, tag.
 */
export function targetLaneDualReadSql(alias = ''): string {
  const col = alias ? `${alias}.` : ''
  return `(${col}lane_id = (SELECT id FROM public.lanes WHERE project_id = ? AND role = 'target' AND legacy_tag = ?))`
}

/** Binds for {@link targetLaneDualReadSql}. */
export function targetLaneDualReadBinds(projectId: string, tag: string): unknown[] {
  return [projectId, tag]
}

/**
 * A back-translation row belongs to one target lane (AQU-1589).
 *
 * `lane_id` stays nullable until the AQU-1616 backfill. A NULL `lane_id` is
 * the lane whose `legacy_tag` is `''` — rows written before the column
 * existed. A named lane does not see them. The tag is matched to
 * `legacy_tag`, never to the lane's name.
 *
 * Binds: projectId, tag, tag ({@link backtranslationLaneMatchBinds}).
 */
export function backtranslationLaneMatchSql(alias = ''): string {
  const col = alias ? `${alias}.` : ''
  return `(${col}lane_id = ${laneIdResolveSql('target')} OR (${col}lane_id IS NULL AND ? = ''))`
}

/** Binds for {@link backtranslationLaneMatchSql}. */
export function backtranslationLaneMatchBinds(projectId: string, tag: string): unknown[] {
  return [...laneIdResolveBinds('target', projectId, tag), tag]
}

/**
 * Cells-read `?lane=` filter: source rows always included; target rows
 * dual-read by tag. Same binds as {@link targetLaneDualReadBinds}.
 */
export function sourceOrTargetLaneSql(): string {
  return `AND (side = 'source' OR ${targetLaneDualReadSql()})`
}

/**
 * AQU-1591: resolve an audio TAKE's `lane_id` from (project, take role, tag).
 *
 * Audio's lane rule is the artifact-binding rule with a different column name:
 * `role = 'source'` — the shared programme audio an import attached — belongs to
 * the project's single source lane, and every dub (a recording, a TTS take, a
 * clone) to the target lane whose `legacy_tag` is the event's `targetLang`.
 * Resolves to NULL until the project's lanes exist, so ON CONFLICT callers
 * COALESCE the way {@link laneIdResolveSql}'s do.
 *
 * The caller MUST splice {@link audioLaneResolveBinds} at the value's position.
 */
export function audioLaneResolveSql(): string {
  return `(SELECT id FROM public.lanes WHERE project_id = ?
    AND ( (? = 'source' AND role = 'source')
       OR (? <> 'source' AND role = 'target' AND legacy_tag = ?) )
    LIMIT 1)`
}

/** Binds for {@link audioLaneResolveSql}: projectId, role, role, targetLang. */
export function audioLaneResolveBinds(
  projectId: string,
  role: string,
  targetLang: string,
): unknown[] {
  return [projectId, role, role, targetLang]
}

/**
 * AQU-1591: "is this take visible in the lane the caller asked for?"
 *
 * Three clauses, and each one is a rule rather than a defensive OR:
 *
 *   - `role = 'source'` is SHARED. The programme audio is the source side of
 *     the line, so it shows in every lane, exactly as the source TEXT does.
 *   - a dub whose `lane_id` matches is that lane's own take.
 *   - a dub with NO lane yet belongs to the lane whose `legacy_tag` is `''` —
 *     which is the backfill's own rule for it (AQU-1616, "dub without an event
 *     targetLang -> the '' lane"). Applying it at read time is what makes the
 *     before- and after-backfill answers the same, instead of hiding every
 *     pre-1591 take until that PR ships.
 *
 * Binds: {@link audioLaneDualReadBinds} — projectId, tag, tag.
 */
export function audioLaneDualReadSql(alias = ''): string {
  const col = alias ? `${alias}.` : ''
  return `(${col}role = 'source'
    OR ${col}lane_id = (SELECT id FROM public.lanes WHERE project_id = ? AND role = 'target' AND legacy_tag = ?)
    OR (${col}lane_id IS NULL AND ? = ''))`
}

/** Binds for {@link audioLaneDualReadSql}: projectId, tag, tag. */
export function audioLaneDualReadBinds(projectId: string, tag: string): unknown[] {
  return [projectId, tag, tag]
}

/**
 * AQU-1978: whose selection a write that SELECTS `audioId` may clear — a
 * `cell.audio.attach` (as a dub) or a `cell.audio.select` naming a take.
 *
 * A take's lane is decided when it is born and `lane_id` is fill-only, so once
 * a dub is on file its own row says which lane it belongs to. Scoping its
 * siblings' deselect by the EVENT's tag instead trusted every later writer to
 * restate that lane, and the routine ones did not: the word-timings re-attach
 * named none, which reads as the `''` lane, and so saving a Spanish take's
 * timings deselected the `''` lane's chosen take on that line.
 *
 *   - `audioId` is a dub already on file → the slot's clips in THAT dub's lane
 *     (a `lane_id` NULL counting as the `''` lane, the read's own rule), plus
 *     the shared source clip, which a dub takes the slot over from exactly as
 *     before. The event's tag is not consulted, so a missing or stale one can
 *     never reach another language.
 *   - anything else — a brand-new take, or the shared source clip itself,
 *     whose selection IS a per-lane choice the event names → the event's tag,
 *     {@link audioLaneDualReadSql}, unchanged.
 *
 * Inlined into `UPDATE cell_audio … WHERE`, so `cell_audio` names the row being
 * deselected. Binds: {@link audioSelectScopeBinds}.
 */
export function audioSelectScopeSql(): string {
  const storedDub = `SELECT 1 FROM cell_audio t
     WHERE t.project_id = cell_audio.project_id AND t.file_id = cell_audio.file_id
       AND t.cell_id = cell_audio.cell_id AND t.audio_id = ? AND t.role <> 'source'`
  const formerDefaultLane = `(SELECT id FROM public.lanes
     WHERE project_id = cell_audio.project_id AND role = 'target' AND legacy_tag = '')`
  return `(
    EXISTS (${storedDub}
      AND (cell_audio.role = 'source'
        OR COALESCE(cell_audio.lane_id, ${formerDefaultLane})
           IS NOT DISTINCT FROM COALESCE(t.lane_id, ${formerDefaultLane})))
    OR (NOT EXISTS (${storedDub}) AND ${audioLaneDualReadSql()})
  )`
}

/** Binds for {@link audioSelectScopeSql}: audioId, audioId, then the tag's. */
export function audioSelectScopeBinds(projectId: string, audioId: string, tag: string): unknown[] {
  return [audioId, audioId, ...audioLaneDualReadBinds(projectId, tag)]
}
