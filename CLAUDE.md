# CLAUDE.md

Guidance for Claude Code working in this repo. See also **`AGENTS.md`** (testing/E2E rules,
shared by all AI assistants) and `docs/` (SYNC, AGENT-API, AGENT-SANDBOX, FEATURE-STORIES;
SPEC.md covers the separate VS Code Codex extension that uses Aquilla as a backend).

## Layout — flat single-SPA trunk

This repo is a **single browser SPA at the repo root** plus a small set of Cloudflare Workers.
(An earlier `apps/*` "AD-11 monorepo" layout and a `packages/` shared-libs layout were both
abandoned — if you find docs or memory describing `apps/workspace/`, `packages/api-client`,
`chat-worker/`, `routes.json`, or `seed.sql`, they are stale. Verify against the tree.)

```
/
├── src/                # the workspace SPA
│   ├── App.tsx         # full route table; project views under /project/:id/...
│   ├── lib/            # ~50 subsystems. Core: sync, parsers, import, editor, rules,
│   │                   #   health, completion, agent, audio, comments, search, export,
│   │                   #   dcs, codex-editor, brief, credits, entitlements, store, …
│   ├── hooks/          # read hooks (useCells, useProject, …) + outbox flusher
│   ├── pages/ components/ context/ branding/
│   └── test-setup.ts
├── auth-worker/        # identity + agent-API Worker — see Backend below
├── sync-worker/        # realtime/sync Worker — see Backend below
├── agent-worker/       # sandboxed agent code-execution Worker — see Backend below
├── db/                 # LIVE Postgres schema: postgres/schema.sql, postgres/migrations/,
│                       #   rollout/, shim/ (D1-compatible executor over Hyperdrive)
├── worker/             # root SPA-serving Worker (index.ts + og/) for the production deploy
├── infra/modal/        # Modal services: diarization.py, seed_vc.py, omnivoice_app.py
├── src-tauri/          # Tauri desktop shell
├── e2e/                # Playwright specs + page objects + JOURNEYS.md (see AGENTS.md)
├── scripts/            # dev-stack.ts (local full stack), e2e-up.ts, brand/build helpers
└── vite.config.ts      # drives the SPA + Tauri build; @/ → ./src
```

`@/` resolves to `./src` (tsconfig + vite). Vitest runs in `happy-dom`; `src/test-setup.ts`
loads `fake-indexeddb/auto` so IDB/idb tests run without a browser.

## Commands

```bash
pnpm i
pnpm dev          # tsx scripts/dev-stack.ts — full local stack (SPA + workers; agent-worker :8790)
pnpm dev:vite     # just the vite dev server
pnpm build        # tsc -b && vite build && scripts/check-brand-build.ts aquilla
pnpm lint         # eslint .
pnpm test         # vitest run — root suite EXCLUDES e2e/** and all worker packages
                  #   (auth-worker, sync-worker, agent-worker, worker, parity)
pnpm test:watch

# E2E (Playwright) — see AGENTS.md; pre-push hook runs the smoke suite
pnpm test:e2e:smoke
pnpm test:e2e

# Worker tests run per-package (own package-lock, ESM):
cd sync-worker && npm test
cd auth-worker && npm test
cd agent-worker && npm test    # worker/ also has its own vitest suite

# Run one test file / pattern
pnpm test src/lib/parsers/usfm.test.ts
pnpm test -t "splits by verse"
```

Other script families in `package.json` (look there before writing your own): `neon:*`
(Postgres migration status/apply/baseline), `seed:*` (seed data), `parity:*` / `roundtrip:*`
(acceptance suites), `tauri:*` (desktop), `deploy:aquilla:staging*` / `deploy:aquilla:dev*`.

### Multi-brand

The SPA ships under several brands selected by the `BRAND` env var
(`aquilla` default, plus `codex`, `honeycomb`, `context`). Brand definitions live in
`src/branding/brands/`. Build/deploy variants: `pnpm dev:codex`, `pnpm build:honeycomb`,
`pnpm deploy:codex`, etc. The default app deploys to `aquilla.app`.

## Backend (Cloudflare Workers, all in this repo)

**Datastore: Postgres (Neon) via Hyperdrive.** The D1→Postgres cutover is **complete** — no
worker binds D1; workers fail fast if `HYPERDRIVE` is unbound and query through
`db/shim/postgres.ts`. Live schema/migrations are `db/postgres/`; `auth-worker/migrations/` and
`sync-worker/migrations/` are retained only as historical D1 records.

- **`auth-worker/`** — Worker `aquilla-identity`. `/api/v2/*`: `auth/*`, `sync-token`,
  `users/*`, `orgs/*`, `projects/*` (+ invites, settings, source-linking, member-scopes,
  termbase, agent-memory, agent-artifacts), `admin/*` (platform admin), `changesets/*` (human
  approval gate for ask-mode agent changesets), `credentials` (PATs for the Agent API),
  `parse-document`. `/api/v1/*`: `chat` (OpenRouter proxy, folded in here), `ai/agent/run`
  (translation agent, SSE), `aquifer` (Bible Aquifer proxy), `usage`.
- **`sync-worker/`** — Worker `aquilla-sync-worker`, R2 `aquilla-snapshots`. Owns the
  append-only event log and its projection to `cells`/`files`, the per-project `ProjectSync`
  Durable Object (presence, focus-lock leases, `event.applied`/`event.stale` broadcast — no
  durable DO state), comments (+ email notifications via CF Email Service), `/audio/*`,
  diarization, voice-convert, and the external **Agent API** under `/api/v1/external/*`
  (changeset engine + apply gate, artifacts, tools-only MCP server, self-describing
  discovery — see `docs/AGENT-API.md`). Per-PR fork template `wrangler.pr.toml.tpl`.
- **`agent-worker/`** — Worker `aquilla-agent-sandbox`: container-backed Durable Object for
  sandboxed agent code execution (see `docs/AGENT-SANDBOX.md`). Server-side only — auth-worker
  calls it via `AGENT_SANDBOX_URL` + shared `AGENT_SANDBOX_KEY`; no zone routes. Reads
  artifacts from the same `aquilla-snapshots` R2 bucket. Local dev on `:8790`.

In-flight (uncommitted on dev): Monday.com nudge — `sync-worker/src/monday-notify.ts` fires
best-effort throttled pushes from the DO broadcast to auth-worker `/api/v2/monday/internal/push`.

Frontend wires hosts at build time: `VITE_AUTH_BASE`, `VITE_CHAT_BASE`,
`VITE_SYNC_WORKER_HOST`. Browser-facing workers mount under `aquilla.app/api/*` via Workers
Routes (Safari drops `*.workers.dev` — see SYNC.md). CI's CF token cannot mutate zone routes:
keep `routes` out of the CI-deployed `wrangler.toml` top level; routes are claimed out-of-band
by a local `wrangler deploy`.

## Architecture (AD-2 / AD-3 / AD-9)

- **Source of truth:** the append-only `events` table in Postgres (owned by sync-worker).
  Every write is an event with a `parent_id` (prior winning event on the same
  `(project, file, cell)`); the projection (`cells`, `files`, `cell_validators`) lands as
  events apply. Cell events are `source.*` (importer) or `target.*` (contributor). For v1
  single-editor reliability, `*.cell.commit` projects **last-write-wins**; chain-mutating
  events keep first-child.
- **Reads (thin client, AD-3):** read hooks under `src/lib/sync/*-read.ts` fetch from
  sync-worker HTTP on demand (`useCells`, `useProject`, `useCellHistory`, …). Plain
  `useState` + race-guarded `useEffect` — React Query is installed but only `useQueryClient`
  invalidation is used; never add `useQuery`/`useMutation` hooks. `useProject` is server-only
  (no IDB fallback — a miss is `not-found`). The outbox is a write buffer **only** — never
  replay it over server reads.
- **Writes:** flow through an IndexedDB outbox (`src/lib/sync/outbox.ts`) → either the
  per-project WebSocket reconciler (`ws-reconciler.ts` ↔ `sync-worker/src/project-do.ts`) or
  HTTP `POST /events` fallback (flushed by `src/hooks/useOutboxFlusher.ts`, idempotent UUIDv7
  ids). Typed emitters in `src/lib/sync/events-emit.ts`. All writes optimistic; a server ack /
  remote `event.applied` triggers `revalidate()`.
- **Live coordination (AD-1):** `useFocusLock` claims/renews/releases per-cell focus leases via
  the project DO; others see "X is editing." No CRDT/OT — the parent-chain rule resolves
  offline-divergent edits on reconcile.
- **Editor:** `TranslatedEditor` is plain TipTap (no Y.Doc binding); hydrates from
  `cell.translatedHtml`, debounces to idle, emits `target.cell.commit` chained on
  `targetEventId` and pinned to `sourceEventId` (AD-9 staleness pin).
- **Imports:** parsers in `src/lib/parsers/*` emit `TranslatableString[]`; `src/lib/import.ts`
  emits `file.create` + N `source.cell.create` events into the outbox. Source blobs go to R2.
- **Agent (AQU-AGENT):** `src/lib/agent/` is the in-app translation-agent harness (session
  store, run state, memory API, apply/undo). Agent writes land as **staged changesets** with a
  human approval gate — never direct commits. External agents use the Agent API/MCP surface
  (sync-worker `external/*`) with PAT credentials scoped org/project.
- **Other major subsystems:** comments (`src/lib/sync/comments-read.ts`, `useComments`),
  search (`src/lib/search/` dual-index + replace), DCS linked-project sync (`src/lib/dcs/`,
  Gitea catalog + delta import), audio/TTS stack (`src/lib/audio/`, Modal + Gemini/Kokoro),
  export (`src/lib/export/`), rules/health/completion (`src/lib/rules|health|completion/`),
  local prefs (`src/lib/store/`, localStorage-backed).
- **React Compiler gotcha:** the compiler memoizes away version-only dependencies; when
  reading from a versioned store, wrap reads with `readAtVersion()`
  (`src/hooks/useActiveCellStore.ts`) so the version participates in the computation. Vitest
  runs with the compiler off, so tests won't catch violations.

## Code style

TypeScript, no `any`. ES6+ (`const`/`let`, arrow fns, async/await, `?.`/`??`). React 19 +
Tailwind v4 + shadcn/ui (`components.json`, primitives in `src/components/ui/`) + `@base-ui/react`;
icons are lucide. Use the `components.json` aliases (`@/components/ui`, `@/lib/utils`).
Target files under ~500 lines. See `AGENTS.md` for the (non-negotiable) testing rules.
