# SWARM TRACES — AQU-1352

## BLOCKERS
- [OPEN] (atk-1) Create bypass: sub-600 caller could attach a new project to a team they don't lead by bundling it with one they lead (some() vs every()) — auth-worker/src/routes/projects.ts — fixer dispatched
## Deferred
- [OPEN] (atk-2) POLICY: org 500 + team 400 + direct 300 resolves 400 (AQU-1274 lets an explicit direct row restrict the org path). Spec's pure max-over-ancestors would give 500. Pinned it.fails in access-attacks-inheritance.test.ts. Needs Ryder's call + parity audit before flipping.
- [OPEN] Export/egress routes live in sync-worker; not covered by the auth-worker attack suite
- [OPEN] P3 lane permissions — Luke, AQU-1389, PRs #805/#831/#853
- [OPEN] P5 drop mirrored tables; access_grants view → table cutover
- [OPEN] D5 role rename (Manager/Translator) — Ryder decision
- [OPEN] Prod: apply migrations 0130+ — Ryder
## Quality
- [OPEN] (atk-3) Inspector chain labels team-scope grants as direct with empty path — access-payload.ts — fixer dispatched
- [OPEN] (atk-4) People & access leaks team names below roster floor — org-access.ts — fixer dispatched
- [OPEN] Hidden refs keep real ids (names blanked); decide if ids need opaque tokens
- [OPEN] Legacy team members (role_level NULL) keep per-project grants; GitLab import does not yet set team roles, so Tim's team role must be set by hand (TeamDetail) until an import backfill
## [DONE]
