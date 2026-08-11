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

## 2026-08-10 — dead-code deletion run (chore/code-health-2026-08-10)

Landed: five zero-importer files removed (336 lines) — see commit
`chore(code-health): delete confirmed-dead source modules`.

- **`src/lib/sync/sync-debug.ts`** (125 lines) — a compatibility surface for an older
  Yjs-provider debug logger. Full-repo grep found no call sites outside its definition.
- **`src/context/EditorScrollContext.tsx`** — remove the unused, deprecated
  `pendingGroup`/`pendingSection` fields after confirming no consumer destructures them.
- **`src/components/ExamplePanel.tsx`** — remove unused, deprecated
  `expanded`/`onExpandedChange` props and their only-call-site attributes; the
  `examplesExpanded` state remains live.

Re-verify these candidates with fresh greps before deleting them.

## Environment note — `pnpm test:e2e:smoke` in the Claude Code web sandbox

This run could not complete the smoke suite because the sandbox lacks a working Docker
daemon and its concurrent local Wrangler stacks intermittently crash under load. This was
reproduced on a clean `origin/dev` checkout, so it is an environment limitation rather than
a code regression. `pnpm lint`, `pnpm build`, `pnpm test`, and the sync-worker tests passed.
