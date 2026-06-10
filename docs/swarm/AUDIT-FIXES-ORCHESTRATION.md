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

(append: branch · commit · verify result · notes)
