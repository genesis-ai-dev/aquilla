import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import { structuralPredicateSql } from './structural-cells'

export const MAX_VALIDATOR_HISTOGRAM_BUCKET = 15

/**
 * AQU-805: bucket size for time-based (media/timeline) sections — 5 minutes,
 * mirroring the in-app jump navigation's TIMELINE_MILESTONE_MS so the
 * project-overview file breakdown groups media progress the same way.
 */
export const TIMELINE_SECTION_MS = 5 * 60 * 1000

/**
 * AQU-805: the section grouping key for a source cell, as a SQL expression.
 *
 * Canonical (Scripture) files key by "<BOOK> <CHAPTER>" — the canonical_ref
 * before the verse colon — exactly as before. Media / timeline files carry no
 * canonical_ref but do carry start_ms; they key into ~5-minute time buckets
 * ("t:<zero-padded bucket-start ms>") so a single-episode media file shows a
 * per-section breakdown instead of only a flat cell count. The bucket-start ms
 * is zero-padded to a fixed width so the key sorts lexically in time order and
 * the read route's string sort needs no time-awareness. Cells with neither a
 * canonical ref nor a start_ms produce '' and are filtered out (untimed).
 */
export function sectionKeyExpr(alias: string): string {
  const canonical = `TRIM(SPLIT_PART(COALESCE(${alias}.canonical_ref, ''), ':', 1))`
  return `CASE
    WHEN ${canonical} <> '' THEN ${canonical}
    WHEN ${alias}.start_ms IS NOT NULL
      THEN 't:' || LPAD(((${alias}.start_ms / ${TIMELINE_SECTION_MS}) * ${TIMELINE_SECTION_MS})::text, 12, '0')
    ELSE ''
  END`
}

/**
 * AQU-1093: the BOOK grouping key for a source cell, as a SQL expression.
 *
 * A section key is "<BOOK> <CHAPTER>"; the book is its first token. Media
 * files key by time bucket ("t:<ms>") and have no book, and a cell with
 * neither yields '' — both are excluded from book rows.
 *
 * A book-only canonical_ref (a one-chapter book referenced as "TIT") produces
 * section_key 'TIT' AND book_key 'TIT'. Those are different rows with the same
 * key, which is why every grouping below carries `scope` alongside the key.
 */
export function bookKeyExpr(alias: string): string {
  const section = sectionKeyExpr(alias)
  return `CASE
    WHEN ${section} <> '' AND ${section} NOT LIKE 't:%'
      THEN SPLIT_PART(${section}, ' ', 1)
    ELSE ''
  END`
}

/**
 * Whether the file is Scripture at all: does any source cell carry a
 * VERSE-shaped canonical_ref ("GEN 1:1")? Chapter- and heading-shaped refs
 * ("GEN 1", "GEN 1:s1:1") are not enough on their own — a non-Scripture file
 * that happens to use a two-token label should not sprout book rows.
 *
 * This is the file-level gate for book rows: every Scripture file plans at
 * book grain, including a one-book file, so the unit's identity is the stable
 * book code rather than a file id that a re-import can replace.
 */
export const HAS_BOOKS_CTE_SQL = `SELECT EXISTS (
       SELECT 1 FROM cells b
        WHERE b.project_id = ? AND b.file_id = ? AND b.side = 'source'
          AND COALESCE(b.canonical_ref, '') ~ '^\\S+ \\d+:\\d+'
     ) AS v`

/**
 * Per-cell audio rollup for one file.
 *
 * Definitions are lifted verbatim from the org portfolio's audio aggregate so
 * a per-book row and the project-wide tile can never disagree: a cell HAS
 * audio when any take is live (deleted = 0) — recording it is what counts,
 * not selecting it — and is VALIDATED when its selected take is approved. A
 * re-record therefore drops validation, which is the intended behaviour.
 *
 * Reads through idx_cell_audio_file, the partial index on deleted = 0.
 */
export const AUDIO_CTE_SQL = `SELECT ca.cell_id,
            MAX(CASE WHEN ca.selected = 1 AND ca.approved = 1 THEN 1 ELSE 0 END) AS validated
       FROM cell_audio ca
      WHERE ca.project_id = ? AND ca.file_id = ? AND ca.deleted = 0
      GROUP BY ca.cell_id`

// AQU-1083: the structural subset of every aggregate below, recorded whatever
// the policy says. The three SQL fragments are shared by all three statements
// so file, section and book rows can never disagree about what "structural"
// means — a reader that excludes headings subtracts these from the totals
// beside them, bucket-wise for the histogram.

/** The per-lane, per-key structural totals that ride beside total/filled. */
const STRUCTURAL_SUMMARY_SQL = `COALESCE(SUM(structural), 0)::integer AS structural_count,
              COALESCE(SUM(filled) FILTER (WHERE structural = 1), 0)::integer AS structural_filled_count`

/** The structural share of one validator bucket. */
const STRUCTURAL_BUCKET_SQL = `COUNT(*) FILTER (WHERE structural = 1)::integer AS structural_bucket_count`

/**
 * The structural histogram, built beside validator_histogram from the same
 * bucket rows. Buckets with no structural cells are left out (FILTER), so an
 * ordinary file's histogram stays '{}' rather than a map of zeros.
 */
const STRUCTURAL_HISTOGRAM_SQL = `jsonb_object_agg(validator_bucket::text, structural_bucket_count)
                FILTER (WHERE structural_bucket_count > 0) AS structural_validator_histogram`

/** The shared tail of every upsert: which columns a recompute overwrites. */
const PROGRESS_UPSERT_SET_SQL = `total_count = excluded.total_count,
       filled_count = excluded.filled_count,
       validator_histogram = excluded.validator_histogram,
       structural_count = excluded.structural_count,
       structural_filled_count = excluded.structural_filled_count,
       structural_validator_histogram = excluded.structural_validator_histogram,
       revision = excluded.revision,
       updated_at = excluded.updated_at,
       audio_count = excluded.audio_count,
       audio_validated_count = excluded.audio_validated_count,
       last_edit_at = excluded.last_edit_at`

const PROGRESS_INSERT_COLUMNS_SQL = `project_id, file_id, scope, section_key, target_lang, total_count, filled_count,
       validator_histogram, structural_count, structural_filled_count,
       structural_validator_histogram, revision, updated_at,
       audio_count, audio_validated_count, last_edit_at`

/**
 * Recompute the file-level progress row from authoritative source/target
 * projection rows. Source rows define the denominator; target-only rows are
 * intentionally ignored to preserve the existing sidebar semantics.
 *
 * AQU-538: one row per target-language lane. The denominator (source rows) is
 * lane-independent, so every lane shares the same total_count; each lane's
 * filled_count / validator histogram derives from that lane's target rows. The
 * default lane ('') is ALWAYS produced (via the UNION) so N=1 projects keep a
 * byte-identical '' row even before any lane exists.
 */
export function fileProgressRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  updatedAt: number,
): AquillaStatement {
  return db.prepare(
    `WITH lanes AS (
       SELECT DISTINCT COALESCE(target_lang, '') AS lane
         FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'target'
       UNION SELECT ''
     ), audio AS (
       ${AUDIO_CTE_SQL}
     ), paired AS (
       SELECT lanes.lane AS lane,
              s.cell_id,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              CASE WHEN ${structuralPredicateSql('s')} THEN 1 ELSE 0 END AS structural,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket,
              CASE WHEN a.cell_id IS NULL THEN 0 ELSE 1 END AS audio,
              COALESCE(a.validated, 0) AS audio_validated,
              GREATEST(COALESCE(s.last_edit_at, 0), COALESCE(t.last_edit_at, 0)) AS last_edit_at
         FROM cells s
         CROSS JOIN lanes
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
          AND t.target_lang = lanes.lane
         LEFT JOIN audio a ON a.cell_id = s.cell_id
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
     ), buckets AS (
       SELECT lane, validator_bucket, COUNT(*)::integer AS bucket_count,
              ${STRUCTURAL_BUCKET_SQL}
         FROM paired
        GROUP BY lane, validator_bucket
     ), summary AS (
       SELECT lane,
              COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count,
              ${STRUCTURAL_SUMMARY_SQL},
              COALESCE(SUM(audio), 0)::integer AS audio_count,
              COALESCE(SUM(audio_validated), 0)::integer AS audio_validated_count,
              NULLIF(MAX(last_edit_at), 0) AS last_edit_at
         FROM paired
        GROUP BY lane
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       ${PROGRESS_INSERT_COLUMNS_SQL}
     )
     SELECT ?, ?, 'file', '', summary.lane, summary.total_count, summary.filled_count,
            COALESCE(
              (SELECT jsonb_object_agg(validator_bucket::text, bucket_count)
                 FROM buckets WHERE buckets.lane = summary.lane),
              '{}'::jsonb
            ),
            summary.structural_count, summary.structural_filled_count,
            COALESCE(
              (SELECT jsonb_object_agg(validator_bucket::text, structural_bucket_count)
                 FROM buckets
                WHERE buckets.lane = summary.lane AND structural_bucket_count > 0),
              '{}'::jsonb
            ),
            watermark.revision, ?,
            summary.audio_count, summary.audio_validated_count, summary.last_edit_at
       FROM summary CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key, target_lang) DO UPDATE SET
       ${PROGRESS_UPSERT_SET_SQL}`,
  ).bind(
    projectId, fileId,
    projectId, fileId,
    projectId, fileId,
    projectId, fileId, projectId,
    projectId, fileId, updatedAt,
  )
}

/** Delete all section rows before a full rebuild in the same transaction. */
export function clearSectionProgressStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): AquillaStatement {
  return db
    .prepare(`DELETE FROM file_section_progress WHERE project_id = ? AND file_id = ? AND scope IN ('section', 'book')`)
    .bind(projectId, fileId)
}

/** Rebuild every meaningful canonical section for a file. */
export function allSectionsProgressRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  updatedAt: number,
): AquillaStatement {
  return sectionsProgressRecomputeStmt(db, projectId, fileId, updatedAt)
}

/**
 * Recompute only the sections containing the supplied cells. Passing no ids
 * rebuilds every section. The source row owns canonical_ref, matching the
 * current importer and sidebar section derivation.
 */
export function sectionsProgressRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  updatedAt: number,
  cellIds?: readonly string[],
): AquillaStatement {
  const uniqueCellIds = cellIds ? [...new Set(cellIds.filter(Boolean))] : []
  // AQU-1093: a touched cell dirties BOTH its chapter section and its book, so
  // the affected set carries each key and the two branches filter on their own.
  const affected = uniqueCellIds.length > 0
    ? `SELECT DISTINCT ${sectionKeyExpr('src')} AS section_key, ${bookKeyExpr('src')} AS book_key
           FROM cells src
          WHERE src.project_id = ? AND src.file_id = ? AND src.side = 'source'
            AND src.cell_id IN (${uniqueCellIds.map(() => '?').join(', ')})`
    : ''
  const sectionFilter = affected ? `AND section_key IN (SELECT section_key FROM affected)` : ''
  const bookFilter = affected ? `AND book_key IN (SELECT book_key FROM affected)` : ''
  const affectedCte = affected ? `, affected AS (${affected})` : ''

  const binds: unknown[] = [
    projectId, fileId,           // lanes
    projectId, fileId,           // audio
    projectId, fileId,           // has_books
    projectId, fileId,           // paired
  ]
  if (uniqueCellIds.length > 0) binds.push(projectId, fileId, ...uniqueCellIds)
  binds.push(projectId, fileId, projectId, projectId, fileId, updatedAt)

  return db.prepare(
    `WITH lanes AS (
       SELECT DISTINCT COALESCE(target_lang, '') AS lane
         FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'target'
       UNION SELECT ''
     ), audio AS (
       ${AUDIO_CTE_SQL}
     ), has_books AS (
       ${HAS_BOOKS_CTE_SQL}
     ), paired AS MATERIALIZED (
       SELECT lanes.lane AS lane,
              ${sectionKeyExpr('s')} AS section_key,
              ${bookKeyExpr('s')} AS book_key,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              CASE WHEN ${structuralPredicateSql('s')} THEN 1 ELSE 0 END AS structural,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket,
              CASE WHEN a.cell_id IS NULL THEN 0 ELSE 1 END AS audio,
              COALESCE(a.validated, 0) AS audio_validated,
              GREATEST(COALESCE(s.last_edit_at, 0), COALESCE(t.last_edit_at, 0)) AS last_edit_at
         FROM cells s
         CROSS JOIN lanes
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
          AND COALESCE(t.target_lang, '') = lanes.lane
         LEFT JOIN audio a ON a.cell_id = s.cell_id
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
     )${affectedCte}, summaries AS (
       SELECT lane, 'section'::text AS scope, section_key,
              COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count,
              ${STRUCTURAL_SUMMARY_SQL},
              COALESCE(SUM(audio), 0)::integer AS audio_count,
              COALESCE(SUM(audio_validated), 0)::integer AS audio_validated_count,
              NULLIF(MAX(last_edit_at), 0) AS last_edit_at
         FROM paired
        WHERE section_key <> '' ${sectionFilter}
        GROUP BY lane, section_key
       UNION ALL
       SELECT lane, 'book'::text, book_key,
              COUNT(*)::integer,
              COALESCE(SUM(filled), 0)::integer,
              ${STRUCTURAL_SUMMARY_SQL},
              COALESCE(SUM(audio), 0)::integer,
              COALESCE(SUM(audio_validated), 0)::integer,
              NULLIF(MAX(last_edit_at), 0)
         FROM paired
        WHERE book_key <> '' AND (SELECT v FROM has_books) ${bookFilter}
        GROUP BY lane, book_key
     ), bucket_counts AS (
       SELECT lane, 'section'::text AS scope, section_key, validator_bucket,
              COUNT(*)::integer AS bucket_count,
              ${STRUCTURAL_BUCKET_SQL}
         FROM paired
        WHERE section_key <> '' ${sectionFilter}
        GROUP BY lane, section_key, validator_bucket
       UNION ALL
       SELECT lane, 'book'::text, book_key, validator_bucket, COUNT(*)::integer,
              ${STRUCTURAL_BUCKET_SQL}
         FROM paired
        WHERE book_key <> '' AND (SELECT v FROM has_books) ${bookFilter}
        GROUP BY lane, book_key, validator_bucket
     ), histograms AS (
       SELECT lane, scope, section_key,
              jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram,
              ${STRUCTURAL_HISTOGRAM_SQL}
         FROM bucket_counts
        GROUP BY lane, scope, section_key
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       ${PROGRESS_INSERT_COLUMNS_SQL}
     )
     SELECT ?, ?, summaries.scope, summaries.section_key, summaries.lane,
            summaries.total_count, summaries.filled_count,
            COALESCE(histograms.validator_histogram, '{}'::jsonb),
            summaries.structural_count, summaries.structural_filled_count,
            COALESCE(histograms.structural_validator_histogram, '{}'::jsonb),
            watermark.revision, ?,
            summaries.audio_count, summaries.audio_validated_count, summaries.last_edit_at
       FROM summaries
       LEFT JOIN histograms
         ON histograms.lane = summaries.lane
        AND histograms.scope = summaries.scope
        AND histograms.section_key = summaries.section_key
       CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key, target_lang) DO UPDATE SET
       ${PROGRESS_UPSERT_SET_SQL}`,
  ).bind(...binds)
}

export function fullProgressRecomputeStmts(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  updatedAt: number,
): AquillaStatement[] {
  return [
    db.prepare(
      // AQU-538: per-lane. `lanes` enumerates every target lane present (always
      // incl. '') so each source cell is paired against that lane's target row;
      // summaries/histograms group by lane and the upsert keys the 5-col PK.
      //
      // AQU-1093/1096: `paired` additionally carries the cell's BOOK key, its
      // audio state, and its newest edit, so one pass over the file produces
      // file, section AND book rows. Grouping keys carry `scope` because a
      // book-only ref ("TIT") collides with its own section key.
      `WITH lanes AS (
         SELECT DISTINCT COALESCE(target_lang, '') AS lane
           FROM cells WHERE project_id = ? AND file_id = ? AND side = 'target'
         UNION SELECT ''
       ), audio AS (
         ${AUDIO_CTE_SQL}
       ), has_books AS (
         ${HAS_BOOKS_CTE_SQL}
       ), paired AS MATERIALIZED (
         SELECT lanes.lane AS lane,
                ${sectionKeyExpr('s')} AS section_key,
                ${bookKeyExpr('s')} AS book_key,
                CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
                CASE WHEN ${structuralPredicateSql('s')} THEN 1 ELSE 0 END AS structural,
                LEAST(
                  COALESCE(t.endorsement_count, 0),
                  ${MAX_VALIDATOR_HISTOGRAM_BUCKET}
                ) AS validator_bucket,
                CASE WHEN a.cell_id IS NULL THEN 0 ELSE 1 END AS audio,
                COALESCE(a.validated, 0) AS audio_validated,
                GREATEST(COALESCE(s.last_edit_at, 0), COALESCE(t.last_edit_at, 0)) AS last_edit_at
           FROM cells s
           CROSS JOIN lanes
           LEFT JOIN cells t
             ON t.project_id = s.project_id
            AND t.file_id = s.file_id
            AND t.cell_id = s.cell_id
            AND t.side = 'target'
            AND COALESCE(t.target_lang, '') = lanes.lane
           LEFT JOIN audio a ON a.cell_id = s.cell_id
          WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
       ), summaries AS (
         SELECT lane,
                'file'::text AS scope,
                ''::text AS section_key,
                COUNT(*)::integer AS total_count,
                COALESCE(SUM(filled), 0)::integer AS filled_count,
                ${STRUCTURAL_SUMMARY_SQL},
                COALESCE(SUM(audio), 0)::integer AS audio_count,
                COALESCE(SUM(audio_validated), 0)::integer AS audio_validated_count,
                NULLIF(MAX(last_edit_at), 0) AS last_edit_at
           FROM paired
          GROUP BY lane
         UNION ALL
         SELECT lane,
                'section'::text AS scope,
                section_key,
                COUNT(*)::integer,
                COALESCE(SUM(filled), 0)::integer,
                ${STRUCTURAL_SUMMARY_SQL},
                COALESCE(SUM(audio), 0)::integer,
                COALESCE(SUM(audio_validated), 0)::integer,
                NULLIF(MAX(last_edit_at), 0)
           FROM paired
          WHERE section_key <> ''
          GROUP BY lane, section_key
         UNION ALL
         SELECT lane,
                'book'::text AS scope,
                book_key,
                COUNT(*)::integer,
                COALESCE(SUM(filled), 0)::integer,
                ${STRUCTURAL_SUMMARY_SQL},
                COALESCE(SUM(audio), 0)::integer,
                COALESCE(SUM(audio_validated), 0)::integer,
                NULLIF(MAX(last_edit_at), 0)
           FROM paired
          WHERE book_key <> '' AND (SELECT v FROM has_books)
          GROUP BY lane, book_key
       ), bucket_counts AS (
         SELECT lane, 'file'::text AS scope, ''::text AS section_key,
                validator_bucket, COUNT(*)::integer AS bucket_count,
                ${STRUCTURAL_BUCKET_SQL}
           FROM paired
          GROUP BY lane, validator_bucket
         UNION ALL
         SELECT lane, 'section'::text, section_key, validator_bucket, COUNT(*)::integer,
                ${STRUCTURAL_BUCKET_SQL}
           FROM paired
          WHERE section_key <> ''
          GROUP BY lane, section_key, validator_bucket
         UNION ALL
         SELECT lane, 'book'::text, book_key, validator_bucket, COUNT(*)::integer,
                ${STRUCTURAL_BUCKET_SQL}
           FROM paired
          WHERE book_key <> '' AND (SELECT v FROM has_books)
          GROUP BY lane, book_key, validator_bucket
       ), histograms AS (
         SELECT lane,
                scope,
                section_key,
                jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram,
                ${STRUCTURAL_HISTOGRAM_SQL}
           FROM bucket_counts
          GROUP BY lane, scope, section_key
       ), watermark AS (
         SELECT GREATEST(
           COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
           COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
         )::bigint AS revision
       )
       INSERT INTO file_section_progress (
         ${PROGRESS_INSERT_COLUMNS_SQL}
       )
       SELECT ?, ?, summaries.scope, summaries.section_key, summaries.lane,
              summaries.total_count, summaries.filled_count,
              COALESCE(histograms.validator_histogram, '{}'::jsonb),
              summaries.structural_count, summaries.structural_filled_count,
              COALESCE(histograms.structural_validator_histogram, '{}'::jsonb),
              watermark.revision, ?,
              summaries.audio_count, summaries.audio_validated_count, summaries.last_edit_at
         FROM summaries
         LEFT JOIN histograms
           ON histograms.lane = summaries.lane
          AND histograms.scope = summaries.scope
          AND histograms.section_key = summaries.section_key
         CROSS JOIN watermark
       ON CONFLICT (project_id, file_id, scope, section_key, target_lang) DO UPDATE SET
         ${PROGRESS_UPSERT_SET_SQL}`,
    ).bind(
      projectId, fileId,
      projectId, fileId,
      projectId, fileId,
      projectId, fileId,
      projectId, fileId, projectId,
      projectId, fileId, updatedAt,
    ),
    db.prepare(
      // Prune sections/books whose cells are gone, and every book row once the
      // file stops being Scripture at all.
      //
      // THESE TWO CONDITIONS MUST MIRROR THE INSERT EXACTLY. Book rows are
      // written for any non-empty book key when the FILE holds a verse-shaped
      // ref anywhere (`has_books`). An earlier version demanded that verse
      // shape of the same row that matched the book key, which is a per-BOOK
      // test, so a book of chapter-only refs inside a Scripture file was
      // inserted and deleted in one batch — present after an incremental
      // recompute, gone after a full one. Since a file with book rows has no
      // file-grain unit, those cells then belonged to no planning unit at all
      // and any date or Done mark stored against the book became unreachable.
      // Compute the surviving keys once. The previous correlated CASE made
      // Postgres scan source cells again for every chapter/book/lane row.
      `WITH source_keys AS MATERIALIZED (
         SELECT DISTINCT ${sectionKeyExpr('source')} AS section_key,
                ${bookKeyExpr('source')} AS book_key,
                COALESCE(source.canonical_ref, '') ~ '^\\S+ \\d+:\\d+' AS is_scripture
           FROM cells source
          WHERE source.project_id = ? AND source.file_id = ? AND source.side = 'source'
       ), surviving_keys AS (
         SELECT 'section'::text AS scope, section_key FROM source_keys
         UNION
         SELECT 'book'::text, book_key FROM source_keys
          WHERE EXISTS (SELECT 1 FROM source_keys WHERE is_scripture)
       )
       DELETE FROM file_section_progress progress
        WHERE progress.project_id = ?
          AND progress.file_id = ?
          AND progress.scope IN ('section', 'book')
          AND NOT EXISTS (
            SELECT 1 FROM surviving_keys alive
             WHERE alive.scope = progress.scope AND alive.section_key = progress.section_key
          )`,
    ).bind(projectId, fileId, projectId, fileId),
  ]
}
