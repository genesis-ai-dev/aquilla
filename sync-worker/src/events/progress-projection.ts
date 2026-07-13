import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'

export const MAX_VALIDATOR_HISTOGRAM_BUCKET = 15

/**
 * Recompute the file-level progress row from authoritative source/target
 * projection rows. Source rows define the denominator; target-only rows are
 * intentionally ignored to preserve the existing sidebar semantics.
 */
export function fileProgressRecomputeStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  updatedAt: number,
): AquillaStatement {
  return db.prepare(
    `WITH paired AS (
       SELECT s.cell_id,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket
         FROM cells s
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
     ), buckets AS (
       SELECT validator_bucket, COUNT(*)::integer AS bucket_count
         FROM paired
        GROUP BY validator_bucket
     ), summary AS (
       SELECT COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count
         FROM paired
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       project_id, file_id, scope, section_key, total_count, filled_count,
       validator_histogram, revision, updated_at
     )
     SELECT ?, ?, 'file', '', summary.total_count, summary.filled_count,
            COALESCE(
              (SELECT jsonb_object_agg(validator_bucket::text, bucket_count)
                 FROM buckets),
              '{}'::jsonb
            ),
            watermark.revision, ?
       FROM summary CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key) DO UPDATE SET
       total_count = excluded.total_count,
       filled_count = excluded.filled_count,
       validator_histogram = excluded.validator_histogram,
       revision = excluded.revision,
       updated_at = excluded.updated_at`,
  ).bind(
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

  const binds: unknown[] = [projectId, fileId]
  if (uniqueCellIds.length > 0) binds.push(projectId, fileId, ...uniqueCellIds)
  binds.push(projectId, fileId, projectId, projectId, fileId, updatedAt)

  return db.prepare(
    `WITH paired AS (
       SELECT TRIM(SPLIT_PART(COALESCE(s.canonical_ref, ''), ':', 1)) AS section_key,
              CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
              LEAST(COALESCE(t.endorsement_count, 0), ${MAX_VALIDATOR_HISTOGRAM_BUCKET}) AS validator_bucket
         FROM cells s
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id = s.file_id
          AND t.cell_id = s.cell_id
          AND t.side = 'target'
        WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
     ), filtered AS (
       SELECT * FROM paired
        WHERE section_key <> ''
        ${affectedFilter}
     ), summaries AS (
       SELECT section_key,
              COUNT(*)::integer AS total_count,
              COALESCE(SUM(filled), 0)::integer AS filled_count
         FROM filtered
        GROUP BY section_key
     ), histograms AS (
       SELECT section_key,
              jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram
         FROM (
           SELECT section_key, validator_bucket, COUNT(*)::integer AS bucket_count
             FROM filtered
            GROUP BY section_key, validator_bucket
         ) bucket_counts
        GROUP BY section_key
     ), watermark AS (
       SELECT GREATEST(
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
         COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
       )::bigint AS revision
     )
     INSERT INTO file_section_progress (
       project_id, file_id, scope, section_key, total_count, filled_count,
       validator_histogram, revision, updated_at
     )
     SELECT ?, ?, 'section', summaries.section_key,
            summaries.total_count, summaries.filled_count,
            COALESCE(histograms.validator_histogram, '{}'::jsonb),
            watermark.revision, ?
       FROM summaries
       LEFT JOIN histograms USING (section_key)
       CROSS JOIN watermark
     ON CONFLICT (project_id, file_id, scope, section_key) DO UPDATE SET
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
      `WITH paired AS MATERIALIZED (
         SELECT TRIM(SPLIT_PART(COALESCE(s.canonical_ref, ''), ':', 1)) AS section_key,
                CASE WHEN TRIM(COALESCE(t.value, '')) <> '' THEN 1 ELSE 0 END AS filled,
                LEAST(
                  COALESCE(t.endorsement_count, 0),
                  ${MAX_VALIDATOR_HISTOGRAM_BUCKET}
                ) AS validator_bucket
           FROM cells s
           LEFT JOIN cells t
             ON t.project_id = s.project_id
            AND t.file_id = s.file_id
            AND t.cell_id = s.cell_id
            AND t.side = 'target'
          WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
       ), summaries AS (
         SELECT 'file'::text AS scope,
                ''::text AS section_key,
                COUNT(*)::integer AS total_count,
                COALESCE(SUM(filled), 0)::integer AS filled_count
           FROM paired
         UNION ALL
         SELECT 'section'::text AS scope,
                section_key,
                COUNT(*)::integer AS total_count,
                COALESCE(SUM(filled), 0)::integer AS filled_count
           FROM paired
          WHERE section_key <> ''
          GROUP BY section_key
       ), bucket_counts AS (
         SELECT ''::text AS section_key,
                validator_bucket,
                COUNT(*)::integer AS bucket_count
           FROM paired
          GROUP BY validator_bucket
         UNION ALL
         SELECT section_key,
                validator_bucket,
                COUNT(*)::integer AS bucket_count
           FROM paired
          WHERE section_key <> ''
          GROUP BY section_key, validator_bucket
       ), histograms AS (
         SELECT section_key,
                jsonb_object_agg(validator_bucket::text, bucket_count) AS validator_histogram
           FROM bucket_counts
          GROUP BY section_key
       ), watermark AS (
         SELECT GREATEST(
           COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
           COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
         )::bigint AS revision
       )
       INSERT INTO file_section_progress (
         project_id, file_id, scope, section_key, total_count, filled_count,
         validator_histogram, revision, updated_at
       )
       SELECT ?, ?, summaries.scope, summaries.section_key,
              summaries.total_count, summaries.filled_count,
              COALESCE(histograms.validator_histogram, '{}'::jsonb),
              watermark.revision, ?
         FROM summaries
         LEFT JOIN histograms USING (section_key)
         CROSS JOIN watermark
       ON CONFLICT (project_id, file_id, scope, section_key) DO UPDATE SET
         total_count = excluded.total_count,
         filled_count = excluded.filled_count,
         validator_histogram = excluded.validator_histogram,
         revision = excluded.revision,
         updated_at = excluded.updated_at`,
    ).bind(
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
