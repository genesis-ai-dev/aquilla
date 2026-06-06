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
<!-- append: date · WS · branch · sha · tsc · vitest · notes -->
