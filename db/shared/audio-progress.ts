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
 * Returns one row per cell that has ANY live take, carrying:
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
 * Reads through idx_cell_audio_file, the partial index on deleted = 0.
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

export const AUDIO_CTE_SQL = `SELECT ca.cell_id,
            MAX(CASE WHEN ca.selected = 1 AND ca.role = 'dub' THEN 1 ELSE 0 END) AS has_dub,
            MIN(CASE WHEN ca.selected = 1 AND ca.role = 'dub'
                          AND ${takeSoundsOnItsTrackSql('ca')}
                     THEN ca.validator_count END) AS dub_votes
       FROM cell_audio ca
      WHERE ca.project_id = ? AND ca.file_id = ? AND ca.deleted = 0
      GROUP BY ca.cell_id`
