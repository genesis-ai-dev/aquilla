-- 0022_assignments.sql — manager work assignment (assign a book/chapter scope
-- to a member; slice 1 of Phase C "Assignment & accountability").
--
-- Projected from the project-level `assignment.*` event family
-- (assignment.create / .reassign / .unassign) by sync-worker's
-- handlers/assignment-events.ts. Like comments, these events carry a fileId on
-- the envelope (auth/routing) but their semantics are project-level — the
-- assigned scope lives in the payload and is resolved into assignment_cells.
--
-- Design decisions:
--   - assignment_cells materializes the resolved source-cell set at create
--     time, so cells_total is a stable denominator and progress is a cheap
--     JOIN against the live cells projection (derived on read — slice 1 never
--     touches the hot cell.commit path).
--   - timestamps are INTEGER unix-ms (matches events.server_ts + the comments
--     table); `deadline` is a TEXT ISO date string (matches projects.deadline_at).
--   - unassigned_at NULL = active; completed_at reserved for the deferred
--     server-emitted assignment.complete.

CREATE TABLE IF NOT EXISTS assignments (
  assignment_id    TEXT    PRIMARY KEY,
  project_id       TEXT    NOT NULL,
  assignee_user_id INTEGER NOT NULL,
  scope_kind       TEXT    NOT NULL,            -- 'books' | 'chapters'
  scope_label      TEXT    NOT NULL,            -- human label, e.g. "Genesis 1-3"
  cells_total      INTEGER NOT NULL DEFAULT 0,  -- resolved source-cell count
  deadline         TEXT,                        -- ISO date string; nullable
  note             TEXT,                        -- optional instruction; nullable
  created_by       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,            -- unix ms
  unassigned_at    INTEGER,                     -- unix ms; NULL = active
  completed_at     INTEGER                      -- unix ms; reserved (deferred .complete)
);

-- Manager workload rollup: all assignments in a project / for an assignee.
CREATE INDEX IF NOT EXISTS assignments_project  ON assignments(project_id);
CREATE INDEX IF NOT EXISTS assignments_assignee ON assignments(assignee_user_id);

CREATE TABLE IF NOT EXISTS assignment_cells (
  assignment_id TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  cell_id       TEXT NOT NULL,
  PRIMARY KEY (assignment_id, file_id, cell_id),
  FOREIGN KEY (assignment_id) REFERENCES assignments(assignment_id) ON DELETE CASCADE
);

-- Progress derivation: count this assignment's cells that are validated by
-- joining assignment_cells -> cells on (file_id, cell_id).
CREATE INDEX IF NOT EXISTS assignment_cells_by_assignment ON assignment_cells(assignment_id);
