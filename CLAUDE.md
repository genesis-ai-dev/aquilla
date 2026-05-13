# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
