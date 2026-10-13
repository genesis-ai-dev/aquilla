import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import { structuralPredicateSql } from './structural-cells'
import { visibleSourceSql } from './hidden-cells-scope'
import { liveSourceSql } from './tombstoned-cells-scope'
// AQU-1278: the section/book key expressions moved to db/shared/plan-keys.ts
// when auth-worker's per-unit assignment read started needing them. They are
// re-exported here so every existing importer of this module keeps working and
// so the file still reads as the one place the projection's grouping is
// defined — the definition simply now lives where both workers can reach it.
import {
  bookKeyExpr,
  inheritedKeysSql,
  PLAN_KEYS_TABLE,
  planKeysJoinSql,
  planKeysRefreshSql,
  sectionKeyExpr,
  TIMELINE_SECTION_MS,
  unitBookKeyExpr,
  unitSectionKeyExpr,
} from '../../../db/shared/plan-keys'
// AQU-490 moved the per-cell audio rollup out for the same reason, and with
// more cause: auth-worker held two hand-copies of it, and this change altered
// what both halves of it mean.
import { AUDIO_CTE_SQL } from '../../../db/shared/audio-progress'

export { bookKeyExpr, sectionKeyExpr, TIMELINE_SECTION_MS, AUDIO_CTE_SQL }

export const MAX_VALIDATOR_HISTOGRAM_BUCKET = 15

/**
 * AQU-1591 — the audio CTE is joined on `lane` as well as `cell_id`. Audio used
 * to have no lane at all, so a single `a.cell_id = s.cell_id` was the whole
 * join and every lane of a file reported the same takes; now a take belongs to
 * one lane and the join has to say which. `a.lane` is a CTE column, so the
 * index note below does not apply to it.
 *
 * AQU-1611 — the lane join compares the BARE `lane_id` column.
 *
 * `idx_cells_file_scan` is `(project_id, file_id, side, lane_id, cell_id)`
 * (migration 0154). `t.lane_id = lanes.lane_id` is an indexable equality on
 * that full tuple. The source lane's id matches no target row, which is what
 * `join_tag` being NULL used to do for the tag column.
 *
 * Wrapping it — `COALESCE(t.lane_id, '') = lanes.lane_id` — changes no result
 * (`lane_id` is NOT NULL) but makes the predicate non-indexable: Postgres
 * stops at `(project_id, file_id, side)` and pairs every target row in the
 * file. On a 10k-cell file one recompute rejected millions of candidate pairs
 * that way. Keep the comparison bare; `progress-lane-join.test.ts` fails if a
 * COALESCE comes back. The audio join stays on `join_tag`: a take with no
 * lane yet still reads as the `''` tag, before and after the AQU-1616 backfill.
 */

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
 * AQU-1493: where each line with no verse reference of its own is counted —
 * a line added in the editor in the chapter of the line above it (front matter
 * of the file's first book at the top), a heading in the chapter of the verse
 * below it (see `inheritedKeysSql`). Read from `cell_plan_keys`, which the full
 * recompute's first statement writes (`planKeysRefreshSql`); `paired` and
 * friends join it as `ik`.
 */
const PLAN_KEYS_JOIN = (alias: string) => planKeysJoinSql(alias, 'ik')

/** The section / book a source cell `alias` counts toward on the plan. */
const UNIT_SECTION_KEY = (alias: string) => unitSectionKeyExpr(alias, 'ik')
const UNIT_BOOK_KEY = (alias: string) => unitBookKeyExpr(alias, 'ik')

/**
 * AQU-1493: the files whose stored placements (`cell_plan_keys`) are not what
 * the walk says now — `scripts/neon-backfill-progress.ts --unreferenced-lines`
 * re-projects exactly these, which rewrites the placements and every progress
 * row counted from them in one batch. Selects (project_id, id); binds nothing;
 * starts with WITH, so a caller combining it with another query must
 * parenthesise it.
 *
 * Compares the walk with the stored rows cell by cell rather than looking for
 * a symptom in the progress rows, so it catches every stale shape alike:
 * production before AQU-1493 (no rows at all, and lines counted in no
 * chapter), rows from before the placements were stored (this PR's earlier
 * builds), and any later change to the rule itself, since the walk is always
 * the current code's. A file the backfill has just re-projected agrees by
 * construction and is never selected again, so the dev stack can run it on
 * every boot.
 *
 * Candidates are Scripture files (a book row, and a verse-shaped reference —
 * the walk's own gate) holding at least one line with no reference. The
 * DISTINCT comes first so those two probes run once per FILE: run per book row
 * they scanned a 27-book New Testament 27 times to reject it.
 */
export const UNREFERENCED_LINES_STALE_FILES_SQL = `WITH candidates AS MATERIALIZED (
             SELECT f.project_id, f.file_id
               FROM (
                 SELECT DISTINCT b.project_id, b.file_id
                   FROM file_section_progress b
                  WHERE b.scope = 'book'
               ) f
              WHERE EXISTS (
                  SELECT 1 FROM cells u
                   WHERE u.project_id = f.project_id AND u.file_id = f.file_id AND u.side = 'source'
                     AND TRIM(SPLIT_PART(COALESCE(u.canonical_ref, ''), ':', 1)) = ''
                )
                AND EXISTS (
                  SELECT 1 FROM cells v
                   WHERE v.project_id = f.project_id AND v.file_id = f.file_id AND v.side = 'source'
                     AND COALESCE(v.canonical_ref, '') ~ '^\\S+ \\d+:\\d+'
                )
           ), walked AS (
             ${inheritedKeysSql('SELECT project_id, file_id FROM candidates')}
           ), stored AS (
             SELECT k.project_id, k.file_id, k.cell_id, k.section_key, k.place_ref, k.depth
               FROM ${PLAN_KEYS_TABLE} k
               JOIN candidates c ON c.project_id = k.project_id AND c.file_id = k.file_id
           )
           SELECT DISTINCT COALESCE(w.project_id, st.project_id) AS project_id,
                  COALESCE(w.file_id, st.file_id) AS id
             FROM walked w
             FULL JOIN stored st
               ON st.project_id = w.project_id AND st.file_id = w.file_id AND st.cell_id = w.cell_id
            WHERE (w.section_key, w.place_ref, w.depth)
                  IS DISTINCT FROM (st.section_key, st.place_ref, st.depth)`

/**
 * The per-cell audio facts each statement's `paired` CTE takes from the CTE
 * above. Shared rather than copied three times for the same reason the
 * structural fragments below are: file, section and book rows must not be able
 * to disagree about what "recorded" means.
 *
 * `audio_validated` is the threshold-1 answer. It exists only for readers that
 * have not moved to the histogram yet, and it is strictly better than what
 * they read before — the old expression was driven by `approved`, so it was 0
 * everywhere, forever. Anything that must honour a project's configured count
 * reads audio_validator_histogram instead; a stored column cannot, which is
 * the whole reason the histogram exists.
 *
 * `audio_validated` is NULL-safe by construction: `NULL >= 1` is NULL, so a
 * cell with no selected dub take falls to the ELSE and counts as 0.
 *
 * The bucket is NOT, and cannot be written as a bare LEAST. Postgres LEAST and
 * GREATEST SKIP null arguments rather than propagating them — `LEAST(NULL, 15)`
 * is 15, not NULL — so every unrecorded cell in the project would have landed
 * in the top bucket, reading as fifteen-times-validated. The text bucket beside
 * this one is safe only because its COALESCE fires first. Caught by
 * "leaves cells with no selected dub take out of the histogram entirely";
 * the explicit IS NULL test is what keeps it caught.
 */
const AUDIO_PAIRED_SQL = `COALESCE(a.has_dub, 0) AS audio,
              CASE WHEN a.dub_votes >= 1 THEN 1 ELSE 0 END AS audio_validated,
              CASE WHEN a.dub_votes IS NULL THEN NULL
                   ELSE LEAST(a.dub_votes, ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) END AS audio_validator_bucket`

// AQU-1083: the structural subset of every aggregate below, recorded whatever
// the policy says. The three SQL fragments are shared by all three statements
// so file, section and book rows can never disagree about what "structural"
// means — a reader that excludes headings subtracts these from the totals
// beside them, bucket-wise for the histogram.

/** The per-lane, per-key structural totals that ride beside total/filled. */
const STRUCTURAL_SUMMARY_SQL = `COALESCE(SUM(structural), 0)::integer AS structural_count,
              COALESCE(SUM(filled) FILTER (WHERE structural = 1), 0)::integer AS structural_filled_count`

/**
 * AQU-1278: the structural share of the AUDIO pair, so a reader that excludes
 * headings subtracts them from the recordings as well as from the cells.
 *
 * Without it the policy shrinks the denominator and leaves the numerator alone,
 * and a book whose chapter headings were voiced reports more audio than it has
 * cells. Sam: recorded headings "don't count towards or against anything".
 *
 * Reads the same per-cell `structural` / `audio` / `audio_validated` columns
 * the `paired` CTE already computes, so no statement grows a join for this.
 */
const STRUCTURAL_AUDIO_SUMMARY_SQL = `COALESCE(SUM(audio) FILTER (WHERE structural = 1), 0)::integer AS structural_audio_count,
              COALESCE(SUM(audio_validated) FILTER (WHERE structural = 1), 0)::integer AS structural_audio_validated_count`

/** The structural share of one validator bucket. */
const STRUCTURAL_BUCKET_SQL = `COUNT(*) FILTER (WHERE structural = 1)::integer AS structural_bucket_count`

/**
 * The structural histogram, built beside validator_histogram from the same
 * bucket rows. Buckets with no structural cells are left out (FILTER), so an
 * ordinary file's histogram stays '{}' rather than a map of zeros.
 */
const STRUCTURAL_HISTOGRAM_SQL = `jsonb_object_agg(validator_bucket::text, structural_bucket_count)
                FILTER (WHERE structural_bucket_count > 0) AS structural_validator_histogram`

/**
 * AQU-490: the audio pair of histograms, built from their OWN bucket CTE.
 *
 * They cannot share `bucket_counts` with the text histogram. Adding
 * audio_validator_bucket to that CTE's GROUP BY splits each text bucket into
 * several rows, and `jsonb_object_agg(validator_bucket, …)` then receives the
 * same key more than once — which is an error at best and a silently halved
 * text histogram at worst. A parallel CTE keeps each grouping to its own key.
 */
const AUDIO_BUCKET_SQL = `COUNT(*)::integer AS bucket_count,
              COUNT(*) FILTER (WHERE structural = 1)::integer AS structural_bucket_count`

const AUDIO_HISTOGRAM_SQL = `jsonb_object_agg(audio_validator_bucket::text, bucket_count) AS audio_validator_histogram,
              jsonb_object_agg(audio_validator_bucket::text, structural_bucket_count)
                FILTER (WHERE structural_bucket_count > 0) AS structural_audio_validator_histogram`

/**
 * AQU-1599: the project's REAL lanes — one row each, the SOURCE lane included.
 *
 * This replaced `SELECT DISTINCT target_lang FROM cells UNION SELECT ''`, which
 * manufactured a `''` lane whether or not one existed and could only ever
 * discover a lane that already had target cells in THIS file. Three things
 * follow from enumerating `lanes` instead:
 *
 *   - The source lane gets a progress row, and that row is where the
 *     lane-independent numbers live (total_count, structural_count, the source
 *     side's newest edit). Readers took them from the `''` row before, so
 *     archiving the former default lane took the plan board's totals with it.
 *   - A registered lane with no target cells yet gets its own 0%-translated
 *     row instead of being invisible until somebody translated in it.
 *   - A tag with no `lanes` row is not projected at all. It could not be
 *     before either: `file_section_progress.lane_id` is NOT NULL (0106) and is
 *     part of the primary key (0114), so such a row had no id to be written
 *     under. Every project create / settings PATCH / migrate path runs
 *     `ensureProjectLaneStmts` (db/shared/lanes.ts), so the rows are there.
 *
 * `join_tag` is NULL on the source lane and the tag on every target lane.
 * The cells join below pairs on `lane_id`, so the source lane matches no
 * target row. `join_tag` remains the audio join's key (see the note above).
 * A tag comparison on the cells join would also borrow the default target
 * lane's translations for the source lane, whose stored tag is ''.
 *
 * Archived lanes are enumerated too: archiving is a soft display decision, and
 * a lane that comes back must not come back with its counts zeroed.
 *
 * Binds: project id.
 */
const PROJECT_LANES_CTE_SQL = `SELECT id AS lane_id,
              role,
              COALESCE(legacy_tag, '') AS lane,
              CASE WHEN role = 'target' THEN COALESCE(legacy_tag, '') END AS join_tag
         FROM public.lanes
        WHERE project_id = ?`

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
       last_edit_at = excluded.last_edit_at,
       structural_audio_count = excluded.structural_audio_count,
       structural_audio_validated_count = excluded.structural_audio_validated_count,
       audio_validator_histogram = excluded.audio_validator_histogram,
       structural_audio_validator_histogram = excluded.structural_audio_validator_histogram`

// AQU-1278 appended the structural audio pair at the TAIL rather than beside
// the audio columns it belongs with, and that is load-bearing: three of the six
// summary branches below are POSITIONAL `UNION ALL` arms with no aliases, so a
// column inserted anywhere but the end shifts every later value one slot to the
// left in half of them — silently, with no SQL error, because the types line up.
// AQU-490's histogram pair is appended for the same reason. Add at the tail.
//
// AQU-1599 made `lane_id` a column of the `lanes` CTE (so every grouping arm
// carries it, as its leading column). Writers no longer fill `target_lang`
// (AQU-1611b); a new progress row leaves that column at its default. The
// SELECT lists below must stay aligned with this column list.
const PROGRESS_INSERT_COLUMNS_SQL = `project_id, file_id, scope, section_key, lane_id, total_count, filled_count,
       validator_histogram, structural_count, structural_filled_count,
       structural_validator_histogram, revision, updated_at,
       audio_count, audio_validated_count, last_edit_at,
       structural_audio_count, structural_audio_validated_count,
       audio_validator_histogram, structural_audio_validator_histogram`

/**
 * Recompute the file-level progress row from authoritative source/target
 * projection rows. Source rows define the denominator; target-only rows are
 * intentionally ignored to preserve the existing sidebar semantics.
 *
 * AQU-538: one row per lane. The denominator (source rows) is lane-independent,
 * so every lane shares the same total_count; each target lane's filled_count /
 * validator histogram derives from that lane's own target rows.
 *
 * AQU-1599: "every lane" means every row of `lanes`, source lane included, and
 * the source lane's row is the one readers take the lane-independent numbers
 * from. There is no manufactured '' row any more — see PROJECT_LANES_CTE_SQL.
 */
export function fileProgressRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  updatedAt: number,
): AquillaStatement {
  return db.prepare(
    `WITH lanes AS (
       ${PROJECT_LANES_CTE_SQL}
     ), audio AS (
       ${AUDIO_CTE_SQL}
     ), paired AS (
       SELECT lanes.lane_id AS lane_id, lanes.lane AS lane,
              s.cell_id,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              CASE WHEN ${structuralPredicateSql('s')} THEN 1 ELSE 0 END AS structural,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket,
              ${AUDIO_PAIRED_SQL},
              GREATEST(COALESCE(s.last_edit_at, 0), COALESCE(t.last_edit_at, 0)) AS last_edit_at
         FROM cells s
         CROSS JOIN lanes
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
          AND t.lane_id = lanes.lane_id
         LEFT JOIN audio a ON a.cell_id = s.cell_id AND a.lane = lanes.join_tag
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
          -- AQU-1424: a parked cell is not work. Dropping it HERE takes it out of
          -- both the numerator and the denominator in one move, for every scope this
          -- CTE feeds (file, section, book) and every lane, so hiding the last
          -- untranslated verse reads 100% instead of 90%. A cell the upstream deleted
          -- from a live link leaves the same way: its tombstoned row (and any
          -- translation orphaned on it) stays for the review panel, but is not work.
          AND ${visibleSourceSql('s')}
          AND ${liveSourceSql('s')}
     ), buckets AS (
       SELECT lane_id, lane, validator_bucket, COUNT(*)::integer AS bucket_count,
              ${STRUCTURAL_BUCKET_SQL}
         FROM paired
        GROUP BY lane_id, lane, validator_bucket
     ), audio_buckets AS (
       SELECT lane_id, lane, audio_validator_bucket, ${AUDIO_BUCKET_SQL}
         FROM paired
        WHERE audio_validator_bucket IS NOT NULL
        GROUP BY lane_id, lane, audio_validator_bucket
     ), summary AS (
       SELECT lane_id, lane,
              COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count,
              ${STRUCTURAL_SUMMARY_SQL},
              COALESCE(SUM(audio), 0)::integer AS audio_count,
              COALESCE(SUM(audio_validated), 0)::integer AS audio_validated_count,
              NULLIF(MAX(last_edit_at), 0) AS last_edit_at,
              ${STRUCTURAL_AUDIO_SUMMARY_SQL}
         FROM paired
        GROUP BY lane_id, lane
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       ${PROGRESS_INSERT_COLUMNS_SQL}
     )
     SELECT ?, ?, 'file', '', summary.lane_id,
            summary.total_count, summary.filled_count,
            COALESCE(
              (SELECT jsonb_object_agg(validator_bucket::text, bucket_count)
                 FROM buckets WHERE buckets.lane_id = summary.lane_id),
              '{}'::jsonb
            ),
            summary.structural_count, summary.structural_filled_count,
            COALESCE(
              (SELECT jsonb_object_agg(validator_bucket::text, structural_bucket_count)
                 FROM buckets
                WHERE buckets.lane_id = summary.lane_id AND structural_bucket_count > 0),
              '{}'::jsonb
            ),
            watermark.revision, ?,
            summary.audio_count, summary.audio_validated_count, summary.last_edit_at,
            summary.structural_audio_count, summary.structural_audio_validated_count,
            COALESCE(
              (SELECT jsonb_object_agg(audio_validator_bucket::text, bucket_count)
                 FROM audio_buckets WHERE audio_buckets.lane_id = summary.lane_id),
              '{}'::jsonb
            ),
            COALESCE(
              (SELECT jsonb_object_agg(audio_validator_bucket::text, structural_bucket_count)
                 FROM audio_buckets
                WHERE audio_buckets.lane_id = summary.lane_id AND structural_bucket_count > 0),
              '{}'::jsonb
            )
       FROM summary CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key, lane_id) DO UPDATE SET
       ${PROGRESS_UPSERT_SET_SQL}`,
  ).bind(
    projectId,                      // lanes
    projectId, fileId,              // audio
    projectId, fileId,              // paired
    projectId, fileId, projectId,   // watermark
    projectId, fileId, updatedAt,   // insert
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
    ? `SELECT DISTINCT ${UNIT_SECTION_KEY('src')} AS section_key, ${UNIT_BOOK_KEY('src')} AS book_key
           FROM cells src
           ${PLAN_KEYS_JOIN('src')}
          WHERE src.project_id = ? AND src.file_id = ? AND src.side = 'source'
            AND src.cell_id IN (${uniqueCellIds.map(() => '?').join(', ')})`
    : ''
  const sectionFilter = affected ? `AND section_key IN (SELECT section_key FROM affected)` : ''
  const bookFilter = affected ? `AND book_key IN (SELECT book_key FROM affected)` : ''
  const affectedCte = affected ? `, affected AS (${affected})` : ''

  const binds: unknown[] = [
    projectId,                   // lanes
    projectId, fileId,           // audio
    projectId, fileId,           // has_books
    projectId, fileId,           // paired
  ]
  if (uniqueCellIds.length > 0) binds.push(projectId, fileId, ...uniqueCellIds)
  // watermark (events, then the rebuilt counter), then the insert's own
  // project/file and its updated_at stamp.
  binds.push(projectId, fileId, projectId, projectId, fileId, updatedAt)

  return db.prepare(
    `WITH lanes AS (
       ${PROJECT_LANES_CTE_SQL}
     ), audio AS (
       ${AUDIO_CTE_SQL}
     ), has_books AS (
       ${HAS_BOOKS_CTE_SQL}
     ), paired AS MATERIALIZED (
       SELECT lanes.lane_id AS lane_id, lanes.lane AS lane,
              ${UNIT_SECTION_KEY('s')} AS section_key,
              ${UNIT_BOOK_KEY('s')} AS book_key,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              CASE WHEN ${structuralPredicateSql('s')} THEN 1 ELSE 0 END AS structural,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket,
              ${AUDIO_PAIRED_SQL},
              GREATEST(COALESCE(s.last_edit_at, 0), COALESCE(t.last_edit_at, 0)) AS last_edit_at
         FROM cells s
         CROSS JOIN lanes
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
          AND t.lane_id = lanes.lane_id
         LEFT JOIN audio a ON a.cell_id = s.cell_id AND a.lane = lanes.join_tag
         ${PLAN_KEYS_JOIN('s')}
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
          -- AQU-1424: a parked cell is not work. Dropping it HERE takes it out of
          -- both the numerator and the denominator in one move, for every scope this
          -- CTE feeds (file, section, book) and every lane, so hiding the last
          -- untranslated verse reads 100% instead of 90%. A cell the upstream deleted
          -- from a live link leaves the same way: its tombstoned row (and any
          -- translation orphaned on it) stays for the review panel, but is not work.
          AND ${visibleSourceSql('s')}
          AND ${liveSourceSql('s')}
     )${affectedCte}, summaries AS (
       SELECT lane_id, lane, 'section'::text AS scope, section_key,
              COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count,
              ${STRUCTURAL_SUMMARY_SQL},
              COALESCE(SUM(audio), 0)::integer AS audio_count,
              COALESCE(SUM(audio_validated), 0)::integer AS audio_validated_count,
              NULLIF(MAX(last_edit_at), 0) AS last_edit_at,
              ${STRUCTURAL_AUDIO_SUMMARY_SQL}
         FROM paired
        WHERE section_key <> '' ${sectionFilter}
        GROUP BY lane_id, lane, section_key
       UNION ALL
       SELECT lane_id, lane, 'book'::text, book_key,
              COUNT(*)::integer,
              COALESCE(SUM(filled), 0)::integer,
              ${STRUCTURAL_SUMMARY_SQL},
              COALESCE(SUM(audio), 0)::integer,
              COALESCE(SUM(audio_validated), 0)::integer,
              NULLIF(MAX(last_edit_at), 0),
              ${STRUCTURAL_AUDIO_SUMMARY_SQL}
         FROM paired
        WHERE book_key <> '' AND (SELECT v FROM has_books) ${bookFilter}
        GROUP BY lane_id, lane, book_key
     ), bucket_counts AS (
       SELECT lane_id, lane, 'section'::text AS scope, section_key, validator_bucket,
              COUNT(*)::integer AS bucket_count,
              ${STRUCTURAL_BUCKET_SQL}
         FROM paired
        WHERE section_key <> '' ${sectionFilter}
        GROUP BY lane_id, lane, section_key, validator_bucket
       UNION ALL
       SELECT lane_id, lane, 'book'::text, book_key, validator_bucket, COUNT(*)::integer,
              ${STRUCTURAL_BUCKET_SQL}
         FROM paired
        WHERE book_key <> '' AND (SELECT v FROM has_books) ${bookFilter}
        GROUP BY lane_id, lane, book_key, validator_bucket
     ), histograms AS (
       SELECT lane_id, lane, scope, section_key,
              jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram,
              ${STRUCTURAL_HISTOGRAM_SQL}
         FROM bucket_counts
        GROUP BY lane_id, lane, scope, section_key
     ), audio_bucket_counts AS (
       SELECT lane_id, lane, 'section'::text AS scope, section_key, audio_validator_bucket,
              ${AUDIO_BUCKET_SQL}
         FROM paired
        WHERE section_key <> '' AND audio_validator_bucket IS NOT NULL ${sectionFilter}
        GROUP BY lane_id, lane, section_key, audio_validator_bucket
       UNION ALL
       SELECT lane_id, lane, 'book'::text, book_key, audio_validator_bucket,
              ${AUDIO_BUCKET_SQL}
         FROM paired
        WHERE book_key <> '' AND audio_validator_bucket IS NOT NULL
          AND (SELECT v FROM has_books) ${bookFilter}
        GROUP BY lane_id, lane, book_key, audio_validator_bucket
     ), audio_histograms AS (
       SELECT lane_id, lane, scope, section_key,
              ${AUDIO_HISTOGRAM_SQL}
         FROM audio_bucket_counts
        GROUP BY lane_id, lane, scope, section_key
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       ${PROGRESS_INSERT_COLUMNS_SQL}
     )
     SELECT ?, ?, summaries.scope, summaries.section_key, summaries.lane_id,
            summaries.total_count, summaries.filled_count,
            COALESCE(histograms.validator_histogram, '{}'::jsonb),
            summaries.structural_count, summaries.structural_filled_count,
            COALESCE(histograms.structural_validator_histogram, '{}'::jsonb),
            watermark.revision, ?,
            summaries.audio_count, summaries.audio_validated_count, summaries.last_edit_at,
            summaries.structural_audio_count, summaries.structural_audio_validated_count,
            COALESCE(audio_histograms.audio_validator_histogram, '{}'::jsonb),
            COALESCE(audio_histograms.structural_audio_validator_histogram, '{}'::jsonb)
       FROM summaries
       LEFT JOIN histograms
         ON histograms.lane_id = summaries.lane_id
        AND histograms.scope = summaries.scope
        AND histograms.section_key = summaries.section_key
       LEFT JOIN audio_histograms
         ON audio_histograms.lane_id = summaries.lane_id
        AND audio_histograms.scope = summaries.scope
        AND audio_histograms.section_key = summaries.section_key
       CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key, lane_id) DO UPDATE SET
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
    // AQU-1493: FIRST, where each line with no reference counts — the one
    // place `cell_plan_keys` is written. Everything after it in this batch,
    // and every incremental recompute and reader until the next full one,
    // joins those rows instead of walking the anchor chain again.
    db.prepare(planKeysRefreshSql()).bind(projectId, fileId, projectId, fileId),
    db.prepare(
      // AQU-538: per-lane. `lanes` enumerates the project's lanes (AQU-1599:
      // from the `lanes` table, source lane included) so each source cell is
      // paired against that lane's target row; summaries/histograms group by
      // lane id and the upsert keys the 5-col PK.
      //
      // AQU-1093/1096: `paired` additionally carries the cell's BOOK key, its
      // audio state, and its newest edit, so one pass over the file produces
      // file, section AND book rows. Grouping keys carry `scope` because a
      // book-only ref ("TIT") collides with its own section key.
      `WITH lanes AS (
         ${PROJECT_LANES_CTE_SQL}
       ), audio AS (
         ${AUDIO_CTE_SQL}
       ), has_books AS (
         ${HAS_BOOKS_CTE_SQL}
       ), paired AS MATERIALIZED (
         SELECT lanes.lane_id AS lane_id, lanes.lane AS lane,
                ${UNIT_SECTION_KEY('s')} AS section_key,
                ${UNIT_BOOK_KEY('s')} AS book_key,
                CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
                CASE WHEN ${structuralPredicateSql('s')} THEN 1 ELSE 0 END AS structural,
                LEAST(
                  COALESCE(t.endorsement_count, 0),
                  ${MAX_VALIDATOR_HISTOGRAM_BUCKET}
                ) AS validator_bucket,
                ${AUDIO_PAIRED_SQL},
                GREATEST(COALESCE(s.last_edit_at, 0), COALESCE(t.last_edit_at, 0)) AS last_edit_at
           FROM cells s
           CROSS JOIN lanes
           LEFT JOIN cells t
             ON t.project_id = s.project_id
            AND t.file_id = s.file_id
            AND t.cell_id = s.cell_id
            AND t.side = 'target'
            AND t.lane_id = lanes.lane_id
           LEFT JOIN audio a ON a.cell_id = s.cell_id AND a.lane = lanes.join_tag
           ${PLAN_KEYS_JOIN('s')}
          WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
            -- AQU-1424: see the note on the other paired CTEs — parked cells leave
            -- progress entirely, numerator and denominator together. So do cells the
            -- upstream deleted from a live link (tombstoned_at).
            AND ${visibleSourceSql('s')}
            AND ${liveSourceSql('s')}
       ), summaries AS (
         SELECT lane_id, lane,
                'file'::text AS scope,
                ''::text AS section_key,
                COUNT(*)::integer AS total_count,
                COALESCE(SUM(filled), 0)::integer AS filled_count,
                ${STRUCTURAL_SUMMARY_SQL},
                COALESCE(SUM(audio), 0)::integer AS audio_count,
                COALESCE(SUM(audio_validated), 0)::integer AS audio_validated_count,
                NULLIF(MAX(last_edit_at), 0) AS last_edit_at,
                ${STRUCTURAL_AUDIO_SUMMARY_SQL}
           FROM paired
          GROUP BY lane_id, lane
         UNION ALL
         SELECT lane_id, lane,
                'section'::text AS scope,
                section_key,
                COUNT(*)::integer,
                COALESCE(SUM(filled), 0)::integer,
                ${STRUCTURAL_SUMMARY_SQL},
                COALESCE(SUM(audio), 0)::integer,
                COALESCE(SUM(audio_validated), 0)::integer,
                NULLIF(MAX(last_edit_at), 0),
                ${STRUCTURAL_AUDIO_SUMMARY_SQL}
           FROM paired
          WHERE section_key <> ''
          GROUP BY lane_id, lane, section_key
         UNION ALL
         SELECT lane_id, lane,
                'book'::text AS scope,
                book_key,
                COUNT(*)::integer,
                COALESCE(SUM(filled), 0)::integer,
                ${STRUCTURAL_SUMMARY_SQL},
                COALESCE(SUM(audio), 0)::integer,
                COALESCE(SUM(audio_validated), 0)::integer,
                NULLIF(MAX(last_edit_at), 0),
                ${STRUCTURAL_AUDIO_SUMMARY_SQL}
           FROM paired
          WHERE book_key <> '' AND (SELECT v FROM has_books)
          GROUP BY lane_id, lane, book_key
       ), bucket_counts AS (
         SELECT lane_id, lane, 'file'::text AS scope, ''::text AS section_key,
                validator_bucket, COUNT(*)::integer AS bucket_count,
                ${STRUCTURAL_BUCKET_SQL}
           FROM paired
          GROUP BY lane_id, lane, validator_bucket
         UNION ALL
         SELECT lane_id, lane, 'section'::text, section_key, validator_bucket, COUNT(*)::integer,
                ${STRUCTURAL_BUCKET_SQL}
           FROM paired
          WHERE section_key <> ''
          GROUP BY lane_id, lane, section_key, validator_bucket
         UNION ALL
         SELECT lane_id, lane, 'book'::text, book_key, validator_bucket, COUNT(*)::integer,
                ${STRUCTURAL_BUCKET_SQL}
           FROM paired
          WHERE book_key <> '' AND (SELECT v FROM has_books)
          GROUP BY lane_id, lane, book_key, validator_bucket
       ), histograms AS (
         SELECT lane_id, lane,
                scope,
                section_key,
                jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram,
                ${STRUCTURAL_HISTOGRAM_SQL}
           FROM bucket_counts
          GROUP BY lane_id, lane, scope, section_key
       ), audio_bucket_counts AS (
         SELECT lane_id, lane, 'file'::text AS scope, ''::text AS section_key,
                audio_validator_bucket, ${AUDIO_BUCKET_SQL}
           FROM paired
          WHERE audio_validator_bucket IS NOT NULL
          GROUP BY lane_id, lane, audio_validator_bucket
         UNION ALL
         SELECT lane_id, lane, 'section'::text, section_key, audio_validator_bucket,
                ${AUDIO_BUCKET_SQL}
           FROM paired
          WHERE section_key <> '' AND audio_validator_bucket IS NOT NULL
          GROUP BY lane_id, lane, section_key, audio_validator_bucket
         UNION ALL
         SELECT lane_id, lane, 'book'::text, book_key, audio_validator_bucket,
                ${AUDIO_BUCKET_SQL}
           FROM paired
          WHERE book_key <> '' AND audio_validator_bucket IS NOT NULL
            AND (SELECT v FROM has_books)
          GROUP BY lane_id, lane, book_key, audio_validator_bucket
       ), audio_histograms AS (
         SELECT lane_id, lane,
                scope,
                section_key,
                ${AUDIO_HISTOGRAM_SQL}
           FROM audio_bucket_counts
          GROUP BY lane_id, lane, scope, section_key
       ), watermark AS (
         SELECT GREATEST(
           COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
           COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
         )::bigint AS revision
       )
       INSERT INTO file_section_progress (
         ${PROGRESS_INSERT_COLUMNS_SQL}
       )
       SELECT ?, ?, summaries.scope, summaries.section_key, summaries.lane_id,
              summaries.total_count, summaries.filled_count,
              COALESCE(histograms.validator_histogram, '{}'::jsonb),
              summaries.structural_count, summaries.structural_filled_count,
              COALESCE(histograms.structural_validator_histogram, '{}'::jsonb),
              watermark.revision, ?,
              summaries.audio_count, summaries.audio_validated_count, summaries.last_edit_at,
              summaries.structural_audio_count, summaries.structural_audio_validated_count,
              COALESCE(audio_histograms.audio_validator_histogram, '{}'::jsonb),
              COALESCE(audio_histograms.structural_audio_validator_histogram, '{}'::jsonb)
         FROM summaries
         LEFT JOIN histograms
           ON histograms.lane_id = summaries.lane_id
          AND histograms.scope = summaries.scope
          AND histograms.section_key = summaries.section_key
         LEFT JOIN audio_histograms
           ON audio_histograms.lane_id = summaries.lane_id
          AND audio_histograms.scope = summaries.scope
          AND audio_histograms.section_key = summaries.section_key
         CROSS JOIN watermark
       ON CONFLICT (project_id, file_id, scope, section_key, lane_id) DO UPDATE SET
         ${PROGRESS_UPSERT_SET_SQL}`,
    ).bind(
      projectId,                      // lanes
      projectId, fileId,              // audio
      projectId, fileId,              // has_books
      projectId, fileId,              // paired
      projectId, fileId, projectId,   // watermark
      projectId, fileId, updatedAt,   // insert
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
      //
      // AQU-1493: by the keys the insert COUNTED each cell under, inherited
      // ones included. A line with no reference can be the only visible cell
      // left in its chapter (the verses around it parked), and the insert
      // above has just written that chapter's row for it.
      `WITH source_keys AS MATERIALIZED (
         SELECT DISTINCT ${UNIT_SECTION_KEY('source')} AS section_key,
                ${UNIT_BOOK_KEY('source')} AS book_key,
                COALESCE(source.canonical_ref, '') ~ '^\\S+ \\d+:\\d+' AS is_scripture
           FROM cells source
           ${PLAN_KEYS_JOIN('source')}
          WHERE source.project_id = ? AND source.file_id = ? AND source.side = 'source'
            -- AQU-1424: a section whose every cell is now parked has no surviving key,
            -- so its progress row is deleted rather than left behind at a stale count
            -- that no later recompute would revisit. Likewise a section whose every
            -- cell the upstream deleted.
            AND ${visibleSourceSql('source')}
            AND ${liveSourceSql('source')}
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
