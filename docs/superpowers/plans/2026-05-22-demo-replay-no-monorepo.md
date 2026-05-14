# Demo Branch Replay (No Monorepo) Implementation Plan

> **For agentic workers:** Each phase points to historical PRs on `main`. Read those diffs and port them into demo's **single-app** structure (`src/`, `sync-worker/`, `auth-worker/`, `chat-worker/`) — DO NOT recreate the `apps/<slug>/` split that exists on `main`. The `apps/` directory currently in demo's working tree is untracked leftover and should be ignored / removed.

**Goal:** Bring `demo` from the legacy single-app structure (HEAD `84867c8`) up to architectural parity with `main` (as of `1b2ac85`) — minus the monorepo split. Demo keeps `src/` (frontend), `sync-worker/` (CF Worker), `auth-worker/`, `chat-worker/`.

**Architecture target:**
- D1 `events` table = source of truth (append-only, AD-2).
- `cells` table = projection of events (queried for current state).
- Per-project Durable Object holds only transient state: presence, focus-locks, `event.applied` broadcasts. **No CRDT, no Yjs.**
- Writes: IndexedDB outbox → WS (DO) or HTTP fallback (`POST /events`). First-write wins by `UNIQUE(parent_id)`; later siblings stay as stale history.
- Reads: thin-client HTTP fetchers (`*-read.ts`) hitting `sync-worker` projections. Search index lives server-side.
- Health: decay metric + "biggest drags" popover (AD-14). No four-sub-score health.

**Current demo state (already done):**
- `sync-worker/src/events/` scaffolding exists: handlers, projection, hydrate, dispatch, role-policy, types.
- `src/lib/sync/outbox.ts` + `outbox-flush.ts` exist.
- Yjs is **still installed and wired** through 80+ files (this is the dominating work).

**Out of scope:**
- Monorepo split (`apps/` + `packages/`). Never replay this.
- `apps/front-door` Worker. Demo keeps Pages/Workers Assets as-is.
- `@aquilla/errors`, `routes.json`, `pnpm-workspace.yaml`, monorepo CI matrix.

**Tech stack:** Vite + React 19, CF Workers + D1 (`aquilla-db`) + R2 (`aquilla-snapshots`), TipTap (plain — **NO `@tiptap/extension-collaboration`**), Vitest + happy-dom + fake-indexeddb.

---

## Setup

- [ ] **Confirm working tree is clean** (`git status`). The untracked `apps/` dir in working tree is leftover — delete it: `rm -rf apps/`.
- [ ] **Verify base.** `git rev-parse HEAD` should be `84867c8` on branch `demo`.
- [ ] **Reference commits on main** (read these via `git show <sha>` — DO NOT cherry-pick blind because main paths are `apps/sync/...` while demo paths are `sync-worker/...`).

---

## Phase A — Finish AD-2 event log + outbox wiring (demo already has the scaffolding)

**Goal:** Make `sync-worker/src/events/` the real write path, with all client hooks reading projections via thin fetchers.

**Reference PRs on main:**
- [#79](https://github.com/genesis-ai-dev/codex-web-app/pull/79) `2560147` — schema reshape (`events` + `cells.event_id` + `cells.source_event_id`)
- [#80](https://github.com/genesis-ai-dev/codex-web-app/pull/80) `63d2ba4` — sync-worker reads + useCells migration
- [#81](https://github.com/genesis-ai-dev/codex-web-app/pull/81) `5baa91d` — read-side hooks migration (the `*-read.ts` typed fetchers)
- [#82](https://github.com/genesis-ai-dev/codex-web-app/pull/82) `cc02ca7` — outbox emitters + per-project DO + WS focus locks
- [#91](https://github.com/genesis-ai-dev/codex-web-app/pull/91) `c323b77` — editor + importer rewritten on events (plain TipTap)

### A.1 — Schema audit

- [ ] Confirm `sync-worker/migrations/` (or wherever migrations live in demo) has:
  - `events(event_id PK, parent_id UNIQUE, project_id, file_id, cell_id, kind, payload, actor, created_at)`
  - `cells.event_id` (chain head) + `cells.source_event_id` (AD-9 staleness pin)
  - `files.event_id`
- [ ] If missing, port the SQL from main's `apps/sync/migrations/` (rewrite paths only). Backfill script: synthetic `source.cell.create` per existing row.
- [ ] Apply to staging D1 fork and verify.

### A.2 — Read-side fetchers (`*-read.ts`)

- [ ] Diff `apps/sync/src/...` (read routes on main) vs `sync-worker/src/events/...read-route.ts` on demo. Port any missing read routes.
- [ ] On the client, ensure every "read" hook (cells, files, validators, audit stats, history, comments, waivers) goes through a typed fetcher in `src/lib/sync/*-read.ts` rather than a Y.Doc subscription.

### A.3 — Outbox + DO write path

- [ ] Verify `src/lib/sync/outbox.ts` is the only producer of writes. All edits emit a `CqrsRawEvent`, NOT a Y.Doc mutation.
- [ ] DO (`sync-worker/src/events/realtime.ts`) handles: WS presence, focus-lock claim/release, `event.applied` broadcast. Verify against main's `apps/sync/src/.../realtime.ts`.
- [ ] HTTP fallback `POST /events` exists and is idempotent (event_id is client-generated UUID).

**Success:** A cell edit on one tab projects to D1 via outbox, broadcasts via DO, and a second tab fetches the projection — no Y.Doc on either side.

---

## Phase B — Yjs rip (the big one) ⚠️ **central refactor**

**Goal:** Delete every Y.Doc/yjs reference. TipTap stays as a plain editor (no `@tiptap/extension-collaboration`). 80 files involved.

**Reference commits on main:**
- `88c5df4` — first wave: delete Y.Doc files (hooks, lib/store, audio writebacks, codex-editor edits, serialize, search)
- `e6867f6` — untangle `ProjectWorkspace` / `EditorTable` / feature-page Y.Doc gates
- `e4cf552` — drop `yjs` / `y-indexeddb` / `y-prosemirror` / `@tiptap/extension-collaboration` deps

### B.1 — Map every Y.Doc consumer to its replacement

Inventory (80 files; the recon subagent produces this matrix):

| Category | Demo files | Replacement on main |
|---|---|---|
| `useCells*` hooks | `useCells.ts`, `useCells.test.ts`, etc. | Thin-client fetcher (`cells-read.ts`) + outbox emitter |
| `useFile*` hooks | `useFileDoc.ts`, `useFileMeta.ts`, `useFileSync.ts` | `files-read.ts` + outbox |
| `useComments` / `useCompletion` / `useAutofix` / `useBacktranslation` / `useSectionProgress` / `useVideoAttachment` / `useCellHistory` / `useCellWaivers` | each replaced by typed read + outbox emit | (one-to-one in main; trace each) |
| `lib/codex-editor/edits/*` | `commit-cell-edit.ts`, `commit-meta-edit.ts`, `seed-from-source.ts`, `toggle-cell-validation.ts`, `yjs-helpers.ts` | event emitters in main; `yjs-helpers.ts` is **deleted** |
| `lib/codex-editor/serialize/*` | `cell.ts`, `file.ts`, `comments.ts` | replaced by projection on server |
| `lib/store/file-doc.ts` / `snapshots.ts` | both | **deleted** on main |
| `lib/sync/cqrs-bridge.ts` / `partyserver-provider.ts` / `y-partyserver-spike.test.ts` | all | bridge becomes a slim shim, provider + spike **deleted** |
| `lib/audio/*` (attach/bulk/timings/transcribe/synth-and-attach) | all use Y.Doc for writeback | event-emitted writes |
| `lib/richtext/translated-xml.ts` | XML ↔ Y.Doc bridge | XML ↔ plain TipTap |
| `lib/search/replace-action.ts` | uses Y.Doc to apply replace | emits replace events |
| `components/EditorTable.tsx`, `TranslatedEditor.tsx`, `ProjectWorkspace.tsx`, `CellTranscriptPreview.tsx`, `ParallelPassagesPanel.tsx`, `CommentsPage.tsx`, `RuleDrawer.tsx`, `SelectionBar.tsx`, `VoiceBar.tsx`, `CellActionsMenu.tsx`, `CellExpansion.tsx`, `CellTranscribeBadge.tsx`, `HistoryDrawer.tsx`, `AudioRecorder/AudioRecordingModal.tsx` | various Y.Doc props/state | take typed values + emit events |

### B.2 — Execute the rip (mirror main's three-step shape)

- [ ] **Step 1 (mirror `88c5df4`):** Delete the leaf Y.Doc consumer files: `lib/store/file-doc.ts`, `lib/store/snapshots.ts`, `lib/codex-editor/serialize/*`, `lib/codex-editor/edits/yjs-helpers.ts`, `lib/sync/partyserver-provider.ts`, `lib/sync/y-partyserver-spike.test.ts`, all `lib/audio/*` Y.Doc writebacks, `lib/search/replace-action.ts` Y.Doc path, `lib/richtext/translated-xml.ts` Y.Doc bridge. For each, port the main replacement.
- [ ] **Step 2 (mirror `e6867f6`):** Strip Y.Doc props from `ProjectWorkspace.tsx`, `EditorTable.tsx`, each feature-page component. Replace with `useCells({ fileId, ... })`-style fetchers and event-emit callbacks.
- [ ] **Step 3 (mirror `e4cf552`):** `pnpm rm yjs y-indexeddb y-prosemirror @tiptap/extension-collaboration`. Confirm `vite build` + `vitest run` are green.

### B.3 — TipTap reconfigure

- [ ] Reconfigure TipTap editor instance to be plain (no `Collaboration` / `CollaborationCursor`). Mirror `apps/workspace/.../TranslatedEditor.tsx` on main.

**Success:** `rg -l 'yjs|Y\\.Doc|y-indexeddb|y-prosemirror|@tiptap/extension-collaboration' src/` returns nothing. Editor still works in browser preview.

---

## Phase C — AD-11 rename pass (`codex-* → aquilla-*`)

**Reference commit:** `813bb93`.

- [ ] Rename worker bindings, KV namespaces, R2 buckets in `sync-worker/wrangler.toml` and `auth-worker/wrangler.toml`: `codex-* → aquilla-*`.
- [ ] R2 bucket → `aquilla-snapshots` (commits `0544498`, `56b8a83`).
- [ ] D1 → `aquilla-db`.
- [ ] Update all client-side fetch URLs / env vars accordingly.
- [ ] Update `auth-worker/` and `chat-worker/` similarly.

---

## Phase D — Identity self-hosted (replace legacy frontier-server)

**Reference commits:**
- `87d3666` (PR #104) — real identity app replacing stubs.
- `bb22bc1` — identity D1 migrations auto-apply on prod deploy.
- `57d54d3` — cut legacy frontier-server identity surface from runtime.

**Memory note:** Per `project_y_sweet_migration` and `feedback_frontier_server_pr_flow`, identity now self-hosted in this repo (formerly under `frontier-server`). Do NOT extend the external `frontierrnd/frontier-server` repo for this work.

- [ ] Promote `auth-worker/` (demo's current auth surface) to be the AD-11 identity Worker. Port code from main's `apps/identity/` but keep it at `auth-worker/` path.
- [ ] Port the migrations runner (`bb22bc1`).
- [ ] Strip all references to legacy `frontier-server` URLs from `src/lib/frontier/` and friends (commit `57d54d3`).

---

## Phase E — D1 schema alignment to aquilla-specs

**Reference commits:** `43eea00`, `f10a4e8`, `f01b779`.

- [ ] Files-meta + `event_id` columns.
- [ ] Validators `DELETE` route.
- [ ] Role constants live in code (no `roles` D1 table).
- [ ] Apply to a per-PR D1 fork; run integration tests.

---

## Phase F — AD-13 branching search + corpus + KV cache

**Reference commits:** `c16ef51`, `a12eb2d`, `3e9fae2`, `f9a9f1b`.

- [ ] Port branching-search primitive + AI copilot rewire (`c16ef51`).
- [ ] `branchingSearch` tunables from `project_settings` (`a12eb2d`).
- [ ] KV cache + `/passages` route on `sync-worker` (`3e9fae2`).
- [ ] Add `idx_cells_pair_lookup` migration (`f9a9f1b`).
- [ ] **Search index lives server-side.** Confirm no client-side full-text index.

---

## Phase G — AD-14 decay health

**Reference commits:** `f01b779`, `24323c4`.

- [ ] Delete the four-sub-score health modules under `src/lib/health/`.
- [ ] Port the decay engine + "biggest drags" popover from main.
- [ ] Per-cell needs-attention marker.
- [ ] `useHealth` memoises per cell by content signature (`553ec95`).

---

## Phase H — Server-side import projection

**Reference commit:** `b6155ae` (+ `4bb0aec`).

- [ ] Port `POST /import` on `sync-worker` — server-side projection so eBible importer doesn't round-trip N events.
- [ ] Client-side bulk-enqueue in a single IDB tx (`4bb0aec`).
- [ ] Client onboarding creates server project row; trash handles orphan IDB rows (`c1b35b6`).

---

## Phase I — Hosting & dev stack

**Reference commits:** `2b5367f`, `642e1ff`, `477e745`.

- [ ] Mount `sync-worker` under `aquilla.app/api/sync` (fixes Safari blocking `*.workers.dev`).
- [ ] Local dev stack: `scripts/dev-stack.ts` boots `auth-worker` + `sync-worker` + Vite, against local D1/R2 with shared `.wrangler-dev-state/`. Wire as `pnpm dev`.

---

## Phase J — Smaller polish (parallel-safe)

- [ ] Seed-VC voice cloning (`41b9ad6`) — Modal endpoint + sync-worker convert proxy.
- [ ] Neumorphic UI refresh (`8cfcd8e` → `16460e2`) — palette + spacing.
- [ ] Hide project-shape picker behind "Advanced" (`c99f8d5`).
- [ ] WS reconnect storm fix on fileless projects (`fa8ca9d`).
- [ ] Banner z-index polish (`88c95da`).
- [ ] Dropdown/tooltip paint order (`d678591`).

---

## Subagent dispatch strategy

**Order matters — phase dependencies:**
1. **Phase A** must complete first (events foundation). Single sonnet agent, sequential.
2. **Phase B (Yjs rip)** depends on A. Single sonnet agent, sequential — too entangled to parallelise.
3. **Phases C–J** can run in parallel after B lands. Dispatch one sonnet per phase.

**Each subagent gets:**
- This plan file path.
- The phase letter to execute.
- The specific commit shas / PRs on main to reference.
- Explicit reminder: "Demo uses single-app structure. Main uses `apps/<slug>/`. Translate paths."

---

## Self-review

- [x] Phase A covers AD-2 schema + reads + outbox.
- [x] Phase B is the Yjs rip with explicit file-by-file map.
- [x] Phase C covers the rename pass (AD-11 + R2).
- [x] Phase D covers identity (AD-11 identity + frontier-server cut).
- [x] Phase E covers schema alignment.
- [x] Phase F covers AD-13.
- [x] Phase G covers AD-14.
- [x] Phase H covers server-side projection imports.
- [x] Phase I covers hosting + dev stack.
- [x] Phase J covers polish.
- [x] Monorepo split (apps/, packages/, routes.json, front-door) explicitly excluded throughout.
