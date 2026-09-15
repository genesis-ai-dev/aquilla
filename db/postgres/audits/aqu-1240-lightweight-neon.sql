-- =============================================================================
-- AQU-1240 LIGHTWEIGHT pre-flight audit — NEON SQL EDITOR version
-- =============================================================================
-- Read-only. One result set of (metric, value), so it drops straight into
-- Neon's GUI and returns a single grid (no psql meta-commands).
--
-- The two SET lines make it abort rather than block writers; run them together
-- with the query. If the editor insists on a single statement, delete the two
-- SET lines (it stays read-only either way) or run them once first.
--
-- Prefer running on the dev branch (it mirrors prod) to keep all load off prod.
-- =============================================================================

SET statement_timeout = '60s';
SET lock_timeout      = '2s';

WITH s AS (
    SELECT
        ps.project_id,
        NULLIF(BTRIM(ps.target_language), '')                        AS tag,
        COALESCE(jsonb_array_length(ps.target_lanes), 0)             AS n_lanes,
        COALESCE(ps.target_lanes, '[]'::jsonb)                       AS lanes_json,
        COALESCE((ps.settings::jsonb)->'archivedLanes', '[]'::jsonb) AS archived_json
    FROM project_settings ps
),
c AS (
    SELECT
        s.*,
        CASE
            WHEN s.tag IS NULL THEN 'BLANK'
            WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.lanes_json) x
                         WHERE LOWER(BTRIM(x)) = LOWER(s.tag))       THEN 'COLLIDE'
            WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.archived_json) x
                         WHERE LOWER(BTRIM(x)) = LOWER(s.tag))       THEN 'ARCHIVED-COLLIDE'
            ELSE 'CLEAN'
        END AS class
    FROM s
),
cells_empty AS (              -- single pass over the target_lang='' slice of cells
    SELECT
        COUNT(*) FILTER (WHERE side = 'target') AS relabel_cells_target,
        COUNT(*) FILTER (WHERE side = 'source') AS keep_cells_source
    FROM cells
    WHERE target_lang = ''
),
tgt_projects AS (             -- projects that own at least one '' target cell (reused 3x)
    SELECT DISTINCT project_id
    FROM cells
    WHERE target_lang = '' AND side = 'target'
)
SELECT metric, value
FROM (
    VALUES
      -- classification (cheap — project_settings only)
      ( 1, 'total projects',                                    (SELECT COUNT(*)                                       FROM c)),
      ( 2, 'CLEAN projects',                                    (SELECT COUNT(*) FILTER (WHERE class='CLEAN')           FROM c)),
      ( 3, 'BLANK projects (no target_language)',               (SELECT COUNT(*) FILTER (WHERE class='BLANK')           FROM c)),
      ( 4, 'COLLIDE projects (tag matches a live lane)',        (SELECT COUNT(*) FILTER (WHERE class='COLLIDE')         FROM c)),
      ( 5, 'ARCHIVED-COLLIDE projects (tag matches archived)',  (SELECT COUNT(*) FILTER (WHERE class='ARCHIVED-COLLIDE') FROM c)),
      ( 6, 'BLANK w/ exactly 1 named lane (AUTO-NAMEABLE)',     (SELECT COUNT(*) FILTER (WHERE class='BLANK' AND n_lanes=1) FROM c)),
      ( 7, 'BLANK w/ 0 named lanes (PLACEHOLDER needed)',       (SELECT COUNT(*) FILTER (WHERE class='BLANK' AND n_lanes=0) FROM c)),
      ( 8, 'BLANK w/ >1 named lanes (human picks name)',        (SELECT COUNT(*) FILTER (WHERE class='BLANK' AND n_lanes>1) FROM c)),
      ( 9, 'multi-lane projects (targetLanes > 1, any class)',  (SELECT COUNT(*) FILTER (WHERE n_lanes>1)               FROM c)),
      -- row volumes (the batched backfill workload)
      (10, 'RELABEL cells (side=target)',                       (SELECT relabel_cells_target FROM cells_empty)),
      (11, 'RELABEL cell_validators',                           (SELECT COUNT(*) FROM cell_validators       WHERE target_lang='')),
      (12, 'RELABEL file_section_progress',                     (SELECT COUNT(*) FROM file_section_progress WHERE target_lang='')),
      (13, 'RELABEL assignments',                               (SELECT COUNT(*) FROM assignments           WHERE target_lang='')),
      (14, 'RELABEL artifact_bindings (binding_role=target)',   (SELECT COUNT(*) FROM artifact_bindings     WHERE target_lang='' AND binding_role='target')),
      (15, 'RELABEL scene_briefs',                              (SELECT COUNT(*) FROM scene_briefs          WHERE target_lang='')),
      (16, 'RELABEL contextual_runs',                           (SELECT COUNT(*) FROM contextual_runs       WHERE target_lang='')),
      (17, 'RELABEL contextual_drafts',                         (SELECT COUNT(*) FROM contextual_drafts     WHERE target_lang='')),
      (18, 'RELABEL project_member_scopes (kind=lane)',         (SELECT COUNT(*) FROM project_member_scopes WHERE kind='lane' AND value='')),
      -- must-not-touch (the source-side guard protects these)
      (19, 'MUST NOT TOUCH cells (side=source)',                (SELECT keep_cells_source FROM cells_empty)),
      (20, 'MUST NOT TOUCH artifact_bindings (binding_role=source)', (SELECT COUNT(*) FROM artifact_bindings WHERE target_lang='' AND binding_role='source')),
      -- project intersections (approx — cells only, which dominate)
      (21, 'DANGER: BLANK projects w/ '''' target cells',       (SELECT COUNT(*) FROM tgt_projects tp JOIN c ON c.project_id=tp.project_id WHERE c.class='BLANK')),
      (22, 'CLEAN projects w/ '''' target cells (auto-migrate)', (SELECT COUNT(*) FROM tgt_projects tp JOIN c ON c.project_id=tp.project_id WHERE c.class='CLEAN')),
      (23, 'AMBIGUOUS: multi-lane projects w/ '''' target cells',(SELECT COUNT(*) FROM tgt_projects tp JOIN c ON c.project_id=tp.project_id WHERE c.n_lanes>1))
) AS t(ord, metric, value)
ORDER BY ord;
