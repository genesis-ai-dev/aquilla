# v3 Audit — Docs vs Code

## Summary

v3 implementation is **D1 event-sourced with projection-based reads**, not Yjs/y-partyserver. AGENTS.md and SYNC.md both claim "y-partyserver on Durable Objects + R2" as the current stack, contradicting the actual architecture. FileSync (legacy per-file CRDT DO) is removed; ProjectSync (per-project coordination for presence + focus-locks) is the current transient layer. D1 event log is the single source of truth; R2 holds media blobs only.

## Doc inventory

| doc | status | one-line summary |
| --- | --- | --- |
| AGENTS.md | stale | Claims Yjs/y-partyserver stack as current |
| SYNC.md | stale | Describes per-file CRDT room (FileSync) + R2 snapshots; real impl is event-sourced D1 + ProjectSync |
| CQRS_LEGACY_IMPORT.md | current | Event log → D1 projection model; matches v3 |
| MMS_R2_HOSTING.md | current | MMS TTS R2 hosting; orthogonal to sync |
| SPEC.md | current | VS Code extension + desktop Tauri shell; web app not primary target |
| TODO.md | current | Tauri release checklist |
| docs/design/project-setup-flow.html | aspirational | Interactive mockup; not implementation docs |

## Findings

### F1: AGENTS.md Yjs/y-partyserver claim

- **Severity**: high
- **Category**: doc-stale
- **Evidence**: AGENTS.md line 33: "The sync stack is y-partyserver on Cloudflare Durable Objects + R2"
- **What's wrong**: v3 uses D1 event-log + ProjectSync (per-project coordination DO). No Yjs document runtime. No per-file CRDT room.
- **Suggested fix**: Replace with "The sync stack is D1 event log (identity of record) + per-project Durable Object for presence/focus-locks + R2 for media only."

### F2: SYNC.md FileSync per-file CRDT room

- **Severity**: high
- **Category**: doc-stale
- **Evidence**: SYNC.md line 36 describes "aquilla-sync-worker hosting one Durable Object per file" with "Y.Doc in memory" (lines 66–68). Line 25 diagram shows "/parties/file-sync/{docId}" WebSocket.
- **What's wrong**: sync-worker/src/index.ts line 73–78 declares FileSync as deprecated: "FileSync CRDT runtime removed; use ProjectSync and /events". Real endpoint is /parties/project-sync/{projectId}.
- **Suggested fix**: Rewrite entire SYNC.md to describe (1) POST /events endpoint → D1, (2) ProjectSync DO for presence/locks, (3) event projection to build cells/files tables, (4) clients read projections via HTTP routes.

### F3: SYNC.md R2 snapshot + tail compaction

- **Severity**: high
- **Category**: doc-stale
- **Evidence**: SYNC.md lines 66–76 detail snapshot.bin + tail/*.bin R2 layout and compaction alarm. Line 113–124 shows R2 directory tree.
- **What's wrong**: R2 is now media-only (audio files, original imports). Event log is in D1. No snapshot/tail compaction logic needed.
- **Suggested fix**: Remove R2 layout section. Keep R2 only for cell audio blobs (sync-worker/src/audio.ts).

### F4: SYNC.md Yjs sync protocol and onSave debounce

- **Severity**: high
- **Category**: doc-stale
- **Evidence**: SYNC.md lines 63–72 describe "Yjs sync protocol", "onSave debounce (2s / max 10s)", "Y.mergeUpdates", "fingerprint dedup".
- **What's wrong**: v3 uses POST /events (HTTP) + D1 batch inserts. No Yjs protocol. No debounce; events are persisted immediately on POST. Dedup is via AD-2 first-child-of-parent guard (sync-worker/src/events/event-projection.ts line 8).
- **Suggested fix**: Replace with event persistence flow: POST /events → authorize → idempotency check → server_seq assign → AD-2 guard → build D1 stmts → batch commit → broadcast.

### F5: SYNC.md hidden tab provider.disconnect() and idleness

- **Severity**: medium
- **Category**: doc-stale
- **Evidence**: SYNC.md lines 76–77: "Hidden tab > 5 min → client provider.disconnect()... Visible again → provider.connect()".
- **What's wrong**: ProjectSync is presence-only; D1 holds all state. Disconnect doesn't lose data; it just stops broadcasting presence. The client can reconnect anytime.
- **Suggested fix**: Clarify that disconnecting doesn't affect data durability; it only pauses real-time presence updates.

### F6: SYNC.md JWT omits `sub` and audience check

- **Severity**: low
- **Category**: doc-stale
- **Evidence**: SYNC.md lines 92–93 claim JWTs intentionally omit `sub` and use `aud: "sync"`.
- **What's wrong**: This claim is true in the code (frontier-server mints sync tokens with aud:sync), but SYNC.md's overall context is stale. Keep this note but update surrounding paragraphs.
- **Suggested fix**: Keep as-is; move this section into a new "Security model" doc that explains both sync-token JWT structure and event authorization.

### F7: SYNC.md references stale dependencies

- **Severity**: low
- **Category**: doc-aspirational
- **Evidence**: SYNC.md lines 113–124 refer to codex-db FTS5 virtual table kept in sync by triggers.
- **What's wrong**: event-projection.ts line 60 shows `ProjectionTouches` includes 'cells' but FTS is mentioned in the projection code. However, the R2 snapshot/tail section claiming to drive this is gone.
- **Suggested fix**: Clarify which D1 tables are core (events, cells, files) vs. derived (cells_fts is built from cells table via triggers).

### F8: CQRS_LEGACY_IMPORT.md uses stale terminology

- **Severity**: medium
- **Category**: doc-mixed
- **Evidence**: CQRS_LEGACY_IMPORT.md line 29 refers to "FileSync Durable Object boots, finds no R2 snapshot, replays events". Line 31 mentions "persists the result back to R2 as the initial snapshot".
- **What's wrong**: v3 doesn't use FileSync or persist Y.Docs to R2. Events are the source of truth; projections are derived on-the-fly (or cached in D1).
- **Suggested fix**: Rewrite: "When a client requests /cells/{fileId}, the route reads from the cells D1 projection. If the projection is empty and events exist, hydrate on-the-fly (or lazy-load from cached checkpoint)."

### F9: Missing docs for v3 event schema

- **Severity**: high
- **Category**: doc-missing
- **Evidence**: sync-worker/src/events/types.ts exists and defines EventKind unions, but docs don't enumerate them.
- **What's wrong**: No public doc lists the event kinds (source.cell.create, target.cell.create, cell.commit, cell.validate, etc.) and their payloads.
- **Suggested fix**: Create docs/EVENT_SCHEMA.md with event kind reference, payload shape, and auth requirements.

### F10: Missing docs for v3 DB schema

- **Severity**: high
- **Category**: doc-missing
- **Evidence**: SYNC.md lines 106–111 briefly list codex-db tables but don't show the actual schema. sync-worker has D1 migrations in (inferred from imports) but no public schema doc.
- **Suggested fix**: Create docs/D1_SCHEMA.md with full CREATE TABLE statements for events, cells, files, cell_validators, cells_fts, checkpoints.

### F11: AGENTS.md references frontier-server y-partyserver endpoint

- **Severity**: medium
- **Category**: doc-stale
- **Evidence**: AGENTS.md line 33 states "The sync stack is y-partyserver on Cloudflare Durable Objects". No mention of POST /events or event-sourcing.
- **What's wrong**: Developers reading AGENTS.md will expect Yjs + WebSocket sync protocol, not HTTP event log.
- **Suggested fix**: Update to: "Sync is event-sourced to D1 via POST /events (HTTP). Real-time presence and focus-locks live in per-project Durable Object."

### F12: SYNC.md testing section outdated

- **Severity**: low
- **Category**: doc-stale
- **Evidence**: SYNC.md lines 166–176 reference `y-partyserver-spike.test.ts` and "round-trip assertions". sync-worker test references assume Yjs protocol.
- **What's wrong**: No Yjs spike; tests should be event-log integration tests. File references may be outdated.
- **Suggested fix**: Verify test files exist, update descriptions to reflect event-log test strategy (e.g., POST event → read projection → assert row).

### F13: ProjectSync introduced but undocumented in SYNC.md

- **Severity**: medium
- **Category**: doc-missing
- **Evidence**: sync-worker/src/project-do.ts defines ProjectSync (per-project coordination). SYNC.md has no section explaining presence, focus-locks, or the __broadcast hook.
- **What's wrong**: Operators cannot understand how real-time coordination works without reading code.
- **Suggested fix**: Add section to SYNC.md: "Per-Project Coordination" describing ProjectSync role, presence state, focus-lock leases, and __broadcast relay from POST /events.

### F14: No runbook for local D1 setup

- **Severity**: medium
- **Category**: doc-missing
- **Evidence**: SYNC.md "Running locally" (lines 143–157) shows wrangler dev commands but doesn't mention D1 binding or schema setup.
- **What's wrong**: Dev will hit "AQUILLA_DB not bound" errors. No instructions to create D1 locally or seed it.
- **Suggested fix**: Add step: "Create local D1 database: `wrangler d1 create codex-dev`. Apply schema from migrations. Bind in wrangler.toml."

### F15: sync-debug.ts wired but undocumented

- **Severity**: low
- **Category**: doc-missing
- **Evidence**: sync-debug.ts is labeled "legacy provider path" and "AD-1 removes the file provider from production". AGENTS.md says nothing about debug tooling.
- **What's wrong**: No doc explaining how to enable sync debugging (sessionStorage flag, console output, etc.).
- **Suggested fix**: Add section to AGENTS.md or create docs/DEBUG.md with: "To debug sync, set sessionStorage.setItem('codex.debug.sync', '1') and watch console logs."

## Open questions

- Is ProjectSync eventually removing all transient state (incl. presence) when the room empties? If so, what's the lifecycle for late-joining clients to discover who else is online?
- What's the checkpoint mechanism in CQRS_LEGACY_IMPORT.md? Is it still used for recovery or has it been replaced?
- How does the branching-search KV cache (sync-worker/src/events/branching-search-route.ts line 58) interact with the event log? Is it a perf optimization or required for correctness?

## Files reviewed

- AGENTS.md
- docs/SPEC.md
- docs/SYNC.md
- docs/CQRS_LEGACY_IMPORT.md
- docs/MMS_R2_HOSTING.md
- TODO.md
- sync-worker/src/index.ts
- sync-worker/src/project-do.ts
- sync-worker/src/events/event-projection.ts
- sync-worker/src/events/route.ts
- sync-worker/src/events/broadcast.ts
- src/lib/sync/sync-debug.ts
