-- =============================================================================
-- AQU-1240 LIGHTWEIGHT pre-flight audit (low-lock, prod/replica friendly)
-- =============================================================================
--
-- Why this exists
--   The full audit (aqu-1240-default-lane-preflight.sql) does per-project rollups,
--   cross-table UNION DISTINCTs and large sorts. On a busy primary those scans can
--   feel like an outage ("it's not responding"). This version returns the SAME
--   headline metrics with the cheapest possible shape, split into a near-instant
--   part and a heavier part you can point at a replica or the dev copy.
--
-- Safety
--   STRICTLY READ-ONLY (SELECT only). Timeouts abort rather than block writers.
--   Every result set is (metric, value) so it drops into the same tooling that
--   produced the JSON we already have.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/postgres/audits/aqu-1240-lightweight.sql
--   (Part A is safe anywhere. Part B: prefer a read replica or the dev copy.)
-- =============================================================================

-- Never let this hold anything up. Fail fast instead.
SET statement_timeout = '60s';
SET lock_timeout      = '2s';
SET idle_in_transaction_session_timeout = '10s';

-- -----------------------------------------------------------------------------
-- PART A — classification + BLANK naming buckets
-- Cost: touches only project_settings (~one row per project). Safe on the primary.
-- -----------------------------------------------------------------------------
\echo ''
\echo '=== PART A) classification (cheap — project_settings only) ==='
\echo ''

WITH s AS (
    SELECT
        ps.project_id,
        NULLIF(BTRIM(ps.target_language), '')                      AS tag,
        COALESCE(jsonb_array_length(ps.target_lanes), 0)           AS n_lanes,
        COALESCE(ps.target_lanes, '[]'::jsonb)                     AS lanes_json,
        COALESCE((ps.settings::jsonb)->'archivedLanes', '[]'::jsonb) AS archived_json
    FROM project_settings ps
),
c AS (
    SELECT
        s.*,
        CASE
            WHEN s.tag IS NULL THEN 'BLANK'
            WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.lanes_json) x
                         WHERE LOWER(BTRIM(x)) = LOWER(s.tag))     THEN 'COLLIDE'
            WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.archived_json) x
                         WHERE LOWER(BTRIM(x)) = LOWER(s.tag))     THEN 'ARCHIVED-COLLIDE'
            ELSE 'CLEAN'
        END AS class
    FROM s
)
SELECT metric, value FROM (
    VALUES
      (1, 'total projects',                                   (SELECT COUNT(*)                                   FROM c)),
      (2, 'CLEAN projects',                                   (SELECT COUNT(*) FILTER (WHERE class='CLEAN')       FROM c)),
      (3, 'BLANK projects',                                   (SELECT COUNT(*) FILTER (WHERE class='BLANK')       FROM c)),
      (4, 'COLLIDE projects',                                 (SELECT COUNT(*) FILTER (WHERE class='COLLIDE')     FROM c)),
      (5, 'ARCHIVED-COLLIDE projects',                        (SELECT COUNT(*) FILTER (WHERE class='ARCHIVED-COLLIDE') FROM c)),
      -- How much of the BLANK pile can we auto-name vs. must placeholder?
      (6, 'BLANK w/ exactly 1 named lane (AUTO-NAMEABLE)',    (SELECT COUNT(*) FILTER (WHERE class='BLANK' AND n_lanes=1) FROM c)),
      (7, 'BLANK w/ 0 named lanes (PLACEHOLDER needed)',      (SELECT COUNT(*) FILTER (WHERE class='BLANK' AND n_lanes=0) FROM c)),
      (8, 'BLANK w/ >1 named lanes (human picks name)',       (SELECT COUNT(*) FILTER (WHERE class='BLANK' AND n_lanes>1) FROM c)),
      (9, 'multi-lane projects (targetLanes > 1, any class)', (SELECT COUNT(*) FILTER (WHERE n_lanes>1)           FROM c))
) AS t(ord, metric, value)
ORDER BY ord;

-- -----------------------------------------------------------------------------
-- PART B — row volumes (the batched backfill workload + must-not-touch)
-- Cost: scans the content tables. `cells` is the big one; scanned ONCE via a CTE.
-- Prefer a replica or the dev copy. The timeouts above make it abort, not block.
-- -----------------------------------------------------------------------------
\echo ''
\echo '=== PART B) row volumes (heavier — prefer replica/dev) ==='
\echo ''

WITH cells_empty AS (   -- single pass over the target_lang='' slice of cells
    SELECT
        COUNT(*) FILTER (WHERE side = 'target')                        AS relabel_cells_target,
        COUNT(*) FILTER (WHERE side = 'source')                        AS keep_cells_source,
        COUNT(DISTINCT project_id) FILTER (WHERE side = 'target')      AS projects_with_target_empty
    FROM cells
    WHERE target_lang = ''
)
SELECT metric, value FROM (
    VALUES
      -- RELABEL targets (get a lane_id in the additive backfill)
      ( 1, 'RELABEL cells (side=target)',              (SELECT relabel_cells_target FROM cells_empty)),
      ( 2, 'RELABEL cell_validators',                  (SELECT COUNT(*) FROM cell_validators       WHERE target_lang='')),
      ( 3, 'RELABEL file_section_progress',            (SELECT COUNT(*) FROM file_section_progress WHERE target_lang='')),
      ( 4, 'RELABEL assignments',                      (SELECT COUNT(*) FROM assignments           WHERE target_lang='')),
      ( 5, 'RELABEL artifact_bindings (role=target)',  (SELECT COUNT(*) FROM artifact_bindings     WHERE target_lang='' AND binding_role='target')),
      ( 6, 'RELABEL scene_briefs',                     (SELECT COUNT(*) FROM scene_briefs          WHERE target_lang='')),
      ( 7, 'RELABEL contextual_runs',                  (SELECT COUNT(*) FROM contextual_runs       WHERE target_lang='')),
      ( 8, 'RELABEL contextual_drafts',                (SELECT COUNT(*) FROM contextual_drafts     WHERE target_lang='')),
      ( 9, 'RELABEL project_member_scopes (kind=lane)',(SELECT COUNT(*) FROM project_member_scopes WHERE kind='lane' AND value='')),
      -- MUST NOT TOUCH (source side — the guard that protects these)
      (10, 'MUST NOT TOUCH cells (side=source)',       (SELECT keep_cells_source FROM cells_empty)),
      (11, 'MUST NOT TOUCH artifact_bindings (role=source)', (SELECT COUNT(*) FROM artifact_bindings WHERE target_lang='' AND binding_role='source')),
      -- Project intersections (approx — uses cells only, which dominate)
      (12, 'projects with any '''' target cell',       (SELECT projects_with_target_empty FROM cells_empty)),
      (13, 'DANGER: BLANK projects w/ '''' target cells',
            (SELECT COUNT(DISTINCT c.project_id) FROM cells c
             WHERE c.target_lang='' AND c.side='target'
               AND c.project_id IN (SELECT project_id FROM project_settings
                                    WHERE NULLIF(BTRIM(target_language),'') IS NULL))),
      (14, 'AMBIGUOUS: multi-lane projects w/ '''' target cells',
            (SELECT COUNT(DISTINCT c.project_id) FROM cells c
             WHERE c.target_lang='' AND c.side='target'
               AND c.project_id IN (SELECT project_id FROM project_settings
                                    WHERE COALESCE(jsonb_array_length(target_lanes),0) > 1)))
) AS t(ord, metric, value)
ORDER BY ord;

\echo ''
\echo '=== AQU-1240 lightweight audit complete ==='
\echo ''
