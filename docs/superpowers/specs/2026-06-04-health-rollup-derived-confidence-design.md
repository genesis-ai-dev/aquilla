# Design: Health rollup as derived confidence over a materialized neighbour graph

**Date:** 2026-06-04 · **Status:** approved (brainstorm) → ready for implementation plan
**Substrate:** Neon Postgres (post D1→Neon migration; see `docs/design/storage-migration-d1-to-neon.md`)
**Supersedes mechanism in:** AD-14 (`~/frontierrnd/aquilla-specs/02-foundations.md`) — see amendment block there.
**Prereq reading:** `.claude/skills/d1-performance/SKILL.md`, `docs/design/health-decay-derive-on-read-plan.md`

## Problem

A translator validates their lowest-health segments and wants to see **the overall project
health jump before their eyes** — "+12% project health, and three on-screen segments improved
30%." Health is a *derived* score: `confidence(cell)` ripples out from validated cells through
the AD-13 retrieval graph. The rollup the manager/translator watches is `mean(confidence)` over
**every** cell in scope — including cells not on screen.

The tension: confidence depends on *which top-k neighbours a cell has right now*, which is an FTS
lookup per cell. Computing `mean(confidence)` purely on read = one FTS lookup per cell in the
project = too expensive to run on every validate. We cannot precompute the neighbourhood index
cheaply from scratch on demand.

## The linchpin

**Validation changes node *anchors*, not graph *edges*.** In the formula

```
confidence(X) = perHopDecay · Σ_neighbours(r · a · confidence(Y)) / Σ_neighbours(r)
confidence(validated) = 100
```

`r` (source similarity) is fixed at import; `a` (target-text consistency) changes only when target
text is **edited**, not when a cell is **validated** (validation endorses existing text, it does
not rewrite it); the topology is fixed. So the neighbourhood graph is **invariant under
validation** — the exact operation driving the "jump." Only translate/edit changes edges, and
those are far rarer and bounded to the changed cell.

Therefore: materialize the **graph** (not the health values), maintain it on edit only, and the
rollup becomes pure arithmetic over an indexed graph — no FTS on the validate path.

## Decision: what health *is* (ratifies the prototype, amends AD-14)

- **Cell metric = derived confidence** `confidence(X)` above (the `c12baa5` prototype:
  `sync-worker/src/lib/confidence/propagate-health.ts`). This is canonical. The
  `endorsement_count`/decay-engine count metric is retired as the health basis (see Migration).
- **Rollup = `mean(confidence over cells in scope)`** for a file or project.
- **Framing preserved from AD-14:** *decay* at cell scope (action-prompting marker, appears only
  above a threshold — `decay(cell) = 1 − confidence(cell)/100`), *health* at aggregate scope
  (optimization target). The dual framing is mechanism-independent and survives unchanged.

## Components

### 1. `cell_edges` — the materialized neighbour graph (the only thing materialized)

```sql
CREATE TABLE cell_edges (
  project_id   TEXT NOT NULL,
  file_id      TEXT NOT NULL,
  src_cell_id  TEXT NOT NULL,   -- the cell whose confidence depends on dst
  dst_cell_id  TEXT NOT NULL,   -- a top-k source-neighbour of src
  r            REAL NOT NULL,   -- source similarity (ts_rank), weights the mean
  a            REAL NOT NULL,   -- target-text consistency, gates health transfer
  PRIMARY KEY (project_id, file_id, src_cell_id, dst_cell_id)
);
CREATE INDEX idx_cell_edges_reverse ON cell_edges (project_id, dst_cell_id);  -- who depends on me
```

- **Built from** the AD-13 retrieval over the ported FTS: `cells.value_tsv @@
  websearch_to_tsquery('simple', $q)` ranked by `ts_rank` (already in `db/postgres/schema.sql:212,
  375`). `r` from `ts_rank`; `a` from `lexicalConfidence(targetText, neighbourTargetText)`.
- **Maintained ONLY on text/translate change of a cell C** (a `cell.commit` that alters source or
  target text), never on validate:
  1. Recompute C's **out-edges**: one FTS retrieval for C's top-k neighbours → replace C's rows.
  2. Refresh C's **in-edges**: one reverse FTS retrieval (cells whose query would now newly
     include / exclude C as a translated neighbour) → update affected `(src, C)` rows.
  - Bounded to ~`O(k)` writes. Accepted tradeoff: a single edit *can* in theory shift many cells'
    neighbourhoods; in practice it's localized. If a refresh touches more than a cap, fall back to
    a debounced file-scoped edge rebuild (see Guardrail).

### 2. Rollup via one `WITH RECURSIVE` propagation pass

Compute confidence for a whole scope in a single recursive CTE over `cell_edges` (anchors =
validated cells at 100, iterate to `maxHops`), then aggregate:

```sql
-- sketch; final form iterates maxHops levels and averages
WITH RECURSIVE prop AS ( ... fixpoint over cell_edges, anchored at validated=100 ... )
SELECT avg(confidence) AS health
FROM prop
WHERE project_id = $1 [AND file_id = $2];
```

- Pure arithmetic over the indexed graph — **no FTS, no per-cell recompute.**
- Runs **debounced** after validates (e.g. coalesce a burst of batch-validations into one pass).
- **Deliberately NOT materializing per-cell confidence yet** (YAGNI). Measure this CTE at Bible
  scale (~31k cells × k edges) first. Promote to an incremental delta — reverse-reachable affected
  set `S` from the validated cell, recompute only `S`, update a stored aggregate by the delta —
  **only if** the on-demand CTE is too slow. The reverse index exists precisely to enable that
  later without a schema change.

### 3. Live "before your eyes" — optimistic client + DO broadcast

- **Realtime transport stays ProjectSync DO-via-fetch** (NOT Postgres LISTEN/NOTIFY — Workers +
  Hyperdrive can't hold long-lived LISTEN connections; the migration keeps the DO unchanged).
- **Optimistic client:** on validate, the client immediately bumps on-screen segments + the rollup
  from cells already in the viewport → frame-perfect jump, independent of backend latency.
- **Server reconcile:** Worker runs the debounced CTE, POSTs the exact new rollup to the DO
  `/__broadcast` hook → connected clients animate to the authoritative number. Add a broadcast
  message kind, e.g. `health.rollup` `{ project, file?, health }`.

### 4. Read path cleanup

- The editor ring and the rollup both read from the same source (the CTE / graph) — retires the
  current **three overlapping metrics** (counter progress, decay-engine `endorsement_count`,
  prototype confidence). See `docs/design/health-decay-derive-on-read-plan.md` findings.
- Replace the per-cell FTS N+1 in `cell-confidence-route.ts:163-182` with the graph-backed read
  (viewport confidence comes from the same propagation, scoped to the viewport's cells).

## Guardrails / verification (d1-performance discipline)

- **Bounded propagation, never a cascade-on-write.** Validate writes O(1) (its own row). Edge
  maintenance is O(k) per edit. No per-validate fan-out to neighbour rows.
- **Radius cap fallback:** if an edit's edge refresh or a validate's affected set exceeds a cap,
  enqueue a debounced scope-level rebuild rather than an unbounded synchronous sweep.
- **No scheduled full-table health rewrite.** No cron.
- **Correctness oracle:** the materialized-graph rollup MUST match a from-scratch batch recompute
  (the current `cell-confidence-route` logic) — 0 mismatches on a test project
  (`SELECT count(*) WHERE stored != recomputed = 0`). This is the Rule-9 test: it encodes *why*
  (the optimization must not change the number).
- **Measure:** capture rollup-query cost (`EXPLAIN ANALYZE`) at small and Bible scale before
  deciding whether to materialize per-cell confidence (component 2).

## What this loses vs AD-14's endorsement model (flagged, not hidden)

The derived-confidence mechanism gives up two properties the count-based endorsement model had.
Spec owner should ratify these consciously:

1. **Attribution/audit.** Endorsement events recorded *who* endorsed via *which* retrieval
   (`validator_user_id`, `retrieval_query_event_id`). Derived confidence is anonymous — no
   per-validator backing trail per cell. (If audit is needed, `cell_validators` still records the
   raw validations; what's lost is the neighbourhood-level attribution.)
2. **Re-import / source-edit stability.** AD-14 tied endorsements to `cell_id`, surviving source
   text changes. Confidence is text-derived, so it shifts when source/target text changes — which
   is arguably *more correct* (a changed neighbourhood should re-derive) but is a behaviour change.

Conversely it **gains**: revocation is free (unvalidate/harmonize just re-derive without the
anchor — no `cell.endorsement.revoke` events), and there is one fewer projection to maintain.

## Out of scope (YAGNI)

- Per-cell materialized confidence + incremental delta (component 2 promotion) — only if measured.
- Time-weighted decay (AD-14 already defers this to `later`).
- Embedding-based retrieval (AD-13 locks BM25/FTS for v1).
- KV cache for viewport confidence — only if read cost warrants after the graph backing lands.

## Build surface

- New PG table `cell_edges` in `db/postgres/schema.sql` (+ reverse index).
- Edge-maintenance hook in `sync-worker/src/events/event-projection.ts` on source/target text
  change (`cell.commit` variants), bounded, with radius-cap fallback.
- Rollup CTE + a read endpoint / view; `health.rollup` DO broadcast message + handler.
- Rework `cell-confidence-route.ts` to read from the graph; deprecate the decay-engine
  `endorsement_count` health path (`src/lib/health/decay-engine.ts`); collapse / remove the now-dead
  `endorsement_count` UPDATE in `event-projection.ts` and `idx_cells_decay_drags` once nothing reads it.
- Optimistic client bump in `useCellConfidence` / `useHealth` + StatusBar animate-to-authoritative.
- Amend AD-14 (done — amendment block in `02-foundations.md`).
