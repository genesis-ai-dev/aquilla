# SWARM ORCHESTRATION — AQU-1352 membership & permissions redesign

Spec: `docs/superpowers/specs/2026-09-21-membership-permissions-redesign.md` · Ticket: AQU-1352
Integration: `swarm/aqu-1352` @ `.worktrees/swarm-1352` (based on origin/dev d65e72ed1)
Ends in: a reviewed PR to `dev`. Never push to `main`. Never apply migrations to prod.

## §0 STOP checklist
- [ ] root `tsc -b --noEmit` clean · `pnpm lint` no new errors
- [ ] root vitest green (vs baseline) · auth-worker + sync-worker vitest green vs baseline
- [ ] `pnpm build` passes
- [ ] Characterization suite pins current effective roles; new resolver passes it unchanged
- [ ] P0: create form shows org breadcrumb + container picker; Tim scenario creates a project
- [ ] P2: team-scope Project Lead can create into their team; teams multi-select persists
- [ ] P4: access payload endpoint + member inspector + origin badges + breadcrumb helper wired
- [ ] Jev adversarial suite written and run against local dev stack; findings logged
- [ ] Adversarial review panel: no open blockers
- [ ] Every known gap traced in TRACES

## Baseline (origin/dev d65e72ed1, 2026-09-28)
- root tsc: clean · auth-worker tsc: clean
- auth-worker vitest: 5 failed / 2259 passed (all pre-existing, unrelated):
  billing-chat-usage, billing-usage-reconcile, billing-workspace-usage ×2, login-enumeration timing
- sync-worker vitest: (pending) — memory says 2 unit tests red on dev

## §1 Operating model and decisions
- Decisions used: D1 many-to-many teams; D2 org Member = no access; D3 (Luke's); D4 floors 500 team / 600 org;
  D6 keep rungs. D5 rename NOT applied (Ryder's call).
- DEVIATION from spec §5 P1: `access_grants` ships first as a **Postgres VIEW** over existing tables, not a
  write-through table. 18 files write membership tables; a view gives one read shape with parity by
  construction and zero writer changes. Converting to a real table is a later cutover.
- P1 is **behavior-preserving**: the resolver over the view must reproduce current semantics exactly,
  incl. AQU-1274 `orgPathContribution` and direct-row restriction. Pure max-over-ancestors is a separate,
  flagged policy switch with its own audit.
- Migration numbers reserved for this swarm: 0130–0139 (dev had 4 renumber collisions this week).
- Forbidden (Luke / AQU-1389 owns): lane permissions — `project_member_lane_roles`, `project_member_scopes`,
  `lane-grants.ts`, `resolveVisibleLanes`, lane read wall, `sync-token-mint.ts` lane claims, PRs #805/#831/#853.
- i18n: add strings to namespaces; orchestrator reconciles `source-hashes.json` via `pnpm i18n:check` at merge.

## §2 Waves
- W1 (2026-09-28, workflow wf_e8e4233e-75a): grants-view, characterization, create-targets, access-ui
- W2 (planned): resolver swap behind flag (reruns characterization matrix), teams-as-containers + teamIds create, access payload endpoint + inspector wiring
- W3 (planned): badges/read-only inherited rows/remove dialog/denial copy, jev adversarial suite, review panel
## §3 Workstreams
| ID | Title | Status |
|---|---|---|
| grants-view | 0130 view + pure resolver | W1 running |
| characterization | pinned role matrix | W1 running |
| create-targets | P0 picker + me/create-targets | W1 running |
| access-ui | types, breadcrumb, badges, inspector UI | W1 running |
## §4 Merge log
