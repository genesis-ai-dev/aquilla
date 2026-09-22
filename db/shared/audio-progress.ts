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
export const AUDIO_CTE_SQL = `SELECT ca.cell_id,
            MAX(CASE WHEN ca.qualifies = 1 THEN 1 ELSE 0 END) AS has_dub,
            MIN(CASE WHEN ca.qualifies = 1 AND ca.track_rank = 1 THEN ca.validator_count END) AS dub_votes
       FROM (SELECT cell_id,
                    validator_count,
                    CASE WHEN selected = 1 AND role = 'dub' THEN 1 ELSE 0 END AS qualifies,
                    ROW_NUMBER() OVER (
                      PARTITION BY cell_id,
                                   CASE WHEN slot IN ('recording', 'generatedVoice')
                                        THEN 'target-audio' ELSE slot END
                      ORDER BY CASE WHEN selected = 1 AND role = 'dub' THEN 0 ELSE 1 END,
                               CASE WHEN slot = 'generatedVoice' THEN 1 ELSE 0 END,
                               audio_id
                    ) AS track_rank
               FROM cell_audio
              WHERE project_id = ? AND file_id = ? AND deleted = 0) ca
      GROUP BY ca.cell_id`
