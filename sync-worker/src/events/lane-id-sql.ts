/**
 * AQU-1240: SQL fragments that resolve or match a row's opaque `lanes.id`.
 *
 * Qualify `public.lanes` so these can be inlined into statements whose WITH
 * list already names a CTE `lanes` (progress-projection groups by tag under
 * that name). PK lookups stay on `target_lang` until slice 8.
 */

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
 * legacy_tag matches target_lang. Mirrors the backfill's ARTIFACT_BINDINGS
 * rule (scripts/neon-backfill-lanes.ts). Returns NULL until the project's
 * lanes exist. The caller MUST splice {@link laneIdResolveBindingBinds}.
 */
export function laneIdResolveBindingSql(): string {
  return `(SELECT id FROM public.lanes WHERE project_id = ?
    AND ( (? = 'source' AND role = 'source')
       OR (? <> 'source' AND role = 'target' AND legacy_tag = ?) )
    LIMIT 1)`
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
 * Dual-read match for a target-lane tag: prefer opaque `lane_id` once
 * backfill has populated it; fall back to `target_lang` while `lane_id` is
 * still NULL.
 *
 * Binds, in order: projectId, tag, tag. See {@link targetLaneDualReadBinds}.
 */
export function targetLaneDualReadSql(alias = ''): string {
  const col = alias ? `${alias}.` : ''
  return `(${col}lane_id = (SELECT id FROM public.lanes WHERE project_id = ? AND role = 'target' AND legacy_tag = ?)
    OR (${col}lane_id IS NULL AND ${col}target_lang = ?))`
}

/** Binds for {@link targetLaneDualReadSql}. */
export function targetLaneDualReadBinds(projectId: string, tag: string): unknown[] {
  return [projectId, tag, tag]
}

/**
 * Cells-read `?lane=` filter: source rows always included; target rows
 * dual-read by tag. Same binds as {@link targetLaneDualReadBinds}.
 */
export function sourceOrTargetLaneSql(): string {
  return `AND (side = 'source' OR ${targetLaneDualReadSql()})`
}
