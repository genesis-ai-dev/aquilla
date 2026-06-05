# SWARM ORCHESTRATION — Prototype Debugging (2026-06-05)

Driver: user ran `/swarm-orchestration` on Linear project **Prototype Debugging** (FrontierR&D / FRO).
Goal: drain the 5 new **Todo** issues, verified, before handoff to Matthew for QA.

## §0 STOP checklist
- [ ] FRO-158, 159, 160, 161, 162 each Fixed (verified) or honestly blocked with a Linear note.
- [ ] Integration `swarm/protodebug-integration` green: root `tsc -b --noEmit` + `vitest run`; `npm run build`; auth/sync-worker tsc+test if touched.
- [ ] Promoted to main ONLY with forbidden files untouched (see §FORBIDDEN).
- [ ] Backend bugs (158/159) live-verified on staging (`dev` branch deploy) — isolated worktrees can't repro Postgres.
- [ ] Remaining gaps traced in docs/swarm/TRACES.md.

## §FORBIDDEN (user's uncommitted work in main — NEVER touch/stage)
- src/App.tsx (modified)
- src/components/OutboxInspectorPopover.tsx (modified)
- src/components/__DevOutboxHarness.tsx (untracked)

## §1 Operating model
- Integration `swarm/protodebug-integration` (worktree `.worktrees/protodebug-integration`, off main `1ef5b9b`, node_modules + auth/sync-worker node_modules symlinked).
- Each agent → manual worktree off integration tip (sonnet). Commits its branch referencing FRO-###. NEVER pushes/deploys/changes Linear status.
- Merge: branch → integration → verify → log §M. Promote integration → main (ff) only when green AND main clean apart from forbidden files.
- Orchestrator owns final gate + staging push to `dev`.

## §2 Workstream registry
Status: in-flight | review | merged-integration | merged-main | blocked
| WS | FRO | Title | Pri | Branch | Owns | Status |
|---|---|---|---|---|---|---|
| A | 160+161 | Audio progress 0% + overview layout pass | Med | swarm/pd-overview | src/components/org/ProjectOverview.tsx, ProjectCard.tsx, audio-progress data path | in-flight |
| B | 162 | Voice studio tap-to-voice border | Low | swarm/pd-voice | voice-studio / tap-to-voice component | in-flight |
| C | 158 | Org groups 500 post-Postgres | High | swarm/pd-groups | auth-worker/src/routes/orgs.ts, auth-worker/migrations/* | in-flight |
| D | 159 | Stale auth token post-Postgres | High | swarm/pd-token | client token-refresh/session path | in-flight |

## §M Merge log
- 2026-06-05 · A(160+161) · swarm/pd-overview · merged → integration · tsc 0 · vitest green
- 2026-06-05 · B(162) · swarm/pd-voice · merged → integration · tsc 0 · vitest green
- 2026-06-05 · C(158) · swarm/pd-groups · merged → integration · auth-worker tsc 0, 123/123
- 2026-06-05 · D(159) · swarm/pd-token · merged → integration · tsc 0 · vitest green
- 2026-06-05 · absorbed main FRO-163 (b881c14, OutboxInspectorPopover) into integration · tsc 0
- 2026-06-05 · PROMOTED integration → main (ff) @ 715106c · full gate green (root tsc 0, vitest 1534 pass / 2 pre-existing baseline fails, auth-worker 123/123, build exit 0). User's uncommitted ExpandableFileList/LivingMemoryPage/ParallelPassagesPanel preserved.

## §LIVE-VERIFY (needs staging/Neon — orchestrator/user)
- FRO-158: apply `db/postgres/migrations/0028_groups_is_internal.sql` to prod/staging Neon (the actual 500 fix). Code returns the column; column must exist in live schema.
- FRO-160: audio 0% is a DATA gap, not code — code path already correct. Verify `SELECT COUNT(*) FROM cell_audio` on live; if recordings exist but table empty, the `cell.audio.attach` projection didn't run.
- FRO-159: confirm auth-worker returns 401 (not 500) for pre-migration tokens so the new client refresh path triggers; confirm `/` re-auth prompt doesn't loop.
- FRO-162: live screenshot of reduced tap-to-voice border in audio mode.
