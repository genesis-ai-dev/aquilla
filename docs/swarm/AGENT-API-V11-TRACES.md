# Agent API v1.1 swarm — open traces

## Review-panel non-blockers NOT covered by the W4 fixer (deferred follow-ups)

- Crash between ask-mode confirmation consume and the committing flip burns the human approval (needs a re-approval; rare, self-healing via a new confirmation).
- LinkMedia copies R2 bytes before posting events — a mid-loop plan_stale leaves orphaned (harmless, unreferenced) bytes under the target file's audio key.
- prepare.ts error-precedence change: body-parse/validation errors now surface before scope errors for doubly-invalid requests (behavior change visible only to clients probing with invalid bodies AND bad scope; documented order now validation-first).
- artifacts list/metadata responses gained an additive `kind` field (backward-compatible; noted for API changelog).
- docs/api/agent-api.md: audio content-type list is verified prose, not an imported constant — export AUDIO_CONTENT_TYPES from artifacts-route.ts someday and reference it.
- fold-projection.test.ts flake under full-suite load (passes in isolation) — pre-existing; investigate PGlite pool/timing isolation separately.

Open TODOs / deferred items discovered during the swarm. Next agent or wave picks these up.

- **[W2-A blocker-grade]** CreateProject command MUST call `createProjectShared(db, { ..., writeCreatorMembership: true })` — the receipt-only apply has no implicit creator-path resolver (auth-worker leaves it off deliberately; see CreateProjectInput JSDoc). Also use the returned `{ inserted }` flag to raise `conflict` on a prepare/commit id race.
- **[W2-A]** Add command-level tests exercising `writeCreatorMembership: true` — auth-worker's suite doesn't cover that path, and db/shared/projects.ts has no direct unit tests.
- **[deploy blocker]** W1-B's `committing` status ALTER lives at `sync-worker/migrations/0064_changeset_committing_status.sql`, but the canonical Postgres migration runner uses `db/postgres/migrations/` (latest 0063). Mirror the ALTER there as the next free number BEFORE any prod deploy. (PGlite tests load schema.sql directly, so suites stay green either way.)
- **[W2-A/W2-B optional]** `changesets-route.ts` discard handler has no `committing` branch — discard mid-commit is a silent no-op. Wave-2 owner of that file may explicitly reject discard on `committing`.
- **[W3-A docs]** Mint endpoint requires a `name` field (UI added a required Name input) — document the payload accordingly in agent-api.md/openapi.
- **[follow-up, non-blocking]** `hints['api-tokens']` entry in PreferencesIndex (e.g. "N active") deliberately skipped to keep the Preferences.tsx diff minimal.
- **[pre-existing, needs own fix session]** Root SPA suite has 18 genuinely failing tests on clean dev @ 752d68d2f (fail even in targeted isolation): ProposalCard(1), import.test(2), import.language(3), ws-reconciler(1), SetupChecklistDrawer(1), ProjectMembersPage(1), TeamsList(4), Settings(3), AssignModal(2) — plus OrgSwitcher/ArchivedProjects flake under full-suite load only. None related to the Agent API batch; logs in the session scratchpad (spa-dev-targeted.log / spa-integration-full.log).
