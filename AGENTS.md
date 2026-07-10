# AGENTS.md

Rules for any AI coding assistant working in this repo (Claude Code, Cursor, Copilot, Aider, etc.).

## CI — deploy build is the gating check

**`npm run build` (i.e. `tsc -b && vite build`) is the CI gate, not `tsc --noEmit`.** Do not revert the CI workflow to `--noEmit` — it misses project-reference / `erasableSyntaxOnly` errors that only `tsc -b` catches (see FRO-213 / FRO-219).

## Testing — non-negotiable

Before claiming any feature is complete:

1. **Run the smoke suite.** `npm run test:e2e:smoke` must pass. The pre-push hook enforces this; do not bypass with `--no-verify` unless explicitly told to.
2. **If your change touches a journey listed in `e2e/JOURNEYS.md`, extend the matching spec OR add a new spec under `e2e/specs/<area>/`.**
3. **New user-facing journey = new row in `e2e/JOURNEYS.md` AND a new spec.**
4. **Changed behavior means changed tests.** If a feature, UI flow, label, role, selector, route, validation rule, or loading state changes, update the existing smoke spec/page object in the same change. A stale smoke test is a product bug, not something to ignore.
5. **Do not leave smoke specs testing removed UI.** If the old journey no longer exists, rewrite the spec around the replacement journey or remove it only when `e2e/JOURNEYS.md` is updated to say the journey was intentionally retired.
6. **Reuse helpers** in `e2e/helpers/page-objects/`. Do not duplicate selectors. If no page object fits, add one or update the existing one as part of the feature.
7. Tests run against **local `wrangler dev` instances** of `auth-worker` and `sync-worker`, backed by a Docker-managed local Postgres (container `aquilla-dev-pg`). See `e2e/README.md` for setup.

Smoke tests are production guardrails. Shipping a UI or workflow change with knowingly stale smoke specs is incomplete work, even when the app appears to work manually.

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
- The sync stack is event-sourced to Postgres (Neon via Hyperdrive): the client enqueues events in an IndexedDB outbox and flushes them asynchronously via `POST /events` (HTTP) with a per-file JWT. The sync-worker (`sync-worker/`) writes each event to the Postgres event log and projects it into the `cells`/`files` tables. A per-project `ProjectSync` Durable Object (one instance per project) handles presence, focus-lock leases, and real-time broadcast relay — it holds no durable state (no Postgres/R2 writes from inside the DO). R2 stores media blobs (audio recordings, generated voice) only. Identity/permissions live in the in-repo `auth-worker/` (Hono, `aquilla-identity` worker, Neon Postgres). `frontier-server` is retired — do not reference it.

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

Both routes 404 unless `WRANGLER_LOCAL=1`. Prod `wrangler.toml` never sets it; the bypass also resolves to a hardcoded username, so the blast radius if it ever leaked is "log in as a user that doesn't exist in prod." See [auth-worker/src/routes/dev-seed.ts](auth-worker/src/routes/dev-seed.ts).

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
- add `--deploy` to deploy for dev validation and advance to `Dev Verification Needed` after the fix.

The command (`.claude/commands/issue.md`) enforces the verification gate and the status
rules below.

### The spec is the source of truth

The behavior spec lives in a sibling repo, **`~/frontierrnd/aquilla-specs`**, and is the
source of truth. Linear only tracks the *fix*; the spec records what the system should do.
So every issue carries a spec question:

- **Fix the code first, then reconcile the spec.** While fixing, your view of the correct
  behavior often changes — so the spec edit comes *after* the fix is verified, not before.
- **Document the corrected behavior as a regression guard** in the relevant
  `05-user-stories/<story>.md` (`Acceptance criteria` / `Error / edge cases`) and/or
  `04-features/<feature>.md`. Describe the *rule* ("the create form shows only fields for the
  selected shape"), not the specific code fix. Refactor/consolidate/append as the truth
  demands; bump `last-updated` + add a `revisions:` entry citing the `FRO-###`.
- If no spec change is needed, say so on the issue (cite the section you checked).
- The spec is currently **behind** the prototype (Neon/Hyperdrive backend; timeline- vs
  segment-ordered files). The Linear project *"Bring aquilla-specs into line with prototype
  divergence"* tracks that catch-up — link it if your edit touches a diverged area.

Status pipeline:

| Status | Meaning | Who/when |
| --- | --- | --- |
| **Backlog** | Captured, not yet scoped for work | triage |
| **Todo** | Ready to be picked up by dev/AI | pull from here to start work |
| **Dispatched** | Dev/AI has **begun work** on the task | set when you pick the issue up |
| **Fixed** | Dev/AI has fixed it, **not deployed yet** | set the moment the fix is committed |
| **Dev Verification Needed** | Fix deployed to the **dev branch**, awaiting dev-team validation | set after deploying to dev |
| **Ready for QA** | Functionality is on **staging**; QA can test against it and merge to main | dev→QA hand-off |
| **Deployed** / **Done** | QA validated and **merged the ticket into `main`** | set by QA as part of the merge |
| **Canceled** / **Duplicate** | invalid / superseded | as needed |

Rules:

1. **Pick up work from `Todo`** → assign it to your name and set **`Dispatched`** (work begun).
2. When the fix is committed but not yet deployed → **`Fixed`**.
3. When the fix is deployed to the **dev branch** for dev-team validation → **`Dev Verification Needed`**.
4. Once the functionality is on **staging** and testable → **`Ready for QA`**. This is the
   dev→QA hand-off. **QA owns the merge to `main`** and advances the ticket to
   `Deployed`/`Done` as part of that merge. Don't set `Deployed`/`Done` yourself unless you
   are the one doing the QA merge.
5. **Every commit must carry its `FRO-###`.** Linear auto-suggests a branch name, and the
   `prepare-commit-msg` hook auto-injects the ticket from a `…/fro-###-…` branch (and warns
   when it can't derive one). QA reviews a PR-to-main by scanning which tickets its commits
   reference — a ticketless `fix`/`feat` commit is invisible to that process.
   `chore`/`docs`/`polish` commits may go ticketless.
6. **Prototyping fast-path:** while prototyping we sometimes merge straight to `main` with
   `--no-verify`, skipping the staging/QA gates. Allowed — but the commit **still needs its
   `FRO-###`** so the ticket stays traceable to the merge.

### One ticket = one branch = one worktree

The failure mode to avoid: agents pile unrelated work onto whatever branch is checked
out, so a branch named for FRO-A ends up holding FRO-B commits **and** a junk drawer of
uncommitted changes spanning five concerns. That destroys the QA PR→ticket mapping and
makes the work impossible to review or revert cleanly.

- **Each ticket gets its own git worktree off live `origin/main`**, on the Linear-suggested
  branch (`ryder/fro-###-…`). Never share the main checkout between tickets. Use
  `git worktree add` (see `using-git-worktrees`); the main checkout is frequently dirty.
- **Start clean.** Before picking up a ticket, the working tree should be clean (or your
  changes stashed). Don't start FRO-B on top of FRO-A's uncommitted spillover.
- **Don't cross-commit.** A commit's `FRO-###` must match the branch's ticket. The
  `pre-commit` hook **warns** (never blocks) when the branch already holds commits for a
  different ticket — heed it and move the stray work to its own worktree.
- **Untangling after the fact is expensive and lossy** — prevention (isolation at pickup)
  is the whole game.

> **Reconcile drift:** run **`/issue-audit`** to cross-check the board against `main` — it
> flags issues whose code shipped but whose status lagged, `Deployed`/`Done` issues with no
> traceable merge, and commits that landed without a ticket. Read-only; never moves the board.

> **Staging** lives at `https://dev.aquilla.app` (API `api.dev.aquilla.app`), backed by the
> Neon `staging` branch via Hyperdrive. Deploy with `pnpm run deploy:aquilla:staging`. Setup
> + one-time provisioning are in [`docs/STAGING.md`](docs/STAGING.md) (tracked by FRO-146 —
> not fully provisioned until the staging Hyperdrive id is filled in).

## Useful slash commands

- `/e2e-add` — scaffold a new E2E spec from template (see `.claude/commands/e2e-add.md`).
