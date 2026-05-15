-- Migration: 0002_events_ad2.sql
-- Description: Reshape the `events` table for AD-2 (parent-chain rule) and
--   AD-9 (linked-target projects). Adds two new columns to every event:
--     - parent_id  — UUIDv7 of the prior winning event on this cell's chain
--                    (`(project_id, file_id, cell_id)`). NULL only for genesis
--                    events. The projection's first-child-wins guard reads
--                    this column.
--     - server_seq — per-project monotonic sequence assigned on accept.
--                    Replaces `server_ts` as the canonical ordering key for
--                    deterministic tiebreaks across siblings.
--
--   Plus a unique index that enforces `server_seq` monotonicity per project,
--   and a parent-lookup index that powers the projection's AD-2 first-child
--   check (`SELECT 1 FROM events WHERE project_id = ? AND file_id = ?
--    AND cell_id = ? AND parent_id = ?`).
--
-- Backfill strategy: existing rows have NULL parent_id (no prior chain
-- to derive from) and a server_seq derived from server_ts ordering. With
-- no production users (project_no_users_yet), the backfill is for
-- developer staging consistency only.

ALTER TABLE events ADD COLUMN parent_id TEXT;
ALTER TABLE events ADD COLUMN server_seq INTEGER NOT NULL DEFAULT 0;

-- Backfill server_seq monotonically per project, ordered by server_ts.
-- ROW_NUMBER() is a window function. The UPDATE-via-FROM-subquery pattern
-- below is SQLite-compatible.
UPDATE events
SET server_seq = (
    SELECT rn
    FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY project_id
            ORDER BY server_ts, id
        ) AS rn
        FROM events
    ) ranked
    WHERE ranked.id = events.id
);

-- Per-project monotonic ordering. UNIQUE so a duplicate seq within a
-- project (a bug in the assignment path) raises immediately.
CREATE UNIQUE INDEX idx_events_project_seq ON events(project_id, server_seq);

-- Powers AD-2's first-child-of-parent check at projection time. Before
-- applying an event the projector reads:
--   SELECT 1 FROM events
--    WHERE project_id = ? AND file_id = ? AND cell_id = ? AND parent_id = ?
--   ORDER BY server_seq ASC LIMIT 1
-- to find the existing winning child (if any). When this query returns the
-- candidate event's own id, it is the winner; otherwise it's a stale sibling.
CREATE INDEX idx_events_parent_lookup
    ON events(project_id, file_id, cell_id, parent_id);
