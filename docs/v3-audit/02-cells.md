# v3 Audit — Cells Data Flow

## Summary

The cell data flow is architecturally sound and implements v3's plain event-log + D1 projection model cleanly. Client writes flow correctly through the outbox → POST /events → D1 events → projection → reads. However, significant dead code from v1/v2 (Y.Doc comments, legacy event types) remains annotated but not removed; a few soft-reference mismatches exist between what the code claims to pin (staleness, presence) and what it actually enforces.

## Chain of custody (as-built)

**Client write path:**
1. Editor idle/blur → `TranslatedEditor.onCommit` fires with `{value, valueHtml}`
2. `EditorTable.handleEditorCommit` calls `emitTargetCellCommit` with `parentId=cell.targetEventId ?? cell.sourceEventId`, pinning `sourceEventId` from the cell row
3. `events-emit.ts:enqueueEvent` builds envelope, enqueues to IndexedDB outbox
4. `outbox-flush.ts:flushOutboxBatch` POSTs batch to `/events` grouped by fileId, retrying on transient errors

**Server write path:**
1. `/events` POST → `project-do-handlers.ts` validates, assigns `serverSeq`
2. AD-2 sibling guard: rejects if another event already won the `(project_id, file_id, cell_id, parent_id)` race
3. `handleCellEvent` writes event to D1 `events` table, then calls `buildEventProjectionStmts`
4. Projection INSERT ON CONFLICT UPSERT to `cells(project_id, file_id, cell_id, side)` with chain-head `event_id` and AD-9 `source_event_id`

**Server → client broadcast:**
1. POST response: `{ accepted: [...], rejected: [...], stale: [...] }` — dead-letters in outbox, surfaces in OutboxSyncIndicator
2. WS relay: `/__broadcast` fanout from `/events` handler → `ProjectSync.broadcastToAll` → every connected client receives `{ t: "event.applied", ... }`
3. Client `ws-reconciler.onMessage` triggers `revalidate()` (soft fetch) on `event.applied`

**Client read path:**
1. `useCells` mounts → `streamFileCells(projectId, fileId, token)` fetches cells projection paginated
2. `joinSourceAndTarget` pairs rows by `cellId`, ordering source then target
3. `buildCellData` constructs `CellData` with `targetEventId`, `targetSourceEventId` pinned from projection
4. Optimistic patch in `applyOptimisticTargetEdit` mutates cached row before server lands, invalidates `useHealth` rule cache

## Findings

### F1: Dead type alias `CqrsRawEvent` masks actual type
- **Severity**: low
- **Category**: dead-code
- **Evidence**: `cqrs-types.ts` line 20 re-exports `OutboxRawEvent` as `CqrsRawEvent`; used only in `outbox.ts:11` and `outbox-flush.ts:5`
- **What's wrong**: The name `CqrsRawEvent` is a legacy v1/v2 CQRS-pattern artifact. v3 uses AD-2 event envelopes on the wire; the type alias obscures that the actual shape is `OutboxRawEvent`. No behavioral impact but confusing for readers.
- **Suggested fix**: Inline `OutboxRawEvent` directly into `outbox.ts` and `outbox-flush.ts` to remove the indirection. Or, if backward-compat with tests is needed, add a comment linking the alias to the source type.

### F2: Stale comment claims parentId "should" carry but isn't enforced client-side
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: `events-emit.ts:49-55` comment says parentId is "should carry" for non-genesis but "we don't enforce it client-side"
- **What's wrong**: The comment is accurate but no test validates the fallback to genesis semantics when parentId is null. A first-time target.cell.commit where the local row hasn't yet been projected will hit this code path silently.
- **Suggested fix**: Add a client-side assertion or test showing the null parentId → null fallback is intentional and won't hide bugs. Alternatively, remove the long comment and trust the server's authoritative guard.

### F3: outbox-types payload for cell.audio.* lacks event_id chain-link docs
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: `outbox-types.ts:36-40` defines audio kinds with `parentId: null` (non-chain-mutating), but `events-emit.ts:227` comment line says "Non-chain-mutating (parentId omitted)"
- **What's wrong**: The payload shapes are correct (audio is additive, not chain-mutating), but there's no explicit note in the types that these are read-only projections (no impact on chain head). A reader might assume they're optional writes.
- **Suggested fix**: Inline a one-liner in `OutboxEventKind` describing that `cell.audio.*` are non-mutating reads: `// Non-chain-mutating additive writes; do not affect cell.* chain head`.

### F4: Presence-as-lock claim in TranslatedEditor but no explicit lock validation in commit
- **Severity**: medium
- **Category**: mismatch
- **Evidence**: `TranslatedEditor.tsx:16-18` claims "the parent owns the WS focus lock"; `EditorTable.handleEditorCommit` line ~230 commits WITHOUT checking `heldByLabel` lock status
- **What's wrong**: The editor is read-only when `heldByLabel` is set (line 112), but the commit handler doesn't verify the lock is still held at emit time. A user could hold the lock, then lose it mid-type, and the next commit would proceed without checking. The server has no per-cell write ACL; the lock is purely UI-level coordination.
- **Suggested fix**: Either (a) prevent commit when `heldByLabel` is set and the lock has expired (re-check before emit), or (b) document this as a known limitation: "Lock expiry during edit is a rare race; revalidate will surface the conflict via the `event.applied` broadcast and the discard-and-reload banner."

### F5: Stale-source pin (AD-9 sourceEventId) not actively validated against source edits
- **Severity**: medium
- **Category**: mismatch
- **Evidence**: `cells-read-types.ts:49-52` documents sourceEventId as "staleness pin"; `useCells.ts:155` and `EditorTable` line ~230 pass it through but never check if source changed since last commit
- **What's wrong**: The pin is stored and passed back, but there's no client-side validation that the source row's event_id matches. A new source.cell.commit could land while the user is editing, making sourceEventId stale, but the commit proceeds with the old pin. The server accepts it (no guard), and the projection updates `cells.source_event_id` to the old value.
- **Suggested fix**: On `event.applied` broadcast for a source cell, check if the local pin is now stale and surface a banner like "Source changed — your pin may be stale" (mirror of the `remoteChangedDuringEdit` banner). Or document this as v3's first-commit-wins: "The first commit after a source change wins; later commits see the old pin but succeed (not validated server-side)."

### F6: Outbox dead-letter on `event.stale` but no explicit handling of stale-sibling chains
- **Severity**: medium
- **Category**: mismatch
- **Evidence**: `outbox-flush.ts:116-120` console.errors on stale siblings; `removeOutboxEvents` removes them; no test of multi-event stale chains
- **What's wrong**: If a user commits 3 times in quick succession on the same cell and the first commit arrives late, the second and third could all be stale siblings (they chained off the first, which lost the race). The outbox removes them individually, but there's no re-cascade: the user isn't prompted to revalidate and re-emit if they wanted to retry chained edits.
- **Suggested fix**: (a) Add test of stale chains to `outbox-flush.test.ts`; (b) On stale events, queue a soft revalidate after 500ms so the user sees the latest projection and can retry if desired. Or accept this as a rare edge case and document the expected behavior: "Stale siblings are removed silently; the user sees the latest value via revalidate."

### F7: `useCells.applyOptimisticTargetEdit` creates synthetic target rows with sentinel event_id=""
- **Severity**: low
- **Category**: mismatch
- **Evidence**: `useCells.ts:466` sets `eventId: ""` on synthetic target rows; code comment says "Sentinel until the server projection lands"
- **What's wrong**: An empty string is not a valid event UUID. If code downstream (e.g., another commit before revalidate lands) reads this eventId and assumes it's a valid chain head, it will fail. The comment is clear, but the sentinel is fragile.
- **Suggested fix**: Use `null` instead of `""` for the sentinel, then update any code that checks event_id to handle `null`. Or add a type guard: `eventId: "" as const` with a comment explaining it's a compile-time sentinel.

### F8: File-level writes (file.create) use `parentId: null` but projection doesn't constrain side
- **Severity**: low
- **Category**: mismatch
- **Evidence**: `events-emit.ts:361-376` emits `file.create` with `parentId: null`; `event-projection.ts` only handles `source.cell.create`, `target.cell.create`, `source.cell.commit`, etc. — no explicit handler for `file.create`
- **What's wrong**: If `file.create` is missing from the projection switch (lines 75–200 in event-projection.ts), the event lands in `events` but doesn't update `files` table. The projection build call would silently skip it. Not fatal (files table is usually pre-populated by the importer), but the omission is silent.
- **Suggested fix**: Audit `event-projection.ts` to confirm `file.create` is handled; if not, add the case or document why it's skipped. A TODO comment explaining the deferral would suffice.

### F9: Validation events (cell.validate, cell.unvalidate) aren't tested for idempotence
- **Severity**: low
- **Category**: mismatch
- **Evidence**: `events-emit.ts:176-202` builds validate/unvalidate envelopes; `outbox-flush.ts` doesn't test what happens when the same validation event is posted twice
- **What's wrong**: The projection likely handles idempotence (a second validate against the same editEventId is a no-op), but there's no test verifying this. If the outbox is drained and a validation event is re-sent, the projection should not double-count.
- **Suggested fix**: Add a test in `outbox-flush.test.ts` or `event-projection.test.ts` that posts the same `cell.validate` twice and confirms `cell_validators` row count doesn't increment.

### F10: `ws-reconciler.ts` offers `onMessage` hook but `useCells` doesn't wire it
- **Severity**: low
- **Category**: dead-code
- **Evidence**: `ws-reconciler.ts:65-67` defines `onMessage` callback; `useCells.ts` never subscribes or calls it; the revalidate is triggered by the hard-coded WS connection in `ProjectWorkspace`
- **What's wrong**: The hook exists but is unused. It's unclear whether `onMessage` is meant to auto-trigger revalidate or let the caller decide. If it's meant for callers to wire their own handlers, the lack of usage suggests the pattern isn't adopted.
- **Suggested fix**: Either (a) remove the `onMessage` hook if it's superseded by the revalidate-on-event.applied pattern, or (b) wire it in a second hook that auto-revalidates `useCells` on every `event.applied` for the active file. Clarify in a comment.

### F11: Event envelope's `kind` union in outbox-types doesn't match sync-worker types
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: `outbox-types.ts:23-42` defines `OutboxEventKind`; comment line 21 claims "must mirror sync-worker/src/events/types.ts" but no lint rule enforces this
- **What's wrong**: The client and server type definitions can drift (e.g., server adds a new kind, client doesn't import the update). There's a comment but no test or build-time assertion.
- **Suggested fix**: Add a post-deploy test (or a schema version check) that validates the client's `OutboxEventKind` against the server's kind list. Or generate both types from a shared definition in a monorepo.

## Open questions

- Is the null parentId fallback in `emitTargetCellCommit` (events-emit.ts:135–141) ever hit in practice? Should it be an error instead?
- Why does `useCells` soft-revalidate on focus/visibility change (line 410–426) but the WS `event.applied` broadcast is the primary sync signal? Are they redundant or complementary?
- The outbox removes stale siblings silently (outbox-flush.ts:116–120). Should the client re-emit them after revalidate, or is this an acceptable loss?
- Is the presence-as-lock model (ProjectWorkspace → TranslatedEditor `heldByLabel`) meant to prevent concurrent edits, or just provide a courtesy signal? The server has no lock validation.

## Files reviewed

- `src/components/TranslatedEditor.tsx` (editor, idle commit, reconciliation banner)
- `src/components/EditorTable.tsx` (editor mount, commit handler, optimistic patch)
- `src/hooks/useCells.ts` (read API, projection pairing, soft revalidate, optimistic edit)
- `src/lib/sync/events-emit.ts` (envelope builders, emitTargetCellCommit, parentId fallback)
- `src/lib/sync/outbox.ts` (IndexedDB persistence, listeners)
- `src/lib/sync/outbox-flush.ts` (POST /events, batching, dead-letter handling)
- `src/lib/sync/cells-read.ts` (fetch wrapper, streaming, pagination)
- `src/lib/sync/cqrs-bridge.ts` (token fetcher identity shim)
- `src/lib/sync/ws-reconciler.ts` (WS client, event.applied relay, locks)
- `src/lib/sync/cells-read-types.ts`, `outbox-types.ts`, `cqrs-types.ts`
- `sync-worker/src/index.ts` (DO routing)
- `sync-worker/src/project-do.ts` (WS lifecycle, broadcast hook)
- `sync-worker/src/events/event-projection.ts` (cells INSERT ON CONFLICT, source_event_id write)
- `sync-worker/src/events/handlers/cell-events.ts` (AD-2 guard, event persistence, projection touch)
