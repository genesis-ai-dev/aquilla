/**
 * AQU-1832 — live progress push.
 *
 * Every remote cell event used to make every connected client invalidate its
 * per-file progress resource, so N viewers fired N conditional GETs of
 * `/progress` back-to-back while one person typed — and each of those reads
 * does the same four queries this module does ONCE, on a request that has just
 * recomputed the very rows they are about to ask for.
 *
 * So the write path reads its own answer back and broadcasts it. The frame is
 * the GET's body, field for field (see `handleProgressReadRequest`): the
 * client merges it into the resource it would otherwise have refetched, and
 * the read disappears rather than moving.
 *
 * Two rules keep the push honest rather than merely fast:
 *
 *   - It is built from the SAME projection rows and the SAME `counts()`
 *     derivation the read route uses. A second way of computing a percentage
 *     is a second answer, and the one nobody looks at is the one that rots.
 *   - It is an accelerator, never the source of truth. A push the client
 *     cannot safely merge (no cached base, an unknown section key, a lane it
 *     is not showing) is DROPPED by the client, which falls back to the read
 *     exactly as before. Nothing here is allowed to be the only way a number
 *     arrives — the reconnect resync and the client's repair timer are what
 *     make that safe to promise.
 */

import type { AquillaDb } from '../../../db/shim/postgres'
import {
  compareSections,
  counts,
  readValidationCount,
  readValidationCountAudio,
} from './progress-read-route'
import type { ProgressCounts } from './progress-read-route'
import { readCountStructuralCells } from './structural-cells'

/**
 * Above this many rewritten projection rows the push is omitted and clients
 * refetch as they did before.
 *
 * A full-file recompute over a 150-chapter book with three target lanes
 * rewrites ~450 rows, and every one of them would ride to every connected
 * socket. That is the import/source-correction case, which already has its
 * own coarse `file.progress.updated` signal; the editing case this ticket is
 * about rewrites one file row and one section row per lane.
 */
export const PROGRESS_PUSH_MAX_ROWS = 160

/** One file+lane's post-commit progress, shaped exactly like the GET body. */
export interface FileProgressPushFrame {
  t: 'file.progress.pushed'
  project: string
  file: string
  /** Target lane tag ('' = the default lane), as the `?lane=` read spells it. */
  lane: string
  revision: number
  validationCount: number
  /**
   * True when the pass rewrote EVERY section row for this file+lane, so the
   * client replaces its section list wholesale. False means "upsert these":
   * the only way a section that no longer exists can disappear is a complete
   * frame, because a partial one cannot express a deletion.
   */
  complete: boolean
  /** The file-scope counts — `FileProgressResponse.file`. */
  counts: ProgressCounts
  sections: Array<{ key: string } & ProgressCounts>
}

interface PushRow {
  lane: string
  scope: 'file' | 'section'
  section_key: string
  total_count: number | string
  filled_count: number | string
  validator_histogram: Record<string, number> | string | null
  structural_count: number | string | null
  structural_filled_count: number | string | null
  structural_validator_histogram: Record<string, number> | string | null
  revision: number | string | bigint
  audio_count: number | string | null
  audio_validated_count: number | string | null
  structural_audio_count: number | string | null
  structural_audio_validated_count: number | string | null
  audio_validator_histogram: Record<string, number> | string | null
  structural_audio_validator_histogram: Record<string, number> | string | null
}

/** One file whose counters a just-committed request rewrote. */
export interface RecomputedFile {
  projectId: string
  fileId: string
  /** The pass ran `fullProgressRecomputeStmts` — every section row was rewritten. */
  fullSections: boolean
}

/**
 * Read back the rows the recompute pass at `recomputeTs` just wrote, and shape
 * them into one frame per target lane.
 *
 * `updated_at >= recomputeTs` is the selector because the upsert stamps every
 * row it rewrites with that exact timestamp — so it names the pass's own
 * output without a second bookkeeping channel to keep in step. A concurrent
 * request's later pass can stamp rows into this window too; those rows are
 * FRESHER, not wrong, and the client's revision guard orders them.
 *
 * Only `role = 'target'` lanes are returned: those are the rows the `?lane=`
 * read can address, and the source lane's row is not a thing any client asks
 * for. Scope `'book'` is dropped for the same reason — the GET body carries
 * the file row and the section rows, nothing else.
 */
export async function buildFileProgressPushFrames(
  db: AquillaDb,
  file: RecomputedFile,
  recomputeTs: number,
): Promise<FileProgressPushFrame[]> {
  const rowsResult = await db
    .prepare(
      `SELECT COALESCE(l.legacy_tag, '') AS lane,
              p.scope, p.section_key, p.total_count, p.filled_count, p.validator_histogram,
              p.structural_count, p.structural_filled_count, p.structural_validator_histogram,
              p.revision, p.audio_count, p.audio_validated_count,
              p.structural_audio_count, p.structural_audio_validated_count,
              p.audio_validator_histogram, p.structural_audio_validator_histogram
         FROM file_section_progress p
         JOIN public.lanes l ON l.id = p.lane_id AND l.role = 'target'
        WHERE p.project_id = ? AND p.file_id = ?
          AND p.scope IN ('file', 'section')
          AND p.updated_at >= ?
        LIMIT ?`,
    )
    .bind(file.projectId, file.fileId, recomputeTs, PROGRESS_PUSH_MAX_ROWS + 1)
    .all<PushRow>()

  const rows = rowsResult.results
  // Over the cap we say nothing rather than something partial: a truncated
  // row set read as a complete one would publish a file whose chapters had
  // silently stopped existing.
  if (rows.length === 0 || rows.length > PROGRESS_PUSH_MAX_ROWS) return []

  const [validationCount, validationCountAudio, countStructural] = await Promise.all([
    readValidationCount(db, file.projectId),
    readValidationCountAudio(db, file.projectId),
    readCountStructuralCells(db, file.projectId),
  ])

  const byLane = new Map<string, PushRow[]>()
  for (const row of rows) {
    const lane = row.lane ?? ''
    const list = byLane.get(lane)
    if (list) list.push(row)
    else byLane.set(lane, [row])
  }

  const frames: FileProgressPushFrame[] = []
  for (const [lane, laneRows] of byLane) {
    const fileRow = laneRows.find((row) => row.scope === 'file')
    // No file row means this lane only had sections rewritten — the client
    // cannot tell a stale denominator from a current one, so it refetches.
    if (!fileRow) continue
    const sections: Array<{ key: string } & ProgressCounts> = []
    for (const row of laneRows) {
      if (row.scope !== 'section') continue
      const sectionCounts = counts(row, validationCount, countStructural, validationCountAudio)
      // The read route drops a section the structural policy emptied, and the
      // merge must not resurrect one the reader is no longer being shown.
      if (sectionCounts.totalCount === 0 && Number(row.total_count) > 0) continue
      sections.push({ key: row.section_key, ...sectionCounts })
    }
    // Document order, by the read route's own comparator. A `complete` frame
    // REPLACES the client's section list, so an unsorted one would reorder
    // the chapter grid under the reader — and a second ordering rule would be
    // a second answer to "which chapter comes first".
    sections.sort((a, b) => compareSections(a.key, b.key))
    frames.push({
      t: 'file.progress.pushed',
      project: file.projectId,
      file: file.fileId,
      lane,
      revision: Math.max(0, ...laneRows.map((row) => Number(row.revision) || 0)),
      validationCount,
      complete: file.fullSections,
      counts: counts(fileRow, validationCount, countStructural, validationCountAudio),
      sections,
    })
  }
  return frames
}
