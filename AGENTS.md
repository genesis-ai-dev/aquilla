# AGENTS.md

Rules for any AI coding assistant working in this repo (Claude Code, Cursor, Copilot, Aider, etc.).

## Testing — non-negotiable

Before claiming any feature is complete:

1. **Run the smoke suite.** `npm run test:e2e:smoke` must pass. The pre-push hook enforces this; do not bypass with `--no-verify` unless explicitly told to.
2. **If your change touches a journey listed in `e2e/JOURNEYS.md`, extend the matching spec OR add a new spec under `e2e/specs/<area>/`.**
3. **New user-facing journey = new row in `e2e/JOURNEYS.md` AND a new spec.**
4. **Reuse helpers** in `e2e/helpers/page-objects/`. Do not duplicate selectors. If no page object fits, add one.
5. Tests run against a **local `wrangler dev` instance** of `frontier-server`, not the production backend. See `e2e/README.md` for setup.

## Conventions

- Spec naming: `*.smoke.spec.ts` for the pre-push gate (<2 min total budget across all smoke specs); `*.spec.ts` for the full suite.
- Multi-user tests: import `{ test, expect } from "../../helpers/multi-user"`.
- Single-user tests: import from `@playwright/test` and call `resetBackend()` in your own `beforeEach`.
- Page objects: one class per surface, methods are user-intent verbs (`createProject`, `editCell`, not `clickButton1`).
- Selectors: prefer `getByRole`, `getByLabel`, then data attributes (`data-cell-id`); avoid CSS class selectors except for verifying a specific visual state (e.g. `text-emerald-500` for "validated").

## Out of scope for tests

- Snapshots (under redesign) — see Plan 2.
- Cross-browser. Chromium only for v1.
- Tauri shell — see Plan 3 for the separate `tauri-driver` suite.

## Project-level conventions

- Whenever a feature exists in both the VS Code extension and this app, mirror the extension's conventions. (See `~/.claude/projects/-Users-ryderwishart-prototypes-codex-web-app/memory/MEMORY.md`.)
- GitLab sync is transitional (legacy compat only). Don't build on top of it.
- The sync stack is event-sourced to D1: the client enqueues events in an IndexedDB outbox and flushes them asynchronously via `POST /events` (HTTP) with a per-file JWT. The sync-worker writes each event to the D1 event log and projects it into the `cells`/`files` tables. A per-project `ProjectSync` Durable Object (one instance per project) handles presence, focus-lock leases, and real-time broadcast relay — it holds no durable state (no D1/R2 writes from inside the DO). R2 stores media blobs (audio recordings, generated voice) only. Identity/permissions live in `frontier-server` (sibling repo at `~/frontierrnd/frontier-server`).

## Local dev — auth bypass

`pnpm dev` boots the identity worker with `WRANGLER_LOCAL=1`, which unlocks two routes on `auth-worker`:

- `POST /__dev__/seed` — idempotent upsert of user `dev` / org `Dev Org` / project `dev-project` (dev user is OWNER of both).
- `POST /__dev__/login` — runs seed, returns `{ access_token, username: "dev", user, org, project }`. Use this to sign in without typing a password.

The SignIn step renders a **"Dev login (skip auth)"** button when `import.meta.env.DEV` — clicking it calls `/__dev__/login` and stores the session like a real login. From Playwright, hit the endpoint directly (no need for `/__test__/reset` if your test only needs one user).

Both routes 404 unless `WRANGLER_LOCAL=1`. Prod `wrangler.toml` never sets it; the bypass also resolves to a hardcoded username, so the blast radius if it ever leaked is "log in as a user that doesn't exist in prod D1." See [auth-worker/src/routes/dev-seed.ts](auth-worker/src/routes/dev-seed.ts).

For the E2E suite, prefer the existing `/__test__/reset` + alice/bob/carol helpers (`e2e/helpers/seed.ts`) — those give clean isolation per test. The `/__dev__/login` bypass is for manual browser dev and ad-hoc Playwright probes.

## Useful slash commands

- `/e2e-add` — scaffold a new E2E spec from template (see `.claude/commands/e2e-add.md`).
