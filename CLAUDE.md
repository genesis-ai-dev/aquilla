# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo layout (AD-11 — Aquilla)

Phase 1B introduced the `apps/` + `packages/` chassis per spec §21-monorepo.md. Each task-flow ships as its own deployable Worker under `apps/<slug>/`; the workspace SPA is the deliberate exception. Cross-app imports outside of `packages/` are forbidden — sharing happens through versioned packages (`@aquilla/ui`, `@aquilla/auth-client`, `@aquilla/api-client`, `@aquilla/data-model`, `@aquilla/telemetry`, `@aquilla/errors`).

- `apps/<slug>/` — one Worker per discrete task (`login`, `signup`, `reset`, `projects`, `import`, `export`, `migrate`, `billing`, `org`, `workspace`, `frontier-server`).
- `apps/front-door/` — root + 404 fallback Worker (`/` → `/projects`, CSP injection, `/__routes` debug). Cloudflare Workers Routes (not the front-door) dispatches each slug to its Worker.
- `packages/<name>/` — shared, versioned concerns. `@aquilla/errors` ships the boot-time `assertEnvBindings()` + `assertNotPreviewInProd()` helpers — every Worker calls them at startup so a preview deploy can't silently bind to prod resources (spec §"Environment binding hygiene").
- `routes.json` (repo root) — authoritative slug → URL-path registry. Adding an app means editing this file plus dropping a folder under `apps/`.
- `seed.sql` (repo root) — canonical preview test cast (alice/bob/carol/dave) applied to every per-PR D1 and the shared `aquilla-dev`.

Existing top-level workers (`auth-worker/`, `sync-worker/`, `chat-worker/`, `cors-proxy/`) stay put until Phase 4's rename pass; Phase 1B is scaffold-only.

## Project Overview

`codex-web` is a browser-based reimplementation of the Codex translation editor (originally a VS Code extension — see `docs/SPEC.md` for the origin design). It is a standalone single-page app: a cell-based translation notebook that imports source documents (USFM, DOCX, PPTX, Markdown, plaintext, VTT/SRT), lets translators fill in aligned target cells with rich text, and supports collaborative editing, snapshots, rules/health scoring, and LLM completion/backtranslation.

Backed by Cloudflare Workers in this repo (`auth-worker`, `sync-worker`, `chat-worker`). The web client is a thin tier-1 client per AD-3 — reads on demand from D1, writes through a local outbox.

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

Post-Phase-2 the app is built on AD-2 / AD-3 v1 / AD-9:

### Source of truth

The append-only `events` table in D1 (`sync-worker`'s `codex-db`) is the durable record. Every write is an event with `parent_id` (the prior winning event on the same `(project_id, file_id, cell_id)`); the projection (`cells`, `files`, `cell_validators`) lands as events apply. Cell events are prefixed `source.*` (importer-only) or `target.*` (contributor+). `target.cell.commit` carries an AD-9 `sourceEventId` pin onto the source row's `event_id` observed at commit time — staleness becomes a pointer comparison at read.

### Reads

Tier-1 thin client: reads fetch from sync-worker's HTTP endpoints on demand. Typed fetch wrappers live alongside the hooks under `src/lib/sync/*-read.ts`; each pairs with a `*-read-types.ts` mirror of the server response shape. Hooks use plain `useState` + race-guarded `useEffect`; no React Query, no SWR. Key read hooks: `useProject`, `useCells`, `useCellHistory`, `useCellValidators`, `useFileMeta`, `useWorkspaceSearch`, `useProjectMembers`, `useOrgInvites`, `useProjectSettings`.

`useCells` is the load path for the editor table: `GET /api/v1/projects/:projectId/files/:fileId/cells` returns paired source + target rows in anchor-chain order. Each row carries its current `event_id` (AD-2 chain head) and target rows additionally carry `source_event_id` (AD-9 staleness pin) — both surface on `CellData` as `targetEventId`, `sourceEventId`, `targetSourceEventId`. `useProject` is a server-only fetch — no IDB fallback in v1 (per AD-3); a miss surfaces as `status: 'not-found'`.

### Writes

Writes flow through a local IndexedDB outbox (`src/lib/sync/outbox.ts`) and surface to the server via two paths:

1. **Per-project WebSocket reconciler** (`src/lib/sync/ws-reconciler.ts`) — `wss://sync-worker/parties/project-sync/:projectId`, backed by a per-project Durable Object (`sync-worker/src/project-do.ts`). Holds **only transient state**: focus-lock leases, presence, and `event.applied` / `event.stale` broadcasts. No DO storage writes; rooms evict when empty.
2. **HTTP fallback** — `POST /events` for queued events when the WS is unhealthy. The outbox flusher (`src/hooks/useOutboxFlusher.ts`) drains in batches with idempotent UUIDv7 ids.

Typed event helpers in `src/lib/sync/events-emit.ts`: `emitTargetCellCommit`, `emitCellValidate`, `emitCellUnvalidate`, `emitSourceCellCreate`, `emitFileCreate`. `outbox-types.ts` mirrors the server's `RawEvent<K>` grammar. All writes are optimistic — `useCells.revalidate()` (passed in as `onCellCommitted`) picks up the projection when the server acks. Remote `event.applied` broadcasts also trigger `revalidate()`.

### Live coordination

`useFocusLock` (per-cell) talks to the per-project reconciler: `focus.claim` on editor focus, periodic `focus.renew`, `focus.release` on blur. Other clients see "Alice is editing this cell" via `lock.claimed` / `lock.released` broadcasts. AD-1: this is the only live coordination mechanism — no CRDT, no operational transform. When two collaborators edit offline against the same source state, the parent-chain rule resolves on reconcile (first child of a parent wins; siblings stay in history).

### Editor

`TranslatedEditor` is plain TipTap (no `@tiptap/extension-collaboration`, no Y.Doc binding). It hydrates from `cell.translatedHtml` (falling back to `cell.translated`), debounces keystrokes to `COMMIT_IDLE_MS` (~1.2s), then calls `onCommit({ value, valueHtml })` on idle / blur / lock-release. The wrapping `EditorTable` row emits `target.cell.commit` via the outbox, chained on `cell.targetEventId` and pinned to `cell.sourceEventId`. A remote `event.applied` for the focused cell triggers a non-blocking "this cell changed elsewhere — discard and reload" banner; the user chooses discard (revalidate) vs. keep (their commit becomes a stale-sibling per AD-2 when finalized).

### Imports

Parsers (`src/lib/parsers/*`) still emit `TranslatableString[]` as the canonical intermediate shape. `src/lib/import.ts` no longer touches Y.Doc — instead it emits `file.create` + N `source.cell.create` events into the outbox, chained via `anchorCellId`. The dialog reports per-cell progress as events flush. Imported source blobs go to R2 (AD-4) for re-parse; the client keeps no local copy.

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

## Residual Y.Doc rip (Phase 2c-γ)

Phase 2c-β switched the editor + importer + read paths off Y.Doc and onto the AD-2 event-log + outbox, but a tail of feature surfaces — comments, multi-validator edit history, waivers, cell audio / video attachments, snapshots, parallel-passages search/replace, completion + backtranslation writebacks — still write into per-file Y.Doc handles (held in memory via the `useFileDoc` shim). These features are functional today but their durable state never reaches D1 until each surface migrates to its own event grammar. Phase 2c-γ rips them: delete the residual `src/lib/store/file-doc.ts`, `partyserver-provider.ts`, `translated-xml.ts`, `cqrs-bridge.ts`, the `@tiptap/extension-collaboration` dep, and the `yjs` / `y-indexeddb` / `y-partyserver` / `y-webrtc` direct deps. Many of the features above are deferred per spec (comments, threads, waivers, validator edit history are v1.x); the rip is gated on their grammars landing.

## Backend stack

Codex-web hosts its own Cloudflare Workers in this repo, independent of the older `frontier-server` (which keeps serving the codex-editor VS Code extension):

- **`auth-worker/`** — `/api/v2/auth/*`, `/api/v2/sync-token`, `/api/v2/projects/*invites*`. Writes to D1 `frontier-db-v2` (shared user table with the old frontier-server, but JWTs sign with codex-web's own `SECRET_KEY`).
- **`chat-worker/`** — `/api/v1/chat/completions`. Authenticated OpenRouter proxy. No billing.
- **`sync-worker/`** — realtime collab DOs (one per file). Persists Y.Doc snapshots/tails to R2 (`codex-snapshots`); projects flat row state to D1 (`codex-db`). Also hosts `/audio/*` for cell-audio storage.

Each worker has a `[env.staging]` block pointing at staging-suffixed resources (`frontier-db-v2-staging`, `codex-db-staging`, `codex-snapshots-staging`). Production and staging share zero data.

The frontend wires worker URLs via build-time env vars: `VITE_AUTH_BASE`, `VITE_CHAT_BASE`, `VITE_SYNC_WORKER_HOST`. The deploy workflow injects prod vs staging hosts based on the branch.

## CI / deploy lifecycle

Five workflows in `.github/workflows/`:

| Workflow | Trigger paths |
|---|---|
| `deploy.yml` (Pages) | all paths except `**.md`, `docs/**` |
| `deploy-workers.yml` | `sync-worker/**`, `auth-worker/**`, `chat-worker/**` |
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
