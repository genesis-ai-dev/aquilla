# SWARM ORCHESTRATION — AQU-1352 membership & permissions redesign

Spec: `docs/superpowers/specs/2026-09-21-membership-permissions-redesign.md` · Ticket: AQU-1352
Integration: `swarm/aqu-1352` @ `.worktrees/swarm-1352` (based on origin/dev d65e72ed1)
Ends in: a reviewed PR to `dev`. Never push to `main`. Never apply migrations to prod.

## §0 STOP checklist
- [x] root `tsc -b --noEmit` clean · `pnpm lint` no new errors
- [x] root vitest green (vs baseline) · auth-worker + sync-worker vitest green vs baseline
- [x] `pnpm build` passes
- [x] Characterization suite pins current effective roles; new resolver passes it unchanged
- [x] P0: create form shows org breadcrumb + container picker; Tim scenario creates a project
- [x] P2: team-scope Project Lead can create into their team; teams multi-select persists
- [x] P4: access payload endpoint + member inspector + origin badges + breadcrumb helper wired
- [x] Break-it suite: deterministic HTTP attack suite in CI (both resolver modes) + live-stack browser probe; findings fixed or traced
- [x] Adversarial review panel: no open blockers
- [x] Every known gap traced in TRACES

## Baseline (origin/dev d65e72ed1, 2026-09-28)
- root tsc: clean · auth-worker tsc: clean
- auth-worker vitest: 5 failed / 2259 passed (all pre-existing, unrelated):
  billing-chat-usage, billing-usage-reconcile, billing-workspace-usage ×2, login-enumeration timing
- sync-worker vitest: 7 failed / 2791 passed (39 min). Pre-existing: derive-missing-book-rows ×4, export-bundle-route lane, export-route lane, progress-book-audio

## §1 Operating model and decisions
- Decisions used: D1 many-to-many teams; D2 org Member = no access; D3 (Luke's); D4 floors 500 team / 600 org;
  D6 keep rungs. D5 rename NOT applied (Ryder's call).
- DEVIATION from spec §5 P1: `access_grants` ships first as a **Postgres VIEW** over existing tables, not a
  write-through table. 18 files write membership tables; a view gives one read shape with parity by
  construction and zero writer changes. Converting to a real table is a later cutover.
- P1 is **behavior-preserving**: the resolver over the view must reproduce current semantics exactly,
  incl. AQU-1274 `orgPathContribution` and direct-row restriction. Pure max-over-ancestors is a separate,
  flagged policy switch with its own audit.
- Migration numbers reserved for this swarm: 0130–0139 during the build; renumbered to 0117–0119 at PR time (log entries below keep the build-time numbers).
- Forbidden (Luke / AQU-1389 owns): lane permissions — `project_member_lane_roles`, `project_member_scopes`,
  `lane-grants.ts`, `resolveVisibleLanes`, lane read wall, `sync-token-mint.ts` lane claims, PRs #805/#831/#853.
- i18n: add strings to namespaces; orchestrator reconciles `source-hashes.json` via `pnpm i18n:check` at merge.

## §2 Waves
- W1 (2026-09-28, workflow wf_e8e4233e-75a): grants-view, characterization, create-targets, access-ui
- W2 (2026-09-28, wf_4bed448f-c46): resolver-swap (ACCESS_GRANTS_RESOLVER off|shadow|on, fallback to legacy on view error), teams (0131 group_members.role_level, 0132 view v2 security_invoker + team rows, PATCH team role, create teamIds, teams multi-select), access-api (GET users/:id/access + inspector popover on rosters); plus 3-lens review panel on W1 diff
- W3 (2026-09-28): fix-create, fix-access-ui, roster-wiring, denials-crumbs, people-page. W4: jev break-it suite + final review panel. Was planned: badges/read-only inherited rows/remove dialog/denial copy, jev adversarial suite, review panel
## §3 Workstreams
| ID | Title | Status |
|---|---|---|
| grants-view | 0130 view + pure resolver | W1 running |
| characterization | pinned role matrix | W1 running |
| create-targets | P0 picker + me/create-targets | W1 running |
| access-ui | types, breadcrumb, badges, inspector UI | W1 running |
## §4 Merge log
- 2026-09-28 · W4 attack-suite (4 findings), cleanup, attack-fixes (3 fixed, 1 deferred policy) · final review panel (1 blocker + 1 major + 5 minor) → final-fixes · merged origin/dev (17 commits) · migrations renumbered 0117-0119 · live-stack probe found + fixed 2 more (People & access duplicate grantee; shared legacy org labelled Personal)
- FINAL GATE (pre-probe tip 2433cdd2b): tsc 0 · auth tsc 0 · sync tsc 24 = baseline · build ok · lint 0 errors · auth 4 billing baseline (+1 admin-elevation load flake, passes alone ×2 and on dev) · root 8 fail all baseline · sync 6 fail all baseline. Post-probe fixes: tsc 0, affected auth suites 95 pass + 2 expected-fail
- 2026-09-28 · W3 fix-access-ui, fix-create, roster-wiring, denials-crumbs, people-page → 3dffbaf42 · tsc 0 · auth tsc 0 · lint clean · auth 4 fail (billing baseline) · root 8 fail, all baseline · conflicts: org.ts i18n union + one duplicate context entry
- 2026-09-28 · W2 resolver-swap, teams, access-api → swarm/aqu-1352 · tsc 0 · auth tsc 0 · sync tsc 24 = baseline 24 · lint 0 errors · auth 4 fail (billing baseline) · root 13 fail, all in baseline set · W1 review panel: sql-security 0 findings; create-contract 2 major + 1 minor; spec-ui 1 major + 3 minor → W3 fixers
- 2026-09-28 · W1 grants-view, characterization, create-targets, access-ui → swarm/aqu-1352 a7f5cdde6 · tsc 0 · auth-worker tsc 0 · lint 0 errors · auth vitest 4 fail (billing baseline) · view DDL loads in PGlite for all 210 auth files · root vitest 36 fail vs 14 baseline: +1 ours (i18n duplicate Creator/Direct, fixed c76f6367c by reusing accessModelLegend keys); outbox-flush ×21 + ProjectOverview ×1 are load timeouts, pass in isolation
- Root baseline (2ecb7967f): 14 failed / 14433 passed. Known flaky under full-suite load: outbox-flush, ProjectOverview, AssignedToMe
