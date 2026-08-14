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
| 1 | 2026-08-12 | WS-01 import-merge, WS-02 lint-guard, WS-03 dead-code, WS-04 standard-relax | **MERGED, gate green** |
| 2 | 2026-08-12 | WS-05 trunk-tables, WS-06 lib-labels, WS-07 error-wiring | **MERGED, gate green** |
| 2b | 2026-08-12 | translation of the 106 new keys (4 locales) + e2e-note fixup | **MERGED, verified live in Arabic** |
| 3 | 2026-08-12 | WS-08 roles, WS-09 formatters, WS-10 RTL | **MERGED, gate green** |
| 4 | 2026-08-12 | WS-11 org, WS-12 onboarding, WS-13 import/export, WS-14 settings, WS-15 rules, WS-16 terminology | in progress |

## §3 Workstream registry

| ID | Title | Model | Status | Owns |
| --- | --- | --- | --- | --- |
| WS-01 | Merge-on-import + source hashes | sonnet | — | `scripts/i18n-catalog.ts`, `src/lib/i18n/catalog-export.ts` (+tests) |
| WS-02 | ESLint `no-unkeyed-string` + CI | sonnet | — | `eslint.config.js`, `tools/eslint-rules/**`, suppressions file, `package.json` lint scripts, `.github/workflows/**` |
| WS-03 | Delete unreachable pages | haiku | — | `TerminologyPage.tsx`, `RulesPage.tsx`, `RuleCreateDialog.tsx`, `RuleSuggestDialog.tsx` + their tests |
| WS-04 | Relax the context standard | sonnet | — | `src/lib/i18n/context.ts`, `screenshots.ts`, `context.test.ts`, `docs/I18N-CONTEXT-CATALOG.md` |

## §4 Merge log

| date | WS | sha | tsc | vitest | notes |
| --- | --- | --- | --- | --- | --- |
| 08-12 | WS-03 dead-code | 89c9b1dd1 | 0 | green | 4 files deleted; verified unreachable independently (routes go to ProjectWorkspace) |
| 08-12 | WS-01 import-merge | merge | 0 | green | **data-loss fix.** Verified by hand: 2-key import → 1335 before / 1335 after. `--replace` still destructive on request |
| 08-12 | prune | — | — | — | dropped 4 stale suppressions for WS-03's deleted files; baseline 2431 → 2251 |
| 08-12 | WS-02 lint-guard | merge | 0 | green | `i18n/no-unkeyed-string` + native suppressions ratchet; 199 files / 2251 baseline; CI wired |
| 08-12 | WS-04 standard-relax | 0e2fdaefc | 0 | green | prose-required keys 1143 (85.5%) → 653 (48.8%); ellipsis normalize defect fixed (20 of 30 exceptions dropped) |

| 08-12 | WS-06 lib-labels | 57ad3b58d | 0 | green | deriveTitle/milestone-nav/sync indicators return MessageKey descriptors; correctly REFUSED to touch two load-bearing display strings |
| 08-12 | WS-07 error-wiring | 8ba5e0e9c | 0 | green | messageForStatus keyed; 6/6 auth.ts sites; 6/6 keyed-but-dead fixed; closed a latent PIN-oracle |
| 08-12 | WS-05 trunk-tables | 8ca984025 | 0 | green | trunk label tables → MessageKey; Setup ratio as plural() + FSI/PDI; ~50 new keys, 11 reused |
| 08-12 | orchestrator | — | 0 | green | union-merged duplicate-exceptions.ts; deduped cross-workstream "Terminology" collision; fixed the PermissionDeniedAlert async race |

**Wave 1 gate: tsc 0 · vitest 768 files / 7109 tests green · i18n:check 1337 covered · eslint exit 0.**
**Wave 2 gate: tsc 0 · vitest 769 files / 7121 tests green · i18n:check 1441 covered · eslint exit 0.**

| 08-12 | ext session | c9686cffc | 0 | green | AQU-820: closed 7 of WS-07's 9 handoff sites; found 2 were false positives and left them |
| 08-12 | WS-09 formatters | ede940eb2 | 0 | green | 58/70 locale-blind sites migrated; Intl.ListFormat; bidi isolate; forced latn numbering to protect plural selection |
| 08-12 | WS-08 roles | d2a659331 | 0 | green | common.role.* (16 keys); 30 files migrated; roleName() stays canonical for comparisons; 2nd `+"s"` bug fixed |
| 08-12 | WS-10 RTL | 98d645b08 | 0 | green | 520/677 utilities → logical; documented leave-list for media timelines and dir=ltr panes |
| 08-12 | orchestrator | — | 0 | green | resolved 3 formatter-vs-direction conflicts by keeping WS-09's formatting AND applying WS-10's logical classes |

**Wave 3 gate: tsc 0 · vitest 7141 tests green · i18n:check 1483 covered · eslint exit 0.**

| 08-12 | WS-16 terminology | 8da402152 | 0 | green | ~150 keys; consolidated a 6-file status vocabulary; split compile.ts's app frame from user terms; **136 suppressions cleared** |
| 08-12 | WS-12 onboarding | 6f0e51288 | 0 | green | 211 strings, ~300 keys; 8 const-array refactors; found + fixed six hardcoded "← Back" arrows (a real RTL bug) |

**After WS-16 + WS-12: tsc 0 · vitest 7141 green · i18n:check 1931 covered · eslint 0 ·
lint baseline 2251 → 1903 violations across 168 files (from 199).**
Residual after wave 3: physical-direction utilities in `components/org` 69+ → **5**;
locale-blind formatter calls 66 → **6** (all documented exclusions: date-picker/calendar
locked to en-US, and 4 sandboxed parser modules with no locale across the boundary).

### Lesson for wave 3 — isolated worktrees cannot see each other's new keys
WS-05 and WS-06 each minted a key for the English "Terminology" and neither could
know. `no-duplicates` caught it only at integration. For wave 3+, either assign one
agent per namespace, or have each agent declare its intended new keys up front so the
orchestrator can arbitrate before they author. This will get worse as waves widen.

## §5 Approved scope decisions (from the user)

- Marketing pages (670 strings): **SKIP**
- Admin surfaces (~50 strings): **SKIP**
- Unreachable pages (~150 strings): **DELETE**
- Per-key context requirement: **RELAX** to a machine-decidable class test
- Screenshot/"multimedia" context requirement: **RELAX**
- AI prompt strings: stay English; add an "answer in {language}" directive
- Email localization: **DEFER** (needs a `users.locale` migration + product call)
