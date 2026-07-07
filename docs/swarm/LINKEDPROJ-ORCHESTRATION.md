# Linked Projects swarm — ORCHESTRATION

Started 2026-07-06. Linear project: **Linked Projects** (id `ce2a634d-ee7c-4ecd-a758-ad7d1aa0a37f`).
Scope: FRO-476, FRO-477, FRO-478, FRO-479 ONLY (the whole project queue as of start).
Spec: `docs/superpowers/specs/2026-07-06-linked-projects-provenance-invalidation-design.md` (in dev history @ 46679360a).
Base: `dev` @ `03ff391c9`. Integration branch: `swarm/linkedproj-integration`
(worktree `.worktrees/linked-projects-integration`). Promotion target: **dev** (repo works dev→main via PR).
NOTE: dev is being advanced by other actors concurrently — re-check dev tip before every promotion
(memory: concurrent orchestrators churn; promote fast once green, compose don't pick-one on conflicts).

## §0 STOP checklist — ALL GREEN 2026-07-06, swarm converged; promoted to dev @ 4e17594f8
- [x] FRO-476, FRO-477, FRO-478, FRO-479 each at **Fixed** (verified) or honestly blocked with a Linear note.
- [x] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before promotion.
- [x] sync-worker (`cd sync-worker && npx tsc --noEmit && npm test`) and auth-worker green — all four issues touch workers.
- [x] Each fix verified on the real dev stack (live UI) before Fixed (one UI-QA singleton per wave).
- [x] Migrations added to BOTH auth-worker/sync-worker migrations AND db/postgres/schema.sql (D1↔Neon drift memory).
- [x] Promoted to dev only with dev's tree clean; dev tip re-checked at promotion time.
- [x] Gaps traced in docs/swarm/LINKEDPROJ-TRACES.md.

## §EXCLUDED
- Nothing excluded: all 4 issues eligible (Todo, unassigned, no dirty files on dev at start).
- FRO-440 (graph UI / template designation) is deliberately NOT in this swarm — separate issue in Prototype Debugging.

## §1 Operating model
Orchestrator merges + promotes; agents never push/deploy/promote/run the shared dev stack.
Agents = sonnet, manual worktrees off LIVE integration tip (never isolation:worktree — stale-base lesson).
One live-UI QA singleton per wave, on the shared dev stack, after code merges green.
Additive conflicts (types.ts kind unions, projection switch cases, route tables): keep BOTH sides.

## §3 Workstream registry + wave plan

| Issue | Surface (OWNED files) | Branch / worktree | Wave | Status |
|---|---|---|---|---|
| FRO-476 mirror engine + staleness | migrations (auth-worker + sync-worker + db/postgres/schema.sql), sync-worker/src/events/{types.ts, event-projection.ts, dispatch.ts, stale-source-route.ts, NEW link-sync module, cells-read-route.ts}, auth-worker/src/{routes,services}/source-linking.ts, src/lib/sync/stale-source-read.ts, src/hooks/useStaleSourceCells.ts, src/lib/sync/events-emit.ts (mirror-adjacent), rebuild.ts | `swarm/fro-476` / `.worktrees/fro-476` | 1 | MERGED to integration @ 1a8d3c47e (Linear: Fixed, pending live-UI QA) |
| FRO-477 chains (consumes=target) + inherited staleness | sync-worker link-sync module (extend), stale-source-route.ts walk, gate handling, src/components/StaleSourceIndicator.tsx (violet tone), useStaleSourceCells (upstreamStaleCellIds) | `swarm/fro-477` / `.worktrees/fro-477` | 2 | dispatched 2026-07-06 (Linear → Dispatched) |
| FRO-478 creation flow + review panel + repin | src/components/** (NEW CreateLinkedProject flow, NEW UpstreamChangesPanel, ProjectSettings SourceLinkSection), sync-worker types.ts+event-projection.ts (target.cell.repin case — ADDITIVE), src/lib/sync/events-emit.ts (emitTargetCellRepin), auth-worker create-linked-project route | `swarm/fro-478` / `.worktrees/fro-478` | 2 | dispatched 2026-07-06 (Linear → Dispatched) |
| FRO-479 push accelerator | sync-worker/src/events/route.ts (post-commit notify hook), sync-worker/src/project-do.ts (frame type), src/lib/sync/ws-reconciler.ts (client frame handler) | `swarm/fro-479` / `.worktrees/fro-479` | 2 | dispatched 2026-07-06 (Linear → Dispatched) |

Wave-2 shared-file notes: types.ts/event-projection.ts touched by 477+478 (both additive — union on merge);
stale-source-route.ts owned by 477 in wave 2 (478 consumes response client-side only; 479 must not touch it).

## §M Merge log
(append: date · WS · branch · sha · tsc · vitest)
- 2026-07-06 · FRO-476 · swarm/fro-476 · 1a8d3c47e (ff) · tsc 0 · root 3401 pass / sync-worker 678 pass / auth-worker 512 pass. NOTE: initial run showed 1 "failure" (TeamDetail getByText(/projects/i)) caused by the app rendering the git BRANCH NAME in the sidebar build-info — integration branch renamed `swarm/linked-projects-integration` → `swarm/linkedproj-integration` (name no longer contains "projects"); test green after rename. Not a code defect. Agent flag accepted: D1→Neon cutover complete, so migration is db/postgres/migrations/0050_live_source_links.sql ONLY (no worker D1 migrations) — 0050 must be applied to live Neon before deploy (SWARM-TODO).
- 2026-07-06 · integration branch renamed to swarm/linkedproj-integration (see above). Wave-2 worktrees branch from it @ 1a8d3c47e.
- 2026-07-06 · FRO-479 · swarm/fro-479 · 4ca716985 (ff) · tsc 0 · sync-worker 686 pass (full root suite deferred to combined wave-2 gate). Scope clean (5 files). KNOWN GAP: ProjectWorkspace.tsx wiring of link.upstream-changed → useStaleSourceCells/link-sync deliberately left as SWARM-TODO(FRO-479) in ws-reconciler.ts (478 owns that file) — orchestrator closes after 478 merges.
- 2026-07-06 · FRO-477 · swarm/fro-477 · 06abefe7d (merge 07f8dcf40) · tsc 0 · sync-worker 697 pass. Scope clean (13 files; EditorTable/ProjectWorkspace = allowed prop threading). New module sync-worker/src/events/inherited-staleness.ts; response adds upstreamStaleCellIds + ancestorBehind. Linear: Fixed (pending live-UI QA).
- 2026-07-06 · FRO-478 · swarm/fro-478 · da658b2bb (merge 06764f2fb, conflict-free) · scope clean; found+fixed real gap (projects routes never returned link metadata). Linear: Fixed (pending live-UI QA).
- 2026-07-06 · orchestrator · 538532149 · FRO-479 ProjectWorkspace wiring (closed the cross-surface gap). COMBINED GATE on integration: tsc 0 · root 3427 pass · sync-worker 704 pass · auth-worker 517 pass · npm run build OK (brand check aquilla OK).
- 2026-07-06 · live-UI QA singleton dispatched over integration (punchlist → docs/swarm/LINKEDPROJ-UIQA.md). Promotion to dev held until QA verdict.
- 2026-07-06 · QA VERDICT (punchlist committed 8a973142d): FRO-477 PASS (incl. dormant-middle-hop violet, server-state matched) · FRO-478 PASS (cosmetic: picker shows raw UUID) · FRO-476 PARTIAL — BLOCKER: no creation-time seed (live born 0 files; clone born empty w/ NO self-heal) · FRO-479 PARTIAL — badge live-updates (~13s, no reload) but mirrored source TEXT needs manual reload (cells fetch races mirror commit) · MINOR transient violet on first open. QA note: source edits require raw POST /events (no source-edit UI affordance) — pre-existing, traced.
- 2026-07-06 · fixer agent dispatched on swarm/lp-qa-fixes (off 8a973142d) for the 3 defects.
- 2026-07-06 · lp-qa-fixes · 2ac232505 (merged) · FULL GATE green: tsc 0 · root 3439 · sync-worker 704 · auth-worker 521 · build OK. Root causes: snapshotSourceCells never copied files + global files.id PK (naive copy mutated UPSTREAM row — fixed w/ fresh file ids + cell remap); seeded flag + client fallback + zero-file self-heal; syncNow() awaits sync then revalidates staleness+cells; single non-retriggering settle-fetch. Linear back up: QA comments posted on FRO-476/479 (statuses stay Fixed, gated on round-2 re-verify). Round-2 scoped live QA dispatched.
- 2026-07-06 · ROUND-2 LIVE QA: ALL 3 FIXES PASS (punchlist Round 2 @ 6916c7a7f). Live seed at creation ✓ (incl. zero-file self-heal of a pre-fix empty project); clone snapshot-at-birth ✓ (upstream file rows untouched); push badge+TEXT live-update ✓, transient tone gone. Seed path exercised = client fallback; server-side path was locally unreachable due to dev-stack SYNC_WORKER_URL passed as process env (never reaches c.env) → FIXED @ ab5ef543f (--var). Round-2 residual: upstream picker still shows raw UUID (cosmetic, traced).
- 2026-07-06 · PROMOTION HELD: dev working tree has ANOTHER actor's uncommitted edit to src/components/ProjectCreateDialog.tsx (PD7 swarm, DialogBody scroll refactor) — overlaps our branch; per skill, hold, never clobber. Monitor armed (notify when file clears). Final integration tsc re-run in background (machine contended by PD7's tsc/vitest). All four issues at Fixed in Linear with round-2 evidence.

## §FINAL 2026-07-06
Promoted to dev @ 4e17594f8 (merge; ProjectCreateDialog conflict composed with PD7's DialogBody refactor;
post-merge gate: tsc 0, root 3439 pass incl. 4 linked-dialog tests). Agent worktrees removed; branches retained.
NOT pushed to origin (deliberate — dev push triggers deploy.yml which clobbers prod SPA with the api.dev build; Ryder's call).
Deploy prerequisites: 0050 migration on live Neon; check SYNC_WORKER_URL config on deployed auth-worker envs.
