---
name: d1-performance
description: Diagnose and fix Cloudflare D1 (single-writer SQLite) performance problems. Use when D1 queries are slow, a migration or bulk write is taking too long, you see "D1 DB is overloaded", or when designing write-heavy or propagating-effect features (counters, health/decay, derived state) on D1. Covers finding the bottleneck via the Query Performance dashboard (rows_read as the O(N²) tell), the single-writer ceiling, batch-size and per-statement limits, and the fix playbook (defer per-row aggregate recomputes to set-based, derive-on-read over materialize-on-write, delta by deterministic id).
---

# D1 Performance

D1 is single-writer SQLite behind a Worker binding. Most "D1 is slow" problems are
**write amplification** or **O(N²) recompute patterns**, not D1 itself. Measure before optimizing.

## 1. Find what's actually slow (don't guess)

- **Dashboard → D1 → your DB → Query Performance**: ranks queries by % of total time, with
  execution count, `rows_read`, `rows_written`, avg/p90 duration. First stop, always.
- **`rows_read` is the tell.** If `rows_read ÷ executions` ≫ rows returned, you're scanning, not
  point-looking. Billions of rows read = an O(N²) or missing-index pattern.
- **`EXPLAIN QUERY PLAN <sql>`** — look for `SCAN` (bad) vs `SEARCH … USING INDEX` (good).
- **`.meta` on D1 results** (`rows_read`, `rows_written`, `duration`) — per-query cost in code/tests.
- **"D1 DB is overloaded. Requests queued for too long"** = you're overdriving the single writer
  (batches too big and/or too much write concurrency).
- **Measure write throughput** by sampling `COUNT(*)` deltas over a fixed window (events/min), not
  by wall-clock of a whole job (which is confounded by clone/parse/network).

## 2. What's generally slow in D1

- **Single writer.** SQLite takes a DB-level write lock — one txn commits at a time. Concurrency does
  NOT parallelize writes; past saturation it just queues → "overloaded". Throughput is capped by commit rate.
- **Correlated-subquery-per-row recompute = O(N²).** Recomputing an aggregate (COUNT/SUM over a set)
  on every change to a member, each recompute re-scanning the whole set. The #1 trap.
- **Per-statement limits:** ≤100 bound params, ≤100 KB SQL text, ≤30 s/txn. (Parameterized multi-row
  INSERT maxes ~9 rows for an 11-col table — to bulk-insert, inline escaped literals up to 100 KB instead.)
- **Batch-size tradeoff:** bigger `db.batch()` = fewer commits but holds the writer longer → overload
  under concurrency. **~100 statements is the sweet spot.** Bigger backfires (verified: 1000 → mass overload).
- **Write amplification:** one logical change → many physical writes (projections, FTS5 maintenance,
  triggers, counter UPDATEs). Audit the fan-out per change.

## 3. Fix playbook

1. **Measure first.** The bottleneck is rarely where you think. (We guessed wrong twice — "events-only"
   and "bigger batches" — before the dashboard showed the real culprit.)
2. **Kill the O(N²):** any "recompute aggregate on every change" → defer to ONE set-based recompute per
   batch/scope: `UPDATE files SET cnt=(SELECT COUNT(*) … WHERE file_id=files.id) WHERE project_id=?` once,
   not per row.
3. **Reduce writes, don't just reorder them.** Deferring work that still must happen = same total cost.
   You win only if the deferred form is cheaper (set-based once vs per-row N times) or eliminated.
4. **Derive-on-read > materialize-on-write** when writes fan out and reads are scoped (viewport). Reads
   never touch the single writer and can be cached (KV).
5. **Don't fight the single writer with concurrency.** Reduce per-write work instead. Cap write
   concurrency to saturate-not-overload; keep batches ~100.
6. **Send less:** for re-syncs/bulk, diff by **deterministic id** (e.g. UUIDv5 of stable inputs) and write
   only the delta — unchanged → zero writes.
7. **Verify any deferred/batched recompute** by diffing its output against the incremental path
   (`SELECT COUNT(*) WHERE stored != recomputed` → must be 0).

## Case study (codex-web-app migration)

A per-cell file-counter `UPDATE files SET cell_count=(SELECT COUNT(…)), word_count=(…), …` ran **once per
cell event**, each re-scanning the whole file's cells → **O(N²) per file**. Profiler showed **67% of all
query time** and **13.4 BILLION rows read** across 3.2M executions. Fix: skip it during ingest
(`deferFileCounters` flag), then run ONE set-based `UPDATE … WHERE project_id=?` per project afterward.
Result: **2.4× write throughput** (12k → 28k events/min), verified **0 mismatches** vs the inline values.

## Propagating effects / derived state (health, decay, confidence)

Systems where one change affects neighbors hit the same trap — worse if effects are **transitive**
(cascade across the connected component, all serialized through one writer).

- **Bound the propagation radius** to immediate neighbors (radius 1), never transitive.
- **Derive-on-read** with indexed/FTS lookups, scoped to the viewport → `O(viewed × local-neighborhood)`,
  not `O(writes × fan-out)`.
- If you must materialize, use **incremental dirty-recompute** of just the changed cell + direct
  neighbors; a project-wide refresh = ONE set-based pass, never per-edit cascades.
- **The rule that generalizes:** *never recompute an aggregate over a set on every change to a member of
  that set.* Derive lazily on read (scoped), or recompute once set-based after a batch.
