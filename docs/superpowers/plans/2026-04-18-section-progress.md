# Section Progress & Validation Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-section progress visualization (dots per section in sidebar), a "next unfinished" button in the workspace header, and configurable multi-level validation thresholds — so users can see at a glance what's done and jump to unfinished work.

**Architecture:** Port the progress-color semantics from the desktop `codex-editor` app. Derive sections from the existing `cell.group` field; derive validation levels from `cell.activeValidators[]` (already populated from `__source.metadata.edits[].validatedBy[]`). Store required-validator count as flat fields on `ProjectRecord` matching the desktop manifest. Lazy-load section progress per file when its sidebar row expands, using the existing ref-counted `loadFileDoc` so we share the Y.Doc with the editor when the same file is open.

**Tech Stack:** React 19 hooks, Y.Doc (via existing `loadFileDoc`), Tailwind + Base UI (Dialog/Menu already in use), vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-04-18-section-progress-design.md`

**Worktree:** Already created at `.worktrees/section-progress` on branch `feat/section-progress`. All task commands run from that worktree's root unless otherwise noted.

---

## File map

New files:
- `src/lib/progress/progress-colors.ts` — port of `getProgressColor`, `getProgressDisplay`, `getCompletedValidationLevels`
- `src/lib/progress/progress-colors.test.ts`
- `src/lib/progress/section-index.ts` — `buildSectionIndex`
- `src/lib/progress/section-index.test.ts`
- `src/lib/progress/section-progress.ts` — `computeSectionProgress`
- `src/lib/progress/section-progress.test.ts`
- `src/hooks/useSectionProgress.ts`
- `src/hooks/useSectionProgress.test.tsx`
- `src/hooks/useNextUnfinished.ts`
- `src/hooks/useNextUnfinished.test.tsx`
- `src/components/sidebar/ProgressDot.tsx`
- `src/components/sidebar/FileSectionGrid.tsx`
- `src/components/NextUnfinishedButton.tsx`
- `src/components/ProjectSettings/ValidationSettingsSection.tsx`

Modified files:
- `src/lib/parsers/types.ts` — add fields to `ProjectRecord`
- `src/hooks/useCells.ts` — accept `validationCount` arg
- `src/components/ProjectWorkspace.tsx` — thread `validationCount`, add NextUnfinishedButton, add keybinding
- `src/components/ExpandableFileList.tsx` — render `FileSectionGrid` in expanded rows
- `src/components/ProjectSettings.tsx` — mount `ValidationSettingsSection`

---

## Task 1: Add `validationCount` / `validationCountAudio` fields to ProjectRecord

**Files:**
- Modify: `src/lib/parsers/types.ts`
- Create: `src/lib/progress/read-validation-count.ts`
- Test: `src/lib/progress/read-validation-count.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/progress/read-validation-count.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { readValidationCount, readValidationCountAudio } from "./read-validation-count"

describe("readValidationCount", () => {
  it("defaults to 1 when undefined", () => {
    expect(readValidationCount({} as any)).toBe(1)
  })
  it("clamps to min 1", () => {
    expect(readValidationCount({ validationCount: 0 } as any)).toBe(1)
    expect(readValidationCount({ validationCount: -5 } as any)).toBe(1)
  })
  it("clamps to max 15", () => {
    expect(readValidationCount({ validationCount: 99 } as any)).toBe(15)
  })
  it("passes valid values through", () => {
    expect(readValidationCount({ validationCount: 3 } as any)).toBe(3)
  })
  it("handles NaN", () => {
    expect(readValidationCount({ validationCount: NaN } as any)).toBe(1)
  })
})

describe("readValidationCountAudio", () => {
  it("defaults to 1 when undefined", () => {
    expect(readValidationCountAudio({} as any)).toBe(1)
  })
  it("clamps to [1, 15]", () => {
    expect(readValidationCountAudio({ validationCountAudio: 0 } as any)).toBe(1)
    expect(readValidationCountAudio({ validationCountAudio: 20 } as any)).toBe(15)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/progress/read-validation-count.test.ts`
Expected: FAIL with "Cannot find module './read-validation-count'"

- [ ] **Step 3: Add fields to ProjectRecord**

Edit `src/lib/parsers/types.ts`. Find the `ProjectRecord` interface (grep for `interface ProjectRecord`) and add these fields before the closing brace:

```ts
  /** Required distinct validators for a text cell to count as "fully validated". Clamped [1, 15]. Default 1. Mirrors desktop manifest. */
  validationCount?: number
  /** Required distinct validators for audio. Clamped [1, 15]. Default 1. */
  validationCountAudio?: number
  /** Cached flag — set true when any cell first writes audio. Avoids scanning every file's Y.Doc on load. */
  hasAnyAudioData?: boolean
```

- [ ] **Step 4: Create the reader helper**

Create `src/lib/progress/read-validation-count.ts`:

```ts
import type { ProjectRecord } from "@/lib/parsers/types"

const MIN = 1
const MAX = 15

function clamp(raw: number | undefined): number {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return MIN
  if (raw < MIN) return MIN
  if (raw > MAX) return MAX
  return Math.floor(raw)
}

export function readValidationCount(project: Pick<ProjectRecord, "validationCount">): number {
  return clamp(project.validationCount)
}

export function readValidationCountAudio(project: Pick<ProjectRecord, "validationCountAudio">): number {
  return clamp(project.validationCountAudio)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/progress/read-validation-count.test.ts`
Expected: all PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/progress/read-validation-count.ts src/lib/progress/read-validation-count.test.ts
git commit -m "$(cat <<'EOF'
feat(progress): add validationCount fields + clamping reader

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Port `getProgressColor` / `getProgressDisplay` from desktop

**Files:**
- Create: `src/lib/progress/progress-colors.ts`
- Test: `src/lib/progress/progress-colors.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/progress/progress-colors.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { getCompletedValidationLevels, getProgressColor, getProgressDisplay } from "./progress-colors"

describe("getCompletedValidationLevels", () => {
  it("returns 0 when levels missing", () => {
    expect(getCompletedValidationLevels(undefined, 3)).toBe(0)
    expect(getCompletedValidationLevels([], 3)).toBe(0)
  })
  it("returns 0 when required is missing", () => {
    expect(getCompletedValidationLevels([100, 100], undefined)).toBe(0)
  })
  it("counts consecutive 100% levels up to required", () => {
    expect(getCompletedValidationLevels([100, 100, 50, 0], 4)).toBe(2)
  })
  it("stops at first incomplete level", () => {
    expect(getCompletedValidationLevels([100, 80, 100], 3)).toBe(1)
  })
})

describe("getProgressColor", () => {
  it("no content → faint muted", () => {
    expect(getProgressColor(0, 0)).toBe("text-muted-foreground/25")
  })
  it("partial translation → muted 80%", () => {
    expect(getProgressColor(0, 50)).toBe("text-muted-foreground/80")
  })
  it("fully translated, no validation → blue", () => {
    expect(getProgressColor(0, 100)).toBe("text-charts-blue")
  })
  it("fully translated, ≥1 validator level → dark blue", () => {
    expect(getProgressColor(50, 100, [100, 50], 2)).toBe("text-charts-blue-dark")
  })
  it("fully validated → warning", () => {
    expect(getProgressColor(100, 100)).toBe("text-editor-warning-foreground")
  })
})

describe("getProgressDisplay", () => {
  it("returns colorClass, title, completedValidationLevels", () => {
    const d = getProgressDisplay(50, 100, "Text", [100, 50], 2)
    expect(d.colorClass).toBe("text-charts-blue-dark")
    expect(d.completedValidationLevels).toBe(1)
    expect(d.title).toContain("Translation: 100%")
    expect(d.title).toContain("Validation: 50%")
    expect(d.title).toContain("1 level")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/progress/progress-colors.test.ts`
Expected: FAIL with "Cannot find module './progress-colors'"

- [ ] **Step 3: Port the implementation**

Create `src/lib/progress/progress-colors.ts`:

```ts
export type ProgressColorClass =
  | "text-editor-warning-foreground"
  | "text-charts-blue"
  | "text-charts-blue-dark"
  | "text-muted-foreground/80"
  | "text-muted-foreground/25"

export function getCompletedValidationLevels(
  validationLevels?: number[],
  requiredValidations?: number,
): number {
  if (!validationLevels || validationLevels.length === 0) return 0
  if (!requiredValidations) return 0
  let completedLevels = 0
  for (let i = 0; i < Math.min(validationLevels.length, requiredValidations); i++) {
    if (validationLevels[i] >= 100) completedLevels++
    else break
  }
  return completedLevels
}

export function getProgressColor(
  validatedPercent: number,
  completedPercent: number,
  validationLevels?: number[],
  requiredValidations?: number,
): ProgressColorClass {
  if (validatedPercent >= 100) return "text-editor-warning-foreground"
  if (completedPercent >= 100) {
    const completedLevels = getCompletedValidationLevels(validationLevels, requiredValidations)
    if (completedLevels >= 1) return "text-charts-blue-dark"
    return "text-charts-blue"
  }
  if (validatedPercent > 0 && validatedPercent < 100) return "text-muted-foreground/80"
  if (completedPercent > 0) return "text-muted-foreground/80"
  return "text-muted-foreground/25"
}

export function getProgressTitle(
  validatedPercent: number,
  completedPercent: number,
  _label: "Audio" | "Text",
  validationLevels?: number[],
  requiredValidations?: number,
): string {
  const completedLevels = getCompletedValidationLevels(validationLevels, requiredValidations)
  const validationLevelText =
    completedLevels > 0 ? `; ${completedLevels} level${completedLevels === 1 ? "" : "s"} of validation complete` : ""
  const translationPercent = Math.round(completedPercent)
  const validationPercent = Math.round(validatedPercent)
  return `Translation: ${translationPercent}%\nValidation: ${validationPercent}%${validationLevelText}`
}

export function getProgressDisplay(
  validatedPercent: number,
  completedPercent: number,
  label: "Audio" | "Text",
  validationLevels?: number[],
  requiredValidations?: number,
) {
  const completedLevels = getCompletedValidationLevels(validationLevels, requiredValidations)
  return {
    colorClass: getProgressColor(validatedPercent, completedPercent, validationLevels, requiredValidations),
    title: getProgressTitle(validatedPercent, completedPercent, label, validationLevels, requiredValidations),
    completedValidationLevels: completedLevels,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/progress/progress-colors.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress/progress-colors.ts src/lib/progress/progress-colors.test.ts
git commit -m "$(cat <<'EOF'
feat(progress): port progress-color helpers from desktop app

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Build section index from cells

**Files:**
- Create: `src/lib/progress/section-index.ts`
- Test: `src/lib/progress/section-index.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/progress/section-index.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { buildSectionIndex } from "./section-index"

function mkCell(id: string, group: string) {
  return { id, group } as any
}

describe("buildSectionIndex", () => {
  it("returns empty array for no cells", () => {
    expect(buildSectionIndex([])).toEqual([])
  })
  it("groups cells by group field preserving first-seen order", () => {
    const cells = [
      mkCell("a", "Chapter 1"),
      mkCell("b", "Chapter 1"),
      mkCell("c", "Chapter 2"),
      mkCell("d", "Chapter 1"),
    ]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "Chapter 1", cellIds: ["a", "b", "d"] },
      { label: "Chapter 2", cellIds: ["c"] },
    ])
  })
  it("falls back to 'Ungrouped' for missing or empty group", () => {
    const cells = [
      mkCell("a", ""),
      mkCell("b", "Chapter 1"),
      mkCell("c", ""),
    ]
    expect(buildSectionIndex(cells)).toEqual([
      { label: "Ungrouped", cellIds: ["a", "c"] },
      { label: "Chapter 1", cellIds: ["b"] },
    ])
  })
  it("treats undefined group as Ungrouped", () => {
    const cells = [{ id: "a" }, { id: "b", group: "X" }] as any
    expect(buildSectionIndex(cells)).toEqual([
      { label: "Ungrouped", cellIds: ["a"] },
      { label: "X", cellIds: ["b"] },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/progress/section-index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/progress/section-index.ts`:

```ts
import type { CellData } from "@/hooks/useCells"

export interface SectionInfo {
  label: string
  cellIds: string[]
}

export function buildSectionIndex(cells: Pick<CellData, "id" | "group">[]): SectionInfo[] {
  const byLabel = new Map<string, SectionInfo>()
  for (const cell of cells) {
    const label = cell.group && cell.group.trim() ? cell.group : "Ungrouped"
    let section = byLabel.get(label)
    if (!section) {
      section = { label, cellIds: [] }
      byLabel.set(label, section)
    }
    section.cellIds.push(cell.id)
  }
  return Array.from(byLabel.values())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/progress/section-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress/section-index.ts src/lib/progress/section-index.test.ts
git commit -m "$(cat <<'EOF'
feat(progress): buildSectionIndex — group cells by cell.group

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Compute section progress with multi-level validation

**Files:**
- Create: `src/lib/progress/section-progress.ts`
- Test: `src/lib/progress/section-progress.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/progress/section-progress.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { computeSectionProgress } from "./section-progress"

function mkCell(id: string, group: string, translated: string, validators: string[], audioUrl?: string) {
  return {
    id, group, translated,
    activeValidators: validators,
    audioUrl,
  } as any
}

describe("computeSectionProgress", () => {
  it("returns empty for no cells", () => {
    expect(computeSectionProgress([], 1)).toEqual([])
  })

  it("counts textCompleted as cells with non-empty translated text", () => {
    const cells = [
      mkCell("a", "C1", "hello", []),
      mkCell("b", "C1", "", []),
      mkCell("c", "C1", "   ", []),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.label).toBe("C1")
    expect(section.textCompleted).toBe(33) // 1/3 rounded
  })

  it("counts textValidated as cells with activeValidators.length >= validationCount", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),
      mkCell("b", "C1", "hi", ["alice", "bob"]),
      mkCell("c", "C1", "hi", []),
      mkCell("d", "C1", "hi", ["alice", "bob", "carol"]),
    ]
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(50) // 2/4 meet threshold of 2
  })

  it("validationLevels[i] = % cells with more than i distinct validators", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),              // 1 validator
      mkCell("b", "C1", "hi", ["alice", "bob"]),       // 2 validators
      mkCell("c", "C1", "hi", ["alice", "bob", "carol"]), // 3 validators
      mkCell("d", "C1", "hi", []),                     // 0 validators
    ]
    const [section] = computeSectionProgress(cells, 3)
    // level 0: 3/4 have >= 1 validator = 75
    // level 1: 2/4 have >= 2 validators = 50
    // level 2: 1/4 have >= 3 validators = 25
    expect(section.textValidationLevels).toEqual([75, 50, 25])
  })

  it("includes all sections in file order", () => {
    const cells = [
      mkCell("a", "C1", "x", []),
      mkCell("b", "C2", "y", []),
    ]
    const result = computeSectionProgress(cells, 1)
    expect(result.map(s => s.label)).toEqual(["C1", "C2"])
  })

  it("hasAudio true when any cell has audioUrl", () => {
    const cells = [
      mkCell("a", "C1", "x", [], "url.wav"),
      mkCell("b", "C1", "y", []),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.hasAudio).toBe(true)
  })

  it("hasAudio false when no cell has audio", () => {
    const cells = [mkCell("a", "C1", "x", [])]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.hasAudio).toBe(false)
  })

  it("audio stub fields are 0 / empty until audio data exists", () => {
    const cells = [mkCell("a", "C1", "x", [])]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.audioCompleted).toBe(0)
    expect(section.audioValidated).toBe(0)
    expect(section.audioValidationLevels).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/progress/section-progress.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/lib/progress/section-progress.ts`:

```ts
import type { CellData } from "@/hooks/useCells"
import { buildSectionIndex, type SectionInfo } from "./section-index"

export interface SectionProgress extends SectionInfo {
  textCompleted: number      // 0..100
  textValidated: number      // 0..100
  textValidationLevels: number[] // [% with ≥1 validator, % with ≥2, …] length = validationCount
  audioCompleted: number     // 0 until audio ships
  audioValidated: number
  audioValidationLevels: number[]
  hasAudio: boolean
}

type ProgressCell = Pick<CellData, "id" | "group" | "translated" | "activeValidators"> & {
  audioUrl?: string // present once audio support lands
}

const MAX_VALIDATION_LEVELS = 15

function pct(num: number, denom: number): number {
  if (denom === 0) return 0
  return Math.round((num / denom) * 100)
}

export function computeSectionProgress(
  cells: ProgressCell[],
  validationCount: number,
): SectionProgress[] {
  const sections = buildSectionIndex(cells)
  const byId = new Map<string, ProgressCell>()
  for (const c of cells) byId.set(c.id, c)

  const levelCap = Math.min(Math.max(validationCount, 1), MAX_VALIDATION_LEVELS)

  return sections.map((section) => {
    const sectionCells = section.cellIds.map((id) => byId.get(id)!).filter(Boolean)
    const total = sectionCells.length

    let completed = 0
    let validated = 0
    const levelCounts = new Array(levelCap).fill(0)
    let hasAudio = false

    for (const cell of sectionCells) {
      const translatedText = (cell.translated || "").trim()
      if (translatedText.length > 0) completed++

      const vCount = cell.activeValidators?.length ?? 0
      if (vCount >= validationCount) validated++

      // levelCounts[i] = cells with > i distinct validators (i.e. ≥ i+1)
      for (let i = 0; i < levelCap; i++) {
        if (vCount > i) levelCounts[i]++
      }

      if (cell.audioUrl && cell.audioUrl.length > 0) hasAudio = true
    }

    const textValidationLevels = levelCounts.map((n) => pct(n, total))

    return {
      label: section.label,
      cellIds: section.cellIds,
      textCompleted: pct(completed, total),
      textValidated: pct(validated, total),
      textValidationLevels,
      audioCompleted: 0,
      audioValidated: 0,
      audioValidationLevels: [],
      hasAudio,
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/progress/section-progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress/section-progress.ts src/lib/progress/section-progress.test.ts
git commit -m "$(cat <<'EOF'
feat(progress): computeSectionProgress with multi-level validation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Make `useCells` threshold-aware

**Files:**
- Modify: `src/hooks/useCells.ts`
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Update `useCells` signature**

Edit `src/hooks/useCells.ts`. Change the hardcoded constant and hook signature:

Find:
```ts
const DEFAULT_REQUIRED_VALIDATIONS = 1
```
Delete that line.

Find:
```ts
export function useCells(doc: Y.Doc | null, username = "local"): CellData[] {
```
Replace with:
```ts
export function useCells(doc: Y.Doc | null, username = "local", requiredValidations = 1): CellData[] {
```

Find:
```ts
const { validationStatus, activeValidators } = deriveValidationStatus(
  translated, source?.metadata?.edits, username, DEFAULT_REQUIRED_VALIDATIONS,
)
```
Replace with:
```ts
const { validationStatus, activeValidators } = deriveValidationStatus(
  translated, source?.metadata?.edits, username, requiredValidations,
)
```

Find the `useEffect` deps at the end:
```ts
  }, [doc])
```
Replace with:
```ts
  }, [doc, username, requiredValidations])
```

- [ ] **Step 2: Update call site in ProjectWorkspace**

Edit `src/components/ProjectWorkspace.tsx`.

Near the top of the file, add import (find existing import block for progress helpers):
```ts
import { readValidationCount } from "@/lib/progress/read-validation-count"
```

Find:
```ts
const cells = useCells(doc, currentUsername)
```
Replace with:
```ts
const validationCount = project ? readValidationCount(project) : 1
const cells = useCells(doc, currentUsername, validationCount)
```

Note: `project` is `ProjectRecord | null` at that point. The `? : 1` guard is important — the hook runs before the early return.

- [ ] **Step 3: Run existing tests to confirm nothing breaks**

Run: `npx vitest run`
Expected: all PASS (489+). If any test imports `useCells` directly, the default `requiredValidations = 1` covers backwards compat.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCells.ts src/components/ProjectWorkspace.tsx
git commit -m "$(cat <<'EOF'
feat(cells): thread validationCount into useCells

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `useSectionProgress` hook — lazy load + memoize

**Files:**
- Create: `src/hooks/useSectionProgress.ts`
- Test: `src/hooks/useSectionProgress.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/hooks/useSectionProgress.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import "fake-indexeddb/auto"
import { createFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { useSectionProgress } from "./useSectionProgress"

describe("useSectionProgress", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory() as any
  })

  it("returns null while loading and sections once synced", async () => {
    const handle = createFileDoc("test-file-1", "file.usfm", "usfm", "en", "fr", [
      { id: "c1", original: "Hello", translated: "Bonjour", context: "", group: "Chapter 1", type: "text" },
      { id: "c2", original: "World", translated: "",        context: "", group: "Chapter 1", type: "text" },
      { id: "c3", original: "!",     translated: "!",       context: "", group: "Chapter 2", type: "text" },
    ])
    await new Promise<void>((r) => handle.persistence.once("synced", () => r()))
    destroyFileDoc(handle)

    const { result } = renderHook(() => useSectionProgress("test-file-1", 1))

    await waitFor(() => {
      expect(result.current).not.toBeNull()
    }, { timeout: 2000 })

    const sections = result.current!
    expect(sections).toHaveLength(2)
    expect(sections[0].label).toBe("Chapter 1")
    expect(sections[0].textCompleted).toBe(50)  // 1/2
    expect(sections[1].label).toBe("Chapter 2")
    expect(sections[1].textCompleted).toBe(100) // 1/1
  })

  it("returns null when fileId is null", () => {
    const { result } = renderHook(() => useSectionProgress(null, 1))
    expect(result.current).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useSectionProgress.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useSectionProgress.ts`:

```ts
import { useEffect, useState } from "react"
import * as Y from "yjs"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { computeSectionProgress, type SectionProgress } from "@/lib/progress/section-progress"
import type { ValidationEntry } from "@/lib/codex-editor/types"
import { getPlainText } from "@/lib/richtext/translated-xml"

/**
 * Lazily read a file's Y.Doc from IndexedDB and compute section progress.
 * Ref-counted via loadFileDoc, so if the editor is already showing this file
 * the doc is shared — no duplicate hydration.
 */
export function useSectionProgress(
  fileId: string | null,
  validationCount: number,
): SectionProgress[] | null {
  const [sections, setSections] = useState<SectionProgress[] | null>(null)

  useEffect(() => {
    if (!fileId) { setSections(null); return }

    const handle = loadFileDoc(fileId)
    let cancelled = false

    function compute() {
      if (cancelled) return
      const cellsMap = handle.doc.getMap("cells")
      const orderArray = handle.doc.getArray<string>("order")
      const ordered: Array<{
        id: string
        group: string
        translated: string
        activeValidators: string[]
        audioUrl?: string
      }> = []

      for (const id of orderArray.toArray()) {
        const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
        if (!cell) continue
        const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
        const translated = frag ? getPlainText(frag) : ((cell.get("translated") as string) || "")
        const source = cell.get("__source") as
          | { metadata?: { edits?: Array<{ editMap?: string[]; validatedBy?: ValidationEntry[] }>; selectedAudioId?: string } }
          | undefined
        let activeValidators: string[] = []
        if (source?.metadata?.edits) {
          for (let i = source.metadata.edits.length - 1; i >= 0; i--) {
            const edit = source.metadata.edits[i]
            if (edit.editMap?.[0] === "value") {
              activeValidators = (edit.validatedBy ?? [])
                .filter(v => v && typeof v.username === "string" && !v.isDeleted)
                .map(v => v.username)
              break
            }
          }
        }
        ordered.push({
          id: cell.get("id") as string,
          group: (cell.get("group") as string) || "",
          translated,
          activeValidators,
          audioUrl: source?.metadata?.selectedAudioId,
        })
      }
      setSections(computeSectionProgress(ordered, validationCount))
    }

    function onSynced() { compute() }

    if (handle.persistence.synced) compute()
    else handle.persistence.once("synced", onSynced)

    // Recompute on any change to cells or order
    const cellsMap = handle.doc.getMap("cells")
    const orderArray = handle.doc.getArray<string>("order")
    cellsMap.observeDeep(compute)
    orderArray.observe(compute)

    return () => {
      cancelled = true
      cellsMap.unobserveDeep(compute)
      orderArray.unobserve(compute)
      destroyFileDoc(handle)
    }
  }, [fileId, validationCount])

  return sections
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useSectionProgress.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSectionProgress.ts src/hooks/useSectionProgress.test.tsx
git commit -m "$(cat <<'EOF'
feat(progress): useSectionProgress — lazy per-file progress hook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `ProgressDot` component

**Files:**
- Create: `src/components/sidebar/ProgressDot.tsx`

- [ ] **Step 1: Add Tailwind color classes**

Edit `src/index.css`. Find the `@theme` block (search for `--color-chart-`). Add the following color tokens at the end of the theme block:

```css
  --color-charts-blue: oklch(0.62 0.17 245);
  --color-charts-blue-dark: oklch(0.45 0.18 245);
  --color-editor-warning-foreground: oklch(0.75 0.17 85);
```

These mirror the desktop VS Code palette approximately — blue for "translated", darker blue for "partially validated", warning/amber for "fully validated".

- [ ] **Step 2: Implement ProgressDot**

Note: V1 renders only the text dot per section. The audio sub-dot (stacked pair) is deferred until `project.hasAnyAudioData` can become true, which requires audio-capture code not in scope here. When audio ships, `FileSectionGrid` in Task 8 will pass an additional `audio` prop and render a second dot above the text dot. No code changes to ProgressDot itself needed — render one pair in the grid.

Create `src/components/sidebar/ProgressDot.tsx`:

```tsx
import { getProgressDisplay } from "@/lib/progress/progress-colors"
import { cn } from "@/lib/utils"

const MAX_VALIDATION_LEVELS = 15

interface Props {
  label: string
  completedPercent: number
  validatedPercent: number
  validationLevels?: number[]
  requiredValidations?: number
  onClick?: () => void
}

/**
 * A single section dot. Size ~8px, colored per progress state, hover tooltip
 * shows exact numbers. Click navigates to the section.
 */
export function ProgressDot({
  label,
  completedPercent,
  validatedPercent,
  validationLevels,
  requiredValidations,
  onClick,
}: Props) {
  const display = getProgressDisplay(
    validatedPercent,
    completedPercent,
    "Text",
    validationLevels,
    requiredValidations,
  )

  // Progressive darkness for "dark blue" state — mirrors the desktop app.
  const isProgressive = display.colorClass === "text-charts-blue-dark"
  let filter = ""
  if (isProgressive) {
    const maxLevels = Math.min(requiredValidations || 1, MAX_VALIDATION_LEVELS)
    const brightness = Math.max(
      0.4,
      0.95 - 0.55 * (display.completedValidationLevels / maxLevels),
    )
    filter = `brightness(${brightness})`
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label}\n${display.title}`}
      aria-label={`${label}: ${display.title}`}
      className={cn(
        "h-2 w-2 rounded-full transition-opacity hover:opacity-80",
        display.colorClass,
      )}
      style={{
        backgroundColor: "currentColor",
        filter: filter || undefined,
      }}
    />
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.css src/components/sidebar/ProgressDot.tsx
git commit -m "$(cat <<'EOF'
feat(progress): ProgressDot + progress color tokens

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `FileSectionGrid` component

**Files:**
- Create: `src/components/sidebar/FileSectionGrid.tsx`

- [ ] **Step 1: Implement**

Create `src/components/sidebar/FileSectionGrid.tsx`:

```tsx
import { useSectionProgress } from "@/hooks/useSectionProgress"
import { ProgressDot } from "./ProgressDot"

interface Props {
  fileId: string
  validationCount: number
  onSectionClick: (sectionLabel: string) => void
}

/**
 * Compact dot grid showing per-section progress for a file. Rendered inside
 * the expanded file row in the sidebar. Loads the file's Y.Doc lazily (via
 * the ref-counted registry) so expanding N files hydrates N docs but
 * collapsing frees them.
 */
export function FileSectionGrid({ fileId, validationCount, onSectionClick }: Props) {
  const sections = useSectionProgress(fileId, validationCount)

  if (sections === null) {
    return <div className="px-6 py-1 text-[10px] text-muted-foreground">Loading…</div>
  }
  if (sections.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-1.5 px-6 py-1.5 max-h-24 overflow-y-auto">
      {sections.map((section) => (
        <ProgressDot
          key={section.label}
          label={section.label}
          completedPercent={section.textCompleted}
          validatedPercent={section.textValidated}
          validationLevels={section.textValidationLevels}
          requiredValidations={validationCount}
          onClick={() => onSectionClick(section.label)}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/FileSectionGrid.tsx
git commit -m "$(cat <<'EOF'
feat(progress): FileSectionGrid — per-section dot grid

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire `FileSectionGrid` into `ExpandableFileList`

**Files:**
- Modify: `src/components/ExpandableFileList.tsx`

- [ ] **Step 1: Pass validationCount prop through**

Edit `src/components/ExpandableFileList.tsx`.

Find the `Props` interface and add:
```ts
  validationCount: number
```

Find the destructured props in the function signature and add `validationCount,` after `suggestionFileIds,`.

- [ ] **Step 2: Import FileSectionGrid + requestScrollToGroup**

At the top of the file, add:
```ts
import { FileSectionGrid } from "./sidebar/FileSectionGrid"
```

Note: `requestScrollToGroup` is already imported from `useEditorScroll` — check line ~34.

- [ ] **Step 3: Render the grid in expanded rows**

Find the section that renders the expanded file's section rows:
```tsx
{isExpanded && sectionsFor(file.id).map((s) => (
  <SectionRow
    key={s.label}
    ...
  />
))}
```

Replace with a single `FileSectionGrid` call. `loadFileDoc` is ref-counted in `src/lib/store/file-doc.ts:78-89`, so when the expanded file is also the active file, the sidebar shares the editor's Y.Doc — no duplicate hydration:

```tsx
{isExpanded && (
  <FileSectionGrid
    fileId={file.id}
    validationCount={validationCount}
    onSectionClick={(label) => {
      if (file.id !== activeFileId) {
        onSelectFile(file.id)
        // Defer scroll until the editor remounts for the new file
        setTimeout(() => requestScrollToGroup(label), 100)
      } else {
        requestScrollToGroup(label)
      }
    }}
  />
)}
```

This removes the `SectionRow` rendering for the active file — the dot grid now replaces the per-section percentage rows everywhere. If the per-section detail view is wanted back later, it can live in a separate hover panel. For this plan, the grid is the single source of truth.

After this change, `SectionRow` and `sectionsFor` inside `ExpandableFileList.tsx` become unused — delete them to keep the file tidy:
- Remove the import `import { SectionRow } from "./SectionRow"` if present.
- Remove the `sectionsFor` function.
- Do NOT delete the `SectionRow.tsx` file itself yet — it may still be used elsewhere. Check with:
  ```
  grep -rn "SectionRow" src/ | grep -v "\.test\." | grep -v "ExpandableFileList"
  ```
  If no other consumers, the cleanup of `SectionRow.tsx` can happen in the post-integration tidy (Task 14).

- [ ] **Step 4: Pass validationCount from ProjectWorkspace**

Edit `src/components/ProjectWorkspace.tsx`. Find the `<ExpandableFileList`  JSX call in the sidebar slot. Add the prop:

```tsx
<ExpandableFileList
  projectId={projectId!}
  files={project.files}
  activeFileId={activeFileId}
  activeFileCells={cells}
  fileProgress={fileProgress}
  suggestionFileIds={suggestionFileIds}
  validationCount={validationCount}
  onSelectFile={setActiveFileId}
  onRename={handleRename}
  onMove={...}
  onDelete={...}
/>
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx tsc -b && npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/components/ExpandableFileList.tsx src/components/ProjectWorkspace.tsx
git commit -m "$(cat <<'EOF'
feat(sidebar): render per-section progress grid in expanded file rows

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `useNextUnfinished` hook

**Files:**
- Create: `src/hooks/useNextUnfinished.ts`
- Test: `src/hooks/useNextUnfinished.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/hooks/useNextUnfinished.test.tsx`:

```tsx
import { describe, it, expect } from "vitest"
import { findNextUnfinishedIndex } from "./useNextUnfinished"

function mkCell(translated: string, validators: string[]) {
  return { translated, activeValidators: validators } as any
}

describe("findNextUnfinishedIndex", () => {
  it("returns -1 for empty list", () => {
    expect(findNextUnfinishedIndex([], 0, 1)).toBe(-1)
  })

  it("returns null when everything is finished", () => {
    const cells = [
      mkCell("done", ["a"]),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 0, 1)).toBe(-1)
  })

  it("finds the first untranslated cell after cursor", () => {
    const cells = [
      mkCell("done", ["a"]),
      mkCell("", []),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 0, 1)).toBe(1)
  })

  it("finds the first cell below threshold after cursor", () => {
    const cells = [
      mkCell("done", ["a", "b"]),
      mkCell("done", ["a"]),          // below threshold of 2
      mkCell("done", ["a", "b"]),
    ]
    expect(findNextUnfinishedIndex(cells, 0, 2)).toBe(1)
  })

  it("wraps to start when nothing unfinished after cursor", () => {
    const cells = [
      mkCell("", []),                 // unfinished at 0
      mkCell("done", ["a"]),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 1, 1)).toBe(0)
  })

  it("returns -1 when cursor is on the only unfinished cell and nothing else is unfinished", () => {
    const cells = [
      mkCell("done", ["a"]),
      mkCell("", []),
      mkCell("done", ["a"]),
    ]
    expect(findNextUnfinishedIndex(cells, 1, 1)).toBe(-1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useNextUnfinished.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/hooks/useNextUnfinished.ts`:

```ts
import { useMemo } from "react"
import type { CellData } from "./useCells"

function isUnfinished(
  cell: Pick<CellData, "translated" | "activeValidators">,
  validationCount: number,
): boolean {
  if (!cell.translated || !cell.translated.trim()) return true
  return (cell.activeValidators?.length ?? 0) < validationCount
}

/**
 * Pure, testable search. Returns the next unfinished cell's index after
 * `fromIndex` (exclusive), wrapping to the start if needed. Excludes
 * `fromIndex` itself. Returns -1 if no other cell is unfinished.
 */
export function findNextUnfinishedIndex(
  cells: Array<Pick<CellData, "translated" | "activeValidators">>,
  fromIndex: number,
  validationCount: number,
): number {
  if (cells.length === 0) return -1
  for (let offset = 1; offset <= cells.length; offset++) {
    const idx = (fromIndex + offset) % cells.length
    if (idx === fromIndex) break
    if (isUnfinished(cells[idx], validationCount)) return idx
  }
  return -1
}

/**
 * Hook variant returning a callable locator that can be invoked on a button
 * click. Kept separate from the pure function so the pure path is
 * independently testable.
 */
export function useNextUnfinished(cells: CellData[], validationCount: number) {
  return useMemo(() => {
    const hasAny = cells.some((c) => isUnfinished(c, validationCount))
    return {
      hasAny,
      findNext: (fromIndex: number) => findNextUnfinishedIndex(cells, fromIndex, validationCount),
    }
  }, [cells, validationCount])
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useNextUnfinished.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useNextUnfinished.ts src/hooks/useNextUnfinished.test.tsx
git commit -m "$(cat <<'EOF'
feat(progress): useNextUnfinished + findNextUnfinishedIndex

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `NextUnfinishedButton` component + WorkspaceHeader integration

**Files:**
- Create: `src/components/NextUnfinishedButton.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Implement the button**

Create `src/components/NextUnfinishedButton.tsx`:

```tsx
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  onClick: () => void
  disabled: boolean
}

export function NextUnfinishedButton({ onClick, disabled }: Props) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title="Jump to next unfinished cell (Cmd+.)"
      aria-label="Next unfinished"
      className="gap-1"
    >
      Next
      <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  )
}
```

- [ ] **Step 2: Integrate in ProjectWorkspace**

Edit `src/components/ProjectWorkspace.tsx`.

Add imports near the other component imports:
```ts
import { NextUnfinishedButton } from "./NextUnfinishedButton"
import { useNextUnfinished } from "@/hooks/useNextUnfinished"
```

After the `cells` declaration, add:
```ts
const { hasAny: hasUnfinished, findNext: findNextUnfinished } = useNextUnfinished(cells, validationCount)
const handleJumpNextUnfinished = useCallback(() => {
  const currentIndex = editorRef.current?.getCurrentIndex?.() ?? 0
  const next = findNextUnfinished(currentIndex)
  if (next >= 0) editorRef.current?.scrollToCellIndex(next)
}, [findNextUnfinished])
```

Note: `editorRef.current?.getCurrentIndex?.()` uses optional chaining because the ref may not expose it yet. If it doesn't, fall back to 0.

- [ ] **Step 3: Check if `getCurrentIndex` exists on EditorTableHandle**

Run:
```
grep -n "getCurrentIndex\|EditorTableHandle" src/components/EditorTable.tsx
```

If `getCurrentIndex` is not exposed, add it. Find `EditorTableHandle`:

```ts
export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
  // ... existing
}
```

Add:
```ts
  getCurrentIndex?: () => number
```

And in the `useImperativeHandle` inside `EditorTable`, add a method. If a "current index" isn't tracked (it might not be — check for a `useVirtualizer` ref) return 0:

```ts
getCurrentIndex: () => 0,
```

Starting from 0 is acceptable for v1 — the button is "find next unfinished from the top" which is reasonable.

- [ ] **Step 4: Add button to WorkspaceHeader children**

Find the `<WorkspaceHeader>` block in ProjectWorkspace. Before `<PrimaryActionButton ...>`, add:

```tsx
<NextUnfinishedButton
  onClick={handleJumpNextUnfinished}
  disabled={!activeFileId || !hasUnfinished}
/>
```

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc -b && npx vitest run`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/components/NextUnfinishedButton.tsx src/components/ProjectWorkspace.tsx src/components/EditorTable.tsx
git commit -m "$(cat <<'EOF'
feat(workspace): NextUnfinishedButton in header

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Cmd+. keybinding for Next Unfinished

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Audit existing keybindings**

Run:
```
grep -n "e.metaKey\|e.ctrlKey" src/components/ProjectWorkspace.tsx
```

Confirm that `Cmd+.` is not already bound. (Existing bindings: `Cmd+K` for search, `Cmd+S` for sync.)

- [ ] **Step 2: Add keyboard handler**

Find the existing `useEffect` that handles `Cmd+K`:
```ts
useEffect(() => {
  function handler(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      setSearchOpen(true)
    }
  }
  document.addEventListener("keydown", handler)
  return () => document.removeEventListener("keydown", handler)
}, [])
```

Extend it to handle `.` as well:

```ts
useEffect(() => {
  function handler(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      setSearchOpen(true)
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ".") {
      if (!activeFileId || !hasUnfinished) return
      e.preventDefault()
      handleJumpNextUnfinished()
    }
  }
  document.addEventListener("keydown", handler)
  return () => document.removeEventListener("keydown", handler)
}, [activeFileId, hasUnfinished, handleJumpNextUnfinished])
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProjectWorkspace.tsx
git commit -m "$(cat <<'EOF'
feat(workspace): Cmd+. jumps to next unfinished cell

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `ValidationSettingsSection` in Project Settings

**Files:**
- Create: `src/components/ProjectSettings/ValidationSettingsSection.tsx`
- Modify: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Create the settings section**

Create `src/components/ProjectSettings/ValidationSettingsSection.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ProjectRecord } from "@/lib/parsers/types"

interface Props {
  validationCount: number
  validationCountAudio: number
  hasAnyAudioData: boolean
  onChange: (
    updates: Partial<Pick<ProjectRecord, "validationCount" | "validationCountAudio">>
  ) => void
}

/**
 * Settings card for required validator counts. Audio input is disabled when
 * the project has no audio data yet — we don't hide it so users know the
 * axis exists.
 */
export function ValidationSettingsSection({
  validationCount,
  validationCountAudio,
  hasAnyAudioData,
  onChange,
}: Props) {
  function clamp(raw: string): number {
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n)) return 1
    if (n < 1) return 1
    if (n > 15) return 15
    return n
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Validation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="validation-count">Required validators (text)</Label>
          <Input
            id="validation-count"
            type="number"
            min={1}
            max={15}
            value={validationCount}
            onChange={(e) => onChange({ validationCount: clamp(e.target.value) })}
            className="w-24"
          />
          <p className="text-xs text-muted-foreground">
            Cells need this many distinct validators to count as fully validated.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="validation-count-audio">Required validators (audio)</Label>
          <Input
            id="validation-count-audio"
            type="number"
            min={1}
            max={15}
            disabled={!hasAnyAudioData}
            value={validationCountAudio}
            onChange={(e) => onChange({ validationCountAudio: clamp(e.target.value) })}
            className="w-24"
          />
          <p className="text-xs text-muted-foreground">
            {hasAnyAudioData
              ? "Applies to audio translations."
              : "Enabled once audio translations exist."}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Mount in ProjectSettings**

Edit `src/components/ProjectSettings.tsx`.

Near existing imports add:
```ts
import { ValidationSettingsSection } from "./ProjectSettings/ValidationSettingsSection"
import { readValidationCount, readValidationCountAudio } from "@/lib/progress/read-validation-count"
```

Add state for the two fields after the other `useState` declarations (find the block with `autoSyncEnabled`):
```ts
const [validationCount, setValidationCount] = useState(1)
const [validationCountAudio, setValidationCountAudio] = useState(1)
```

In the `useEffect` that hydrates project state into form fields (find `getProject(id).then((p) =>`), add after the existing sets:
```ts
setValidationCount(readValidationCount(p))
setValidationCountAudio(readValidationCountAudio(p))
```

Find the save/update handler (grep for `updateProject(` in this file). The file uses pattern: updates are built into a partial object then passed to `updateProject`. Find where the update object is assembled and add the two fields:

```ts
const updates: Partial<ProjectRecord> = {
  // ... existing
  validationCount,
  validationCountAudio,
}
```

Finally, render the card. Near where other settings cards are rendered (search for `<Card>` to find the layout pattern), add:

```tsx
<ValidationSettingsSection
  validationCount={validationCount}
  validationCountAudio={validationCountAudio}
  hasAnyAudioData={Boolean(project?.hasAnyAudioData)}
  onChange={(u) => {
    if (u.validationCount !== undefined) setValidationCount(u.validationCount)
    if (u.validationCountAudio !== undefined) setValidationCountAudio(u.validationCountAudio)
  }}
/>
```

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc -b && npx vitest run`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProjectSettings/ValidationSettingsSection.tsx src/components/ProjectSettings.tsx
git commit -m "$(cat <<'EOF'
feat(settings): ValidationSettingsSection for required validator counts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Manual verification + checklist

**Files:** none.

- [ ] **Step 1: Start the dev server**

```
rm -rf node_modules/.vite && npm run tauri:dev
```

- [ ] **Step 2: Walk the manual checklist from the spec**

For each item, confirm working, then tick:

- [ ] Open GitLab-imported project → sidebar shows file list; expanding a file shows dot grid.
- [ ] Open newly created empty project → sidebar shows "no files yet"; after importing one USFM file, grid appears on expand.
- [ ] Click a grid dot → editor scrolls to that section's first cell.
- [ ] Hover dot → tooltip shows accurate translated/validated counts.
- [ ] Validate one cell as user A → with `validationCount=2`, dot stays partial; set to `1`, dot jumps to validated color.
- [ ] Click "Next →" in a half-finished file → jumps to first untranslated/unvalidated cell.
- [ ] `Cmd+.` triggers "Next →" when focus is in editor.
- [ ] No audio data anywhere → audio sub-dots never render; audio settings input disabled.
- [ ] Project Settings writes persist across page reload.

- [ ] **Step 3: Run full lint + test**

```
npm run lint
npm test
```

Lint baseline is 156 pre-existing errors — do not count those. Confirm we added **zero new errors** (diff against baseline).
Tests: 489 → 489+N (new tests added in earlier tasks). All must pass.

- [ ] **Step 4: Final commit if anything minor tidied up**

```bash
git status
# if clean, nothing to commit
# if tidying needed:
git add -A
git commit -m "chore(progress): post-integration tidy"
```

- [ ] **Step 5: Open PR back to main**

```bash
cd /Users/ryderwishart/prototypes/codex-web-app
git fetch --all
# Optional: push the branch so main's review can happen in PR
git push -u origin feat/section-progress
```

---

## Post-plan notes

- **Keybinding sanity**: `Cmd+.` on macOS can be intercepted by certain apps as "hide app." Confirm it works inside the Tauri window during manual verification. If it doesn't, fall back to `Cmd+Shift+N`.
- **Color tokens**: The `text-charts-blue` / `text-editor-warning-foreground` tokens borrow the desktop app's naming. If the design system crew wants different visual colors, swap the oklch values in `index.css` — no component changes needed.
- **Audio activation**: When audio capture ships later, the write path must set `project.hasAnyAudioData = true` (one-way latch). At that point the audio sub-dots and the audio settings input light up automatically.
