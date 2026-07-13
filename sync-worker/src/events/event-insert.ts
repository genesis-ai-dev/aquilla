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

// ---------------------------------------------------------------------------
// Bulk variant (POST /import fast path)
// ---------------------------------------------------------------------------
//
// The per-event CTE above costs one DB round trip per event; through the
// Postgres shim a 1500-cell chunk became ~3000 sequential round trips
// (~30ms each ≈ 100s/book — AQU-310 follow-up). Bulk imports instead
// allocate the whole seq block in ONE counter bump, then write all rows in
// multi-row INSERTs with explicit seqs.
//
// Race-safety is the same property as the single-row CTE: the counter row's
// lock serializes concurrent same-project allocators, so blocks never
// overlap, and seqs handed out here are ≤ the counter — any later writer
// (bulk or per-event) allocates strictly above. Replays consume a block and
// drop the rows on ON CONFLICT (id) — seq gaps, harmless by design (see
// header note on gaps).

const SEQ_RANGE_ALLOC_SQL = `INSERT INTO project_seq_counters (project_id, last_seq)
VALUES (?, COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + ?)
ON CONFLICT (project_id) DO UPDATE SET
  last_seq = GREATEST(project_seq_counters.last_seq + ?, excluded.last_seq)
RETURNING last_seq`

/** Atomically allocate `n` consecutive server_seqs for a project; returns the
 *  FIRST seq of the block (rows get base, base+1, …, base+n-1). */
export async function allocateSeqRange(
  db: AquillaDb,
  projectId: string,
  n: number,
): Promise<number> {
  if (n <= 0) throw new Error(`allocateSeqRange: n must be positive, got ${n}`)
  const last = await db
    .prepare(SEQ_RANGE_ALLOC_SQL)
    .bind(projectId, projectId, n, n)
    .first<number>('last_seq')
  if (last == null) throw new Error('allocateSeqRange: counter bump returned no row')
  return Number(last) - n + 1
}

/** One pre-allocated seq per row (from allocateSeqRange). */
export type SeqEventInsertRow = EventInsertRow & { serverSeq: number }

const EVENT_COLS = 12

/** Multi-row events INSERT with explicit pre-allocated server_seqs. Rows are
 *  byte-identical to buildEventInsertStmt's; ON CONFLICT (id) DO NOTHING keeps
 *  the same qualified idempotency (duplicate ids within one statement are
 *  silently dropped, matching sequential replay semantics). */
export function buildBulkEventInsertStmt(db: AquillaDb, rows: SeqEventInsertRow[]): AquillaStatement {
  if (rows.length === 0) throw new Error('buildBulkEventInsertStmt: empty rows')
  const placeholders = Array(rows.length)
    .fill(`(${Array(EVENT_COLS).fill('?').join(', ')})`)
    .join(',\n')
  const binds: unknown[] = []
  for (const e of rows) {
    binds.push(
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
      e.serverSeq,
    )
  }
  return db
    .prepare(
      `INSERT INTO events (
  id, schema_version, project_id, file_id, cell_id, parent_id, kind,
  author, payload, client_ts, server_ts, server_seq
) VALUES ${placeholders}
ON CONFLICT (id) DO NOTHING`,
    )
    .bind(...binds)
}
