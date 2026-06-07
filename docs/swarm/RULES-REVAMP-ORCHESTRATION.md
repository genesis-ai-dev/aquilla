# SWARM ORCHESTRATION — Rules Revamp

**Goal:** Ship the Rules Revamp (FRO-194…198): Linear-quality in-editor Rules surface, intuitive rule authoring, document import → multi-pass LLM extraction (text/md + PDF/DOCX), and rule suggestions mined from edits (diffs + validated pairs). Spec: `docs/plans/rules-revamp.md`.

## §0 STOP checklist
- [ ] FRO-194 In-editor Rules surface — shell fixed, center swaps, deep-link works
- [ ] FRO-195 Plain-language rule authoring + live preview
- [ ] FRO-196 Document import → multi-pass LLM extraction (text/md/paste)
- [ ] FRO-197 PDF/DOCX parsing
- [ ] FRO-198 Suggest rules from edits (diffs + validated pairs)
- [ ] tsc clean (`npx tsc -b --noEmit`)
- [ ] vitest green (`npx vitest run`)
- [ ] `npm run build` passes
- [ ] worker tsc/tests pass (auth-worker, sync-worker)
- [ ] every new surface verified in the real UI as the seeded dev user
- [ ] every known gap has a SWARM-TODO trace in TRACES.md

## §1 Operating model
- main = sacred. Base integration off clean commit 75657a2 (NOT the dirty feat/dev-db-seed tree).
- swarm/integration = accumulation branch (node_modules symlinked).
- Each agent → its own worktree off integration tip.
- Merge protocol: verify on integration first; promote only when clean.
- **Dependency graph (serial root):** FRO-194 first → unblocks 195, 196, 198. FRO-197 blocked by 196. FRO-198 blocked by 194+196.
  - Wave 1: FRO-194 (solo).
  - Wave 2 (after 194 merges): FRO-195 + FRO-196 in parallel.
  - Wave 3 (after 196 merges): FRO-197 + FRO-198 in parallel.
- Forbidden paths (actor's in-flight work on main — DO NOT TOUCH): `db/seed/`, `scripts/seed-*.ts`, `scripts/lib/seed-tables.ts`, `.gitignore`, `package.json` (seed-related changes).

## §2 Wave history & control plane
- Wave 1 dispatched: FRO-194 → swarm/ws-194-surface.

## §3 Workstream registry
| ID | Title | Status | Owns (files) | Notes |
|----|-------|--------|--------------|-------|
| FRO-194 | In-editor Rules surface | dispatched | RulesPage, ProjectWorkspace shell toggle, App.tsx route | foundational |
| FRO-195 | Rule authoring + live preview | blocked(194) | RuleCreateDialog→inline editor | |
| FRO-196 | Doc import (text/md) extraction | blocked(194) | new import dialog, rule-suggester multi-pass | |
| FRO-197 | PDF/DOCX parsing | blocked(196) | worker parse endpoint | |
| FRO-198 | Suggest from edits | blocked(194,196) | edit-mining service, rule-suggester | |

## §4 Merge log
- Wave 1 · FRO-194 · swarm/ws-194-surface · merged · tsc 0 · vitest green (2 pre-existing AssignedToMe failures) · in-shell Rules surface
- Wave 2 · FRO-195 · swarm/ws-195-authoring · merged · RuleEditor inline authoring + live preview
- Wave 2 · FRO-196 · swarm/ws-196-import · merged (1 union conflict on RulesSurface imports, resolved) · two-pass extractor + import dialog + reusable review
- Wave 3 · FRO-197 · swarm/ws-197-pdfdocx · merged · auth-worker POST /api/v2/parse-document (fflate DOCX full; minimal PDF extractor) · auth-worker tsc 0, 135 tests pass
- Wave 3 · FRO-198 · swarm/ws-198-edits · merged · edit-miner + suggestRulesFromCandidates + suggest-from-edits dialog

**Final gate on integration (all green):** root `tsc -b --noEmit` = 0 · root `vitest` = 1663 pass / 2 pre-existing fail · auth-worker tsc = 0 · auth-worker vitest = 135 pass · `npm run build` = ✓ built.

## §5 Known limitations / fast-follows (honest gaps, documented as SWARM-TODOs)
- **FRO-198 true prior-value diffs:** per-cell prior values live in the D1 event log and need a batch endpoint (`GET /projects/:pid/events?kinds=target.cell.commit`) to mine real corrections without N round-trips. Current miner detects repeated *source→target duplicates* + `hasPendingEdit` recent edits + validated pairs. (SWARM-TODO(event-layer) in edit-miner.ts)
- **FRO-198 cell scope:** RulesSurface receives only `validatedCells`; ProjectWorkspace should also pass ALL cells for richer recent-edit detection. (SWARM-TODO(FRO-198-cells))
- **FRO-197 PDF fidelity:** minimal BT/ET text extractor; complex embedded-font PDFs garble. Swap for a build-verified Workers PDF lib. (SWARM-TODO(FRO-197-pdf)) DOCX is full-fidelity.

## §6 Integration / promotion note
swarm/integration is based off **75657a2** (tip of `feat/dev-db-seed`), NOT main — because the working tree was dirty with the user's seed work at swarm start. Promoting to `main` would carry feat/dev-db-seed commits along. **Promotion path is a user decision** (PR from integration, merge into feat/dev-db-seed, or rebase onto main). Live UI walkthrough + staging push pending user go-ahead.
