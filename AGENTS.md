# AGENTS.md

Rules for any AI coding assistant working in this repo (Claude Code, Cursor, Copilot, Aider, etc.).

## Testing — non-negotiable

Before claiming any feature is complete:

1. **Run the smoke suite.** `npm run test:e2e:smoke` must pass. The pre-push hook enforces this; do not bypass with `--no-verify` unless explicitly told to.
2. **If your change touches a journey listed in `e2e/JOURNEYS.md`, extend the matching spec OR add a new spec under `e2e/specs/<area>/`.**
3. **New user-facing journey = new row in `e2e/JOURNEYS.md` AND a new spec.**
4. **Reuse helpers** in `e2e/helpers/page-objects/`. Do not duplicate selectors. If no page object fits, add one.
5. Tests run against **in-repo `wrangler dev` instances** of `codex-auth-worker` + `aquilla-sync-worker` against a local D1 (schemas vendored under `e2e/sql/`). No external repo checkout required. See `e2e/README.md` for setup.

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
- The sync stack is y-partyserver on Cloudflare Durable Objects + R2 (`sync-worker/`). Identity, orgs, members, project rows, and invites are owned by `codex-auth-worker/` in this repo (shared `frontier-db-v2` D1 with the legacy frontier-server, but codex-web's runtime no longer calls frontier-server).

## Useful slash commands

- `/e2e-add` — scaffold a new E2E spec from template (see `.claude/commands/e2e-add.md`).
