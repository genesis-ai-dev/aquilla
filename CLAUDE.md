# CLAUDE.md

Guidance for Claude Code working in this repo. See also **`AGENTS.md`** (testing/E2E rules,
shared by all AI assistants) and `docs/` (SPEC, SYNC, import/hosting design).

## Layout — flat single-SPA trunk

This repo is a **single browser SPA at the repo root** plus a small set of Cloudflare Workers.
(An earlier `apps/*` "AD-11 monorepo" layout was abandoned — if you find docs or memory
describing `apps/workspace/`, `apps/identity/`, `apps/sync/`, `routes.json`, or `seed.sql`, they
are stale. Verify against the tree.)

```
/
├── src/                # the workspace SPA (editor, copilot, comments, search, sync, …)
│   ├── App.tsx         # full route table; project views under /project/:id/...
│   ├── lib/            # parsers, import, sync, editor, rules, health, completion,
│   │                   #   diarization, video/audio, search, export, migrate, …
│   ├── hooks/          # read hooks (useCells, useProject, …) + outbox flusher
│   ├── pages/ components/ context/ branding/
│   └── test-setup.ts
├── auth-worker/        # identity Worker — see Backend below
├── sync-worker/        # realtime/sync Worker — see Backend below
├── chat-worker/        # empty leftover stub; chat now lives in auth-worker (routes/chat.ts)
├── packages/           # shared libs: api-client, auth-client, data-model, telemetry, ui
├── db/                 # Postgres migration work-in-progress (postgres/schema.sql, shim/)
├── worker/             # root SPA-serving Worker (index.ts) for the production deploy
├── infra/modal/        # Modal services: diarization.py (pyannote), seed_vc.py (voice clone)
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
pnpm dev          # tsx scripts/dev-stack.ts — full local stack (SPA + workers)
pnpm dev:vite     # just the vite dev server
pnpm build        # tsc -b && vite build && brand-build check (aquilla)
pnpm lint         # eslint .
pnpm test         # vitest run   (root suite EXCLUDES sync-worker/**)
pnpm test:watch

# E2E (Playwright) — see AGENTS.md; pre-push hook runs the smoke suite
pnpm test:e2e:smoke
pnpm test:e2e

# Worker tests run per-package (own package-lock, ESM):
cd sync-worker && npm test
cd auth-worker && npm test

# Run one test file / pattern
pnpm test src/lib/parsers/usfm.test.ts
pnpm test -t "splits by verse"
```

### Multi-brand

The SPA ships under several brands selected by the `BRAND` env var
(`aquilla` default, plus `codex`, `honeycomb`, `context`). Brand definitions live in
`src/branding/brands/`. Build/deploy variants: `pnpm dev:codex`, `pnpm build:honeycomb`,
`pnpm deploy:codex`, etc. The default app deploys to `aquilla.app`.

## Backend (Cloudflare Workers, all in this repo)

- **`auth-worker/`** — Worker `aquilla-identity`, D1 `aquilla-db`. Routes under `/api/v2/*`:
  `auth/*`, `sync-token`, `users/*`, `orgs/*`, `projects/*` (+ invites, settings,
  source-linking), and **`chat`** (OpenRouter proxy — folded in here; `chat-worker/` is a
  dead stub). Migrations in `auth-worker/migrations/`.
- **`sync-worker/`** — Worker `aquilla-sync-worker`, D1 `aquilla-db` + R2 `aquilla-snapshots`.
  Owns the append-only event log and its projection to `cells`/`files`, the per-project
  `ProjectSync` Durable Object (presence, focus-lock leases, `event.applied`/`event.stale`
  broadcast — no durable DO state), `/audio/*`, diarization, and voice-convert. Migrations in
  `sync-worker/migrations/`; per-PR fork template `wrangler.pr.toml.tpl`.

Frontend wires hosts at build time: `VITE_AUTH_BASE`, `VITE_CHAT_BASE`,
`VITE_SYNC_WORKER_HOST`. Browser-facing workers mount under `aquilla.app/api/*` via Workers
Routes (Safari drops `*.workers.dev` — see SYNC.md). CI's CF token cannot mutate zone routes:
keep `routes` out of the CI-deployed `wrangler.toml` top level; routes are claimed out-of-band
by a local `wrangler deploy`.

### In-flight: Postgres migration

`db/postgres/schema.sql` + `db/shim/d1-postgres.ts` are an in-progress port of the D1 schema to
Postgres (Neon), staged behind a D1-compatible executor shim (FTS5 → tsvector). Workers still
run on D1 today; the shim lets `event-projection`/import target either dialect.

## Architecture (AD-2 / AD-3 / AD-9)

- **Source of truth:** the append-only `events` table in D1 (sync-worker). Every write is an
  event with a `parent_id` (prior winning event on the same `(project, file, cell)`); the
  projection (`cells`, `files`, `cell_validators`) lands as events apply. Cell events are
  `source.*` (importer) or `target.*` (contributor). For v1 single-editor reliability,
  `*.cell.commit` projects **last-write-wins**; chain-mutating events keep first-child.
- **Reads (thin client, AD-3):** read hooks under `src/lib/sync/*-read.ts` fetch from
  sync-worker HTTP on demand (`useCells`, `useProject`, `useCellHistory`, …). Plain
  `useState` + race-guarded `useEffect`; no React Query/SWR. `useProject` is server-only (no
  IDB fallback — a miss is `not-found`). The outbox is a write buffer **only** — never replay it
  over D1 reads.
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
- **Rules / health / completion:** `src/lib/rules/`, `src/lib/health/`, `src/lib/completion/`
  (OpenAI-compatible endpoint, per-project settings).

## Code style

TypeScript, no `any`. ES6+ (`const`/`let`, arrow fns, async/await, `?.`/`??`). React 19 +
Tailwind v4 + shadcn/ui (`components.json`, primitives in `src/components/ui/`) + `@base-ui/react`;
icons are lucide. Use the `components.json` aliases (`@/components/ui`, `@/lib/utils`).
Target files under ~500 lines. See `AGENTS.md` for the (non-negotiable) testing rules.
