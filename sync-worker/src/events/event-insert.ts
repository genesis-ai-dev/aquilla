// Canonical `events` INSERT — the ONLY way an event row may be written.
//
// server_seq allocation (audit RACE-1 / PERF-5, task M1-1; AQU-1005):
//   The original per-statement `COALESCE((SELECT MAX(server_seq) …), 0) + 1`
//   was race-unsafe: two concurrent same-project transactions computed the
//   same N+1 under READ COMMITTED, and the loser's unique-index collision on
//   idx_events_project_seq was swallowed by an UNQUALIFIED `ON CONFLICT DO
//   NOTHING` — the event-log row silently vanished while its cells projection
//   still committed (cells.event_id → ghost event).
//
//   M1-1 fixed that by bumping a per-project counter row inside the insert
//   statement itself. Correct, but it took the counter's row lock inside the
//   write transaction and held it until commit, so every same-project writer
//   queued behind the slowest one — the AQU-1005 lock convoy.
//
//   Allocation now happens UP FRONT, outside the write transaction, via
//   `allocateSeqRange` (one autocommit statement: bump the counter, announce
//   the block in `seq_allocations`, purge expired corpses). Callers stamp the
//   pre-allocated seq onto each row and every insert — single or bulk — goes
//   through `buildBulkEventInsertStmt` with an explicit server_seq.
//
//   Race safety now rests on two things:
//   - The counter row lock is still what serializes concurrent same-project
//     allocators, but it is held for ONE tiny statement (microseconds), never
//     across the event batch. Blocks therefore never overlap.
//   - Cursor safety comes from the `seq_allocations` ledger fence: readers
//     clamp their advertised `?since=` cursor below the oldest still-pending
//     allocation (see fetchPendingFloor), so an in-flight writer's block can
//     never be skipped past.
//
//   - Seeding: the VALUES arm initializes the counter from
//     MAX(events.server_seq) the first time a project allocates.
//   - Self-healing: if the counter ever falls behind the log, the GREATEST
//     against the freshly computed EXCLUDED seed jumps it past the log max in
//     one statement instead of colliding.
//   - `ON CONFLICT (id) DO NOTHING` is qualified to the PK: only true
//     idempotent id-replays are skipped. Any other unique violation (e.g. a
//     seq collision, which the allocator makes impossible by construction)
//     fails the transaction LOUDLY instead of dropping the row.
//   - Gaps: a rejected or replayed event still consumes its pre-allocated
//     seq. Harmless — server_seq is an ordering key, not a count.

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
  /** Pre-allocated ordering key (from allocateSeqRange) — never computed
   *  inside the INSERT any more. See the header note. */
  serverSeq: number
}

// AQU-533: `events.provenance` (JSONB, nullable) is INTENTIONALLY omitted from
// the column list below. Every write through this canonical insert — in-app,
// mirror, import — leaves it NULL. Only the external Agent-API changeset commit
// path stamps provenance, and it does so out-of-band with a targeted UPDATE
// AFTER the events land (see sync-worker/src/external/commit.ts). Keeping it out
// of the hot insert preserves byte-identical behaviour for every existing test.

/** Build the canonical events INSERT statement for one event. One-row
 *  delegation to the bulk builder — identical row bytes, explicit seq. */
export function buildEventInsertStmt(db: AquillaDb, e: EventInsertRow): AquillaStatement {
  return buildBulkEventInsertStmt(db, [e])
}

// ---------------------------------------------------------------------------
// Bulk variant (POST /import fast path)
// ---------------------------------------------------------------------------
//
// One statement per event costs one DB round trip per event; through the
// Postgres shim a 1500-cell chunk became ~3000 sequential round trips
// (~30ms each ≈ 100s/book — AQU-310 follow-up). Bulk imports instead
// allocate the whole seq block in ONE counter bump, then write all rows in
// multi-row INSERTs with explicit seqs. Since AQU-1005 this is the ONLY
// events-insert builder; buildEventInsertStmt is a one-row wrapper over it.
//
// Race-safety: the counter row's lock serializes concurrent same-project
// allocators, so blocks never overlap, and seqs handed out here are ≤ the
// counter — any later writer allocates strictly above. Replays consume a
// block and drop the rows on ON CONFLICT (id) — seq gaps, harmless by design
// (see header note on gaps).
//
// AQU-1005: the allocator also announces the block in `seq_allocations`
// (settled by buildSettleSeqRangeStmt once the event rows land, or expired
// after PENDING_ALLOC_TTL_MS on crash/abort) so readers can fence their
// advertised `?since=` cursor on the oldest still-pending allocation instead
// of racing ahead of an in-flight writer.

export const PENDING_ALLOC_TTL_MS = 5 * 60_000

// Allocation = counter bump + ledger announce + expired-row purge, ONE
// autocommit statement. The counter row lock is held only for this statement
// (microseconds), never across the event-write batch — that hold was the
// AQU-1005 convoy. Both self-heal arms (seeding VALUES / GREATEST on
// conflict) are unchanged.
const SEQ_RANGE_ALLOC_SQL = `WITH purged AS (
  DELETE FROM seq_allocations
   WHERE project_id = ? AND created_at <= now() - (? * interval '1 millisecond')
), bump AS (
  INSERT INTO project_seq_counters (project_id, last_seq)
  VALUES (?, COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ?), 0) + ?)
  ON CONFLICT (project_id) DO UPDATE SET
    last_seq = GREATEST(project_seq_counters.last_seq + ?, excluded.last_seq)
  RETURNING last_seq
)
INSERT INTO seq_allocations (project_id, first_seq, last_seq)
SELECT ?, last_seq - ? + 1, last_seq FROM bump
RETURNING first_seq`

/** Atomically allocate `n` consecutive server_seqs for a project; returns the
 *  FIRST seq of the block (rows get base, base+1, …, base+n-1). Also announces
 *  the block in `seq_allocations` (settled by buildSettleSeqRangeStmt once the
 *  event rows land) and purges any of this project's allocations older than
 *  PENDING_ALLOC_TTL_MS (crash/abort corpses). */
export async function allocateSeqRange(
  db: AquillaDb,
  projectId: string,
  n: number,
): Promise<number> {
  if (n <= 0) throw new Error(`allocateSeqRange: n must be positive, got ${n}`)
  const first = await db
    .prepare(SEQ_RANGE_ALLOC_SQL)
    .bind(projectId, PENDING_ALLOC_TTL_MS, projectId, projectId, n, n, projectId, n)
    .first<number>('first_seq')
  if (first == null) throw new Error('allocateSeqRange: counter bump returned no row')
  return Number(first)
}

/** Settle (retire) an allocation — append to the SAME batch as the event
 *  rows so the ledger row disappears atomically with the events becoming
 *  visible. An unsettled row (crash/abort) simply expires after the TTL. */
export function buildSettleSeqRangeStmt(
  db: AquillaDb,
  projectId: string,
  firstSeq: number,
): AquillaStatement {
  return db
    .prepare('DELETE FROM seq_allocations WHERE project_id = ? AND first_seq = ?')
    .bind(projectId, firstSeq)
}

/** The highest server_seq safe to advertise as a `?since=` cursor: one below
 *  the oldest live (unsettled, unexpired) allocation. `null` = no fence —
 *  nothing is pending. Rows above the floor are still DELIVERED; only the
 *  advertised cursor is clamped, so late-committing writers are re-covered
 *  by the next delta instead of skipped. */
export async function fetchPendingFloor(
  db: AquillaDb,
  projectId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MIN(first_seq) - 1 AS floor FROM seq_allocations
        WHERE project_id = ? AND created_at > now() - (? * interval '1 millisecond')`,
    )
    .bind(projectId, PENDING_ALLOC_TTL_MS)
    .first<{ floor: number | string | bigint | null }>()
  return row?.floor == null ? null : Number(row.floor)
}

/** Alias kept for callers; every insert row now carries its own seq. */
export type SeqEventInsertRow = EventInsertRow

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
