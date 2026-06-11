# Audit-fixes swarm — 2026-06-10

Source backlog: `docs/AUDIT-2026-06-10.md` (committed at `cfd4470`). Goal: the audit §4 "Definition of done".

## STOP criteria (acceptance checklist)

- [ ] Zero Critical findings: RACE-1, PERF-1 (via M2-1), RES-3, DEPS-1, TEST-1 resolved and regression-tested.
- [ ] Concurrent-edit regression tests (PGlite, two concurrent commits same project + same cell) pass and fail against pre-fix code.
- [ ] CI authoritative: pnpm + `--frozen-lockfile`; lint + unit + both worker suites on PR **and** push to main; deploys `needs:` CI.
- [ ] Warm reopen of a file = 1 conditional request (ETag/304 or `?since=` delta); window focus does not full re-stream.
- [ ] Forced render error → recovery UI + one `posthog.captureException`; backend 5xx → "can't reach server", not "no projects".
- [ ] `tsconfig.app.json` strict:true, build green.
- [ ] Final gate (orchestrator-run, on integration): `npx tsc -b --noEmit` + `vitest run` + `pnpm build` + both worker test suites green.
- [ ] Adversarial review panel passed (races / regressions / contracts), blockers fixed or reverted.
- [ ] Promote to main (FF or squash), push `dev` for staging deploy.

## Operating model

- Integration branch: `swarm/aud-integration` at `.worktrees/aud-integration`.
- Wave agents work in `.worktrees/aud-<name>` on branch `swarm/aud-<name>`, created off the **live integration tip** (never `isolation: worktree` — stale-base bug).
- Agents never push, never touch main, never run `e2e-up.ts` (force-kills the user's live dev stack on 5173/8787/8788).
- Orchestrator merges (3-way OK), verifies, reviews, promotes, pushes `dev`.

## FORBIDDEN PATHS (user's uncommitted work in main checkout — no agent may edit)

auth-worker/src/middleware/platform-admin.ts · auth-worker/src/routes/admin.ts · auth-worker/src/routes/org-settings.ts · auth-worker/src/routes/orgs.ts · auth-worker/src/routes/projects-invites.ts · auth-worker/src/routes/projects.ts · auth-worker/src/routes/termbase-subscriptions.ts · auth-worker/src/services/org-permissions.ts · auth-worker/src/services/project-permissions.ts · auth-worker/src/types.ts · src/lib/frontier/admin.ts · src/lib/frontier/orgs.ts · src/lib/sync/sync-token.ts · src/pages/AdminConsole.tsx

Consequences: M2-4 (shared data-model pkg) DEFERRED; sync-token timeout DEFERRED.

## Wave 1 (6 agents, disjoint file ownership)

| Agent | Branch | Scope (audit IDs) | Owned files |
|---|---|---|---|
| aud-ci | swarm/aud-ci | QW-1/5/6, M0-1, M0-2, TEST-7, DEVEX-1, DEPS-4(shadcn) | .github/workflows/*, package.json(s), lockfiles, .husky |
| aud-server-seq | swarm/aud-server-seq | M0-4(unit), M1-1, M1-2, QW-10, PERF-5 | sync-worker/src/events/**, db/postgres/schema.sql, sync-worker tests |
| aud-client-write | swarm/aud-client-write | QW-2, M1-3, M1-4, M1-5, M2-5(outbox only) | EditorTable.tsx, ProjectWorkspace.tsx, events-emit.ts, outbox.ts, outbox-flush.ts, useOutboxFlusher.ts |
| aud-error-vis | swarm/aud-error-vis | QW-4/RES-3, M2-3/RES-5 | main.tsx, App.tsx, new ErrorBoundary, posthog.ts, cloud-projects.ts, useProject.ts |
| aud-hygiene | swarm/aud-hygiene | QW-3/7/8/9, DOCS-1/2/3/4, DEVEX-2/3 | tsconfig.app.json, vitest config, AGENTS.md, e2e/README.md, README.md, docs/SYNC.md, wrangler.tomls, cors-proxy/, packages/, zero-byte files |
| aud-do-locks | swarm/aud-do-locks | M1-6(RACE-6 server), RACE-7 | project-do.ts, project-do-handlers.ts, auth-worker/src/routes/invites.ts + tests |

## Wave 2 (after wave-1 merge + green)

aud-delta-read (M2-1, PERF-4, RES-6 cells-read) · aud-batch-perf (M2-2, PERF-8) · aud-lock-client (RACE-5 claim gap, EditorTable) · aud-audio-cache (M2-6) · aud-ui-qa (custom-port dev stack walkthrough).

## Wave 3

Adversarial review panel → fixers → orchestrator final gate → promote main → push dev.

## Merge log

Wave 1 — all 6 branches merged clean into integration (no conflicts), tip `bbf7087`:

- `swarm/aud-ci` `0baa132` — pnpm canonical (`packageManager: pnpm@10.19.0`), npm locks deleted, worker deps self-contained, all 4 workflows on pnpm frozen-lockfile with test gates. Agent-verified: 3× frozen-lockfile installs exit 0, auth 192/192, sync 485/485.
- `swarm/aud-hygiene` `c393f1d..c634cd9` — strict tsconfig, 17 zero-byte files removed, passWithNoTests:false, AGENTS.md/e2e-README/SYNC.md corrected, root README + .env.example, observability blocks. cors-proxy/packages were already absent (no-op). Staging BASE_URL left unchanged (ambiguous — human call).
- `swarm/aud-server-seq` `014d175..6c48ea4` — **RACE-1/RACE-2 fix**: per-project `project_seq_counters` allocator (CTE bump, same tx), `ON CONFLICT (id)` everywhere (8 insert sites incl. snapshots), `chain_claims` atomic AD-2 arbitration + `stale` read-back, deferFileCounters per (file,chunk) (QW-10), single `isChainMutatingKind()` predicate (ARCH-4). TDD: 7 reds against pre-fix code → 10/10 green. **DEPLOY BLOCKER: migration 0034 to live Neon/staging first.**
- `swarm/aud-do-locks` `1eed74b` — RACE-6 multi-tab disconnect (locks survive while user has live connections), RACE-7 invite stamp-before-grant with rowcount check, RACE-5 ack contract documented (already existed via emitTo deny).
- `swarm/aud-client-write` `34499c7` — RACE-3 parentId via pending refs (both call sites), RES-4 enqueue failure reverts optimistic patch + inline error, RES-2 transient 0/5xx don't burn budget + auto-requeue on online/authEpoch, RACE-4 reentrancy guard, 15s timeout on /events POST.
- `swarm/aud-error-vis` `afa3801` — ErrorBoundary + captureException + global error/unhandledrejection hooks + chunk-reload guard (RES-3), unreachable-vs-empty distinction in cloud-projects/useProject/Dashboard/ProjectsList (RES-5).

Wave-1 gate (orchestrator-run): root vitest 2343/2343 · auth-worker 195/195 · sync-worker 499/499 · tsc clean after post-merge stabilization `d72f3d7` (explicit shim type imports in chain-claims/event-insert — ambient sync-worker globals aren't visible to the e2e tsconfig project; isUnreachable added to useProject mocks in LivingMemoryPage/TerminologyPage tests; ReactNode return on ThrowingChild under strict; schema-guard job moved to pnpm).

**Main moved mid-run** (user/PD6 session): merged `main@7b1ed43` into integration at `e765537` — brings platform-admin work (formerly the dirty files), media-lens, and the **Neon schema-migration guard** (`scripts/neon-migrate.ts` ledger + CI schema-guard job). Our migration 0034 fits its convention; `pnpm neon:apply` is the deploy-blocker remedy. Post-merge: root vitest 2347/2347, concurrent-writes 10/10, tsc clean.

**Concurrent session (PD6)** active on FRO-262/263/264 (ProductTour/OrgSidebar/OrgSwitcher/Homepage/TeamDetail/teams.ts/org-permissions.ts) — those files are off-limits to aud-* agents; expect another main merge before promotion. Chrome-profile/dev-port contention: schedule aud UI-QA after PD6's.

Wave 2 dispatched off `d72f3d7`: aud-delta-read (M2-1+PERF-4+RES-6) · aud-batch-perf (M2-2+PERF-8) · aud-lock-client (RACE-5 client, workspace unreachable UI) · aud-audio-cache (M2-6) · aud-lint-green (CI lint gate green). All five merged clean; +0035 watermark index (orchestrator).

**Adversarial panel (4 lenses)**: server-side Critical fix CONFIRMED real (batch() = one tx in prod postgres.js; allocator/claims/rebuild parity traced). 7 blockers → fixer branches:
- aud-fix-client `d4fc9c7..96f48e7`: B1 watermark held at `since` on protected-row discard; B2 torn multi-page snapshot stores no cursor; B3 feature-detected write timeout; N1 4xx burns budget again; N2 chunk-flag re-arm; N3 README claim.
- aud-fix-locks `1faa871`: B4 lock-map aliasing — new Map per WS frame via pure cell-lock-state.ts helpers; reconnect-wipes-lock finding documented (open).
- aud-fix-server `490b8a5,880994e` (agent died at session limit AFTER committing; orchestrator-verified 57/57): B5 rebuilt_seq resync marker + migration 0036 + ETag epoch; B6 snapshot restore claims chain slots.

**Second main merge** (`6a04392` + fix `52a5c36`): main gained the UXA wave (FRO-266/271/273/274/278/279/280/282/295). 15 conflict hunks hand-resolved — ErrorBoundary: main's FRO-266 wins + swarm chunk-guard ported; editor commit: FRO-273 role guard + RACE-5 live re-check + revert-on-failure through FRO-274 writeError; route: FRO-279 validationCount via memoized settings reader; dispatch opts forwarding restored (auto-merge had dropped deferFileCounters/chainGate).

**Final gate (merged tree, `52a5c36`)**: tsc clean · lint 0 errors · root 2540/2540 (296 files) · auth-worker 235/235 · sync-worker 573/573 · `pnpm build` + brand check OK.

**DEPLOY ORDER**: `pnpm neon:apply` (migrations 0034/0035/0036 — idempotent) against the target DB BEFORE deploying sync-worker anywhere (staging branch included; deploy-workers schema-guard only guards main).

## Promotion (2026-06-10 evening)

- Third main merge `6d27c0c` (PD6 promotion: FRO-262/263/264 + ai_drafted + FRO-293 session-expiry) and fourth main merge `5832d9c` (FRO-288 focus-lock hook, FRO-296/297, FRO-290 copy pass, sync-worker test-tsc cleanup) hand-resolved; lock handlers compose FRO-288 hook feed + B4 new-Map-per-frame; ProjectsList composes RES-5 unreachable + FRO-293 notify.
- Final gate round 4 (tip pre-promotion): lint 0 errors · root 2636/2636 · auth-worker green · sync-worker green · build + brand check OK · tsc clean.
- UI-QA: golden path PASSED (first agent, before session-limit kill); focused re-run of delta-reads/unreachable/?__crash=1 dispatched — verdict lands post-promotion; findings become follow-ups.
- Promoted to main via fast-forward.

### DEPLOY RUNBOOK (do before deploying workers anywhere)
1. `pnpm neon:apply` against PROD Neon (migrations 0034 allocator+claims, 0035 watermark index, 0036 rebuilt_seq — all idempotent). The deploy-workers schema-guard fails closed on main pushes if drift remains (needs NEON_PG_* repo secrets set).
2. Same against the STAGING Neon branch BEFORE pushing `dev` (dev-branch worker deploys bypass the schema guard).
3. Deploy sync-worker at a quiet time (rolling window: old workers still allocate MAX+1; collisions surface as loud 500 + client retry, self-heals).
4. Open human decision: staging BASE_URL (dev.aquilla.app vs staging.aquilla.app) in auth-worker/wrangler.toml [env.staging].
