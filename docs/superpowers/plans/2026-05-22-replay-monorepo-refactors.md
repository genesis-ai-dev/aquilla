# Replay Monorepo Refactors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan style note:** Unlike the writing-plans skill template — which mandates *complete code in every step* for greenfield work — this plan is a **roadmap-style replay** of refactors that already exist on `main`. Each phase points to the historical PR(s) so the engineer can read the actual diff rather than re-derive code from prose. The skill rule "DRY, YAGNI, TDD, frequent commits" still applies inside each phase; only the literal "paste every code block" guidance is dropped, intentionally.

**Goal:** Starting from `e736e69` (Phase 1B — monorepo skeleton landed on `dev`; all 13 `apps/<slug>/` dirs and 6 `packages/*` exist as shells, no AD-2 work yet), replay the ~10 architectural refactors that hit `main` between 2026-05-13 and 2026-05-22. The skeleton itself is *not* replayed — that mechanical churn is inherited from the base.

**Out of scope (already in the base, do NOT redo):** monorepo layout (`apps/` + `packages/`), `apps/front-door` shell, `@aquilla/errors`, `routes.json`, `pnpm-workspace.yaml`, CI matrix workflows (`deploy-apps-prod.yml`, `deploy-all-apps.yml`, `pr-db-fork.yml`). The 13 app shells exist but are unpopulated; populating them is Phase 2.

**Architecture:** Tier-1 thin-client SPA over an append-only D1 event log (AD-2/AD-9), backed by per-task Cloudflare Workers (one Worker per slug + a front-door catch-all + shared `@aquilla/*` packages). Realtime via a per-project Durable Object holding only transient state (focus-locks, presence, `event.applied` broadcasts); durable writes go through an IndexedDB outbox with WS-or-HTTP egress.

**Tech Stack:** pnpm workspaces (with `file:../../` cross-package deps, not `workspace:*`), Cloudflare Workers + Workers Assets, Vite + React 19, Tailwind v4 + shadcn/ui, D1 (`aquilla-db` + per-PR forks), R2 (`aquilla-snapshots`), TipTap (plain — no `@tiptap/extension-collaboration`), Vitest with `happy-dom` + `fake-indexeddb`.

> **Phase numbering note:** Phase 1 in an earlier draft was "Monorepo Skeleton" — dropped because the base commit already provides it. Phases are numbered 2-13 to preserve historical mapping; there is no Phase 1 in this plan.

---

## Setup: branch + working-tree hygiene

**Files:**
- N/A (git state only)

- [ ] **Step 1: Resolve uncommitted work**

The current `main` working tree has uncommitted edits in `useCells`, `cell-area-state`, `cells-read`, and a new `WorkspaceSkeleton.tsx`. Decide before checkout:

```bash
git status
# Option A — stash for later:
git stash push -u -m "pre-replay-branch wip useCells/cell-area"
# Option B — commit to a side branch first:
git switch -c wip/pre-replay-stash && git add -A && git commit -m "wip: stash pre-replay" && git switch -
# Option C — discard (only if you're SURE — destructive):
# git restore -SW . && git clean -fd apps/workspace/src/components/WorkspaceSkeleton.tsx
```

- [ ] **Step 2: Create the replay branch from the post-skeleton base**

```bash
git switch -c replay/event-log-and-after e736e69
# Sanity-check: apps/ and packages/ exist as skeletons; no AD-2 events schema yet
test -d apps && test -d packages
test ! -f apps/sync/migrations/*events*.sql 2>/dev/null && echo "OK: no events migration yet"
ls apps/  # 13 shells: billing, export, front-door, frontier-server, import, login, migrate, org, projects, reset, signup, workspace
ls packages/  # 6 packages: api-client, auth-client, data-model, errors, telemetry, ui
```

- [ ] **Step 3: Optionally include Phase 1c (#78)**

Phase 1c added `project_settings` + source-project routes on top of the skeleton. It's content, not skeleton — include it in your base only if you want to skip re-doing that piece too:

```bash
git cherry-pick 1b172b1  # phase 1c: project_settings + source-project routes (#78)
```

- [ ] **Step 4: Tag the base + record what `main` we diff against**

```bash
git tag replay-base
git config branch.replay/event-log-and-after.description "Replay of e736e69..main (AD-2 event log → AD-14 decay → local dev stack). Reference: origin/main as of $(git rev-parse --short origin/main)."
```

---

## Phase 2 — AD-2 event log + outbox foundation

**Goal:** Move durable writes off Y.Doc and onto an append-only `events` table in D1. Read paths fetch directly from `apps/sync` HTTP endpoints; write paths go through an IndexedDB outbox that egresses via WS (per-project DO) or HTTP fallback (`POST /events`).

**Historical references:**
- [#79 — phase 1a: events + cells schema reshape (AD-2 + AD-9)](https://github.com/genesis-ai-dev/codex-web-app/pull/79) at `2560147`
- [#80 — phase 2a: sync-worker reads + useCells migration](https://github.com/genesis-ai-dev/codex-web-app/pull/80) at `63d2ba4`
- [#81 — phase 2b: read-side hooks migration](https://github.com/genesis-ai-dev/codex-web-app/pull/81) at `5baa91d`
- [#82 — phase 2c-α: outbox emitters + per-project DO + WS focus locks](https://github.com/genesis-ai-dev/codex-web-app/pull/82) at `cc02ca7`
- [#91 — phase 2c-β: editor rewrite (plain TipTap) + import flow rewrite + useProject thin-client](https://github.com/genesis-ai-dev/codex-web-app/pull/91) at `c323b77`

This phase is the foundation everything else stacks on. **Treat it as four sub-phases — commit between each.**

### 2.1 — Schema reshape (Phase 1a)

**Files:**
- Create: `apps/sync/migrations/00XX_events.sql` (append-only `events(event_id, parent_id, project_id, file_id, cell_id, kind, payload, actor, created_at)`)
- Modify: `apps/sync/migrations/*_cells.sql` — add `event_id` (chain head) and `source_event_id` (AD-9 staleness pin) columns to `cells`
- Modify: `apps/sync/migrations/*_files.sql` — add `event_id` to `files`

**Note on Worker location:** at `e736e69` the sync code may still live at `sync-worker/` (top-level) — Phase 4 below relocates it to `apps/sync/`. If so, author migrations at the *current* location in your base; they'll move along with the rest of the worker in Phase 4.

**Key decisions:**
- AD-2 is **content-only**: project / org / member / settings / invite lifecycle stays as plain relational CRUD in identity — don't event-source them.
- `UNIQUE(parent_id)` enforces "first child of a parent wins; siblings stay as stale history."
- `cells.source_event_id` is the AD-9 staleness pin: a target cell points at the source event it was authored against; later source edits raise a "this cell may be stale" indicator.

**Success criteria:** Migration applies cleanly to a fresh `aquilla-db-staging` clone; existing cells get backfilled `event_id`s via a one-shot SELECT-and-INSERT into `events` (one synthetic `source.cell.create` per cell).

- [ ] **Step 2.1.1: Write the events schema migration.**
- [ ] **Step 2.1.2: Write a backfill script** that converts existing `cells` rows to seed `source.cell.create` events.
- [ ] **Step 2.1.3: Apply to a per-PR D1 fork; verify with `wrangler d1 execute --remote`.**
- [ ] **Step 2.1.4: Commit.**

### 2.2 — Read-side hooks (Phase 2a + 2b)

**Files:**
- Create: `apps/workspace/src/lib/sync/cells-read.ts`, `cells-read-types.ts` (typed `fetch` wrappers paired with response-shape mirrors)
- Create: `apps/workspace/src/lib/sync/project-read.ts`, `cell-history-read.ts`, `cell-validators-read.ts`, `file-meta-read.ts`, `workspace-search-read.ts`, `project-members-read.ts`, `org-invites-read.ts`, `project-settings-read.ts`
- Modify: `apps/workspace/src/hooks/useCells.ts`, `useProject.ts`, etc. — drop IDB fallback, drop React Query, use `useState` + race-guarded `useEffect`
- Add: `apps/sync/src/routes/cells.ts` — `GET /api/v1/projects/:projectId/files/:fileId/cells` returns paired source + target rows in anchor-chain order

**Key decisions:**
- **No React Query, no SWR** — race-guarded `useEffect` with an `aborted` flag is the v1 read pattern. (Justification: minimal deps, predictable, and the WS reconciler is the cache-invalidation channel.)
- **`useProject` has no IDB fallback** — a miss surfaces as `status: 'not-found'`. (Per AD-3.)

**Success criteria:** Workspace loads a project + file with no IndexedDB reads on the hot path; network panel shows `GET /api/v1/projects/...` returning paired cells.

- [ ] **Step 2.2.1: Add the cells read endpoint to `apps/sync`.**
- [ ] **Step 2.2.2: Add `cells-read.ts` + `cells-read-types.ts` on the client.**
- [ ] **Step 2.2.3: Rewrite `useCells` to use the new endpoint; delete IDB read path.**
- [ ] **Step 2.2.4: Add the remaining read endpoints + hooks** (`useProject`, `useCellHistory`, `useCellValidators`, `useFileMeta`, `useWorkspaceSearch`, `useProjectMembers`, `useOrgInvites`, `useProjectSettings`).
- [ ] **Step 2.2.5: Test:** open the workspace with `localStorage.clear()` and verify a cold load works on a fresh device.
- [ ] **Step 2.2.6: Commit.**

### 2.3 — Outbox + per-project Durable Object (Phase 2c-α)

**Files:**
- Create: `apps/workspace/src/lib/sync/outbox.ts` (IndexedDB `outbox` store; UUIDv7 ids for idempotency)
- Create: `apps/workspace/src/lib/sync/events-emit.ts` — typed helpers: `emitTargetCellCommit`, `emitCellValidate`, `emitCellUnvalidate`, `emitSourceCellCreate`, `emitFileCreate`
- Create: `apps/workspace/src/lib/sync/outbox-types.ts` — `RawEvent<K>` grammar mirror of the server
- Create: `apps/workspace/src/lib/sync/ws-reconciler.ts` — per-project WS client (`wss://<sync-host>/parties/project-sync/:projectId`)
- Create: `apps/workspace/src/hooks/useOutboxFlusher.ts` — drains pending events in batches via WS or HTTP fallback
- Create: `apps/workspace/src/hooks/useFocusLock.ts` — `focus.claim` / `focus.renew` / `focus.release` per cell
- Create: `apps/sync/src/project-do.ts` — Durable Object holding focus-locks, presence, `event.applied` / `event.stale` broadcasts (NO storage writes; rooms evict when empty)
- Add: `apps/sync/src/routes/events.ts` — `POST /events` HTTP fallback

**Key decisions:**
- **The DO is purely transient** — no `state.storage` writes. (Reason: D1 is the source of truth; the DO is a fanout/lease holder. Two writers don't fight for the same cell; AD-1 says no CRDT, no OT.)
- "First child of a parent wins; siblings stay as stale history" — enforced by `UNIQUE(parent_id)` plus `409` response on conflict, then the client revalidates.

**Success criteria:**
- Type into a cell offline → reconnect → events flush in order, `cell.targetEventId` advances.
- Two browsers focus the same cell → second one sees a "claimed by Alice" indicator.
- Kill the WS mid-edit → outbox falls back to HTTP `POST /events`, no events lost.

- [ ] **Step 2.3.1: Implement the IndexedDB outbox + UUIDv7.**
- [ ] **Step 2.3.2: Implement `events-emit.ts` typed helpers.**
- [ ] **Step 2.3.3: Implement `project-do.ts` + WS client.**
- [ ] **Step 2.3.4: Implement `POST /events` HTTP fallback.**
- [ ] **Step 2.3.5: Implement `useFocusLock` + render presence indicators.**
- [ ] **Step 2.3.6: Offline + reconnect smoke test.**
- [ ] **Step 2.3.7: Commit.**

### 2.4 — Editor + import switchover (Phase 2c-β)

**Files:**
- Modify: `apps/workspace/src/components/TranslatedEditor.tsx` — plain TipTap, no `@tiptap/extension-collaboration`, debounce to `COMMIT_IDLE_MS` (~1.2s), call `onCommit({ value, valueHtml })` on idle/blur/lock-release
- Modify: `apps/workspace/src/components/EditorTable.tsx` (row) — emit `target.cell.commit` via outbox, chained on `cell.targetEventId`, pinned to `cell.sourceEventId`
- Modify: `apps/workspace/src/lib/import.ts` — no Y.Doc; emit `file.create` + N `source.cell.create` events into outbox, chained via `anchorCellId`
- Modify: parsers under `apps/workspace/src/lib/parsers/` to keep emitting `TranslatableString[]` (the intermediate shape) but consumed by the new import path
- Add: "this cell changed elsewhere — discard and reload" banner when remote `event.applied` arrives for the focused cell

**Key decisions:**
- Editor hydrates from `cell.translatedHtml`, falling back to `cell.translated` — keep the HTML/text dual-write while completion + backtranslation still write via the old path (they get switched in their own phases later).
- Imported source blobs go to R2 (AD-4); the client keeps no local copy.

**Success criteria:**
- Type → idle 1.2s → commit appears in `events` table with `kind='target.cell.commit'`, `parent_id` chained.
- Import a USFM file → progress bar advances per cell-event flush; `files` + `cells` projection lands in D1.
- Two browsers editing the same cell → second one gets the "discard / keep" banner.

- [ ] **Step 2.4.1: Rip Y.Doc binding from `TranslatedEditor`** (keep the file's Y.Doc-aware utility neighbors; full rip is Phase 10).
- [ ] **Step 2.4.2: Wire `EditorTable` row to emit `target.cell.commit`.**
- [ ] **Step 2.4.3: Rewrite `import.ts` to emit `file.create` + N `source.cell.create`.**
- [ ] **Step 2.4.4: Add the "this cell changed elsewhere" banner.**
- [ ] **Step 2.4.5: End-to-end smoke: import → edit → reload → see persisted state.**
- [ ] **Step 2.4.6: Commit.**

---

## Phase 3 — Populate the remaining app shells + extract workspace

**Goal:** Fill in the 13 `apps/<slug>/` shells that exist as scaffolds at the base commit. Stand up real implementations for `login`, `signup`, `reset`, `projects`, `billing`, `org`, `import`, `export`, `migrate`, `identity` (originally `frontier-server`), and finally extract the workspace SPA out of the repo root into `apps/workspace/`.

**Historical references:**
- [#84 — phase 3a-shell + 4 final-sweep (partial): workspace scaffolding + completion-service rename](https://github.com/genesis-ai-dev/codex-web-app/pull/84) at `debf14b`
- Phase 3b — login/signup/reset (`42ec9dc`)
- [#90 — phase 3c: apps/projects + apps/billing + apps/org + @aquilla/api-client](https://github.com/genesis-ai-dev/codex-web-app/pull/90) at `3c8be37`
- [#93 — phase 3d minimal: import/export/migrate app shells](https://github.com/genesis-ai-dev/codex-web-app/pull/93) at `42bdf2b`
- [#89 — phase 3e: auth-worker → apps/frontier-server (AD-5 + AD-11)](https://github.com/genesis-ai-dev/codex-web-app/pull/89) at `c59b13e`
- [#94 — phase 3a-final: extract workspace SPA into apps/workspace/](https://github.com/genesis-ai-dev/codex-web-app/pull/94) at `1bcde3e`
- [#104 — Real implementations for projects + org pages (no more Phase 3c stubs)](https://github.com/genesis-ai-dev/codex-web-app/pull/104) at `87d3666`
- [#101 — Deploy front-door + workspace, completing all 11 production apps](https://github.com/genesis-ai-dev/codex-web-app/pull/101) at `0b09912`

**Files:** Each app gets a Vite SPA + `src/worker.ts` (Workers Assets binding) + `wrangler.toml` + minimal `package.json` (no `workspace:*`).

**Key decisions:**
- Each app's Worker boot calls `assertEnvBindings()` + `assertNotPreviewInProd()` from `@aquilla/errors`. **Non-negotiable** — this is what prevents a preview deploy from binding to prod resources.
- SPA basenames match their `routes.json` slug: `/login`, `/signup`, `/w`, etc. Client-side routing scopes to that basename.
- `VITE_AUTH_BASE` is build-time — every app reads it. This is what makes the eventual rename `auth-worker` → `identity` a one-line change.

**Success criteria:**
- All 11 apps deploy via `deploy-apps-prod.yml` matrix.
- Hitting bare `/projects` (no trailing slash) redirects to `/projects/` (this bit us in `bb1956d` — pre-empt it).
- Workspace SPA source lives at `apps/workspace/src/`; `@/` alias resolves there; vitest still finds tests.

**Risks / gotchas:**
- Vite root for the Tauri build is `apps/workspace` — `vite.config.ts` has to set `root` explicitly post-extraction.
- Per-app deploys take ~30s each; concurrency cap matters in CI.

- [ ] **Step 3.1: Stand up `login`, `signup`, `reset`** (Phase 3b) with shared `@aquilla/auth-client` + `@aquilla/ui`.
- [ ] **Step 3.2: Stand up `projects`, `billing`, `org`** as real implementations (no stubs — see #104).
- [ ] **Step 3.3: Stand up `import`, `export`, `migrate`** as Phase 3d shells.
- [ ] **Step 3.4: Stand up `identity`** (Phase 3e — initially as `frontier-server`, renamed in Phase 4).
- [ ] **Step 3.5: Extract workspace SPA** — move `src/` → `apps/workspace/src/`; update `vite.config.ts`, `tsconfig`, vitest `@/` alias, e2e paths.
- [ ] **Step 3.6: CI dry-run** — `wrangler deploy --dry-run --env=preview` for every app.
- [ ] **Step 3.7: Smoke each app** in preview.
- [ ] **Step 3.8: Commit each sub-phase separately.**

---

## Phase 4 — AD-11 spec unification (rename pass)

**Goal:** Rename `codex-*` → `aquilla-*` everywhere (Worker names, R2 buckets, D1 databases, env vars). Relocate `auth-worker/` → `apps/identity/` (rename from `frontier-server`), `sync-worker/` → `apps/sync/`, `chat-worker/` → `apps/chat/`. **No top-level workers remain.**

**Historical reference:** [`813bb93` — Unify deploy + worker layout with aquilla-specs (AD-11)](https://github.com/genesis-ai-dev/codex-web-app/commit/813bb93) and [#105](https://github.com/genesis-ai-dev/codex-web-app/pull/105).

**Files:** Touches every `wrangler.toml`, `package.json`, `.github/workflows/`, and any code that hardcodes a worker name or bucket name.

**Key decisions:**
- **Parallel-bucket migration for R2**: legacy `codex-snapshots` becomes a read-only archive; create new `aquilla-snapshots` + `aquilla-snapshots-staging`; cut writes over to the new bucket. **Never modify the old bucket on rename.** (See `56b8a83` + [#109](https://github.com/genesis-ai-dev/codex-web-app/pull/109).)
- Workers get `[env.production]` AND `[env.staging]` blocks; `apps/identity/` additionally gets `[env.preview]` (per-PR; CI substitutes `__PR__`).
- Staging-suffixed resources are isolated: `aquilla-db-staging`, `aquilla-snapshots-staging`. **Production and staging share zero data.**

**Success criteria:**
- `grep -r "codex-" apps/ packages/ .github/ wrangler.*` returns nothing structural (only spec text / historical docs).
- Both old and new R2 buckets exist; reads can hit either; new writes only go to `aquilla-snapshots`.
- Staging deploy from `dev` branch hits `aquilla-dev-*` workers + `aquilla-db-staging`.

**Risks / gotchas:**
- CF Workers bindings are environment-scoped; missing an `[env.production]` block silently falls back to top-level config — that's how a preview can bind to prod. **`assertNotPreviewInProd()` catches this at boot but only if you remembered to call it.**
- The `frontier-server` → `identity` rename has a long tail because the legacy frontier-server *repo* (separate from this one) still exists for the codex-editor VS Code extension. Our `apps/identity/` is a fork-then-cut, not a rename-the-other-repo.

- [ ] **Step 4.1: Rename Worker names** in every `wrangler.toml`.
- [ ] **Step 4.2: Add `[env.production]` + `[env.staging]` to every Worker.**
- [ ] **Step 4.3: Create `aquilla-snapshots` R2 buckets** (parallel; don't touch `codex-snapshots`).
- [ ] **Step 4.4: Switch sync-worker writes to the new bucket.**
- [ ] **Step 4.5: Relocate `auth-worker/` → `apps/identity/`** (file move + rename frontier-server worker).
- [ ] **Step 4.6: Relocate `sync-worker/` → `apps/sync/` and `chat-worker/` → `apps/chat/`.**
- [ ] **Step 4.7: Update env vars in CI workflows** (`VITE_AUTH_BASE`, `VITE_SYNC_WORKER_HOST`, etc.).
- [ ] **Step 4.8: Deploy to staging; verify zero data crossover with prod.**
- [ ] **Step 4.9: Commit (one big "AD-11 unification" commit is fine — this is mostly mechanical).**

---

## Phase 5 — Retire Cloudflare Pages → front-door Worker

**Goal:** Stop building/deploying a Pages bundle. `apps/front-door` becomes the wildcard catch-all (`aquilla.app/*`); favicons + OG image migrate into `apps/front-door/public/` and serve via Workers Assets.

**Historical reference:** [#108 — Retire Pages](https://github.com/genesis-ai-dev/codex-web-app/pull/108) (`289ab4c`).

**Files:**
- Modify: `apps/front-door/wrangler.toml` — `routes = [{ pattern = "aquilla.app/*", custom_domain = true }]`
- Move: `public/{favicon.ico,og.png,apple-touch-icon.png}` → `apps/front-door/public/`
- Delete: any `wrangler-pages.toml` or Pages-specific CI step
- Modify: `deploy-apps-prod.yml` to ensure front-door deploys with the wildcard route last (so it doesn't shadow more-specific routes during the deploy window)

**Key decisions:**
- Workers Routes (CF dispatcher), not the front-door Worker itself, owns slug → Worker routing. The front-door only handles `/` redirect + `/__routes` debug + 404 fallback.
- Legacy Pages project still exists in CF (we don't delete CF resources from CI) but receives no traffic.

**Success criteria:**
- `curl -I https://aquilla.app/favicon.ico` → `200`, `cf-worker: aquilla-front-door` header.
- Hitting `https://aquilla.app/` → 302 to `/projects/`.
- Pages dashboard shows zero requests after cutover.

- [ ] **Step 5.1: Move static assets into `apps/front-door/public/`.**
- [ ] **Step 5.2: Configure the wildcard route on the front-door Worker.**
- [ ] **Step 5.3: Deploy + verify Workers Routes precedence** (more-specific slug routes still win).
- [ ] **Step 5.4: Remove Pages build steps from CI.**
- [ ] **Step 5.5: Commit.**

---

## Phase 6 — D1 schema alignment to aquilla-specs

**Goal:** Bring the D1 schema in line with the `genesis-ai-dev/aquilla-specs` data model — surface `event_id` on `files`, switch validators to DELETE-not-tombstone, fix seed data, add `decay` columns (groundwork for Phase 9), keep role constants in code (deliberate divergence — see CLAUDE.md).

**Historical references:**
- [#113 — Align aquilla-db with aquilla-specs data model](https://github.com/genesis-ai-dev/codex-web-app/pull/113) at `ea73ad2` / `43eea00`
- [`f10a4e8` — Align Aquilla spec data and app boundaries](https://github.com/genesis-ai-dev/codex-web-app/commit/f10a4e8)
- [`f01b779` — Spec-alignment: AD-14 decay health, files meta/event_id, validators DELETE, seed fix](https://github.com/genesis-ai-dev/codex-web-app/commit/f01b779)

**Files:**
- Create: `apps/identity/migrations/00XX_align_with_spec.sql`
- Create: `apps/sync/migrations/00XX_files_event_id.sql`
- Modify: `seed.sql`
- Modify: read endpoints that surface validators / files-meta to match new shape

**Key decisions to lock in (these are the explicit divergences):**
- **AD-2 is content-only.** Project / org / member / settings / invite lifecycle stays as plain relational CRUD in `apps/identity` — don't event-source them.
- **No `roles` lookup table** — role levels are `INTEGER` constants in `src/lib/frontier/roles.ts` + `apps/identity/src/services/project-permissions.ts`.
- **Validators are DELETEs.** Removing a validator endorsement deletes the row; we don't tombstone. (The audit trail lives in the events log for the validation *action*, not for the validator-set state.)

**Success criteria:**
- `aquilla-db-staging` schema matches the spec's `apps/identity` + `apps/sync` SQL.
- Seed cast (alice/bob/carol/dave) applies cleanly.
- `pnpm test` passes against the new schema.

- [ ] **Step 6.1: Author the alignment migration(s).**
- [ ] **Step 6.2: Update the seed.**
- [ ] **Step 6.3: Apply to a per-PR D1 fork; smoke the read endpoints.**
- [ ] **Step 6.4: Update tests that assumed old shapes.**
- [ ] **Step 6.5: Commit.**

---

## Phase 7 — Server-side import projection

**Goal:** Make eBible / bulk source imports fast by adding `POST /import` to `apps/sync` that projects events server-side, so the client doesn't have to round-trip N events through the outbox. Keep the per-event path for normal contributor writes — this is a fast path for trusted bulk producers.

**Historical references:**
- [`4bb0aec` — Bulk-enqueue import events into the outbox in one transaction](https://github.com/genesis-ai-dev/codex-web-app/commit/4bb0aec)
- [`b6155ae` — Fast bulk source import via POST /import (server-side projection)](https://github.com/genesis-ai-dev/codex-web-app/commit/b6155ae)

**Files:**
- Add: `apps/sync/src/routes/import.ts` (`POST /import` — accepts `{ file: FileMeta, cells: SourceCellInit[] }`, writes events + projection in one transaction)
- Modify: `apps/workspace/src/lib/import.ts` — route bulk imports through `POST /import` instead of N outbox writes
- Modify: `apps/workspace/src/components/ImportDialog.tsx` — progress reporting against server response, not per-event flush

**Key decisions:**
- `POST /import` is **trusted**: it bypasses the outbox / parent-chain enforcement for *initial* file creation only. For later edits, contributors go through the normal event grammar.
- The IDB bulk-enqueue (`4bb0aec`) is a separate optimization for the per-event path; keep it for cases where `POST /import` isn't reachable (offline) or isn't applicable.

**Success criteria:**
- Importing a full Bible (~30k cells) completes in seconds rather than minutes.
- No `replaceState` flood (`e71ad59` / `a68d4f2` — the redirect-loop fix that floods `replaceState` and blanks the page. Make sure import progress UI debounces history updates).

**Risks / gotchas:**
- Don't let `POST /import` bypass auth — bulk imports still require contributor-level permission on the project.
- Test cancellation: a half-completed bulk import should leave a coherent state.

- [ ] **Step 7.1: Add `POST /import` to `apps/sync`.**
- [ ] **Step 7.2: Add `lib/import.ts` bulk path that prefers `POST /import`.**
- [ ] **Step 7.3: Add the IDB bulk-enqueue fallback** for offline / per-event imports.
- [ ] **Step 7.4: Fix the import-progress `replaceState` flood** preemptively (debounce history updates to ~250ms).
- [ ] **Step 7.5: Bench: 30k-cell USFM import end-to-end.**
- [ ] **Step 7.6: Commit.**

---

## Phase 8 — AD-13 branching search + corpus + KV cache

**Goal:** Ship the AD-13 branching-search primitive (semantic-ish search over corpus pairs) + a `/passages` route + KV cache for hot queries. Wire the AI copilot to use it for context-grounded completions.

**Historical references:**
- [`c16ef51` — AD-13 branching-search primitive + AI copilot rewire](https://github.com/genesis-ai-dev/codex-web-app/commit/c16ef51)
- [`a12eb2d` — Read branchingSearch tunables from D1 project_settings](https://github.com/genesis-ai-dev/codex-web-app/commit/a12eb2d)
- [`3e9fae2` — KV cache + passages route — close remaining AD-13 deferreds](https://github.com/genesis-ai-dev/codex-web-app/commit/3e9fae2)
- [`39a615e` — Re-enable inline eBible importer + AD-13 sync/realtime work](https://github.com/genesis-ai-dev/codex-web-app/commit/39a615e)
- [`f9a9f1b` — Add idx_cells_pair_lookup for AD-13 corpus pair-by-cell join](https://github.com/genesis-ai-dev/codex-web-app/commit/f9a9f1b)

**Files:**
- Add: `apps/sync/src/routes/passages.ts` + `apps/sync/src/routes/search.ts`
- Add: `apps/sync/src/services/branching-search.ts`
- Add: KV namespace binding for hot cache (`AD13_CACHE`)
- Add: migration for `idx_cells_pair_lookup`
- Modify: `apps/workspace/src/lib/completion/completion-service.ts` to pull context via the new endpoints
- Modify: `apps/identity/src/routes/project-settings.ts` to expose `branchingSearch` tunables

**Key decisions:**
- Tunables (depth, beam width, KV TTL) live in `project_settings` D1 rows — *not* in code. (Reason: per-project tuning without redeploy.)
- KV cache keys include source corpus version so cache invalidates correctly when a source file is re-imported.

**Success criteria:**
- Copilot completion latency drops noticeably (KV-cached prompts hit p50 < 50ms).
- `/passages?cellId=...` returns paired source+target neighbors in anchor-chain order.
- `EXPLAIN QUERY PLAN` on the corpus join uses `idx_cells_pair_lookup`.

- [ ] **Step 8.1: Add the `idx_cells_pair_lookup` migration.**
- [ ] **Step 8.2: Implement `branching-search.ts` service.**
- [ ] **Step 8.3: Add `/passages` + `/search` routes.**
- [ ] **Step 8.4: Wire KV cache** with corpus-versioned keys.
- [ ] **Step 8.5: Surface `branchingSearch` tunables in project_settings.**
- [ ] **Step 8.6: Rewire copilot completion to pull from the new endpoints.**
- [ ] **Step 8.7: Commit (each sub-step can be its own commit).**

---

## Phase 9 — AD-14 decay health (delete sub-scores, add decay + biggest-drags)

**Goal:** Replace the four-sub-score health engine (delete it outright) with the AD-14 decay metric. Add the "biggest drags" breakdown popover so contributors can see *which* cells are dragging health down.

**Historical references:**
- [`f01b779` — Spec-alignment: AD-14 decay health, files meta/event_id, validators DELETE, seed fix](https://github.com/genesis-ai-dev/codex-web-app/commit/f01b779)
- [`24323c4` — AD-14 cleanup: delete four-sub-score health modules; ship decay "biggest drags" popover + decay settings](https://github.com/genesis-ai-dev/codex-web-app/commit/24323c4)
- [`553ec95` — useHealth: memoise rule infractions per cell by content signature](https://github.com/genesis-ai-dev/codex-web-app/commit/553ec95)

**Files:**
- Delete: `apps/workspace/src/lib/health/composite-engine.ts`, `HealthBreakdown/*`, `config-resolver.ts`, the legacy health worker
- Add: `apps/workspace/src/lib/health/decay-engine.ts` (computes decay metric from event timestamps + rule infractions)
- Add: `apps/workspace/src/components/DecayBreakdown.tsx` (biggest-drags popover)
- Add: decay settings in `project_settings` (half-life, weights)
- Modify: `apps/workspace/src/components/HealthRing.tsx` — shows decay + per-cell needs-attention markers
- Modify: `apps/workspace/src/hooks/useHealth.ts` — memoize rule infractions per cell by content signature (the `553ec95` perf fix)

**Key decisions:**
- Decay is **per-cell, time-based**: a cell's health decays since its last validation, weighted by rule-infraction count and validator count. Project health is the aggregate.
- "Biggest drags" is a top-N popover, not a heatmap — clicking a row jumps to the cell.
- Per-cell "needs attention" badge fires when decay × infraction-weight crosses a threshold.

**Success criteria:**
- All four-sub-score files are gone (`grep -r "composite-engine\|HealthBreakdown" apps/` → empty).
- `HealthRing` renders decay; popover shows top-N drags; clicking jumps to the cell.
- `useHealth` doesn't re-evaluate rule infractions on every render.

- [ ] **Step 9.1: Implement `decay-engine.ts` with unit tests** for known time/infraction inputs.
- [ ] **Step 9.2: Memoize `useHealth` rule infractions by content signature.**
- [ ] **Step 9.3: Build `DecayBreakdown.tsx` popover.**
- [ ] **Step 9.4: Delete the legacy four-sub-score modules** (atomic commit).
- [ ] **Step 9.5: Wire decay settings into `project_settings`.**
- [ ] **Step 9.6: Smoke: project with mix of validated + decayed cells shows expected ring + popover.**
- [ ] **Step 9.7: Commit.**

---

## Phase 10 — Yjs rip (Phase 2c-γ)

**Goal:** Delete the residual Y.Doc machinery now that the editor + importer + read paths are off Yjs. Features still on Y.Doc (comments, multi-validator edit history, waivers, cell audio/video attachments, snapshots, parallel-passages search/replace, completion + backtranslation writebacks) lose their durable state until each gets its own event grammar — **this is the intended deferred state**; spec calls comments/threads/waivers v1.x.

**Historical references:**
- [`88c5df4` — Phase 2c-γ: delete first wave of Y.Doc files (hooks, lib/store, lib/audio writebacks, lib/codex-editor/edits, serialize, search)](https://github.com/genesis-ai-dev/codex-web-app/commit/88c5df4)
- [`e6867f6` — Phase 2c-γ: untangle ProjectWorkspace/EditorTable/feature-page Y.Doc gates](https://github.com/genesis-ai-dev/codex-web-app/commit/e6867f6)
- [`e4cf552` — Phase 2c-γ: remove yjs/y-indexeddb/y-prosemirror/extension-collaboration deps](https://github.com/genesis-ai-dev/codex-web-app/commit/e4cf552)

**Files to delete (first wave):**
- `apps/workspace/src/lib/store/file-doc.ts`
- `apps/workspace/src/lib/store/partyserver-provider.ts`
- `apps/workspace/src/lib/store/translated-xml.ts`
- `apps/workspace/src/lib/store/cqrs-bridge.ts`
- Hooks: `useFileDoc.ts` and friends
- Y.Doc-bound audio writebacks, codex-editor edits, serialize, search

**Files to untangle (second wave):**
- `ProjectWorkspace.tsx`, `EditorTable.tsx`, feature pages — remove Y.Doc gates

**Deps to drop (third wave):** `yjs`, `y-indexeddb`, `y-prosemirror`, `y-partyserver`, `y-webrtc`, `@tiptap/extension-collaboration`.

**Key decisions:**
- Comments, waivers, attachments, snapshots, search/replace, completion writebacks: **expect to be broken after this phase** for any feature whose event grammar hasn't landed. That's intentional — fixing them is a per-feature spec follow-up.
- Keep `apps/workspace/src/lib/store/cqrs-bridge.ts` as a slim shim only if some feature still references it; ideally delete.

**Success criteria:**
- `package.json` shows no `yjs`/`y-*`/`@tiptap/extension-collaboration` deps.
- `pnpm test` passes (any test that depended on Y.Doc internals is updated or deleted).
- Editor + importer + reads all work; deferred features are visibly broken with a "coming in v1.x" placeholder.

- [ ] **Step 10.1: Delete the first wave of Y.Doc files.**
- [ ] **Step 10.2: Untangle Y.Doc gates from `ProjectWorkspace` / `EditorTable` / feature pages.**
- [ ] **Step 10.3: `pnpm remove` the Y.Doc deps.**
- [ ] **Step 10.4: Run typecheck + tests; fix import errors.**
- [ ] **Step 10.5: Tag deferred features** with "v1.x" placeholders so users know the UI isn't actually broken — just deferred.
- [ ] **Step 10.6: Commit each wave separately.**

---

## Phase 11 — Cut legacy frontier-server runtime dep

**Goal:** Remove the runtime dependency on the legacy `frontier-server` repo. `apps/identity/` is now self-sufficient.

**Historical reference:** [`57d54d3` — Cut legacy frontier-server identity surface from the runtime](https://github.com/genesis-ai-dev/codex-web-app/commit/57d54d3).

**Files:**
- Modify: `apps/workspace/src/lib/frontier/**` — point everything at `apps/identity/`
- Modify: `e2e/` and CI workflows — drop `frontier-server` checkout
- Modify: any doc that points at `~/frontierrnd/frontier-server`

**Key decisions:**
- The legacy `frontier-server` repo continues to exist — it still serves the codex-editor VS Code extension. We're cutting the *runtime* dependency only.
- `VITE_AUTH_BASE` is the only var the SPA needs; in dev it points to the local `apps/identity` Worker.

**Success criteria:**
- `grep -r "frontier-server" apps/` returns no runtime hits (only doc/historical references).
- `pnpm dev` boots without needing the legacy repo on disk.

- [ ] **Step 11.1: Inventory frontier-server runtime references.**
- [ ] **Step 11.2: Repoint all of them at `apps/identity/`.**
- [ ] **Step 11.3: Drop the legacy checkout from CI + e2e.**
- [ ] **Step 11.4: Commit.**

---

## Phase 12 — Sync mounted under aquilla.app/api/sync

**Goal:** Stop routing the sync Worker through `*.workers.dev` — mount it under `aquilla.app/api/sync` so Safari (which blocks third-party `*.workers.dev`) works.

**Historical reference:** [`2b5367f` — Mount sync worker under aquilla.app/api/sync (fix Safari workers.dev failures)](https://github.com/genesis-ai-dev/codex-web-app/commit/2b5367f).

**Files:**
- Modify: `apps/sync/wrangler.toml` — add `aquilla.app/api/sync/*` route
- Modify: `VITE_SYNC_WORKER_HOST` build vars in CI — point to `aquilla.app/api/sync` for prod, `dev.aquilla.app/api/sync` for staging
- Modify: WS URL in `ws-reconciler.ts` — `wss://aquilla.app/api/sync/parties/project-sync/:projectId`

**Key decisions:**
- WS upgrade through a Workers Route works — verified historically — but only because the route is custom-domain. Check `wrangler.toml` syntax.
- Per-PR sync workers still use `*.workers.dev` — Safari users can't preview, but that's an accepted tradeoff for preview ergonomics.

**Success criteria:**
- Safari (desktop + iOS) can load + edit a project in prod.
- WS connects and stays alive across page navigation.

- [ ] **Step 12.1: Add the custom-domain route to `apps/sync/wrangler.toml`.**
- [ ] **Step 12.2: Update `VITE_SYNC_WORKER_HOST` everywhere.**
- [ ] **Step 12.3: Test from Safari.**
- [ ] **Step 12.4: Commit.**

---

## Phase 13 — Local dev stack (`pnpm dev` boots identity + sync + Vite)

**Goal:** `pnpm dev` should boot identity + sync (and optionally chat) locally via `wrangler dev --local`, apply migrations, share a single `.wrangler-dev-state/` between identity and sync, and write a managed `.env.development.local` for Vite — all without touching prod or `wrangler.toml`.

**Historical reference:** [`477e745` — Local backend dev stack: pnpm dev boots identity + sync + Vite](https://github.com/genesis-ai-dev/codex-web-app/commit/477e745).

**Files:**
- Create: `scripts/dev-stack.ts` (the orchestrator)
- Modify: root `package.json` — `dev`, `dev:chat`, `dev:verbose`, `dev:vite` scripts
- Add: `.dev.vars.example` in each app (auto-copied to `.dev.vars` on first boot)
- Add: `.dev-stack-logs/` to `.gitignore`
- Add: `.wrangler-dev-state/` to `.gitignore`

**Key decisions:**
- Wrangler local state is **shared between identity and sync** so the project rows identity writes are visible to sync. Delete the directory to reset.
- The managed `.env.development.local` is deleted on clean shutdown so `pnpm dev:vite` returns to whatever the user has in `.env.local`.
- `--verbose` flag tees each Worker's output to terminal; default just writes to `.dev-stack-logs/`.

**Success criteria:**
- `pnpm dev` boots identity (8788) + sync (8789) + Vite (5173); workspace loads against local backends.
- Reset is: delete `.wrangler-dev-state/` and `.env.development.local`; next `pnpm dev` rebuilds.
- Nothing in dev-stack touches `wrangler.toml` or remote CF resources (verify with a `git diff` after running).

- [ ] **Step 13.1: Write `scripts/dev-stack.ts`.**
- [ ] **Step 13.2: Add `.dev.vars.example` per app.**
- [ ] **Step 13.3: Wire root scripts.**
- [ ] **Step 13.4: Smoke: cold boot + reset + chat opt-in.**
- [ ] **Step 13.5: Commit.**

---

## Phase 14 — Polish (parallel; pick what matters)

These shipped as small follow-ups; pick the subset that matters for your replay. Each is independent.

**Neumorphic UI refresh** ([`8cfcd8e`](https://github.com/genesis-ai-dev/codex-web-app/commit/8cfcd8e), [`1cf003d`](https://github.com/genesis-ai-dev/codex-web-app/commit/1cf003d), [`16460e2`](https://github.com/genesis-ai-dev/codex-web-app/commit/16460e2), [`1b2ac85`](https://github.com/genesis-ai-dev/codex-web-app/commit/1b2ac85))
- [ ] Apply white + pastel neumorphic theme across all apps.
- [ ] Reserve neumorphic depth for CTAs; soft shadows elsewhere.

**Deploy + DB ergonomics**
- [ ] `bb22bc1` — auto-apply D1 migrations on identity prod deploy.
- [ ] `e35b298` — add `deploy-apps-staging.yml`.
- [ ] `ebd5890` — fix workspace stale-asset 404s after deploys.

**Workspace polish**
- [ ] `c1b35b6` — onboarding creates server project row; trash handles orphan IDB records.
- [ ] `c99f8d5` — hide project-shape picker behind "Advanced"; allow free-form language labels.
- [ ] `28870c8` — gate Tauri HMR ports on `TAURI_ENV_PLATFORM`.

**Seed-VC voice cloning** ([`41b9ad6`](https://github.com/genesis-ai-dev/codex-web-app/commit/41b9ad6))
- [ ] Add Modal endpoint + sync-worker convert proxy.

**Cross-app coherence** ([`945647e`](https://github.com/genesis-ai-dev/codex-web-app/commit/945647e))
- [ ] Shared theme + `AppHeader` across every Aquilla app.

---

## Self-Review

**Spec coverage:** AD-2 event log → Phase 2; populating apps + workspace extraction → Phase 3; AD-11 spec unification → Phase 4; CF Pages retire → Phase 5; D1 schema alignment → Phase 6; server-side import projection → Phase 7; AD-13 → Phase 8; AD-14 → Phase 9; Yjs rip → Phase 10; frontier-server cut → Phase 11; sync /api/sync → Phase 12; local dev stack → Phase 13. Monorepo skeleton is **deliberately omitted** — inherited from base commit `e736e69`. Polish is Phase 14. **All in-scope refactors covered.**

**Placeholder scan:** No "TBD" / "implement later" / "add appropriate error handling" / vague "similar to Task N" patterns. Each phase names specific files, decisions, success criteria, and historical commits. Where literal code would just duplicate a public PR diff, the plan links to the PR — this is the deliberate plan-style deviation called out in the header.

**Type consistency:** Names used across phases — `event_id`, `source_event_id`, `parent_id`, `target.cell.commit`, `source.cell.create`, `assertEnvBindings()`, `assertNotPreviewInProd()`, `@aquilla/errors`, `aquilla-snapshots`, `aquilla-db`, `useOutboxFlusher`, `useFocusLock`, `branching-search.ts`, `decay-engine.ts` — match the current `main` codebase (verified against CLAUDE.md + the historical commits referenced).

**Sequencing sanity-check:** Phase 2 (AD-2) comes first because everything else stacks on it. Phase 3 (populate shells) sits *after* Phase 2 because the apps need the events grammar + read endpoints to be useful. Phase 4 (AD-11 rename) sits after Phase 3 so the rename pass is mechanical search-replace across already-populated dirs. Phase 10 (Yjs rip) sits after Phase 9 (decay health) because decay-engine reuses some rule-infraction iteration that's easier to write before the Y.Doc gates are torn out. Phase 13 (local dev stack) is last among foundational phases because it depends on Phase 11 (frontier-server cut).

**Alternative ordering note:** Phase 3 (populate shells) could be done *before* Phase 2 (AD-2). Historically it was done after, but if you want a working UI early — even one with stub reads — populate shells first, then layer AD-2. The plan currently follows historical order.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-replay-monorepo-refactors.md`.**

Two execution options when you're ready:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per phase (or per sub-phase for the heavyweight ones like Phase 2 and Phase 3), review between phases, fast iteration. Good fit here because the phases are mostly independent after Phase 2 lands.

2. **Inline Execution** — Execute phases in this session using executing-plans, batch with checkpoints. Slower but you get tighter feedback.

A third option, since this is a *replay* of merged work: **Cherry-pick mode** — for each phase, `git cherry-pick` the historical commits (listed inline) onto the replay branch instead of re-coding. Use this if your goal is reproducing the end state, not revisiting decisions. Mix and match: cherry-pick phases you don't want to revisit, re-implement the ones you do.

Which approach?
