# Testing the Agent API (AQU-533) — where it actually lives, and how to try it

Status: 2026-07-13. Written against `swarm/integration` at commit range through the
W4 fix pass. **Correction to a prior assumption in this session: none of this is on
`dev` or `main` yet.** It lives entirely on the `swarm/integration` branch, checked
out in the worktree at `.worktrees/swarm-integration/` off the main repo root. `dev`
and `main` are untouched by this work and have continued to move independently
(most recently: a real fix for the invites still-member bug landed on `dev` via
cherry-pick `e21f25659`, and `main` picked up an unrelated `0054` migration — see
"Before merging to dev" below).

## 1. Fastest path: run the test suites (no server needed)

Everything below is already proven by the swarm's own tests — this is the quickest
way to see the behavior without standing up a stack.

```bash
cd .worktrees/swarm-integration/sync-worker
npm test
```

866 tests, including the ones that show the actual design decisions in action:

- `src/__tests__/external-changesets.test.ts` — prepare → summary → digest → commit;
  ask-mode confirmation required/consumed-once; `plan_stale` on precondition drift
- `src/__tests__/external-permission-parity.test.ts` — the role×operation matrix
  (gate G7); this is the one that caught the prepare membership-gate bug (now fixed)
- `src/__tests__/external-coldstart.test.ts` — the gate-10 simulation: a fake "stranger's
  agent" that only knows what `tools/list` tells it, doing a full act-mode and
  ask-mode journey through the MCP server
- `src/__tests__/external-mcp.test.ts` — the 11 MCP tools directly
- `src/__tests__/external-import.test.ts` — artifact upload + `PlanImport`
- `src/__tests__/external-reads.test.ts` — search/read/history

Also: `cd .worktrees/swarm-integration/auth-worker && npm test` for credentials +
the approval-assertion endpoints (`src/__tests__/credentials.test.ts`,
`src/__tests__/changeset-approvals.test.ts`).

Reading `external-coldstart.test.ts` top to bottom is the single best way to see
the whole design working end to end without running anything live.

## 2. Running it live, locally

The worktree needs its own `.env`/local secrets the same as the main tree, plus
node_modules are symlinked to the root repo's install (already done in
`.worktrees/swarm-integration`). To bring the stack up pointed at this branch:

```bash
cd .worktrees/swarm-integration
pnpm dev          # full local stack: SPA + auth-worker + sync-worker
```

This runs the **local dev D1/Hyperdrive-shimmed Postgres**, not a shared/staging
database — safe to experiment in. If migrations 0054–0056 (see below) haven't been
applied to your local Postgres yet, apply them the way this repo always does:

```bash
npx tsx scripts/pg.ts db/postgres/schema.sql   # full schema (includes the new tables)
# or, incrementally:
npx tsx scripts/pg.ts db/postgres/migrations/0054_api_credentials.sql
npx tsx scripts/pg.ts db/postgres/migrations/0055_changesets.sql
npx tsx scripts/pg.ts db/postgres/migrations/0056_artifacts.sql
```

### 2a. Mint a credential

You need an existing Aquilla user session (log in via the SPA normally first, or use
whatever seed user your local stack has), then:

```bash
curl -s -X POST http://127.0.0.1:8788/api/v2/credentials \
  -H "Authorization: Bearer $SESSION_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my test agent",
    "mode": "act",
    "projectId": "<a project you are PROJECT_LEAD or higher on>"
  }'
```

Response includes the plaintext token **once** — starts with `aqk_`. Save it; it's
only ever shown here (hashed at rest after this).

Port note: `8788` is auth-worker's local dev port per this repo's existing
`.env.example` conventions — confirm against your actual `pnpm dev` output, since
local ports are configurable.

### 2b. Point an MCP client at it

The MCP endpoint is `POST /api/v1/external/mcp` on the **sync-worker** host (not
auth-worker — credentials are minted on auth-worker, but changesets/reads/MCP all
live on sync-worker). Add it to Claude Code or another MCP client:

```json
{
  "mcpServers": {
    "aquilla": {
      "url": "http://127.0.0.1:8787/api/v1/external/mcp",
      "headers": { "Authorization": "Bearer aqk_..." }
    }
  }
}
```

(Sync-worker's local port similarly — check your `pnpm dev` output; SYNC.md /
`.env.example` reference `8787`/`8789` inconsistently across files, worth confirming
once rather than guessing.)

From there: `get_capabilities` and `get_identity_and_scope` are the two calls that
prove the connection works and show you exactly what the credential can do. Then
`list_projects` → `read_content` → `prepare_translations` → `confirm_changeset` is
the golden path, narrated in `docs/api/examples/blackfoot-import.md`.

### 2c. Or drive it over raw REST

`docs/api/examples/blackfoot-import.md` has the full curl sequence: mint → upload a
USFM artifact → inspect → `PlanImport` prepare → commit → read cells back — and the
same flow again with an ask-mode credential to see the `confirmation_required`
response and the `/approve/:changesetId` page.

### 2d. See the ask-mode approval page

With an **ask-mode** credential, `prepare_translations`/`confirm_changeset` returns
an `approvalUrl`. Open it in the SPA (it's a real route, `/approve/:changesetId`,
added to `src/App.tsx`) while logged in as the credential's owning user — you'll see
the server-computed summary (never agent-narrated) and Approve/Reject buttons. This
is the actual enforcement point: the credential literally cannot commit without this
page's approval being exercised first.

## 3. What to poke at (things worth deliberately trying to break)

- **Confirm an ask-mode changeset without visiting the approval page** — must get
  `confirmation_required`, never a silent success.
- **Reuse a confirmation twice** — second commit must not double-apply (it's
  consumed exactly once).
- **Edit a cell through the normal app UI between `prepare` and `confirm`** — the
  changeset should come back `plan_stale` (409) on commit, not silently apply against
  stale state.
- **Use a credential scoped to project A against project B** — `scope_denied`.
- **Use a credential from a non-member (or a role below the command's floor)** —
  should be denied at `prepare` time now (this was the gate-7 bug the swarm's own
  parity tests caught and W4 fixed — worth specifically re-verifying by hand).
- **Look at the `events.provenance` column** on any event landed via this path — it
  should show `origin: "agent"`, the human's `user_id`, the `credential_id`, and
  `channel` correctly distinguishing `"mcp"` vs `"rest"` depending on how you drove it.

## 4. Known gaps (don't be surprised by these — they're deliberate v1 scope cuts)

From `docs/swarm/AGENT-API-TRACES.md` and `docs/AGENT-API.md`'s implementation-status
block — read those for the full list. The ones most likely to surprise a hands-on
tester:

- `PlanImport` (file/USFM import) is **REST-only** — no MCP tool for it yet, so an
  MCP-only agent can prepare translations but not run an import; it needs a REST
  escape hatch.
- Import cells arrive **already parsed** — there's no server-side USFM/XLIFF parser
  in this path yet, only lightweight format *detection* on `/inspect`. The agent (or
  you, by hand) has to parse the source file into cells before calling `PlanImport`.
- No rate limiting is enforced despite `rate_limited` being a defined error code.
- No audit ledger for reads/searches yet — only changeset state transitions and the
  event log itself are recorded.
- `list_projects` won't surface a project you can only reach via a group grant (group
  grants still work for permission checks — `get_project` resolves them — they're
  just missing from the discovery listing).

## 5. Before this can merge to dev

Two things, independent of functional readiness:

1. **Migration renumbering.** `dev` currently ends at `0053`. `swarm/integration`
   adds `0054_api_credentials.sql` / `0055_changesets.sql` / `0056_artifacts.sql`
   off that base. Separately, `main` has *also* added its own `0054` (an unrelated
   settings-language migration, not yet merged into `dev`). Whichever of the two
   `0054`s reaches `dev` second must be renumbered before merge — check `dev`'s
   migration tip again at merge time rather than assuming `0053` still holds.
2. **The usual integration → dev promotion gate**: root `tsc -b --noEmit` +
   `vitest run` + `pnpm build`, both workers' full suites, and e2e smoke — none of
   which have been run yet from repo root (only sync-worker/auth-worker package-level
   suites have been verified so far in this swarm).

Nothing here has been pushed anywhere. `swarm/integration` is local-only in this
worktree until you decide to push/PR it.
