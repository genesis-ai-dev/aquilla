# Swarm: Terminology Management + Interlinear Back-Translation

**Integration branch:** `swarm/term-integration` (off `75657a2`)
**Linear:** FrontierR&D project "Terminology Management + Interlinear Back-Translation" (FRO-199..FRO-208)
**Plan:** `docs/plans/terminology-interlinear-story.md`

## STOP checklist (done = all green)
- [ ] `npx tsc -b --noEmit` clean (root)
- [ ] `npx vitest run` green (incl. new unit tests)
- [ ] `npm run build` passes
- [ ] FRO-199 chips render on managed terms, no line-height shift
- [ ] FRO-200 editor gutter/rail decluttered to primary + overflow
- [ ] FRO-201 library shows live enforcement/infringement stats (0% on clean)
- [ ] FRO-202 interlinear alignment extraction with confidence + tests
- [ ] FRO-203 statistical BT auto-updates on commit, no network on default path
- [ ] FRO-204 chips -> TermLookupPopover Apply works
- [ ] FRO-205 terminology infractions visually distinct
- [ ] FRO-206 per-term drill-down inline editing persists
- [ ] FRO-207 interlinear confirm/invalidate persists + seeds glosser
- [ ] FRO-208 manager entry points + role-gating
- [ ] Real-UI walkthrough QA pass on a live server

## Operating model
- Manual worktrees off the integration tip (NOT isolation:worktree -- that pins stale base).
- Each agent: own files, forbidden files, verify commands, SWARM-TODO requirement, NO push.
- Orchestrator owns all merges + the final gate + staging push.

## Disjoint ownership (avoid collisions)
- FRO-199/204/205 (chips + popover wiring + infraction glyph): src/lib/richtext/*, EditorTable.tsx source-column region, SourceWithTermLookup, violation-decoration-plugin.
- FRO-200 (declutter): CellActionRail.tsx, EditorTable.tsx rail/gutter region. Conflicts with 199-family in EditorTable.tsx -> sequence: land 199 first, then 200 rebases.
- FRO-201/206/208 (library): TerminologyPage.tsx, new library/drill-down components, project settings link.
- FRO-202/207 (interlinear): src/lib/completion/interlinear.ts, bt-glosser.ts (read-only -- do NOT rename its API), expansion-tab BT region.
- FRO-203 (always-on BT): BT compute wiring in ProjectWorkspace.tsx/EditorTable.tsx BT region + glosser memoization.

## Wave plan
- Wave 1 (independent, parallel): FRO-199, FRO-201, FRO-202, FRO-203. (Hold FRO-200 until 199 lands to avoid EditorTable churn.)
- Wave 2: FRO-200 (rebase on 199), FRO-204, FRO-205, FRO-206, FRO-208, FRO-207.
- Wave 3: real-UI QA walkthrough.

## Merge log
- FRO-199 chips merged (13274ee) — tsc clean
- FRO-201 library stats merged (2384cac) — tsc clean
- FRO-202 interlinear lib merged (4320880) — tsc clean
- FRO-203 always-on BT merged (454a968) — tsc clean
- FRO-205 infraction glyph merged (d498227) — tsc clean; compile.ts already emits term: ids
- FRO-204 popover wiring merged (d7b8461) — tsc clean
- FRO-206 drill-down merged (e673618) — tsc clean; GAP: cells=[] (fixer)
- FRO-200 declutter merged (5822b9b) — auto-merge ort, tsc clean
- FRO-208 role-gating merged (bc07c83) — CONFLICT in TerminologyPage resolved (kept onDrillDown + canManage), tsc clean
- FRO-207 confirm/invalidate merged (1ed8c3c) — tsc clean; GAP: ProjectWorkspace alignmentModel wiring (fixer)

## Integration-fix pass (in progress)
- GAP1 FRO-206/201: wire useProjectCells → stats header + drill-down
- GAP2 FRO-207: ProjectWorkspace builds AlignmentModel + persists alignmentSeeds
- GAP3 FRO-203: onCellCommitted signature TODO (assess)

## Remaining before QA
- fixer pass green → full gate (tsc + vitest + npm run build) → real-UI QA walkthrough → promote to main → push dev/staging
