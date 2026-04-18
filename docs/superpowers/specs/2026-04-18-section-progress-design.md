# Section progress & validation visibility — design

**Date:** 2026-04-18
**Status:** design approved, ready for plan
**Worktree:** `.worktrees/section-progress`

## Problem

Users can't easily tell what's finished or find unfinished work in a project. The
VS Code extension (`codex-editor`) solves this with a chapter/subsection accordion
in the editor header showing per-section progress for text and audio, with
multi-validator awareness. We want equivalent value in the web app without
duplicating the entire desktop UI.

"Easy to find unfinished work or see that things are finished" is the
high-value outcome.

## Goals

- At-a-glance project status in the sidebar: which sections of which files are
  done, partial, or untouched.
- One-click "jump to next unfinished" within the current file.
- Configurable multi-level validation threshold per project (text + audio),
  matching the desktop app's `validationCount` / `validationCountAudio`.
- Groundwork for audio tracking without shipping audio capture in this pass.

## Non-goals

- Populating audio data. Fields are plumbed, but no capture flow, storage, or
  UI surface for audio appears until any cell has actual audio data.
- Milestone (section) editing — renaming sections from the navigation UI.
  Desktop has this; we don't need it v1.
- A modal section-accordion dropdown in the editor header. We chose
  sidebar-grid + "next unfinished" button instead for lower surface area.
- Changing `validationStatus` derivation — already correct, just needs
  threshold awareness.
- Cross-file "next unfinished" — current file only. v2.

## File-type and project-origin agnostic

This design works identically for GitLab-imported projects, newly-created
projects, and any future parser (subtitles, plain text, JSON). It keys off
`cell.group` which every parser populates; cells without a group fall under
"Ungrouped" and degrade to a single dot.

`validationCount` defaults to `1` when unset, so projects created before this
feature (or that never visit Settings) treat "one validator is enough."

## Reference implementation

From `~/frontierrnd/codex-editor`:
- `ChapterNavigationHeader.tsx` — header dropdown trigger (not adopted here)
- `MilestoneAccordion.tsx` — per-milestone progress rendering with accordion +
  expanded subsections (pattern adapted into the sidebar grid)
- `ProgressDots.tsx` — compact text + audio dots, the core visual idiom
- `utils/progressUtils.ts` — `getProgressColor`, `getProgressDisplay`,
  `deriveSubsectionPercentages`, `getCompletedValidationLevels` — **ported
  verbatim** to preserve color semantics
- `types/index.d.ts` — `validationCount` / `validationCountAudio` at project
  meta level (flat top-level fields, not nested)

## Data model

### Project-level additions

Flat top-level fields on `ProjectRecord`, matching desktop manifest exactly:

```ts
interface ProjectRecord {
  // ... existing fields
  validationCount?: number        // default 1, clamped [1, 15]
  validationCountAudio?: number   // default 1, clamped [1, 15]
  hasAnyAudioData?: boolean       // cached flag; set to true when any cell first writes audio. Stored (not re-derived on every load) to avoid scanning every file's Y.Doc.
}
```

Clamping happens on read (`readValidationCount(project)`), not on write, so
legacy projects with missing/out-of-range values still work.

### Cell audio fields (plumbed only)

`CellData` already carries `activeValidators: string[]` for text. Add parallel
audio fields that stay empty until audio shipping:

```ts
// on CellData (hooks/useCells.ts)
audioUrl?: string               // placeholder — no capture flow yet
audioActiveValidators?: string[]
```

No population code in this pass. The presence of `audioUrl` on any cell is
what flips `project.hasAnyAudioData` to true.

### Section model

```ts
export interface SectionInfo {
  label: string      // cell.group value, "Ungrouped" fallback
  cellIds: string[]  // preserved in file order
}

export interface SectionProgress {
  label: string
  textCompleted: number        // 0..100 — % cells with non-empty translation
  textValidated: number        // 0..100 — % cells with ≥ validationCount distinct validators
  textValidationLevels: number[]  // [% ≥1 validator, % ≥2, …] up to max 15 levels
  audioCompleted: number       // 0 until audio ships
  audioValidated: number
  audioValidationLevels: number[]
  hasAudio: boolean            // any cell in this section has audioUrl
}
```

`textValidationLevels[i]` = percentage of cells whose
`activeValidators.length > i`. Used to drive the progressive darkness effect
on the dot (more distinct validators → darker blue).

## Architecture

```
src/
├── lib/
│   ├── progress/
│   │   ├── progress-colors.ts       port of getProgressColor + getProgressDisplay
│   │   ├── section-index.ts         buildSectionIndex(cells): SectionInfo[]
│   │   └── section-progress.ts      computeSectionProgress(cells, validationCount): SectionProgress[]
│   └── parsers/types.ts             add validationCount, validationCountAudio, hasAnyAudioData, audio fields
├── hooks/
│   ├── useSectionProgress.ts        active file — memoized over cells + validationCount
│   └── useNextUnfinished.ts         returns { sectionLabel, cellIndex } | null
└── components/
    ├── sidebar/
    │   ├── FileSectionGrid.tsx      N dots per file row (only when expanded)
    │   └── ProgressDot.tsx          single text+audio dot with darkness by level
    ├── NextUnfinishedButton.tsx     icon button for WorkspaceHeader
    └── ProjectSettings/
        └── ValidationSettingsSection.tsx  two number inputs + helper text
```

## Data flow (lazy)

```
User expands a file row in ExpandableFileList
  → FileSectionGrid mounts with fileId
      → useSectionProgress(fileId, validationCount)
          → loadFileDoc(fileId)          [ref-counted; shares with editor if open]
          → await persistence.once("synced")
          → read order + cells + activeValidators
          → buildSectionIndex → SectionInfo[]
          → computeSectionProgress → SectionProgress[]
          → render FileSectionGrid dots
```

Because `loadFileDoc` is ref-counted in `src/lib/store/file-doc.ts`, a sidebar
expand of file A while the editor is already on file A shares the same Y.Doc
— no duplicate hydration.

## Interaction details

### Sidebar grid (inside expanded file accordion)

- Flex-wrap row of small (~8px) dots, one per section in file order.
- Each dot is a pair: audio on top, text on bottom. Audio sub-dot only
  renders when `project.hasAnyAudioData`.
- Dot color via ported `getProgressColor`:
  - muted 25% — no cells translated
  - muted 80% — partial translation OR partial validation
  - blue — fully translated, not yet validated
  - dark blue — fully translated + ≥1 validator level (darkens with levels)
  - warning/gold — fully validated at project's `validationCount` threshold
- Click a dot → jumps to **first cell** of that section (not first
  unfinished) via `editorScroll.requestScrollToGroup(section.label)`.
- Hover tooltip: `Chapter 3 — 12/20 translated · 5/20 validated (req. 2)`
- Cap: if a file has > 40 sections, wrap; the file row gets a scoped
  `max-h` with scroll inside the accordion.

### Next-unfinished button (WorkspaceHeader)

- Icon button labeled `Next →` (lucide `ArrowRight`).
- Scope: **current file only** for v1.
- Enabled iff editor is open AND at least one cell is unfinished.
- Unfinished = `!cell.translated || cell.activeValidators.length < validationCount`.
- Click → find next such cell after `editorRef.current.currentIndex` (fallback
  0, wrap to start if we hit end), then `editorRef.current.scrollToCellIndex(idx)`.
- Keybinding: `Cmd/Ctrl + .`. Skip if it conflicts with existing bindings.

### Project Settings — ValidationSettingsSection

- Two numeric inputs (range 1–15), labeled:
  - "Required validators (text)"
  - "Required validators (audio)"
- Audio input: disabled + muted when `!project.hasAnyAudioData`, helper text
  "Enabled once audio translations exist."
- Help text under the text input: "Cells need this many distinct validators
  to count as fully validated."
- Save is immediate via existing `updateProject` on change.

## Error handling

- **Doc load failure in `useSectionProgress`** → render empty grid row with a
  subtle retry affordance. Matches current `useFileDoc` behavior.
- **Invalid `validationCount`** (0, 16, NaN, undefined) → clamped to `[1, 15]`
  on read via helper. Not on write, so legacy data remains readable.
- **Legacy cells without `activeValidators`** → treated as `[]`. Cell with a
  translation but no validators never hits the validated threshold (default 1),
  so it shows as blue — consistent with desktop behavior.

## Testing

Unit tests (vitest):

- `progress-colors.test.ts` — port desktop boundary cases: 0/0, 50%/0,
  100%/0 → blue, 100%/50 with 1 level → dark blue, 100%/100 with threshold
  met → warning.
- `section-index.test.ts` — groups produced in file order; "Ungrouped"
  fallback; empty-file edge case.
- `section-progress.test.ts` — multi-validator counting from
  `activeValidators[]`; threshold application; `validationLevels` array
  semantics match desktop.
- `useNextUnfinished.test.tsx` — wrapping past end returns null; skips
  validated cells; respects threshold; handles empty file.

No new integration tests — all UI is thin rendering over tested data
producers.

## Manual verification checklist

- [ ] Open GitLab-imported project → sidebar shows file list; expanding a
      file shows dot grid.
- [ ] Open newly created empty project → sidebar shows "no files yet"; after
      importing one USFM file, grid appears on expand.
- [ ] Click a grid dot → editor scrolls to that section's first cell.
- [ ] Hover dot → tooltip shows accurate translated/validated counts.
- [ ] Validate one cell as user A → with `validationCount=2`, dot stays
      partial; set to `1`, dot immediately jumps to validated color.
- [ ] Click "Next →" in a half-finished file → jumps to first
      untranslated/unvalidated cell; repeated clicks advance.
- [ ] `Cmd+.` triggers "Next →" when focus is in editor.
- [ ] No audio data anywhere → audio sub-dots never render; audio settings
      input stays disabled.
- [ ] Project Settings writes persist across page reload.

## Open questions for plan phase

- Exact Tailwind color tokens for the four progress states — desktop uses
  VS Code theme variables we don't have. Map to our `bg-muted`,
  `bg-blue-500`, `bg-blue-700`, `bg-amber-500` or equivalent.
- Whether the `Cmd+.` keybinding conflicts with anything existing. Audit
  during plan.
