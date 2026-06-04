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

## Verifying UI changes — drive the app yourself

Do NOT punt to the user with "on your side: reload and click X." If you have Playwright MCP available (tools named `mcp__plugin_playwright_playwright__*`), drive the app yourself. The seeded dev stack exists specifically to make this loop tight.

Steps:

1. Confirm `pnpm dev` is running (port 5173 reachable). If not, start it in the background.
2. `browser_navigate http://127.0.0.1:5173/__dev/login` — calls the dev bypass, redirects to `/project/dev-project`. You are now logged in as user `dev` with OWNER on `Dev Org` and `dev-project`.
3. Navigate to the surface your change touches, interact with it, then `browser_snapshot` / `browser_take_screenshot` to confirm.

Only escalate to the human when:
- the change depends on real-data shapes the seed doesn't produce (large multi-file projects, specific cell/event histories),
- the bug only reproduces in their existing IDB state,
- the change is a multi-window/multi-user collab scenario (use the e2e harness instead — see `e2e/README.md`).

For the broader discipline, see the `verify` and `superpowers:verification-before-completion` skills. Project-specific glue lives in the `verify-dev-change` skill.

## Local dev — auth bypass

`pnpm dev` boots the identity worker with `WRANGLER_LOCAL=1`, which unlocks two routes on `auth-worker`:

- `POST /__dev__/seed` — idempotent upsert of user `dev` / org `Dev Org` / project `dev-project` (dev user is OWNER of both).
- `POST /__dev__/login` — runs seed, returns `{ access_token, username: "dev", user, org, project }`. Use this to sign in without typing a password.

The SignIn step renders a **"Dev login (skip auth)"** button when `import.meta.env.DEV` — clicking it calls `/__dev__/login` and stores the session like a real login. For agents driving the app via Playwright MCP, prefer the auto-login URL **`http://127.0.0.1:5173/__dev/login`** — it logs in and redirects to `/project/dev-project` in one navigate.

Both routes 404 unless `WRANGLER_LOCAL=1`. Prod `wrangler.toml` never sets it; the bypass also resolves to a hardcoded username, so the blast radius if it ever leaked is "log in as a user that doesn't exist in prod D1." See [auth-worker/src/routes/dev-seed.ts](auth-worker/src/routes/dev-seed.ts).

For the E2E suite, prefer the existing `/__test__/reset` + alice/bob/carol helpers (`e2e/helpers/seed.ts`) — those give clean isolation per test. The `/__dev__/login` bypass is for manual browser dev and ad-hoc Playwright probes.

## Issue workflow (Linear — FrontierR&D team)

Bugs and tasks live in Linear (team `FrontierR&D`, key `FRO`). Move issues through the
status pipeline as work progresses — keep the board honest so anyone (human or agent)
can see exactly where each issue stands.

**Use the `/issue` slash command to drive this.** Whenever you're debugging, improving,
validating, or QA-testing in this repo, run it instead of touching the board by hand —
it resolves the issue's current status and does the next right transition:

- `/issue next` — pick up the top `Todo` and start working it.
- `/issue FRO-123` — act on a specific issue from wherever it currently sits.
- `/issue debug "thing is broken"` — file a new bug, then start it.
- `/issue improve "make X nicer"` — file a new improvement, then start it.
- add `--deploy` to push to staging and advance to `Ready for Review` after the fix.

The command (`.claude/commands/issue.md`) enforces the verification gate and the status
rules below.

Status pipeline:

| Status | Meaning | Who/when |
| --- | --- | --- |
| **Backlog** | Captured, not yet scoped for work | triage |
| **Todo** | Ready to be picked up by dev/AI | pull from here to start work |
| **Fixed** | Dev/AI has fixed it, **not deployed yet** | set the moment the fix is committed/merged |
| **Ready for Review** | Fix deployed to **staging**, awaiting dev-team validation | set after pushing to the staging subdomain |
| **Ready for QA** | Dev validated on staging; QA can review | **terminal status for now** — stop here |
| ~~Done~~ / ~~Deployed~~ | post-QA states | **not used yet** — no QA process running |
| **Canceled** / **Duplicate** | invalid / superseded | as needed |

Rules:

1. **Pick up work from `Todo`.** Move the issue to your name and start it.
2. When the fix is done but not yet on staging → **`Fixed`**.
3. When the fix is deployed to the **staging subdomain** → **`Ready for Review`**.
4. Once validated on staging → **`Ready for QA`**. This is the **terminal status** until a QA
   process exists — do **not** move issues to `Done`/`Deployed`.
5. Reference the `FRO-###` identifier in commits/branches (Linear auto-suggests a branch name).

> **TODO (infra):** stand up a dedicated **staging subdomain** for the prototype so the
> `Ready for Review` → `Ready for QA` steps have a real deploy target. Until it exists,
> note in the issue where the fix was verified.

## Useful slash commands

- `/e2e-add` — scaffold a new E2E spec from template (see `.claude/commands/e2e-add.md`).
