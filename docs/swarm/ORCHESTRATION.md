# SWARM ORCHESTRATION — i18n coverage (AQU-511 / AQU-832)

**Goal:** close the localization coverage gap. 1,337 keys exist; ~3,465 in-app
user-visible strings were never keyed. Full audit + plan:
`docs/swarm/I18N-COVERAGE-PLAN.md` (and the published artifact).

## §0 STOP checklist

Foundation:
- [ ] `i18n:import` MERGES instead of overwriting; a test proves a partial import
      preserves previously-translated keys
- [ ] Source hashes detect English that changed under an existing translation
- [ ] `i18n/no-unkeyed-string` ESLint rule landed, baselined, wired into `pnpm lint`
      and CI; a NEW hardcoded string fails the build
- [ ] `pnpm i18n:check` runs in CI (it never has)
- [ ] Context standard relaxed to a machine-decidable class test; docs updated
- [ ] Unreachable pages deleted, not translated

Shared foundations (block all area work):
- [ ] `common.role.*` exists; `src/lib/frontier/roles.ts` consumers use it
- [ ] Colliding vocabulary promoted to `common.*`
- [ ] Shared locale-aware date/number/list formatters; no `toLocaleX(undefined)` in `src/`
- [ ] Plural + bidi (FSI/PDI) helpers
- [ ] RTL logical-property sweep (physical `ml-/pl-/left-` → logical `ms-/ps-/start-`)

Coverage:
- [ ] Trunk label tables typed as `MessageKey` (compile error on an unkeyed row)
- [ ] The ~21 already-translated-but-unwired chrome keys are wired
- [ ] `err.message`-over-keyed-fallback sites fixed (6 keyed-but-dead + auth cluster)
- [ ] Area sweeps landed in the plan's phase-04 order

Gate:
- [ ] `npx tsc -b --noEmit` clean
- [ ] `pnpm test` green
- [ ] `pnpm build` passes
- [ ] worker tests pass (sync-worker, auth-worker, agent-worker)
- [ ] e2e smoke green (run centrally)
- [ ] Arabic run of the editor shows no English in permanent chrome
- [ ] every known gap has a SWARM-TODO trace in TRACES.md

## §1 Operating model

- `main` / whatever the user's actor branch is = **sacred**. Never touch its
  uncommitted work. A concurrent session has been active in this repo all day.
- `swarm/i18n-integration` = accumulation branch, based on `28618fd32`
  (`i18n/populate-locale-catalogs`, the four filled catalogs).
- Each agent → its own worktree off the integration tip. Agents NEVER push.
- Orchestrator owns: merges into integration, the final gate, promotion, push.
- Merge protocol: union — if both sides add additive functionality, take both.

### Hard sequencing constraints (violating these loses data or blocks PRs)

1. **WS-01 (merge-on-import) must land before ANY workstream adds catalog keys.**
   Today `runImport` emits only the keys in the file handed to it, so a
   new-keys-only import silently drops the other 1,335 translations and reports
   them as "safe to ship". Until WS-01 is merged, no agent may run `i18n:import`.
2. **Foundations (wave 3) must land before area sweeps.** `roles.ts` and the
   colliding `common.*` vocabulary are claimed by 2+ areas each; fanning out
   first mints duplicate keys and fails `no-duplicates.test.ts` across unrelated
   PRs.
3. **Deletes and megafile splits before keying** those files.

### Forbidden paths (all agents)

- `src/lib/i18n/messages/*.ts` — GENERATED catalogs. Never hand-edit. Only
  `scripts/i18n-catalog.ts import` writes these.
- Anything under `.worktrees/`, `.claude/worktrees/`
- `src/pages/Homepage/**`, `src/pages/CaseStudy/**`, `src/pages/PrivacyPolicy.tsx`
  — marketing, scope decision = SKIP
- `src/components/admin/**` — scope decision = SKIP (staff-only)

## §2 Wave history & control plane

| Wave | Dispatched | Workstreams | Status |
| --- | --- | --- | --- |
| 1 | pending | WS-01 import-merge, WS-02 lint-guard, WS-03 dead-code, WS-04 standard-relax | dispatching |

## §3 Workstream registry

| ID | Title | Model | Status | Owns |
| --- | --- | --- | --- | --- |
| WS-01 | Merge-on-import + source hashes | sonnet | — | `scripts/i18n-catalog.ts`, `src/lib/i18n/catalog-export.ts` (+tests) |
| WS-02 | ESLint `no-unkeyed-string` + CI | sonnet | — | `eslint.config.js`, `tools/eslint-rules/**`, suppressions file, `package.json` lint scripts, `.github/workflows/**` |
| WS-03 | Delete unreachable pages | haiku | — | `TerminologyPage.tsx`, `RulesPage.tsx`, `RuleCreateDialog.tsx`, `RuleSuggestDialog.tsx` + their tests |
| WS-04 | Relax the context standard | sonnet | — | `src/lib/i18n/context.ts`, `screenshots.ts`, `context.test.ts`, `docs/I18N-CONTEXT-CATALOG.md` |

## §4 Merge log

<!-- date · WS · branch · sha · tsc · vitest · notes -->

## §5 Approved scope decisions (from the user)

- Marketing pages (670 strings): **SKIP**
- Admin surfaces (~50 strings): **SKIP**
- Unreachable pages (~150 strings): **DELETE**
- Per-key context requirement: **RELAX** to a machine-decidable class test
- Screenshot/"multimedia" context requirement: **RELAX**
- AI prompt strings: stay English; add an "answer in {language}" directive
- Email localization: **DEFER** (needs a `users.locale` migration + product call)
