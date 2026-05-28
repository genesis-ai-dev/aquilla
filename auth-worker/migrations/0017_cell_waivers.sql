-- 0017_cell_waivers.sql
-- Durable per-cell QA rule waivers (AD-2 waiver grammar).
--
-- Re-establishes the rule-waiver state that Phase 2c-γ removed when waivers
-- stopped being written to the per-file Y.Doc. Now projected from the
-- append-only event log. One row per (cell, rule): a row exists iff that QA
-- rule's infraction is currently dismissed on that cell (DELETE-on-unwaive,
-- mirroring cell_validators).
--
-- Written by the cell.waive / cell.unwaive event kinds
-- (apps/sync src/events/event-projection.ts). Read per-file alongside
-- validators via GET /cells/audit-stats?fileId=.
--
-- This is a read projection regenerable from `events`, so no backfill — the
-- sync worker re-projects on next write / rebuild.

CREATE TABLE cell_waivers (
    project_id  TEXT    NOT NULL,
    file_id     TEXT    NOT NULL,
    cell_id     TEXT    NOT NULL,
    rule_id     TEXT    NOT NULL,           -- the dismissed QA rule
    reason      TEXT,                        -- optional human-entered justification
    waived_by   TEXT    NOT NULL,           -- the user who waived
    waived_ts   INTEGER NOT NULL,           -- server clock; out-of-order replay guard
    PRIMARY KEY (project_id, file_id, cell_id, rule_id)
) STRICT;

-- Per-file read (the editor pulls every live waiver at once with audit stats).
CREATE INDEX idx_cell_waivers_file ON cell_waivers(project_id, file_id);
