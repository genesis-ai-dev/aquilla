# Code-health candidate ledger

Bigger opportunities surfaced by `/code-health` runs that exceeded that run's budget
(≤ ~300 changed lines, ≤ ~8 files). Not yet done. Prune an entry once a later run
completes it.

## 2026-08-11 — dead-code survey (chore/code-health-2026-08-11)

The survey that produced this run's deletions turned up more dead code than the
budget allowed. The 8 smallest/safest candidates were deleted this run; the rest are
listed here.

- **`src/components/CellActionsMenu.tsx`** (150 lines) — zero call sites in `src/`.
  Friction: exceeded this run's file/line budget once combined with the picks above.
  Proof needed before deleting: confirm `e2e/specs/editor/cell-actions-menu-history.smoke.spec.ts`
  stays skipped (its own comment already says the UI path was removed and this
  component is "pending deletion") — do not touch the spec file itself, just verify
  it remains untouched/skipped in the same run that deletes the component.

- **`src/components/sidebar/ProgressDot.tsx`** (65 lines, exports `ProgressDot`) —
  zero call sites in `src/`; `FileSectionGrid` replaced the grid that used it.
  Friction: same as above, budget. Proof needed: confirm
  `e2e/specs/editor/sidebar-progress-dot-navigate.smoke.spec.ts` (whose own comment
  says the old ProgressDot grid was replaced) stays untouched/skipped.

- **`src/hooks/useSubscribedConcepts.ts`** (140 lines) — no real importers; only
  mentioned in comments in `TermbaseSharingSection.tsx` and `useRules.ts` describing
  intended-but-never-wired architecture. Friction: budget; also worth a quick check
  that those two comments aren't describing near-term planned work before deleting.
  Proof needed: re-grep at deletion time, confirm the comments still describe
  unrealized plans rather than an in-flight feature.

- **`src/lib/sync/settings-read.ts`** (70 lines) + **`src/lib/sync/settings-read-types.ts`**
  (36 lines) — an abandoned "Phase 2b" typed wrapper pair around
  `project-settings.ts`; `useProjectSettings.ts` imports the underlying module
  directly instead. Friction: budget (two files). Proof needed: same zero-importer
  grep across `src/`, worker packages, `e2e/`, `scripts/`.

- **`src/lib/timeline/diarization-loader.ts`** (122 lines, exports
  `DIARIZATION_ASSET_BASE`, `diarize`, etc.) — the in-browser WASM diarizer,
  superseded by server-side diarization (`infra/modal/diarization.py`) per
  `docs/superpowers/specs/2026-06-03-diarization-modal-pyannote-design.md` ("Approved
  direction (supersedes the in-browser wasm approach for B3)"). Friction: budget;
  also worth confirming the Modal migration actually shipped (not just approved)
  before deleting the fallback. Proof needed: zero importers, and confirm no feature
  flag still routes to the WASM path.

- **`src/components/Dashboard.tsx`** (466 lines) — a pre-org-model project dashboard,
  apparently superseded by `src/components/org/OrgHome.tsx`; no import found anywhere
  (route table in `App.tsx` doesn't reference it). Friction: at 466 lines this alone
  would consume most of a single run's budget — worth a dedicated pass rather than
  bundling with smaller deletions. Proof needed: zero importers/JSX usage
  (component + string route matches), and confirm `OrgHome.tsx` covers the same
  surface before deleting.

## 2026-08-11 — type-tightening + complexity survey (chore/code-health-2026-08-11, second run)

This run removed 13 redundant non-null assertions (type-tightening theme). The same
survey turned up a complexity-reduction (theme 2) candidate and one more type-tightening
spot, both deferred rather than mixed into the single-theme budget.

- **`src/lib/frontier/roles.ts`** (175 lines) — `roleName()` (lines ~115–126) and
  `roleDescription()` (lines ~136–147) are two parallel `switch` statements keyed on
  the same 7 numeric role levels (100/200/…/700). Friction: this run's budget was
  already spent on the type-tightening theme; picking both in one PR would mix themes.
  Proof needed: collapse to a single `Record<RoleLevel, { name; description }>` lookup
  with `roleName`/`roleDescription` kept as thin accessors with identical signatures
  and return values — `pnpm build` (return-type match) plus `pnpm test` (no test file
  changes) is the proof.

- **`src/components/CellAudioButton.tsx`** (lines 74–102) — `errorIcon()` and
  `errorTooltip()` are two switch statements keyed on the same `kind` string union;
  same lookup-table shape as above. Friction: budget, and slightly higher risk since
  the switches return JSX rather than plain values — worth its own careful pass.
  Proof needed: same exported signatures/return types, `pnpm build` + `pnpm test`
  green with no test changes.

- **`src/lib/text/word-diff.ts`** (~lines 32–56) — ~14 dense non-null assertions
  (`text[i]!`-style) inside a tight DP loop, same "loop condition already bounds the
  index" story as the ones fixed this run in `src/lib/biblica/sentence-cuts.ts`.
  Friction: skipped this run — the density of assertions in one tight loop raised the
  risk of a transcription typo during a bulk edit for a line-count-only benefit; wants
  a dedicated, careful pass rather than being bundled with the other easier fixes.
  Proof needed: `pnpm build` clean (confirms TS still infers the narrower type without
  the assertions) plus `pnpm test` green, no test files touched.
