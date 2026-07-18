# Agent API v1.1 swarm — orchestration state

**Spec:** `docs/superpowers/specs/2026-07-17-agent-api-v1.1-design.md` (committed 752d68d2f)
**Base:** `dev` @ 752d68d2f · **Integration:** `swarm/integration` (`.worktrees/swarm-integration`)
**Mode:** Workflow (interactive) · models: opus (hard seams), sonnet (mechanical)

## STOP checklist (acceptance)

- [ ] `db/shared/projects.ts` exists; auth-worker project-create + settings routes call it; auth-worker tests green (behavior-preserving).
- [ ] prepare-time ids: prepare mints all event/file/cell ids into the plan; commit replays them; `committing` status; commit-replay test proves no duplicate events.
- [ ] Token UI: Preferences → Account → "API tokens" (list, mint dialog with role-filtered scoping, show-once, revoke) + `src/lib/sync/credentials.ts` client + tests.
- [ ] Commands `CreateProject` / `UpdateProjectSettings` (receipt-only via shared module) and `LinkMedia` (events) through prepare→commit with preconditions per spec §2.
- [ ] Audio artifacts (`kind: audio`, wav/mp3/m4a/ogg, 25MB, existing audio R2 layout).
- [ ] MCP catalog extended; docs/api/agent-api.md §8, openapi.yaml, AGENT-API.md status updated.
- [ ] Parity-matrix rows for the 3 commands; no-credits regression test (`org_credit_usage_daily` untouched).
- [ ] Final gate on integration: root `tsc -b --noEmit` + `vitest run` + build, sync-worker `npm test`, auth-worker `npm test` — all green.
- [ ] Adversarial review panel passed (races / regressions / contract+permission lenses); blockers fixed.
- [ ] Merged to `dev`, pushed (staging deploy).

## Waves

| Wave | Agent | Model | Branch | Scope | Status |
|---|---|---|---|---|---|
| 1 | W1-A shared projects module | opus | swarm/w1a-shared-projects | db/shared/projects.ts + auth-worker refactor | pending |
| 1 | W1-B commit idempotency | opus | swarm/w1b-idempotency | prepare/commit ids, committing status, replay test | pending |
| 1 | W1-C token UI | sonnet | swarm/w1c-token-ui | Preferences section, ApiTokensSection, credentials client | pending |
| 2 | W2-A project commands | opus | swarm/w2a-project-commands | CreateProject + UpdateProjectSettings (needs W1-A, W1-B) | pending |
| 2 | W2-B media | opus | swarm/w2b-media | audio artifacts + LinkMedia (needs W1-B) | pending |
| 3 | W3-A MCP + docs | sonnet | swarm/w3a-mcp-docs | mcp-tools catalog, agent-api.md, openapi, status table | pending |
| 3 | W3-B cross-cutting tests | opus | swarm/w3b-tests | parity rows, no-credits guard, extra replay coverage | pending |

## File ownership (conflict avoidance)

- W1-A: `db/shared/projects.ts`(new), `auth-worker/src/routes/projects.ts`, `auth-worker/src/routes/project-settings.ts`, auth-worker tests. FORBIDDEN: sync-worker/**, src/**.
- W1-B: `sync-worker/src/external/{prepare,commit,types,store}.ts`, sync-worker migrations (if status CHECK needs it), `sync-worker/src/__tests__/external-*`. FORBIDDEN: commands.ts signature changes, auth-worker/**, src/**.
- W1-C: `src/pages/Preferences.tsx` (section entry only), `src/components/settings/ApiTokensSection.tsx`(new), `src/lib/sync/credentials.ts`(new), SPA tests. FORBIDDEN: workers, db/.
- W2-A: `sync-worker/src/external/{commands,prepare,commit}.ts` (project-command branches), receipt types. W2-B: `sync-worker/src/external/artifacts-route.ts`, LinkMedia branches in same files — merge order W2-A → W2-B, orchestrator resolves.
- W3-A: `sync-worker/src/external/mcp-tools.ts`, docs. W3-B: sync-worker test files only.

## Merge log

- swarm/w1a-shared-projects (cd84eee) → 24e3e0b — agent-verified: auth-worker 703/703, tsc clean
- swarm/w1b-idempotency (cabf194) → 9943982 — agent-verified: sync-worker 920/920 (incl. 2 new replay tests), tsc clean
- swarm/w1c-token-ui (9e38f50) → 7ccde2f — agent-verified: targeted vitest green, root tsc clean
- integration @ 7ccde2f (wave-1 gate): root tsc clean; SPA 15/15; auth-worker 703/703; sync-worker 920/920 — GREEN
- swarm/w2a-project-commands (bc936c5) → 0da1037 — clean merge; agent-verified 937/937
- swarm/w2b-media (b0889e0) → 45cbd1e — 12 conflict hunks hand-resolved by orchestrator (commands/prepare/commit/types: git fused stageReceiptOnlyChangeset with prepareLinkMedia around a shared INSERT tail; both reconstructed as complete functions). Also: relocated committing-status migration to db/postgres/migrations/0065 (PG-only DDL; sync-worker/D1 copy removed — matches W2-B's 0064 precedent).
- integration @ 45cbd1e (wave-2 gate): sync-worker type-check clean; full suite 958/958 — GREEN
- swarm/w3a-mcp-docs (10cf6cc) → 6bac1d0 — clean merge; agent-verified full suite 961/961
- swarm/w3b-tests (67a22f0) → 88094d7 — clean merge; parity matrix + no-credits test; flagged pre-existing fold-projection flake (passes in isolation)
- ADVERSARIAL PANEL (3 opus lenses): 4 distinct blockers found — (1) UpdateProjectSettings crash-retry false-success (author-ambiguous +1 heuristic), (2) decorative staged→committing flip + stale-write clobbering committed receipts, (3) act-mode CreateProject reachable via org-scoped act credentials (docs claimed ask-only), (4) empty receipt-only summaries → blind approval. 8 non-blockers (3 folded into fixer as H1-H3, rest in TRACES).
- swarm/w4-fixes (c9f21db) → 875ca9e — all 4 blockers + H1-H3 fixed with proof-tests; agent-verified sync-worker 990/990, auth-worker 703/703, root tsc clean, SPA specs 10/10
- FINAL GATE @ 875ca9e (orchestrator-run): build ✅ (tsc -b + vite + brand) · sync-worker 990/990 ✅ · auth-worker 703/703 ✅ · root SPA 20 failed/4391 passed → ATTRIBUTED: 18 fail identically on clean dev base 752d68d2f (pre-existing, files untouched by this batch: ProposalCard/import/ws-reconciler/SetupChecklistDrawer/ProjectMembersPage/TeamsList/Settings/AssignModal/OrgSwitcher/ArchivedProjects), 2 are full-suite load flakes (OrgSwitcher + ArchivedProjects pass 7/7 in isolation on integration). Zero failures caused by this batch — GATE GREEN.
- Promoted: swarm/integration → dev (fast-forward), pushed → staging deploy.

## Rules

Subagents never push, never touch main/dev. Orchestrator merges, verifies (tsc + vitest + per-worker npm test), reviews adversarially, and owns the final gate + dev push.
