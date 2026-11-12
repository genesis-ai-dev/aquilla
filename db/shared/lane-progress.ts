// Progress rows for a target language that has none yet.
//
// `file_section_progress` gets a row per lane when a FILE is recomputed
// (sync-worker/src/events/progress-projection.ts), and nothing recomputes the
// project's files when a language is added. So a language added to a project
// with files had no row for any file nobody had edited since, and every reader
// summing a language's rows read it short: on "LAN Party" (2026-10-27) French
// and Samoan showed 70,584 and 70,677 lines where each owes 73,715, and the
// Monday push counted those files once for the two of them.
//
// A recompute gives a lane with no target text and no recording in a file
// exactly the source lane's rows for that file: the source lane pairs with no
// target cells and no takes either, so its rows carry the lane-independent
// totals (lines, headings, the all-zero vote histogram, the newest source edit,
// the revision watermark) and no work. Copying those rows under the new lane's
// id is therefore the recompute's answer, without the per-file aggregate that
// makes a recompute expensive. A file where the lane already has text or
// audio is skipped — only a real recompute can count that — and so is any
// row the lane already has.
//
// What this does not reach (a file with no source-lane row yet, a lane added
// by an import or a migration) the nightly self-heal finds and recomputes
// (sync-worker/src/progress-selfheal-cron.ts, `missingLaneProgressFilesSql`).

import type { AquillaDb, AquillaStatement } from "../shim/postgres"

/** Every column of `file_section_progress` except `lane_id`, copied as is. */
const COPIED_COLUMNS = [
  "total_count",
  "filled_count",
  "validator_histogram",
  "audio_count",
  "audio_validated_count",
  "last_edit_at",
  "structural_count",
  "structural_filled_count",
  "structural_validator_histogram",
  "structural_audio_count",
  "structural_audio_validated_count",
  "audio_validator_histogram",
  "structural_audio_validator_histogram",
  "text_audio_validator_histogram",
  "structural_text_audio_validator_histogram",
  "revision",
  "updated_at",
] as const

/**
 * Give every target lane of the project the rows it is missing, for the files
 * where it has no work yet. Idempotent and cheap on a project whose lanes all
 * have their rows (each source row costs one primary-key probe per lane).
 *
 * A take with no lane, or on a lane that is gone, counts toward the `''` lane
 * (`audioLaneTagSql`), so for that lane any live take in the file holds the
 * copy back.
 */
export function seedLaneProgressStmt(db: AquillaDb, projectId: string): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO file_section_progress
         (project_id, file_id, scope, section_key, lane_id, ${COPIED_COLUMNS.join(", ")})
       SELECT p.project_id, p.file_id, p.scope, p.section_key, l.id,
              ${COPIED_COLUMNS.map((column) => `p.${column}`).join(", ")}
         FROM file_section_progress p
         JOIN lanes src
           ON src.project_id = p.project_id AND src.id = p.lane_id AND src.role = 'source'
         JOIN lanes l
           ON l.project_id = p.project_id AND l.role = 'target'
        WHERE p.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM file_section_progress q
             WHERE q.project_id = p.project_id AND q.file_id = p.file_id
               AND q.scope = p.scope AND q.section_key = p.section_key AND q.lane_id = l.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM cells t
             WHERE t.project_id = p.project_id AND t.file_id = p.file_id
               AND t.side = 'target' AND t.lane_id = l.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM cell_audio ca
             WHERE ca.project_id = p.project_id AND ca.file_id = p.file_id AND ca.deleted = 0
               AND (ca.lane_id = l.id OR COALESCE(l.legacy_tag, '') = '')
          )
       ON CONFLICT (project_id, file_id, scope, section_key, lane_id) DO NOTHING`,
    )
    .bind(projectId)
}
