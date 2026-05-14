# `@aquilla/workspace`

The translation workspace SPA — editor + copilot + comments + validation + search + sync + presence. AD-11's deliberate SPA exception (every other app under `apps/` is task-flow-scoped).

Mounted at `/w/*` per `routes.json`.

## Status: shell only (Phase 3a-shell)

This directory currently contains **config only** — Vite config, TypeScript config, package manifest, wrangler.toml. No `src/` yet.

The actual workspace extraction (move every workspace-related file from the repo-root `src/` into `apps/workspace/src/`) lands in **Phase 3a-final**, after these dependencies merge:

- **Phase 2c-β** (editor rewrite + Yjs removal + import-flow rewrite) — rewrites every file in `src/components/`, `src/lib/parsers/*`, `src/lib/store/*`, `src/lib/import.ts`, `src/lib/sync/{partyserver-provider, cqrs-bridge}.ts`, `src/lib/richtext/translated-xml.ts`, `src/hooks/{useFileDoc, useProject}.ts`. Doing the extraction before this lands would either lose 2c-β's work or require a full rebase-and-redo.
- **Phase 3b** (login/signup/reset) and **Phase 3c** (projects/billing/org) — these copy shared components into `packages/ui` and `packages/auth-client`. The workspace SPA's extraction consumes those packages instead of duplicating.
- **Phase 5** (source-linking UI) — adds new components in `src/components/` that need to come along into `apps/workspace/src/`.

Once those four merge, 3a-final's job is mechanical: `git mv` `src/` into `apps/workspace/src/`, rewrite imports in `App.tsx` to point at `@aquilla/ui` / `@aquilla/api-client` / etc., delete the routes that now live in other apps (`/`, `/project/:id/settings`, `/join/:token`, etc. — see `src/App.tsx`), then `pnpm test && pnpm build`.

## Build commands (when populated)

```sh
pnpm i
pnpm dev     # local Vite dev server
pnpm build   # tsc + vite build
pnpm deploy  # wrangler deploy
```
