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
 *   dub_votes — the MINIMUM validator count across those selected dub takes,
 *               or NULL when there are none. The minimum is what makes "every
 *               track is validated" a single comparison: min >= N exactly when
 *               all of them have reached N. NULL means NOT RECORDED, which is
 *               a different state from recorded-and-unvalidated and must not
 *               be bucketed as zero.
 *
 * A verdict is deliberately not returned. The required number of validators is
 * a project setting applied when somebody READS, so that changing it does not
 * require reprojecting anything — the same design text validation has used
 * since FRO-279, and the reason cell_audio.approved is no longer consulted.
 *
 * Reads through idx_cell_audio_file, the partial index on deleted = 0.
 */
export const AUDIO_CTE_SQL = `SELECT ca.cell_id,
            MAX(CASE WHEN ca.selected = 1 AND ca.role = 'dub' THEN 1 ELSE 0 END) AS has_dub,
            MIN(CASE WHEN ca.selected = 1 AND ca.role = 'dub' THEN ca.validator_count END) AS dub_votes
       FROM cell_audio ca
      WHERE ca.project_id = ? AND ca.file_id = ? AND ca.deleted = 0
      GROUP BY ca.cell_id`
