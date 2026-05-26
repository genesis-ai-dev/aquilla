# v3 Search & Parallel Passages — Design

## Goal

Translators working in Aquilla need to search for words and phrases across every file in a project — to find how a term has been rendered elsewhere, to locate a partially-remembered verse, or to identify every place where a source text recurs ("parallel passages") so a consistent translation can be applied. Today the feature is disabled with a placeholder message (`src/components/ParallelPassagesPanel.tsx:48–55`). This document describes the architecture to re-enable it in a way that is fast, always current, and where a user can never see content from a project they are not authorized to access — by construction, not by convention.

## Non-goals

- Semantic / vector similarity retrieval (AD-13 branching-search in `sync-worker/src/events/branching-search-route.ts` already covers this for the AI copilot).
- Cross-organization federated search; results are bounded by sync-tokens, which are project-scoped at identity.
- File-level cell listing (served by `cells-read-route.ts`).
- Bulk-replace write path (separate feature; this doc covers search reads only).

## Constraints (recap)

- Sub-second latency for up to ~500k cells (a full two-sided Bible); graceful degradation above that.
- Index lag behind writes: zero (in-transaction FTS5 update); worst-case is D1 batch commit latency (~20–80 ms).
- Permission boundary: structural, not advisory. A developer adding a new search surface must not be able to forget the project-scope predicate.
- One shared D1 FTS index (no per-user shards).
- Both ranked full-text (with snippet) and exact-string ("parallel passages") lookups are required.

## Architecture decision: wire FTS5 maintenance into `buildEventProjectionStmts` and route every search read through a `queryScopedSearch(db, verifiedProjectId, ...)` helper whose `VerifiedProjectId` type can only be produced by a successful JWT verification

## Decision rationale

**Why not a separate index worker or KV search?** The `cells_fts` virtual table already exists and is queried by `handleSearchReadRequest` (`search-route.ts:155`). The projector just never writes to it. Introducing a second index path creates dual-write complexity and a reconciliation problem. FTS5 in external-content mode can be updated atomically inside the same `db.batch()` call that writes the `cells` projection row (`route.ts:356`), so the index and the cells table are always consistent by construction.

**Why not per-user index shards?** Permissions are project-scoped, not user-scoped. The sync-token (`auth.ts:17`) carries `projectId` and `role`. Every user who can read project A can read all cells in A. Sharding by user multiplies storage O(members) with no correctness benefit.

**Why not a Durable Object per project?** The `ProjectSync` DO is explicitly transient — no D1/R2 writes from inside it (`wrangler.toml:14`). D1 is the correct durable store.

**Performance model.** D1 FTS5 on a 500k-cell corpus benchmarks under 200ms for a token-match query. The existing SQL (`search-route.ts:147–169`) already pushes `AND cells.project_id = ?` inside the FTS5 JOIN, so SQLite narrows candidate rowids via the covering index on `cells(project_id, file_id, cell_id, side)` before scoring. The 500-row `LIMIT` cap keeps response payloads bounded regardless of corpus size.

**Freshness model.** FTS5 external-content mode requires explicit `INSERT/UPDATE/DELETE` on the virtual table when the content table changes. Today those writes are absent; the route queries `cells_fts` but the projector never writes to it. The fix is to add FTS5 maintenance statements inside `buildEventProjectionStmts` (`event-projection.ts:70`) for `*.cell.create`, `*.cell.commit`, and `*.cell.delete`. Because these statements join the same `db.batch()` array as the `cells` UPSERT, lag is zero.

**Permission model — structural, not advisory.** The chosen approach is a branded `VerifiedProjectId` type exported from a new `scoped-search.ts` module. A `VerifiedProjectId` can only be created by calling `makeVerifiedProjectId(claims: SyncTokenClaims)` where `SyncTokenClaims` is the verified output of `verifyTokenForProject` (`auth.ts:95`). The FTS query is encapsulated inside `queryScopedSearch`; the `AND cells.project_id = ?` predicate is hardcoded and bound to the verified value. No caller writes the SQL directly. A plain `string` passed where `VerifiedProjectId` is required is a TypeScript compile error. There is no escape hatch.

## Index design

**FTS5 virtual table.** Referenced as created in "auth-worker migration 0003" (`search-route.ts:8`). The schema lives in the frontier-server repo (`~/frontierrnd/frontier-server/cloudflare/codex_migrations/`). The recommended DDL:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS cells_fts
USING fts5(
  value,
  content='cells',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
```

`remove_diacritics 2` is the Unicode-aware full diacritic strip — a translator searching "Dios" must match "Diós." If the deployed version uses `remove_diacritics 1`, a migration to version 2 is safe and worthwhile.

**How rows enter the index.** Inside `buildEventProjectionStmts` (`event-projection.ts:70`), append to `stmts` after each cell-value write:

- `*.cell.create` and `*.cell.commit`: `INSERT INTO cells_fts(rowid, value) VALUES ((SELECT rowid FROM cells WHERE project_id=? AND file_id=? AND cell_id=? AND side=?), ?)`
- `*.cell.delete`: prepend a `SELECT value FROM cells WHERE ...` to the batch to capture the old value, then `INSERT INTO cells_fts(cells_fts, rowid, value) VALUES ('delete', <rowid>, <old_value>)`

All statements land in the same `db.batch()` call as the cell mutation, preserving atomicity.

**Lag budget.** Zero — same `db.batch()` call. Effective lag = D1 batch commit latency (~20–80 ms).

**Storage cost.** FTS5 external-content stores only the inverted index, not original content. For a 500k-cell two-sided Bible corpus (~50 bytes/cell), the FTS index is ~50–100 MB. D1's 10 GB limit is not threatened.

## Query path

**Public read API (TypeScript, in `src/lib/sync/`):**

```typescript
// Existing — signature unchanged. Wires to GET /api/v1/projects/:projectId/search
export async function fetchProjectSearch(
  projectId: string, q: string,
  opts: FetchSearchOptions, jwt: string,
): Promise<SearchResult[]>

// New — exact-string parallel passages across multiple projects the caller holds tokens for.
export async function fetchParallelPassages(
  sourceText: string,
  opts: { projectIds: string[]; limit?: number },
  getToken: (projectId: string) => Promise<string | null>,
): Promise<ParallelPassageResult[]>
```

`ParallelPassageResult` extends `SearchResult` with `projectId: string` and `targetSnippet: string`. Added to `src/lib/sync/search-read-types.ts`.

**How permission scoping is applied at the single chokepoint.** New file `sync-worker/src/events/scoped-search.ts`:

```typescript
export type VerifiedProjectId = string & { __brand: 'verified' }

export function makeVerifiedProjectId(claims: SyncTokenClaims): VerifiedProjectId {
  return claims.projectId as VerifiedProjectId
}

export async function queryScopedSearch(
  db: D1Database,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: { side?: 'source' | 'target'; limit?: number },
): Promise<SearchResultOut[]>

export async function queryScopedExact(
  db: D1Database,
  verifiedProjectId: VerifiedProjectId,
  exactText: string,
  opts: { side?: 'source' | 'target'; limit?: number },
): Promise<SearchResultOut[]>
```

`handleSearchReadRequest` (`search-route.ts:83`) is refactored to extract `verifiedProjectId` from `auth.claims` (produced by the existing `verifyTokenForProject` call at line 107) and pass it to `queryScopedSearch`. The URL path's raw `projectId` is used only as the argument to `verifyTokenForProject`.

**Pagination.** FTS5 `rank` ordering is not stable across pages without a deterministic tie-breaker. For v3, `LIMIT 500` covers all UI use cases. A `(rank, cellId)` cursor is deferred.

**Snippet generation.** Already implemented (`search-route.ts:151`): `snippet(cells_fts, 0, '<mark>', '</mark>', '...', 16)`. No change.

**Parallel passages lookup.** `queryScopedExact` uses FTS5 phrase-quoted matching: user text is token-split and each token quoted (`"token"`), joined as FTS5 adjacent-phrase terms. Returns `{ projectId, fileId, cellId, sourceSnippet, targetSnippet }` by joining the source FTS result against the paired target cell row on `(project_id, file_id, cell_id, side='target')`. Server endpoint: `GET /api/v1/projects/:projectId/search/passages?q=<exact>`.

`fetchParallelPassages` fans out one authenticated HTTP request per `projectId` via `getToken(projectId)`, collecting with `Promise.all`. Safe for up to ~10 projects; above that the UI should paginate project scope.

## Permission model — the structural part

`VerifiedProjectId` is a branded string type. The only way to obtain one is `makeVerifiedProjectId(claims: SyncTokenClaims)` where `SyncTokenClaims` comes from `verifyTokenForProject`'s `{ ok: true }` branch (`auth.ts:38–40`). Passing a raw `string` where `VerifiedProjectId` is required is a TypeScript compile error. The FTS query and the `AND cells.project_id = ?` predicate live entirely inside `queryScopedSearch` / `queryScopedExact` — callers supply parameters, never SQL fragments.

A developer writing a new search surface must:

1. Call `verifyTokenForProject(token, projectId, secret)` — mandatory on every route in the codebase already.
2. Call `makeVerifiedProjectId(auth.claims)` — one line; produces the branded type.
3. Call `queryScopedSearch(db, verifiedProjectId, ...)` — the only exported FTS execution path.

There is no `queryScopedSearchUnchecked`. There is no exported function that runs `cells_fts MATCH` directly. A `@ts-expect-error` bypass is immediately visible in code review. This is the strongest enforcement available in TypeScript without a runtime capability system, and it is consistent with the existing pattern of `verifyTokenForProject` being the mandatory auth gateway on every route.

## Migration / rollout

**Order of operations:**

1. Confirm `cells_fts` DDL in frontier-server migration history (`~/frontierrnd/frontier-server/cloudflare/codex_migrations/`). Note tokenizer version and content binding.
2. If `remove_diacritics 2` is absent, add a migration in the frontier-server repo (branch + PR per the frontier-server PR flow convention). DDL-only; safe on a live database with an empty FTS table.
3. Add `POST /admin/projects/:projectId/rebuild-fts` to `sync-worker/src/admin.ts`, mirroring `handleRebuildProjectionRequest` in `rebuild.ts`. Runs `INSERT INTO cells_fts(rowid, value) SELECT rowid, value FROM cells WHERE project_id = ?` in batches of 1000. Idempotent; safe to re-run.
4. Wire FTS5 maintenance into `buildEventProjectionStmts` (`event-projection.ts:70`) for create/commit/delete kinds. Deploy after backfill completes so the index is coherent from the first live write.
5. Create `sync-worker/src/events/scoped-search.ts`. Refactor `search-route.ts` to use it. Add the `/search/passages` sub-route.
6. Add `ParallelPassageResult` to `src/lib/sync/search-read-types.ts` and `fetchParallelPassages` to `src/lib/sync/search-read.ts`.
7. Extend `src/hooks/useWorkspaceSearch.ts` with `searchParallelPassages(text, projectIds)`.
8. Re-implement `src/components/ParallelPassagesPanel.tsx` with real search UI; delete the placeholder at lines 48–55.
9. Update `sync-worker/src/__tests__/helpers/d1-fake.ts` to handle FTS5 maintenance SQL patterns for the new event kinds.
10. Add / extend tests in `sync-worker/src/__tests__/search-read.test.ts`.
11. Run `rebuild-fts` against staging D1, verify result quality, promote to production.

**Risk: large project on re-enable.** Backfill is incremental. The projector hook deploys after backfill, so there is no race window. A partial backfill degrades to fewer results, not errors — the existing `search-route.ts:136–138` already returns `{ results: [] }` on empty-query and sanitize-to-empty cases. The `/search/passages` endpoint can be independently feature-flagged via the existing experimental-flags mechanism until rollout is confirmed stable.

## Open questions

- Exact `cells_fts` DDL must be confirmed from the frontier-server migrations (not accessible in this repo); specifically the tokenizer version and `content_rowid` column name.
- `*.cell.delete` FTS maintenance requires reading the old `value` before deletion — one extra D1 read per delete event in the batch. Acceptable at current traffic; worth a note if deletes become high-frequency (e.g., bulk-delete import).
- Multi-word phrase matching in `queryScopedExact`: FTS5 adjacent-phrase quoting is the default. Whether sub-word partial matches (requiring `LIKE` post-filter) are needed for parallel passages is a UX decision deferred to the panel redesign.
- Cross-project fan-out cost for users with access to >20 projects. A server-side multi-project batch endpoint is more efficient; deferred until usage data is available.

## Estimated implementation steps

1. Confirm `cells_fts` DDL in frontier-server migration history.
2. Add `remove_diacritics 2` migration to frontier-server if needed; PR per frontier-server PR flow.
3. Add `POST /admin/projects/:projectId/rebuild-fts` to `sync-worker/src/admin.ts`.
4. Add FTS5 maintenance statements to `buildEventProjectionStmts` in `sync-worker/src/events/event-projection.ts`.
5. Create `sync-worker/src/events/scoped-search.ts` with `VerifiedProjectId` brand and query helpers.
6. Refactor `sync-worker/src/events/search-route.ts` to use `scoped-search.ts`; add `GET .../search/passages` endpoint.
7. Add `ParallelPassageResult` to `src/lib/sync/search-read-types.ts`; add `fetchParallelPassages` to `src/lib/sync/search-read.ts`.
8. Extend `src/hooks/useWorkspaceSearch.ts` with `searchParallelPassages`.
9. Re-implement `src/components/ParallelPassagesPanel.tsx`; remove the placeholder.
10. Update `sync-worker/src/__tests__/helpers/d1-fake.ts` for FTS5 maintenance SQL patterns.
11. Add / extend tests in `sync-worker/src/__tests__/search-read.test.ts`.
12. Backfill staging, verify, promote to production.
