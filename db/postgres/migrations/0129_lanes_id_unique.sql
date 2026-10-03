-- 0129_lanes_id_unique.sql — AQU-1606
--
-- Lane ids are opaque 8-hex values minted by the app
-- (src/lib/lanes/lane-id.ts). They were unique only inside a project, because
-- the primary key is (project_id, id). That key stays: every composite
-- foreign key (project_id, lane_id) -> lanes(project_id, id) still needs it.
-- This index is additional, so one id cannot belong to two projects.
--
-- A plain CREATE UNIQUE INDEX, same as the other indexes on this table
-- (0096). `lanes` is a few rows per project, so the lock is short. If two
-- rows already share an id the statement aborts; that collision is resolved
-- by hand, not collapsed.
--
-- Idempotent: IF NOT EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS uq_lanes_id
    ON lanes(id);
