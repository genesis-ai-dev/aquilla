-- 0191_edit_histories.sql — decision 11: the undo history follows the person.
--
-- Each person keeps ONE undo history per project, whatever language they are
-- in, and it goes with them to any computer or browser. Until now it lived
-- only in the browser's IndexedDB. This table is the server's copy: one row
-- per (project, person), holding the history as the client's JSON document
-- (both stacks, the skip log and the tombstones of steps that left for good)
-- and a revision number.
--
-- The revision is the whole concurrency story. A write names the revision it
-- was built on; a write built on an older one is refused (409) with the
-- current copy, and the client merges the two step by step and writes again
-- (src/lib/history/history-merge.ts). Two devices writing at once therefore
-- never lose each other's steps. The server never reads the document.
--
-- Rows are written and read only by auth-worker's /edit-history route, for
-- the signed-in person's own row. Nothing else reads it, so it gets no RLS
-- policy and is listed in scripts/rls-coverage.test.ts's UNCOVERED map.
--
-- Idempotent and additive. (Renumbered after dev took 0185–0187.)

CREATE TABLE IF NOT EXISTS edit_histories (
    project_id  TEXT    NOT NULL,
    user_id     BIGINT  NOT NULL,
    revision    INTEGER NOT NULL,
    history     TEXT    NOT NULL,
    updated_at  BIGINT  NOT NULL,
    PRIMARY KEY (project_id, user_id)
);
