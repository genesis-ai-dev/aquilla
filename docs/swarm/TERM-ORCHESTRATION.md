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
- (none yet)
