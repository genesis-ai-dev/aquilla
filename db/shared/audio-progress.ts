/**
 * The one definition of "this cell has audio, and this is how validated it is".
 *
 * It used to live in sync-worker's progress-projection.ts and be hand-copied
 * into auth-worker's per-assignment panel and (in a third spelling) into the
 * org portfolio. Its own docstring promised that a per-book row, a person's
 * assignment bar and the project tile could never disagree — a promise resting
 * on three separate copies staying in step by hand. AQU-490 changed both
 * halves of the definition at once, which is exactly when that promise would
 * have broken, so it moved here instead, the way plan-keys.ts did.
 *
 * Both workers reach db/shared, so there is one copy for the two of them.
 */

/**
 * Per-cell audio rollup for one file. Binds, in order: project id, file id.
 *
 * AQU-1591: one row per (cell, LANE) — see audioLaneTagSql below. Every caller
 * joins the lane as well as the cell, or it counts another language's takes.
 *
 * Returns one row per cell-and-lane that has ANY live take, carrying:
 *
 *   has_dub   — 1 when a SELECTED take with role 'dub' exists. This is what
 *               "recorded" means. Not "any live take": on an imported media
 *               file the shared programme audio is attached and selected on
 *               every cell, which used to make a whole file read as fully
 *               recorded before anyone had dubbed a line of it.
 *
 *   dub_votes — the MINIMUM validator count across those takes, ONE PER
 *               TRACK, or NULL when there are none. The minimum is what makes
 *               "every track is validated" a single comparison: min >= N
 *               exactly when all of them have reached N. NULL means NOT
 *               RECORDED, which is a different state from
 *               recorded-and-unvalidated and must not be bucketed as zero.
 *
 * ONE PER TRACK IS NOT ONE PER SLOT, and the difference is the default track:
 * it alone owns two slots, `recording` and `generatedVoice`, of which only one
 * ever sounds (the client's resolveTargetAudio prefers the recording slot and
 * falls through to the voice). A line carrying a real take and a leftover
 * generated voice was therefore asked to validate the same track twice, and
 * the silent one — which nobody can hear to judge — held the whole line down.
 * Every added track owns exactly one slot, so it needs no such rule.
 * `selectedDubTakes` in cell-audio-read-types.ts is this same resolution in
 * TypeScript; the two must move together or the gutter and the board disagree
 * about one line.
 *
 * A verdict is deliberately not returned. The required number of validators is
 * a project setting applied when somebody READS, so that changing it does not
 * require reprojecting anything — the same design text validation has used
 * since FRO-279, and the reason cell_audio.approved is no longer consulted.
 *
 * Reads through idx_cell_audio_lane (AQU-1591), the partial index on
 * deleted = 0 that carries the lane beside the file.
 */
/**
 * Does this take SOUND on its track? Written once, used by every reader of
 * "how validated is this cell's audio", because there turned out to be three
 * of them and only one had the rule.
 *
 * Only the default track can hold two takes at once — it owns both the
 * `recording` and `generatedVoice` slots — and `resolveTargetAudio` plays the
 * recording when there is one. So a generated voice is silenced exactly when
 * a recorded dub sits beside it, and that is the whole rule; every added
 * track owns one slot and the projection already keeps one selected take per
 * (cell, slot).
 *
 * This replaced a ROW_NUMBER partitioned on a `'target-audio'` sentinel. The
 * sentinel was not safe: `cell_audio.slot` is unconstrained TEXT and 9,568
 * rows on this machine's dev database literally hold `slot = 'target-audio'`,
 * so a cell carrying one of those beside a `recording` take would have put
 * two real tracks in one partition and dropped a whole track's votes out of
 * the minimum. Not reachable through the shipping client, which quarantines
 * a track id spelling a legacy slot name — but "cannot happen" reasoning
 * about slot names has already been wrong here once, and this form needs no
 * sentinel at all.
 */
export function takeSoundsOnItsTrackSql(alias: string): string {
  return `NOT (${alias}.slot = 'generatedVoice' AND EXISTS (
              SELECT 1 FROM cell_audio sib
               WHERE sib.project_id = ${alias}.project_id
                 AND sib.file_id = ${alias}.file_id
                 AND sib.cell_id = ${alias}.cell_id
                 AND sib.deleted = 0 AND sib.selected = 1
                 AND sib.role = 'dub' AND sib.slot = 'recording'))`
}

/**
 * AQU-1591: a take's lane, as the legacy TAG the readers below group by.
 *
 * Both of them already have a lane in hand as a tag — the progress projection's
 * `lanes` CTE is `DISTINCT COALESCE(target_lang, '')` over the file's cells, and
 * the assignment panel binds `assignments.target_lang` — so the join is made in
 * that currency rather than resolving every lane to an id first.
 *
 * `NULL` reads as the `''` lane, which is the rule the batch backfill (AQU-1616)
 * applies to a lane-less dub. Readers and backfill therefore agree on a take's
 * lane before that PR lands as well as after it; this is the whole reason
 * `cell_audio.lane_id` could ship nullable.
 *
 * A `role = 'source'` take also lands in the `''` group (the source lane's
 * `legacy_tag` is NULL by definition). Inert, not a claim: every aggregate below
 * counts `role = 'dub'`, so the shared programme audio contributes the same zero
 * it would contribute to any group. "Shared across every lane" is stated where
 * it is actually read — `audioLaneDualReadSql` in sync-worker's lane-id-sql.ts.
 */
export function audioLaneTagSql(alias: string): string {
  // `public.lanes`, never a bare `lanes`: the progress projection's WITH list
  // already binds that name to its own tag CTE, so an unqualified reference
  // here would silently resolve to it. Same discipline as lane-id-sql.ts.
  return `COALESCE((SELECT l.legacy_tag FROM public.lanes l
                     WHERE l.project_id = ${alias}.project_id AND l.id = ${alias}.lane_id), '')`
}

/**
 * AQU-1591 added the `lane` column. Audio used to be lane-INDEPENDENT by
 * construction — `cell_audio` had no lane at all — so one recording counted as
 * the recording in every lane, and a file translated into three languages
 * reported the same audio progress for all three no matter who had voiced what.
 * AQU-1200 decided audio is per lane; every consumer of this CTE must now join
 * `lane` as well as `cell_id` or it is back to counting another language's
 * takes as its own.
 */
export const AUDIO_CTE_SQL = `SELECT ca.cell_id,
            ${audioLaneTagSql('ca')} AS lane,
            MAX(CASE WHEN ca.selected = 1 AND ca.role = 'dub' THEN 1 ELSE 0 END) AS has_dub,
            MIN(CASE WHEN ca.selected = 1 AND ca.role = 'dub'
                          AND ${takeSoundsOnItsTrackSql('ca')}
                     THEN ca.validator_count END) AS dub_votes
       FROM cell_audio ca
      WHERE ca.project_id = ? AND ca.file_id = ? AND ca.deleted = 0
      GROUP BY ca.cell_id, ${audioLaneTagSql('ca')}`
