# D1 10 GB Limit — Why We Hit It, and Where to Go

_Analysis written 2026-06-04. Scope: `aquilla-db` (the shared D1 behind
`sync-worker` + `frontier-server`)._

## TL;DR

We didn't hit 10 GB because we have 10 GB of *live* project state. We hit it
because **`aquilla-db` is carrying an append-only event log that is never
pruned, and every event row stores the full cell text _and_ its rendered HTML
twice over.** The live, queryable state (the `cells` projection) is a small
fraction of the database; the `events` table is the thing that grows without
bound. The 10 GB ceiling is a hard, un-raisable per-database limit on
Cloudflare D1, so "ask Cloudflare for more" is not an option — the fix is
either to shard, to stop storing what we don't need, or to move the log off D1.

## How the data actually flows today

The sync stack is y-partyserver on Durable Objects + R2 for live collaborative
editing; identity/permissions live in `frontier-server`. D1 (`aquilla-db`) sits
underneath as the **event log + read-model projection**:

- **R2** (`aquilla-snapshots`) holds the canonical Y.Doc snapshots and tail
  updates — this is the real source of truth for live editing state.
- **D1** holds two very different kinds of data in one database:
  1. **Projection tables** — `cells`, `cell_validators`, `cell_audio`,
     `files`. These are *current state only* (upserts/deletes), bounded by the
     number of cells in the corpus. This is what search and reads hit.
  2. **The `events` table** — an **append-only audit log**. Every cell
     mutation writes one row here and it is *never deleted*.

The write path is in `sync-worker/src/events/handlers/cell-events.ts`:

```ts
INSERT OR IGNORE INTO events (
  id, schema_version, project_id, file_id, cell_id, parent_id, kind,
  author, payload, client_ts, server_ts, server_seq
) VALUES (...)
```

…where `payload` is `JSON.stringify(event.payload)`.

## Why it blew up — the three compounding causes

### 1. The event log is append-only with no retention/compaction

There is **no `DELETE FROM events`, no pruning, no compaction, no
VACUUM, no archival-to-cold-storage anywhere** in the codebase (grep confirms
it). Every edit, commit, reorder, validate/unvalidate, and audio attach leaves
a permanent row. The architecture *depends* on this — `rebuild.ts` replays the
full event log to reconstruct projections, and per-cell history surfaces old
rows (including AD-2 "stale branch" rows that lost the first-child race but are
deliberately retained). So the log only ever grows, monotonically, for the life
of the account.

The "archive" path (`project-archive.ts`) is a **soft-delete marker only** — it
broadcasts an archived flag and the durable state lives on identity's project
rows. It does **not** delete events or reclaim a single byte of D1 storage.
Archiving a project does nothing for the size problem.

### 2. Every event row stores the full text *and* the full HTML

Look at the create/commit payloads (`event-projection.ts`,
`sync-worker/src/events/types.ts`): each carries both `value` (plain text) and
`valueHtml` (rendered HTML). Both go into the `events.payload` JSON on **every
edit**, and the current values are *also* stored again in the `cells`
projection row. So for an actively-edited cell we persist:

- the current `value` + `value_html` in `cells` (1×), **plus**
- `value` + `valueHtml` in `events.payload` for **every commit in its
  history** (N×).

`valueHtml` is typically several times larger than the plain text. A cell
edited 20 times stores ~20 copies of its (HTML-inflated) content forever. The
event log is dominated by redundant HTML renderings of text we already have in
plain form.

### 3. Bulk source imports multiply rows massively

The import fast-path (`sync-worker/src/events/import-route.ts`) is explicit
about scale: **"for a 31k-verse eBible that's ~62k subrequests."** A single
source-Bible import mints one `source.cell.create` event per verse — ~31,000
rows, each carrying `value` + `valueHtml` — plus 31,000 projection rows. Every
imported source file is tens of thousands of permanent event rows before a
single human edit happens. Multiply by every project × every source/target
file × every re-import, and the 10 GB ceiling arrives fast.

### And it's one shared database

`aquilla-db` is shared across **all projects and all tenants** (single DB id in
`wrangler.toml`, plus a separate staging one). There is no per-project or
per-tenant sharding, so *every* project's unbounded event log accumulates into
*one* 10 GB bucket. D1 is explicitly designed to be scaled the opposite way —
many small databases, not one big one.

## Why "get a bigger D1" isn't on the table

Per Cloudflare's current docs, the **10 GB per-database limit cannot be
increased** — D1 is built on SQLite and is designed for horizontal scale-out
across many small databases, not vertical growth. On a Workers Paid plan you
get 10 GB/db (up from the old 2 GB) and up to **50,000 databases per account**
(free tier: 500 MB/db, 10 dbs). So within Cloudflare the only lever is *more
databases*, not *a bigger one*.

---

## Options

I've split these into (A) things that buy headroom on the current stack with
minimal disruption, and (B) moving the heavy data off D1 — including non-
Cloudflare destinations, since the prompt explicitly opened that up.

### A. Stay on D1, attack the size — cheapest first

These are worth doing **regardless** of any larger migration, because they cut
the growth rate at the source.

1. **Stop storing `valueHtml` in the event log (likely the single biggest
   win).** HTML is a derived rendering of `value`; it doesn't belong in an
   audit log. Drop `valueHtml` from `events.payload` (keep it only in the
   `cells` projection where the live UI needs it, or regenerate it on read).
   This shrinks the fastest-growing column on every historical row. Low risk,
   high payoff.
2. **Compress payloads.** Store `events.payload` gzip/zstd-compressed (or at
   least dictionary-compressed JSON). Event payloads are highly repetitive
   text/HTML and compress extremely well — often 5–10×. Transparent to
   queries that don't filter on payload internals.
3. **Introduce event-log retention / compaction.** Because projections are
   rebuildable and snapshots live in R2, the *full* event history is not
   strictly required forever. Options:
   - Periodically **snapshot a projection checkpoint** and delete events older
     than it (keep last-N events per cell for history UI, archive the rest).
   - **VACUUM** after large deletes to actually reclaim pages.
   This is the structural fix for "append-only forever."
4. **Move the event log to cold storage, keep only projections in D1.** Write
   events as compressed NDJSON/Parquet to **R2** (you already have an R2
   bucket and R2 has no practical size cap and far cheaper $/GB). D1 then holds
   only the bounded projection tables — `cells` et al. — which are small and
   query-fast. History/rebuild reads replay from R2. This is probably the
   highest-leverage Cloudflare-native move: it keeps the hot path on D1's SQL
   while the unbounded data lands in object storage.
5. **Shard D1 per project/tenant.** D1's intended scaling model. One database
   per project (or per org) means each project gets its own 10 GB budget and
   50,000 of them per account = ~500 TB addressable. Requires a routing layer
   (project → database id) and migration tooling; `scripts/pr-db-fork.sh`
   suggests some multi-DB plumbing already exists. More engineering, but stays
   100% on the current platform.

### B. Move the store off Cloudflare (or partially)

Worth it if the relational/event workload is outgrowing D1's model, you want
no per-DB ceiling, or you want richer query/analytics on the log.

| Option | Shape | Why it fits | Watch-outs |
|---|---|---|---|
| **Turso (libSQL)** | SQLite-compatible, edge-replicated | Closest drop-in to D1 — same SQLite SQL, multi-DB / DB-per-tenant is its core model, no 10 GB wall | Another vendor; egress/replication cost |
| **Neon / Supabase (Postgres)** | Serverless Postgres | No fixed size cap, branching, strong analytics & partial indexes; great for the projection tables | Not edge-local; connection model differs from Workers (use HTTP/serverless driver) |
| **PlanetScale / Vitess (MySQL)** | Horizontally sharded MySQL | Built for sharding huge OLTP at scale | Heavier ops; relational only |
| **R2 / S3 + Parquet + DuckDB/Athena** | Object-store event lake | Ideal home for the *append-only log* specifically — cheap, unbounded, analytics-friendly | Not a transactional store; pair with a small hot DB for projections |
| **ClickHouse / Tinybird** | Columnar OLAP | Purpose-built for high-volume append-only event data with great compression | OLAP semantics, not your transactional read path |
| **Postgres + a queue (managed RDS/Aurora)** | Classic event-sourcing stack | Maximum control, mature event-sourcing patterns | You run more infra; loses edge locality |

The pragmatic hybrid most teams land on: **keep the bounded, latency-sensitive
projection (`cells`, `cell_validators`, …) on an edge SQL store (D1 or Turso),
and push the unbounded append-only `events` log to object storage (R2/S3) as
compressed Parquet/NDJSON**, queried with DuckDB/ClickHouse when you need
history or analytics. That removes the 10 GB pressure permanently without
giving up the edge read path.

## Recommended sequence

1. **Immediate (days):** stop writing `valueHtml` into `events.payload`;
   compress payloads. Buys headroom now, no architecture change. (Option A1+A2)
2. **Short term (weeks):** offload the event log to R2 (compressed NDJSON/
   Parquet); keep only projections in D1. (Option A4) — likely resolves the
   limit outright on the current stack.
3. **If multi-tenant growth continues:** either shard D1 per project (A5,
   stay on Cloudflare) or move the projection store to Turso/Neon (B) for an
   unbounded SQL home.

Steps 1–2 are reversible, low-risk, and stay entirely within the existing
Cloudflare footprint, so they're the right first moves before committing to any
vendor migration.

## Sources

- [Cloudflare D1 — Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 — FAQs (scaling / 10 GB)](https://developers.cloudflare.com/d1/reference/faq/)
- [Cloudflare Workers — Storage options](https://developers.cloudflare.com/workers/platform/storage-options/)
