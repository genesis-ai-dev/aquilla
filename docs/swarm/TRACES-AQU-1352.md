# SWARM TRACES — AQU-1352

## BLOCKERS
- [DONE 4e52bb81c] (fr-1) getOrCreateUserOrg + me.ts personal lookup require billing_scope='personal'; legacy personal orgs are NULL (0092 no backfill) → duplicate workspace. Fixer dispatched
- [DONE 5bdc2f822] (fr-2) GET /projects/:id/members ?minRole path leaks team/org names via roster origins. Fixer dispatched
- [DONE d3c9e1960] (atk-1) Create bypass: sub-600 caller could attach a new project to a team they don't lead by bundling it with one they lead (some() vs every()) — auth-worker/src/routes/projects.ts — fixer dispatched
## Deferred
- [OPEN] (atk-2) POLICY: org 500 + team 400 + direct 300 resolves 400 (AQU-1274 lets an explicit direct row restrict the org path). Spec's pure max-over-ancestors would give 500. Pinned it.fails in access-attacks-inheritance.test.ts. Needs Ryder's call + parity audit before flipping.
- [OPEN] Export/egress routes live in sync-worker; not covered by the auth-worker attack suite
- [OPEN] P3 lane permissions — Luke, AQU-1389, PRs #805/#831/#853
- [OPEN] P5 drop mirrored tables; access_grants view → table cutover
- [OPEN] D5 role rename (Manager/Translator) — Ryder decision
- [OPEN] Prod: apply migrations 0117–0119 — Ryder
## Quality
- [DONE 9442a27ee bec081c5e 03303d5c1] (fr-3..5) team-only PATCH peer demotion; org-access 404/403 enumeration; OrgAccessPage stale data on org switch. Fixer dispatched
- [OPEN] Shadow mode doubles role-lookup queries in dev/local (acceptable for a time-boxed shadow period)
- [OPEN] Preview stacks share dev Hyperdrive without the neon:status gate: apply 0117-0119 to dev Neon before preview QA, or team routes 500 on missing group_members.role_level
- [DONE] Renumbered 0130-0132 → 0117-0119 after merging dev (which reached 0116)
- [OPEN] People & access: viewer below roster floor sees org name in tree[0] but hidden org crumb in people[].grants (safe, inconsistent)
- [DONE d3c9e1960] (atk-3) Inspector chain labels team-scope grants as direct with empty path — access-payload.ts — fixer dispatched
- [DONE d3c9e1960] (atk-4) People & access leaks team names below roster floor — org-access.ts — fixer dispatched
- [OPEN] Hidden refs keep real ids (names blanked); decide if ids need opaque tokens
- [OPEN] Legacy team members (role_level NULL) keep per-project grants; GitLab import does not yet set team roles, so Tim's team role must be set by hand (TeamDetail) until an import backfill
## [DONE]
- [DONE cd4a6a02a] People & access tree listed a creator twice per project (live probe)
- [DONE 9a857dead] create-targets labelled a shared legacy org Personal (live probe)
- [NOTE] Local shared dev DB aquilla_dev predates dev's cells.lane_id NOT NULL; dev-stack reconcile fails there (unrelated to this branch). Probe ran on a throwaway DB. Migrations 0117-0119 were applied by hand to aquilla_dev (additive).
