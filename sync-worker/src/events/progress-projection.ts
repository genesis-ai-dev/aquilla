import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'

export const MAX_VALIDATOR_HISTOGRAM_BUCKET = 15

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
     ), paired AS (
       SELECT lanes.lane AS lane,
              s.cell_id,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket
         FROM cells s
         CROSS JOIN lanes
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
          AND t.target_lang = lanes.lane
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
     ), buckets AS (
       SELECT lane, validator_bucket, COUNT(*)::integer AS bucket_count
         FROM paired
        GROUP BY lane, validator_bucket
     ), summary AS (
       SELECT lane,
              COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count
         FROM paired
        GROUP BY lane
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       project_id, file_id, scope, section_key, target_lang, total_count, filled_count,
       validator_histogram, revision, updated_at
     )
     SELECT ?, ?, 'file', '', summary.lane, summary.total_count, summary.filled_count,
            COALESCE(
              (SELECT jsonb_object_agg(validator_bucket::text, bucket_count)
                 FROM buckets WHERE buckets.lane = summary.lane),
              '{}'::jsonb
            ),
            watermark.revision, ?
       FROM summary CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key, target_lang) DO UPDATE SET
       total_count = excluded.total_count,
       filled_count = excluded.filled_count,
       validator_histogram = excluded.validator_histogram,
       revision = excluded.revision,
       updated_at = excluded.updated_at`,
  ).bind(
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
    .prepare(`DELETE FROM file_section_progress WHERE project_id = ? AND file_id = ? AND scope = 'section'`)
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
  const affectedFilter = uniqueCellIds.length > 0
    ? `AND section_key IN (
         SELECT DISTINCT TRIM(SPLIT_PART(COALESCE(canonical_ref, ''), ':', 1))
           FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source'
            AND cell_id IN (${uniqueCellIds.map(() => '?').join(', ')})
       )`
    : ''

  // AQU-538: lanes CTE up front, then paired WHERE, then (optional)
  // affectedFilter subquery, then watermark, then the INSERT projection.
  const binds: unknown[] = [projectId, fileId, projectId, fileId]
  if (uniqueCellIds.length > 0) binds.push(projectId, fileId, ...uniqueCellIds)
  binds.push(projectId, fileId, projectId, projectId, fileId, updatedAt)

  return db.prepare(
    `WITH lanes AS (
       SELECT DISTINCT COALESCE(target_lang, '') AS lane
         FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'target'
       UNION SELECT ''
     ), paired AS (
       SELECT lanes.lane AS lane,
              TRIM(SPLIT_PART(COALESCE(s.canonical_ref, ''), ':', 1)) AS section_key,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket
         FROM cells s
         CROSS JOIN lanes
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
          AND t.target_lang = lanes.lane
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
     ), filtered AS (
       SELECT * FROM paired
        WHERE section_key <> ''
        ${affectedFilter}
     ), summaries AS (
       SELECT lane, section_key,
              COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count
         FROM filtered
        GROUP BY lane, section_key
     ), histograms AS (
       SELECT lane, section_key,
              jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram
         FROM (
           SELECT lane, section_key, validator_bucket, COUNT(*)::integer AS bucket_count
             FROM filtered
            GROUP BY lane, section_key, validator_bucket
         ) bucket_counts
        GROUP BY lane, section_key
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       project_id, file_id, scope, section_key, target_lang, total_count, filled_count,
       validator_histogram, revision, updated_at
     )
     SELECT ?, ?, 'section', summaries.section_key, summaries.lane,
            summaries.total_count, summaries.filled_count,
            COALESCE(histograms.validator_histogram, '{}'::jsonb),
            watermark.revision, ?
       FROM summaries
       LEFT JOIN histograms USING (lane, section_key)
       CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key, target_lang) DO UPDATE SET
       total_count = excluded.total_count,
       filled_count = excluded.filled_count,
       validator_histogram = excluded.validator_histogram,
       revision = excluded.revision,
       updated_at = excluded.updated_at`,
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
      `WITH lanes AS (
         SELECT DISTINCT COALESCE(target_lang, '') AS lane
           FROM cells WHERE project_id = ? AND file_id = ? AND side = 'target'
         UNION SELECT ''
       ), paired AS MATERIALIZED (
         SELECT lanes.lane AS lane,
                TRIM(SPLIT_PART(COALESCE(s.canonical_ref, ''), ':', 1)) AS section_key,
                CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
                LEAST(
                  COALESCE(t.endorsement_count, 0),
                  ${MAX_VALIDATOR_HISTOGRAM_BUCKET}
                ) AS validator_bucket
           FROM cells s
           CROSS JOIN lanes
           LEFT JOIN cells t
             ON t.project_id = s.project_id
            AND t.file_id = s.file_id
            AND t.cell_id = s.cell_id
            AND t.side = 'target'
            AND COALESCE(t.target_lang, '') = lanes.lane
          WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
       ), summaries AS (
         SELECT lane,
                'file'::text AS scope,
                ''::text AS section_key,
                COUNT(*)::integer AS total_count,
                COALESCE(SUM(filled), 0)::integer AS filled_count
           FROM paired
          GROUP BY lane
         UNION ALL
         SELECT lane,
                'section'::text AS scope,
                section_key,
                COUNT(*)::integer AS total_count,
                COALESCE(SUM(filled), 0)::integer AS filled_count
           FROM paired
          WHERE section_key <> ''
          GROUP BY lane, section_key
       ), bucket_counts AS (
         SELECT lane,
                ''::text AS section_key,
                validator_bucket,
                COUNT(*)::integer AS bucket_count
           FROM paired
          GROUP BY lane, validator_bucket
         UNION ALL
         SELECT lane,
                section_key,
                validator_bucket,
                COUNT(*)::integer AS bucket_count
           FROM paired
          WHERE section_key <> ''
          GROUP BY lane, section_key, validator_bucket
       ), histograms AS (
         SELECT lane,
                section_key,
                jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram
           FROM bucket_counts
          GROUP BY lane, section_key
       ), watermark AS (
         SELECT GREATEST(
           COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
           COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
         )::bigint AS revision
       )
       INSERT INTO file_section_progress (
         project_id, file_id, scope, section_key, target_lang, total_count, filled_count,
         validator_histogram, revision, updated_at
       )
       SELECT ?, ?, summaries.scope, summaries.section_key, summaries.lane,
              summaries.total_count, summaries.filled_count,
              COALESCE(histograms.validator_histogram, '{}'::jsonb),
              watermark.revision, ?
         FROM summaries
         LEFT JOIN histograms
           ON histograms.lane = summaries.lane AND histograms.section_key = summaries.section_key
         CROSS JOIN watermark
       ON CONFLICT (project_id, file_id, scope, section_key, target_lang) DO UPDATE SET
         total_count = excluded.total_count,
         filled_count = excluded.filled_count,
         validator_histogram = excluded.validator_histogram,
         revision = excluded.revision,
         updated_at = excluded.updated_at`,
    ).bind(
      projectId, fileId,
      projectId, fileId,
      projectId, fileId, projectId,
      projectId, fileId, updatedAt,
    ),
    db.prepare(
      `DELETE FROM file_section_progress progress
        WHERE progress.project_id = ?
          AND progress.file_id = ?
          AND progress.scope = 'section'
          AND NOT EXISTS (
            SELECT 1
              FROM cells source
             WHERE source.project_id = progress.project_id
               AND source.file_id = progress.file_id
               AND source.side = 'source'
               AND TRIM(SPLIT_PART(COALESCE(source.canonical_ref, ''), ':', 1)) = progress.section_key
          )`,
    ).bind(projectId, fileId),
  ]
}
