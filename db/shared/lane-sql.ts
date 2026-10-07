// AQU-1599: where a reader finds the lane a progress row belongs to.
//
// `file_section_progress` has held one row per lane since AQU-538, and since
// AQU-1599 that includes the project's SOURCE lane — the row carrying the
// lane-independent numbers: the source-cell denominator, its structural share,
// the source side's newest edit, and (until the per-lane audio ticket lands)
// the file's shared audio rollup.
//
// Readers used to take those from the row the projection manufactured for
// `target_lang = ''`, which made them the former default TARGET lane's
// property. Archive that lane and the plan board, the files list and the org
// overview lost their totals with it — and now that the source lane's row
// carries '' in `target_lang` too (its `legacy_tag` is NULL), a `target_lang =
// ''` join matches two rows and double-counts instead.
//
// Both workers and db/shared reach this module, so the two spellings of "which
// lane" live here once rather than being written out at each reader.

/**
 * Scalar subquery for the project's source lane id. `projectCol` is a SQL
 * expression already in scope — a column, or a `?` the caller binds.
 *
 * `public.lanes` is qualified so this can be inlined into a statement whose
 * WITH list already names a CTE `lanes`; the progress projection's does.
 *
 * At most one row by construction: `uq_lanes_project_source` is unique on
 * (project_id) WHERE role = 'source'. NULL for a project with no lane rows at
 * all, which makes the join that uses it match nothing — the same miss a file
 * with no projection row produces, and handled by the same fallbacks.
 */
export function sourceLaneIdSql(projectCol: string): string {
  return `(SELECT id FROM public.lanes WHERE project_id = ${projectCol} AND role = 'source')`
}

/**
 * Scalar subquery for the target lane carrying `tagCol` — the lane's immutable
 * `legacy_tag`, which is '' for the former default lane. At most one row by
 * `uq_lanes_project_legacy_tag`.
 *
 * Why a tag still appears here: these callers are handed the lane the REQUEST
 * named, and the wire still names lanes by tag (AQU-1613 / AQU-1615 move that
 * to lane ids). Resolving it to an id is what keeps a lane of '' off the source
 * lane's row, which carries the same '' in `target_lang`.
 */
export function targetLaneIdSql(projectCol: string, tagCol = "?"): string {
  return `(SELECT id FROM public.lanes WHERE project_id = ${projectCol} AND role = 'target' AND legacy_tag = ${tagCol})`
}

/**
 * The legacy tag a row's lane still echoes on the wire as `targetLang`.
 *
 * Source lanes store NULL and read back as ''. This does not read the
 * projection `target_lang` column — that column stays until AQU-1611c, and a
 * reader that echoed it would keep answering "which lane?" with a tag that
 * can drift from the lane row. `alias` is the row's table or alias
 * (`cells`, `a`, `t`); both `project_id` and `lane_id` must be in scope on it.
 */
export function wireLegacyTagSql(alias: string): string {
  return `COALESCE((SELECT l.legacy_tag FROM public.lanes l WHERE l.project_id = ${alias}.project_id AND l.id = ${alias}.lane_id), '')`
}

/**
 * The progress row carrying a unit's LANE-INDEPENDENT numbers: the source-cell
 * denominator and its structural share, the file's shared audio rollup, and the
 * newest edit anywhere on it.
 *
 * Prefers the SOURCE lane's row — where AQU-1599 put those numbers — and falls
 * back to whichever other lane's row sorts first. The fallback is the
 * transition, and AQU-1419's delivery rule asks for it: a row projected before
 * AQU-1599 has no source-lane sibling until AQU-1616's batch recompute gives it
 * one, and every lane's row carried identical lane-independent columns back
 * then, so any of them answers correctly meanwhile. Once the recompute has run
 * the first ORDER BY key always wins and this is simply "the source lane's row".
 *
 * Deliberately NOT "the row whose `target_lang` is ''": that is the pin this
 * ticket removes. It picked the former default TARGET lane, so archiving that
 * lane took the board's totals with it — and now that the source lane's row
 * carries '' in `target_lang` too, it matches two rows and sums them.
 *
 * Returns a lateral body — `LEFT JOIN LATERAL (…) pd ON TRUE`. `d` and `dl` are
 * its own aliases; the caller's expressions must not use them. No binds.
 */
export function laneIndependentProgressSql(opts: {
  /** SQL for the project id, e.g. `u.project_id`. */
  projectCol: string
  /** SQL for the file id. A NULL here yields no row, as a missing join did. */
  fileCol: string
  /** SQL for the scope ('file' / 'book' / an expression choosing between them). */
  scopeSql: string
  /** SQL for the section key. */
  sectionKeySql: string
}): string {
  return `SELECT d.*
           FROM file_section_progress d
           JOIN public.lanes dl ON dl.project_id = d.project_id AND dl.id = d.lane_id
          WHERE d.project_id = ${opts.projectCol} AND d.file_id = ${opts.fileCol}
            AND d.scope = ${opts.scopeSql} AND d.section_key = ${opts.sectionKeySql}
          ORDER BY (dl.role = 'source') DESC, dl.position, d.lane_id
          LIMIT 1`
}
