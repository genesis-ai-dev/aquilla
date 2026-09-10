-- =============================================================================
-- AQU-1240 pre-flight audit: eliminate the implicit default lane ('')
-- =============================================================================
--
-- Purpose
--   Read-only blast-radius report for the "eliminate the implicit default lane"
--   migration (Linear AQU-1240). Quantifies rows that must be relabeled, rows
--   that must NOT be touched, and projects that cannot be auto-migrated safely.
--
--   Measures exactly the risks named in:
--     docs/superpowers/specs/2026-09-09-eliminate-default-lane-design.md §2.2
--
-- Safety
--   STRICTLY READ-ONLY. SELECT statements only — no INSERT, UPDATE, DELETE,
--   ALTER, CREATE, or other writes.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f db/postgres/audits/aqu-1240-default-lane-preflight.sql
--
--   For a saved report:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f db/postgres/audits/aqu-1240-default-lane-preflight.sql \
--     > /tmp/aqu-1240-preflight-$(date +%Y%m%d-%H%M%S).txt
--
-- Schema references (db/postgres/schema.sql)
--   target_lang columns: cells, file_section_progress, cell_validators,
--   assignments, artifact_bindings, scene_briefs, contextual_runs,
--   contextual_drafts
--   Lane scopes (not target_lang): project_member_scopes.value WHERE kind='lane'
--   Default-lane tag source: project_settings.target_language (migration 0054
--   generated column over settings->>'targetLanguage')
--   Named lanes registry: project_settings.target_lanes (settings->'targetLanes')
--   Archived lanes: (settings::jsonb)->'archivedLanes' (JSON only, no generated col)
--
-- Interpretation (design §2.2)
--   CLEAN          — target_language non-blank, no case-insensitive targetLanes match
--   BLANK          — target_language NULL/absent/whitespace; quarantine if '' content
--   COLLIDE        — target_language matches a live targetLanes entry (PK merge risk)
--   ARCHIVED-COLLIDE — target_language matches an archivedLanes entry only
-- =============================================================================

\set QUIET on
\pset pager off
\pset format aligned
\timing off

-- ---------------------------------------------------------------------------
-- 0) Project settings resolution and migration class
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 0) Per-project migration class (target_language / targetLanes) ==='
\echo ''

WITH project_lane_settings AS (
    SELECT
        ps.project_id,
        ps.target_language,
        ps.target_lanes,
        NULLIF(BTRIM(ps.target_language), '') AS resolved_tag,
        COALESCE(ps.target_lanes, '[]'::jsonb) AS target_lanes_json,
        COALESCE(jsonb_array_length(ps.target_lanes), 0) AS target_lanes_count,
        COALESCE((ps.settings::jsonb)->'archivedLanes', '[]'::jsonb) AS archived_lanes_json
    FROM project_settings ps
),
project_class AS (
    SELECT
        pls.*,
        EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(pls.target_lanes_json) AS tl(lane)
            WHERE pls.resolved_tag IS NOT NULL
              AND LOWER(BTRIM(tl.lane)) = LOWER(pls.resolved_tag)
        ) AS collides_with_live_lane,
        EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(pls.archived_lanes_json) AS al(lane)
            WHERE pls.resolved_tag IS NOT NULL
              AND LOWER(BTRIM(al.lane)) = LOWER(pls.resolved_tag)
        ) AS collides_with_archived_lane,
        CASE
            WHEN pls.resolved_tag IS NULL THEN 'BLANK'
            WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(pls.target_lanes_json) AS tl(lane)
                WHERE LOWER(BTRIM(tl.lane)) = LOWER(pls.resolved_tag)
            ) THEN 'COLLIDE'
            WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(pls.archived_lanes_json) AS al(lane)
                WHERE LOWER(BTRIM(al.lane)) = LOWER(pls.resolved_tag)
            ) THEN 'ARCHIVED-COLLIDE'
            ELSE 'CLEAN'
        END AS migration_class
    FROM project_lane_settings pls
),
cells_empty AS (
    SELECT project_id, COUNT(*)::bigint AS empty_target_cells
    FROM cells
    WHERE target_lang = '' AND side = 'target'
    GROUP BY project_id
),
assignments_empty AS (
    SELECT project_id, COUNT(*)::bigint AS empty_assignments
    FROM assignments
    WHERE target_lang = ''
    GROUP BY project_id
),
lane_scopes_empty AS (
    SELECT project_id, COUNT(*)::bigint AS empty_lane_scopes
    FROM project_member_scopes
    WHERE kind = 'lane' AND value = ''
    GROUP BY project_id
),
project_empty_signal AS (
    SELECT
        COALESCE(c.project_id, a.project_id, s.project_id) AS project_id,
        COALESCE(c.empty_target_cells, 0) AS empty_target_cells,
        COALESCE(a.empty_assignments, 0) AS empty_assignments,
        COALESCE(s.empty_lane_scopes, 0) AS empty_lane_scopes,
        (
            COALESCE(c.empty_target_cells, 0)
            + COALESCE(a.empty_assignments, 0)
            + COALESCE(s.empty_lane_scopes, 0)
        ) AS headline_empty_rows
    FROM cells_empty c
    FULL OUTER JOIN assignments_empty a USING (project_id)
    FULL OUTER JOIN lane_scopes_empty s USING (project_id)
)
SELECT
    pc.project_id,
    pc.migration_class,
    pc.target_language AS raw_target_language,
    pc.resolved_tag AS backfill_tag_candidate,
    pc.target_lanes_count,
    pc.target_lanes_json,
    pc.archived_lanes_json,
    COALESCE(pes.empty_target_cells, 0) AS empty_target_cells,
    COALESCE(pes.empty_assignments, 0) AS empty_assignments,
    COALESCE(pes.empty_lane_scopes, 0) AS empty_lane_scopes,
    COALESCE(pes.headline_empty_rows, 0) AS headline_empty_rows,
    (SELECT COUNT(*)::bigint FROM events e WHERE e.project_id = pc.project_id) AS event_count
FROM project_class pc
LEFT JOIN project_empty_signal pes ON pes.project_id = pc.project_id
WHERE COALESCE(pes.headline_empty_rows, 0) > 0
   OR pc.migration_class <> 'CLEAN'
ORDER BY
    CASE pc.migration_class
        WHEN 'BLANK' THEN 1
        WHEN 'COLLIDE' THEN 2
        WHEN 'ARCHIVED-COLLIDE' THEN 3
        WHEN 'CLEAN' THEN 4
    END,
    COALESCE(pes.headline_empty_rows, 0) DESC,
    pc.project_id;

\echo ''
\echo '=== 0b) Migration class totals ==='
\echo ''

WITH project_lane_settings AS (
    SELECT
        ps.project_id,
        NULLIF(BTRIM(ps.target_language), '') AS resolved_tag,
        COALESCE(ps.target_lanes, '[]'::jsonb) AS target_lanes_json,
        COALESCE((ps.settings::jsonb)->'archivedLanes', '[]'::jsonb) AS archived_lanes_json
    FROM project_settings ps
),
project_class AS (
    SELECT
        pls.project_id,
        CASE
            WHEN pls.resolved_tag IS NULL THEN 'BLANK'
            WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(pls.target_lanes_json) AS tl(lane)
                WHERE LOWER(BTRIM(tl.lane)) = LOWER(pls.resolved_tag)
            ) THEN 'COLLIDE'
            WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(pls.archived_lanes_json) AS al(lane)
                WHERE LOWER(BTRIM(al.lane)) = LOWER(pls.resolved_tag)
            ) THEN 'ARCHIVED-COLLIDE'
            ELSE 'CLEAN'
        END AS migration_class
    FROM project_lane_settings pls
),
has_empty_target_content AS (
    SELECT DISTINCT project_id
    FROM (
        SELECT project_id FROM cells WHERE target_lang = '' AND side = 'target'
        UNION
        SELECT project_id FROM assignments WHERE target_lang = ''
        UNION
        SELECT project_id FROM cell_validators WHERE target_lang = ''
        UNION
        SELECT project_id FROM file_section_progress WHERE target_lang = ''
        UNION
        SELECT project_id FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'target'
        UNION
        SELECT project_id FROM scene_briefs WHERE target_lang = ''
        UNION
        SELECT project_id FROM contextual_runs WHERE target_lang = ''
        UNION
        SELECT project_id FROM contextual_drafts WHERE target_lang = ''
        UNION
        SELECT project_id FROM project_member_scopes WHERE kind = 'lane' AND value = ''
    ) s
)
SELECT
    pc.migration_class,
    COUNT(*)::bigint AS project_count,
    COUNT(*) FILTER (
        WHERE het.project_id IS NOT NULL
    )::bigint AS projects_with_empty_target_content
FROM project_class pc
LEFT JOIN has_empty_target_content het ON het.project_id = pc.project_id
GROUP BY pc.migration_class
ORDER BY
    CASE pc.migration_class
        WHEN 'BLANK' THEN 1
        WHEN 'COLLIDE' THEN 2
        WHEN 'ARCHIVED-COLLIDE' THEN 3
        WHEN 'CLEAN' THEN 4
    END;

-- ---------------------------------------------------------------------------
-- 1) DANGER: projects with '' target content but no resolvable backfill tag
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 1) DANGER — BLANK target_language with implicit-lane content ==='
\echo '    (migration cannot safely auto-relabel; human must name the lane)'
\echo ''

WITH blank_projects AS (
    SELECT ps.project_id
    FROM project_settings ps
    WHERE NULLIF(BTRIM(ps.target_language), '') IS NULL
),
empty_content AS (
    SELECT project_id, 'cells.target (side=target)' AS source, COUNT(*)::bigint AS row_count
    FROM cells WHERE target_lang = '' AND side = 'target' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'assignments', COUNT(*)::bigint FROM assignments WHERE target_lang = '' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'cell_validators', COUNT(*)::bigint FROM cell_validators WHERE target_lang = '' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'file_section_progress', COUNT(*)::bigint FROM file_section_progress WHERE target_lang = '' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'artifact_bindings (binding_role=target)', COUNT(*)::bigint
    FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'target' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'scene_briefs', COUNT(*)::bigint FROM scene_briefs WHERE target_lang = '' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'contextual_runs', COUNT(*)::bigint FROM contextual_runs WHERE target_lang = '' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'contextual_drafts', COUNT(*)::bigint FROM contextual_drafts WHERE target_lang = '' GROUP BY project_id
    UNION ALL
    SELECT project_id, 'project_member_scopes (kind=lane)', COUNT(*)::bigint
    FROM project_member_scopes WHERE kind = 'lane' AND value = '' GROUP BY project_id
)
SELECT
    ec.project_id,
    ec.source,
    ec.row_count,
    (SELECT COUNT(*)::bigint FROM events e WHERE e.project_id = ec.project_id) AS event_count
FROM empty_content ec
JOIN blank_projects bp ON bp.project_id = ec.project_id
ORDER BY ec.project_id, ec.source;

\echo ''
\echo '=== 1b) DANGER totals — BLANK projects with any implicit-lane content ==='
\echo ''

WITH blank_projects AS (
    SELECT ps.project_id
    FROM project_settings ps
    WHERE NULLIF(BTRIM(ps.target_language), '') IS NULL
),
danger_projects AS (
    SELECT DISTINCT project_id
    FROM (
        SELECT project_id FROM cells WHERE target_lang = '' AND side = 'target'
        UNION
        SELECT project_id FROM assignments WHERE target_lang = ''
        UNION
        SELECT project_id FROM cell_validators WHERE target_lang = ''
        UNION
        SELECT project_id FROM file_section_progress WHERE target_lang = ''
        UNION
        SELECT project_id FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'target'
        UNION
        SELECT project_id FROM scene_briefs WHERE target_lang = ''
        UNION
        SELECT project_id FROM contextual_runs WHERE target_lang = ''
        UNION
        SELECT project_id FROM contextual_drafts WHERE target_lang = ''
        UNION
        SELECT project_id FROM project_member_scopes WHERE kind = 'lane' AND value = ''
    ) s
)
SELECT COUNT(*)::bigint AS blank_projects_with_implicit_lane_content
FROM blank_projects bp
JOIN danger_projects dp ON dp.project_id = bp.project_id;

-- ---------------------------------------------------------------------------
-- 2) QUARANTINE: COLLIDE / ARCHIVED-COLLIDE (PK merge risk, not auto-migrate)
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 2) QUARANTINE — COLLIDE / ARCHIVED-COLLIDE projects with '' content ==='
\echo ''

WITH project_lane_settings AS (
    SELECT
        ps.project_id,
        NULLIF(BTRIM(ps.target_language), '') AS resolved_tag,
        COALESCE(ps.target_lanes, '[]'::jsonb) AS target_lanes_json,
        COALESCE((ps.settings::jsonb)->'archivedLanes', '[]'::jsonb) AS archived_lanes_json
    FROM project_settings ps
),
project_class AS (
    SELECT
        pls.project_id,
        pls.resolved_tag,
        CASE
            WHEN pls.resolved_tag IS NULL THEN 'BLANK'
            WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(pls.target_lanes_json) AS tl(lane)
                WHERE LOWER(BTRIM(tl.lane)) = LOWER(pls.resolved_tag)
            ) THEN 'COLLIDE'
            WHEN EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(pls.archived_lanes_json) AS al(lane)
                WHERE LOWER(BTRIM(al.lane)) = LOWER(pls.resolved_tag)
            ) THEN 'ARCHIVED-COLLIDE'
            ELSE 'CLEAN'
        END AS migration_class
    FROM project_lane_settings pls
),
empty_cells AS (
    SELECT project_id, COUNT(*)::bigint AS empty_target_cells
    FROM cells WHERE target_lang = '' AND side = 'target'
    GROUP BY project_id
),
twin_cell_samples AS (
    SELECT
        c.project_id,
        COUNT(*)::bigint AS colliding_twin_target_cells
    FROM cells c
    JOIN project_class pc ON pc.project_id = c.project_id
    WHERE c.side = 'target'
      AND c.target_lang <> ''
      AND pc.migration_class IN ('COLLIDE', 'ARCHIVED-COLLIDE')
      AND LOWER(c.target_lang) = LOWER(pc.resolved_tag)
    GROUP BY c.project_id
)
SELECT
    pc.project_id,
    pc.migration_class,
    pc.resolved_tag,
    COALESCE(ec.empty_target_cells, 0) AS empty_target_cells_to_relabel,
    COALESCE(tcs.colliding_twin_target_cells, 0) AS existing_named_lane_target_cells,
    (SELECT COUNT(*)::bigint FROM events e WHERE e.project_id = pc.project_id) AS event_count
FROM project_class pc
LEFT JOIN empty_cells ec ON ec.project_id = pc.project_id
LEFT JOIN twin_cell_samples tcs ON tcs.project_id = pc.project_id
WHERE pc.migration_class IN ('COLLIDE', 'ARCHIVED-COLLIDE')
  AND COALESCE(ec.empty_target_cells, 0) > 0
ORDER BY COALESCE(ec.empty_target_cells, 0) DESC, pc.project_id;

-- ---------------------------------------------------------------------------
-- 3) AMBIGUOUS DEFAULT: multiple named targetLanes + implicit '' content
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 3) AMBIGUOUS DEFAULT — targetLanes length > 1 with implicit-lane rows ==='
\echo '    (more than one registered named lane; implicit default is especially risky)'
\echo ''

WITH multi_lane_projects AS (
    SELECT ps.project_id, COALESCE(jsonb_array_length(ps.target_lanes), 0) AS target_lanes_count
    FROM project_settings ps
    WHERE COALESCE(jsonb_array_length(ps.target_lanes), 0) > 1
),
per_project AS (
    SELECT
        mlp.project_id,
        mlp.target_lanes_count,
        (SELECT COUNT(*)::bigint FROM cells c
         WHERE c.project_id = mlp.project_id AND c.target_lang = '' AND c.side = 'target') AS empty_target_cells,
        (SELECT COUNT(*)::bigint FROM assignments a
         WHERE a.project_id = mlp.project_id AND a.target_lang = '') AS empty_assignments,
        (SELECT COUNT(*)::bigint FROM cell_validators cv
         WHERE cv.project_id = mlp.project_id AND cv.target_lang = '') AS empty_validators,
        (SELECT COUNT(*)::bigint FROM file_section_progress fsp
         WHERE fsp.project_id = mlp.project_id AND fsp.target_lang = '') AS empty_progress_rows,
        (SELECT COUNT(*)::bigint FROM scene_briefs sb
         WHERE sb.project_id = mlp.project_id AND sb.target_lang = '') AS empty_scene_briefs,
        (SELECT COUNT(*)::bigint FROM contextual_runs cr
         WHERE cr.project_id = mlp.project_id AND cr.target_lang = '') AS empty_contextual_runs,
        (SELECT COUNT(*)::bigint FROM contextual_drafts cd
         WHERE cd.project_id = mlp.project_id AND cd.target_lang = '') AS empty_contextual_drafts,
        (SELECT COUNT(*)::bigint FROM artifact_bindings ab
         WHERE ab.project_id = mlp.project_id AND ab.target_lang = '' AND ab.binding_role = 'target') AS empty_target_bindings,
        (SELECT COUNT(*)::bigint FROM project_member_scopes pms
         WHERE pms.project_id = mlp.project_id AND pms.kind = 'lane' AND pms.value = '') AS empty_lane_scopes
    FROM multi_lane_projects mlp
)
SELECT *
FROM per_project
WHERE (
    empty_target_cells + empty_assignments + empty_validators + empty_progress_rows
    + empty_scene_briefs + empty_contextual_runs + empty_contextual_drafts
    + empty_target_bindings + empty_lane_scopes
) > 0
ORDER BY empty_target_cells DESC, project_id;

\echo ''
\echo '=== 3b) Ambiguous-default grand total (projects) ==='
\echo ''

WITH multi_lane_projects AS (
    SELECT ps.project_id
    FROM project_settings ps
    WHERE COALESCE(jsonb_array_length(ps.target_lanes), 0) > 1
),
has_implicit AS (
    SELECT DISTINCT project_id FROM (
        SELECT project_id FROM cells WHERE target_lang = '' AND side = 'target'
        UNION SELECT project_id FROM assignments WHERE target_lang = ''
        UNION SELECT project_id FROM cell_validators WHERE target_lang = ''
        UNION SELECT project_id FROM file_section_progress WHERE target_lang = ''
        UNION SELECT project_id FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'target'
        UNION SELECT project_id FROM scene_briefs WHERE target_lang = ''
        UNION SELECT project_id FROM contextual_runs WHERE target_lang = ''
        UNION SELECT project_id FROM contextual_drafts WHERE target_lang = ''
        UNION SELECT project_id FROM project_member_scopes WHERE kind = 'lane' AND value = ''
    ) s
)
SELECT COUNT(*)::bigint AS ambiguous_default_projects
FROM multi_lane_projects m
JOIN has_implicit h ON h.project_id = m.project_id;

-- ---------------------------------------------------------------------------
-- 4) Per-project counts: target_lang='' rows TO RELABEL (migration targets)
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 4) Per-project — implicit-lane rows TO RELABEL (target_lang='''') ==='
\echo ''

WITH per_project AS (
    SELECT
        project_id,
        COUNT(*) FILTER (WHERE target_lang = '' AND side = 'target')::bigint AS cells_target,
        0::bigint AS cells_source_must_not_touch,
        0::bigint AS cell_validators,
        0::bigint AS file_section_progress,
        0::bigint AS assignments,
        0::bigint AS artifact_bindings_target,
        0::bigint AS scene_briefs,
        0::bigint AS contextual_runs,
        0::bigint AS contextual_drafts,
        0::bigint AS lane_scopes
    FROM cells
    GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, COUNT(*)::bigint, 0, 0, 0, 0, 0, 0, 0
    FROM cell_validators WHERE target_lang = '' GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, 0, COUNT(*)::bigint, 0, 0, 0, 0, 0, 0
    FROM file_section_progress WHERE target_lang = '' GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, 0, 0, COUNT(*)::bigint, 0, 0, 0, 0, 0
    FROM assignments WHERE target_lang = '' GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, 0, 0, 0, COUNT(*)::bigint, 0, 0, 0, 0
    FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'target' GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, 0, 0, 0, 0, COUNT(*)::bigint, 0, 0, 0
    FROM scene_briefs WHERE target_lang = '' GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, 0, 0, 0, 0, 0, COUNT(*)::bigint, 0, 0
    FROM contextual_runs WHERE target_lang = '' GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, 0, 0, 0, 0, 0, 0, COUNT(*)::bigint, 0
    FROM contextual_drafts WHERE target_lang = '' GROUP BY project_id

    UNION ALL

    SELECT project_id, 0, 0, 0, 0, 0, 0, 0, 0, 0, COUNT(*)::bigint
    FROM project_member_scopes WHERE kind = 'lane' AND value = '' GROUP BY project_id
),
rolled AS (
    SELECT
        project_id,
        SUM(cells_target) AS cells_target,
        SUM(cell_validators) AS cell_validators,
        SUM(file_section_progress) AS file_section_progress,
        SUM(assignments) AS assignments,
        SUM(artifact_bindings_target) AS artifact_bindings_target,
        SUM(scene_briefs) AS scene_briefs,
        SUM(contextual_runs) AS contextual_runs,
        SUM(contextual_drafts) AS contextual_drafts,
        SUM(lane_scopes) AS lane_scopes
    FROM per_project
    GROUP BY project_id
)
SELECT
    r.*,
    (
        r.cells_target + r.cell_validators + r.file_section_progress + r.assignments
        + r.artifact_bindings_target + r.scene_briefs + r.contextual_runs
        + r.contextual_drafts + r.lane_scopes
    ) AS total_to_relabel
FROM rolled r
WHERE (
    r.cells_target + r.cell_validators + r.file_section_progress + r.assignments
    + r.artifact_bindings_target + r.scene_briefs + r.contextual_runs
    + r.contextual_drafts + r.lane_scopes
) > 0
ORDER BY total_to_relabel DESC, project_id;

-- ---------------------------------------------------------------------------
-- 5) Per-project counts: source-side '' rows that MUST NOT be relabeled
--    (migration 0057: source rows are always '' — not lane-addressable)
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 5) Per-project — source-side cells with target_lang='''' (MUST NOT TOUCH) ==='
\echo ''

SELECT
    project_id,
    COUNT(*)::bigint AS source_cells_target_lang_empty
FROM cells
WHERE target_lang = '' AND side = 'source'
GROUP BY project_id
HAVING COUNT(*) > 0
ORDER BY source_cells_target_lang_empty DESC, project_id;

\echo ''
\echo '=== 5b) artifact_bindings with target_lang='''' by binding_role (no side column) ==='
\echo '    binding_role=source rows with '''' are NOT lane-addressable — leave alone'
\echo ''

SELECT
    project_id,
    binding_role,
    COUNT(*)::bigint AS row_count
FROM artifact_bindings
WHERE target_lang = ''
GROUP BY project_id, binding_role
HAVING COUNT(*) > 0
ORDER BY project_id, binding_role;

-- ---------------------------------------------------------------------------
-- 6) RECONCILIATION — per table, target_lang='''' split by side/role where applicable
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 6) RECONCILIATION — target_lang='''' row counts by table (grand totals) ==='
\echo ''

SELECT *
FROM (
    SELECT
        1 AS sort_key,
        'cells' AS table_name,
        side::text AS partition_key,
        'has side column' AS partition_note,
        COUNT(*)::bigint AS row_count
    FROM cells
    WHERE target_lang = ''
    GROUP BY side

    UNION ALL

    -- file_section_progress: target-only projection; no side column (schema.sql:545)
    SELECT
        2,
        'file_section_progress',
        '(all rows)',
        'no side column — table is target-lane-keyed only',
        COUNT(*)::bigint
    FROM file_section_progress
    WHERE target_lang = ''

    UNION ALL

    SELECT 3, 'cell_validators', '(all rows)', 'no side column — target-only', COUNT(*)::bigint
    FROM cell_validators WHERE target_lang = ''

    UNION ALL

    SELECT 4, 'assignments', '(all rows)', 'no side column — target-only', COUNT(*)::bigint
    FROM assignments WHERE target_lang = ''

    UNION ALL

    SELECT
        5,
        'artifact_bindings',
        binding_role,
        'no side column — use binding_role; only target role is migrated',
        COUNT(*)::bigint
    FROM artifact_bindings
    WHERE target_lang = ''
    GROUP BY binding_role

    UNION ALL

    SELECT 6, 'scene_briefs', '(all rows)', 'no side column — target-only', COUNT(*)::bigint
    FROM scene_briefs WHERE target_lang = ''

    UNION ALL

    SELECT 7, 'contextual_runs', '(all rows)', 'no side column — target-only', COUNT(*)::bigint
    FROM contextual_runs WHERE target_lang = ''

    UNION ALL

    SELECT 8, 'contextual_drafts', '(all rows)', 'no side column — target-only', COUNT(*)::bigint
    FROM contextual_drafts WHERE target_lang = ''

    UNION ALL

    SELECT 9, 'project_member_scopes', 'kind=lane', 'uses value column, not target_lang', COUNT(*)::bigint
    FROM project_member_scopes WHERE kind = 'lane' AND value = ''
) reconciliation
ORDER BY sort_key, partition_key;

\echo ''
\echo '=== 6b) RECONCILIATION — per-project cells target_lang='''' by side ==='
\echo ''

SELECT
    project_id,
    side,
    COUNT(*)::bigint AS row_count
FROM cells
WHERE target_lang = ''
GROUP BY project_id, side
ORDER BY project_id, side;

\echo ''
\echo '=== 6c) RECONCILIATION summary — migration must touch ONLY target partitions ==='
\echo ''

SELECT
    'cells side=target (RELABEL)' AS bucket,
    COUNT(*)::bigint AS row_count
FROM cells WHERE target_lang = '' AND side = 'target'
UNION ALL
SELECT 'cells side=source (LEAVE ALONE)', COUNT(*)::bigint
FROM cells WHERE target_lang = '' AND side = 'source'
UNION ALL
SELECT 'cells other side with target_lang empty', COUNT(*)::bigint
FROM cells WHERE target_lang = '' AND side NOT IN ('source', 'target')
UNION ALL
SELECT 'artifact_bindings binding_role=target (RELABEL)', COUNT(*)::bigint
FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'target'
UNION ALL
SELECT 'artifact_bindings binding_role=source (LEAVE ALONE)', COUNT(*)::bigint
FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'source'
UNION ALL
SELECT 'artifact_bindings other binding_role with target_lang empty', COUNT(*)::bigint
FROM artifact_bindings WHERE target_lang = '' AND binding_role NOT IN ('source', 'target')
ORDER BY bucket;

-- ---------------------------------------------------------------------------
-- 7) Grand totals — relabel vs must-not-touch
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== 7) GRAND TOTALS ==='
\echo ''

SELECT 'TO RELABEL' AS category, 'cells (side=target)' AS detail, COUNT(*)::bigint AS row_count
FROM cells WHERE target_lang = '' AND side = 'target'
UNION ALL
SELECT 'TO RELABEL', 'cell_validators', COUNT(*)::bigint FROM cell_validators WHERE target_lang = ''
UNION ALL
SELECT 'TO RELABEL', 'file_section_progress (recompute preferred over UPDATE)', COUNT(*)::bigint
FROM file_section_progress WHERE target_lang = ''
UNION ALL
SELECT 'TO RELABEL', 'assignments', COUNT(*)::bigint FROM assignments WHERE target_lang = ''
UNION ALL
SELECT 'TO RELABEL', 'artifact_bindings (binding_role=target)', COUNT(*)::bigint
FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'target'
UNION ALL
SELECT 'TO RELABEL', 'scene_briefs', COUNT(*)::bigint FROM scene_briefs WHERE target_lang = ''
UNION ALL
SELECT 'TO RELABEL', 'contextual_runs', COUNT(*)::bigint FROM contextual_runs WHERE target_lang = ''
UNION ALL
SELECT 'TO RELABEL', 'contextual_drafts', COUNT(*)::bigint FROM contextual_drafts WHERE target_lang = ''
UNION ALL
SELECT 'TO RELABEL', 'project_member_scopes (kind=lane, value empty)', COUNT(*)::bigint
FROM project_member_scopes WHERE kind = 'lane' AND value = ''
UNION ALL
SELECT 'MUST NOT TOUCH', 'cells (side=source)', COUNT(*)::bigint
FROM cells WHERE target_lang = '' AND side = 'source'
UNION ALL
SELECT 'MUST NOT TOUCH', 'artifact_bindings (binding_role=source)', COUNT(*)::bigint
FROM artifact_bindings WHERE target_lang = '' AND binding_role = 'source'
ORDER BY category, detail;

\echo ''
\echo '=== AQU-1240 pre-flight audit complete ==='
\echo ''
