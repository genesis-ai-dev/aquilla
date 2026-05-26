# v3 Audit — Hooks & Read APIs

## Summary
The read-side is substantially clean. All 11 `*-read.ts` modules follow the D1-projection pattern correctly (fetch + typed errors, no Yjs). Most hooks (useCells, useCellHistory, useCellEditHistory, useCellsAuditStats) implement the generation-guarded soft-refetch pattern properly. However, three legacy hooks (usePendingOutboxRecords, useOutboxFlusher, useSync) and two stubbed features (useComments, useCellWaivers) remain v1/v2 artifacts that should be flagged for deferred cleanup or reclassification.

## Hook inventory
| hook | reads from | clean for v3? |
| --- | --- | --- |
| useCells | D1 `cells` projection (streamFileCells) | yes |
| useCellHistory | D1 event log (fetchCellHistory) | yes |
| useCellEditHistory | D1 event log (fetchCellHistory, filtered) | yes |
| useCellsAuditStats | D1 `cells/audit-stats` projection | yes |
| useStaleSourceCells | D1 `stale-source` projection | yes |
| useSearchIndex | D1 `search` projection | yes |
| useFileSync | navigator.onLine (no fetch) | yes-stub |
| useSync | navigator.onLine (no fetch) | yes-stub |
| useLiveness | client clock + navigator.onLine | yes-utility |
| useCellWaivers | stubbed (always returns `[]`) | deferred |
| useComments | stubbed (always returns `[]`) | deferred |
| useOutboxFlusher | IndexedDB outbox (CQRS infra) | yes-transient |
| usePendingOutboxRecords | IndexedDB outbox (CQRS infra) | yes-transient |

## Findings

### F1: useCells implements proper soft-refetch with in-flight guard
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: src/hooks/useCells.ts:334–341
- **What's wrong**: Comment says soft refetch must not blank the view, but the logic correctly preserves `rowsRef` (line 374 absorbs into buffer). However, recent git commit mentions "Fix whole-cell-list flash on every commit: revalidate must be a soft refetch" — verify the fix is complete.
- **Suggested fix**: No code change needed. Confirm via manual test that soft refetch on focus/visibility/post-commit does NOT flash a skeleton.

### F2: useCellHistory and useCellEditHistory duplicate the same server endpoint
- **Severity**: medium
- **Category**: duplicate
- **Evidence**: src/hooks/useCellHistory.ts:97, src/hooks/useCellEditHistory.ts:105
- **What's wrong**: Both hooks call `fetchCellHistory` (same endpoint), but useCellHistory returns raw events while useCellEditHistory filters to `*.cell.commit` only. This is intentional per design (useCellHistory for audit, useCellEditHistory for drawer), but callers may be using both on the same cell, doubling the load. No deduplication or cache layer.
- **Suggested fix**: Phase 2c: consider a unified hook with a filter parameter, or memoize/deduplicate at the fetch layer if caller patterns show both are active simultaneously.

### F3: useSync is a stub (navigator.onLine only)
- **Severity**: low
- **Category**: legacy-v2
- **Evidence**: src/hooks/useSync.ts:33–50
- **What's wrong**: Per Phase 2b plan, useSync returns `connected: navigator.onLine` with a comment that Phase 2c will replace it with real WS state + reconciler.flushing. No DO connection, no presence, no focus locks yet.
- **Suggested fix**: Phase 2c: implement real WS connection state from ws-reconciler. For now acceptable as a placeholder that keeps the sync indicator green while online.

### F4: usePendingOutboxRecords and useOutboxFlusher are CQRS transient-state hooks, not D1 reads
- **Severity**: low
- **Category**: legacy-v2
- **Evidence**: src/hooks/useOutboxFlusher.ts, src/hooks/usePendingOutboxRecords.ts
- **What's wrong**: Both read IndexedDB outbox directly, not D1. This is correct per v3 design (outbox is client-side staging), but they are categorically different from D1-read hooks. They should not be audited as "read-side D1" — they manage transient write staging. They are v2 CQRS infrastructure, not legacy Y.Doc.
- **Suggested fix**: Reclassify these as "outbox management" not "read hooks" in documentation. No code change needed; they follow the correct pattern for their domain.

### F5: useComments and useCellWaivers are stubbed (always return empty)
- **Severity**: medium
- **Category**: deferred
- **Evidence**: src/hooks/useComments.ts, src/hooks/useCellWaivers.ts
- **What's wrong**: Both return empty data + no-op mutators. Per comments, they are awaiting v1.x event grammar. Call sites still compile (preserved signatures) but are dead code. ProjectWorkspace still wires them in but nothing renders.
- **Suggested fix**: Phase 2c / v1.x: implement the event-log read path for comments and waivers, or remove the hooks and their call sites if the feature is deferred past v1.

### F6: useCellsAuditStats endpoint is separate from useCells fetch
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: src/hooks/useCellsAuditStats.ts:47–68
- **What's wrong**: Fetches `/cells/audit-stats` (one round-trip), while useCells fetches `/cells` (streaming). No indication whether audit-stats is ever stale relative to cells, or if they're kept synchronized server-side. Comment says "projected from the event log — never out of date by more than an onSave debounce window (~2s)" but no evidence this is true after the switch to v3 D1 event log.
- **Suggested fix**: Verify server keeps both projections in sync within ~2s; add a note in the comment if this SLA changed post-Phase 2a.

### F7: ws-reconciler is built but not wired to hooks
- **Severity**: medium
- **Category**: legacy-v2
- **Evidence**: src/lib/sync/ws-reconciler.ts
- **What's wrong**: The WS client is complete (Phase 2c) with message protocol (event.applied, event.stale, presence, focus locks), but no hooks consume it. useSync and useLiveness are not driven by the reconciler — they use navigator.onLine and explicit bumpedAt triggers. The reconciler exists but is dead code in the UI layer.
- **Suggested fix**: Phase 2c completion: wire ws-reconciler into useSync / a new useReconcilerStatus hook to expose connection state, event broadcast subscriptions, and presence. For now document that the reconciler is built but not connected.

### F8: useLiveness uses a caller-supplied bumpedAt trigger, not a real subscription
- **Severity**: low
- **Category**: legacy-v2
- **Evidence**: src/hooks/useLiveness.ts:43–58
- **What's wrong**: Derives liveness state correctly, but the "update happened" signal comes from a manual bumpedAt counter passed by the parent (ProjectWorkspace bumps it when project/rules change), not from a subscription to actual sync events. When the ws-reconciler lands, this should subscribe to ProjectWsServerMessage instead.
- **Suggested fix**: Phase 2c: swap bumpedAt for subscribeToReconciler or a real WS event stream.

### F9: useFileSync returns empty peers array (Phase 2c pending)
- **Severity**: low
- **Category**: legacy-v2
- **Evidence**: src/hooks/useFileSync.ts:92
- **What's wrong**: Returns `peers: []` always; per comment, roster comes back in Phase 2c. Call sites that render PeerPresence / peer chips show nothing (same as pre-connect state), which is acceptable but not reflective of actual project state.
- **Suggested fix**: No change needed; acceptable placeholder. Phase 2c: populate from presence messages.

### F10: Soft refetch error handling is silent (violates Rule 12)
- **Severity**: medium
- **Category**: bug
- **Evidence**: src/hooks/useCells.ts:381–384, useCellHistory.ts:101–105
- **What's wrong**: When a soft refetch (revalidate) fails, the hook catches the error, logs it to console.warn, and sets isError=true — but the parent component may not see this because revalidate() is called after a known write (outbox flush), and the parent is watching isLoading/isError from the original mount effect, not from revalidate(). The error state is set but may not bubble to the UI if the parent doesn't re-render on the error flag.
- **Suggested fix**: Verify useCells/useCellHistory callers watch isError after calling revalidate(). If not, either (a) have revalidate() return a Promise<error> so callers can handle it, or (b) surface errors via a callback. ProjectWorkspace should log or toast hard errors, not silently swallow them.

### F11: All read modules throw typed errors correctly
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: cells-read.ts, history-read.ts, projects-read.ts, search-read.ts, stale-source-read.ts (all define *ReadError classes)
- **What's wrong**: No issue; all read modules throw on non-2xx with the full status + body truncated. Hooks catch and log. Pattern is consistent and clean.
- **Suggested fix**: No change needed. Confirm that error handling in hooks distinguishes transient (5xx) from terminal (401/403) on a per-module basis (some do, some don't).

## Open questions
- Is audit-stats projection kept in sync with cells projection server-side? Or can they drift by more than the ~2s debounce mentioned in the comment?
- Are there callers simultaneously using useCellHistory and useCellEditHistory on the same cell? If so, deduplication would reduce load.
- Should useFileSync and useLiveness be removed from the audit, or reclassified as "stub/placeholder" instead of "read"?
- Is the ws-reconciler actually wired anywhere, or is it truly dead code pending Phase 2c landing?
- Are soft-refetch errors (isError from revalidate) actually reaching the UI, or are they being swallowed silently?

## Files reviewed
- src/hooks/useCells.ts
- src/hooks/useCellHistory.ts
- src/hooks/useCellEditHistory.ts
- src/hooks/useCellsAuditStats.ts
- src/hooks/useStaleSourceCells.ts
- src/hooks/useSearchIndex.ts
- src/hooks/useFileSync.ts
- src/hooks/useSync.ts
- src/hooks/useLiveness.ts
- src/hooks/useCellWaivers.ts
- src/hooks/useComments.ts
- src/hooks/useOutboxFlusher.ts
- src/hooks/usePendingOutboxRecords.ts
- src/lib/sync/cells-read.ts
- src/lib/sync/history-read.ts
- src/lib/sync/projects-read.ts
- src/lib/sync/search-read.ts
- src/lib/sync/stale-source-read.ts
- src/lib/sync/ws-reconciler.ts
- src/lib/sync/outbox.ts
