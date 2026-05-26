# v3 Audit — Yjs / CQRS Residue

## Summary

No production Yjs imports remain in the codebase; v3 is event-log-only with D1 projections. However, **13 substantial Yjs/CQRS residual references live in comments** across components and hooks — mostly Phase 2c-γ migration notes explaining what was ripped out. The AGENTS.md file still claims "sync stack is y-partyserver on CF Durable Objects", directly contradicting v3's event-driven architecture. The `FileSync` DO is stubbed (410 Gone), the outbox/CQRS modules are load-bearing (FWW conflict tracking + idempotent replay), and CQRS_LEGACY_IMPORT.md documents v1 hydration semantics that no longer apply.

## Yjs touchpoints inventory

| file:line | purpose | still needed in v3? |
| --- | --- | --- |
| src/components/CellActionsMenu.tsx:9 | Comment: "Prefer D1 editCount when available; fall back to Y.Doc history length" | NO — D1 is canonical now |
| src/components/EditorTable.tsx:2–3 | Comment: "Phase 2c-gamma: waivers wrote to Y.Doc; event-grammar version..." | NO — informational only (historical note) |
| src/components/ProjectWorkspace.tsx:180–182 | Comment: "The Y.Doc is still wired for writes + Tiptap editor" | NO — outdated; cells hydrate from D1 only |
| src/components/RuleDrawer.tsx:4 | Comment: "Phase 2c-gamma: autofix applied via Y.Doc edits; writeback path is..." | NO — writebacks now through events-emit |
| src/components/TranslatedEditor.tsx:1 | Comment: "no Y.Doc, no collaboration extension" | NO — confirms removal, safe to keep |
| src/hooks/useSectionProgress.ts:12 | Comment: "no longer writes a Y.Doc, legacy IDB-backed read path returns nothing" | NO — purely historical context |
| src/hooks/useCells.ts:3–4 | Comment: "Y.Doc grammar went away. The shape is preserved as defaults" | NO — explains empty defaults for v1.x deferred fields |
| src/hooks/useCellHistory.ts:1–10 | Comment: "Y.Doc write helpers removed alongside per-file Y.Doc" | NO — documents deletion rationale |
| src/lib/sync/cqrs-bridge.ts:1–7 | Comment header explaining the Y.Doc-coupled writers are gone | NO — but the module IS needed |
| src/lib/sync/events-emit.ts:4–6 | Comment: "legacy cqrs-bridge.ts is the Y.Doc-coupled equivalent" | NO — correct; directs readers to events-emit |
| sync-worker/wrangler.toml:13 | Comment: "y-partyserver wires one Durable Object per file" | NO — outright wrong for v3 |
| sync-worker/wrangler.toml:32 | Comment: "R2 holds canonical Y.Doc snapshots and tail updates" | NO — wrong; R2 now holds media/imports only |
| docs/SYNC.md (entire file) | "How codex-web-app's Yjs-based sync works" | NO — describes v1 CRDT + y-partyserver, not v3 event-log |

## Outbox / CQRS-bridge inventory

| file:line | purpose | still needed in v3? |
| --- | --- | --- |
| src/lib/sync/cqrs-bridge.ts | Per-file sync-token fetcher + bridge identity (projectId, activeFileId, username) | YES — load-bearing |
| src/lib/sync/cqrs-types.ts | Re-exports outbox-types under legacy `Cqrs*` names for backward compat | YES — used by outbox + audit-stats |
| src/lib/sync/outbox.ts | IndexedDB-backed queue for CQRS events; survives tab close; drained by flusher | YES — critical for FWW + offline resilience |
| src/lib/sync/outbox-flush.ts | POST batches to `/events`; groups by fileId for per-file JWT; handles auth quarantine | YES — durable delivery mechanism |
| src/lib/sync/outbox-types.ts | Client-side AD-2 event grammar (source.cell.*, target.cell.*, parentId envelope) | YES — canonical event schema |
| src/hooks/usePendingOutboxRecords.ts | Subscription-based view of pending events (IDB); triggers UI revalidations | YES — user-visible confirmation of pending writes |

## Findings

### F1: wrangler.toml comments contradict v3 architecture
- **Severity**: high
- **Category**: doc-mismatch
- **Evidence**: sync-worker/wrangler.toml:13, :32
- **What's wrong**: Comments claim "y-partyserver wires one Durable Object per file" and "R2 holds canonical Y.Doc snapshots" — both false in v3. FileSync is 410 Gone; R2 holds media/imports. ProjectSync holds live locks/presence only.
- **Suggested fix**: Update comments to describe the AD-1 event-log-only architecture: "FileSync binding preserved for backwards-compatibility (returns 410); ProjectSync is per-project DO holding focus locks + presence + event fanout; D1 holds canonical events/projections; R2 holds media blobs and checkpoint imports."

### F2: AGENTS.md claims y-partyserver is the sync stack
- **Severity**: high
- **Category**: doc-mismatch
- **Evidence**: AGENTS.md:33
- **What's wrong**: "The sync stack is y-partyserver on Cloudflare Durable Objects + R2" — directly contradicts the AD-1 event-log-only design.
- **Suggested fix**: Replace with "The sync stack is event-log-based: D1 holds durable events and projections; ProjectSync DO (per-project) coordinates focus locks, presence, and event broadcast; the client enqueues events in an IDB outbox and flushes asynchronously via POST /events with per-file JWT scope."

### F3: CQRS_LEGACY_IMPORT.md documents v1 hydration, not v3
- **Severity**: medium
- **Category**: legacy-v1
- **Evidence**: docs/CQRS_LEGACY_IMPORT.md (entire file)
- **What's wrong**: "FileSync.onLoad boots, finds no R2 snapshot, replays events chronologically, builds a Y.Doc, and persists the result back to R2 as the initial snapshot" — this v1 cold-start hydration no longer exists. v3 reads cells directly from D1 projections via HTTP.
- **Suggested fix**: Rename to `LEGACY_IMPORT_V1.md` with a prominent header: "DEPRECATED — describes the v1.x Yjs hydration path and is not applicable to v3. See docs/SYNC.md for current event-log flow." Or delete and document modern import via POST /events in a separate guide.

### F4: SYNC.md describes v1 CRDT + y-partyserver, not v3
- **Severity**: medium
- **Category**: doc-mismatch
- **Evidence**: docs/SYNC.md (entire file)
- **What's wrong**: Section "The flow (single-user, single-file)" steps 3–10 document the y-partyserver WS handshake, Y.Doc sync protocol, 2s debounce to onSave, and R2 compaction — all v1. Modern v3 skips WS entirely for writes; cells are fetched from D1 via HTTP and events posted back through the outbox + flusher.
- **Suggested fix**: Rewrite "The flow" section to describe: (1) Client reads cells via HTTP from /cells?fileId=; (2) Editor changes enqueue events in IDB outbox with parentId + sourceEventId pointers; (3) Flusher polls outbox, groups by fileId, POSTs to /events with per-file JWT; (4) Server applies event with FWW guard (first-child-of-parent); (5) ProjectSync broadcasts event.applied to subscribed clients for soft revalidation.

### F5: FileSync DO is 410 Gone but still bound in wrangler.toml
- **Severity**: low
- **Category**: legacy-v1
- **Evidence**: sync-worker/src/index.ts:73–79; sync-worker/wrangler.toml:14–16
- **What's wrong**: The binding exists only for backwards-compatibility; the DO itself returns "FileSync CRDT runtime removed" (410). Comments explain it's a "compatibility shim" but it's taking up a migration slot.
- **Suggested fix**: No immediate action needed — the binding is inert and the 410 response is intentional. When cleaning up migrations, mark the v1 migration as deprecated.

### F6: 13 migration comments explain Y.Doc rip-out but clutter the codebase
- **Severity**: low
- **Category**: dead-code
- **Evidence**: src/components/* (13 locations); src/hooks/* (8 locations)
- **What's wrong**: Comments like "Phase 2c-gamma: bulk transcribe/synth wrote attachments to Y.Doc; the grammar for bulk-attach is not in scope v1.x" are helpful during a v1/v2→v3 migration but clutter the codebase long-term.
- **Suggested fix**: Post-v3-stabilize (once v1.x features land), batch-delete comments using the pattern "Phase 2c-gamma" or "Y.Doc" from component files — they're internal documentation only. Keep them in hooks (useCells.ts, useFileMeta.ts, etc.) where they explain why fields have empty defaults.

### F7: cqrs-types.ts is a legacy re-export shim, not load-bearing
- **Severity**: low
- **Category**: legacy-v2
- **Evidence**: src/lib/sync/cqrs-types.ts
- **What's wrong**: Re-exports outbox-types under old names (CqrsEventKind, CqrsRawEvent) purely for "back-compat with in-flight Y.Doc-mirrored writers" — but no Y.Doc writers exist in v3. Used only by outbox.ts, outbox-flush.ts, and audit-stats overlay; callers could import from outbox-types directly.
- **Suggested fix**: Rename outbox-types imports in outbox*.ts and audit-stats to use the Cqrs* names, then delete cqrs-types.ts entirely. Or mark it as deprecated with a comment directing future readers to outbox-types.

### F8: ProjectSync DO lacks documentation; described only in wrangler.toml comment
- **Severity**: medium
- **Category**: doc-mismatch
- **Evidence**: sync-worker/wrangler.toml:18–19 (comment only); no docs/SYNC.md section
- **What's wrong**: ProjectSync is the new per-project DO responsible for focus locks, presence, and event fanout, but it's documented only in a 2-line wrangler.toml comment. New developers will look at docs/SYNC.md and find it missing.
- **Suggested fix**: Add a "The ProjectSync Durable Object" section to docs/SYNC.md describing: (1) One instance per project; (2) Holds transient locks (who's editing which cell) + presence (who's viewing which file); (3) Broadcasts `event.applied` frames to subscribed clients so they soft-revalidate without full refetch; (4) No D1/R2 writes from inside the DO.

### F9: No mention of first-child-of-parent guard (FWW conflict resolution) in user-facing docs
- **Severity**: medium
- **Category**: doc-mismatch
- **Evidence**: sync-worker/src/events/route.ts:4 (describes it); docs/SYNC.md (silent)
- **What's wrong**: The FWW guard is the core v3 conflict-resolution mechanism and explains why IDB + offline resilience works, but docs/SYNC.md doesn't mention it. Users building on the API don't understand idempotency semantics or why parentId matters.
- **Suggested fix**: Add a "Conflict resolution (last-write-wins with parent guard)" section to docs/SYNC.md explaining: (1) Every cell-mutating event carries a parentId (previous cell state's event_id); (2) Server rejects "stale siblings" — events whose parentId no longer matches the current cell.event_id; (3) Idempotent — replaying the same event ID always succeeds once (INSERT OR IGNORE); (4) IDB outbox survives tab close + automatic retry = safe offline editing.

### F10: unshed signaling/ directory contains only node_modules
- **Severity**: low
- **Category**: dead-code
- **Evidence**: /Users/ryderwishart/prototypes/codex-web-app/signaling/ (empty except node_modules)
- **What's wrong**: The directory exists but contains no source code, only stale node_modules. Likely a v1 artifact (presence relay?). Clutters the repo root.
- **Suggested fix**: Delete the directory entirely. If WebRTC presence signaling becomes relevant in v1.x, create a new isolated subproject.

## Open questions

- **ProjectSync event fanout**: docs don't specify what happens if a client misses an `event.applied` broadcast (network flake, tab backgrounded). Does the soft-revalidate happen on next poller tick? What's the timeout for replaying missed events?
- **Outbox batch size**: `MAX_BATCH` is 100; is this tuned for latency/throughput? What's the flush interval?
- **Stale sibling surfacing**: outbox-flush.ts logs rejected + stale events to console.error but doesn't persist them. Should the inspector UI surface these, or is the log sufficient?
- **R2 media vs. imports**: wrangler.toml claims "R2 holds canonical Y.Doc snapshots" — clarify whether R2 now holds **only** media blobs + import checkpoints, or if it still holds anything for cells/events.

## Files reviewed

- `/Users/ryderwishart/prototypes/codex-web-app/package.json` — no Yjs deps
- `/Users/ryderwishart/prototypes/codex-web-app/src/` — 13 Yjs-related comments in components + hooks; no imports
- `/Users/ryderwishart/prototypes/codex-web-app/src/lib/sync/` — outbox.ts, outbox-flush.ts, cqrs-bridge.ts, cqrs-types.ts, outbox-types.ts (all load-bearing)
- `/Users/ryderwishart/prototypes/codex-web-app/src/hooks/useFileSync.ts` — compatibility shim (no provider/doc)
- `/Users/ryderwishart/prototypes/codex-web-app/sync-worker/wrangler.toml` — wrong comments (y-partyserver, Y.Doc snapshots)
- `/Users/ryderwishart/prototypes/codex-web-app/sync-worker/src/index.ts` — FileSync returns 410; ProjectSync is live DO
- `/Users/ryderwishart/prototypes/codex-web-app/sync-worker/src/events/route.ts` — describes FWW guard + event ingestion
- `/Users/ryderwishart/prototypes/codex-web-app/docs/SYNC.md` — v1 y-partyserver flow, not v3
- `/Users/ryderwishart/prototypes/codex-web-app/docs/CQRS_LEGACY_IMPORT.md` — v1 hydration semantics, not v3
- `/Users/ryderwishart/prototypes/codex-web-app/AGENTS.md` — claims y-partyserver
- `/Users/ryderwishart/prototypes/codex-web-app/signaling/` — empty directory (dead code)
