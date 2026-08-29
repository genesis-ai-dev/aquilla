# Seq Allocation Ledger (lock-free event writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop event-write transactions from holding the per-project `project_seq_counters` row lock for their whole duration (the AQU-1005 lock convoy) while keeping `?since=` delta cursors safe against out-of-order commits.

**Architecture:** Seq allocation moves out of the write transaction into its own tiny autocommit statement that both bumps the counter AND announces the allocated range in a new `seq_allocations` ledger table. Event rows are then written with explicit pre-allocated seqs (the bulk paths already work this way). The write batch settles (deletes) its ledger row atomically with the event rows; a crashed/aborted writer's row expires after a TTL. Readers compute a **pending floor** — one below the oldest live ledger row — and never advertise a `?since=` cursor above it, so a straggler that commits late is always re-covered by the next delta. Rows above the floor are still *delivered* immediately (fast hydration); only the advertised cursor is clamped. Zero SPA changes.

**Design note (pivot from the xid/snapshot discussion):** the pure `pg_current_snapshot()` fence has a real hole — xid assignment order and seq allocation order are not guaranteed to agree, so `MAX(seq) WHERE write_xid < xmin` can advertise a seq while a lower seq is still in flight. The ledger closes that hole exactly (the announce *is* the allocation, per project), needs no `write_xid` column, no `pg_current_snapshot()`, and no client changes. Same family, airtight version.

**Tech Stack:** Cloudflare Workers (sync-worker), Postgres (Neon) via `db/shim/postgres.ts` (`?` placeholders; `batch()` = one atomic transaction; single `.run()` = autocommit), PGlite test harness (`sync-worker/src/__tests__/helpers/pg-test-db.ts` loads `db/postgres/schema.sql`), vitest per-package (`cd sync-worker && npm test`).

**Spec:** the conversation record + audit artifact "Neon Bottleneck Audit" (AQU-1005). Key contract preserved: seq gaps are harmless by design; seq order must equal *advertised-cursor-safe* order; `rebuilt_seq`/`project_epoch` semantics unchanged.

## Global Constraints

- TypeScript, no `any`; match existing file style (comment density is high and load-bearing in this area — keep the invariant comments accurate).
- `db/shim` placeholders are `?`. One `.prepare().run()` = one autocommit transaction. `db.batch(stmts)` / `batchPipelined(stmts)` = one atomic transaction.
- Seq gaps: allowed and already documented as harmless. Never reuse a seq.
- The allocation SQL must keep BOTH self-heal arms of today's `SEQ_RANGE_ALLOC_SQL`: the `MAX(events.server_seq)` seeding VALUES arm and the `GREATEST` on-conflict arm (RACE-1 regression tests depend on them).
- `PENDING_ALLOC_TTL_MS = 5 * 60_000` (5 min). Rationale: an unsettled ledger row means a writer crashed mid-request or aborted; 5 min comfortably exceeds any statement/request lifetime once server-side timeouts (audit fix #2) land, and a stalled floor only delays cursor advance, never data delivery.
- Worker tests: `cd sync-worker && npm test` (root `pnpm test` excludes worker packages).
- Commit after every task; branch `ryder/aqu-1005-neon-bottlenecks`; reference AQU-1005 in commit messages.

## File Structure

- `db/postgres/migrations/0082_seq_allocations.sql` — new ledger table (create).
- `db/postgres/schema.sql` — same table added to the canonical schema (modify).
- `sync-worker/src/events/event-insert.ts` — allocation+announce SQL, settle statement, pending-floor reader, explicit-seq single insert (modify; this file stays the single home of seq mechanics).
- `sync-worker/src/events/dispatch.ts` + `sync-worker/src/events/handlers/*.ts` — thread `serverSeq` through (modify, mechanical).
- `sync-worker/src/events/route.ts` — pre-allocate per request, settle on success (modify).
- `sync-worker/src/events/import-route.ts`, `import-reconcile-route.ts`, `migrate-ingest-route.ts`, `merge-sibling-route.ts`, `link-sync.ts` — settle their existing allocations in-batch (modify).
- `sync-worker/src/events/cells-read-route.ts` — fence the advertised watermark (modify).
- `sync-worker/src/__tests__/seq-allocation-ledger.test.ts` — new test file.

---

### Task 1: `seq_allocations` table (migration + canonical schema)

**Files:**
- Create: `db/postgres/migrations/0082_seq_allocations.sql`
- Modify: `db/postgres/schema.sql` (immediately after the `project_seq_counters` block, ~line 415)

**Interfaces:**
- Produces: table `seq_allocations (project_id TEXT, first_seq BIGINT, last_seq BIGINT, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (project_id, first_seq))` — consumed by every later task.

- [ ] **Step 1: Write the migration**

`db/postgres/migrations/0082_seq_allocations.sql`:

```sql
-- AQU-1005: seq-allocation ledger.
--
-- Seq allocation is moving OUT of the event-write transaction (which held the
-- project_seq_counters row lock for the whole batch — the lock convoy) into a
-- tiny autocommit statement that bumps the counter AND announces the range
-- here. The write batch deletes its row atomically with the event rows; a
-- crashed/aborted writer's row expires (readers ignore rows older than the
-- TTL; the next allocator for the project deletes them).
--
-- Readers use MIN(first_seq)-1 over live rows as the "pending floor": the
-- highest server_seq that is safe to advertise as a ?since= cursor. Rows
-- above the floor are still delivered — only the cursor is clamped — so a
-- late-committing writer's events are re-covered by the next delta instead
-- of being skipped.
CREATE TABLE IF NOT EXISTS seq_allocations (
    project_id TEXT NOT NULL,
    first_seq  BIGINT NOT NULL,
    last_seq   BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, first_seq)
);
```

- [ ] **Step 2: Add the identical block to `db/postgres/schema.sql`** right after the `project_seq_counters` CREATE TABLE (keep the same comment).

- [ ] **Step 3: Verify the test harness picks it up**

Run: `cd sync-worker && npx vitest run src/__tests__/concurrent-writes.test.ts`
Expected: PASS (schema loads; nothing uses the table yet).

- [ ] **Step 4: Commit**

```bash
git add db/postgres/migrations/0082_seq_allocations.sql db/postgres/schema.sql
git commit -m "feat(db): seq_allocations ledger table (AQU-1005)"
```

---

### Task 2: Allocation announces in the ledger; settle + pending-floor primitives

**Files:**
- Modify: `sync-worker/src/events/event-insert.ts`
- Test: `sync-worker/src/__tests__/seq-allocation-ledger.test.ts` (create)

**Interfaces:**
- Consumes: `seq_allocations` from Task 1; existing `AquillaDb`/`AquillaStatement` from `db/shim/postgres`.
- Produces (later tasks rely on these exact signatures):
  - `allocateSeqRange(db: AquillaDb, projectId: string, n: number): Promise<number>` — unchanged signature, now also inserts the ledger row and purges expired rows.
  - `buildSettleSeqRangeStmt(db: AquillaDb, projectId: string, firstSeq: number): AquillaStatement`
  - `fetchPendingFloor(db: AquillaDb, projectId: string): Promise<number | null>` — `null` = nothing pending.
  - `PENDING_ALLOC_TTL_MS: number` (exported const, `5 * 60_000`).

- [ ] **Step 1: Write the failing tests**

`sync-worker/src/__tests__/seq-allocation-ledger.test.ts`:

```ts
// AQU-1005 seq-allocation ledger: allocation announces its range, the write
// batch settles it, readers fence the advertised cursor on the oldest live
// (unsettled, unexpired) allocation. These tests pin the primitives; the
// route-level fence behaviour is tested in Task 6's cases below (same file).
import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import {
  allocateSeqRange,
  buildSettleSeqRangeStmt,
  fetchPendingFloor,
  PENDING_ALLOC_TTL_MS,
} from '../events/event-insert'

const PROJECT = 'proj-ledger'

describe('seq allocation ledger', () => {
  let db: TestDb
  beforeEach(async () => {
    db = await makeTestDb()
  })

  it('allocateSeqRange announces the range and keeps counter semantics', async () => {
    const base = await allocateSeqRange(db, PROJECT, 5)
    expect(base).toBe(1)
    const row = await db
      .prepare('SELECT first_seq, last_seq FROM seq_allocations WHERE project_id = ?')
      .bind(PROJECT)
      .first<{ first_seq: number | string; last_seq: number | string }>()
    expect(Number(row?.first_seq)).toBe(1)
    expect(Number(row?.last_seq)).toBe(5)
    // Counter self-heal arms survive: a second allocation continues above.
    const base2 = await allocateSeqRange(db, PROJECT, 2)
    expect(base2).toBe(6)
  })

  it('settle removes exactly the allocated range row', async () => {
    const base = await allocateSeqRange(db, PROJECT, 3)
    const other = await allocateSeqRange(db, PROJECT, 3)
    await buildSettleSeqRangeStmt(db, PROJECT, base).run()
    const floors = await db
      .prepare('SELECT first_seq FROM seq_allocations WHERE project_id = ? ORDER BY first_seq')
      .bind(PROJECT)
      .all<{ first_seq: number | string }>()
    expect(floors.results.map((r) => Number(r.first_seq))).toEqual([other])
  })

  it('fetchPendingFloor = oldest live allocation minus one; null when clear', async () => {
    expect(await fetchPendingFloor(db, PROJECT)).toBeNull()
    const a = await allocateSeqRange(db, PROJECT, 4) // 1..4
    const b = await allocateSeqRange(db, PROJECT, 4) // 5..8
    expect(await fetchPendingFloor(db, PROJECT)).toBe(a - 1) // 0
    await buildSettleSeqRangeStmt(db, PROJECT, a).run()
    expect(await fetchPendingFloor(db, PROJECT)).toBe(b - 1) // 4
    await buildSettleSeqRangeStmt(db, PROJECT, b).run()
    expect(await fetchPendingFloor(db, PROJECT)).toBeNull()
  })

  it('expired allocations are ignored by the floor and purged by the next alloc', async () => {
    await allocateSeqRange(db, PROJECT, 2) // 1..2, will be aged out
    await db
      .prepare(
        `UPDATE seq_allocations SET created_at = now() - (? * interval '1 millisecond')
         WHERE project_id = ?`,
      )
      .bind(PENDING_ALLOC_TTL_MS + 1000, PROJECT)
      .run()
    expect(await fetchPendingFloor(db, PROJECT)).toBeNull()
    // Next allocation purges the corpse.
    await allocateSeqRange(db, PROJECT, 1)
    const count = await db
      .prepare('SELECT COUNT(*)::int AS n FROM seq_allocations WHERE project_id = ?')
      .bind(PROJECT)
      .first<{ n: number }>()
    expect(Number(count?.n)).toBe(1) // only the fresh row
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sync-worker && npx vitest run src/__tests__/seq-allocation-ledger.test.ts`
Expected: FAIL — `buildSettleSeqRangeStmt` / `fetchPendingFloor` / `PENDING_ALLOC_TTL_MS` not exported; ledger row assertions fail.

- [ ] **Step 3: Implement in `event-insert.ts`**

Replace `SEQ_RANGE_ALLOC_SQL` and add the new exports (keep the existing header comments, updating the allocation story — the bump CTE no longer lives inside the event INSERT after Task 4, but this task only changes the bulk allocator):

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `cd sync-worker && npx vitest run src/__tests__/seq-allocation-ledger.test.ts`
Expected: PASS. Also run `npx vitest run src/__tests__/concurrent-writes.test.ts` — PASS (allocator semantics unchanged for callers).

- [ ] **Step 5: Commit**

```bash
git add sync-worker/src/events/event-insert.ts sync-worker/src/__tests__/seq-allocation-ledger.test.ts
git commit -m "feat(sync): seq allocation announces in ledger; settle + pending-floor primitives (AQU-1005)"
```

---

### Task 3: Explicit-seq single-event insert (retire the bump CTE)

**Files:**
- Modify: `sync-worker/src/events/event-insert.ts`

**Interfaces:**
- Produces: `EventInsertRow` gains required `serverSeq: number`; `buildEventInsertStmt(db, e: EventInsertRow): AquillaStatement` now writes the explicit seq (identical row bytes to the bulk path). `EVENT_INSERT_SQL` (the CTE) is deleted. `SeqEventInsertRow` type alias becomes `= EventInsertRow` (kept for callers).

- [ ] **Step 1: Implement**

In `event-insert.ts`: add `serverSeq: number` to `EventInsertRow`; delete `EVENT_INSERT_SQL`; reimplement `buildEventInsertStmt` as a one-row delegation:

```ts
export function buildEventInsertStmt(db: AquillaDb, e: EventInsertRow): AquillaStatement {
  return buildBulkEventInsertStmt(db, [e])
}
```

Update `SeqEventInsertRow` to `export type SeqEventInsertRow = EventInsertRow` and rewrite the header comment: allocation now happens up front via `allocateSeqRange` (Task 2); the race-safety argument is the counter row lock held for one tiny statement + ledger fence for cursor safety.

- [ ] **Step 2: Typecheck to enumerate broken callers**

Run: `cd sync-worker && npx tsc --noEmit`
Expected: errors in every `buildEventInsertStmt` handler call site (missing `serverSeq`) — the worklist for Task 4. Do not fix them here.

- [ ] **Step 3: Commit** (with Task 4 — the tree doesn't typecheck alone; proceed directly to Task 4 and commit together.)

---

### Task 4: Thread `serverSeq` through dispatch and the POST /events route; settle on success

**Files:**
- Modify: `sync-worker/src/events/dispatch.ts` (add `serverSeq` to `DispatchOptions` — NOT a positional param, to keep the ten handler signatures stable)
- Modify: `sync-worker/src/events/handlers/cell-events.ts`, `file-create.ts`, `file-rename.ts`, `file-video-set.ts`, `file-timing-set.ts`, `file-track-set.ts`, `file-delete-restore.ts` (both handlers), `comment-events.ts`, `assignment-events.ts`
- Modify: `sync-worker/src/events/route.ts` (allocate at ~line 562 where `nextServerTs` is minted; stamp per-event at ~line 759; settle after the commit loop at ~line 1234ff)
- Test: `sync-worker/src/__tests__/seq-allocation-ledger.test.ts` (extend)

**Interfaces:**
- Consumes: `allocateSeqRange`, `buildSettleSeqRangeStmt` (Task 2); `EventInsertRow.serverSeq` (Task 3).
- Produces: `DispatchOptions` gains `serverSeq: number` (required). Every handler copies `opts.serverSeq` into its `buildEventInsertStmt` row. `handleEventsWriteRequest` allocates `events.length` seqs up front and settles only when EVERY chunk committed.

- [ ] **Step 1: Extend the test file with route-level cases**

Append to `seq-allocation-ledger.test.ts` (reuse the request-builder pattern from `concurrent-writes.test.ts` — `makeTestToken`, `handleEventsWriteRequest`, the same partyserver mock):

```ts
it('POST /events settles its allocation when all chunks commit', async () => {
  // ... build a 2-event request exactly as concurrent-writes.test.ts does ...
  const res = await handleEventsWriteRequest(request, env)
  expect(res.status).toBe(200)
  const pending = await db
    .prepare('SELECT COUNT(*)::int AS n FROM seq_allocations WHERE project_id = ?')
    .bind(PROJECT)
    .first<{ n: number }>()
  expect(Number(pending?.n)).toBe(0)
  // Events carry consecutive explicit seqs.
  const seqs = await db
    .prepare('SELECT server_seq FROM events WHERE project_id = ? ORDER BY server_seq')
    .bind(PROJECT)
    .all<{ server_seq: number | string }>()
  expect(seqs.results.length).toBe(2)
})
```

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/__tests__/seq-allocation-ledger.test.ts` — FAIL: tsc errors / unsettled ledger row).

- [ ] **Step 3: Implement**

1. `dispatch.ts`: add to `DispatchOptions`:
   ```ts
   /** Pre-allocated server_seq for this event (AQU-1005: allocation happens
    *  once per request via allocateSeqRange, outside the write transaction). */
   serverSeq: number
   ```
2. Each handler: add `serverSeq: opts.serverSeq` to its `buildEventInsertStmt` row (handlers that take `opts`; `file-create.ts` and others that currently take no opts gain a fourth `serverSeq: number` param — check each signature and thread the minimal way; `handleCellEvent` reads `opts.serverSeq`). Delete the now-stale "`server_seq` is allocated by the per-project counter inside the INSERT" comments.
3. `route.ts`:
   - After the events array is validated (where `nextServerTs` is minted, ~line 562): `const seqBase = events.length > 0 ? await allocateSeqRange(db, projectId, events.length) : 0`.
   - In the per-event loop (~line 759, alongside `const serverTs = nextServerTs++`): compute `const serverSeq = seqBase + eventIndex` and pass it in the dispatch opts. Rejected events still consume their seq — a gap, harmless by design.
   - After the commit loop (~line 1234ff): if every chunk committed (no entries pushed to `rejected` from a failed `db.batch`), run `await buildSettleSeqRangeStmt(db, projectId, seqBase).run()` (guard `events.length > 0`). On partial failure, skip settle — the row expires via TTL and the fence holds the cursor down meanwhile (conservative, correct).

- [ ] **Step 4: Run the full worker suite**

Run: `cd sync-worker && npm test`
Expected: PASS, including `concurrent-writes.test.ts` (its RACE-1 pre-seeding still works because allocation still GREATEST-heals against `MAX(events.server_seq)`). Fix any test that asserted the old CTE SQL text.

- [ ] **Step 5: Commit**

```bash
git add sync-worker/src/events db/  sync-worker/src/__tests__
git commit -m "feat(sync): pre-allocate server_seqs per request; write events with explicit seqs; settle ledger on success (AQU-1005)"
```

---

### Task 5: Settle the bulk allocators in-batch

**Files:**
- Modify: `sync-worker/src/events/import-route.ts` (allocations at :463 and :668)
- Modify: `sync-worker/src/events/import-reconcile-route.ts` (allocation at :872)
- Modify: `sync-worker/src/events/migrate-ingest-route.ts` (allocation at :136)
- Modify: `sync-worker/src/events/merge-sibling-route.ts` (allocation at :181)
- Modify: `sync-worker/src/events/link-sync.ts` (allocations at :976 and :996)
- Test: `sync-worker/src/__tests__/seq-allocation-ledger.test.ts` (extend)

**Interfaces:**
- Consumes: `buildSettleSeqRangeStmt(db, projectId, firstSeq)` from Task 2.

- [ ] **Step 1: Extend tests** — one case driving the bulk import route (reuse `handleBulkImportRequest` setup from `concurrent-writes.test.ts`), asserting `seq_allocations` is empty for the project after a successful import.

- [ ] **Step 2: Run to verify failure** (unsettled rows remain).

- [ ] **Step 3: Implement** — at each call site, capture the returned base seq (already done everywhere) and append `buildSettleSeqRangeStmt(db, <projectId>, <baseSeq>)` to the SAME statement array that carries the event inserts (`finalizeStmts`, `stmts`, `allStmts`), so settle commits atomically with the rows. `link-sync.ts` has two allocations feeding one `allStmts` batch — append two settle statements.

- [ ] **Step 4: Run** `cd sync-worker && npm test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add sync-worker/src/events sync-worker/src/__tests__
git commit -m "feat(sync): bulk import/ingest/mirror paths settle their seq allocations in-batch (AQU-1005)"
```

---

### Task 6: Fence the advertised watermark in cells-read

**Files:**
- Modify: `sync-worker/src/events/cells-read-route.ts` (`Watermarks` ~line 336, `fetchWatermarks` ~line 350, `advertisedSeq` ~line 394, resync gate ~line 562–568)
- Test: `sync-worker/src/__tests__/seq-allocation-ledger.test.ts` (extend; model on existing `cells-read.test.ts` request setup)

**Interfaces:**
- Consumes: `seq_allocations` table; `PENDING_ALLOC_TTL_MS` from Task 2.
- Produces: `Watermarks` gains `pendingFloor: number | null`; `advertisedSeq(w)` clamps to it; the resync gate keeps using the UNCLAMPED max.

- [ ] **Step 1: Write the failing tests**

```ts
it('advertised maxServerSeq is clamped below a live allocation, rows still delivered', async () => {
  // Write 3 events normally (settled), then plant an unsettled allocation
  // covering seqs 4..5 (simulating an in-flight writer):
  await db
    .prepare('INSERT INTO seq_allocations (project_id, first_seq, last_seq) VALUES (?, 4, 5)')
    .bind(PROJECT)
    .run()
  const res = await getCells(/* file read, no since */)
  const body = await res.json()
  expect(body.maxServerSeq).toBe(3)          // clamped: 4..5 pending
  expect(body.cells.length).toBe(/* all */)   // delivery NOT clamped
})

it('a cursor above a freshly clamped watermark does not force resync', async () => {
  // since=3 with pendingFloor=2 (allocation covering 3..4 planted after the
  // client got cursor 3): must return a normal (possibly empty) delta, not
  // {resync:true} — the gate compares against the unclamped max.
})

it('expired allocations do not clamp', async () => { /* age the row past TTL, expect maxServerSeq back at MAX(server_seq) */ })
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

1. `Watermarks` gains:
   ```ts
   /** AQU-1005 fence: one below the oldest live (unsettled, unexpired) seq
    *  allocation, null when nothing is pending. Clamps the ADVERTISED cursor
    *  only — delivery and the ETag stay on maxSeq, so a 304 can never strand
    *  a client: when the straggler commits, maxSeq moves, the ETag misses,
    *  and the delta from the clamped cursor re-covers the straggler's rows. */
   pendingFloor: number | null
   ```
2. `fetchWatermarks` adds a fourth subquery (bind `PENDING_ALLOC_TTL_MS`):
   ```sql
   (SELECT MIN(first_seq) - 1 FROM seq_allocations
     WHERE project_id = ? AND created_at > now() - (? * interval '1 millisecond')) AS pending_floor
   ```
3. `advertisedSeq`:
   ```ts
   function advertisedSeq(w: Watermarks): number {
     const unclamped = Math.max(w.maxSeq, w.rebuiltSeq)
     return w.pendingFloor == null ? unclamped : Math.min(unclamped, w.pendingFloor)
   }
   ```
4. Resync gate (~line 567): the `since > maxServerSeq` comparison must use the unclamped `Math.max(watermarks.maxSeq, watermarks.rebuiltSeq)` — a clamped advertisement can sit below a cursor the client legitimately holds from an earlier response; that is not incarnation drift and must not force a resync. Extract `const unclampedMax = Math.max(watermarks.maxSeq, watermarks.rebuiltSeq)` and compare `since > unclampedMax`.
5. ETag (`makeEtag`): UNCHANGED — stays on `maxSeq` so new visible rows always bust the 304.

- [ ] **Step 4: Run** `cd sync-worker && npm test` — PASS (including `cells-read.test.ts` untouched cases).

- [ ] **Step 5: Commit**

```bash
git add sync-worker/src/events/cells-read-route.ts sync-worker/src/__tests__
git commit -m "feat(sync): fence advertised ?since= watermark on the seq-allocation pending floor (AQU-1005)"
```

---

### Task 7: Fence the link-sync fold head

**Files:**
- Modify: `sync-worker/src/events/link-sync.ts` (where `head` — the upstream MAX(server_seq) fold target — is computed before `loadDelta` is called; search for the assignment of `head` near the `runSync` body ~line 900–960)
- Test: `sync-worker/src/__tests__/seq-allocation-ledger.test.ts` (extend)

**Interfaces:**
- Consumes: `fetchPendingFloor(db, upstreamProjectId)` from Task 2.

- [ ] **Step 1: Write the failing test** — seed an upstream project with settled events, plant an unsettled `seq_allocations` row below the upstream head, run the mirror sync (reuse the harness from the existing link-sync tests in `__tests__`), and assert the stored cursor does not advance past `firstSeq - 1`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — after `head` is computed for the upstream project:

```ts
// AQU-1005: never advance the fold cursor past an in-flight upstream
// allocation — a late-committing upstream writer's events would otherwise be
// permanently skipped by this link's `server_seq > cursor` fold.
const upstreamFloor = await fetchPendingFloor(db, upstreamProjectId)
const safeHead = upstreamFloor == null ? head : Math.min(head, upstreamFloor)
if (safeHead <= cursor) return { ranSync: false, /* match existing early-return shape */ }
```

and use `safeHead` everywhere `head` fed `loadDelta` / `advanceCursor` / the `link.cursor.advance` payload.

- [ ] **Step 4: Run** `cd sync-worker && npm test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add sync-worker/src/events/link-sync.ts sync-worker/src/__tests__
git commit -m "feat(sync): clamp link-sync fold head to the upstream pending floor (AQU-1005)"
```

---

### Task 8: Full verification + docs touch-up

**Files:**
- Modify: `sync-worker/src/events/event-insert.ts` (final comment pass), `CLAUDE.md`/`docs/SYNC.md` only if they describe the old in-CTE allocation (grep for "counter" / "bump").

- [ ] **Step 1:** `cd sync-worker && npm test` — full suite PASS, zero skips.
- [ ] **Step 2:** `pnpm lint && npx tsc --noEmit` (root) and `cd sync-worker && npx tsc --noEmit` — clean.
- [ ] **Step 3:** Grep for stragglers: `grep -rn "EVENT_INSERT_SQL\|allocated by the per-project counter inside" sync-worker/src` — must be empty.
- [ ] **Step 4:** Run the e2e smoke per AGENTS.md before push: `pnpm test:e2e:smoke`.
- [ ] **Step 5: Commit** any doc fixes: `git commit -m "docs(sync): seq allocation ledger notes (AQU-1005)"`.

## Non-goals / explicitly out of scope

- `migrate-event-ids-route.ts` cursor paging: migration reads run behind the AQU-1007 runner fence and off-hours; a fence there can follow if needed.
- Client (SPA) changes: none required — the fence is entirely server-side in the advertised cursor.
- Removing `project_seq_counters`: it remains the allocator (and carries `rebuilt_seq`/`project_epoch`).
- Applying the fence to `progress-read-route` / ETag semantics beyond cells-read: ETags stay maxSeq-based everywhere by design.
