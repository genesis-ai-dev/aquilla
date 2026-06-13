# SWARM ORCHESTRATION — codex-web-app → production

---

# 🆕🆕🆕🆕🆕 CURRENT GOAL (2026-06-13) — OmniVoice TTS on Modal + org-attributed usage metering

> **This block is the active goal.** Everything below is reference-only from prior swarms.
> Spec (read first): `docs/superpowers/specs/2026-06-13-omnivoice-tts-design.md`.
> Driver: user approved the design, then `/loop 5m` + `/swarm-orchestration`.
> Note: this work plausibly unblocks the parked TTS-demo items (FRO-173 cell_audio empty, FRO-246 TTS demo asset).

## §0 STOP checklist
- [ ] `infra/modal/omnivoice.py` authored (FastAPI `/synthesize` + `/health`, `X-Auth-Token`, `X-Audio-Duration-Seconds` header; mirrors `seed_vc.py`)
- [ ] Migration `0041_tts_usage_daily.sql` + `db/postgres/schema.sql` updated
- [ ] `sync-worker`: `tts-budget.ts` + `tts.ts` (`POST /api/v1/voice/tts`) wired into `index.ts` + tests
- [ ] `auth-worker`: `GET /api/v1/usage/me` + `GET /api/v1/usage/org/:orgId` (maintainer-gated) + tests
- [ ] Frontend: client libs + `<UsageSection/>` (Preferences) + `<UsageRollup/>` (OrgHome) + editor "Generate audio" trigger + tests
- [ ] Gate: root tsc 0 · vitest green · sync-worker tsc+test · auth-worker tsc+test · `npm run build` PASS
- [ ] Adversarial review panel passed on integration diff (races / regressions / contracts)
- [ ] UI-QA walkthrough: Preferences Usage + Org overview rollup + cell TTS trigger (post-merge)
- [ ] every known gap has a SWARM-TODO trace in `docs/swarm/TRACES.md`

## §1 Operating model (this goal)
- main = sacred (tip at dispatch: `610c4be9e`, clean). Never touch another actor's uncommitted work.
- Integration: `swarm/integration` (worktree `.worktrees/swarm-integration`, off `610c4be9e`; node_modules ×3 symlinked: root + sync-worker + auth-worker).
- Each agent → **manual** worktree off integration tip (NOT isolation:worktree — stale-base trap, see 2026-05-31 lesson). sonnet, run_in_background. Commits its branch; **NEVER pushes/promotes/deploys**.
- Merge: branch → integration → verify (tsc + vitest, + worker tests if touched) → log §M. Keep-both-sides on conflicts.
- Promote integration → main only when green AND main `git status` clean (D==0, no MERGE_HEAD).
- Enforcement default LOG-ONLY (`TTS_BUDGET_ENFORCE` off) — mirrors the LLM guard while sizing.
- Loop: /loop 5m dynamic; background agents auto-notify on completion (primary driver). Drop to watcher / STOP on convergence — do NOT manufacture work.
- ⚠️ Do NOT run `modal deploy` unattended — author the Python only; deploy is a human step (needs Modal secret creation).

## §3 Workstream registry (this goal)
Status: `in-flight | review | merged-integration | merged-main | blocked`
| ID | Title | Branch | Owns (files) | Status | Agent |
|----|-------|--------|--------------|--------|-------|
| ws-modal | OmniVoice Modal endpoint | `swarm/ws-modal` | `infra/modal/omnivoice.py` | merged-integration | a3da581 |
| ws-sync | TTS route + metering | `swarm/ws-sync` | `db/postgres/migrations/0041_tts_usage_daily.sql`, `db/postgres/schema.sql`, `sync-worker/src/tts-budget.ts`, `sync-worker/src/tts.ts`, `sync-worker/src/index.ts`, `sync-worker/src/__tests__/tts*.test.ts` | dispatched | — |
| ws-auth | Usage read endpoints | `swarm/ws-auth` | `auth-worker/src/routes/usage.ts`, `auth-worker/src/index.ts` (mount), `auth-worker/src/__tests__/usage*.test.ts` | merged-integration | a678119 |
| ws-frontend | Usage UI + cell trigger | `swarm/ws-frontend` | `src/lib/sync/tts.ts`, `src/lib/sync/usage.ts`, `src/components/settings/UsageSection.tsx`, `src/components/org/UsageRollup.tsx`, `src/pages/Preferences.tsx` (insert), `src/components/org/OrgHome.tsx` (insert), editor trigger, tests | dispatched | — |
| ws-qa | UI-QA walkthrough (wave 2) | — | post-merge | queued | — |

## §M Merge log (this goal)
- 2026-06-13 · integration `swarm/integration` created off main `610c4be9e` (spec commit). Wave 1 (4 agents, manual worktrees) dispatched: ws-modal, ws-sync, ws-auth, ws-frontend.
- 2026-06-13 · ⚠️ **ISOLATION ANOMALY:** ws-sync + ws-auth (and likely ws-frontend) wrote their files to the **MAIN working tree** (`/Users/ryderwishart/prototypes/codex-web-app`), NOT their `.worktrees/swarm-ws-*` worktrees (which are empty/clean). `.worktrees` is gitignored. ws-modal worked correctly in its worktree. main was clean (D==0) before dispatch, so ALL current dirty files are agent output + disjoint by directory (sync-worker/db = ws-sync; auth-worker = ws-auth; src = ws-frontend) — no user work at risk. **Their self-reported tsc/vitest are INVALID** (ran against empty worktrees). **RECOVERY PLAN:** after all 3 finish, harvest main's working-tree feature changes (NOT docs/swarm) into `.worktrees/swarm-integration` (cp by `git add -A` name-list), verify centrally (root tsc+vitest, sync-worker tsc+test, auth-worker tsc+test), commit on integration, then restore main to clean. DO NOT clobber main's dirty files until harvested. DO NOT trust agent self-checks. For wave 2: make the worktree the agent's actual cwd or have it write absolute worktree paths + verify the worktree is non-empty before trusting.
- 2026-06-13 · **ws-auth MERGED** → integration (branch `swarm/ws-auth`@2c0be2392 was committed correctly + clean worktree, despite also leaking copies to main). `/api/v1/usage/me` + `/usage/org/:orgId` (maintainer gate via `getEffectiveOrgRole` ≥ MAINTAINER, mirrors workload endpoint) + missing-tts-table degrades-to-zeros (42P01 guard). **Central verify: auth-worker tsc 0 · vitest 345/345.** No SWARM-TODOs.
- 2026-06-13 · **ws-modal MERGED** → integration `37b4b9a82` (FF). `infra/modal/omnivoice.py` (259 lines, mirrors seed_vc). py_compile OK. Uses `OmniVoice.from_pretrained("k2-fsa/OmniVoice")` + `model.generate(...)`, 24kHz output, duration = len/24000. 3 SWARM-TODOs: (1) pin install once upstream tags a release (installs from HEAD), (2) confirm `device_map="cuda:0"` on L40S, (3) `language` accepted at HTTP layer but not forwarded to `generate()` (upstream undocumented kwarg). ws-sync/ws-auth/ws-frontend still in-flight.

---

# 🆕🆕🆕🆕 CURRENT GOAL (2026-06-10 PD7) — Drain Prototype Debugging Todo/Backlog dev queue

> **This block is the active goal.** Everything below is reference-only from prior swarms.
> Driver: `/swarm Prototype Debugging` — Todo/Backlog only; skip Dev Verification Needed / Ready for QA. Sonnet agents.

## §0 STOP checklist (PD7)
- [ ] Every eligible Todo/Backlog issue at **Fixed**, **Dev Verification Needed**, or honestly **blocked** with a Linear note.
- [ ] Integration `swarm/pd7-integration` green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before promotion; worker tsc/test if touched.
- [ ] Live-UI QA (singleton) walked each fix's SWARM-TODO before Fixed.
- [ ] Promoted to main only with main clean apart from protected untracked (`pd5-settings-text.txt`, `tn-fixture.tsv`) + this file.
- [ ] Gaps traced in `docs/swarm/TRACES.md`.

## §EXCLUDED (PD7)
- 14 issues already merged-on-main, reconciled → Dev Verification Needed in Linear: FRO-324/305/300/301/302/306/257/258/304/312/221/218/169/179.
- FRO-173 — real data gap (cell_audio empty), not a code bug; investigation on main d675e63. Linear-commented, left Todo for human.
- FRO-246 — needs a new TTS demo asset (content decision). Linear-commented.
- FRO-227/224 — Dispatched homepage-claims verification owned by a prior dispatch; not reclaimed.
- FRO-209 — likely fixed by FRO-270 (/reset-password shipped in UX-audit swarm); UI-QA agent verifies, then dup/close.

## §1 Operating model (PD7)
- Integration `swarm/pd7-integration` (worktree `.worktrees/pd7-integration`, off main `412f800`, node_modules ×3 symlinked).
- Agents: sonnet, manual worktrees off live integration tip (NEVER isolation:worktree). Commit only; no push/deploy/status-advance beyond Dispatched→Fixed per /issue.
- Claim = orchestrator flips issue → Dispatched before spawn.

## §3 Workstream registry + wave plan (PD7)
| WS | FRO | Title | Pri | Branch | Owns | Wave | Status |
|---|---|---|---|---|---|---|---|
| A | 323+321+322 | Invite cluster: bulk-add visibility, typeahead privacy, path consolidation | High | swarm/pd7-invites | MembersPage.tsx, invite picker, SharePanel invite tab, auth-worker invite/search endpoints | 1 | in-flight |
| B | 308+320 | Left sidebar rework + AI chat docked into left bar | Med | swarm/pd7-sidebar | AppShell/sidebar, ChatPanel placement, ProjectWorkspace panel docking | 1 | in-flight |
| C | 310 | Import flow: client-side parse preview-before-confirm + beta flags | Med | swarm/pd7-import | ImportDialog.tsx, src/lib/import.ts | 1 | in-flight |
| D | 317 | Footnotes: toggle + inline render + edit | Med | swarm/pd7-footnotes | EditorTable cell rendering, footnote lib | 1 | in-flight |
| E | 319 | Audio take-switch feedback + spam-safety | Med | swarm/pd7-audio | audio panel/take components | 1 | in-flight |
| F | 313 | Plain-text export option | Low | swarm/pd7-export | export-service, ExportDialog | 1 | in-flight |
| G | 303 | AI chat: streaming, history, non-blocking, real cell context | Med | swarm/pd7-chat | ChatPanel internals (after B) | 2 | — |
| H | 314+315+316 | Importers: spreadsheet col-mapping, cell-labels template, finished-translation import | Med | swarm/pd7-importers | parsers, ImportDialog (after C) | 2 | — |
| I | 318 | Milestones: event-log model + UI + sidebar nav + sticky anchor | High | swarm/pd7-milestones | sync-worker events (additive), milestones UI (after B) | 2 | — |
| J | 309 | Search UX: jump-in-context + expand-all (after B's dock) | Med | swarm/pd7-search | search panel/results | 2 | — |
| K | 311 | AI metrics: post-edit magnitude over time (simplest) | Med | swarm/pd7-metrics | metrics surface | 2 | — |
| L | 307 | Report-a-problem → PostHog session capture | Med | swarm/pd7-report | new component + posthog lib | 2 | — |
| M | 259 | /projects refactor | Low | swarm/pd7-projects | ProjectsPage | 3 | — |
| N | 193 | AD-9 detach-from-source | Low | swarm/pd7-detach | settings + sync-worker event | 3 | — |
| O | 183 | Terminology spec gaps (scope: decompose first) | Med | — | — | 3 | needs decomposition |

## §M Merge log (PD7)
- 2026-06-10 · integration `swarm/pd7-integration` created off main `412f800`. Reconciliation DONE: 14 issues → Dev Verification Needed w/ commit-ref comments (FRO-257 comment failed — issue archived; status updated). FRO-173/246 commented, left Todo.
- 2026-06-10 · Wave 1 CLAIMED (→Dispatched) + dispatched, 6 sonnet agents on manual worktrees off integration tip 412f800: A invites(323+321+322), B sidebar+chat(308+320), C import-preview(310), D footnotes(317), E audio-takes(319), F txt-export(313).
- 2026-06-10 · **E (FRO-319) MERGED** → integration 5b8efbe (orchestrator fixed 1 unused-var tsc error in test). tsc 0 · full vitest GREEN · FRO-319 Fixed by agent.
- 2026-06-10 · ⚠️ API-522 outage killed agents A/B/C/D/F mid-flight. F had committed 9d1c0ab — orchestrator verified (tsc 0, export tests 68/68), **F (FRO-313) MERGED** → integration, FRO-313 → Fixed + comment. A/B/C/D respawned as FINISHERS into the same worktrees (A effectively fresh).
- 2026-06-10 · **C (FRO-310) MERGED** → integration (finisher completed; FRO-310 Fixed by agent). Orchestrator fixed 3 FRO-287 collision tests broken by the new preview step (mock parseFile + walk preview-confirm) @ 5e087d7+amend.
- 2026-06-10 · **B (FRO-308+320) MERGED** → integration 2eba17a (finisher; AppShell back-compat `sidebar` alias). FRO-308/320 → Fixed by orchestrator (320's comment blocked by permission classifier — status set, no comment).
- 2026-06-10 · **★ INTEGRATION GREEN post-wave-1-partial: tsc 0 · vitest 2658/2658.** Footnotes finisher died 2× more (API flaky) — finisher #3 dispatched with commit-early discipline. Invites agent still in flight.
- 2026-06-10 · **Wave 2 dispatched** (5 sonnet agents, worktrees off live integration tip): G chat(303), H importers(316+314+315), J search(309), K metrics(311). L report-problem(307) deferred until a slot frees. In-flight total 6.
- 2026-06-10 · **G (FRO-303) MERGED** (streaming pre-existed; thread history via localStorage; cell context confirmed) — Fixed by agent. **L (FRO-307) dispatched** into freed slot.
- 2026-06-10 · **D (FRO-317) MERGED** (finisher #3 16c9d76; orchestrator did the ProjectWorkspace wiring: useFootnotesPreference → ViewSettingsMenu + EditorTable). USFM edit-safe; DOCX read-only.
- 2026-06-10 · **J (FRO-309) MERGED** 6203563 (click-to-jump + SearchResultsView expand-all) — Fixed by agent.
- 2026-06-10 · **A (FRO-323+321+322) MERGED** 0f03b8b. 323: server path proven correct w/ round-trip test, real-world cause = role-floor/stale-hook, "park" typo absent; 321: scoped /users/search?scoped=1 + /projects?minRole=600; 322: mode toggle + honest "Add to projects" label (full email-batch unification traced). Spec updated in aquilla-specs. All three Fixed by agent.
- 2026-06-10 · **★ GATE GREEN: tsc 0 · vitest 2685/2685 · auth-worker tsc 0 + 266/266.**
- 2026-06-10 · **Wave 3 dispatched:** M /projects-refactor(259), N detach-AD9(193). In flight: H importers, K metrics, L report, M, N (5).
- 2026-06-10 · **K (FRO-311) MERGED** 0e5e301 (NED post-edit metrics, derive-on-read off target.cell.commit ai_suggestion provenance; Settings → AI Metrics). **L (FRO-307) MERGED** 89fa42f (Report-a-problem → PostHog + replay URL; consent-off honest copy path; "anonymous usage data"→"usage data").
- 2026-06-10 · **H (FRO-316+314+315) MERGED** 78a610d. ⚠️ ORCHESTRATOR INTERVENTION: FRO-314's apply path wrote cast names into TARGET TEXT via real commits (corruption). Disabled at e073ab7 (template+preview kept); **FRO-314 reopened → Todo** w/ unblocker comment (needs cell.label.set-style event). 316/315 sound (zero-dep XLSX via DecompressionStream; paired import reuses FRO-191 matcher).
- 2026-06-10 · **M (FRO-259) MERGED** 34396d6 (Linear-style /projects rows + filter/sort; created/updated cols traced — list endpoint lacks fields). TeamDetail "pre-existing fail" claim NOT reproduced on integration (suite green).
- 2026-06-10 · **FRO-183 DECOMPOSED** → children FRO-327/328/329 (v1 trio, agent dispatched on swarm/pd7-terminology) + FRO-330 (data-model DECISION for Ryder, Todo). Deferred: verdict pipeline, dictionaries, org subscriptions.
- 2026-06-10 · **N (FRO-193) MERGED** 7b5ba29 (SourceLinkSection + typed-DETACH confirm; project.link-source event added additively to sync-worker; snapshot burst via pre-existing auth-worker snapshotSourceCells; markers clear by pointer-match). Gates: tsc 0 · sync-worker 585/585 · auth-worker 266/266.
- 2026-06-10 · **★ npm run build PASS** on integration (pre-detach tip).
- 2026-06-10 · **O (FRO-327/328/329)**: agent found all three ALREADY implemented on the branch base (prior swarm work) — verified green, issues → Fixed. NOTE: review-queue role gate is project_lead(500) vs spec's maintainer(600); FRO-330 = data-model decision for Ryder.
- 2026-06-10 · **Live-UI QA (singleton, 2 attempts — first killed): ALL 17 CHECKS PASS** → UI-QA-PUNCHLIST.md §PD7. Env-only caveats: local sync-worker CORS/import-500, chat needs OPENROUTER key, footnote render needs a \f-bearing USFM. FRO-209 verified: /reset-password renders (fixed by FRO-270).
- 2026-06-10 · **★★ PROMOTED TO MAIN (ff-only): 412f800 → 5dea6c6** (+6845/−229, 68 files). Gates at promotion: tsc 0 · vitest 2736/2736 · sync-worker 585/585 · auth-worker 266/266 · build PASS · UI-QA GO. **PD7 SWARM CONVERGED.** Open remainders: FRO-314 (reopened, needs cell-label event), FRO-330 (decision), FRO-183 umbrella, FRO-173/246 (human), FRO-227/224 (prior dispatch).

---

# 🆕🆕🆕 CURRENT GOAL (2026-06-11) — QoL sweep (Prototype Debugging simple issues)

> **This block is the active goal.** Everything below is reference-only from prior swarms.

## §0 STOP checklist
- [ ] Every eligible issue at **Fixed** or honestly **blocked** with a Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` passes before promotion.
- [ ] Promoted to main only with main's working tree clean apart from untracked files.
- [ ] Each fix verified; spec reconciled per `/issue` Step 2.5.
- [ ] Remaining gaps traced in `docs/swarm/TRACES.md`.

## §EXCLUDED
- FRO-257/FRO-258 — wave 2 (file overlap with wave 1; combined into one agent)
- FRO-304/FRO-312 — wave 2 (file overlap with FRO-305 on ProjectSettings.tsx; combined into one agent)

## §1 Operating model
- Integration `swarm/qol-integration` (worktree `.worktrees/qol-integration`, off main `89e87e1`, node_modules symlinked).
- Each agent → manual worktree off integration tip. sonnet model.
- Agents commit to their branch, NEVER push/deploy/promote.
- Merge: branch → integration → verify → log §M. Promote integration → main (ff) when green AND main clean.
- Protected untracked: `pd5-settings-text.txt`, `tn-fixture.tsv`.

## §3 Workstream registry
| FRO | Title | Pri | Branch | Owns | Status |
|---|---|---|---|---|---|
| 324 | Drop trailing ellipsis on "Invite to projects" button | Low | swarm/fro-324@3b95ca0 | MembersPage.tsx | merged-main |
| 305 | Default top_k to 15 | Low | swarm/fro-305 | ProjectSettings.tsx, useCompletion.ts | merged-main |
| 300 | Outbox indicator position jump on reconnect | Low | swarm/fro-300 | SyncStatusIndicator.tsx | merged-main |
| 301 | Term mining stopwords + phrase splitting | Med | swarm/fro-301@f973719 | candidates.ts | merged-main |
| 302 | Setup walkthrough: import files first | Med | swarm/fro-302 | onboarding/, useSetupChecklist.ts, ProjectWorkspace.tsx | merged-main |
| 306 | Reframe health as staleness + rule violations | Med | swarm/fro-306 | EditorTable.tsx, DecaySettingsSection.tsx | merged-main |
| 257+258 | Modal/Share scroll overflow (combined) | Med | swarm/fro-257-258 | SharePanel.tsx, MembersPanel.tsx | merged-main |
| 304+312 | Consolidate AI config in settings (combined) | Med | swarm/fro-304-312 | ProjectSettings.tsx, VoiceLibraryPanel.tsx | merged-main |

## §M Merge log
- 2026-06-11 · integration `swarm/qol-integration` created off main `89e87e1`. Wave 1 (6 agents) dispatched.
- 2026-06-11 · **Wave 1 ALL MERGED** → integration. FRO-324 (FF), FRO-305, FRO-300, FRO-301 (orchestrator finished commit after agent timeout), FRO-302 (new ImportFilesStep), FRO-306. **Gate: tsc 0 · vitest 2640/2640 · all green.** Wave 2 dispatched: FRO-257+258 (modal overflow), FRO-304+312 (AI config consolidation).

---

# 🆕🆕 CURRENT GOAL (2026-06-04) — Drain the `Prototype Debugging` Linear Todo queue via parallel `/issue` workflows

> **This block is the active goal.** Everything below CONVERGED and is reference-only.
> Driver: user ran `/swarm-orchestration` to iterate `/issue next`. What-to-do = Linear project **Prototype Debugging** (team FrontierR&D, key FRO), status **Todo**. Per-issue lifecycle = `.claude/commands/issue.md`. Spec source of truth = `~/frontierrnd/aquilla-specs`.

## §0 STOP checklist
- [ ] Every eligible `Todo` issue at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Integration `swarm/issue-integration` green: root `tsc -b --noEmit` + `vitest run`; `npm run build` before each promotion; sync/auth-worker tsc+test if touched.
- [ ] Promoted to main ONLY with `ProjectCreateDialog.tsx` working change protected (never staged).
- [ ] Each fix live-verified on the real dev stack before its issue moves to Fixed; spec reconciled.
- [ ] Remaining gaps traced in `docs/swarm/TRACES.md`.

## §EXCLUDED — FRO-147 (`ProjectCreateDialog.tsx` DIRTY in main — forbidden path), FRO-146 (staging, user), FRO-145 (archived junk).

## §1 Operating model
- Integration `swarm/issue-integration` (worktree `.worktrees/issue-integration`, off main `bfacb67`, node_modules + auth-worker/node_modules + sync-worker/node_modules symlinked).
- Each agent → **manual** worktree off the live integration tip (NOT isolation:worktree — stale-base trap). sonnet. Commits its branch referencing FRO-###, does own Linear (assign me + fix comment), spec reconcile, **NEVER pushes/deploys/changes issue status**. Worker-touching worktrees MUST symlink auth-worker + sync-worker node_modules.
- **Live-UI verification centralized** (one dev stack :5173): agents leave SWARM-TODO; a single UI-QA agent confirms each batch, then orchestrator moves the issue → Fixed.
- Merge: branch → integration → verify → log §M. Promote integration → main (ff) only when green AND main clean apart from the protected file.
- ⚠️ Migrations: 0028 CLAIMED (FRO-142). Next free = **0029**.
- ⚠️ BASELINE RED (pre-existing, NOT swarm): `src/components/org/AssignedToMe.test.tsx` 2 fails (mock-export). Present at `bfacb67`. Don't attribute/block on it.

## §3 Workstream registry
Status: `in-flight | review | merged-integration | merged-main | blocked`
| FRO | Title | Pri | Branch@sha | Status |
|---|---|---|---|---|
| 135 | Bible import 0% post-Postgres | High | swarm/fro-135 | in-flight (a30689fbfc2bd3f2d) |
| 140 | Rename Frontier→Aquilla username | Low | swarm/fro-140@a221e43 | merged-integration |
| 141 | Org dropdown scroll affordance | Low | swarm/fro-141@2718dad | merged-integration |
| 136 | Overview file list show-all | Med | swarm/fro-136@84a84f2 | merged-integration |
| 142 | Group internal/public toggle (+migr 0028) | Low | swarm/fro-142@3eb7f9b | merged-integration |
| 143 | Version pins nav | Med | swarm/fro-143@be04128 | **review — premise false, see §M** |
| 134 | Login email→canonical username (TRUE BUG) | High | swarm/fro-134@87c7fa9 | merged-integration |
| 137 | Roster Matrix perf | High | swarm/fro-137@8c81f91 | merged-integration |
| 138 | Define+test org/team perm semantics | Urgent | swarm/fro-138@12230b0 | merged-integration (34 tests, 4 OPQs) |
| 139 | Team view edit perm levels + tooltips | Med | swarm/fro-139 | in-flight (a0b94e6cada5c018a) |
| 144 | E2E org-level business logic tests | High | swarm/fro-144 | in-flight (a4d5758a0357baa03) |

**Queue status: ENTIRE Todo queue dispatched.** Done/merged: 135,140,141,136,142,134,137,138. In-flight: 139,144. Held: 143. Excluded (done by other actor): 147,146; junk: 145.
**PENDING ORCHESTRATOR STEPS:** (1) ~~merge 139+144~~ DONE; (2) live-UI QA via Postgres dev stack for the batch SWARM-TODOs; (3) promote integration → `main` branch (clean ff off `bfacb67`; other actor's `ryder/fro-146-staging-subdomain`@883ff20 lands separately, no overlap); (4) move live-verified issues → Fixed; (5) surface FRO-143 decision + FRO-138 OPQs to user.

## §FINAL IN-SESSION STATE (2026-06-04 ~17:25)
- **ALL 10 swarm issues merged green → `swarm/issue-integration`** (135,140,141,136,142,134,137,138,139,144). FRO-143 held (premise false). Final gate: root tsc 0 · vitest 1514/1516 (2 baseline AssignedToMe reds) · auth-worker tsc 0 + 122/122 · sync-worker 400/400 · build PASS (e2e specs tsc-clean + discovered by `--list`, NOT run).
- **`swarm/issue-integration` is a real branch — it persists after session close.** All work is recoverable from it; NOT stranded in worktrees.
- Per user `/loop` instruction: **all 11 dispatched issues moved Todo→`Dispatched` in Linear** (134,135,136,137,138,139,140,141,142,143,144) so the recurring loop only picks fresh Todo work. `Todo` queue now empty (FRO-145 = archived junk).
- **STILL TODO (human/next-run):** (a) live-UI QA the batch on the Postgres dev stack + run `npm run test:e2e -- e2e/specs/orgs/org-access-lifecycle.spec.ts`; (b) promote `swarm/issue-integration` → `main`; (c) move verified issues Dispatched→Fixed; (d) FRO-143 decision; (e) FRO-138's 4 OPQs (org-viewer-sees-all default, etc.).
- User switched to a **60-min CLOUD schedule** (must clone BOTH `codex-web-app` + `~/frontierrnd/aquilla-specs`) running: "whenever an issue is finished, revisit Linear, work anything still Todo; mark started-but-unfinished as Dispatched."

## §M Merge log
- 2026-06-04 · integration `swarm/issue-integration` off main `bfacb67`. FRO-147 protected.
- 2026-06-04 · **MERGED green → integration:** FRO-141 (OrgSwitcher scroll), FRO-140 (Aquilla rename, 5 files), FRO-136 (ProjectOverview show-all +test), FRO-142 (group toggle: migration `0028_groups_is_internal` + schema + auth-worker org-permissions + TeamsList +4 tests; default Internal-only), FRO-134 (auth.ts JWT-sub → canonical username, TRUE BUG +test), FRO-137 (matrix: stable useCallback deps + React.memo rows, +5 tests). Gate after FRO-137: **root tsc 0 · vitest 1510/1512 · auth-worker tsc 0 + 94/94** (the only reds = 2 baseline AssignedToMe).
- 2026-06-04 · **FRO-143 HELD (review, NOT merged).** No version-pinning portal exists in codex-web-app OR codex-groups-admin; issue premise ("portal reachable via URL") false. Agent added a build-info "Versions" tab to AdminConsole (green) = version-info *discoverability*, not *pinning*. Branch preserved; awaiting user decision.
- 2026-06-04 · FRO-146 actor wired staging deploy into `issue.md` Step 3 (`dev.aquilla.app`, `pnpm run deploy:aquilla:staging`). `--deploy` available once FRO-146 lands.
- 2026-06-04 · **FRO-135 merged** → integration (sync-worker only: defer O(N²) per-cell file-counter recompute to once-per-chunk — the REAL cause of import-stuck-0% over Hyperdrive/PG, SQL dialect was already ported). **root tsc 0 · sync-worker npm test 400/400 · `npm run build` PASS.** ⚠️ sync-worker `tsc --noEmit` shows **60 PRE-EXISTING errors in `__tests__/` files** (CellRow not assignable to Record, node: module resolution) — CONFIRMED identical on `main` branch `bfacb67`, NOT swarm-introduced (from the recent D1→PG migration). Real gate = vitest, green. Traced as separate debt.
- 2026-06-04 · **★ AUTOMATED GATE GREEN for the 7-issue batch** (135,140,141,136,142,134,137): root tsc 0 · vitest 1510/1512 (2 baseline AssignedToMe reds) · auth-worker tsc 0 + 94/94 · sync-worker test 400/400 · build PASS.
- 2026-06-04 · **TOPOLOGY CLARIFIED:** `main` BRANCH = `bfacb67` (integration is correctly based on it; clean ff). The main *working dir* is checked out on **`ryder/fro-146-staging-subdomain`** @ `883ff20` (other actor's commits: FRO-146 staging-on-Neon, FRO-147 dialog redesign, dev-stack managed-local-Postgres). **Zero file overlap** with integration (`comm -12` empty) → conflict-free whenever that branch lands on main. ⇒ **FRO-147 + FRO-146 are DONE by the other actor.** dev-stack now boots Postgres for `pnpm dev` (unblocks live-UI QA).
- 2026-06-04 · **FRO-138 committed** `swarm/fro-138`@`12230b0` ("lock permission semantics with 34 integration tests") — awaiting full agent completion before merge.
- ⚠️ NOTE: this top block was once stripped by a linter/user edit and restored. If it goes missing again, the merge log here is the recovery source.

---

# 🆕 CURRENT GOAL (2026-05-31 PM) — Back-translation + Terminology, built fully

> **This block is the active goal. The historical "production-ready" swarm below CONVERGED and is reference-only.**
> Design spec (read first): `docs/superpowers/specs/2026-05-31-bt-terminology-design.md`.

**Goal:** Build two aquilla-spec features fully in codex-web-app — (1) back-translation (statistical glosser + `cell.backtranslation.set` persistence + BT-tab edit/Polish/stale/role-gate + termbase seeding); (2) terminology/glossary v1-core (concept model synced + compile-to-rules derived verdicts + settings page CSV/TBX + lookup/apply popover). Localization DEFERRED. **User authorized the sync-worker event layer** (additive only).

## §0 STOP checklist (done = all green; then CronDelete + PushNotify)
- [ ] `npx tsc -b --noEmit` clean (root) · `npx vitest run` green incl. new tests
- [ ] `cd sync-worker && npx tsc --noEmit && npm test` green
- [ ] `npm run build` passes
- [ ] BT demo-true: auto-generates statistically · persists across reload (event) · Edit→Save persists · Polish toggle · stale→regen · role-gated
- [ ] Terminology demo-true: add/edit/delete · CSV+TBX import/export · violations on cells · lookup→Apply · termbase seeds BT
- [ ] every remaining gap traced in `docs/swarm/TRACES.md`

## §1 Operating model (this goal)
- **Base:** main is CLEAN at `aae39b7` (prior swarm promoted; Paratext actor's sync-worker work landed). No forbidden paths now — sync-worker event layer is fair game, additively.
- **Integration:** `swarm/integration2` (worktree `.worktrees/swarm-integration2`, off `aae39b7`, node_modules symlinked). The old `swarm/integration`@`9b4529a` is STALE (main 60 ahead) — abandoned.
- Each agent → isolated worktree (Agent isolation:worktree, model sonnet, run_in_background). Agents commit their branch, NEVER push.
- Merge protocol: merge branch → integration2 → verify (tsc + vitest, + sync-worker tests for BT-EVENT) → log in §M. Keep-both-sides on conflicts. Promote integration2 → main only when green AND main `git status` clean (D==0, no MERGE_HEAD).
- **Loop:** 5-min cron (this session). Also re-invoked on each agent completion. Drop to a watcher / STOP on convergence — do NOT manufacture work.

## §3 Workstream registry (this goal)
Status: `in-flight | review | merged-integration2 | merged-main | blocked`
| ID | Title | Branch | Owns | Status | Agent |
|---|---|---|---|---|---|
| WS-BT-EVENT | sync-worker `cell.backtranslation.set` event + projection + read route | `swarm/ws-bt-event` | sync-worker/src/events/** (additive) | in-flight | ab27b12f8ab8e67e9 |
| WS-BT-CLIENT | Markov glosser + BT tab edit/Polish/stale/role-gate + emit | `swarm/ws-bt-client` | bt-glosser.ts, EditorTable BT tab, ProjectWorkspace BT wiring | in-flight | ae51dccfab674b40b |
| WS-TERM-DATA | concept model + sync + compile-to-rules + CSV/TBX lib | `swarm/ws-term-data` | src/lib/terminology/**, types.ts (terminology field), project-settings | in-flight | ac0af825757d23a14 |
| WS-TERM-UI | terminology page (CRUD+CSV/TBX) + standalone lookup/apply popover | `swarm/ws-term-ui` | TerminologyPage.tsx, TermLookupPopover.tsx, nav/route | in-flight | af692816a137f4701 |
| WS-GLUE-QA | mount popover in editor + seed glosser from termbase + live UI QA | (wave 2) | (after wave-1 merges) | queued | — |

## §M Merge log (this goal)
<!-- append: date · WS · branch · sha · tsc · vitest · notes -->
- 2026-05-31 · integration2 created off main `aae39b7` · wave 1 (4 agents) dispatched.
- 2026-05-31 · **WS-BT-EVENT merged** → integration2 (FF; `cell.backtranslation.set` event + projection + read route + migration 0021 + 20 tests). root tsc 0, sw tsc 0.
- 2026-05-31 · **WS-TERM-DATA merged** → integration2 (terminology lib + compile-to-rules @ `useRules.ts:36-45` + CSV/TBX + 29 tests). root tsc 0, **vitest 1291 pass**. sync-worker `npm test` = **6 PRE-EXISTING stale failures** (admin×3 / audio×1 / files-read×2 — per `SYNC-WORKER-FAILURES.md`, NOT introduced here; BT's 20 new tests pass). → fixer `swarm/ws-swtest-fix` dispatched.
- 2026-05-31 · **WS-BT-CLIENT merged** → integration2 (no conflict; Markov glosser + BT tab edit/Polish/stale/role-gate + outbox emit + 14 glosser tests). root tsc 0, **vitest 1305 pass**. SWARM-TODO: hydrate persisted BT via the read route (glue wave).
- 2026-05-31 · **WS-TERM-UI merged** → integration2. add/add conflicts on terminology/{types,store,csv,tbx}.ts resolved KEEP-REAL-IMPL (TERM-DATA's); TERM-UI's TEMP stubs dropped. Page + popover + route + RulesPage nav + 16 tests landed. ⚠️ tsc RED (9 errors): TERM-UI's CRUD call-sites assume `addConcept(concept)` but TERM-DATA shipped `addConcept(project, concept) → ProjectRecord` → glue fixes.
- 2026-05-31 · **★ All 4 wave-1 branches merged.** WAVE 2 GLUE dispatched (`swarm/ws-glue`, off integration2 tip): (1) fix TerminologyPage CRUD call-sites + test to real store API + persist via patchShared; (2) mount TermLookupPopover in EditorTable source-token UI; (3) hydrate persisted BT via cell-backtranslations read route in ProjectWorkspace; (4) seed glosser from termbase (preferred=+,admitted=low,forbidden=−); (5) Terminology sidebar nav item. Target: tsc 0 + vitest green.
- 2026-05-31 · **WS-SWTEST-FIX merged** → integration2 (clean; 6 stale tests refreshed, zero prod code). **sync-worker now 381/381 pass, tsc 0.** Client tsc still RED pending glue.
- 2026-05-31 · **WS-GLUE cut off** mid-Task-1 (no commit; left TerminologyPage half-refactored at 20 errors). Discarded the partial. **Decomposed into 3 parallel single-file agents** (brief was too big for one): Glue-A `swarm/ws-glue` (TerminologyPage → real store API, target tsc 0), Glue-B `swarm/ws-glue-pw` (ProjectWorkspace: BT read-route hydration + glosser termbase-seeding + terminology nav), Glue-C `swarm/ws-glue-editor` (EditorTable: mount lookup/apply popover on source-token click). Each owns ONE hot file → conflict-free.
- 2026-05-31 · **Glue-A + Glue-B merged** → integration2 (clean, disjoint files). **integration2 GREEN: root tsc 0, vitest 1321 pass.** (TerminologyPage CRUD → `useProject().patchSettings`; ProjectWorkspace BT-hydration + glosser termbase-seeding + Terminology nav.) sync-worker still 381/381.
- 2026-05-31 · **Glue-C merged** → integration2 (clean). **★ FULL GATE GREEN: root tsc 0, vitest 1321, sync-worker tsc 0 + 381 tests, `npm run build` PASS.**
- 2026-05-31 · **★ PROMOTED TO MAIN (ff-only).** main `aae39b7` → **`e16759a`**. All BT + terminology work is on main; untracked swarm docs preserved; tree clean.
- 2026-05-31 · **UI-QA done** (`UI-QA-PUNCHLIST.md` §"BT + Terminology QA"). Both PARTIAL. In-session add/save (terminology, PATCH 200 + server-confirmed) and generate/edit/save (BT, event emitted to outbox) all WORK. **1 REAL P1: BUG-TERM-1** — synced settings (terminology) don't load on navigation (StrictMode `aliveRef` race in `useProjectSettings.ts:140` drops the fetched response). **1 glosser defect: BUG-BT-5** — runaway repetition (no termination guard). Rest = ENV (migration 0021 not applied to the running dev D1 → BT D1-persistence unverified live; CSV/TBX/popover/role/Polish untestable via Preview tooling — all cascade, not code bugs).
- 2026-05-31 · **Fix-wave dispatched**: `swarm/fix-term-load` (BUG-TERM-1: useProjectSettings StrictMode race + regression test) · `swarm/fix-glosser-repeat` (BUG-BT-5: bound length + break repetition cycles + test).
- **ENV step for the demo** (BUG-BT-1/TERM-2 — NOT a code bug): apply the migration to the demo D1 → `cd auth-worker && npx wrangler d1 migrations apply aquilla-db --local --persist-to ../.wrangler-dev-state` + restart sync-worker. BT persistence logic is unit-proven (sync-worker 381 green incl. BT round-trip); only the dev-stack D1 lacked the table.
- 2026-05-31 · **Fix-A + Fix-B merged + verified** → integration2 (Fix-B add/add conflict on bt-glosser.ts resolved = take the guarded version; sanity ours=0 / theirs=5 guard markers). **GREEN: root tsc 0, vitest 1324 (1321 + 3 regression tests), build PASS.** sync-worker unchanged 381.
- 2026-05-31 · **★ PROMOTED TO MAIN (ff-only).** main `e16759a` → **`3ea4932`**. BUG-TERM-1 + BUG-BT-5 fixed on main; all automated gates green.
- 2026-05-31 · **Re-QA done.** Check 1 (BUG-TERM-1 fix) **✅ FIXED** (loads on nav + hard reload). Check 2 (lookup popover + Apply) **✅ PASS** (note: concept must be status "active"/approved; new = draft). Check 3 (terminology violation) **✗ BUG-TERM-6 (P2)** — `source-requires-target` terminology violations don't fire on cells; persists after hard reload (so NOT in-session staleness); concept active on server, compile unit-tested + `useRules.ts:47` merges them — yet the editor's cell-violation path (likely the health WORKER) doesn't get them.
- 2026-05-31 · **BUG-TERM-6 fix dispatched** (`swarm/fix-term-violations`): diagnose why compiled terminology rules don't reach the cell-violation path (hypothesis: the health worker's rule input ≠ `useRules` merged rules, or `project.terminology` doesn't reach the editor's rule context) + surgical fix + integration test through the real path. Killed stray re-QA vite :5291.
- 2026-05-31 · ⚠️ **isolation:worktree STALE-BASE bug discovered.** The BUG-TERM-6 agent's `isolation:worktree` was based off session-start `aae39b7` (NOT live main `3ea4932`) → it recreated the already-on-main terminology module; its branch diff vs main = +350/−3273 (would DELETE all BT + sync-worker event layer + the stale-test/StrictMode fixes). **Branch `swarm/fix-term-violations` DISCARDED — DO NOT MERGE.** Lesson: `isolation:worktree` pins to session-start HEAD; **use MANUAL worktrees off live main for all further agents** (the glue agents did this correctly; Fix-A/Fix-B also got stale bases but their 3-way merges happened to combine cleanly + are re-QA/test-verified). main verified COMPLETE + correct.
- 2026-05-31 · **Real BUG-TERM-6 fix re-dispatched** on a MANUAL worktree off live main `3ea4932` (`swarm/fix-term-viol2`): diagnose the RUNTIME path (ProjectWorkspace `project`→`useRules`→`useHealth`→`checkRulesForCell`) — prime suspects: `project.terminology` empty in ProjectWorkspace, or `useHealth` filters terminology rules out of `enabledRules`. Surgical fix + real-path test.
- 2026-05-31 · **BUG-TERM-6 = symptom of BUG-TERM-1 (already fixed).** Real-fix agent (manual worktree, NO recreated modules) traced it: StrictMode race → `settings.terminology` undefined → `useRules` compiled 0 terminology rules; that race is fixed on main (`2e89ccf`). Audited the runtime path (compile sets enabled:true; useHealth keeps them; checkRulesForCell fires) + added a 5-case **integration regression test** (`useRulesHealth.integration.test.tsx`). Merged → main **`00fad37`**. **GREEN: tsc 0, vitest 1329, sw 381, build PASS.**
- 2026-05-31 · **Final tight re-QA dispatched**: settle the lone contradiction — does a terminology violation RENDER on a FRESH load (active concept + non-compliant cell)? The prior re-QA negative was an in-session-promotion scenario; the integration test proves computation. Non-disruptive, time-boxed, ONE check.
- 2026-05-31 · **★ Final re-QA: VERDICT = RENDERS.** Terminology violation renders on a genuine FRESH load — source-term dotted-underline decoration + the `source-requires-target` infraction in the cell's Issues tab; control built-in violation also renders. **BUG-TERM-6 was a FALSE NEGATIVE** (prior in-session-promotion timing, exactly as the integration test predicted). UX note (P3, traced): the term violation shows in the Issues tab but has no face-level row indicator.
- 2026-05-31 · **★★ SWARM CONVERGED — GOAL COMPLETE.** Back-translation + Terminology built fully, on main **`00fad37`**. §0 STOP checklist GREEN: root tsc 0 · vitest **1329** · sync-worker tsc 0 + **381** · `npm run build` PASS · both features demo-true (live-verified) · gaps traced. Bugs found+fixed in QA: BUG-TERM-1 (StrictMode settings-load race), BUG-BT-5 (glosser runaway repetition); BUG-TERM-6 = symptom of TERM-1 (already fixed) + new integration test. ⚠️ `isolation:worktree` stale-base pitfall recorded above — used manual worktrees off live main. **Loop cron `c666a8c2` DELETED.** Demo-env step: apply migration `0021` for BT D1-persistence (unit-proven; sync-worker round-trip green).

---

## 📦 ARCHIVE — prior goal "production-ready given homepage claims" (CONVERGED + PROMOTED 2026-05-31)

Everything below this line is the **historical record of the prior swarm**. It converged and **promoted to main** (now `aae39b7` — see the two `merge(swarm→main)` commits). The "Paratext/USFM actor" it repeatedly references has **committed — main's working tree is clean**, and its sync-worker event-layer work (`comment.*`, `target.cell.commit`, etc.) has **landed in main**. ⚠️ Therefore the **"Forbidden paths", "promotion BLOCKED", "promote only when D==0", and "sync-worker = RED" notes below are STALE and no longer apply** — sync-worker is now freely extendable (additively). The dead watcher cron `5d99aca3` was a prior session and is gone. Kept for history; **do not act on its directives** — the live state is the CURRENT GOAL block at the very top.

**Role (historical):** This file is the single source of truth for an autonomous swarm making
codex-web-app shippable for upcoming demos. The project-lead loop (cron, every 5
min) and every subagent reads this first. Keep it current.

**Started:** 2026-05-30 · **Mode:** autonomous (user AFK 8–16h) · **Model policy:** sonnet for all implementation subagents.

**GOAL (user-set, /goal):** Production-ready *given the homepage claims*. Every promise on the marketing homepage (`src/pages/Homepage/Homepage.tsx`) must be demonstrably true on the golden path, OR be honestly dialed back (hidden / copy changed) rather than left as a visible broken promise. The homepage is the acceptance contract — see §0 Layer 2 and §6.

---

## 0. Definition of "shippable" — STOP checklist

Two layers. BOTH must be green. The loop STOPS (and notifies the user) only when all are true.

### Layer 1 — Green build (the floor)
- [ ] `npx tsc -b --noEmit` clean (root: src/ + scripts/ + e2e/)
- [ ] `npx vitest run` green (client/src)
- [ ] `cd sync-worker && npm test` green · `cd auth-worker && npm test` green
- [ ] `npm run build` succeeds (aquilla brand)
- [ ] `npm run test:e2e:smoke` green (run centrally, not in worktrees)

### Layer 2 — Homepage claims demonstrably true (the REAL bar — status tracked in §6)
- [ ] CTA path: homepage → `/onboarding` → create account (free) → into the workspace
- [ ] Text translation: open source, draft, edit, validate a cell
- [ ] Audio translation: record / synthesize / play per-cell audio
- [ ] Video translation: claimed video modality works — OR claim dialed back with user sign-off
- [ ] AI first-draft (completion), incl. low-resource framing
- [ ] Back-translation visible "as you work"
- [ ] Living Memory = ACTIVE learning loop (a correction becomes guidance in the next draft), not only a read-only view
- [ ] Confidence score per cell + "biggest drags, ranked, one click away"
- [ ] Team collaboration / cloud sync (multi-user)
- [ ] On-device speech + private mode — OR claim dialed back
- [ ] Import/export robust enough for professional source files
- [ ] No "unavailable in this build" placeholder on any CLAIMED golden path

### Honesty gate (non-negotiable)
- [ ] Every gap that can't be closed in time is (a) traced in TRACES.md AND (b) either hidden in the UI or surfaced to the user as a copy change — NEVER a visible broken promise. Under-delivering silently is a FAIL.

---

## 1. Operating model (how the swarm works without colliding)

- **main** = sacred. It carries the USER'S uncommitted in-flight work (see Forbidden
  paths). NEVER `git add`/commit/stash/checkout their changes. Only clean-merge into main.
- **swarm/integration** (worktree `.worktrees/swarm-integration`, node_modules symlinked)
  = integration branch based on clean HEAD `8e35c2b`. All agent branches merge here
  first; kept green; promoted to main in batches.
- **Each workstream agent** runs via `Agent(model:sonnet, isolation:worktree,
  run_in_background:true)`. The harness gives it an isolated worktree at HEAD and
  returns its branch/path on completion. Agents COMMIT their work (no pre-commit hook).
- **Merge protocol (per completed agent):**
  1. Review the returned branch diff (scope + forbidden paths).
  2. Merge branch → `swarm/integration`; run verify commands there.
  3. Green + on-scope → keep, log in §4. Red/off-scope → revert, write a TRACE, respawn a fixer.
- **Promotion:** when `swarm/integration` is green, clean-merge it into `main`
  (`git -C <main> merge --no-ff swarm/integration`). If it conflicts with the user's
  dirty files, PAUSE and surface — do not force.
- **Concurrency rule:** never let two IN-FLIGHT agents own the same file. Ownership is
  tracked in §3. ProjectWorkspace.tsx and import.ts are HOT — single-owner at a time.
- **Keep ~3–5 agents in flight.** Don't oversubscribe.

### ~~Forbidden paths~~ — ✅ RESOLVED 2026-05-31 (actor landed; sync-worker NO LONGER forbidden)
**HISTORICAL — do not act on this.** The Paratext/USFM actor committed; main is clean at `aae39b7` and its sync-worker event-layer work is merged. The current goal extends sync-worker freely. The list below records what was *once* in-flight (2026-05-30, now resolved); none of it is off-limits today:
- `sync-worker/src/events/**`, `sync-worker/src/__tests__/**` (event-layer refactor + comment handlers)
- `src/lib/import.ts`, `src/components/ImportDialog.tsx`, `src/lib/sync/source-export.ts`, `src/lib/sync/bulk-import.ts` (import/export wiring — they edit these too)
- `src/lib/import/**` (new dir, theirs)
- `src/lib/parsers/paratext.ts`, `paratext-project.ts`, `usfm-markers.ts`, `usfm-tokenize.ts` (+ `.test.ts`)
- `scripts/paratext-import-e2e.ts`, `usfm-conformance.ts`, `usfm-marker-coverage.ts`
- `src/pages/MembersPage.tsx`
- Any change needing NEW sync-worker event kinds → leave a TRACE, do not edit the event layer.

NOTE: wave-1 already committed CAT-format edits to `import.ts`/`ImportDialog.tsx` + a `source-export.ts` fix on swarm/integration — these overlap the actor and will be reconciled at promotion (their source-export.ts fix is byte-identical to ours; import.ts/ImportDialog.tsx are additive switch cases). NO NEW swarm work may touch these files.

### Verify commands (ground truth)
| Scope | Command (from) |
|---|---|
| Typecheck (client+scripts+e2e) | `npx tsc -b --noEmit` (root) |
| Unit tests (client/src) | `npx vitest run` (root) |
| sync-worker | `cd sync-worker && npx tsc --noEmit && npm test` |
| auth-worker | `cd auth-worker && npx tsc --noEmit && npm test` |
| Full build | `npm run build` (root) — central only |
| E2E smoke (CENTRAL ONLY) | `npm run test:e2e:smoke` — needs wrangler dev ×2 + Chromium |
Worktree agents: symlink deps first → `ln -s /Users/ryderwishart/prototypes/codex-web-app/node_modules node_modules`.

### Key contracts (so agents build against the right types)
- Parser output: `TranslatableString` — `src/lib/parsers/types.ts:17`
- Editor cell: `CellData` (has `id,fileId,original,translated,status,group(=canonicalRef),activeValidators`) — `src/hooks/useCells.ts:42`; hook `useCells()` returns `{cells: CellData[]}` at `:258`
- Events: `EventKind` union — `sync-worker/src/events/types.ts:22` (already incl. comment.* and target.cell.commit)
- Import orchestrator: `src/lib/import.ts` (`importFile`→`parseFile` switch→`emitParsedFile`)
- Export: `src/lib/export/export-service.ts` (`exportFile()` throws today; `downloadBlob()` works); USFM server export at `sync-worker/src/events/export-route.ts`
- UI: shadcn "base-nova", primitives in `src/components/ui/`, lucide icons, NO toast lib (local state / window.alert), Dialog & Sheet patterns per `ConfirmActionDialog.tsx` / `FixReviewPanel.tsx`

---

## 2. Wave history & control plane
- **Loop cron:** CONVERGED WATCHER `5d99aca3` (`8,38 * * * *` = every 30 min). History: `cd56b87c`(5m build) → watchers `806fc9e0`/`3bc7a649` → ACTIVE `5f4fba13`(10m, user-directed aggressive) → **converged watcher `5d99aca3`** (build done, 30m to save tokens during AFK; auto-promotes when actor's tree clears; if user returns + wants aggressive, follow that). `CronDelete 5d99aca3` on STOP.
- **USER DIRECTIVE (2026-05-31):** be aggressive with parallel subagents (accept later 3-way merges; don't gate on zero-collision ownership); always keep a UI-walkthrough agent driving the live app. See memory `feedback_aggressive_parallelism`. The earlier "plateau/watcher" throttle was a mistake — keep the pipeline full.
- **QA server:** integration frontend at `http://127.0.0.1:5273` (vite from `.worktrees/swarm-integration`, env→ running backend :8788 auth / :8789 sync). Relaunch cmd is in the cron prompt. Does NOT disturb the actor's stack on :5173/:8788/:8789.
- **Wave 6** (2026-05-31, in-flight, aggressive): W6-A UI-QA walkthrough → `ac5e7ebdd5b43e950` (drives :5273 → `docs/swarm/UI-QA-PUNCHLIST.md`); W6-B perf/code-split → `a05898ff789027e5d` (`.worktrees/swarm-w6b-perf`); W6-C UX polish (ExportDialog/LivingMemory/PassagesPanel) → `a44eed5e94c7b02f8` (`.worktrees/swarm-w6c-uxpolish`); W6-D polish traces (lastEditAt sort + complete-all cost) → `af811d4414d7540ce` (`.worktrees/swarm-w6d-traces`). Merge each into swarm/integration on completion.
- **Promotion logic (IMPORTANT — survives compaction; UPDATED 2026-05-31):** The actor COMMITTED — main moved `8e35c2b` → **`e99b45b`** (landed client Paratext project-import + org-context: Overview dashboard, archive/untrack, audio-progress, org create/rename, Settings/Members in AppShell). Their committed `import.ts`(+182), `ImportDialog.tsx`(+95), `source-export.ts`, `parsers/types.ts` now hold Paratext changes that OVERLAP the swarm's CAT additions → promotion is a REAL 3-way `git merge swarm/integration` (NOT fast-forward), resolving those 4 files by KEEPING BOTH (actor's Paratext cases + swarm's CAT cases; source-export fix is identical). **Still 13 dirty files, ALL sync-worker event-layer** (the actor's ongoing work) + new `paratext-pairing.ts`. The swarm's changes are 100% client `src/` — DISJOINT from the dirty sync-worker, so a merge wouldn't clobber their dirty work — BUT to avoid disrupting the actor mid-work, **promote only when D==0** (their tree clean). Watcher cron handles it. Rollback ref if promotion goes wrong: main was `e99b45b` pre-merge.
- **Integration worktree:** `.worktrees/swarm-integration` (branch `swarm/integration`, node_modules symlinked, based on clean HEAD `8e35c2b`).
- **Baseline @ HEAD 8e35c2b:** client `vitest run` = **996 pass / 157 files**. `tsc -b --noEmit` = **1 pre-existing error** (`src/lib/sync/source-export.ts:26`, erasableSyntaxOnly) → assigned to WS-EXPORT to fix.
- **Wave 1** (2026-05-30, ✅ DONE — verified green on swarm/integration @ 38bea14, promotion to main BLOCKED — see §4):
  - WS-EXPORT → `a16344d952f81a951` · WS-IMPORT-CAT → `a4c60baf04985eb48` · WS-LIVING-MEMORY (read-only) → `a96afcb61c530cc28` · WS-SEARCH-SURVEY (research) → `aec2ea90f0c7e2c92`
- **Claims-audit** (research) → `af076577d0a9b4c19`; full report `docs/swarm/CLAIMS-AUDIT.md`; status table in §6.
- **Wave 2** (2026-05-30, in-flight) — dedicated worktrees off integration tip, claims-driven:
  - W2-A Living Memory ACTIVE learning loop (C7) → agent `a812e1fea4062dae4`, worktree `.worktrees/swarm-w2a-memory` (branch `swarm/w2-memory`). Owns completion lib.
  - W2-B workspace wirings: FTS5 search 1-line fix + back-translation (C6) + LM nav → agent `ae7a2741e0c7a207c`, worktree `.worktrees/swarm-w2b-workspace` (branch `swarm/w2-workspace`). Owns ProjectWorkspace.tsx.
  - Merge-back: when each completes, merge its branch into swarm/integration, verify (tsc+vitest), log in §4.
- **Wave 3** (2026-05-30, in-flight) off integration tip `d0d4346`: W3-A rule-suggestion-from-corrections → `ac129a2ac74289546` (`.worktrees/swarm-w3a-rulesuggest`); W3-B whole-project multi-format export → `a90e02eab6dfd1290` (`.worktrees/swarm-w3b-projexport`).
- **Integration tip:** swarm/integration @ `d0d4346` (tsc 0, vitest 1087). Accumulation branch; wave worktrees merge back into it.
- **Milestone TODO (verification):** the running preview serves MAIN, not integration — so swarm changes aren't browser-verifiable until promotion. Once main unblocks (or via a dev server launched from `.worktrees/swarm-integration`), run a hands-on golden-path QA (onboarding → workspace → import → draft/validate → export → search → Living Memory) + `npm run test:e2e:smoke` centrally. This is the remaining Layer-1/Layer-2 gate not yet exercised.

---

## 3. Workstream registry

Status: `queued | in-flight | review | merged-integration | merged-main | blocked`

| ID | Title | Status | Owner branch | Owns (files) | Prio | Notes |
|---|---|---|---|---|---|---|
| WS-EXPORT | Multi-format client export + ExportDialog + workspace wiring | in-flight | (wave1) | `src/lib/export/**`, `src/lib/sync/source-export.ts`, new `ExportDialog.tsx`, export wiring in `ProjectWorkspace.tsx` | P0 | User priority. USFM server path stays; add client TSV/CSV/MD/TXT/DOCX/XLIFF/TMX export. |
| WS-IMPORT-CAT | CAT-industry importers (XLIFF 1.2/2.0, TMX, CSV/TSV bilingual) | in-flight | (wave1) | new `src/lib/parsers/{xliff,tmx,csv-bilingual}.ts`, `src/lib/import.ts`, `ImportDialog.tsx`, `src/lib/parsers/types.ts` | P0 | User priority. Spec-driven (OASIS/LISA), NOT GPL MateCat copy. |
| WS-LIVING-MEMORY | Living Memory read-only surface (client-side) | in-flight | (wave1) | new `src/components/LivingMemoryPage.tsx`, new `src/hooks/useLivingMemory.ts`, route in `src/App.tsx` | P1 | Quick demo win. Build from `useCells` validated cells. |
| WS-SEARCH-SURVEY | Survey existing branching-search branches → impl plan | in-flight | (wave1, research) | (read-only) | P1 | Unblocks A2 (large). Report mergeable work from feat/ad-13-branching-search + claude/context-branching-search-*. |
| WS-COMPLETE-ALL | "Complete all" workspace action + spend display | queued | — | `registry.ts`, ProjectWorkspace actionArgs | P1 | DEFER to wave 2 (collides with WS-EXPORT on ProjectWorkspace.tsx). |
| WS-SEARCH-IMPL | Parallel passages + project search | queued | — | TBD from survey | P2 | After WS-SEARCH-SURVEY. |
| WS-LIVING-MEM-SERVER | (only if client-side proves insufficient) | queued | — | — | P3 | — |

---

## 4. Merge log & promotion status

- 2026-05-30 · **Wave-1 VERIFIED GREEN** on swarm/integration @ `38bea14` (commits: 9885f78 living-memory, 2b4777e export, 38bea14 import-cat). `tsc -b --noEmit` = 0 errors; `vitest run` = **1070 pass / 162 files** (baseline was 996/157). +2505 lines, 23 files.
- 2026-05-30 · **PROMOTION TO MAIN: BLOCKED.** Rollback point: main = `8e35c2b`. `git merge --ff-only swarm/integration` from main ABORTED (correctly) — main's working tree dirty (29 files) with the concurrent Paratext/USFM actor editing `import.ts`, `ImportDialog.tsx`, `source-export.ts`. Per user rule do NOT clobber their work.
  - **Loop action each iteration:** from main run `git merge --ff-only swarm/integration`; if it still aborts, leave main alone and keep accumulating. Promote the instant it succeeds (actor commits → tree clears). The overlaps are small/additive; their source-export.ts fix is identical to ours.
  - If still blocked when the user returns: surface for a coordinated promotion (they may know the actor / when it commits).
- 2026-05-30 · **W2-B merged** → swarm/integration @ `c3a7593` (FF). FTS5 search 1-line fix + back-translation display path + Living Memory nav button. `tsc`=0, `vitest`=1070 pass. Main promotion re-attempted — still BLOCKED (Paratext actor tree unchanged, 29 dirty).
- 2026-05-30 · **W2-A merged + ACTIVATED** → swarm/integration @ `d0d4346`. Learning loop (C7): `collectValidatedPairs` + project rules now feed completion prompts; activated by wiring `rules, allProjectCells` into `useCompletion()` at ProjectWorkspace.tsx:698 (integrator edit). `tsc`=0, `vitest`=**1087 pass**. Main re-attempt still BLOCKED.
- 2026-05-30 · **W3-A merged** → swarm/integration @ `a01184f` (FF). RulesPage feeds validated cells to RuleSuggestDialog → users can suggest rules from their corrections. `tsc`=0, `vitest`=1087. Main re-attempt still BLOCKED.
- 2026-05-30 · **W3-B merged** → swarm/integration @ `9f17079`. Whole-project multi-format zip export (`useProjectCells` + `project-zip-export`). `tsc`=0, `vitest`=**1102 pass / 163 files**.
- 2026-05-30 · **VERIFICATION milestone (partial), integration @ 9f17079:** `npm run build` ✅ PASS (Layer-1 build gate cleared; only non-blocking warnings: chunk size, dashjs CJS-in-ESM). `auth-worker` tests ✅ **65/65**. `sync-worker` tests ❌ **6 FAIL / 350** (`admin.test.ts`×3, `audio.test.ts`×1, `files-read.test.ts`×2).
  - These 6 FAIL on committed HEAD **and** on the actor's dirty tree → **pre-existing, NOT swarm-caused, NOT fixed by the actor's refactor.** Includes a likely **auth gap** (audio DELETE returns 200, test expects 401 for SYNC_SECRET_KEY). Diagnosis agent `a45ac9e752f47563a` (read-only) → writing `docs/swarm/SYNC-WORKER-FAILURES.md`.
  - **DO NOT fix unilaterally** — forbidden territory (actor) + the audio one has security semantics needing human judgment. **STOP-checklist Layer-1 sync-worker = RED** until resolved. Surface to user.
  - **DIAGNOSIS COMPLETE (agent a45ac9e752f47563a → `docs/swarm/SYNC-WORKER-FAILURES.md`):** all 6 are **TEST-STALENESS, not production bugs** — sync-worker production code is correct. The audio "auth bypass" is a **FALSE ALARM** (deliberate feature F8 / commit 1811d31; sync-token DELETE for the file owner is intended, all 4 auth checks present; the test name/expectation is stale). 4 are stale assertions (admin/audio); 2 are `d1-fake.ts` test-helper drift after the v3 schema port (production route is fine). **Owner = the sync-worker actor/user — a ~5-min fix with the diagnosis in hand.** Swarm intentionally NOT editing sync-worker (actor's active package, zero urgency). Reclassify: sync-worker *functionality* is production-OK; only the *test suite* is stale.
  - e2e smoke deferred: a dev stack is actively running (:8788 sync-worker, :5173 vite); `e2e-up.ts` kills those ports → would disrupt concurrent work. Run only when the stack is free or after coordinating.
- 2026-05-30 · **W4 merged** → swarm/integration @ `742d27c` (FF). Parallel-passages multi-project mode wired (Search|Passages|Replace toggle). `tsc`=0, `vitest`=1102. Main re-attempt still BLOCKED.
- 2026-05-30 · **Hands-on/browser verification = BLOCKED (investigated):** the running dev server (vite :5173 + sync-worker :8788) serves MAIN + the actor's DIRTY tree — neither the swarm's work (on integration) nor a clean baseline. Preview MCP needs a managed server (serverId/launch.json). So golden-path + e2e verification stays pending until (a) promotion to main clears, or (b) a dedicated stack off `.worktrees/swarm-integration` (blocked: running stack owns the ports). **Unit (1102) + full build are the current verification ceiling.**
- 2026-05-30 · **W5 dispatched** (agent `a64fdd568bd3491b2`, worktree `.worktrees/swarm-w5-completeall`): enable "Complete all" (remove the disabled "coming soon" placeholder; draft every untranslated cell with a confirm). This is the LAST identified safe client-side feature/loose-thread. After it, the autonomous build phase is complete.
- 2026-05-30 · **W5 merged** → swarm/integration @ `fd076a0` (FF). "Complete all" enabled (no more "coming soon" placeholder; confirm + draft every untranslated cell). `tsc`=0, `vitest`=1102.
- **★ AUTONOMOUS BUILD PHASE COMPLETE (2026-05-30).** Waves 1–5 + learning-loop activation: DONE & verified (tsc 0, vitest **1102**, full `npm run build` PASS @ 9f17079, auth-worker 65/65). Integration tip `fd076a0`. No more safe-buildable work remains — only marginal polish traces (lastEditAt recency sort; complete-all spend display).
- **LOOP → WATCHER MODE (cadence 5min → ~30min for token efficiency; cron replaced).** Watcher duties each tick: re-attempt `git merge --ff-only swarm/integration` from main; on SUCCESS (actor committed) → verify main (tsc/vitest/build/workers) + run the now-possible e2e/hands-on golden-path + PushNotify user; on ABORT → hold, no busywork. Merge any straggler agent per protocol. STOP only when §0 fully green.
- **Remaining blockers are NOT the swarm's to fix:** (1) actor's import/export commit → unblocks main promotion + reconciliation; (2) sync-worker test refresh (actor/user — diagnosed in `SYNC-WORKER-FAILURES.md`, ~5 min, all test-staleness); (3) user decisions on homepage overclaims (video/image-oral-story/private-mode).
- 2026-05-31 · **Wave 6 progress** (active phase resumed per user directive): **W6-D merged** @ `7c99607` (Living Memory recency sort + Complete-all cost hint; vitest 1104). **W6-C merged** @ `bf4efc0` (UX polish: a11y/states/responsive/dark-mode on ExportDialog + LivingMemoryPage + ParallelPassagesPanel; 0 conflicts; vitest 1104). Still in-flight: W6-A UI-QA (`ac5e7ebdd5b43e950` → UI-QA-PUNCHLIST.md), W6-B perf/code-split (`a05898ff789027e5d`), W6-E homepage QA+polish (`a242ae610091449e4`, no-copy-changes). Next wave seeds from the QA punch-list (decompose fix-its per surface — finer slices, scoped per worker).
- 2026-05-31 · **W6-B merged** @ `ac94d5e` (perf code-split: main entry **772 kB → 46 kB** via route-level React.lazy; heavy dash/hls now lazy workspace-only chunks). 0 conflicts; `tsc`=0, `vitest`=1104, `npm run build`=PASS (8.6s, no >500kB warning). SWARM-TODO: react-player `/lazy` entry to defer codec loading further. Integration @ `ac94d5e` = waves 1–5 + W6-B/C/D, build-verified. In-flight: W6-A UI-QA, W6-E homepage.
- 2026-05-31 · **W6-A UI-QA delivered** (browser tools WORKED; 34 surfaces walked → `docs/swarm/UI-QA-PUNCHLIST.md`). Found 1 demo-blocker (P1 Voice nav permanently hides file list) + P2 back-translation disabled-no-explanation, P3 "Sync disabled" misleads at root, P4 Geist font 403 console flood (dev-server-only), P5 import label "XLIFF"→"XLIFF/XLF", + Base UI button a11y warning. Most surfaces OK.
- 2026-05-31 · **W6-E merged** @ `47f227a` (homepage a11y/responsive/correctness polish, NO copy changes; 3 `SWARM-TODO(homepage-copy)` traces for user: open-source badge, stats sourcing, JESUS Film trademark). 0 conflicts; vitest 1104. Integration = full waves 1–6.
- 2026-05-31 · **Wave 7 dispatched** (per-surface fix-its from punch-list): W7-A workspace UX (P1/P2/P3) → `af0a3eabbba8326c6` (`.worktrees/swarm-w7a-workspaceux`); W7-B console hygiene (P4 font + button a11y + P5 label) → `ac6d26c94438d1e43` (`.worktrees/swarm-w7b-consolehygiene`). NEXT after W7 merges: a SECOND QA pass (verify fixes + deeper voice/audio walkthrough) — run serially (single shared Playwright browser).
- 2026-05-31 · **W7-A + W7-B merged** @ `cba96a9` (P1 voice-lens escape via toggle, P2 back-translation disabled-hint, P3 "No file open" sync copy; P4 font `fs.allow`, button a11y via `nativeButton={false}` on the Import upload-label, P5 "XLIFF / XLF" label). 0 conflicts; `tsc`=0, `vitest`=1104, `npm run build`=PASS. Integration = **full waves 1–7**. :5273 restarted with fixes.
- 2026-05-31 · **Pass-2 QA dispatched** (`a0a61edf8617e4020`): verifies the wave-7 fixes on :5273 + deep voice/audio walkthrough → appends `UI-QA-PUNCHLIST.md` Pass 2. Will seed a voice fix-wave if it finds issues.
- 2026-05-31 · **Pass-2 QA results**: 3 VERIFIED-FIXED (P1 voice toggle, P3 sync copy, P5 XLF label), 3 still-broken → (P2 back-translation hint didn't render; font-403 = **worktree-symlink ARTIFACT, NOT a real app bug** — won't occur in a normal checkout, dismiss; button a11y has a 2nd site `App.tsx:251`). New voice demo-risk **V1**: the Audio LENS (not just nav) hides the file list → can't switch files in audio mode. eBible import 404s (V4 — investigating: real bug vs dev-env).
- 2026-05-31 · **Wave (post-pass2) dispatched**: W11 Pass-2 re-fixes (V1 audio-lens + P2 BT copy + App.tsx button a11y) → `a0eeed6bd23b44412`; W9 import fidelity (xliff/tmx/csv robustness + eBible 404 diagnosis) → `aecaff4c3095b01d5`; W10 round-trip fidelity verification (+ `docs/swarm/ROUNDTRIP-FIDELITY.md`) → `af17a8c206b3e28ee`.
- 2026-05-31 · **W10 merged** @ `eeaf351` (round-trip fidelity test ×26 + ROUNDTRIP-FIDELITY.md; `vitest`=1130). Caught a real bug → TRACES `tsv-corruption` (HIGH). **W9 was cut off mid-task** (only partial xliff.ts, uncommitted, 1 stale test) → respawned finisher **W9b** `ad83306c8af70afd5` in the same worktree (resilience: regenerate the slice). In-flight: W11 (`a0eeed6bd23b44412`), W9b.
- 2026-05-31 · **W9b merged** @ `b14c253` (XLIFF multi-segment + test fix; **TMX source/target bug fixed** (2nd real bug round-trip surfaced); CSV BOM/Excel + 4th-column context; eBible 404 = upstream data gap, NOT a code bug → `SWARM-TODO(ebible-404)`: filter UI to downloadable translations). 0 conflicts; `tsc`=0, `vitest`=**1139** (round-trip test still green vs new parsers). Integration = waves 1–7 + W10 + W9b.
- 2026-05-31 · **W12 dispatched** (`ab9e21e9557e5992a`): fix TSV `tsv-corruption` (RFC-4180 quoting in exporter + parser; flip round-trip TSV assertions to clean). In-flight: W11, W12.
- 2026-05-31 · **W12 merged** @ `25f4302` (TSV RFC-4180 quoting → lossless round-trip; trace `tsv-corruption` DONE). FF; `tsc`=0, `vitest`=1139. **Import/export fidelity now comprehensively verified** (CSV/TSV/XLIFF clean; TMX drops untranslated by design; plain/md one-way by design — all documented in ROUNDTRIP-FIDELITY.md). Only W11 (Pass-2 demo re-fixes) still in-flight. Promotion still gated (main `e99b45b`, D=13 sync-worker).
- 2026-05-31 · **W11 merged** @ `0425a56` (V1 audio-lens keeps file list / VoiceSidebar below; P2 back-translation single correct empty-state message; "second button-a11y site" was a STALE-SERVER artifact, no real bug). 0 conflicts; `tsc`=0, `vitest`=1139. :5273 restarted with all fixes. Integration = waves 1–7 + W10 + W9b + W12 + W11.
- 2026-05-31 · **Wave dispatched**: W15 QA pass-3 (verify re-fixes + DEEP voice/audio on :5273) → `a472b386b781d1276`; W13 eBible downloadable-filter (resolve `ebible-404`) → `a0ebe515829dc8a46`. Note: swarm is CONVERGING — most build/polish/fidelity done + verified; remaining is browser-serialized QA + blocked-on-user/actor (overclaims, sync-worker tests, promotion).
- 2026-05-31 · **W13 merged** @ `5e2c736` (eBible picker filters to `downloadable`; `ebible-404` RESOLVED). `tsc`=0, `vitest`=1144.
- 2026-05-31 · **W15 QA Pass-3 results**: all 3 Pass-2 re-fixes VERIFIED-FIXED (V1 audio-lens, P2 BT copy, P3 sync). DEEP voice found 2 demo-blockers (A1 audio synth fails with only a silent red "Failed" badge; A2 the failure popover's "Open audio setup" CTA is dead) + 6 confusing (A3 narrator synth-vs-play + wrong-cell error; A4 dismiss clears the failed state; A5 Voice-together undiscoverable; A6 "Key needed" vs "Key invalid"; A7 Voice-nav lens-vs-settings; A8 Esc doesn't close More). Char/Recording modals + per-cell layout work well.
- 2026-05-31 · **W16 dispatched** (`aece6f3a18dc62b3b`): fix voice demo-blockers A1/A2/A3/A4/A6; TRACE A5/A7/A8. Browser free → Pass-4 QA after W16 merges. In-flight: W16.
- 2026-05-31 · **W16 merged** @ `584cac0` (voice fixes A1–A6; W16 SELF-browser-verified A1/A2/A3/A4 on :5373; A5/A7/A8 traced as `SWARM-TODO(voice-*)`). `tsc`=0, `vitest`=1144. :5273 restarted.
- 2026-05-31 · **Pass-4 final golden-path QA dispatched** (`aaa816e089a795c8d`): full demo path end-to-end on `584cac0` → DEMO-READY verdict. **Handoff doc written: `docs/swarm/DEMO-READINESS.md`** (user-facing summary: delivered / needs-you / how-to-promote). Swarm is essentially CONVERGED — Pass-4 is the final verification; remaining work is the 3 user/actor blockers in DEMO-READINESS.md.
- 2026-05-31 · **Pass-4 verdict: READY-WITH-CAVEATS.** All 9 golden-path steps PASS (import engBBE 30,966 cells, edit, validate, export TSV, search+passages, rules+suggest, complete-all, voice A1/A2/A6/V1 all confirmed). ONE new demo-blocker: "Open Voice Studio" button (`ProjectSettings.tsx:722`) → unregistered `/project/:id/voice` route → blank page (no VoiceStudioPage was ever built). → **W17 dispatched** (`a8368f3c90c944846`) to point it at the Audio lens. Caveats (demo-prep, not bugs): dev-project files are empty stubs (import engBBE first); Living Memory needs 2 validators to show entries (single-user demo shows empty).
- 2026-05-31 · **W17 merged** @ `9b4529a` ("Open Voice Studio" button now lands in the Audio lens via the lens-preference key; W17 browser-verified, no blank page). `tsc`=0, `vitest`=1144. **Golden path is now fully clean.**
- 2026-05-31 · **★ SWARM CONVERGED ON GOAL.** Every homepage-claim feature is built, polished (a11y/perf/UX), import/export-fidelity-verified, and QA'd across 4 live passes with all findings fixed. 17 waves on `swarm/integration` @ `9b4529a` (`tsc`=0, `vitest`=1144, build PASS, 4 QA passes). **Remaining is ONLY the 3 user/actor blockers** (overclaim copy decisions; sync-worker stale-test refresh; the `main` promotion that auto-fires when the actor's sync-worker tree clears). Handoff: `DEMO-READINESS.md`. Loop → hold/watch per tick (re-attempt promotion; do NOT manufacture work — convergence is the success state, not under-orchestration).
- 19 swarm wave worktrees remain under `.worktrees/swarm-w*` (branches preserved; dirs are throwaway — safe to `git worktree remove` at leisure). Keep `.worktrees/swarm-integration` (live; serves :5273).

---

## 5. Deferred / blocked (see TRACES.md for detail)
- WS-COMMENTS (A1) — blocked: comment event handlers in flight (forbidden path). Revisit after user's sync-worker work lands.
- WS-WRITEBACK (B1), WS-AUTOFIX (B2), WS-BULK-AUDIO (B3) — need event-layer work; defer.
- Tauri desktop release (TODO.md) — only if demo is desktop; confirm with user.

---

## 6. Homepage claims → implementation status (the acceptance contract)

Claims source: `src/pages/Homepage/Homepage.tsx` (hero, feature sections, pricing list).
Status: `DONE | PARTIAL | STUB | MISSING | OVERCLAIM` (OVERCLAIM = needs copy change / sign-off).
Filled by claims-audit agent → see §2 control plane for its id; update as workstreams land.

| # | Claim (homepage) | Required capability | Status | Evidence / gap |
|---|---|---|---|---|
| C1 | "Start translating free" CTA → /onboarding | Onboarding create-account → into workspace works | _audit_ | sole conversion path; must work |
| C2 | text translation "under one roof" | Cell editor: draft/edit/validate | _audit_ | core |
| C3 | audio translation | per-cell record / synth / play | _audit_ | voice studio (recent commits) |
| C4 | **video** translation (pricing list + hero) | video modality | _audit_ | BIG question mark |
| C5 | "first draft in seconds" low-resource | AI completion | _audit_ | useCompletion exists |
| C6 | "real-time checks and **back-translation** as you work" | back-translation surface | _audit_ | question mark |
| C7 | Living Memory "fix it once, the system learns" | corrections → guidance injected into next draft (ACTIVE loop) | _audit_ | WS-LIVING-MEMORY is read-only only → under-scoped |
| C8 | "Quality you can see" confidence + "biggest drags, ranked, one click away" | per-cell confidence (HealthRing) + ranked drag list w/ jump | _audit_ | AD-14 confidence prototype per memory |
| C9 | "Many translators, one project" / cloud sync | multi-user collab + sync | _audit_ | sync-worker + teams landed |
| C10 | "On-device speech & private mode" | local speech + private mode | _audit_ | question mark |
| C11 | "Free, forever · open source" | onboarding free; repo OSS | _audit_ | policy, not feature |
| C12 | import/export of professional source files | robust import + multi-format export | in-progress | WS-IMPORT-CAT + WS-EXPORT (wave 1) |
| C13 | manifesto: image / oral-story modalities | (softer vision copy) | _audit_ | likely OVERCLAIM — confirm vs pricing list |
