# M13 Phase 3 — Git Merge (Lossless CRDT-style Pull)

**Date:** 2026-04-15
**Status:** Approved design
**Predecessors:**
- Phase 1 — `2026-04-15-codex-web-app-milestone13-phase1-git-import-design.md`
- Phase 2 — `2026-04-15-codex-web-app-milestone13-phase2-git-push-design.md`

## Goal

Resolve the `remote-moved` case that Phase 2 left unhandled: when local and remote have both advanced since the last sync, reconcile them losslessly without force-push and without invoking isomorphic-git's `merge` (which doesn't support recursive merge). The outcome is a two-parent merge commit written locally and fast-forwarded to GitLab.

**Non-negotiable:** never lose a user edit. Every entry in every cell's `metadata.edits[]` ledger survives the merge, regardless of which side it came from.

## Non-goals

- Multi-branch workflows (we only sync the single tracked branch).
- UI for manual conflict resolution. If a resolver throws, we stash and surface an error — we do not render a diff view.
- Rebase-style linear history.
- Background merges while the tab is hidden.
- Pull-only (no local edits) as a distinct action — covered as a degenerate case of the merge flow.
- Recovery from push rejection during a merge-commit push beyond a single retry (rare; bounded).

## Guiding principle

The `.codex` / `.source` / `comments.json` / `metadata.json` files on GitLab are the **canonical source of truth**. Y.Doc is a working cache. Each cell already carries a CRDT-style `metadata.edits[]` ledger — one entry per group of minor Yjs ops, attributed with `{editMap, value, timestamp, author, validatedBy?}`. Merging two versions of a cell is just *unioning their ledgers* and replaying latest-per-editMap. No base commit is needed because the union of edit ledgers is always total and commutative.

## Why not `git.merge`

isomorphic-git's `merge` is limited to fast-forward + a degenerate three-way that refuses on any textual conflict. Our files are structured JSON whose "conflicts" are resolvable at the cell / edit-entry level but always look textually conflicting to git. We need a custom merger, and we never need git's.

## High-level flow

Entrypoint remains `syncProject`. The Phase 2 `remote-moved` early-return is replaced with a branch that calls `mergeRemoteIntoOurs`.

```
┌───────────────────────────────────────────────────────────┐
│ syncProject(project, session)                             │
│                                                           │
│  1. freezeEdits(project.id)                              │
│  2. serializeDirtyDocs + commit → oursSha                │
│  3. git.fetch origin/branch       → theirsSha            │
│  4. lineage check:                                        │
│       theirs ⊆ ours   → push (remote didn't really move) │
│       ours   ⊆ theirs → fast-forward local, rehydrate    │
│       divergent        → step 5                          │
│  5. mergeRemoteIntoOurs({oursSha, theirsSha, branch})    │
│       ├─ walkTrees → conflict set                        │
│       ├─ per-path resolveTwoWay                          │
│       ├─ writeBlob + writeTree                           │
│       └─ commit parent:[oursSha, theirsSha] → mergeSha  │
│  6. push                                                  │
│  7. rehydrateFileDocs(touchedPaths)                      │
│  8. releaseEditFreeze, update origin.headSha             │
└───────────────────────────────────────────────────────────┘
```

Every step is idempotent-on-retry up to (but not including) the `push`.

## Edit freeze

A new `syncing` flag on `useSyncProject` (returned to consumers) drives the editor UI:

- Every cell input surface (TipTap, comment box) reads `syncing` from context and short-circuits its `onChange` handlers: keystrokes are absorbed, not fed into Y.Doc.
- A subtle overlay (`.sync-freeze-overlay`) appears at the top of the document pane: "Merging incoming changes…". No modal. No blur. Typical duration sub-3s.
- The freeze is released at step 8, *after* rehydration, so no edit lands against a stale doc.

Missed keystrokes during the freeze are lost — this is acceptable because the freeze is short and triggered by an explicit user action (Sync button). The alternative (buffering Yjs ops and replaying them against the rehydrated doc) is complexity we don't need yet.

## Lineage check

```ts
const theirsInOurs = await git.isDescendent({fs, dir, oid: oursSha, ancestor: theirsSha})
const oursInTheirs = await git.isDescendent({fs, dir, oid: theirsSha, ancestor: oursSha})
```

- `theirsInOurs` → remote-moved was a false alarm (someone else synced then we synced after, state already fine). Skip merge, just push.
- `oursInTheirs` → pure fast-forward pull. No local commits worth merging. Update HEAD to `theirsSha`, rehydrate touched docs, skip push.
- Neither → true divergence, proceed to merge.

## Tree walk (conflict set discovery)

```ts
const { classify } = buildTreeDiff(fs, oursSha, theirsSha)
// classify() yields { path, oursOid, theirsOid, kind } for every entry where oursOid !== theirsOid
```

Implementation:

```ts
await git.walk({
  fs, dir,
  trees: [git.TREE({ref: oursSha}), git.TREE({ref: theirsSha})],
  map: async (path, [ours, theirs]) => {
    const oursOid = await ours?.oid()
    const theirsOid = await theirs?.oid()
    if (oursOid === theirsOid) return null
    return {
      path: "/" + path,
      oursOid,
      theirsOid,
      kind:
        !oursOid ? "theirs-only" :
        !theirsOid ? "ours-only" :
        "both-differ",
    }
  },
})
```

Classification drives step 6 routing:

| kind | action |
|------|--------|
| `theirs-only` | include theirs' blob in merged tree as-is (`theirsOid`) |
| `ours-only` | include ours' blob as-is (`oursOid`) |
| `both-differ` | run the per-path resolver on the two blob contents |

Directory-level handling is implicit — `git.walk` emits leaves only.

## Per-path resolvers

Each resolver is a pure function: `(oursBytes: string, theirsBytes: string) → string` or throws. **No base parameter** — the edit-map union semantics don't need one.

### `strategies.ts`

```ts
export enum Strategy {
  CODEX = "codex",            // .codex, .source
  COMMENTS = "comments",       // .project/comments.json
  METADATA = "metadata",       // metadata.json
  JSON_MERGE = "json-merge",   // .vscode/settings.json, unknown .json
  IGNORE = "ignore",           // complete_drafts.txt, anything generated
  OVERRIDE = "override",       // fallback for binary / unknown (theirs wins, logged)
}

export const filePatternsToResolve: Record<Strategy, string[]> = {
  [Strategy.CODEX]: ["files/target/*.codex", ".project/sourceTexts/*.source"],
  [Strategy.COMMENTS]: [".project/comments.json"],
  [Strategy.METADATA]: ["metadata.json"],
  [Strategy.JSON_MERGE]: [".vscode/settings.json"],
  [Strategy.IGNORE]: ["complete_drafts.txt"],
  [Strategy.OVERRIDE]: [],
}

export function determineStrategy(path: string): Strategy {
  // Exact-or-suffix match for IGNORE; wildcard match for others.
  // Unknown path → JSON_MERGE if .json, else OVERRIDE.
}
```

Ported directly from `codex-editor/src/projectManager/utils/merge/strategies.ts`, minus the VSCode-specific entries.

### `resolveCodexTwoWay` — `.codex` / `.source`

Input: two notebook JSON strings. Algorithm:

1. Parse `ourNotebook`, `theirNotebook`. Both have `{cells: CodexCell[], metadata: {edits?: EditHistory[]}}`.
2. Merge file-level `metadata.edits[]` via set union keyed on `(timestamp, editMap.join('.'), JSON.stringify(value))`. This is `mergeEditHistoryUnion` — identical keying to the existing `mergeTwoCellsUsingResolverLogic` in `src/lib/codex-editor/merge/cells.ts`.
3. Build a `theirCellsById: Map<string, CodexCell>` from theirs.
4. Walk ours' cells in order. For each `ourCell` with id:
   - If `theirCellsById.has(id)` → push `mergeTwoCellsUsingResolverLogic(ourCell, theirCell)`; delete from theirCellsById. Both-sides-soft-deleted → still keep the merged cell (the deletion flags + history are preserved on the cell itself; we never drop for audit).
   - Else → push `ourCell` unchanged.
5. If `theirCellsById.size > 0`, insert remaining cells at positions preserving their *relative* order on theirs' side. Ported from `insertUniqueCellsPreservingRelativePositions` — for each theirs-only cell, find its nearest neighbor that *also* exists in our merged list (by `id`), and insert before/after it depending on which side of the neighbor it was on in theirs. Falls back to append if no anchor exists.
6. Safety pass: for every merged cell, filter `edit.validatedBy` arrays through `isValidValidationEntry` (already in `validators.ts`).
7. Serialize via `formatJsonForNotebookFile(merged)` — must match Phase 2's writer settings exactly (2-space indent, trailing newline, key order identical to codex-editor's output) so unchanged cells round-trip byte-identical.

Total function. Cannot throw for well-formed inputs. Malformed JSON on either side propagates as a parse error and routes to the failure path (step below).

### `resolveCommentsTwoWay` — `.project/comments.json`

Input: two JSON strings containing `NotebookCommentThread[]`. Algorithm:

1. Parse both. Migrate any legacy `deleted`/`resolved` booleans to `deletionEvent[]`/`resolvedEvent[]` arrays, matching the codex-editor migration path in `resolvers.ts:1295-1425`.
2. Index ours by `thread.id`.
3. For each thread in theirs: if no match in ours, add as-is. If matched:
   - Union comments within the thread keyed by `comment.id`; fallback dedupe key is `(body, author.name)` for legacy comments lacking ids.
   - `deletionEvent` / `resolvedEvent` arrays are appended (union, dedupe by timestamp+author).
   - Thread-level metadata (title, priority) adopts the side whose latest-comment-timestamp is newest.
4. Output array order: ours first (in ours' original order), then theirs-only threads (in theirs' original order).

Total function.

### `resolveMetadataTwoWay` — `metadata.json`

Each top-level key may have a sidecar edit entry in `metadata.edits[]`. Algorithm:

1. Union `metadata.edits[]` with the same keying as the file-level edits in `.codex`.
2. For each top-level key other than `edits`: use the latest edit entry's `value` for that key (from the unioned edits, filtered to that editMap path). If a key has no edit trail on either side (legacy import), prefer theirs for forward progress.

Total function.

### `resolveJsonMergeTwoWay` — `.vscode/settings.json` and `.json` fallback

1. Parse both as JSON objects.
2. Recursive per-key merge: if both sides have the same key with different scalar values, take theirs (last-writer-wins). Log a warning naming the key. Arrays at the same key are concatenated + deduped by `JSON.stringify`. Objects recurse.
3. Ours-only keys and theirs-only keys are both preserved.

Near-total. Lossy only when both sides set the same scalar key to different values — logged, rare, bounded.

### `override` — binary / unknown

Take theirs. Log a warning. Only routes here for paths not matching any other strategy *and* not ending in `.json`. In the current project shape, this mostly catches images and other binary assets that typically don't conflict. If they do, last-writer-wins is the pragmatic choice.

## Writing the merged tree

```ts
const mergedEntries: Array<{mode: string, path: string, oid: string, type: "blob" | "tree"}> = []
for (const entry of conflictSet) {
  if (entry.kind === "both-same") continue  // filtered earlier
  if (entry.kind === "theirs-only") mergedEntries.push({...entry, oid: entry.theirsOid})
  else if (entry.kind === "ours-only") mergedEntries.push({...entry, oid: entry.oursOid})
  else {
    const resolvedText = await resolveOne(entry)   // routes via determineStrategy
    const {oid} = await git.writeBlob({fs, dir, blob: textEncoder.encode(resolvedText)})
    mergedEntries.push({...entry, oid})
  }
}
// Entries outside the conflict set are carried over from ours' tree unchanged.
const mergeTreeOid = await buildTreeFromOursPlusOverrides(oursSha, mergedEntries)
const mergeSha = await git.commit({
  fs, dir,
  tree: mergeTreeOid,
  parent: [oursSha, theirsSha],
  author: {name: session.username, email: `${session.username}@frontier`},
  message: `merge: sync with ${theirsSha.slice(0, 7)}`,
})
```

`buildTreeFromOursPlusOverrides` recurses from ours' root tree, replacing the blobs named in `mergedEntries`. This is the one nontrivial iso-git helper we write; see `src/lib/sync/git-merge/tree.ts`.

## Push

Normal `git.push`. Our merge commit's first parent is `oursSha`, second is `theirsSha` — so from GitLab's POV our tip is a descendant of the remote tip, making the push a fast-forward.

If the push *still* rejects (remote advanced again during our 1-3s merge):

1. Fetch again; record the newer `theirsSha'`.
2. One retry: re-run merge against the new theirs. (Merges are commutative on `.codex`/`.source`/comments so the second merge composes cleanly.)
3. If the second push also rejects → abort with error; do not retry again. Surface "remote changed during merge — please retry sync". Our merge commits remain on the local branch; nothing is lost.

## Rehydrate

For each `touchedPath` in the conflict set (both-differ ∪ theirs-only):

1. Find the `FileReference` whose on-disk path matches (via `findOriginalPath`).
2. Parse the merged `.codex` bytes via `parseCodexNotebook` + `pairCells` (same pipeline as import).
3. For each cell, derive its current `translatedXml` by HTML-parsing the cell's `value` field.
4. Get the live `FileDocHandle` for that file id. Inside `handle.doc.transact()`:
   - Replace `doc.getMap("cells")` content. For each cell id, upsert its Y.Map with `value`, `history` (from `metadata.edits`), `validatedBy`, `translatedXml`. Delete any cell id not in the merged output.
   - Update `doc.getMap("meta")` with merged file-level metadata.
5. Bump `__lastSyncedHistoryAt` on every cell to `mergeCommit.timestamp`.

This is the only path where Y.Doc gets wholesale reset *inside a transaction* — the IndexeddbPersistence observes the transaction and writes through; no destroy/recreate is needed. Open editors see atomic state replacement (TipTap re-renders from the new `translatedXml`), which is exactly the UX we want when incoming edits are accepted.

*Open Y.Doc identity is preserved* — cursors, selection, undo history within touched docs are reset (they were about to be wrong anyway). Untouched docs are not affected at all.

New module: `src/lib/store/file-doc.ts` gains `rehydrateFileDoc(handle, parsedNotebook)`.

## Failure path

If any resolver throws (malformed JSON, unexpected shape, unmigrateable legacy data):

1. Create a backup ref at ours: `git.writeRef({ref: 'refs/heads/codex-web/backup-' + isoNow, value: oursSha, force: true})`.
2. Rewind local branch head to *pre-step-2* — the `beforeSerializeSha` we captured at entry. Our serialized-dirty-cells commit `oursSha` is still reachable via the backup ref, so Y.Doc edits aren't lost.
3. Do **not** push.
4. Release the edit freeze.
5. Return `{status: "error", message: "Couldn't auto-merge — your work is saved on branch codex-web/backup-<ISO>. Please retry or contact support.", backupRef}`.

The backup ref gives support a way to recover the user's work. Subsequent successful syncs should GC these refs older than 7 days. (GC is a nice-to-have for Phase 3.5 — not in scope here beyond creating the refs.)

## Architecture — new modules

```
src/lib/codex-editor/merge/
  cells.ts              (exists; unchanged — Phase 2 already vendored)
  comments.ts           (exists; extend with thread-level two-way merge)
  validators.ts         (exists; unchanged)
  resolvers.ts          NEW — top-level per-path resolvers
  strategies.ts         NEW — filePatternsToResolve + determineStrategy
  metadata.ts           NEW — resolveMetadataTwoWay
  json-merge.ts         NEW — resolveJsonMergeTwoWay

src/lib/sync/git-merge/
  index.ts              NEW — mergeRemoteIntoOurs orchestrator
  tree-diff.ts          NEW — buildTreeDiff via git.walk
  tree-write.ts         NEW — buildTreeFromOursPlusOverrides
  lineage.ts            NEW — isDescendent wrappers + decision helper

src/lib/sync/git-sync.ts          MODIFY — remove `remote-moved` early return,
                                           branch into merge path
src/lib/sync/useSyncProject.ts    MODIFY — expose syncing flag (context)
src/lib/store/file-doc.ts         MODIFY — rehydrateFileDoc()
src/lib/store/project-index.ts    MODIFY — bump origin.headSha to mergeSha

src/components/editor/             MODIFY — consume syncing flag; freeze overlay
  CodexCellEditor.tsx              (short-circuit onChange during freeze)
src/components/sync/SyncButton.tsx MODIFY — remove Phase 2's disabled state
                                           for remote-moved; now runs merge
```

All merge resolvers are pure and live in `codex-editor/merge/` so they're testable in isolation and can be reused by future parts of the pipeline (e.g. the local-snapshot diff tool in M8).

## Commit message shape

```
merge: sync with abc1234

- <n> cells merged across <f> files
- <m> comments merged
```

Matches Phase 2's `buildCommitMessage` format plus a first-line `merge:` prefix.

## Identity

Author of the merge commit is the user performing the sync (`session.username`). Per-cell edit entries keep their own `author` from the side they came from (lossless). This is consistent with how codex-editor attributes merges.

## Testing strategy

### Unit

- Per-resolver fixtures in `src/lib/codex-editor/merge/__test__/`:
  - `resolvers.codex.test.ts` — 8 fixtures: (a) disjoint cell edits, (b) overlapping same-editMap latest-wins, (c) ours adds cell, (d) theirs adds cell at position, (e) both soft-delete same cell, (f) theirs-deleted-ours-edited, (g) `validatedBy` union, (h) file-level `metadata.edits` union.
  - `resolvers.comments.test.ts` — thread-union, comment-dedupe by id, legacy-dedupe by (body, author), thread-metadata from newer comment, deletionEvent append.
  - `resolvers.metadata.test.ts` — per-key latest-wins via edit history.
  - `resolvers.jsonMerge.test.ts` — deep merge, array-dedupe, scalar-same-key conflict logs warning and takes theirs.
- `strategies.test.ts` — path → strategy routing, including fallback.
- `lineage.test.ts` — three scenarios (theirs⊆ours, ours⊆theirs, divergent) against an in-memory iso-git fixture.

### Integration

- `git-merge.integration.test.ts` — with the existing MemoryDirectoryHandle fs from Phase 2 tests:
  - Set up two "users" as two in-memory repos + a shared "remote" repo.
  - User A clones, edits cell X, pushes. User B clones from the pre-A state, edits cell Y + cell X differently, calls `syncProject`, which must produce a merge commit preserving both X edits and the Y edit. Re-clone as user A and verify all three edits present.
- `rehydrate.integration.test.ts` — mount a `FileDocHandle`, trigger merge, assert that the Y.Doc after rehydration contains cells matching the merged JSON and that `__lastSyncedHistoryAt` is bumped.

### Manual

- Two browser tabs on the same project with different users. Both edit; user A syncs first, user B syncs second. Verify user B's sync produces a merge commit on GitLab containing both users' edits.
- Three-way race: A and B both sync before either fetches — the second one in produces a merge; the third sync (either user) fast-forwards cleanly.

### Round-trip byte check

Augment Phase 2's serializer round-trip test to include a merge step: clone → import → no-op serialize → `resolveCodexTwoWay(serialized, serialized)` must return byte-identical output (idempotent on trivial input).

## Backwards compatibility

Phase 2's serialize path is unchanged — it produces the same bytes. Phase 3 only adds a new code path after `fetch` sees divergence. Existing `remote-moved` returns in `syncProject` become intermediate states that resolve automatically instead of bubbling to the UI.

A repo that was last synced under Phase 2 and now sees a Phase 3 sync is handled normally — `origin.headSha` is already set correctly, and the merge-base-isn't-needed property means there's no migration.

## Open risks

- **Cell position preservation for theirs-only cells** — our algorithm anchors to nearest shared-id neighbor. If the neighbor was renamed/deleted, positioning falls back to append. Acceptable; matches codex-editor's current behavior.
- **HTML round-trip** — unchanged from Phase 2 risks. Cells touched on both sides where ours' HTML is our subset and theirs' HTML has richer tags → the merge takes latest-wins per editMap; whichever side's edit is newer wins. If that's ours, we lose theirs' richer HTML for that specific edit. Mitigation: keep Phase 2's HTML-subset concern on the roadmap.
- **Walk performance on very large repos** — `git.walk` over two full trees is O(nFiles). For repos with 10k+ files, the merge might take seconds. Acceptable now; if it becomes a problem, we can constrain the walk to `files/`, `.project/`, `.vscode/` only.
- **Legacy migration paths in reference resolvers** — codex-editor's resolvers contain long migration blocks for deprecated field shapes. We port the migration code *only if* we encounter corresponding inputs; for a fresh web-app-imported project we don't need them. We will vendor them behind feature flags rather than inline to keep the resolver bodies clean.
- **Backup ref accumulation** — failure-path backup refs can grow unbounded. Out of scope for Phase 3; tracked for Phase 3.5 GC.

## Out of scope (Phase 4+)

- Background periodic sync (with an in-tab leader election for multi-tab).
- Conflict-resolution UI for the rare resolver-throws case.
- Branch workflows (create branch, switch branch, merge branch).
- Push retries across more than one remote-advanced cycle.
- Amend, squash, rebase.
- LFS media conflict resolution (delegated to OVERRIDE for now).
