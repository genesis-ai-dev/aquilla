# Plan: Health/Decay as Derive-on-Read with Bounded Locality

**Status:** ready for pickup · **Owner:** unassigned · **Prereq reading:** `.claude/skills/d1-performance/SKILL.md`

## Why this exists

Cell "health"/confidence (AD-14: *looks-like-validated-neighbors*, intended to be derived on read via
FTS5) has **propagating effects** — one validation/edit changes neighbors' health. On a **single-writer
D1**, the naive implementation (recompute affected cells on every write, especially transitively) is the
same trap that just cost this codebase dearly during migration: a per-row aggregate recompute was **67% of
all D1 query time and read 13.4 BILLION rows** because it ran once per change, each re-scanning the whole
set — **O(N²) per file** (see the d1-performance skill case study). Eager/transitive health propagation
would reproduce this, or worse (cascade across a connected component, all serialized through one writer).

**Goal:** a health/confidence/decay model with **O(1) write cost** and **viewport-scoped read cost** — no
write-time fan-out, no transitive cascades, no scheduled full-table rewrites.

## Phase 0 FINDINGS (2026-06-03)

Investigated the actual code. **The feared O(N²) write-time cascade does not exist.** The read path is
already derive-on-read. Most success criteria are already met. Corrected picture:

- **Health is computed ON READ**, in-memory, viewport-scoped: `GET /cell-confidence`
  (`cell-confidence-route.ts:86` → `propagateHealth()` in `lib/confidence/propagate-health.ts`). No stored
  health column.
- **No write-time neighbor propagation.** A `cell.validate` touches only its own row. Explicit
  `TODO(AD-13/14)` at `event-projection.ts:537` notes propagation is intentionally *not* implemented.
- **No transitive cascade. No scheduled decay cron** (no `[triggers]` in `wrangler.toml`, no `scheduled()`).
- **Decay is not actually used** — formula uses only `validated` + FTS5 lexical edges; `last_edit_at` decay
  is not in the formula (despite migration name `0011_ad14_decay.sql`).

**The two REAL inefficiencies (revised scope):**

1. **Read path is N+1.** `loadFileCells` pulls ≤5000 cells, then `querySourceNeighbors()` runs **one FTS5
   query per unvalidated cell** (`cell-confidence-route.ts:163-182`). Dominant read cost. Batch the neighbor
   lookup per viewport instead of per cell. (Read-side, does not hit the single writer.)
2. **`endorsement_count` is a wasted write.** Every `cell.validate` runs TWO correlated-subquery UPDATEs
   (`event-projection.ts:508` validated, `:556` endorsement_count) for the one cell. The read route
   **never reads `endorsement_count`** — computed-on-write, unused. Pure write amplification, plus the
   `idx_cells_decay_drags` index is maintained for nothing.

**Revised goal:** not "kill a cascade" (none exists) but (a) batch the N+1 read, (b) drop the dead
`endorsement_count` write + its index, OR wire it into the read path if AD-14 actually wants it. Decide
intent before deleting (see Risks).

---

## The real finding: spec and implementation have diverged into two health models

The original premise of this plan ("a write-time cascade is costing us, make it derive-on-read") is
**already solved** — and was solved by *changing the definition of health*, not by optimizing the old one.
Commit `c12baa5 feat(health): derive-on-read confidence + multi-hop propagation` introduced a new model and
explicitly "left endorsement_count intact for comparison; nothing removed." We now run two models at once:

| | **AD-14 spec** (`~/frontierrnd/aquilla-specs/02-foundations.md:290`, *provisional* 2026-05-14) | **Current prototype** (`c12baa5`) |
|---|---|---|
| Cell metric | `decay = max(0, 1 − endorsement_count / endorsementTarget)` | `health(X) = perHopDecay · Σ(r·a·health(Y)) / Σr`, multi-hop ripple, validated=100 anchors |
| Basis | **count** of human endorsements | **lexical-similarity graph** (FTS5) + validated anchors |
| Storage | `endorsement_count` materialized on write | nothing stored; computed on read |
| Propagation | **on write**: each `cell.validate` runs AD-13 branching search, emits `cell.endorsement` to top-k source-neighbors + self | **on read**: viewport-scoped, never writes neighbors |
| File/project health | `health(S) = 1 − mean(decay over cells in S)` — the **manager rollup** | **not produced** |
| Time decay | none in v1 | none |

**The spec's AD-14 is itself the write-amplification trap.** "On every validate, run a branching search and
emit a `cell.endorsement` write to top-k neighbors + self" is per-write fan-out of `k+1` rows serialized
through the single writer. Batch-validating a file of N cells → N searches + N·(k+1) endorsement writes —
structurally the same shape as the 13.4-billion-row file-counter incident (see d1-performance case study).
The prototype didn't optimize that cascade; it **avoided it by redefining health** as a pure read-time
function of the always-current FTS5 index. That was the right instinct.

### What the current code actually does (verified)

- **Cell health: derived on read, O(1)-ish writes.** `GET /cell-confidence` → `loadFileCells` +
  `querySourceNeighbors` (FTS5) + `propagateHealth()` (`lib/confidence/propagate-health.ts`). UI consumes via
  `useCellConfidence` (capped at 100 query cells), renders the % ring in `EditorTable`.
- **`endorsement_count`: written, unused.** Two correlated-subquery UPDATEs per validate
  (`event-projection.ts:508` validated, `:556` endorsement_count). The read path ignores `endorsement_count`.
  The spec's neighbor-endorsement cascade was **never implemented** — only self-endorsement
  (`endorsement_count` ≈ "how many validators on this cell"). So today it is neither used on read nor a
  faithful implementation of the spec.
- **Two read-path inefficiencies (real, but read-side — they don't hit the single writer):**
  1. **N+1 neighbor fetch.** `querySourceNeighbors` runs one FTS5 query *per unvalidated cell* in the
     viewport (`cell-confidence-route.ts:163-182`).
  2. **`loadFileCells` scans up to 5000 source cells** per request, scoped to one file (acceptable, but
     unindexed for the JOIN).

## The decision this plan now turns on (Rule 7 — surface, don't average)

The two models can't be blended; one has to be canonical. The efficiency analysis points one way, but the
**file/project health rollup** is the catch:

- The prototype's derived-on-read cell health is **cheap per viewport but expensive to aggregate** over a
  whole project (it'd touch every cell's neighbors — an aggregate cost, distinct from viewport cost). The
  org-context goal (manager oversight for Wendi/Randall/Anna) *needs* that file/project number.
- The spec's `endorsement_count` is a **cheap, indexable aggregate basis** for `health(S) = 1 − mean(decay)`
  — but its write-time cascade is the trap.

So the likely-correct shape is a **hybrid that keeps each layer where it's cheap**, NOT a single model:

- **Cell-level (viewport):** ratify derive-on-read multi-hop confidence (current prototype). Canonical for
  the editor ring.
- **File/project-level (rollup):** a **single set-based aggregate**, never a per-validate cascade — mirror
  the `deferFileCounters` + `POST /migrate/finalize` pattern (`migrate-finalize-route.ts`). Basis TBD: either
  a cheap materialized `endorsement_count` (spec-faithful, no neighbor cascade) or a scoped batch recompute
  of derived confidence.

## Recommended plan

- **P1 — Decide canonical cell metric + update the spec.** Ratify derive-on-read multi-hop confidence as the
  cell metric and **rewrite AD-14** to drop the on-write neighbor-endorsement cascade (it's the trap; it was
  never built). This is a spec change, not just code — AD-14 is provisional, so amend it. Keep
  `endorsementTarget`/decay vocabulary only if it survives the rollup decision (P3).
- **P2 — Batch the N+1 read.** Replace per-cell `querySourceNeighbors` with one viewport-scoped batched
  neighbor lookup (single FTS5 pass / UNION, not per-cell). Measure before/after with `.meta` rows_read.
  Read-side only — no writer impact, but it's the dominant read cost.
- **P3 — Resolve the file/project health rollup (the genuine open question).** Choose the basis and compute
  it **set-based per scope**, never per-edit. If `endorsement_count` stays as the rollup basis, keep its
  write but **collapse the two validate UPDATEs into one** and confirm it's strictly own-row (no fan-out). If
  it doesn't, **delete `endorsement_count` + `idx_cells_decay_drags`** and add a scoped batch refresh.
- **P4 — (optional) KV cache** for cell confidence keyed by `(file, server_seq)`, *iff* P2 read cost still
  warrants it. Measure first.
- **P5 — Verify** (see success criteria).

## Success criteria

- One canonical, documented cell-health model; AD-14 spec amended to match (no on-write neighbor cascade).
- A validate touches **O(1) rows** (its own) — already true; keep it true. No `cell.endorsement` fan-out.
- Viewport read of V cells uses **≤ a small constant number of FTS5 queries** (batched), not V — verified
  via `.meta` rows_read before/after.
- File/project health rollup computed **set-based per scope** (one pass), never per-edit; no scheduled job
  rewriting unviewed cells.
- No dead writes: `endorsement_count` is either consumed by the rollup or removed (with its index).
- **No health-attributable query** reads N²/billions of rows in the D1 Query Performance dashboard.

## Risks / open questions

- **What feeds the manager rollup?** The one real product decision: spec-faithful `endorsement_count`
  (cheap aggregate, but needs the cell metric to agree it's meaningful) vs. a scoped batch recompute of
  derived confidence (matches the editor ring, but a heavier aggregate pass). Decide in P3.
- **AD-13 dependency.** The spec couples AD-14 to AD-13 branching search as the endorsement engine. Dropping
  the on-write cascade means AD-13 stays a *read*-time retrieval primitive only. Confirm nothing else relies
  on AD-13 firing on write.
- **Spec authority.** AD-14 is `provisional`; amending it is in-bounds, but the canonical specs live in
  `~/frontierrnd/aquilla-specs/` — coordinate the edit there, not just in-repo.
- **Read cost at scale** (dense neighborhoods / large files): measure P2; add KV (P4) only if needed.

## References

- `.claude/skills/d1-performance/SKILL.md` — methodology + the file-counter O(N²) case study.
- `~/frontierrnd/aquilla-specs/02-foundations.md:290` (AD-14), `:263` (AD-13) — the product intent to amend.
- `sync-worker/src/lib/confidence/propagate-health.ts` — the prototype cell-health formula + tests.
- `sync-worker/src/events/cell-confidence-route.ts:163` — the N+1 neighbor fetch to batch.
- `sync-worker/src/events/event-projection.ts:508,556` — the two own-row validate UPDATEs.
- `sync-worker/src/events/migrate-finalize-route.ts` — canonical "defer per-row aggregate → one set-based
  statement" to imitate for the rollup.
