# Cell page read scaling (AQU-1160)

No deployment or production mutation is part of this change.

## Problem

`GET /api/v1/projects/:projectId/files/:fileId/cells` had no `LIMIT`/`OFFSET` in
its Postgres query — it pulled every matching row for the file, walked the
anchor chain per side and lane in memory (`walkAnchorChain`), then sliced the
requested page. On a 37,530-cell file that's ~2.85M raw materializations for a
full client load, and every page paid the full-file cost, not just the first.

## What changed

`sync-worker/src/events/cells-read-route.ts` gained an ordered-id chain cache
(see the `AQU-1160: ordered-id chain cache` block in that file). The FIRST page
request for a given `(project, file, side, lane, ETag)` is unchanged — full
query + `walkAnchorChain`, same code path as before — but it now also stores
the resulting ordered list of `{cellId, side, targetLang}` (not row data) in an
isolate-local cache. Every subsequent page for the same version fetches only
that page's rows via a bounded `(side, target_lang, cell_id) IN (...)` point
lookup.

- **New index**: `idx_cells_file_scan` on
  `cells(project_id, file_id, side, target_lang, cell_id)` —
  `db/postgres/migrations/0083_cells_scan_index.sql`, `CREATE INDEX
  CONCURRENTLY`. Backs the bounded page lookup above. (Salvaged from the
  reverted `ef249e914` keyset-pagination attempt — that commit's client-side
  keyset/focus-lock changes were NOT resurrected, only the index was sound.)
- **Cache key**: the route's own `ETag` (`fileId:epoch:rebuiltSeq:maxSeq`,
  already the route's exact "current full state" identity marker) plus
  `projectId`/`side`/`lane`. Any write, rebuild, or re-incarnation changes the
  ETag and the cache misses safely — it never serves stale ordering.
- **Scope**: isolate-local (a `WeakMap<AquillaDb, Map<...>>`, capped at 8
  entries per db instance, 10-minute TTL). No DO/KV — correctness never
  depends on a hit, so a cold isolate just falls back to the pre-AQU-1160 full
  walk. This means the hit rate (and therefore the win) is highest for a
  single warm Worker isolate serving many page requests for the same open
  file in a short window — exactly the "user opens a Bible book and scrolls"
  pattern this ticket targeted.
- **Unaffected**: the `cellIds=` fast path (unpaginated, caller-order) and the
  `?since=` delta path (unordered by design) — neither touches the cache. The
  wire contract (cursor shape, `total`, `maxServerSeq`, `projectEpoch`, ETag
  semantics) is unchanged; the client (`src/lib/sync/cells-read.ts`) needed no
  code change, only a comment update noting the cache exists.

## What did NOT change (and why)

A fully general O(page) guarantee — bounded rows on literally every page,
including the very first page of a file nobody has read yet — would need a
persisted ordering (e.g. a `position`/sequence column maintained by the event
projection) so a page can be answered by an indexed range scan with no prior
materialization. That touches `sync-worker/src/project-do.ts` write path /
event apply, which is out of scope for a read-route fix and needs the
sync-worker owner's decision (see the design-options note on AQU-1160). This
change ships the smallest bounded win available without that: it does not fix
the first page of a cold file, but it fixes every page after it, for as long
as the serving isolate stays warm.

## Rollout

1. Apply `db/postgres/migrations/0083_cells_scan_index.sql` to the intended
   environment. It is one `CREATE INDEX CONCURRENTLY` statement; do not wrap
   it in an explicit transaction or concatenate it with other migrations.
   Check `pg_index.indisvalid` for `idx_cells_file_scan` after an interrupted
   build: `IF NOT EXISTS` alone does not repair an invalid concurrent index.
2. Deploy the sync Worker. No SPA deploy is required — the wire contract is
   unchanged.
3. Compare `/cells` slow-request logs (AGENTS.md → "Slow-request logs") and
   the `[cells-read] chain-cache hit/miss` row-count log lines before and
   after on a large file.

## Verification / test impact

- `sync-worker/src/__tests__/cells-read.test.ts` — new `AQU-1160: chain-order
  cache` describe block:
  - AC1 (bounded rows): a 500-cell linear-chain fixture; asserts the total
    rows read across 4 cache-hit pages stays a small multiple of the page
    size, never approaching the file size.
  - AC2 (ordering equivalence): a fixture combining a sibling tie + orphaned
    sub-chain + two orphan roots (the same shapes the pre-existing AQU-931
    oracle tests use); walks it page-by-page at a tiny limit (so every page
    past the first is a cache hit) and asserts the concatenated pages equal
    an unpaginated oracle read exactly.
  - Cache invalidation: a new event landing between two page reads changes
    the ETag; the cache must not serve the stale ordering.
  - `cellIds=` fast path is unaffected by the cache (existing behavior,
    reasserted).
- Existing 37 tests in the same file (ordering oracle, pagination, lanes,
  sides, conditional reads, delta, resync/epoch/rebuild gates) all pass
  unmodified — the cache sits behind the exact same `walkAnchorChain` oracle
  they already exercise; nothing about the miss path changed.

Commands run:

```sh
cd sync-worker && npx tsc --noEmit
cd sync-worker && npx vitest run src/__tests__/cells-read.test.ts
```

## Central verification (SWARM-TODO — owned by the orchestrator, not this worktree)

- Open a whole-Bible project file on dev; scroll through several pages;
  confirm every page renders in order with correct anchors (no gaps,
  duplicates, or reordering across the scroll).
- Compare per-page slow-request logs before/after this change on the same
  large file; confirm no line at or above 5s (AGENTS.md → "Slow-request
  logs").
- Grep the sync-worker's runtime logs for `[cells-read] chain-cache` lines
  while scrolling; confirm `hit` lines dominate after the first page and their
  `rows=` stays close to the page `limit` regardless of file size.
- Measure and record on AQU-1160: memory/latency opening the LAN party
  project (or an equivalent whole-Bible project) on dev, both before and after
  this change, from production builds — this is AQU-1160's second acceptance
  criterion and is explicitly out of scope for a single worktree to measure in
  isolation (it needs the full dev stack + a stable baseline).
- Run the AQU-1060 six-editor concurrent load test against this change.
