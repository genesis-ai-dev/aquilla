# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo layout (AD-11 — Aquilla)

Phase 1B introduced the `apps/` + `packages/` chassis per spec §21-monorepo.md. Each task-flow ships as its own deployable Worker under `apps/<slug>/`; the workspace SPA is the deliberate exception. Cross-app imports outside of `packages/` are forbidden — sharing happens through versioned packages (`@aquilla/ui`, `@aquilla/auth-client`, `@aquilla/api-client`, `@aquilla/data-model`, `@aquilla/telemetry`, `@aquilla/errors`).

- `apps/<slug>/` — one Worker per discrete task (`login`, `signup`, `reset`, `projects`, `import`, `export`, `migrate`, `billing`, `org`, `workspace`, `frontier-server`).
- `apps/front-door/` — root + 404 fallback Worker (`/` → `/projects`, CSP injection, `/__routes` debug). Cloudflare Workers Routes (not the front-door) dispatches each slug to its Worker.
- `packages/<name>/` — shared, versioned concerns. `@aquilla/errors` ships the boot-time `assertEnvBindings()` + `assertNotPreviewInProd()` helpers — every Worker calls them at startup so a preview deploy can't silently bind to prod resources (spec §"Environment binding hygiene").
- `routes.json` (repo root) — authoritative slug → URL-path registry. Adding an app means editing this file plus dropping a folder under `apps/`.
- `seed.sql` (repo root) — canonical preview test cast (alice/bob/carol/dave) applied to every per-PR D1 and the shared `aquilla-dev`.

Phase 3e relocated `auth-worker/` to `apps/frontier-server/` (the AD-5 identity service). The remaining top-level workers (`sync-worker/`, `chat-worker/`, `cors-proxy/`) stay put until Phase 4's rename pass.

**Apps populated:** `front-door` (Phase 1B), `login` / `signup` / `reset` (Phase 3b). Remaining stubs: `projects`, `import`, `export`, `migrate`, `billing`, `org`, `workspace`, `frontier-server`. **Packages populated:** `errors` (1B), `auth-client` / `ui` (3b). Remaining stubs: `api-client`, `data-model`, `telemetry`.

Each populated app is a Vite SPA served by a Cloudflare Worker with a Workers Assets binding. The Worker script under `src/worker.ts` adds boot-time env-binding assertions (`@aquilla/errors`) + baseline security headers; the SPA lives in `dist/` and routes client-side under its mounted basename (`/login`, `/signup`, `/reset`). Build-time `VITE_AUTH_BASE` controls the identity-service host so the rename from `codex-auth-worker` to `aquilla-frontier-server` (Phase 3e) is a one-line wrangler-vars change.

## Project Overview

`codex-web` is a browser-based reimplementation of the Codex translation editor (originally a VS Code extension — see `docs/SPEC.md` for the origin design). It is a standalone single-page app: a cell-based translation notebook that imports source documents (USFM, DOCX, PPTX, Markdown, plaintext, VTT/SRT), lets translators fill in aligned target cells with rich text, and supports collaborative editing, snapshots, rules/health scoring, LLM completion/backtranslation, and P2P sharing.

There is no backend in this repo. Persistence is entirely client-side (IndexedDB + Yjs).

## Commands

```bash
pnpm i              # install
pnpm dev            # vite dev server
pnpm build          # tsc -b && vite build
pnpm preview        # preview built bundle
pnpm lint           # eslint
pnpm test           # vitest run (single pass)
pnpm test:watch     # vitest watch

# Run a single test file or pattern
pnpm test src/lib/parsers/usfm.test.ts
pnpm test -t "splits by verse"
```

Vitest runs in `happy-dom` with `fake-indexeddb/auto` loaded via `src/test-setup.ts`, so tests that use IndexedDB / idb work without a browser. Path alias `@/` resolves to `src/`.

## Architecture

> **Phase 2c-α (in flight).** The Aquilla spec-alignment effort is migrating
> codex-web from Y.Doc-as-source-of-truth to **events-log + projection as
> the durable record** (AD-2) with WS-based focus locks for live
> coordination (AD-1) and an outbox + reconciler for offline-tolerant
> writes (AD-3). The migration is being shipped in three slices:
>
> - **2a (merged):** D1 cells read-path. Reads now flow through
>   `src/lib/sync/cqrs-bridge.ts` → sync-worker D1.
> - **2b (merged):** Stubs of project-level state, comment shells.
> - **2c-α (this slice):** AD-2 event grammar + outbox enqueuer
>   (`src/lib/sync/events-emit.ts`, `outbox-types.ts`), per-project DO
>   (`sync-worker/src/project-do.ts`), WS reconciler client
>   (`src/lib/sync/ws-reconciler.ts`), focus-lock hook
>   (`src/hooks/useFocusLock.ts`). The editor still writes through the
>   legacy Y.Doc + `cqrs-bridge.ts` path; the new modules are wired but
>   unconsumed.
> - **2c-β (next PR):** Editor migration (plain TipTap, remove
>   `@tiptap/extension-collaboration`); importer rewrite (parsers emit
>   `source.cell.create` events directly); full Yjs removal (drop deps,
>   delete `file-doc.ts`, `partyserver-provider.ts`, `translated-xml.ts`,
>   the IDB Y.Doc persistence, and the `useProject` IDB cache fallback).
>
> The architecture sections below describe the **current** state during
> 2c-α — Y.Doc remains the load path for cells until 2c-β.

### Document model: parsers → Y.Doc → rebuilders

The whole pipeline is built around a single intermediate shape: `TranslatableString[]` (see `src/lib/parsers/types.ts`). Each importer in `src/lib/parsers/` (`usfm`, `docx`, `pptx`, `markdown`, `plaintext`, `subtitle`) reads a binary/text blob and emits that array plus enough metadata (`SourceLocation` for docx/pptx) to reconstruct the original later. `src/lib/import.ts` dispatches on `detectFileType`.

Each imported file becomes one Yjs document via `createFileDoc` in `src/lib/store/file-doc.ts`. Structure inside the doc is fixed and load-bearing:

- `doc.getMap("meta")` — file-level metadata
- `doc.getMap("cells")` — `Y.Map<cellId, Y.Map>`, each cell holding `original`, `originalHtml?`, `translatedXml` (a `Y.XmlFragment`, M9+), `context`, `group`, `type`, `history` (`Y.Array<CellHistoryEntry>`), optional `sourceLocation`, `threads`, backtranslation fields
- `doc.getArray("order")` — cell id order

Per-file docs persist under `codex:file:<fileId>` via `y-indexeddb`. Project-level records (the `ProjectRecord` with file list, rules, completion settings, members) live in a separate `idb` database `codex` (see `src/lib/store/project-index.ts`), alongside snapshots and share invites. When editing a cell, **write to `translatedXml` via `src/lib/richtext/translated-xml.ts`** — the legacy plain `translated` string field is only kept as a read fallback for pre-M9 docs.

Export is the inverse path: `src/lib/export/surgical-export.ts` + `src/lib/export/rebuilders/*` reconstruct the original file format from the current cell state using `SourceLocation`, so round-tripping a docx/pptx preserves non-translatable content.

### Rich text editing

Tiptap 3 bound directly to each cell's `Y.XmlFragment` via `@tiptap/extension-collaboration`. `TranslatedEditor` / `EditorTable` in `src/components/` are the cell surfaces; `src/lib/richtext/translated-xml.ts` has the helpers for reading plain text, reading fragment HTML, and replacing content. When you need a string representation of a cell's translation, always go through `getPlainText(frag)` rather than reading `cell.get("translated")`.

### Hooks as the view-model layer

Every major subsystem has a hook in `src/hooks/` that subscribes to Yjs updates and returns a plain-React view:

- `useProject`, `useFileDoc` — load project + open a file doc
- `useCells` — observed, ordered `CellData[]` with derived `status` ("empty" | "unvalidated" | "validated")
- `useComments`, `useCellHistory`, `useRules`, `useHealth`, `useCompletion`, `useBacktranslation`, `useSearchIndex`, `useWorkspaceSearch`, `useSync`

Adding a new cell-level feature almost always means: extend the cell Y.Map shape in `file-doc.ts`, add a service under `src/lib/<feature>/`, surface it through a hook, and render in a component under `src/components/`.

### Phase 2c-α write path (events log + outbox + WS coordination)

The post-Phase-2 write path is built around three concepts:

1. **Typed event grammar (AD-2)** — `src/lib/sync/outbox-types.ts` mirrors
   `sync-worker/src/events/types.ts`. Cell events carry `source.` or
   `target.` prefixes; every chain-mutating event carries `parentId` (the
   prior winning event on this cell's `(project, file, cell)` chain).
   Genesis events (`*.create`, `file.create`) carry `parentId = null`.
   `target.cell.commit` carries `sourceEventId` — the AD-9 staleness pin
   onto the source row's `event_id` at commit time.

2. **Outbox writers (AD-3)** — `src/lib/sync/events-emit.ts` exposes
   `buildRawEvent`, `enqueueEvent`, and convenience helpers
   (`emitTargetCellCommit`, `emitCellValidate`, `emitSourceCellCreate`,
   `emitFileCreate`). All persist into the same IDB outbox as the legacy
   path (`src/lib/sync/outbox.ts`), and the existing
   `useOutboxFlusher`/`outbox-flush.ts` drains via HTTP `POST /events`.
   Writes never block on the network — IDB is the durable buffer.

3. **Per-project DO + WS reconciler (AD-1)** — `sync-worker/src/project-do.ts`
   is a Durable Object instance per project (path
   `/parties/project-sync/:projectId`). It holds **only transient state**
   — focus-lock leases, presence, and an `event.applied` / `event.stale`
   broadcast channel for `POST /events`. No DO storage writes; rooms
   evict naturally when empty. The client side is
   `src/lib/sync/ws-reconciler.ts` (per-project WS with backoff
   reconnect) and `src/hooks/useFocusLock.ts` (claim/renew/release lease,
   read `heldBy` for the "Alice is editing" affordance).

These modules are **wired but not yet consumed**: the editor still writes
through `cqrs-bridge.ts` (Y.Doc mirror) until 2c-β. 2c-β rewires
`TranslatedEditor` / `EditorTable` to write through `emitTargetCellCommit`
+ `useFocusLock` directly, deletes `cqrs-bridge.ts`, and removes Yjs.

### Sync & sharing (P2P)

`src/lib/sync/webrtc-provider.ts` wraps `y-webrtc` with public signaling + a free TURN fallback. Rooms are joined by share token; PIN protection is enforced at the app layer (`src/lib/sync/share-tokens.ts`), not via y-webrtc's built-in password. `useSync` drives awareness/presence, and `JoinPage` (`/join/:token`) is the entry point for invitees. There is no server component — share invites are stored locally and exchanged via the token string.

### Rules, health, completion

- `src/lib/rules/rule-engine.ts` evaluates `TranslationRule[]` against cell pairs; `rule-suggester.ts` asks an LLM to propose rules. Infractions feed into health.
- `src/lib/health/health-engine.ts` computes the project health ring shown in `HealthRing`, combining rule infractions, validation state, and an LLM penalty multiplier from `CompletionSettings`.
- `src/lib/completion/completion-service.ts` and `backtranslation-service.ts` call the configured `CompletionSettings.endpoint` (OpenAI-compatible). Endpoint/model/system-prompt are per-project.

### Routing

`src/App.tsx` is the full route table. All project-scoped views are under `/project/:id/...` (workspace, settings, rules, comments, snapshots, plus `/debug` variants). `/join/:token` handles share-link entry. There is no auth layer — the identity is a `username` stored on the `ProjectRecord`.

### UI stack

React 19 + Tailwind v4 (via `@tailwindcss/vite`) + shadcn/ui (`components.json`, style `base-nova`, primitives in `src/components/ui/`) + `@base-ui/react`. Icons are lucide. When adding shadcn components, use the aliases declared in `components.json` (`@/components/ui`, `@/lib/utils`, etc.).

## Design docs & milestones

`docs/SPEC.md` describes the VS Code extension this app was extracted from — useful for understanding the `.codex` notebook / paired-source / LLM-context concepts that this app inherits. Per-milestone specs and implementation plans live under `docs/superpowers/specs/` and `docs/superpowers/plans/` (M1–M10 covering import, editor, health, rules, export, search+backtranslation, comments, snapshots, richtext/Yjs migration, P2P sync). When working on a feature that has a spec there, read it first — the schema decisions (especially `translatedXml` vs `translated`, `SnapshotFile.ydocState`, `schemaVersion` on snapshots) were made deliberately and are load-bearing for migrations.

## Phase 2 data flow (in progress)

Phase 2 migrates the client off Y.Doc reads onto the sync-worker's D1 projection (per Aquilla spec AD-2 / AD-3 v1 thin client). Status as of phase 2b:

- **Reads** — every read-side hook is server-backed. The pattern is locked-in: a domain-specific `*-read.ts` + `*-read-types.ts` under `src/lib/sync/`, exposing a `fetchX(...)` wrapper that throws an `XReadError` on non-2xx; hooks wrap the fetcher with a vanilla useState + race-guarded effect (no React Query, no SWR). Phase 2a migrated `useCells`; Phase 2b migrated the remaining read hooks.
- **Phase 2b additions** — fetch wrappers: `history-read.ts` (per-cell event chain), `search-read.ts` (project FTS5), `projects-read.ts` (frontier-server project list + detail), `members-read.ts`, `settings-read.ts`, `orgs-read.ts`. Hooks rewritten or aligned: `useCellHistory` (new read-side hook; old write helpers in the same file are untouched, Phase 2c rewrites them), `useCellEditHistory` (drops React Query; uses the new history wrapper; gains a required `projectId` prop wired through `HistoryDrawer`), `useCellValidators`, `useCellsAuditStats`, `useFileMeta` (Y.Doc → localStorage), `useWorkspaceSearch` (server FTS5). Hook stubs (`// Phase 2b: <concept> dropped from v1 event grammar`): `useComments`, `useCellWaivers`. New `useSync` reports a static online/connected state until Phase 2c wires the real WS reconciler. `useFileSync` is also stubbed (peers: [], provider: null, status: "live"); the TipTap editor's `syncProvider` prop is therefore always null on dev. `useFileDoc` is a shim that hands out a fresh in-memory Y.Doc per fileId — no IDB, no R2 — so the TipTap editor compiles unchanged until Phase 2c rips the Y.Doc dep out.
- **New sync-worker routes (Phase 2b):**
  - `GET /api/v1/projects/:projectId/files/:fileId/cells/:cellId/history` → cell event chain, newest first.
  - `GET /api/v1/projects/:projectId/search?q=&side=&limit=` → FTS5 over `cells_fts`, project-scoped.
- **Still Y.Doc-bound:** the TipTap editor (`@tiptap/extension-collaboration`), `src/lib/store/file-doc.ts`, parsers/import pipeline, all write paths (cell commits, edits, comments, snapshots). Phase 2c handles writes + finally deletes Y.Doc. Search-side concepts dropped from the v1 event grammar — comments and cell-waivers — return empty data from the stub hooks; future v1.x features.
- **Project-index IDB** still lives in `src/lib/store/project-index.ts` for write callers that Phase 2c will migrate; reads happen through frontier-server. The hook layer (`useProject`) overlays frontier-server project + settings onto whatever local stub remains.
- **Writes still go through Y.Doc** until Phase 2c. After a known write, callers should invoke `revalidate()` so the projection re-loads. `revalidate()` is best-effort: a write that lands in the local Y.Doc but hasn't propagated to the server's projection won't show up on refetch. Phase 2c replaces Y.Doc writes with the AD-3 outbox + cell-event POSTs and removes Y.Doc entirely.
- **New sync-worker read routes** (added 2a; mounted in `sync-worker/src/index.ts`):
  - `GET /api/v1/projects/:projectId/files` → list with cell/word/last-edit rollups
  - `GET /api/v1/projects/:projectId/files/:fileId` → single file row
  - `GET /api/v1/projects/:projectId/files/:fileId/cells?side=&limit=&cursor=` → cells in anchor-chain order (AD-2). When `side` is omitted, the response carries both source and target rows; the client pairs by `cell_id` (AD-9).
  - All three auth with a sync-token JWT (`Authorization: Bearer …`) scoped to `:projectId`. Membership is implicit in the JWT — frontier-server only mints tokens for project members.

## Backend stack

Codex-web hosts its own Cloudflare Workers in this repo, independent of the older `frontier-server` repo (which keeps serving the codex-editor VS Code extension):

- **`apps/frontier-server/`** — `/api/v2/auth/*`, `/api/v2/sync-token`, `/api/v2/users/*`, `/api/v2/orgs/*`, `/api/v2/projects/*` (incl. invites + settings + source-linking), `/api/v2/invites/*`. Identity service per AD-5; mounted under `/api/identity/*` once the aquilla.app zone is provisioned (routes.json). Worker name `aquilla-frontier-server` (prod: `aquilla-prod-frontier-server`; staging: `aquilla-dev-frontier-server`). Writes to D1 `aquilla-db` (its own schema; not shared with the legacy `frontier-db-v2`). Relocated from top-level `auth-worker/` in Phase 3e (AD-11).
- **`chat-worker/`** — `/api/v1/chat/completions`. Authenticated OpenRouter proxy. No billing. Phase 4 renamed the worker to `aquilla-chat-worker`; the source dir keeps its `chat-worker/` name until a later phase.
- **`sync-worker/`** — realtime collab DOs (one per file). Persists Y.Doc snapshots/tails to R2 (`aquilla-snapshots`); projects flat row state to D1 (`aquilla-db`, same database as frontier-server but writer-only against `files`/`cells`/`events`/etc.). Also hosts `/audio/*` for cell-audio storage. Phase 4 renamed the worker to `aquilla-sync-worker`; the source dir keeps its `sync-worker/` name until a later phase.

Each worker has a `[env.staging]` block pointing at staging-suffixed resources (`aquilla-db-staging`, `aquilla-snapshots-staging`). `apps/frontier-server/` additionally has an `[env.preview]` block (per-PR; `aquilla-pr-<N>-frontier-server`) that CI substitutes `__PR__` into. Production and staging share zero data.

The frontend wires worker URLs via build-time env vars: `VITE_AUTH_BASE`, `VITE_CHAT_BASE`, `VITE_SYNC_WORKER_HOST`. The deploy workflow injects prod vs staging hosts based on the branch.

## CI / deploy lifecycle

Five workflows in `.github/workflows/`:

| Workflow | Trigger paths |
|---|---|
| `deploy.yml` (Pages) | all paths except `**.md`, `docs/**` |
| `deploy-workers.yml` | `sync-worker/**`, `apps/frontier-server/**`, `chat-worker/**` |
| `pr-db-fork.yml` | `sync-worker/migrations/**.sql` only |
| `pr-db-cleanup.yml` | `sync-worker/migrations/**.sql` only (PR-close event) |
| `web-ci.yml` | every PR push (no path filter) |

### Branch behavior

- **Push to `main`** → production deploy. `codex-web-4ih.pages.dev` + custom domains rebuild with **prod** worker URLs. Workers re-deploy too if their dir changed.
- **Push to `dev`** → staging deploy. `dev.codex-web-4ih.pages.dev` rebuilds with **staging** worker URLs. Workers re-deploy via `--env=staging`.
- **Squash-merge caveat**: `deploy-workers.yml`'s job-level `if: contains(commits.*.modified, ...)` silently skips on squash-merges. After a worker-touching merge, verify it deployed; if not, dispatch manually: `gh workflow run "Deploy Workers" --ref <branch> -f worker=all`.

### PR behavior

- **PR opened / reopened / `ready_for_review`** → always deploys preview to `pr-<N>.codex-web-4ih.pages.dev` with staging worker URLs. Sticky comment posts the URL.
- **PR push (synchronize) on a non-draft PR** → deploys **only if commit message contains `[preview]` or `[deploy]`** (case-insensitive). Without the tag, the build is skipped (saves CF/GH minutes) and the branch alias stays pointing at the last *deployed* commit. The new selective-deploy logic is in `deploy.yml`'s `Decide whether to deploy` step.
- **Draft PR** → never deploys, regardless of commit message.
- **Concurrency cancellation** is enabled per-PR — a new push kills the in-flight deploy for the same PR.

### Per-PR DB fork (for migration PRs)

If a PR adds `sync-worker/migrations/**.sql`, the `pr-db-fork.yml` workflow:

1. Creates `codex-db-pr-<N>` D1 (mirrors `codex-db-staging` schema + applies the new migration files)
2. Generates a per-PR `wrangler.toml` from `sync-worker/wrangler.pr.toml.tpl` (substitutes `__PR__`, `__DB_ID__`)
3. Deploys `codex-sync-worker-pr-<N>` pointing at the forked D1; R2 namespaced via `R2_KEY_PREFIX=pr-<N>` (shares `codex-snapshots-staging`)
4. Worker runs with `ALLOW_UNAUTHENTICATED=true` (per-PR shortcut — semi-hidden URL, staging data)
5. Sticky-comments the per-PR worker URL on the PR

`deploy.yml`'s `Detect PR migrations` step then targets `VITE_SYNC_WORKER_HOST` at `codex-sync-worker-pr-<N>` so the PR's preview bundle wires to the forked stack.

**`pr-db-cleanup.yml`** runs on PR close (only when the PR had migrations) and tears down the per-PR worker, D1, and R2 keys under `pr-<N>/`.

**The CF API token in CI (`CLOUDFLARE_API_TOKEN` GH secret) needs D1 write scopes** for the fork workflow to actually function. Without those scopes the workflow runs but its wrangler D1 calls 401. (Currently set up but not yet rotated to include D1.)

## Reference card: branch → effect

```
Open a PR (non-draft) → preview at pr-<N>.codex-web-4ih.pages.dev (staging workers)
Add a .sql migration → per-PR D1 + sync-worker variant spun up via pr-db-fork.yml

Push fixups          → preview stays stale unless commit msg has [preview]
Push with [preview]  → preview rebuilds
Mark ready for review → preview rebuilds

Close PR             → per-PR DB + worker torn down (only if it had migrations)
Merge to dev         → dev.codex-web-4ih.pages.dev rebuilds (staging workers)
Merge dev → main     → production rebuilds (prod workers + custom domains)
```
