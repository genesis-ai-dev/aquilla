# Swarm: Translation Brief

**Plan:** docs/superpowers/plans/2026-06-17-translation-brief.md
**Spec:** docs/superpowers/specs/2026-06-17-translation-brief-design.md
**Integration branch:** `swarm/translation-brief` (worktree `.worktrees/swarm-translation-brief`)
**Promotion target:** `feat/translation-brief` (NOT main — this is feature-branch work)

## STOP checklist (done = all green)

- [ ] Tasks 1–13 implemented, each with passing tests
- [ ] `pnpm exec tsc --noEmit -p tsconfig.json` clean (client)
- [ ] `pnpm exec vitest run src/lib/brief src/lib/completion src/lib/sync src/hooks src/components/brief` green
- [ ] auth-worker agent tests green; `pnpm --dir auth-worker exec tsc --noEmit` clean
- [ ] `pnpm build` passes
- [ ] Adversarial review panel: no unaddressed blockers
- [ ] Manual UI smoke (verify-dev-change) passed
- [ ] Integration merged into `feat/translation-brief`

## Operating model

- Orchestrator owns: worktree creation per agent, merges, gates, adversarial review, promotion. Agents NEVER push or merge.
- Waves off the live integration tip (manual worktrees, NOT isolation:worktree — pins to stale base).
- Disjoint file ownership per wave (formatter hook reverts parallel same-file edits).
- Each agent works ONLY in its assigned worktree, commits there, runs verify, reports branch + status. No push.

## Wave plan & file ownership

- Foundation (orchestrator): Task 1 — `src/lib/brief/types.ts`, `src/lib/brief/schema.ts` (+test).
- Wave 1 (parallel): W1-A Task 2 (`brief.ts`) · W1-B Task 3 (sync data model) · W1-C Tasks 8+9 (auth-worker).
- Wave 2 (parallel): W2-D Tasks 4+5 (`brief-generator.ts`) · W2-E Tasks 6+7 (completion wiring).
- Wave 3 (single): Tasks 10→13→11→12 (UI).
- Final (orchestrator): Task 14 gate + adversarial review + promote.

## Merge log

- Foundation: Task 1 landed directly on integration.
