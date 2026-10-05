/**
 * AQU-1240: SQL fragments that resolve or match a row's opaque `lanes.id`.
 *
 * Qualify `public.lanes` so these can be inlined into statements whose WITH
 * list already names a CTE `lanes` (progress-projection groups by tag under
 * that name). Row identity is `lane_id`. `target_lang` remains the legacy tag.
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
