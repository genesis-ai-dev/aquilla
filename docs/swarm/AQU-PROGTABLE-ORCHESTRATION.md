# WS-Progress-table Swarm — Orchestration

Resumes the PAUSED WS-Progress-table workstream from AQU-DASHBOARD-ORCHESTRATION.md.
Serialized, same component. Order (user-fixed): **AQU-493 → 499 → 500 → 490 → 492**.

- Integration branch: `swarm/aqu-progtable-integration` (off `dev` tip `61794a79e`).
- Promotion target: **dev** (this repo trunks on dev, not main). Orchestrator-only merges.
- Team: Aquilla (`de0f5d29-418f-4f62-ade7-02f77974c598`). Project: Prototype Debugging.

## §0 STOP checklist (the goal)
- [ ] All 5 issues (493, 499, 500, 490, 492) at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before promotion.
- [ ] Each fix verified on the real dev stack (live UI) before → Fixed; spec reconciled per /issue Step 2.5.
- [ ] Promoted to dev only with dev's tree clean apart from recorded protected files.
- [ ] Every remaining gap traced in TRACES.md.

## §EXCLUDED / protected
- Protected/untracked (do not touch): `.migrate-state.json.bak-local-jun25`.
- SCOPE LOCK: only these 5 issues. No other Prototype Debugging Todos.

## §1 Operating model
- **Serialize hard** — all 5 mutate `src/components/org/ProjectOverview.tsx`. One sonnet agent at a
  time, manual worktree off the LIVE integration tip. Orchestrator claims (→ Dispatched, assign me)
  before spawning, merges to integration on green, then unlocks the next. Agents never push/deploy/promote.
- Live-UI verification centralized after code lands + green gates.

## Surface (shared context, injected into every brief)
- **Primary file:** `src/components/org/ProjectOverview.tsx` (837 lines @ base).
  - Progress card (validation/audio tiles + bars): ~lines 511–594. `TODO(AQU-168)` @542 = AQU-490 hook.
  - Per-file breakdown table: ~lines 596–650. Rows sorted `b.cellCount - a.cellCount`, capped `FILE_ROW_CAP`.
    Row render @617–631: `{f.filledCount}/{f.approvedCount}/{f.cellCount} · {f.wordCount}w` (AQU-492).
- **Test:** `src/components/org/ProjectOverview.test.tsx`. File row shape:
  `{ fileId, projectId, name, fileType, sourceLanguage, targetLanguage, cellCount, filledCount, approvedCount, wordCount, lastEditAt }`.
- **Portfolio model/helpers:** `src/lib/frontier/portfolio.ts` (`PortfolioProject`, `validatedPct`, `audioPct`, …).
- **Validation counts:** `src/lib/progress/read-validation-count.ts` (`readValidationCountAudio`; AQU-298
  flagged `validationCountAudio` for deletion → AQU-490 must confirm audio-validation exists server-side or blocked).
- **Export permission** (AQU-500): reuse the org export-floor pattern (`exportMinRole`) — same as WS-Perms AQU-485/487 used.

## §3 Per-issue status (final)
| # | Issue | Scope | Branch | Status |
|---|-------|-------|--------|--------|
| 1 | AQU-493 | chapter/verse nested rollup (book›chapter›verse), generic ref detection | swarm/aqu-493 | **Fixed** ✓ merged |
| 2 | AQU-499 | file-breakdown table sort/filter (default last-updated; canonical; alphabetical) | swarm/aqu-499 | **Fixed** ✓ merged |
| 3 | AQU-500 | CSV export / copy-to-clipboard of progress; respects export perm | swarm/aqu-500 | **Fixed** ✓ merged |
| 4 | AQU-490 | audio-validation % separate from text-validation | swarm/aqu-490 | **Todo, blocked-by AQU-508** (honest partial merged) |
| 5 | AQU-492 | file-breakdown columns: clear headers/units + tidy layout | swarm/aqu-492 | **Fixed** ✓ merged |

Sub-issue filed: **AQU-508** (server: per-cell audio-validated count) — blocker for AQU-490.

## §M Merge log
- 2026-07-08 · AQU-493 · swarm/aqu-493 · `e94ba81f7` · tsc0 · vitest 95/95 (progress surface)
- 2026-07-08 · AQU-499 · swarm/aqu-499 · `b21f01017`+`789df014f` · tsc0 · vitest 114/114
- 2026-07-08 · AQU-500 · swarm/aqu-500 · `242bc9c13` · tsc0 · vitest 130/130
- 2026-07-08 · AQU-490 · swarm/aqu-490 · `dbbc116db` · tsc0 · vitest 130/130 (honest partial)
- 2026-07-08 · AQU-492 · swarm/aqu-492 · `64dc17c00` · tsc0 · vitest 132/132
- **Promotion:** integration `64dc17c00` fast-forwarded to `dev` 2026-07-08. Gate: `npm run build` ✓ (built 8.62s, brand aquilla OK), `src/components/org/` 143/143, tsc -b 0. **Unpushed.**

## FINAL STATUS — 2026-07-08
- 4/5 issues **Fixed** and on local `dev` (unpushed): AQU-493, 499, 500, 492.
- AQU-490: honest partial merged (relabel "Audio"→"Has Audio", "Audio Validated: N/A"); real metric **blocked** on server work → **AQU-508** (Todo, High). AQU-490 = Todo, blocked-by 508.
- **Live-UI QA: NOT run** (unit gates + build only). SWARM-TODO click-paths left in-code for each. Verify:
  - 493: expand a file row → chapter/verse rollup sums to file %.
  - 499: Sort dropdown → Canonical = Genesis-before-Exodus; filter box narrows rows.
  - 500: export-permitted role sees Copy/Download CSV → paste matches on-screen order; unpermitted role sees none.
  - 490: audio project shows "Has Audio" + "Audio Validated: N/A"; text-only shows neither.
  - 492: labeled header row (File/Progress/Filled/Approved/Total/Words) aligns with rows.
- Full `vitest run` timed out (7min infra limit) — NOT a failure; scoped + org-dir suites green, tsc0, build green.
- Nothing pushed to origin.

## Notes
- AQU-499: prior file sort was `b.cellCount - a.cellCount` (NOT "total cells control" — none existed). OrgHome/ProjectsList `sortProjectsByLens` is PROJECT-level and was untouched.
- Full ProjectOverview.tsx now ~1150+ lines (was 837) — over the ~500 guideline; pre-existing debt compounded by 5 features on one card. Candidate for extraction later.
