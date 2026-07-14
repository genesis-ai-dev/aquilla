# Worktree-integration swarm — 2026-07-13

Orchestration state for incorporating stale local worktree branches into `dev`.
Integration branch: `swarm/wt-integration` (worktree `.worktrees/wt-integration`), based on
`origin/dev` @ `4a4a7f2a8`. Orchestrator owns all merges, verification, and the final push to dev.

## STOP criteria (acceptance)

- [ ] swarm/integration (AQU-533 agent-api) merged, gate green
- [ ] bulk-import-outbox rebased + merged, SDBH import routed through outbox
- [ ] ai-phase05-check cherry-picked + merged
- [ ] docx-r2-roundtrip cherry-picked (minus superseded migration 0e2f13b68) + merged
- [ ] FRO-471 remainder re-ported fresh (org invite-preview route, JoinOrgPage preview UX, invite OG image, org-view email invites)
- [ ] magical-kare rebased onto integration tip — HELD for user decision (live aqu-538 overlap); do NOT merge without explicit approval
- [ ] Salvage: codex-rec dirty skill-file diffs reviewed; ai-phase0 SSE re-enable commit reviewed
- [ ] Adversarial review panel passed on the promotion batch
- [ ] Final gate: tsc -b, vitest root, sync-worker + auth-worker tests, build, e2e smoke → push to dev

## Backlog / wave plan

| # | Item | Source ref | Strategy | Model | Status |
|---|------|-----------|----------|-------|--------|
| 1 | agent-api swarm | swarm/integration ed0d51774 | orchestrator merge (clean) | — | merged, gate running |
| 2 | bulk-import-outbox | worktree-feat-optimistic-bulk-import-outbox a433f78bb | rebase onto wt-integration; 5 shallow conflicts; then point src/lib/import-sdbh.ts at enqueueTargetCommits | sonnet | pending |
| 3 | phase05-check | ryder/ai-phase05-check a95acd043 | cherry-pick 2 commits; 1 conflict in ProjectWorkspace.tsx | sonnet | pending |
| 4 | docx-r2-roundtrip | worktree-docx-r2-roundtrip 1b558ef08 | cherry-pick 14 commits (DROP 0e2f13b68 — schema already on dev as db/postgres/migrations/0046); hand-merge exportDocx with dev parity/fidelity logic | opus | pending |
| 5 | FRO-471 remainder | ryder/fro-471-invite-experience… 13deb4401 | re-implement fresh on dev shapes; do NOT merge branch (email core already on dev via 36d316ea1) | opus | pending |
| 6 | magical-kare | claude/magical-kare-a784e0 1e6f8335a | rebase onto wt-integration (11 conflicts: events tables mechanical; EditorTable/ProjectWorkspace/ExportDialog/projects.ts by hand); produce branch, HOLD merge | opus | pending |
| 7 | salvage | codex-rec dirty skills; ai-phase0 10a3a360f SSE | report + optional docs-only commits | sonnet | pending |

## Discards (approved by user in plan)

- migrate/gitlab-groups-admin — superseded by dev 73bf3266a + Neon cutover. Delete branch + worktree ~/prototypes/codex-groups-admin after run.
- rec/org-setup-doc — merged via PR #125. Delete after skill-file salvage (#7).
- ryder/ai-phase0-metering — superseded by credits.ts. Delete after SSE salvage (#7).
- After #1 confirmed on dev: delete all 11 swarm/agent-api-* branches + worktrees (.claude/worktrees/wf_bf7e8d1b-*, .worktrees/w4-fixes, .worktrees/swarm-integration).

## Constraints

- LIVE BRANCH: claude/aqu-538-project-linking-60wmeq (37 commits, 581 files: src/components, src/lib, src/hooks, auth-worker, sync-worker/src/events). magical-kare merge is gated on user decision because of overlap in EditorTable/ProjectWorkspace/ExportDialog/sync-worker events.
- Subagents never push, never touch dev/main. Branches only: wt/<item>-rebased.
- Untracked binaries docs/walkthroughs/org-setup/* in main checkout: belong in aquilla-docs R2 bucket, never git.

## Merge log

- 2026-07-13: swarm/integration (ed0d51774) → swarm/wt-integration. Clean auto-merge.
  Gate GREEN: tsc clean; sync-worker 866/866; auth-worker 662/662; root vitest 21 failures
  in 9 files — verified byte-identical pre-existing on origin/dev 4a4a7f2a8 (baseline
  worktree .worktrees/baseline-dev). Gate criterion for this run: no NEW failures vs that baseline.
  NOTE: worker suites need per-package `npm install` in each worktree (root node_modules
  symlink is not enough — hono/jwt etc. resolve from worker-local deps).
- 2026-07-13: wt/salvage (SSE streaming re-enable) → merged. Gate: tsc + completion tests green.
- 2026-07-13: wt/phase05-check (deterministic check + drawer, 3 commits) → merged. Gate green (103/103 targeted).
- 2026-07-13: wt/bulk-import-outbox (13 commits incl. SDBH follow-up; bulk method re-implemented
  on CellStore) → merged clean. Gate green (90/90 targeted incl. ProjectWorkspace suites).
- 2026-07-13: wt/docx-r2-roundtrip (15 commits, migration dropped) → merged; one import-union
  conflict in bulk-import.ts. Gate green (71/71 targeted).
- 2026-07-13: wt/fro471-remainder (6 commits) → merged clean. Gate green (33/33 targeted +
  auth-worker 671/671).
- HELD: wt/magical-kare-rebased — rebase complete and green (99/99 branch tests, workers green,
  zero new root failures) but NOT merged; awaiting user sequencing decision vs live aqu-538.
- Wave-2 agent followup adopted into backlog: pre-existing red on dev — import.test.ts +
  import.language.test.ts assert one /import POST but bulkUploadSource now sends a trailing
  finalize complete:true POST; fix is to filter to content-bearing uploads (pattern already
  applied in the kare branch's own import tests).

## TRACES (open TODOs for next agent/session)

- import-sdbh.ts must call enqueueTargetCommits after #2 lands (verify in review panel).
- docs/docx-r2-roundtrip-spec branch carries a stale plan copy; superseded by 1b558ef08 revision landing in #4. Delete branch after #4.
- docs/AGENT-API.md gate table is stale (gates 7/8/10 done per w3/w4 commits) — candidate doc fix.
