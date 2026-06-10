// Canonical `events` INSERT — the ONLY way an event row may be written.
//
// server_seq allocation (audit RACE-1 / PERF-5, task M1-1):
//   The old per-statement `COALESCE((SELECT MAX(server_seq) …), 0) + 1` was
//   race-unsafe: two concurrent same-project transactions computed the same
//   N+1 under READ COMMITTED, and the loser's unique-index collision on
//   idx_events_project_seq was swallowed by an UNQUALIFIED `ON CONFLICT DO
//   NOTHING` — the event-log row silently vanished while its cells projection
//   still committed (cells.event_id → ghost event).
//
//   Now every insert bumps a per-project counter row INSIDE the same
//   statement/transaction (`bump` CTE). The first bump in a transaction takes
//   the counter's row lock, so concurrent same-project writers serialize on
//   it and can never allocate the same seq; different projects don't contend.
//
//   - Seeding: the VALUES arm initializes the row from MAX(events.server_seq)
//     the first time a project writes after this deploy.
//   - Self-healing: if the counter ever falls behind the log (e.g. rows
//     written by a pre-allocator worker during a rolling deploy), the
//     GREATEST against the freshly computed EXCLUDED seed jumps it past the
//     log max in one statement instead of colliding.
//   - `ON CONFLICT (id) DO NOTHING` is qualified to the PK: only true
//     idempotent id-replays are skipped. Any other unique violation (e.g. a
//     seq collision, which the allocator makes impossible by construction)
//     now fails the transaction LOUDLY instead of dropping the row.
//   - Gaps: an id-replay still consumes a seq (the CTE runs, the row is
//     dropped). Harmless — server_seq is an ordering key, not a count — and
//     rare: POST /events pre-checks idempotency before building statements.

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'

/** Minimal event shape needed to write the canonical `events` row. */
export interface EventInsertRow {
  id: string
  schemaVersion: number
  projectId: string
  fileId: string | null
  cellId: string | null
  parentId: string | null
  kind: string
  author: string
  /** Already-serialized JSON payload. */
  payloadJson: string
  clientTs: number
  serverTs: number
}

export const EVENT_INSERT_SQL = `WITH bump AS (
  INSERT INTO project_seq_counters (project_id, last_seq)
  VALUES (?, COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + 1)
  ON CONFLICT (project_id) DO UPDATE SET
    last_seq = GREATEST(project_seq_counters.last_seq + 1, excluded.last_seq)
  RETURNING last_seq
)
INSERT INTO events (
  id, schema_version, project_id, file_id, cell_id, parent_id, kind,
  author, payload, client_ts, server_ts, server_seq
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, last_seq FROM bump
ON CONFLICT (id) DO NOTHING`

/** Build the canonical events INSERT statement for one event. */
export function buildEventInsertStmt(db: AquillaDb, e: EventInsertRow): AquillaStatement {
  return db
    .prepare(EVENT_INSERT_SQL)
    .bind(
      e.projectId,
      e.projectId,
      e.id,
      e.schemaVersion,
      e.projectId,
      e.fileId,
      e.cellId,
      e.parentId,
      e.kind,
      e.author,
      e.payloadJson,
      e.clientTs,
      e.serverTs,
    )
}
