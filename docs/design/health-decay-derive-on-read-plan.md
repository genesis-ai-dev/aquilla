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

## Phase 0 — Investigate current state (DO FIRST; this plan was written without reading the health code)

1. Locate the current implementation. Start: `grep -rinE "health|confidence|decay|endorsement_count|validated" sync-worker/src src` and look at:
   - `sync-worker/src/events/cell-confidence-route.ts` (there's a `handleCellConfidenceRequest` wired in `index.ts`)
   - `sync-worker/src/events/event-projection.ts` (the `validated` flag + `endorsement_count` UPDATEs)
   - the FTS5 search routes (`search-route.ts`, `branching-search-*`)
2. Answer: Is health computed **on read** or **on write** today? What are its inputs (validated neighbors, endorsements, edit recency/decay)? Is there ANY write-time propagation to neighbors right now?
3. Check the **D1 dashboard → Query Performance** for any health/confidence query with high `rows_read` (the O(N²) tell). Note execution count + rows_read.
4. Write findings to the top of this doc before designing further.

## Recommended design — derive-on-read, radius-1

- **Health(cell) = pure function of its immediate (radius-1) neighbors' *current* state** (validated /
  endorsed / edit-recency), computed **at read time**, **scoped to the viewport** being rendered.
- **Writes stay O(1):** a validate/edit/endorse writes ONLY its own row. Neighbors' health is *not*
  recomputed on write — it's recomputed lazily the next time those cells are read.
- **No transitivity.** Health depends on immediate neighbors only. If a wider signal is genuinely needed,
  compute it as a **single set-based project refresh**, never as a per-edit cascade.
- **Decay is derive-on-read too:** compute the time-decay factor from `last_edit_at`/timestamp *at read
  time*. **Do NOT** run a cron that rewrites every cell's health on a schedule — that's a write-
  amplification disaster on a single writer.
- **Index the neighbor lookup** (FTS5 / existing indexes) so health-of-one-cell is `O(k log N)`, not a scan.
- **Optional KV cache** keyed by `(cell, server_seq)` with invalidation when a neighbor's seq advances —
  **only if** read-recompute is measured to be too slow. Measure before adding it.

## Implementation phases

- **P1 — Define the function.** Write `computeHealth(cell, neighbors, now)` as a pure function (inputs,
  formula, radius, decay curve). Unit-test it in isolation (Rule 9: tests encode *why*).
- **P2 — Derive-on-read.** Implement in the read path, viewport-scoped, behind a flag. Neighbor fetch via
  one index-backed query per viewport (batch, not per-cell N+1).
- **P3 — Make writes O(1).** Remove/avoid any write-time neighbor propagation; a change touches only its
  own row. Confirm no projection statement fans out to neighbors.
- **P4 — (optional) KV cache** with seq-based invalidation, *iff* P2 read cost warrants it. Measure first.
- **P5 — Verify** (see success criteria).

## Success criteria

- A write (validate/edit/endorse) touches **O(1) rows** (its own) — no neighbor fan-out, no cascade.
- Reading a viewport of V cells costs **O(V·k)** with index-backed neighbor lookups — **no full-table scan**.
- **No health-attributable query** in the D1 Query Performance dashboard reads N²/billions of rows.
- Derived health **matches a reference batch recompute** (0 mismatches) on a test project.
- No scheduled job rewrites health for unviewed cells.

## Risks / open questions

- **Transitivity:** does confidence legitimately depend on neighbors-of-neighbors? If yes, bound it
  (radius cap) or do a set-based refresh — never cascade on write.
- **Read cost at scale** (large files / dense neighborhoods): measure P2; add the KV cache only if needed.
- **Decay semantics:** confirm decay is purely a read-time function of timestamps (no write sweep).
- **Consistency with migration's derived state:** the migration already uses the canonical pattern —
  `deferFileCounters` + `POST /migrate/finalize` (one set-based recompute per project). Mirror that shape
  for any health "refresh" operation; keep the two derived layers coherent.

## References

- `.claude/skills/d1-performance/SKILL.md` — methodology + the file-counter O(N²) case study.
- `sync-worker/src/events/migrate-finalize-route.ts` — the canonical "defer per-row aggregate → one
  set-based statement" implementation to imitate.
- AD-14 health spec (find in `~/frontierrnd/aquilla-specs/` per project memory) — the product intent.
