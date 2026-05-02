# Large-Document Subdoc Segmentation — Design

**Date:** 2026-05-02
**Status:** Design
**Scope:** Add a manifest + chunk-doc segmentation tier *inside a single file* for files that exceed a measured size threshold. Targets the whole-Bible-as-one-file case and any future long-form document that does not fit comfortably in a single Y.Doc. Existing per-file segmentation is unchanged below the threshold.

## Problem

`src/lib/store/file-doc.ts` creates one Y.Doc per file. The sync-worker hosts one Durable Object per file (`docId = "{projectId}--{fileId}"`), backed by an R2 snapshot + tail tree. This works well for normal-sized files but degrades along three axes when a single file grows large:

1. **DO memory ceiling** — Cloudflare DOs are capped at 128 MB. An active editing session on a heavily-revised whole-Bible Y.Doc (Y.Doc state + tail history + awareness for N connected clients) approaches that ceiling at 30k+ cells.
2. **Cold-start latency** — even with brotli, a multi-MB snapshot is 2–10 s on 3 Mbps and minutes on 250 kbps. For a file the user opens to look at three verses, that is unacceptable.
3. **Awareness amplification** — every connected client receives every other client's awareness updates, and Yjs reconciles against the full document state. A single editor doing a small edit forces every viewer to walk the full doc.

Empirical evidence (KJV benchmark, 31,102 verses, Y.Doc shape mirroring `file-doc.ts`):

| Edit profile | Whole-Bible raw / gz | Per-book worst raw (Psalms) | Per-chapter worst raw |
|---|---|---|---|
| Untouched | 10.5 MB / 2.5 MB | 697 KB | 47 KB |
| Light (3 hist/cell) | 24 MB / 4.1 MB | 1.75 MB | 124 KB |
| Medium (10 hist/cell) | 51 MB / 5.4 MB | 3.9 MB | 281 KB |
| Heavy (30 hist/cell) | 128 MB / 8.3 MB | 10 MB | 725 KB |

Two takeaways:
- A Bible imported as one file is genuinely problematic at heavy edits — DO ceiling is reached.
- Per-book imports (Codex's current default) stay comfortable even at heavy edits — Psalms peaks at 10 MB, well under 128 MB.

So the chunking primitive is needed for the whole-Bible-as-one-file case and other long-form documents, not for the existing per-book Bible flow.

## Goals

- Define a **measured threshold** above which a file is automatically split into chunks at import time.
- Define a **manifest + chunk-doc** Y.Doc shape that preserves cell-id-keyed semantics across chunks.
- Provide a **boundary chooser** that aligns chunks with `cell.group` when possible and falls back to fixed-N otherwise.
- Keep the `codex-db` read model unchanged — D1 still keys cells by `(file_id, cell_id)`, indifferent to chunking.
- Migrate existing oversized files in place, idempotently, without forcing a client-visible reload.
- Ship behind `large-doc-subdocs` experimental flag so the rollout can be gated.

## Non-Goals

- **Y.js subdoc primitives.** Y.js's `Y.Doc.subdoc` mechanism transports children within a parent connection; that does not map to Cloudflare's per-DO sync model. We use plain Y.Docs with a manifest doc that lists chunk IDs as opaque strings.
- **Cross-chunk CRDT atomicity.** A move from chunk A to chunk B is application-atomic, not CRDT-atomic. Cell reorders within a translation project are rare (cell IDs come from a fixed source corpus); the v1 model treats this as documented edge behavior.
- **Sub-cell chunking** (huge single cells). Out of scope; current cells are short by construction (a verse, a sentence). Long-form-per-cell content is a separate problem.
- **Live rebalancing during an active session.** Chunks rebalance on the alarm/compaction path, not on the edit path.

## Threshold

A file is chunked if either:

- **`cellCount > 5,000`**, or
- **`sumOfCellOriginalBytes > 2,000,000`**

Rationale: from the benchmark, a single doc hits the awkward zone at ~5 MB raw post-light-edits. Cells average ~150–500 bytes of `original` text in normal projects, so 5,000 cells × 400 bytes ≈ 2 MB — both criteria surface roughly the same files. Either-or so a small number of huge cells (e.g. long article paragraphs as cells) also triggers chunking.

The threshold lives in code, behind a constant that can be retuned without schema changes. Storing the trigger reasoning on the file metadata (`chunked: true, chunkedReason: "cellCount=31102"`) gives observability into why a file got chunked.

**Target chunk size:** 1,000 cells. Light-edit benchmark shows ~150 KB raw per 1,000 verses; heavy-edit ~700 KB. Both hydrate fast.
**Hard cap per chunk:** 1,500 cells. Above that, a new chunk starts even mid-group.

## Data Model

### Today

```
File (one Y.Doc):
  meta: Y.Map               { fileId, fileName, fileType, sourceLang, targetLang }
  cells: Y.Map<cellId, Y.Map>
  order: Y.Array<cellId>
```

One DO per file, one R2 snapshot+tail per file.

### After

A file is in one of two states:

**Single-doc (unchanged):** files below threshold continue to use the existing shape. No code change downstream of import.

**Chunked:** files above threshold split into a manifest doc + N chunk docs.

```
Manifest doc (always loaded eagerly when file opens):
  meta: Y.Map               { fileId, fileName, fileType, sourceLang, targetLang,
                              chunked: true, chunkedReason: string }
  order: Y.Array<cellId>    (full cell-id sequence; the spine of the file)
  chunks: Y.Array<Y.Map>    (one entry per chunk, in order)
    {
      chunkId: string       (stable opaque GUID)
      label: string         ("Genesis 1 – 7" or "cells 1–1000")
      firstCellId: string
      lastCellId: string
      cellCount: number
    }
  cellChunkMap: Y.Map<cellId, chunkId>   (lookup index — eventual-consistent
                                           projection of chunks[].cellRange,
                                           rebuilt on manifest load)

Chunk doc (one per chunk, loaded on demand):
  meta: Y.Map               { fileId, chunkId, chunked-of: fileId }
  cells: Y.Map<cellId, Y.Map>
  order: Y.Array<cellId>    (this chunk's cells only — same shape as today)
```

The chunk doc's shape is **identical** to today's file doc shape, modulo `meta`. This is deliberate: every code path that reads cells from a Y.Doc (the editor, the projection, the export, the rehydrate) continues to work unchanged once it has been handed the right Y.Doc. The chunking concern lives at the *resolver* layer (which Y.Doc?), not at the *cell* layer.

### docId scheme

| Today | After |
|---|---|
| `{projectId}--{fileId}` | `{projectId}--{fileId}` (manifest doc, when chunked) |
|  | `{projectId}--{fileId}--{chunkId}` (chunk doc) |

The double-dash separator is already handled by `parseDocId` in `sync-worker/src/index.ts`; the third slot only needs to extend the parser to split on the second `--`. Below-threshold files still use the single-slot form, so existing data does not move.

### R2 layout

```
projects/{projectId}/files/{fileId}/
├── manifest/
│   ├── snapshot.bin              (manifest doc; only present when chunked)
│   └── tail/{seq}.bin
├── chunks/{chunkId}/
│   ├── snapshot.bin
│   └── tail/{seq}.bin
└── snapshot.bin                  (legacy single-doc; only present when not chunked)
└── tail/{seq}.bin
```

A file is unambiguously in one mode or the other based on which keys exist. Migration writes the new keys before deleting the old, so a partially-migrated file remains loadable from the legacy path until the migration completes.

## Boundary Chooser

```
function chooseChunkBoundaries(cells, target = 1000, hardCap = 1500):
  if cells.length <= 5000 and sumBytes(cells) <= 2_000_000:
    return [single chunk]                        // below threshold

  chunks = []
  current = []
  for cell in cells (in order):
    current.push(cell)
    isGroupBoundary = next cell.group != cell.group
    if current.length >= hardCap:
      flush current
    else if current.length >= target and isGroupBoundary:
      flush current

  if current.length > 0: flush current
  return chunks
```

Behaviour:
- **Bible imported as one file** (31,102 cells, groups = "BOOK CH"): produces ~31 chunks, each a contiguous run of chapters within a book, never crossing a book boundary unless a book is too small to be its own chunk.
- **Article with sparse `cell.group`**: groups change every few cells, so chunks are size-driven (~target cells, group-aligned within ±10%).
- **Plain doc with no `cell.group` at all**: every cell counts as a single group of one; chunks land at exactly target size.

Labels are derived from the chunk's first/last `cell.group` ("Genesis 1 – Genesis 7") or, when groups are uniform, from cell IDs ("cells 1–1000").

## Sync Flow

### Open file

1. Client mounts `useFileSync(fileId)`. Constructs `docId = "{projectId}--{fileId}"`.
2. Connects to manifest DO. (For below-threshold files this is the same DO as today and the response carries no chunk list.)
3. Manifest doc syncs. Client reads `meta.chunked`. If false → today's behavior.
4. If true, client reads `order` and `chunks`. Renders the cell list immediately using `order` + per-cell metadata from D1 read model (`/api/v2/projects/:id/files/:id/cells?ids=...`). **No chunk doc is hydrated yet.**
5. User clicks/scrolls into a cell. Client looks up `cellChunkMap[cellId]`, opens chunk DO via `useChunkSync(fileId, chunkId)`.
6. Editor binds to the chunk doc's cell. Awareness scopes to the chunk DO.
7. When user navigates to a cell in a different chunk, the previous chunk doc may be retained (cache) or destroyed (LRU eviction policy: keep last 3 chunks).

### Edit a cell

Identical to today, except awareness and Yjs sync traffic touch only the chunk DO. The manifest doc is read-mostly during a session — only structural changes (a new cell added, a cell removed) write to it.

### Add or remove a cell

Adding/removing a cell is a manifest write *plus* a chunk write, in two transactions:

1. Mutate the chunk doc (add or remove the cell from `cells` + `order`).
2. Mutate the manifest doc (`order` += newCellId, `cellChunkMap[newCellId] = chunkId`, update the chunk's `cellCount` + `lastCellId`).

These do not need to be atomic across DOs. If step 1 succeeds and step 2 fails, the cell exists in the chunk but not in the manifest's `order`, which makes it invisible until reconciliation. A small reconciliation pass on manifest load (compare manifest `order` against each chunk's `order`) repairs drift.

### Move a cell across chunks

Rare. Application-level: remove from old chunk + add to new chunk + manifest update. Three writes, no CRDT atomicity. Documented as a graceful-degradation path: a partial failure leaves the cell in one of the two chunks (manifest determines which), and the other chunk's `order` self-cleans on next manifest reconcile.

## Read Model

D1 schema unchanged. Cells project as `(file_id, cell_id, ...)` keyed independently of chunk boundaries. New columns on `files`:

```sql
ALTER TABLE files ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN chunked_reason TEXT;
```

`chunk_count = 0` means a non-chunked single-doc file. `chunk_count > 0` means chunked; `chunked_reason` records why (e.g. `cellCount=31102`).

The chunk DO's `onSave` projects its cells the same way the file DO does today — write per-cell rows, write a chunk-scope rollup. The manifest DO's `onSave` projects `(file_id, chunk_count, chunked_reason, cell_count, last_edit_at)` — a thin file-row update aggregated from the chunk-scope rollups (read once at compaction time, not every save).

Aggregate "% translated" / "% validated" / etc. continues to work unchanged: SUM over cells WHERE file_id = ?. Chunking is invisible to dashboards.

## Migration of Existing Oversized Files

Existing single-doc files above threshold need to be split.

Trigger: on first connect to a file whose D1 `cell_count > 5000` (or whose snapshot is suspected oversized via R2 head), the sync-worker schedules a one-shot migration job:

1. Hydrate the existing single-doc snapshot in a temporary worker (not the file's own DO).
2. Run `chooseChunkBoundaries`.
3. For each chunk, build a new Y.Doc populated with that chunk's cells, encode, write `chunks/{chunkId}/snapshot.bin`.
4. Build the manifest doc, write `manifest/snapshot.bin`.
5. Atomically: in `codex-db.files`, set `chunk_count = N, chunked_reason = ...`.
6. Delete the legacy `snapshot.bin` and `tail/*.bin`.

Idempotency: if step 6 fails, a re-run sees the new keys exist and skips to step 6. Crash-safe.

Client-visible during migration: file opens normally on the legacy path until step 5 lands. After step 5, the client's next reconnect routes to the manifest DO. No user-visible reload.

## Experimental Flag

`large-doc-subdocs` (boolean, default false during rollout). When off:
- Importer does not chunk — all files use today's single-doc path regardless of size.
- Migration job skips chunking even when the threshold is met.
- Existing chunked files (none yet) are still readable; flag only gates chunking *of new files*.

When on (per-project, then default-on after dogfooding):
- Importer chunks at threshold.
- Migration job runs on legacy oversized files.

## Implementation Sketch (file-by-file)

This is the spec; the corresponding `docs/superpowers/plans/2026-05-02-large-doc-subdocs.md` carries the task-by-task instructions.

- `src/lib/store/file-doc.ts` — split `createFileDoc` into `createSingleDoc` + `createChunkedDocs` with a shared `chooseChunkBoundaries`.
- `src/lib/store/manifest-doc.ts` — new helper for building / reading manifest docs.
- `src/lib/store/chunk-resolver.ts` — `resolveChunkForCell(fileId, cellId)` that consults a cached manifest.
- `src/hooks/useFileSync.ts` — branch on `meta.chunked` after manifest hydrate; expose `useActiveChunk(cellId)` for the editor.
- `src/lib/sync/partyserver-provider.ts` — extend `docId` parsing for the `--{chunkId}` suffix.
- `sync-worker/src/index.ts` — extend `parseDocId`, accept the new docId form, route the same `FileSync` DO class for both manifest and chunks (the DO class is unchanged; only the room name carries the routing).
- `sync-worker/src/projection.ts` — add a `projectManifestDoc` path that emits the file-row rollup; existing `projectDoc` remains for chunk-scope projection.
- `sync-worker/src/migration.ts` — new module implementing the one-shot legacy split.
- `frontier-server/cloudflare/migrations/0NNN_chunked_files.sql` — add `chunk_count` + `chunked_reason` columns.

## Testing Strategy

- **Boundary chooser** (`src/lib/store/chunk-resolver.test.ts`): synthetic 31k-cell input → ~31 group-aligned chunks; pure-input fixtures for the no-group / small-group / one-huge-group cases.
- **Manifest doc shape** (`src/lib/store/manifest-doc.test.ts`): build, write, re-read, assert manifest fields and `cellChunkMap` integrity.
- **Sync round-trip** — add a chunked-doc spike in `src/lib/sync/y-partyserver-spike.test.ts`: import a 6,000-cell file, confirm one manifest DO + N chunk DOs, edit a cell in chunk 3, reload, see the edit.
- **Migration idempotency** (`sync-worker/src/__tests__/migration.test.ts`): legacy snapshot in R2, run migration, run again, assert no duplicate writes.
- **Read-model invariance** — extend an existing projection test to assert that aggregate file rollups (`cell_count`, `approved_count`) match before and after chunking.

## Open Questions

- **LRU cache size on the client.** "Keep last 3 chunks" is a guess. If users routinely cross-reference distant chunks (e.g. parallel passages in Bible study), evicting too eagerly forces re-hydration. Telemetry-driven tuning, post-launch.
- **Manifest doc growth on huge files.** A Bible-as-one-file at 31k cells stores 31k cell-ids in `order` + 31k entries in `cellChunkMap`. Roughly 1–2 MB of manifest doc. Loadable but not tiny. If this becomes a concern, fall back to range-encoded `chunks[].cellIdRange` and lazy-build `cellChunkMap` on the client; out of scope for v1.
- **Awareness for "who else is editing this file".** Today awareness is per-DO; with chunking it's per-chunk-DO. To show "Alice is editing somewhere in Genesis", the manifest DO needs to subscribe to chunk awareness. Deferred — the v1 awareness model is per-chunk-only, with a UI affordance ("Alice is in Chapter 5") that resolves chunk-id back to a label via the manifest. If users ask for cross-chunk presence, a `ProjectPresenceDO` is the pattern.
