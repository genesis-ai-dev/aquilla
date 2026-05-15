# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo layout (AD-11 — Aquilla)

Phase 1B introduced the `apps/` + `packages/` chassis per spec §21-monorepo.md. Each task-flow ships as its own deployable Worker under `apps/<slug>/`; the workspace SPA is the deliberate exception. Cross-app imports outside of `packages/` are forbidden — sharing happens through versioned packages (`@aquilla/ui`, `@aquilla/auth-client`, `@aquilla/api-client`, `@aquilla/data-model`, `@aquilla/telemetry`, `@aquilla/errors`).

- `apps/<slug>/` — one Worker per discrete task (`login`, `signup`, `reset`, `projects`, `import`, `export`, `migrate`, `billing`, `org`, `workspace`, `identity`).
- `apps/workspace/` — AD-11's deliberate SPA exception (editor + copilot + comments + validation + search + sync + presence). Mounted at `/w/*`. The workspace's source lives at `apps/workspace/src/` (moved out of the repo root in Phase 3a-final).
- `apps/front-door/` — root + 404 fallback Worker (`/` → `/projects`, CSP injection, `/__routes` debug). Cloudflare Workers Routes (not the front-door) dispatches each slug to its Worker.
- `packages/<name>/` — shared, versioned concerns. `@aquilla/errors` ships the boot-time `assertEnvBindings()` + `assertNotPreviewInProd()` helpers — every Worker calls them at startup so a preview deploy can't silently bind to prod resources (spec §"Environment binding hygiene").
- `routes.json` (repo root) — authoritative slug → URL-path registry. Adding an app means editing this file plus dropping a folder under `apps/`.
- `seed.sql` (repo root) — canonical preview test cast (alice/bob/carol/dave) applied to every per-PR D1 and the shared `aquilla-dev`.

Phase 3a-final moved the workspace SPA's source from the repo-root `src/` into `apps/workspace/src/`, completing the monorepo-extraction effort. The repo root retains only orchestration (root `package.json` scripts, `vite.config.ts` that drives the Tauri build with `root: apps/workspace`, e2e/, scripts/, the brand HTML plugin, Tauri shell, and CI workflows). All 11 task-flow apps now live under `apps/`; all 6 shared packages under `packages/`. The AD-11 spec-unification pass relocated `auth-worker/` → `apps/identity/` (renamed from `frontier-server`), `sync-worker/` → `apps/sync/`, and `chat-worker/` → `apps/chat/`. No top-level workers remain.

**Apps populated:** all eleven — `front-door` (Phase 1B), `login` / `signup` / `reset` (Phase 3b), `import` / `export` / `migrate` (Phase 3d shells), `projects` / `billing` / `org` (Phase 3c), `identity` (Phase 3e), `workspace` (Phase 3a-final). **Packages populated:** all six — `errors` (1B), `auth-client` / `ui` (3b), `api-client` (3c), `data-model` / `telemetry` (#85).

Each populated app is a Vite SPA served by a Cloudflare Worker with a Workers Assets binding. The Worker script under `src/worker.ts` adds boot-time env-binding assertions (`@aquilla/errors`) + baseline security headers; the SPA lives in `dist/` and routes client-side under its mounted basename (`/login`, `/signup`, `/reset`, `/w`, …). Build-time `VITE_AUTH_BASE` controls the identity-service host so the rename from `codex-auth-worker` to `aquilla-identity` (Phase 3e) is a one-line wrangler-vars change.

## Project Overview

`codex-web` is a browser-based reimplementation of the Codex translation editor (originally a VS Code extension — see `docs/SPEC.md` for the origin design). It is a standalone single-page app: a cell-based translation notebook that imports source documents (USFM, DOCX, PPTX, Markdown, plaintext, VTT/SRT), lets translators fill in aligned target cells with rich text, and supports collaborative editing, snapshots, rules/health scoring, and LLM completion/backtranslation.

Backed by Cloudflare Workers in this repo (`apps/identity/`, `apps/sync/`, `apps/chat/`). The web client is a thin tier-1 client per AD-3 — reads on demand from D1, writes through a local outbox.

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
pnpm test apps/workspace/src/lib/parsers/usfm.test.ts
pnpm test -t "splits by verse"
```

Vitest runs in `happy-dom` with `fake-indexeddb/auto` loaded via `apps/workspace/src/test-setup.ts`, so tests that use IndexedDB / idb work without a browser. Path alias `@/` resolves to `apps/workspace/src/` (post-Phase-3a-final).

## Architecture

Post-Phase-2 the app is built on AD-2 / AD-3 v1 / AD-9:

### Source of truth

The append-only `events` table in D1 (`apps/sync/`'s `aquilla-db`) is the durable record. Every write is an event with `parent_id` (the prior winning event on the same `(project_id, file_id, cell_id)`); the projection (`cells`, `files`, `cell_validators`) lands as events apply. Cell events are prefixed `source.*` (importer-only) or `target.*` (contributor+). `target.cell.commit` carries an AD-9 `sourceEventId` pin onto the source row's `event_id` observed at commit time — staleness becomes a pointer comparison at read.

### Reads

Tier-1 thin client: reads fetch from `apps/sync/`'s HTTP endpoints on demand. Typed fetch wrappers live alongside the hooks under `apps/workspace/src/lib/sync/*-read.ts`; each pairs with a `*-read-types.ts` mirror of the server response shape. Hooks use plain `useState` + race-guarded `useEffect`; no React Query, no SWR. Key read hooks: `useProject`, `useCells`, `useCellHistory`, `useCellValidators`, `useFileMeta`, `useWorkspaceSearch`, `useProjectMembers`, `useOrgInvites`, `useProjectSettings`.

`useCells` is the load path for the editor table: `GET /api/v1/projects/:projectId/files/:fileId/cells` returns paired source + target rows in anchor-chain order. Each row carries its current `event_id` (AD-2 chain head) and target rows additionally carry `source_event_id` (AD-9 staleness pin) — both surface on `CellData` as `targetEventId`, `sourceEventId`, `targetSourceEventId`. `useProject` is a server-only fetch — no IDB fallback in v1 (per AD-3); a miss surfaces as `status: 'not-found'`.

### Writes

Writes flow through a local IndexedDB outbox (`apps/workspace/src/lib/sync/outbox.ts`) and surface to the server via two paths:

1. **Per-project WebSocket reconciler** (`apps/workspace/src/lib/sync/ws-reconciler.ts`) — `wss://<sync-worker-host>/parties/project-sync/:projectId`, backed by a per-project Durable Object (`apps/sync/src/project-do.ts`). Holds **only transient state**: focus-lock leases, presence, and `event.applied` / `event.stale` broadcasts. No DO storage writes; rooms evict when empty.
2. **HTTP fallback** — `POST /events` for queued events when the WS is unhealthy. The outbox flusher (`apps/workspace/src/hooks/useOutboxFlusher.ts`) drains in batches with idempotent UUIDv7 ids.

Typed event helpers in `apps/workspace/src/lib/sync/events-emit.ts`: `emitTargetCellCommit`, `emitCellValidate`, `emitCellUnvalidate`, `emitSourceCellCreate`, `emitFileCreate`. `outbox-types.ts` mirrors the server's `RawEvent<K>` grammar. All writes are optimistic — `useCells.revalidate()` (passed in as `onCellCommitted`) picks up the projection when the server acks. Remote `event.applied` broadcasts also trigger `revalidate()`.

### Live coordination

`useFocusLock` (per-cell) talks to the per-project reconciler: `focus.claim` on editor focus, periodic `focus.renew`, `focus.release` on blur. Other clients see "Alice is editing this cell" via `lock.claimed` / `lock.released` broadcasts. AD-1: this is the only live coordination mechanism — no CRDT, no operational transform. When two collaborators edit offline against the same source state, the parent-chain rule resolves on reconcile (first child of a parent wins; siblings stay in history).

### Editor

`TranslatedEditor` is plain TipTap (no `@tiptap/extension-collaboration`, no Y.Doc binding). It hydrates from `cell.translatedHtml` (falling back to `cell.translated`), debounces keystrokes to `COMMIT_IDLE_MS` (~1.2s), then calls `onCommit({ value, valueHtml })` on idle / blur / lock-release. The wrapping `EditorTable` row emits `target.cell.commit` via the outbox, chained on `cell.targetEventId` and pinned to `cell.sourceEventId`. A remote `event.applied` for the focused cell triggers a non-blocking "this cell changed elsewhere — discard and reload" banner; the user chooses discard (revalidate) vs. keep (their commit becomes a stale-sibling per AD-2 when finalized).

### Imports

Parsers (`apps/workspace/src/lib/parsers/*`) still emit `TranslatableString[]` as the canonical intermediate shape. `apps/workspace/src/lib/import.ts` no longer touches Y.Doc — instead it emits `file.create` + N `source.cell.create` events into the outbox, chained via `anchorCellId`. The dialog reports per-cell progress as events flush. Imported source blobs go to R2 (AD-4) for re-parse; the client keeps no local copy.

### Rules, health, completion

- `apps/workspace/src/lib/rules/rule-engine.ts` evaluates `TranslationRule[]` against cell pairs; `rule-suggester.ts` asks an LLM to propose rules. Infractions feed into health.
- `apps/workspace/src/lib/health/health-engine.ts` computes the project health ring shown in `HealthRing`, combining rule infractions, validation state, and an LLM penalty multiplier from `CompletionSettings`.
- `apps/workspace/src/lib/completion/completion-service.ts` and `backtranslation-service.ts` call the configured `CompletionSettings.endpoint` (OpenAI-compatible). Endpoint/model/system-prompt are per-project.

### Routing

`apps/workspace/src/App.tsx` is the full route table for the workspace SPA. All project-scoped views are under `/project/:id/...` (workspace, settings, rules, comments, snapshots, plus `/debug` variants). `/join/:token` handles share-link entry. There is no auth layer — the identity is a `username` stored on the `ProjectRecord`.

### UI stack

React 19 + Tailwind v4 (via `@tailwindcss/vite`) + shadcn/ui (`components.json`, style `base-nova`, primitives in `apps/workspace/src/components/ui/`) + `@base-ui/react`. Icons are lucide. When adding shadcn components, use the aliases declared in `components.json` (`@/components/ui`, `@/lib/utils`, etc.) — `@/` resolves to `apps/workspace/src/`.

## Design docs & milestones

`docs/SPEC.md` describes the VS Code extension this app was extracted from — useful for understanding the `.codex` notebook / paired-source / LLM-context concepts that this app inherits. Per-milestone specs and implementation plans live under `docs/superpowers/specs/` and `docs/superpowers/plans/` (M1–M10 covering import, editor, health, rules, export, search+backtranslation, comments, snapshots, richtext/Yjs migration, P2P sync). When working on a feature that has a spec there, read it first — the schema decisions (especially `translatedXml` vs `translated`, `SnapshotFile.ydocState`, `schemaVersion` on snapshots) were made deliberately and are load-bearing for migrations.

## Residual Y.Doc rip (Phase 2c-γ)

Phase 2c-β switched the editor + importer + read paths off Y.Doc and onto the AD-2 event-log + outbox, but a tail of feature surfaces — comments, multi-validator edit history, waivers, cell audio / video attachments, snapshots, parallel-passages search/replace, completion + backtranslation writebacks — still write into per-file Y.Doc handles (held in memory via the `useFileDoc` shim). These features are functional today but their durable state never reaches D1 until each surface migrates to its own event grammar. Phase 2c-γ rips them: delete the residual `apps/workspace/src/lib/store/file-doc.ts`, `partyserver-provider.ts`, `translated-xml.ts`, `cqrs-bridge.ts`, the `@tiptap/extension-collaboration` dep, and the `yjs` / `y-indexeddb` / `y-partyserver` / `y-webrtc` direct deps. Many of the features above are deferred per spec (comments, threads, waivers, validator edit history are v1.x); the rip is gated on their grammars landing.

## Backend stack

Codex-web hosts its own Cloudflare Workers in this repo, independent of the older `frontier-server` repo (which keeps serving the codex-editor VS Code extension):

- **`apps/identity/`** — `/api/v2/auth/*`, `/api/v2/sync-token`, `/api/v2/users/*`, `/api/v2/orgs/*`, `/api/v2/projects/*` (incl. invites + settings + source-linking), `/api/v2/invites/*`. Identity service per AD-5; mounted under `/api/identity/*` via Workers Routes (routes.json). Worker name `aquilla-identity` (prod: `aquilla-prod-identity`; staging: `aquilla-dev-identity`). Writes to D1 `aquilla-db` (its own schema; not shared with the legacy `frontier-db-v2`). Relocated from top-level `auth-worker/` in Phase 3e, renamed from `frontier-server` during the AD-11 spec-unification pass.
- **`apps/chat/`** — `/api/v1/chat/completions`. Authenticated OpenRouter proxy. No billing. Worker name `aquilla-chat-worker` (relocated from top-level `chat-worker/` during the AD-11 spec-unification pass).
- **`apps/sync/`** — realtime collab DOs (one per file). Persists Y.Doc snapshots/tails to R2 (`codex-snapshots`; TODO rename to `aquilla-snapshots`); projects flat row state to D1 (`aquilla-db`, same database as identity but writer-only against `files`/`cells`/`events`/etc.). Also hosts `/audio/*` for cell-audio storage. Worker name `aquilla-sync-worker` (relocated from top-level `sync-worker/` during the AD-11 spec-unification pass).

Each worker has a `[env.staging]` block pointing at staging-suffixed resources (`aquilla-db-staging`, `aquilla-snapshots-staging`). `apps/identity/` additionally has an `[env.preview]` block (per-PR; `aquilla-pr-<N>-identity`) that CI substitutes `__PR__` into. Production and staging share zero data.

The frontend wires worker URLs via build-time env vars: `VITE_AUTH_BASE`, `VITE_CHAT_BASE`, `VITE_SYNC_WORKER_HOST`. The deploy workflow injects prod vs staging hosts based on the branch.

## CI / deploy lifecycle

Workflows in `.github/workflows/`:

| Workflow | Trigger paths |
|---|---|
| `deploy-apps-prod.yml` | every `apps/<slug>/**` (except front-door currently) on push to `main` — matrix-deploys all Workers via `wrangler deploy --env=production` |
| `deploy-all-apps.yml` | every PR — matrix-deploys per-PR previews via `wrangler deploy --env=preview` at `pr-<N>.aquilla.app/<slug>/*` |
| `pr-db-fork.yml` | `apps/*/migrations/**.sql` (any app's migrations) — provisions `aquilla-pr-<N>` D1 + per-PR sync worker |
| `pr-db-cleanup.yml` | `apps/*/migrations/**.sql` (PR-close event) |
| `nightly-dev-reset.yml` | nightly cron — drops + reapplies `aquilla-db-staging` from migrations + seed |
| `web-ci.yml` | every PR push (no path filter) — runs tests + build |

Cloudflare Pages retirement is **partial**. The repo no longer builds or deploys a Pages bundle (the `deploy.yml` workflow + root deploy scripts are gone), but the existing Pages deployment is still live in CF and Workers Routes still maps `aquilla.app/` (apex-exact) to front-door — not the wildcard `aquilla.app/*` claim that's documented in `apps/front-door/wrangler.toml`. Unclaimed paths still fall through to Pages, which serves the old SPA bundle's `index.html` + favicons. To complete the cutover: (a) migrate favicons + any other Pages-served assets into front-door or an app's `public/`, then (b) update the `aquilla.app/` Workers Route to `aquilla.app/*` in the Cloudflare dashboard (CI's token has `workers_routes:write` but the change is risky enough to want human review).

### Branch behavior

- **Push to `main`** → production deploy. Every app under `apps/*` re-deploys in parallel via `deploy-apps-prod.yml`.
- **Push to `dev`** → staging deploy. Every app re-deploys with `--env=staging` to `aquilla-dev-<slug>` Workers; routes claim `dev.aquilla.app/<slug>/*`.

### PR behavior

- **PR opened / reopened / `ready_for_review` / synchronize with `[preview]` or `[deploy]` in the commit message** → `deploy-all-apps.yml` deploys per-PR Workers (`aquilla-pr-<N>-<slug>`) to `pr-<N>.aquilla.app/<slug>/*`. Sticky comment posts the URL.
- **PR push (synchronize) without the tag** → no redeploy (saves CF/GH minutes).
- **Draft PR** → never deploys.
- **Concurrency cancellation** is enabled per-PR — a new push kills the in-flight deploy for the same PR.

### Per-PR DB fork (for migration PRs)

If a PR adds `apps/*/migrations/**.sql`, the `pr-db-fork.yml` workflow:

1. Creates `aquilla-pr-<N>` D1 (mirrors `aquilla-db-staging` schema + applies the new migration files)
2. Generates a per-PR `wrangler.toml` from `apps/sync/wrangler.pr.toml.tpl` (substitutes `__PR__`, `__DB_ID__`)
3. Deploys `aquilla-sync-worker-pr-<N>` pointing at the forked D1; R2 namespaced via `R2_KEY_PREFIX=pr-<N>` (shares `aquilla-snapshots-staging`)
4. Worker runs with `ALLOW_UNAUTHENTICATED=true` (per-PR shortcut — semi-hidden URL, staging data)
5. Sticky-comments the per-PR worker URL on the PR

`pr-db-cleanup.yml` runs on PR close (only when the PR had migrations) and tears down the per-PR worker, D1, and R2 keys under `pr-<N>/`.

The CF API token in CI (`CLOUDFLARE_API_TOKEN` GH secret) needs D1 write scopes for the fork workflow to actually function.

## Reference card: branch → effect

```
Open a PR (non-draft) → preview at pr-<N>.aquilla.app (per-app Workers)
Add a .sql migration → per-PR D1 + sync-worker variant spun up via pr-db-fork.yml

Push fixups            → preview stays stale unless commit msg has [preview]
Push with [preview]    → preview rebuilds
Mark ready for review  → preview rebuilds

Close PR               → per-PR DB + worker torn down (only if it had migrations)
Merge to dev           → dev.aquilla.app rebuilds with --env=staging
Merge dev → main       → production rebuilds (prod workers + aquilla.app)
```
