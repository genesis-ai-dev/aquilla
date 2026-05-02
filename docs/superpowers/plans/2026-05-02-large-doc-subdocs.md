# Large-Document Subdoc Segmentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manifest + chunk-doc segmentation for files above a measured size threshold (5,000 cells or 2 MB). Single-doc files are unchanged. The Bible-as-one-file case is the motivating fixture; the mechanism is generic.

**Spec:** `docs/superpowers/specs/2026-05-02-large-doc-subdocs-design.md`

**Tech Stack:**
- Y.js, IndexedDB persistence (existing).
- y-partyserver Durable Objects + R2 (sync-worker, existing).
- frontier-server D1 (`codex-db.files`) for the file-row rollup.
- React + the existing `useFileSync` hook.
- vitest for unit tests; happy-dom for hook tests.

**Worktree:** create at `.worktrees/large-doc-subdocs` on branch `feat/large-doc-subdocs` before starting.

---

## File map

New files:
- `src/lib/store/chunk-resolver.ts` — `chooseChunkBoundaries`, `resolveChunkForCell`
- `src/lib/store/chunk-resolver.test.ts`
- `src/lib/store/manifest-doc.ts` — manifest doc shape helpers
- `src/lib/store/manifest-doc.test.ts`
- `src/lib/store/chunked-file-doc.ts` — `createChunkedDocs`, `loadManifestDoc`
- `src/lib/store/chunked-file-doc.test.ts`
- `src/hooks/useChunkSync.ts` — chunk-level Y.Doc + provider lifecycle
- `src/hooks/useChunkSync.test.tsx`
- `sync-worker/src/migration.ts` — one-shot legacy split
- `sync-worker/src/__tests__/migration.test.ts`
- `frontier-server/cloudflare/migrations/0NNN_chunked_files.sql` — `chunk_count` + `chunked_reason` columns

Modified files:
- `src/lib/store/file-doc.ts` — split `createFileDoc` to call `createChunkedDocs` above threshold
- `src/lib/sync/partyserver-provider.ts` — extend docId parsing for `--{chunkId}` suffix
- `src/hooks/useFileSync.ts` — branch on `meta.chunked` after manifest hydrate
- `src/components/EditorTable.tsx` (or equivalent cell-render entry) — accept a chunk-resolver when in chunked mode
- `sync-worker/src/index.ts` — extend `parseDocId`, route chunk DOs through the same `FileSync` class
- `sync-worker/src/projection.ts` — add `projectManifestDoc` (file-row rollup only)
- `sync-worker/src/wrangler.toml` — verify the `FileSync` DO namespace handles the new room-name shape (no new binding needed; same class)

---

## Phase A — Pure-logic foundations (no integration risk)

### Task A1: Boundary chooser

**Files:**
- Create: `src/lib/store/chunk-resolver.ts`
- Test: `src/lib/store/chunk-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest"
import { chooseChunkBoundaries, isAboveThreshold } from "./chunk-resolver"

function mk(id: string, group: string, size = 100) {
  return { id, group, originalBytes: size }
}

describe("isAboveThreshold", () => {
  it("returns false for small files", () => {
    expect(isAboveThreshold([mk("a", "G")])).toBe(false)
  })
  it("returns true at 5001 cells", () => {
    const cells = Array.from({ length: 5001 }, (_, i) => mk(`c${i}`, "G", 100))
    expect(isAboveThreshold(cells)).toBe(true)
  })
  it("returns true at 2_000_001 bytes regardless of cell count", () => {
    const cells = Array.from({ length: 100 }, (_, i) => mk(`c${i}`, "G", 20_001))
    expect(isAboveThreshold(cells)).toBe(true)
  })
})

describe("chooseChunkBoundaries", () => {
  it("returns single chunk when below threshold", () => {
    const cells = Array.from({ length: 100 }, (_, i) => mk(`c${i}`, "G"))
    const chunks = chooseChunkBoundaries(cells)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].cellIds).toHaveLength(100)
  })

  it("aligns chunks to group boundaries when possible", () => {
    // 6000 cells in 6 groups of 1000 each → 6 chunks, one per group
    const cells: ReturnType<typeof mk>[] = []
    for (let g = 0; g < 6; g++) {
      for (let i = 0; i < 1000; i++) cells.push(mk(`g${g}-${i}`, `G${g}`))
    }
    const chunks = chooseChunkBoundaries(cells)
    expect(chunks).toHaveLength(6)
    expect(chunks[0].label).toContain("G0")
    expect(chunks[5].label).toContain("G5")
  })

  it("respects hard cap of 1500 cells per chunk", () => {
    // 6000 cells, all in one group → split at hard cap
    const cells = Array.from({ length: 6000 }, (_, i) => mk(`c${i}`, "G"))
    const chunks = chooseChunkBoundaries(cells)
    for (const c of chunks) expect(c.cellIds.length).toBeLessThanOrEqual(1500)
  })

  it("never splits a single group across chunks if group fits in hard cap", () => {
    // 4 groups of 800 cells each → 4 chunks, each one full group
    const cells: ReturnType<typeof mk>[] = []
    for (let g = 0; g < 4; g++) {
      for (let i = 0; i < 800; i++) cells.push(mk(`g${g}-${i}`, `G${g}`))
    }
    const chunks = chooseChunkBoundaries(cells)
    expect(chunks).toHaveLength(4)
  })

  it("emits stable chunk ids (deterministic given same input)", () => {
    const cells = Array.from({ length: 6000 }, (_, i) => mk(`c${i}`, `G${Math.floor(i / 1000)}`))
    const a = chooseChunkBoundaries(cells)
    const b = chooseChunkBoundaries(cells)
    expect(a.map(c => c.chunkId)).toEqual(b.map(c => c.chunkId))
  })
})
```

- [ ] **Step 2: Implement**

Implementation sketch:
- `isAboveThreshold` returns `cellCount > 5000 || sumBytes > 2_000_000`.
- `chooseChunkBoundaries` walks cells in order, opens a new chunk when (a) hard cap (1500) reached or (b) target (1000) reached AND next cell starts a new group.
- Chunk id: stable hash of `firstCellId` (sha256 truncated to 12 hex chars) so re-running on the same input produces the same id.
- Label: `<firstGroup> – <lastGroup>` if they differ; otherwise `<firstGroup>`. If group is empty, use `cells <firstId>–<lastId>`.

- [ ] **Step 3: Run tests; commit.**

### Task A2: Manifest doc shape

**Files:**
- Create: `src/lib/store/manifest-doc.ts`
- Test: `src/lib/store/manifest-doc.test.ts`

- [ ] **Step 1: Write failing tests** for `buildManifestDoc(fileMeta, chunks)`, `readManifest(doc)`, `mutateManifestForCellMove(doc, cellId, fromChunk, toChunk)`. Cover the round-trip and the cell-move helper.

- [ ] **Step 2: Implement**

```ts
export interface ChunkRef {
  chunkId: string
  label: string
  firstCellId: string
  lastCellId: string
  cellCount: number
}

export interface ManifestSnapshot {
  meta: { fileId: string; fileName: string; sourceLang: string; targetLang: string;
          chunked: true; chunkedReason: string }
  order: string[]                 // full cell-id sequence
  chunks: ChunkRef[]
  cellChunkMap: Record<string, string>  // cellId → chunkId
}

export function buildManifestDoc(fileMeta, chunks): Y.Doc { /* ... */ }
export function readManifest(doc): ManifestSnapshot { /* ... */ }
```

- [ ] **Step 3: Run tests; commit.**

### Task A3: Chunked-file builder

**Files:**
- Create: `src/lib/store/chunked-file-doc.ts`
- Test: `src/lib/store/chunked-file-doc.test.ts`

- [ ] **Step 1: Failing test** — `createChunkedDocs(fileId, ..., strings)` returns `{ manifest: FileDocHandle, chunks: Map<chunkId, FileDocHandle> }`. Each chunk handle is a `FileDocHandle` of the same shape `createFileDoc` returns today (so consumers don't need to know the difference). Manifest handle persists to `codex:file:{fileId}:manifest` IDB; chunks to `codex:file:{fileId}:chunk:{chunkId}`.

- [ ] **Step 2: Implement.** Reuse `createFileDoc`-style transactions for each chunk. Compute boundaries via Task A1, then for each chunk build a doc with that chunk's cells (`cells` map, `order` array, `meta` with `chunkId` + `chunked-of: fileId`). Build the manifest doc via Task A2.

- [ ] **Step 3: Test that re-creating from the same input produces stable chunk IDs and identical R2-equivalent encodings (`Y.encodeStateAsUpdate` byte-for-byte equal modulo timestamps).**

- [ ] **Step 4: Commit.**

### Task A4: Threshold-gated factory in `file-doc.ts`

**Files:**
- Modify: `src/lib/store/file-doc.ts`
- Test: extend `src/lib/store/file-doc.rehydrate.test.ts` (or create new) with above-threshold case

- [ ] **Step 1: Wrap the existing `createFileDoc`.** Below threshold → existing path unchanged. Above threshold → call `createChunkedDocs` from Task A3. Return a discriminated union:

```ts
export type FileDocResult =
  | { kind: "single"; handle: FileDocHandle }
  | { kind: "chunked"; manifest: FileDocHandle; chunks: Map<string, FileDocHandle> }
```

- [ ] **Step 2: Updaters** — find every caller of `createFileDoc` (importers). Add explicit handling for the chunked case at the call site, or have the importer flatten it back to a list of `FileDocHandle`s and let the next layer deal with routing.

- [ ] **Step 3: Test + commit.**

---

## Phase B — Sync layer (server + client wiring)

### Task B1: docId parsing extension

**Files:**
- Modify: `sync-worker/src/index.ts` (extend `parseDocId`)
- Modify: `src/lib/sync/partyserver-provider.ts` (parallel parser on the client)
- Tests: extend existing parser tests

- [ ] **Step 1:** `parseDocId("p--f")` → `{projectId, fileId, chunkId: null, isManifest: true}`. `parseDocId("p--f--c")` → `{projectId, fileId, chunkId: "c", isManifest: false}`.

- [ ] **Step 2:** Below-threshold files keep the 2-part form, so legacy DOs keep working.

- [ ] **Step 3:** Add `chunked: true` recognition in the manifest case — `onLoad` reads `meta.chunked` and short-circuits the "load cells from R2" path because the manifest's R2 namespace is `manifest/snapshot.bin`, not `snapshot.bin`.

- [ ] **Step 4:** Test + commit on both repos (sync-worker and src/).

### Task B2: R2 layout + DO `onLoad` / `onSave` for the new layout

**Files:**
- Modify: `sync-worker/src/index.ts` — `snapshotKey`, `tailPrefix`, `compactToSnapshot`

- [ ] **Step 1:** Helpers conditionalize on `chunkId`:
  ```
  snapshotKey(projectId, fileId, chunkId): chunkId == null && manifest
    ? `projects/${pid}/files/${fid}/manifest/snapshot.bin`
    : chunkId
      ? `projects/${pid}/files/${fid}/chunks/${chunkId}/snapshot.bin`
      : `projects/${pid}/files/${fid}/snapshot.bin`           // legacy
  ```

- [ ] **Step 2:** `onLoad` sniffs which keys exist — prefer the new layout, fall back to legacy. This makes the migration safe (Phase C).

- [ ] **Step 3:** Test the three layouts via the existing `__tests__/compaction.test.ts` style; commit.

### Task B3: Projection split

**Files:**
- Modify: `sync-worker/src/projection.ts` — add `projectManifestDoc`

- [ ] **Step 1:** Existing `projectDoc` is the chunk-scope projection. It writes per-cell rows + a chunk-scope rollup (a new lightweight `chunks` table — *or* don't introduce a new table and just project per-cell + skip the chunk rollup. Pick the simpler — skip).

- [ ] **Step 2:** New `projectManifestDoc(fileId, manifestDoc)` writes `files.chunk_count`, `files.chunked_reason`, and `files.last_edit_at = max(chunk last_edit_at)`. Other file-row counters (`cell_count`, `approved_count`, `word_count`) are SUM-aggregated in D1 from the `cells` table — no scan-on-save needed; a single SQL UPDATE per manifest save.

- [ ] **Step 3:** Test + commit.

### Task B4: D1 schema additions

**Files:**
- Create: `frontier-server/cloudflare/migrations/0NNN_chunked_files.sql`

```sql
ALTER TABLE files ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN chunked_reason TEXT;
```

- [ ] **Step 1:** Add migration + apply locally.

- [ ] **Step 2:** Verify the existing SUM-aggregation queries (file rollup endpoints) still work — `chunk_count` is informational only.

- [ ] **Step 3:** Commit on the frontier-server repo.

### Task B5: Client-side `useChunkSync` hook

**Files:**
- Create: `src/hooks/useChunkSync.ts`
- Test: `src/hooks/useChunkSync.test.tsx`

- [ ] **Step 1:** API:

```ts
function useChunkSync(fileId: string, chunkId: string | null): {
  doc: Y.Doc | null
  state: "loading" | "ready" | "error"
}
```

`chunkId == null` returns `{doc: null, state: "ready"}`. Otherwise mounts a Y.Doc on `codex:file:{fileId}:chunk:{chunkId}` IDB room with a y-partyserver provider opened to `{projectId}--{fileId}--{chunkId}`.

- [ ] **Step 2:** LRU eviction in `useChunkSync` registry: keep last 3 chunks per file, destroy older.

- [ ] **Step 3:** Test multi-chunk lifecycle (open 4 chunks → first one destroyed; reopening it re-hydrates from IDB).

- [ ] **Step 4:** Commit.

### Task B6: Branch `useFileSync` on chunked manifests

**Files:**
- Modify: `src/hooks/useFileSync.ts`

- [ ] **Step 1:** After manifest hydrate, expose:
  ```ts
  {
    isChunked: boolean
    manifest: ManifestSnapshot | null
    activeChunkId: string | null
    setActiveChunk: (cellId: string) => void   // resolves cellId → chunkId
  }
  ```

- [ ] **Step 2:** Editor consumes `activeChunkId` and pulls its Y.Doc from `useChunkSync(fileId, activeChunkId)`.

- [ ] **Step 3:** Test the flow with a synthetic chunked file: open file → see manifest cells in the list immediately → click a cell → chunk loads → cell renders.

- [ ] **Step 4:** Commit.

---

## Phase C — Migration of existing oversized files

### Task C1: Migration module

**Files:**
- Create: `sync-worker/src/migration.ts`
- Test: `sync-worker/src/__tests__/migration.test.ts`

- [ ] **Step 1:** `migrateLegacyToChunked(env, projectId, fileId)`:
  1. Read `projects/{pid}/files/{fid}/snapshot.bin` + tails.
  2. Load into a temporary Y.Doc.
  3. Extract cells.
  4. Run `chooseChunkBoundaries`.
  5. For each chunk, build a Y.Doc, encode, write `chunks/{chunkId}/snapshot.bin`.
  6. Build manifest doc, write `manifest/snapshot.bin`.
  7. Update `codex-db.files` SET `chunk_count = N, chunked_reason = …`.
  8. Delete legacy `snapshot.bin` + tails.

- [ ] **Step 2:** Idempotency test: run migration twice; second run is a no-op (detects new keys exist).

- [ ] **Step 3:** Crash-safety test: simulate failure at each step; assert legacy path remains usable until step 7.

- [ ] **Step 4:** Commit.

### Task C2: Migration trigger

**Files:**
- Modify: `sync-worker/src/index.ts` — `onLoad` schedules migration when threshold met

- [ ] **Step 1:** In `onLoad`, after hydrating the legacy snapshot, count cells. If `cellCount > 5000` and `meta.chunked != true`, schedule `ctx.waitUntil(migrateLegacyToChunked(env, pid, fid))`.

- [ ] **Step 2:** Migration runs once. Future connects see the new layout. The currently-connected client keeps its session on the legacy doc until it disconnects; on next connect it gets routed to manifest + chunks.

- [ ] **Step 3:** Add a feature flag check — only schedule when `large-doc-subdocs` is on for this project.

- [ ] **Step 4:** Test + commit.

---

## Phase D — Importer integration (Bible motivating case)

### Task D1: Importer awareness

**Files:**
- Modify: importer for whole-Bible / single-file imports (find via `grep -rn "createFileDoc" src/`)

- [ ] **Step 1:** Importer calls the threshold-gated factory from Task A4. For below-threshold files (the per-book Bible default), nothing changes. For above-threshold files (whole-Bible-as-one-file, large article imports), the factory returns the chunked result and the importer registers all the chunk handles + manifest handle.

- [ ] **Step 2:** Add an integration test: import a 6,000-cell synthetic file; assert `chunk_count > 0` in D1; assert manifest + chunk DOs exist via R2 head.

- [ ] **Step 3:** Commit.

### Task D2: Editor consumption

**Files:**
- Modify: `src/components/EditorTable.tsx` (or whichever component owns the cell list)

- [ ] **Step 1:** When `useFileSync` reports `isChunked: true`, the editor list renders from `manifest.order` + per-cell metadata (D1 fetch via existing endpoint). Editing a row activates `setActiveChunk(cellId)`; the row's editor binds to the chunk doc's cell once `useChunkSync` reports `state: "ready"`.

- [ ] **Step 2:** Display a per-row loading state during chunk hydration (skeleton or spinner; one per chunk, not per cell).

- [ ] **Step 3:** Manual test in dev — import a 31k-cell synthetic Bible, scroll, edit cells in different chunks, confirm correct chunk hydration + LRU eviction. Run the smoke suite.

- [ ] **Step 4:** Commit.

---

## Phase E — Rollout

### Task E1: Experimental flag

**Files:**
- Modify: `src/lib/features/flags.ts` — add `large-doc-subdocs`
- Modify: server-side check in `sync-worker/src/migration.ts`

- [ ] **Step 1:** Register flag with description "Split files above ~5000 cells into chunked subdocs."

- [ ] **Step 2:** Importer + migration both gate on the flag. Below-threshold flow always works regardless.

- [ ] **Step 3:** Commit.

### Task E2: Manual verification checklist

- [ ] Import a single-book USFM (Genesis, ~1500 cells) → unchanged single-doc path; existing tests pass.
- [ ] Import whole-Bible single-file (KJV, ~31k cells) with flag on → manifest + ~31 chunks; opening the file lists all cells immediately; clicking GEN 1:1 opens chunk 0; clicking REV 22:21 opens chunk N.
- [ ] Edit cells across two chunks → both chunks persist independently; manifest unaffected.
- [ ] Force-disconnect mid-edit → reconnect, confirm chunk restored from R2 + tails.
- [ ] Migration: pre-create a legacy oversized file via the dev backdoor → enable the flag → first connect triggers migration; second connect routes to chunked layout; cell content preserved.

### Task E3: Telemetry hooks

- [ ] Log on the sync-worker: `chunk_count`, `largest_chunk_size`, hydration time per chunk.
- [ ] After a week of dogfood, retune `TARGET_CELLS_PER_CHUNK` / `HARD_CAP_CELLS` if needed.

---

## Out of Scope for v1

- **Cross-chunk awareness aggregation.** v1 awareness is per-chunk-DO. A `ProjectPresenceDO` is the future home for "Alice is somewhere in Genesis."
- **Adaptive rebalancing.** A chunk that grows past 2× target is a problem; v1 does not auto-split. Re-splitting is a follow-up triggered by alarm-time observation.
- **Sub-cell chunking.** Long-form content per cell (a chapter as a single cell) is a separate problem.
- **Manifest range encoding.** `cellChunkMap` stores `cellId → chunkId` explicitly; for very large files this is 1–2 MB. If profiled to hurt, replace with range-encoded chunks (`chunks[].cellIdRange`) and lazy-build the map client-side.

## Post-plan notes

- **Ordering of phases.** A through D depend on each other; E gates on D. Within A, tasks A1–A3 are independent of A4 but A4 depends on all three.
- **Branch strategy.** The frontier-server SQL migration in Task B4 ships independently; client + sync-worker changes ship in lockstep (the docId-parsing change is forward-compatible for two-part docIds).
- **Testing budget.** End-to-end coverage is via `src/lib/sync/y-partyserver-spike.test.ts` (extend with a chunked round-trip). Heavy unit-test coverage on the boundary chooser and migration; medium on the hooks.
