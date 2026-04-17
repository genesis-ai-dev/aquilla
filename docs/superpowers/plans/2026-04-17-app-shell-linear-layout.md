# App Shell Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crammed project workspace toolbar with a Linear-inspired shell — sectioned sidebar (user account at top, Files scrollable, Project nav below), minimal top header with a contextual split-button primary action, file rename + auto-labeling with original-name transparency, expandable file rows with per-section progress, and multi-account session switching.

**Architecture:** New `AppShell` wrapper composes three regions: a sectioned sidebar, a thin `WorkspaceHeader`, and a bottom `StatusBar` (peers + sync). A `WorkspaceAction` registry drives an extensible split-button whose default label is computed from project/file state. Renaming is powered by pure helpers (`renameFile`, `moveFileToCorpus`, `renameCorpus`) that update `ProjectRecord.files` in one transaction and preserve `FileReference.originalName` for hover transparency. Auto-labeling runs detectors on demand, never mutates on its own — the user confirms via banner/dialog. Session store moves from single-key to an envelope `{ active, sessions }` with a migration on first load.

**Tech Stack:** React 19, TypeScript, vitest, idb (IndexedDB), react-router-dom 7, @base-ui/react primitives (custom shadcn-style wrappers), lucide-react icons, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-04-17-app-shell-linear-layout-design.md`

**Test command (project-wide):** `npm run test`
**Test command (single file):** `npx vitest run <path>`
**Type check:** `npm run build` (also bundles; use only when needed)
**Lint:** `npm run lint`

---

## File Map

**Create:**

- `src/lib/file-labeling/bible-book-names.ts` — USFM code → English name table (66 books)
- `src/lib/file-labeling/bible-book-names.test.ts`
- `src/lib/file-labeling/detect.ts` — suggestion detectors
- `src/lib/file-labeling/detect.test.ts`
- `src/lib/file-labeling/apply.ts` — applySuggestions + buildUndo
- `src/lib/file-labeling/apply.test.ts`
- `src/lib/store/file-operations.ts` — renameFile, moveFileToCorpus, renameCorpus, deleteFile
- `src/lib/store/file-operations.test.ts`
- `src/lib/workspace-actions/types.ts`
- `src/lib/workspace-actions/registry.ts`
- `src/lib/workspace-actions/registry.test.ts`
- `src/context/EditorScrollContext.tsx`
- `src/hooks/useAccounts.ts`
- `src/hooks/useAccounts.test.ts`
- `src/hooks/useSidebarExpansion.ts`
- `src/components/AppShell.tsx`
- `src/components/AccountSwitcher.tsx`
- `src/components/WorkspaceHeader.tsx`
- `src/components/PrimaryActionButton.tsx`
- `src/components/SidebarProjectSection.tsx`
- `src/components/SidebarCommandPaletteHint.tsx`
- `src/components/ExpandableFileList.tsx`
- `src/components/FileRow.tsx`
- `src/components/SectionRow.tsx`
- `src/components/FileActionMenu.tsx`
- `src/components/SuggestionBanner.tsx`
- `src/components/RenameSuggestionsDialog.tsx`
- `src/components/ConfirmActionDialog.tsx`
- `src/components/WorkspaceStatusBar.tsx`

**Modify:**

- `src/lib/parsers/types.ts` — add `FileReference.originalName`, `ProjectRecord.suggestionsDismissedAt`
- `src/lib/codex-editor/bible-books.ts` — no changes; new names table is a separate file
- `src/lib/frontier/session-store.ts` — envelope schema + migration; retain `loadSession`, add new APIs
- `src/hooks/useFrontierSession.ts` — becomes a thin wrapper over `useAccounts`
- `src/components/git-import/HeaderAuth.tsx` — unchanged functionally; still used on Dashboard
- `src/components/ProjectWorkspace.tsx` — render `AppShell` instead of `Toolbar` + `ProjectSidebar` + old `StatusBar`
- `src/components/ProjectSidebar.tsx` — **delete** (superseded by `ExpandableFileList` + `SidebarProjectSection`)
- `src/components/Toolbar.tsx` — **delete** (superseded by `WorkspaceHeader` + sidebar nav)
- `src/components/StatusBar.tsx` — unchanged if kept for the cell-level info; confirm in Task 18

---

## Task 1: Expand Bible book table with English names

**Files:**
- Create: `src/lib/file-labeling/bible-book-names.ts`
- Create: `src/lib/file-labeling/bible-book-names.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/lib/file-labeling/bible-book-names.test.ts
import { describe, it, expect } from "vitest"
import { getBookName, isKnownBookCode } from "./bible-book-names"

describe("getBookName", () => {
  it("returns English name for OT book codes", () => {
    expect(getBookName("GEN")).toBe("Genesis")
    expect(getBookName("EXO")).toBe("Exodus")
    expect(getBookName("MAL")).toBe("Malachi")
    expect(getBookName("1SA")).toBe("1 Samuel")
    expect(getBookName("2CH")).toBe("2 Chronicles")
  })
  it("returns English name for NT book codes", () => {
    expect(getBookName("MAT")).toBe("Matthew")
    expect(getBookName("JHN")).toBe("John")
    expect(getBookName("1JN")).toBe("1 John")
    expect(getBookName("REV")).toBe("Revelation")
  })
  it("is case-insensitive", () => {
    expect(getBookName("gen")).toBe("Genesis")
    expect(getBookName("Rev")).toBe("Revelation")
  })
  it("returns undefined for unknown codes", () => {
    expect(getBookName("xyz")).toBeUndefined()
    expect(getBookName("")).toBeUndefined()
  })
})

describe("isKnownBookCode", () => {
  it("returns true for 66 canonical books", () => {
    expect(isKnownBookCode("GEN")).toBe(true)
    expect(isKnownBookCode("REV")).toBe(true)
  })
  it("returns false for unknown", () => {
    expect(isKnownBookCode("ZZZ")).toBe(false)
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/lib/file-labeling/bible-book-names.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/file-labeling/bible-book-names.ts
const NAMES: Record<string, string> = {
  GEN: "Genesis", EXO: "Exodus", LEV: "Leviticus", NUM: "Numbers", DEU: "Deuteronomy",
  JOS: "Joshua", JDG: "Judges", RUT: "Ruth",
  "1SA": "1 Samuel", "2SA": "2 Samuel",
  "1KI": "1 Kings", "2KI": "2 Kings",
  "1CH": "1 Chronicles", "2CH": "2 Chronicles",
  EZR: "Ezra", NEH: "Nehemiah", EST: "Esther", JOB: "Job", PSA: "Psalms",
  PRO: "Proverbs", ECC: "Ecclesiastes", SNG: "Song of Songs",
  ISA: "Isaiah", JER: "Jeremiah", LAM: "Lamentations", EZK: "Ezekiel",
  DAN: "Daniel", HOS: "Hosea", JOL: "Joel", AMO: "Amos", OBA: "Obadiah",
  JON: "Jonah", MIC: "Micah", NAM: "Nahum", HAB: "Habakkuk", ZEP: "Zephaniah",
  HAG: "Haggai", ZEC: "Zechariah", MAL: "Malachi",
  MAT: "Matthew", MRK: "Mark", LUK: "Luke", JHN: "John", ACT: "Acts",
  ROM: "Romans", "1CO": "1 Corinthians", "2CO": "2 Corinthians",
  GAL: "Galatians", EPH: "Ephesians", PHP: "Philippians", COL: "Colossians",
  "1TH": "1 Thessalonians", "2TH": "2 Thessalonians",
  "1TI": "1 Timothy", "2TI": "2 Timothy", TIT: "Titus", PHM: "Philemon",
  HEB: "Hebrews", JAS: "James", "1PE": "1 Peter", "2PE": "2 Peter",
  "1JN": "1 John", "2JN": "2 John", "3JN": "3 John", JUD: "Jude", REV: "Revelation",
}

export function getBookName(code: string): string | undefined {
  return NAMES[(code || "").toUpperCase()]
}

export function isKnownBookCode(code: string): boolean {
  return (code || "").toUpperCase() in NAMES
}
```

- [ ] **Step 4: Run and verify PASS**

Run: `npx vitest run src/lib/file-labeling/bible-book-names.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/file-labeling/bible-book-names.ts src/lib/file-labeling/bible-book-names.test.ts
git commit -m "feat(file-labeling): add USFM book code → English name table"
```

---

## Task 2: Add data model fields to ProjectRecord / FileReference

**Files:**
- Modify: `src/lib/parsers/types.ts`

- [ ] **Step 1: Edit types**

In `src/lib/parsers/types.ts`, find `interface FileReference` and add one field:

```ts
export interface FileReference {
  id: string
  name: string
  type: FileType
  createdAt: string
  cellCount: number
  corpusMarker?: string
  originalName?: string  // Set the first time `name` is auto-rewritten by a suggestion or user rename. Enables hover-to-see-original. Never overwritten after set.
}
```

Find `interface ProjectRecord` and add one field at the end (before the closing brace):

```ts
export interface ProjectRecord {
  // ... existing fields unchanged
  originalFileListing?: Record<string, string>
  syncSettings?: ProjectSyncSettings
  suggestionsDismissedAt?: string  // ISO timestamp; suggestion banner is hidden after this is set.
}
```

- [ ] **Step 2: Verify build still compiles**

Run: `npm run build`
Expected: PASS (no type errors; both fields are optional).

- [ ] **Step 3: Commit**

```bash
git add src/lib/parsers/types.ts
git commit -m "feat(types): add FileReference.originalName and ProjectRecord.suggestionsDismissedAt"
```

---

## Task 3: File operation helpers — rename, move, delete, rename corpus

**Files:**
- Create: `src/lib/store/file-operations.ts`
- Create: `src/lib/store/file-operations.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/store/file-operations.test.ts
import { describe, it, expect } from "vitest"
import {
  renameFile, moveFileToCorpus, renameCorpus, deleteFile,
} from "./file-operations"
import type { ProjectRecord, FileReference } from "@/lib/parsers/types"

function mkFile(overrides: Partial<FileReference>): FileReference {
  return {
    id: "f1", name: "genesis.usfm", type: "usfm",
    createdAt: "2026-01-01T00:00:00Z", cellCount: 50,
    ...overrides,
  }
}

function mkProject(files: FileReference[]): ProjectRecord {
  return {
    id: "p1", name: "Test", sourceLanguage: "en", targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z", files, members: [],
  }
}

describe("renameFile", () => {
  it("updates the file's name", () => {
    const project = mkProject([mkFile({ id: "f1", name: "genesis.usfm" })])
    const next = renameFile(project, "f1", "Genesis")
    expect(next.files[0].name).toBe("Genesis")
  })
  it("sets originalName the first time name changes", () => {
    const project = mkProject([mkFile({ id: "f1", name: "genesis.usfm" })])
    const next = renameFile(project, "f1", "Genesis")
    expect(next.files[0].originalName).toBe("genesis.usfm")
  })
  it("does not overwrite originalName on subsequent renames", () => {
    const project = mkProject([mkFile({
      id: "f1", name: "Genesis", originalName: "genesis.usfm",
    })])
    const next = renameFile(project, "f1", "Book of Beginnings")
    expect(next.files[0].originalName).toBe("genesis.usfm")
    expect(next.files[0].name).toBe("Book of Beginnings")
  })
  it("throws if new name collides with another file in the project", () => {
    const project = mkProject([
      mkFile({ id: "f1", name: "Genesis" }),
      mkFile({ id: "f2", name: "Exodus" }),
    ])
    expect(() => renameFile(project, "f1", "Exodus")).toThrow(/already exists/i)
  })
  it("allows renaming to the same name (no-op)", () => {
    const project = mkProject([mkFile({ id: "f1", name: "Genesis" })])
    const next = renameFile(project, "f1", "Genesis")
    expect(next.files[0].name).toBe("Genesis")
    expect(next.files[0].originalName).toBeUndefined()
  })
  it("throws if fileId not found", () => {
    const project = mkProject([mkFile({ id: "f1" })])
    expect(() => renameFile(project, "missing", "x")).toThrow(/not found/i)
  })
  it("returns a new project object (immutable)", () => {
    const project = mkProject([mkFile({ id: "f1", name: "a" })])
    const next = renameFile(project, "f1", "b")
    expect(next).not.toBe(project)
    expect(next.files).not.toBe(project.files)
  })
})

describe("moveFileToCorpus", () => {
  it("sets corpusMarker", () => {
    const project = mkProject([mkFile({ id: "f1", corpusMarker: "OT" })])
    const next = moveFileToCorpus(project, "f1", "NT")
    expect(next.files[0].corpusMarker).toBe("NT")
  })
  it("clears corpusMarker when given empty string", () => {
    const project = mkProject([mkFile({ id: "f1", corpusMarker: "OT" })])
    const next = moveFileToCorpus(project, "f1", "")
    expect(next.files[0].corpusMarker).toBeUndefined()
  })
})

describe("renameCorpus", () => {
  it("rewrites corpusMarker on every member of the group", () => {
    const project = mkProject([
      mkFile({ id: "f1", corpusMarker: "OT" }),
      mkFile({ id: "f2", corpusMarker: "OT" }),
      mkFile({ id: "f3", corpusMarker: "NT" }),
    ])
    const next = renameCorpus(project, "OT", "Old Testament")
    expect(next.files[0].corpusMarker).toBe("Old Testament")
    expect(next.files[1].corpusMarker).toBe("Old Testament")
    expect(next.files[2].corpusMarker).toBe("NT")
  })
  it("is a no-op when no files match", () => {
    const project = mkProject([mkFile({ id: "f1", corpusMarker: "NT" })])
    const next = renameCorpus(project, "OT", "Old Testament")
    expect(next.files[0].corpusMarker).toBe("NT")
  })
})

describe("deleteFile", () => {
  it("removes the file", () => {
    const project = mkProject([
      mkFile({ id: "f1" }),
      mkFile({ id: "f2", name: "Exodus" }),
    ])
    const next = deleteFile(project, "f1")
    expect(next.files).toHaveLength(1)
    expect(next.files[0].id).toBe("f2")
  })
  it("is a no-op when file not found", () => {
    const project = mkProject([mkFile({ id: "f1" })])
    const next = deleteFile(project, "missing")
    expect(next.files).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/lib/store/file-operations.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/store/file-operations.ts
import type { ProjectRecord, FileReference } from "@/lib/parsers/types"

function replaceFile(
  project: ProjectRecord,
  fileId: string,
  update: (f: FileReference) => FileReference,
): ProjectRecord {
  const idx = project.files.findIndex((f) => f.id === fileId)
  if (idx < 0) throw new Error(`File ${fileId} not found in project`)
  const nextFiles = project.files.slice()
  nextFiles[idx] = update(project.files[idx])
  return { ...project, files: nextFiles }
}

export function renameFile(
  project: ProjectRecord, fileId: string, newName: string,
): ProjectRecord {
  const trimmed = newName.trim()
  if (!trimmed) throw new Error("File name cannot be empty")
  const existing = project.files.find((f) => f.id === fileId)
  if (!existing) throw new Error(`File ${fileId} not found in project`)
  if (existing.name === trimmed) return project
  const collision = project.files.some((f) => f.id !== fileId && f.name === trimmed)
  if (collision) throw new Error(`A file named "${trimmed}" already exists in this project`)
  return replaceFile(project, fileId, (f) => ({
    ...f,
    name: trimmed,
    originalName: f.originalName ?? f.name,
  }))
}

export function moveFileToCorpus(
  project: ProjectRecord, fileId: string, corpus: string,
): ProjectRecord {
  const trimmed = corpus.trim()
  return replaceFile(project, fileId, (f) => ({
    ...f,
    corpusMarker: trimmed || undefined,
  }))
}

export function renameCorpus(
  project: ProjectRecord, oldMarker: string, newMarker: string,
): ProjectRecord {
  const trimmedNew = newMarker.trim()
  const nextFiles = project.files.map((f) =>
    f.corpusMarker === oldMarker ? { ...f, corpusMarker: trimmedNew || undefined } : f
  )
  return { ...project, files: nextFiles }
}

export function deleteFile(project: ProjectRecord, fileId: string): ProjectRecord {
  return { ...project, files: project.files.filter((f) => f.id !== fileId) }
}
```

- [ ] **Step 4: Run and verify PASS**

Run: `npx vitest run src/lib/store/file-operations.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/store/file-operations.ts src/lib/store/file-operations.test.ts
git commit -m "feat(store): add renameFile, moveFileToCorpus, renameCorpus, deleteFile helpers"
```

---

## Task 4: Suggestion detectors

**Files:**
- Create: `src/lib/file-labeling/detect.ts`
- Create: `src/lib/file-labeling/detect.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/file-labeling/detect.test.ts
import { describe, it, expect } from "vitest"
import { detectSuggestions } from "./detect"
import type { ProjectRecord, FileReference } from "@/lib/parsers/types"

function mkFile(overrides: Partial<FileReference>): FileReference {
  return {
    id: "f", name: "x", type: "usfm",
    createdAt: "2026-01-01T00:00:00Z", cellCount: 0,
    ...overrides,
  }
}

function mkProject(files: FileReference[]): ProjectRecord {
  return {
    id: "p1", name: "t", sourceLanguage: "en", targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z", files, members: [],
  }
}

describe("detectSuggestions — bible-book", () => {
  it("recognizes book code in USFM filename stem", () => {
    const p = mkProject([mkFile({ id: "1", name: "gen.usfm", type: "usfm" })])
    const s = detectSuggestions(p)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({
      fileId: "1", suggestedName: "Genesis",
      suggestedCorpus: "OT", source: "bible-book",
    })
  })
  it("handles numbered prefix like '40-MAT.usfm'", () => {
    const p = mkProject([mkFile({ id: "2", name: "40-MAT.usfm", type: "usfm" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({ suggestedName: "Matthew", suggestedCorpus: "NT" })
  })
  it("handles ebible type", () => {
    const p = mkProject([mkFile({ id: "3", name: "psa", type: "ebible" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({ suggestedName: "Psalms", suggestedCorpus: "OT" })
  })
  it("does not suggest if name is already the canonical English name", () => {
    const p = mkProject([mkFile({ id: "4", name: "Genesis", type: "usfm" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("does not suggest if corpus is already the canonical testament and name matches", () => {
    const p = mkProject([mkFile({
      id: "5", name: "Genesis", type: "usfm", corpusMarker: "OT",
    })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("suggests corpus update when name is canonical but corpus is missing", () => {
    const p = mkProject([mkFile({ id: "6", name: "Genesis", type: "usfm" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Genesis", suggestedCorpus: "OT",
    })
  })
  it("ignores non-scripture types", () => {
    const p = mkProject([mkFile({ id: "7", name: "gen.docx", type: "docx" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
})

describe("detectSuggestions — season-episode", () => {
  it("recognizes S01E02 pattern", () => {
    const p = mkProject([mkFile({ id: "1", name: "show.S01E02.vtt", type: "vtt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Season 1 · Episode 2",
      suggestedCorpus: "Season 1",
      source: "season-episode",
    })
  })
  it("recognizes 3-digit run as S1E{23}", () => {
    const p = mkProject([mkFile({ id: "2", name: "101.vtt", type: "vtt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Season 1 · Episode 1",
      suggestedCorpus: "Season 1",
    })
  })
  it("recognizes 4-digit run as S{12}E{34}", () => {
    const p = mkProject([mkFile({ id: "3", name: "1004.srt", type: "srt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Season 10 · Episode 4",
      suggestedCorpus: "Season 10",
    })
  })
  it("does not match 5+ digit runs", () => {
    const p = mkProject([mkFile({ id: "4", name: "10004.vtt", type: "vtt" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("does not match 2-digit runs", () => {
    const p = mkProject([mkFile({ id: "5", name: "10.vtt", type: "vtt" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("is case-insensitive on S/E", () => {
    const p = mkProject([mkFile({ id: "6", name: "s3e7.srt", type: "srt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({ suggestedName: "Season 3 · Episode 7" })
  })
})

describe("detectSuggestions — numbered-family", () => {
  it("groups files sharing a stem with numeric suffixes", () => {
    const p = mkProject([
      mkFile({ id: "1", name: "lesson-01.docx", type: "docx" }),
      mkFile({ id: "2", name: "lesson-02.docx", type: "docx" }),
      mkFile({ id: "3", name: "lesson-03.docx", type: "docx" }),
    ])
    const s = detectSuggestions(p)
    expect(s).toHaveLength(3)
    expect(s.map((x) => x.suggestedName).sort()).toEqual(["01", "02", "03"])
    expect(s[0].suggestedCorpus).toBe("lesson")
  })
  it("does not fire for single-file 'family'", () => {
    const p = mkProject([mkFile({ id: "1", name: "lesson-01.docx", type: "docx" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("normalizes zero-padding across the family", () => {
    const p = mkProject([
      mkFile({ id: "1", name: "part1.docx", type: "docx" }),
      mkFile({ id: "2", name: "part10.docx", type: "docx" }),
    ])
    const s = detectSuggestions(p)
    const byId = new Map(s.map((x) => [x.fileId, x.suggestedName]))
    expect(byId.get("1")).toBe("01")
    expect(byId.get("2")).toBe("10")
  })
})

describe("detectSuggestions — priority", () => {
  it("bible-book wins over numbered-family for scripture files", () => {
    const p = mkProject([
      mkFile({ id: "1", name: "gen.usfm", type: "usfm" }),
      mkFile({ id: "2", name: "exo.usfm", type: "usfm" }),
    ])
    const s = detectSuggestions(p)
    expect(s.every((x) => x.source === "bible-book")).toBe(true)
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/lib/file-labeling/detect.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/file-labeling/detect.ts
import type { ProjectRecord, FileReference } from "@/lib/parsers/types"
import { getBookName, isKnownBookCode } from "./bible-book-names"
import { getTestament } from "@/lib/codex-editor/bible-books"

export interface RenameSuggestion {
  fileId: string
  currentName: string
  suggestedName: string
  currentCorpus?: string
  suggestedCorpus?: string
  source: "bible-book" | "season-episode" | "numbered-family"
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

function detectBibleBook(file: FileReference): RenameSuggestion | null {
  if (file.type !== "usfm" && file.type !== "ebible") return null
  const stem = stripExt(file.name)
  const codeMatch = stem.match(/([A-Za-z0-9]{3})$/)?.[1]
    ?? stem.match(/^([A-Za-z0-9]{3})/)?.[1]
  if (!codeMatch || !isKnownBookCode(codeMatch)) return null
  const name = getBookName(codeMatch)!
  const corpus = getTestament(codeMatch)!
  if (file.name === name && file.corpusMarker === corpus) return null
  return {
    fileId: file.id,
    currentName: file.name,
    suggestedName: name,
    currentCorpus: file.corpusMarker,
    suggestedCorpus: corpus,
    source: "bible-book",
  }
}

function detectSeasonEpisode(file: FileReference): RenameSuggestion | null {
  if (file.type !== "vtt" && file.type !== "srt") return null
  const stem = stripExt(file.name)
  let season: number | null = null
  let episode: number | null = null

  const sxEx = stem.match(/[Ss](\d{1,2})[Ee](\d{1,3})/)
  if (sxEx) {
    season = parseInt(sxEx[1], 10)
    episode = parseInt(sxEx[2], 10)
  } else {
    const bare = stem.match(/(?<!\d)(\d{3,4})(?!\d)/)
    if (bare) {
      const digits = bare[1]
      if (digits.length === 3) {
        season = parseInt(digits[0], 10)
        episode = parseInt(digits.slice(1), 10)
      } else {
        season = parseInt(digits.slice(0, 2), 10)
        episode = parseInt(digits.slice(2), 10)
      }
    }
  }

  if (season == null || episode == null || season === 0) return null
  const suggestedName = `Season ${season} · Episode ${episode}`
  const suggestedCorpus = `Season ${season}`
  if (file.name === suggestedName && file.corpusMarker === suggestedCorpus) return null
  return {
    fileId: file.id,
    currentName: file.name,
    suggestedName,
    currentCorpus: file.corpusMarker,
    suggestedCorpus,
    source: "season-episode",
  }
}

function detectNumberedFamily(files: FileReference[]): RenameSuggestion[] {
  interface Entry { file: FileReference; stem: string; num: string }
  const parsed: Entry[] = []
  for (const file of files) {
    const stem = stripExt(file.name)
    const m = stem.match(/^(.+?)[-_\s]?(\d+)$/)
    if (!m) continue
    const base = m[1].trim().replace(/[-_\s]+$/, "")
    if (!base) continue
    parsed.push({ file, stem: base, num: m[2] })
  }
  const byStem = new Map<string, Entry[]>()
  for (const e of parsed) {
    const key = e.stem.toLowerCase()
    const arr = byStem.get(key) ?? []
    arr.push(e)
    byStem.set(key, arr)
  }
  const out: RenameSuggestion[] = []
  for (const [, group] of byStem) {
    if (group.length < 2) continue
    const width = Math.max(...group.map((g) => g.num.length), 2)
    for (const e of group) {
      const padded = e.num.padStart(width, "0")
      if (e.file.name === padded && e.file.corpusMarker === e.stem) continue
      out.push({
        fileId: e.file.id,
        currentName: e.file.name,
        suggestedName: padded,
        currentCorpus: e.file.corpusMarker,
        suggestedCorpus: e.stem,
        source: "numbered-family",
      })
    }
  }
  return out
}

export function detectSuggestions(project: ProjectRecord): RenameSuggestion[] {
  const out: RenameSuggestion[] = []
  const claimed = new Set<string>()

  for (const file of project.files) {
    try {
      const bible = detectBibleBook(file)
      if (bible) { out.push(bible); claimed.add(file.id); continue }
      const se = detectSeasonEpisode(file)
      if (se) { out.push(se); claimed.add(file.id); continue }
    } catch (e) {
      console.warn(`[detect] error on file ${file.id}:`, e)
    }
  }

  const remainder = project.files.filter((f) => !claimed.has(f.id))
  try {
    out.push(...detectNumberedFamily(remainder))
  } catch (e) {
    console.warn(`[detect] numbered-family error:`, e)
  }
  return out
}
```

- [ ] **Step 4: Run and verify PASS**

Run: `npx vitest run src/lib/file-labeling/detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/file-labeling/detect.ts src/lib/file-labeling/detect.test.ts
git commit -m "feat(file-labeling): detect bible-book, S/E, and numbered-family rename suggestions"
```

---

## Task 5: Apply suggestions helper + undo

**Files:**
- Create: `src/lib/file-labeling/apply.ts`
- Create: `src/lib/file-labeling/apply.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/file-labeling/apply.test.ts
import { describe, it, expect } from "vitest"
import { applySuggestions, buildUndo } from "./apply"
import type { RenameSuggestion } from "./detect"
import type { ProjectRecord, FileReference } from "@/lib/parsers/types"

function mkFile(overrides: Partial<FileReference>): FileReference {
  return {
    id: "f", name: "x", type: "usfm",
    createdAt: "2026-01-01T00:00:00Z", cellCount: 0,
    ...overrides,
  }
}
function mkProject(files: FileReference[]): ProjectRecord {
  return {
    id: "p1", name: "t", sourceLanguage: "en", targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z", files, members: [],
  }
}
function mkSug(overrides: Partial<RenameSuggestion>): RenameSuggestion {
  return {
    fileId: "f", currentName: "x", suggestedName: "y",
    source: "bible-book",
    ...overrides,
  }
}

describe("applySuggestions", () => {
  it("renames files and sets originalName", () => {
    const project = mkProject([mkFile({ id: "f1", name: "gen.usfm" })])
    const next = applySuggestions(project, [
      mkSug({ fileId: "f1", currentName: "gen.usfm", suggestedName: "Genesis", suggestedCorpus: "OT" }),
    ])
    expect(next.files[0].name).toBe("Genesis")
    expect(next.files[0].corpusMarker).toBe("OT")
    expect(next.files[0].originalName).toBe("gen.usfm")
  })
  it("applies multiple in one pass", () => {
    const project = mkProject([
      mkFile({ id: "f1", name: "gen.usfm" }),
      mkFile({ id: "f2", name: "exo.usfm" }),
    ])
    const next = applySuggestions(project, [
      mkSug({ fileId: "f1", currentName: "gen.usfm", suggestedName: "Genesis", suggestedCorpus: "OT" }),
      mkSug({ fileId: "f2", currentName: "exo.usfm", suggestedName: "Exodus", suggestedCorpus: "OT" }),
    ])
    expect(next.files.map((f) => f.name)).toEqual(["Genesis", "Exodus"])
  })
  it("skips files that no longer exist in the project", () => {
    const project = mkProject([mkFile({ id: "f1", name: "gen.usfm" })])
    const next = applySuggestions(project, [
      mkSug({ fileId: "missing", currentName: "x", suggestedName: "y" }),
    ])
    expect(next.files[0].name).toBe("gen.usfm")
  })
  it("preserves originalName when already set", () => {
    const project = mkProject([mkFile({
      id: "f1", name: "partly-renamed", originalName: "gen.usfm",
    })])
    const next = applySuggestions(project, [
      mkSug({ fileId: "f1", currentName: "partly-renamed", suggestedName: "Genesis" }),
    ])
    expect(next.files[0].originalName).toBe("gen.usfm")
  })
})

describe("buildUndo", () => {
  it("restores previous name and corpus", () => {
    const before = mkProject([mkFile({
      id: "f1", name: "gen.usfm", corpusMarker: undefined,
    })])
    const suggestions: RenameSuggestion[] = [
      mkSug({
        fileId: "f1", currentName: "gen.usfm", suggestedName: "Genesis",
        suggestedCorpus: "OT", currentCorpus: undefined,
      }),
    ]
    const after = applySuggestions(before, suggestions)
    const undone = buildUndo(after, suggestions)
    expect(undone.files[0].name).toBe("gen.usfm")
    expect(undone.files[0].corpusMarker).toBeUndefined()
    expect(undone.files[0].originalName).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/lib/file-labeling/apply.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/file-labeling/apply.ts
import type { ProjectRecord } from "@/lib/parsers/types"
import type { RenameSuggestion } from "./detect"

export function applySuggestions(
  project: ProjectRecord, suggestions: RenameSuggestion[],
): ProjectRecord {
  const byId = new Map(suggestions.map((s) => [s.fileId, s]))
  const nextFiles = project.files.map((f) => {
    const s = byId.get(f.id)
    if (!s) return f
    const nameChanged = f.name !== s.suggestedName
    return {
      ...f,
      name: s.suggestedName,
      corpusMarker: s.suggestedCorpus ?? f.corpusMarker,
      originalName: nameChanged && !f.originalName ? f.name : f.originalName,
    }
  })
  return { ...project, files: nextFiles }
}

export function buildUndo(
  project: ProjectRecord, suggestions: RenameSuggestion[],
): ProjectRecord {
  const byId = new Map(suggestions.map((s) => [s.fileId, s]))
  const nextFiles = project.files.map((f) => {
    const s = byId.get(f.id)
    if (!s) return f
    const { originalName: _unused, ...rest } = f
    return {
      ...rest,
      name: s.currentName,
      corpusMarker: s.currentCorpus,
    }
  })
  return { ...project, files: nextFiles }
}
```

- [ ] **Step 4: Run and verify PASS**

Run: `npx vitest run src/lib/file-labeling/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/file-labeling/apply.ts src/lib/file-labeling/apply.test.ts
git commit -m "feat(file-labeling): apply suggestions with originalName tracking and undo"
```

---

## Task 6: Multi-account session envelope + migration

**Files:**
- Modify: `src/lib/frontier/session-store.ts`
- Modify: `src/lib/frontier/session-store.test.ts`

- [ ] **Step 1: Read existing test + store to understand current shape**

Run: `cat src/lib/frontier/session-store.ts src/lib/frontier/session-store.test.ts`

- [ ] **Step 2: Add new test cases first**

Append to `src/lib/frontier/session-store.test.ts`:

```ts
import {
  listSessions, addSession, activateSession, removeSession,
  loadActiveSession, sessionKey,
} from "./session-store"
import type { FrontierSession } from "./types"

function mkSession(overrides: Partial<FrontierSession> = {}): FrontierSession {
  return {
    jwt: "jwt", gitlabToken: "g", gitlabUrl: "https://git.example.com",
    username: "ryder", createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("multi-account envelope", () => {
  beforeEach(async () => {
    const { _resetDbForTesting } = await import("./session-store")
    await _resetDbForTesting()
  })

  it("addSession persists and activates the first session", async () => {
    const s = mkSession()
    await addSession(s)
    const list = await listSessions()
    expect(list).toHaveLength(1)
    expect(list[0].username).toBe("ryder")
    const active = await loadActiveSession()
    expect(active?.username).toBe("ryder")
  })

  it("addSession does not reactivate when an active session exists", async () => {
    const a = mkSession({ username: "ryder" })
    const b = mkSession({ username: "ada" })
    await addSession(a)
    await addSession(b)
    const active = await loadActiveSession()
    expect(active?.username).toBe("ryder")
  })

  it("activateSession switches the active pointer", async () => {
    await addSession(mkSession({ username: "ryder" }))
    await addSession(mkSession({ username: "ada" }))
    await activateSession(sessionKey(mkSession({ username: "ada" })))
    const active = await loadActiveSession()
    expect(active?.username).toBe("ada")
  })

  it("removeSession removes the session and picks next-active when removing active", async () => {
    await addSession(mkSession({ username: "ryder" }))
    await addSession(mkSession({ username: "ada" }))
    await removeSession(sessionKey(mkSession({ username: "ryder" })))
    const list = await listSessions()
    expect(list).toHaveLength(1)
    const active = await loadActiveSession()
    expect(active?.username).toBe("ada")
  })

  it("removeSession with only one session clears active", async () => {
    await addSession(mkSession({ username: "ryder" }))
    await removeSession(sessionKey(mkSession({ username: "ryder" })))
    const active = await loadActiveSession()
    expect(active).toBeNull()
  })

  it("sessionKey dedupes by url + username", async () => {
    const first = mkSession({ jwt: "old" })
    const second = mkSession({ jwt: "new" })
    await addSession(first)
    await addSession(second)
    const list = await listSessions()
    expect(list).toHaveLength(1)
    const active = await loadActiveSession()
    expect(active?.jwt).toBe("new")
  })
})

describe("migration from single-session to envelope", () => {
  it("migrates on first load when only the old `current` key exists", async () => {
    const { _resetDbForTesting, saveSession: _legacySave, loadActiveSession } = await import("./session-store")
    await _resetDbForTesting()
    // Simulate legacy state by writing directly — use the existing saveSession path
    const legacy = mkSession({ username: "legacy" })
    // Directly pre-populate the old key via the module internals
    const { openDB } = await import("idb")
    const d = await openDB("frontier", 1, {
      upgrade(db) { if (!db.objectStoreNames.contains("session")) db.createObjectStore("session") },
    })
    await d.put("session", legacy, "current")
    d.close()

    const active = await loadActiveSession()
    expect(active?.username).toBe("legacy")
    const list = await listSessions()
    expect(list).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run and verify FAIL**

Run: `npx vitest run src/lib/frontier/session-store.test.ts`
Expected: FAIL (new exports missing).

- [ ] **Step 4: Implement — rewrite `src/lib/frontier/session-store.ts`**

```ts
// src/lib/frontier/session-store.ts
import { openDB } from "idb"
import type { FrontierSession } from "./types"

const DB = "frontier"
const STORE = "session"
const ENVELOPE_KEY = "envelope"
const LEGACY_KEY = "current"

interface Envelope {
  active: string | null
  sessions: Record<string, FrontierSession>
}

async function db() {
  return openDB(DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    },
  })
}

type Listener = () => void
const listeners = new Set<Listener>()
function notify() { for (const l of listeners) l() }

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function sessionKey(s: FrontierSession): string {
  return `${s.gitlabUrl}::${s.username}`
}

async function readEnvelope(): Promise<Envelope> {
  const d = await db()
  const existing = (await d.get(STORE, ENVELOPE_KEY)) as Envelope | undefined
  if (existing) return existing
  const legacy = (await d.get(STORE, LEGACY_KEY)) as FrontierSession | undefined
  if (legacy) {
    const key = sessionKey(legacy)
    const envelope: Envelope = { active: key, sessions: { [key]: legacy } }
    await d.put(STORE, envelope, ENVELOPE_KEY)
    await d.delete(STORE, LEGACY_KEY)
    return envelope
  }
  return { active: null, sessions: {} }
}

async function writeEnvelope(env: Envelope): Promise<void> {
  const d = await db()
  await d.put(STORE, env, ENVELOPE_KEY)
  notify()
}

export interface SessionSummary {
  key: string
  username: string
  gitlabUrl: string
  createdAt: string
  active: boolean
}

export async function listSessions(): Promise<SessionSummary[]> {
  const env = await readEnvelope()
  return Object.entries(env.sessions).map(([key, s]) => ({
    key, username: s.username, gitlabUrl: s.gitlabUrl,
    createdAt: s.createdAt, active: env.active === key,
  }))
}

export async function addSession(s: FrontierSession): Promise<void> {
  const env = await readEnvelope()
  const key = sessionKey(s)
  env.sessions[key] = s
  if (!env.active) env.active = key
  await writeEnvelope(env)
}

export async function activateSession(key: string): Promise<void> {
  const env = await readEnvelope()
  if (!(key in env.sessions)) throw new Error(`Unknown session key: ${key}`)
  env.active = key
  await writeEnvelope(env)
}

export async function removeSession(key: string): Promise<void> {
  const env = await readEnvelope()
  if (!(key in env.sessions)) return
  delete env.sessions[key]
  if (env.active === key) {
    const remaining = Object.keys(env.sessions)
    env.active = remaining.length > 0 ? remaining[0] : null
  }
  await writeEnvelope(env)
}

export async function loadActiveSession(): Promise<FrontierSession | null> {
  const env = await readEnvelope()
  if (!env.active) return null
  return env.sessions[env.active] ?? null
}

// Backward-compat: the old login path uses saveSession. It now adds-and-activates.
export async function saveSession(s: FrontierSession): Promise<void> {
  const env = await readEnvelope()
  const key = sessionKey(s)
  env.sessions[key] = s
  env.active = key
  await writeEnvelope(env)
}

export async function loadSession(): Promise<FrontierSession | null> {
  return loadActiveSession()
}

export async function clearSession(): Promise<void> {
  const env = await readEnvelope()
  env.active = null
  env.sessions = {}
  await writeEnvelope(env)
}

export async function _resetDbForTesting(): Promise<void> {
  const d = await db()
  await d.clear(STORE)
}
```

- [ ] **Step 5: Run and verify PASS**

Run: `npx vitest run src/lib/frontier/session-store.test.ts`
Expected: PASS (existing + new tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/frontier/session-store.ts src/lib/frontier/session-store.test.ts
git commit -m "feat(frontier): multi-account session envelope with legacy migration"
```

---

## Task 7: `useAccounts` hook

**Files:**
- Create: `src/hooks/useAccounts.ts`
- Create: `src/hooks/useAccounts.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/hooks/useAccounts.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useAccounts } from "./useAccounts"
import {
  _resetDbForTesting, addSession, sessionKey,
} from "@/lib/frontier/session-store"

describe("useAccounts", () => {
  beforeEach(async () => { await _resetDbForTesting() })

  it("returns empty state initially", async () => {
    const { result } = renderHook(() => useAccounts())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.active).toBeNull()
    expect(result.current.sessions).toHaveLength(0)
  })

  it("reflects sessions after add", async () => {
    await addSession({
      jwt: "x", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ada", createdAt: "2026-01-01T00:00:00Z",
    })
    const { result } = renderHook(() => useAccounts())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.active?.username).toBe("ada")
  })

  it("activate swaps active session", async () => {
    await addSession({
      jwt: "x", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ryder", createdAt: "2026-01-01T00:00:00Z",
    })
    await addSession({
      jwt: "y", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ada", createdAt: "2026-01-02T00:00:00Z",
    })
    const { result } = renderHook(() => useAccounts())
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
    const adaKey = sessionKey({
      jwt: "y", gitlabToken: "g", gitlabUrl: "https://git.example.com",
      username: "ada", createdAt: "2026-01-02T00:00:00Z",
    })
    await act(async () => { await result.current.activate(adaKey) })
    await waitFor(() => expect(result.current.active?.username).toBe("ada"))
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/hooks/useAccounts.test.ts`
Expected: FAIL (hook missing).

- [ ] **Step 3: Implement**

```ts
// src/hooks/useAccounts.ts
import { useEffect, useState, useCallback } from "react"
import {
  listSessions, addSession, activateSession, removeSession,
  loadActiveSession, subscribeSession,
  type SessionSummary,
} from "@/lib/frontier/session-store"
import type { FrontierSession } from "@/lib/frontier/types"

export function useAccounts() {
  const [active, setActive] = useState<FrontierSession | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [a, s] = await Promise.all([loadActiveSession(), listSessions()])
    setActive(a)
    setSessions(s)
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    refresh().catch(() => { if (!cancelled) setLoading(false) })
    const un = subscribeSession(() => { refresh() })
    return () => { cancelled = true; un() }
  }, [refresh])

  const add = useCallback(async (s: FrontierSession) => { await addSession(s) }, [])
  const activate = useCallback(async (key: string) => { await activateSession(key) }, [])
  const remove = useCallback(async (key: string) => { await removeSession(key) }, [])

  return { active, sessions, loading, add, activate, remove }
}
```

- [ ] **Step 4: Run and verify PASS**

Run: `npx vitest run src/hooks/useAccounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Make `useFrontierSession` a thin wrapper**

Replace `src/hooks/useFrontierSession.ts` with:

```ts
import { useCallback } from "react"
import { login as doLogin } from "@/lib/frontier/auth"
import { clearSession } from "@/lib/frontier/session-store"
import { useAccounts } from "@/hooks/useAccounts"

export function useFrontierSession() {
  const { active, loading } = useAccounts()

  const login = useCallback(async (username: string, password: string) => {
    return doLogin({ username, password })
  }, [])

  const logout = useCallback(async () => {
    await clearSession()
  }, [])

  return { session: active, loading, login, logout }
}
```

- [ ] **Step 6: Verify existing consumers still pass**

Run: `npx vitest run`
Expected: PASS for everything that previously passed.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useAccounts.ts src/hooks/useAccounts.test.ts src/hooks/useFrontierSession.ts
git commit -m "feat(hooks): add useAccounts and reroute useFrontierSession through it"
```

---

## Task 8: `useSidebarExpansion` hook (persist expanded fileIds)

**Files:**
- Create: `src/hooks/useSidebarExpansion.ts`

- [ ] **Step 1: Implement**

```ts
// src/hooks/useSidebarExpansion.ts
import { useCallback, useEffect, useState } from "react"

function storageKey(projectId: string) {
  return `sidebar:expanded:${projectId}`
}

function read(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === "string"))
  } catch {
    return new Set()
  }
}

export function useSidebarExpansion(projectId: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => read(projectId))

  useEffect(() => { setExpanded(read(projectId)) }, [projectId])

  const toggle = useCallback((fileId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      try {
        localStorage.setItem(storageKey(projectId), JSON.stringify(Array.from(next)))
      } catch { /* ignore quota errors */ }
      return next
    })
  }, [projectId])

  return { expanded, toggle }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSidebarExpansion.ts
git commit -m "feat(hooks): add useSidebarExpansion for persisting file-row expansion state"
```

---

## Task 9: Workspace action types + registry

**Files:**
- Create: `src/lib/workspace-actions/types.ts`
- Create: `src/lib/workspace-actions/registry.ts`
- Create: `src/lib/workspace-actions/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/lib/workspace-actions/registry.test.ts
import { describe, it, expect, vi } from "vitest"
import { getDefaultAction, getVisibleActions } from "./registry"
import type { WorkspaceAction, WorkspaceActionContext } from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"

const project: ProjectRecord = {
  id: "p1", name: "t", sourceLanguage: "en", targetLanguage: "fr",
  createdAt: "2026-01-01T00:00:00Z",
  files: [{ id: "f1", name: "a", type: "md", createdAt: "2026-01-01T00:00:00Z", cellCount: 10 }],
  members: [],
}

function ctx(overrides: Partial<WorkspaceActionContext> = {}): WorkspaceActionContext {
  return {
    project,
    activeFileId: null,
    fileProgress: new Map(),
    ...overrides,
  }
}

function mockActions(): WorkspaceAction[] {
  return [
    {
      id: "import-new", label: "+ Import",
      group: "primary",
      isAvailable: () => true,
      isDefault: (c) => c.activeFileId == null,
      run: vi.fn(),
    },
    {
      id: "run-completions", label: "Run completions",
      group: "primary",
      isAvailable: (c) => c.activeFileId != null,
      isDefault: (c) => {
        if (!c.activeFileId) return false
        const p = c.fileProgress.get(c.activeFileId)
        return !!p && p.translated < p.total
      },
      run: vi.fn(),
    },
    {
      id: "export", label: "Export",
      group: "primary",
      isAvailable: (c) => c.activeFileId != null,
      isDefault: (c) => {
        if (!c.activeFileId) return false
        const p = c.fileProgress.get(c.activeFileId)
        return !!p && p.total > 0 && p.validated === p.total
      },
      run: vi.fn(),
    },
  ]
}

describe("getDefaultAction", () => {
  it("returns import-new when no file open", () => {
    const def = getDefaultAction(mockActions(), ctx())
    expect(def.id).toBe("import-new")
  })
  it("returns run-completions when file open and partially translated", () => {
    const progress = new Map([["f1", { translated: 5, validated: 0, total: 10 }]])
    const def = getDefaultAction(mockActions(), ctx({ activeFileId: "f1", fileProgress: progress }))
    expect(def.id).toBe("run-completions")
  })
  it("returns export when file fully validated", () => {
    const progress = new Map([["f1", { translated: 10, validated: 10, total: 10 }]])
    const def = getDefaultAction(mockActions(), ctx({ activeFileId: "f1", fileProgress: progress }))
    expect(def.id).toBe("export")
  })
  it("falls back to first available when no isDefault matches", () => {
    const acts: WorkspaceAction[] = [
      { id: "a", label: "A", group: "primary", isAvailable: () => false, run: vi.fn() },
      { id: "b", label: "B", group: "primary", isAvailable: () => true, run: vi.fn() },
    ]
    const def = getDefaultAction(acts, ctx())
    expect(def.id).toBe("b")
  })
})

describe("getVisibleActions", () => {
  it("filters out unavailable actions", () => {
    const acts: WorkspaceAction[] = [
      { id: "a", label: "A", group: "primary", isAvailable: () => false, run: vi.fn() },
      { id: "b", label: "B", group: "primary", isAvailable: () => true, run: vi.fn() },
    ]
    const visible = getVisibleActions(acts, ctx())
    expect(visible.map((a) => a.id)).toEqual(["b"])
  })
})
```

- [ ] **Step 2: Run and verify FAIL**

Run: `npx vitest run src/lib/workspace-actions/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement types**

```ts
// src/lib/workspace-actions/types.ts
import type { LucideIcon } from "lucide-react"
import type { NavigateFunction } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"

export interface FileProgressEntry {
  translated: number
  validated: number
  total: number
}

export interface WorkspaceActionContext {
  project: ProjectRecord
  activeFileId: string | null
  fileProgress: Map<string, FileProgressEntry>
}

export interface WorkspaceActionRunArgs {
  openImport: () => void
  runCompletions: () => void
  runExport: () => void
  runBatchValidate: () => void
  runAgentInput: () => void
  runImportWip: () => void
  navigate: NavigateFunction
}

export interface WorkspaceAction {
  id: string
  label: string
  icon?: LucideIcon
  group: "primary" | "secondary"
  isAvailable: (ctx: WorkspaceActionContext) => boolean
  isDefault?: (ctx: WorkspaceActionContext) => boolean
  requiresConfirmation?: {
    title: string
    description: (ctx: WorkspaceActionContext) => string
    confirmLabel: string
  }
  run: (ctx: WorkspaceActionContext, args: WorkspaceActionRunArgs) => void
}
```

- [ ] **Step 4: Implement registry**

```ts
// src/lib/workspace-actions/registry.ts
import { Plus, Sparkles, Download, CheckSquare, Bot, Upload } from "lucide-react"
import type {
  WorkspaceAction, WorkspaceActionContext,
} from "./types"

export function getVisibleActions(
  actions: WorkspaceAction[], ctx: WorkspaceActionContext,
): WorkspaceAction[] {
  return actions.filter((a) => a.isAvailable(ctx))
}

export function getDefaultAction(
  actions: WorkspaceAction[], ctx: WorkspaceActionContext,
): WorkspaceAction {
  const visible = getVisibleActions(actions, ctx)
  const match = visible.find((a) => a.isDefault?.(ctx))
  return match ?? visible[0] ?? actions[0]
}

export const workspaceActions: WorkspaceAction[] = [
  {
    id: "import-new", label: "+ Import", icon: Plus, group: "primary",
    isAvailable: () => true,
    isDefault: (c) => c.activeFileId == null,
    run: (_c, args) => args.openImport(),
  },
  {
    id: "run-completions", label: "Run completions", icon: Sparkles, group: "primary",
    isAvailable: (c) => c.activeFileId != null,
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated < p.total
    },
    run: (_c, args) => args.runCompletions(),
  },
  {
    id: "batch-validate", label: "Batch validate…", icon: CheckSquare, group: "primary",
    isAvailable: (c) => c.activeFileId != null,
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated === p.total && p.validated < p.total
    },
    requiresConfirmation: {
      title: "Batch validate",
      description: (c) => {
        if (!c.activeFileId) return ""
        const p = c.fileProgress.get(c.activeFileId)
        const unvalidated = p ? p.total - p.validated : 0
        return `This marks ${unvalidated} translated cell${unvalidated === 1 ? "" : "s"} as validated under your name.`
      },
      confirmLabel: "Validate all",
    },
    run: (_c, args) => args.runBatchValidate(),
  },
  {
    id: "export", label: "Export", icon: Download, group: "primary",
    isAvailable: (c) => c.activeFileId != null,
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.validated === p.total
    },
    run: (_c, args) => args.runExport(),
  },
  {
    id: "agent-input", label: "Agent input", icon: Bot, group: "primary",
    isAvailable: () => true,
    run: (_c, args) => args.runAgentInput(),
  },
  {
    id: "import-wip", label: "Import work in progress", icon: Upload, group: "secondary",
    isAvailable: () => true,
    run: (_c, args) => args.runImportWip(),
  },
]
```

- [ ] **Step 5: Run and verify PASS**

Run: `npx vitest run src/lib/workspace-actions/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workspace-actions/
git commit -m "feat(workspace-actions): extensible action registry with default-action selector"
```

---

## Task 10: `ConfirmActionDialog` component

**Files:**
- Create: `src/components/ConfirmActionDialog.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/ConfirmActionDialog.tsx
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"

interface ConfirmActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  checkboxLabel?: string
  onConfirm: () => void
}

export function ConfirmActionDialog({
  open, onOpenChange, title, description, confirmLabel,
  checkboxLabel = "I understand this action.",
  onConfirm,
}: ConfirmActionDialogProps) {
  const [checked, setChecked] = useState(false)
  useEffect(() => { if (!open) setChecked(false) }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-2 py-2 text-sm">
          <input
            type="checkbox" checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>{checkboxLabel}</span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!checked}
            onClick={() => { onConfirm(); onOpenChange(false) }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/ConfirmActionDialog.tsx
git commit -m "feat(ui): add ConfirmActionDialog with required-checkbox gate"
```

---

## Task 11: `PrimaryActionButton` split button

**Files:**
- Create: `src/components/PrimaryActionButton.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/PrimaryActionButton.tsx
import { useRef, useState, useEffect } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  workspaceActions, getDefaultAction, getVisibleActions,
} from "@/lib/workspace-actions/registry"
import type {
  WorkspaceActionContext, WorkspaceActionRunArgs, WorkspaceAction,
} from "@/lib/workspace-actions/types"
import { ConfirmActionDialog } from "./ConfirmActionDialog"

interface Props {
  ctx: WorkspaceActionContext
  run: WorkspaceActionRunArgs
}

export function PrimaryActionButton({ ctx, run }: Props) {
  const [open, setOpen] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<WorkspaceAction | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const defaultAction = getDefaultAction(workspaceActions, ctx)
  const visible = getVisibleActions(workspaceActions, ctx)
  const primary = visible.filter((a) => a.group === "primary")
  const secondary = visible.filter((a) => a.group === "secondary")

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  function handleRun(action: WorkspaceAction) {
    setOpen(false)
    if (action.requiresConfirmation) {
      setPendingConfirm(action)
    } else {
      action.run(ctx, run)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        size="sm"
        className="rounded-r-none"
        onClick={() => handleRun(defaultAction)}
      >
        {defaultAction.icon && <defaultAction.icon className="h-4 w-4 mr-1.5" />}
        {defaultAction.label}
      </Button>
      <Button
        size="sm"
        className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border bg-popover p-1 shadow-md">
          {primary.map((a) => (
            <MenuItem
              key={a.id} action={a}
              isDefault={a.id === defaultAction.id}
              onClick={() => handleRun(a)}
            />
          ))}
          {secondary.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              {secondary.map((a) => (
                <MenuItem key={a.id} action={a} onClick={() => handleRun(a)} />
              ))}
            </>
          )}
        </div>
      )}
      {pendingConfirm?.requiresConfirmation && (
        <ConfirmActionDialog
          open={true}
          onOpenChange={(v) => { if (!v) setPendingConfirm(null) }}
          title={pendingConfirm.requiresConfirmation.title}
          description={pendingConfirm.requiresConfirmation.description(ctx)}
          confirmLabel={pendingConfirm.requiresConfirmation.confirmLabel}
          checkboxLabel="I understand this change will be attributed to my account."
          onConfirm={() => { pendingConfirm.run(ctx, run); setPendingConfirm(null) }}
        />
      )}
    </div>
  )
}

function MenuItem({
  action, isDefault, onClick,
}: {
  action: WorkspaceAction
  isDefault?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-left hover:bg-accent",
        isDefault && "font-medium",
      )}
      onClick={onClick}
    >
      {action.icon && <action.icon className="h-4 w-4" />}
      <span>{action.label}</span>
    </button>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/PrimaryActionButton.tsx
git commit -m "feat(ui): add PrimaryActionButton split button with confirmation dialog integration"
```

---

## Task 12: `AccountSwitcher` component

**Files:**
- Create: `src/components/AccountSwitcher.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/AccountSwitcher.tsx
import { useState, useEffect, useRef } from "react"
import { ChevronsUpDown, LogIn, LogOut, UserPlus, Check } from "lucide-react"
import { useAccounts } from "@/hooks/useAccounts"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { FrontierLoginForm } from "./git-import/FrontierLoginForm"
import { cn } from "@/lib/utils"

function initials(name: string): string {
  const t = name.trim()
  if (!t) return "?"
  const parts = t.split(/\s+/)
  if (parts.length === 1) return t.slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  return `hsl(${hue}, 55%, 45%)`
}

export function AccountSwitcher() {
  const { active, sessions, activate, remove } = useAccounts()
  const [open, setOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  if (!active) {
    return (
      <>
        <button
          className="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded"
          onClick={() => setLoginOpen(true)}
        >
          <LogIn className="h-4 w-4" />
          <span>Log in</span>
        </button>
        <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Log in to Frontier</DialogTitle></DialogHeader>
            <FrontierLoginForm onSuccess={() => setLoginOpen(false)} />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  const others = sessions.filter((s) => !s.active)

  return (
    <div ref={rootRef} className="relative">
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
        onClick={() => setOpen((v) => !v)}
      >
        <div
          className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
          style={{ backgroundColor: colorFor(active.username) }}
        >
          {initials(active.username)}
        </div>
        <span className="truncate flex-1 text-left">{active.username}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-60 rounded-md border bg-popover p-1 shadow-md">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Signed in
          </div>
          <Entry summary={{ key: "current", username: active.username, gitlabUrl: active.gitlabUrl, createdAt: active.createdAt, active: true }} />
          {others.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Switch to
              </div>
              {others.map((s) => (
                <Entry
                  key={s.key} summary={s}
                  onClick={() => { setOpen(false); activate(s.key) }}
                  onRemove={() => remove(s.key)}
                />
              ))}
            </>
          )}
          <div className="my-1 h-px bg-border" />
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => { setOpen(false); setLoginOpen(true) }}
          >
            <UserPlus className="h-4 w-4" />
            <span>Add another account…</span>
          </button>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => { setOpen(false); if (active) remove(sessions.find((s) => s.active)!.key) }}
          >
            <LogOut className="h-4 w-4" />
            <span>Log out</span>
          </button>
        </div>
      )}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add Frontier account</DialogTitle></DialogHeader>
          <FrontierLoginForm onSuccess={() => setLoginOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Entry({
  summary, onClick, onRemove,
}: {
  summary: { key: string; username: string; gitlabUrl: string; active: boolean }
  onClick?: () => void
  onRemove?: () => void
}) {
  const body = (
    <>
      <div
        className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
        style={{ backgroundColor: colorFor(summary.username) }}
      >
        {initials(summary.username)}
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate">{summary.username}</span>
        <span className="truncate text-[10px] text-muted-foreground">{summary.gitlabUrl}</span>
      </div>
      {summary.active && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
    </>
  )
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded px-2 py-1.5 text-sm",
        !summary.active && "hover:bg-accent cursor-pointer",
      )}
      onClick={onClick}
    >
      {body}
      {onRemove && !summary.active && (
        <button
          className="ml-1 rounded px-1 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={`Remove ${summary.username}`}
        >
          remove
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountSwitcher.tsx
git commit -m "feat(ui): add AccountSwitcher with multi-account and add-account support"
```

---

## Task 13: `FileActionMenu` hover/right-click popover

**Files:**
- Create: `src/components/FileActionMenu.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/FileActionMenu.tsx
import { useEffect, useRef } from "react"
import { Pencil, FolderInput, Trash2 } from "lucide-react"

interface FileActionMenuProps {
  x: number
  y: number
  onClose: () => void
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}

export function FileActionMenu({
  x, y, onClose, onRename, onMove, onDelete,
}: FileActionMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent | KeyboardEvent) {
      if (e instanceof KeyboardEvent && e.key === "Escape") { onClose(); return }
      if (e instanceof MouseEvent && !ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    document.addEventListener("keydown", handler)
    return () => {
      document.removeEventListener("mousedown", handler)
      document.removeEventListener("keydown", handler)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-[60] w-44 rounded-md border bg-popover p-1 shadow-md text-sm"
      style={{ left: x, top: y }}
    >
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={() => { onRename(); onClose() }}
      >
        <Pencil className="h-3.5 w-3.5" /> Rename
      </button>
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
        onClick={() => { onMove(); onClose() }}
      >
        <FolderInput className="h-3.5 w-3.5" /> Move to corpus…
      </button>
      <div className="my-1 h-px bg-border" />
      <button
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-destructive/10 text-destructive"
        onClick={() => { onDelete(); onClose() }}
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/FileActionMenu.tsx
git commit -m "feat(ui): add FileActionMenu for file-row actions"
```

---

## Task 14: `SectionRow` and `FileRow` components

**Files:**
- Create: `src/components/SectionRow.tsx`
- Create: `src/components/FileRow.tsx`

- [ ] **Step 1: Implement SectionRow**

```tsx
// src/components/SectionRow.tsx
import { cn } from "@/lib/utils"

interface SectionRowProps {
  label: string
  translated: number
  validated: number
  total: number
  onClick: () => void
}

export function SectionRow({ label, translated, validated, total, onClick }: SectionRowProps) {
  const translatedPct = total > 0 ? Math.round((translated / total) * 100) : 0
  const validatedPct = total > 0 ? Math.round((validated / total) * 100) : 0
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 pl-8 text-xs text-left",
        "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
    >
      <span className="truncate flex-1">{label}</span>
      <div className="flex items-center gap-0.5 shrink-0" aria-label={`${translatedPct}% translated, ${validatedPct}% validated`}>
        <span className="h-2 w-8 rounded-full bg-muted overflow-hidden">
          <span className="block h-full bg-amber-500" style={{ width: `${translatedPct}%` }} />
        </span>
        <span className="h-2 w-8 rounded-full bg-muted overflow-hidden">
          <span className="block h-full bg-emerald-500" style={{ width: `${validatedPct}%` }} />
        </span>
      </div>
    </button>
  )
}
```

- [ ] **Step 2: Implement FileRow**

```tsx
// src/components/FileRow.tsx
import { useEffect, useRef, useState } from "react"
import { ChevronRight, MoreHorizontal, Sparkles } from "lucide-react"
import type { FileReference } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

interface FileStats { translated: number; validated: number; total: number }

interface FileRowProps {
  file: FileReference
  active: boolean
  expanded: boolean
  progress?: FileStats
  openCommentCount?: number
  hasSuggestion?: boolean
  editing: boolean
  onEditCommit: (newName: string) => void
  onEditCancel: () => void
  onToggleExpand: () => void
  onSelect: () => void
  onOpenMenu: (x: number, y: number) => void
  onStartRename: () => void
}

export function FileRow(props: FileRowProps) {
  const {
    file, active, expanded, progress, hasSuggestion, editing,
    onEditCommit, onEditCancel, onToggleExpand, onSelect, onOpenMenu, onStartRename,
  } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(file.name)

  useEffect(() => {
    if (editing) {
      setDraft(file.name)
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
    }
  }, [editing, file.name])

  const translatedPct = progress && progress.total > 0
    ? Math.round((progress.translated / progress.total) * 100) : 0
  const validatedPct = progress && progress.total > 0
    ? Math.round((progress.validated / progress.total) * 100) : 0

  return (
    <div
      className={cn(
        "group relative flex items-center gap-1 rounded px-1 py-1 text-sm cursor-pointer",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
      onClick={(e) => { if (!editing) onSelect() }}
      onContextMenu={(e) => { e.preventDefault(); onOpenMenu(e.clientX, e.clientY) }}
      onKeyDown={(e) => {
        if (editing) return
        if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault(); onStartRename()
        }
      }}
      tabIndex={0}
    >
      <button
        className="p-0.5 hover:bg-muted rounded"
        onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
        aria-label={expanded ? "Collapse" : "Expand"}
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
      </button>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onEditCommit(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onEditCommit(draft) }
              else if (e.key === "Escape") { e.preventDefault(); onEditCancel() }
            }}
            className="w-full rounded border px-1 py-0 text-sm bg-background"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className="truncate">{file.name}</div>
            {file.originalName && (
              <div className="truncate text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                {file.originalName}
              </div>
            )}
          </>
        )}
      </div>
      {progress && progress.total > 0 && !editing && (
        <div className="flex items-center gap-0.5 shrink-0" aria-label={`${translatedPct}% translated, ${validatedPct}% validated`}>
          <span className="h-2 w-6 rounded-full bg-muted overflow-hidden">
            <span className="block h-full bg-amber-500" style={{ width: `${translatedPct}%` }} />
          </span>
          <span className="h-2 w-6 rounded-full bg-muted overflow-hidden">
            <span className="block h-full bg-emerald-500" style={{ width: `${validatedPct}%` }} />
          </span>
        </div>
      )}
      {!editing && (
        <button
          className="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onOpenMenu(e.clientX, e.clientY) }}
          aria-label="File actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      )}
      {hasSuggestion && !editing && (
        <Sparkles className="h-3 w-3 text-amber-500 shrink-0" aria-label="Rename suggestion available" />
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/FileRow.tsx src/components/SectionRow.tsx
git commit -m "feat(ui): add FileRow with inline rename and SectionRow with per-section progress"
```

---

## Task 15: `ExpandableFileList` with section aggregation

**Files:**
- Create: `src/components/ExpandableFileList.tsx`
- Create: `src/context/EditorScrollContext.tsx`

- [ ] **Step 1: Implement scroll context**

```tsx
// src/context/EditorScrollContext.tsx
import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

interface EditorScroll {
  pendingGroup: string | null
  requestScrollToGroup: (groupId: string) => void
  consume: () => string | null
}

const Ctx = createContext<EditorScroll | null>(null)

export function EditorScrollProvider({ children }: { children: ReactNode }) {
  const [pendingGroup, setPendingGroup] = useState<string | null>(null)
  const requestScrollToGroup = useCallback((g: string) => setPendingGroup(g), [])
  const consume = useCallback(() => {
    const g = pendingGroup
    if (g !== null) setPendingGroup(null)
    return g
  }, [pendingGroup])
  return <Ctx.Provider value={{ pendingGroup, requestScrollToGroup, consume }}>{children}</Ctx.Provider>
}

export function useEditorScroll(): EditorScroll {
  const v = useContext(Ctx)
  if (!v) throw new Error("useEditorScroll must be used inside EditorScrollProvider")
  return v
}
```

- [ ] **Step 2: Implement ExpandableFileList**

```tsx
// src/components/ExpandableFileList.tsx
import { useMemo, useState } from "react"
import type { FileReference } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSidebarExpansion } from "@/hooks/useSidebarExpansion"
import { FileRow } from "./FileRow"
import { SectionRow } from "./SectionRow"
import { FileActionMenu } from "./FileActionMenu"
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
import { useEditorScroll } from "@/context/EditorScrollContext"

interface FileStats { translated: number; validated: number; total: number }

interface Props {
  projectId: string
  files: FileReference[]
  activeFileId: string | null
  activeFileCells: CellData[]
  fileProgress: Map<string, FileStats>
  suggestionFileIds: Set<string>
  onSelectFile: (fileId: string) => void
  onRename: (fileId: string, newName: string) => void
  onMove: (fileId: string) => void
  onDelete: (fileId: string) => void
}

export function ExpandableFileList({
  projectId, files, activeFileId, activeFileCells, fileProgress,
  suggestionFileIds, onSelectFile, onRename, onMove, onDelete,
}: Props) {
  const { expanded, toggle } = useSidebarExpansion(projectId)
  const [menu, setMenu] = useState<{ fileId: string; x: number; y: number } | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const { requestScrollToGroup } = useEditorScroll()
  const groups = useMemo(() => groupByCorpus(files), [files])

  function sectionsFor(fileId: string) {
    if (fileId !== activeFileId || activeFileCells.length === 0) return []
    const byGroup = new Map<string, FileStats>()
    for (const c of activeFileCells) {
      const key = c.group || "Ungrouped"
      const s = byGroup.get(key) ?? { translated: 0, validated: 0, total: 0 }
      s.total += 1
      if (c.translated) s.translated += 1
      if (c.validated) s.validated += 1
      byGroup.set(key, s)
    }
    return Array.from(byGroup.entries()).map(([label, stats]) => ({ label, ...stats }))
  }

  return (
    <>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2">
          {groups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">No files imported yet.</p>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              {groups.length > 1 || group.label !== "Ungrouped" ? (
                <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
              ) : null}
              <div className="space-y-0.5">
                {group.files.map((file) => {
                  const isExpanded = expanded.has(file.id)
                  const isEditing = editingFileId === file.id
                  return (
                    <div key={file.id}>
                      <FileRow
                        file={file}
                        active={file.id === activeFileId}
                        expanded={isExpanded}
                        progress={fileProgress.get(file.id)}
                        hasSuggestion={suggestionFileIds.has(file.id)}
                        editing={isEditing}
                        onEditCommit={(name) => {
                          setEditingFileId(null)
                          if (name !== file.name) onRename(file.id, name)
                        }}
                        onEditCancel={() => setEditingFileId(null)}
                        onToggleExpand={() => toggle(file.id)}
                        onSelect={() => onSelectFile(file.id)}
                        onOpenMenu={(x, y) => setMenu({ fileId: file.id, x, y })}
                        onStartRename={() => setEditingFileId(file.id)}
                      />
                      {isExpanded && sectionsFor(file.id).map((s) => (
                        <SectionRow
                          key={s.label}
                          label={s.label}
                          translated={s.translated}
                          validated={s.validated}
                          total={s.total}
                          onClick={() => {
                            onSelectFile(file.id)
                            requestScrollToGroup(s.label)
                          }}
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      {menu && (
        <FileActionMenu
          x={menu.x} y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => setEditingFileId(menu.fileId)}
          onMove={() => onMove(menu.fileId)}
          onDelete={() => onDelete(menu.fileId)}
        />
      )}
    </>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ExpandableFileList.tsx src/context/EditorScrollContext.tsx
git commit -m "feat(ui): add ExpandableFileList with per-section progress and EditorScrollContext"
```

---

## Task 16: `SuggestionBanner` + `RenameSuggestionsDialog`

**Files:**
- Create: `src/components/SuggestionBanner.tsx`
- Create: `src/components/RenameSuggestionsDialog.tsx`

- [ ] **Step 1: Implement RenameSuggestionsDialog**

```tsx
// src/components/RenameSuggestionsDialog.tsx
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { RenameSuggestion } from "@/lib/file-labeling/detect"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  suggestions: RenameSuggestion[]
  onApply: (chosen: RenameSuggestion[]) => void
}

export function RenameSuggestionsDialog({ open, onOpenChange, suggestions, onApply }: Props) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (open) setChecked(new Set(suggestions.map((s) => s.fileId)))
  }, [open, suggestions])

  function toggle(id: string) {
    setChecked((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const chosen = suggestions.filter((s) => checked.has(s.fileId))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review suggested names</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-80">
          <ul className="space-y-1 py-2">
            {suggestions.map((s) => (
              <li key={s.fileId} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-accent">
                <input
                  type="checkbox"
                  checked={checked.has(s.fileId)}
                  onChange={() => toggle(s.fileId)}
                  className="mt-1"
                />
                <div className="flex-1 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="line-through text-muted-foreground">{s.currentName}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium">{s.suggestedName}</span>
                  </div>
                  {s.suggestedCorpus && (
                    <div className="text-xs text-muted-foreground">
                      Corpus: {s.currentCorpus ?? "—"} → {s.suggestedCorpus}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={chosen.length === 0}
            onClick={() => { onApply(chosen); onOpenChange(false) }}
          >
            Apply {chosen.length} change{chosen.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Implement SuggestionBanner**

```tsx
// src/components/SuggestionBanner.tsx
import { useState } from "react"
import { Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { RenameSuggestion } from "@/lib/file-labeling/detect"
import { RenameSuggestionsDialog } from "./RenameSuggestionsDialog"

interface Props {
  suggestions: RenameSuggestion[]
  onApply: (chosen: RenameSuggestion[]) => void
  onDismiss: () => void
}

export function SuggestionBanner({ suggestions, onApply, onDismiss }: Props) {
  const [reviewOpen, setReviewOpen] = useState(false)
  if (suggestions.length === 0) return null
  const bibleCount = suggestions.filter((s) => s.source === "bible-book").length
  const seCount = suggestions.filter((s) => s.source === "season-episode").length
  const parts: string[] = []
  if (bibleCount > 0) parts.push(`${bibleCount} Bible book${bibleCount === 1 ? "" : "s"}`)
  if (seCount > 0) parts.push(`${seCount} episode${seCount === 1 ? "" : "s"}`)
  const family = suggestions.length - bibleCount - seCount
  if (family > 0) parts.push(`${family} numbered file${family === 1 ? "" : "s"}`)
  const label = parts.join(", ")

  return (
    <>
      <div className="mx-2 mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <div className="flex items-start gap-1.5">
          <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{label} — apply friendly names?</p>
            <div className="mt-1.5 flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>Review</Button>
              <Button size="sm" onClick={() => onApply(suggestions)}>Apply all</Button>
            </div>
          </div>
          <button
            className="p-0.5 rounded hover:bg-amber-100"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <RenameSuggestionsDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        suggestions={suggestions}
        onApply={onApply}
      />
    </>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/SuggestionBanner.tsx src/components/RenameSuggestionsDialog.tsx
git commit -m "feat(ui): add SuggestionBanner and RenameSuggestionsDialog for auto-label review"
```

---

## Task 17: `SidebarProjectSection` and `SidebarCommandPaletteHint`

**Files:**
- Create: `src/components/SidebarProjectSection.tsx`
- Create: `src/components/SidebarCommandPaletteHint.tsx`

- [ ] **Step 1: Implement SidebarProjectSection**

```tsx
// src/components/SidebarProjectSection.tsx
import type { LucideIcon } from "lucide-react"
import { Scale, MessagesSquare, Camera, Share2, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ProjectNavItem {
  id: string
  label: string
  icon: LucideIcon
  badge?: number
  onClick: () => void
}

interface Props {
  items: ProjectNavItem[]
}

export function SidebarProjectSection({ items }: Props) {
  return (
    <div className="border-t px-2 py-2">
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Project
      </div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <button
            key={item.id}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent",
            )}
            onClick={item.onClick}
          >
            <item.icon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-left">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px]">{item.badge}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

export { Scale, MessagesSquare, Camera, Share2, Settings }
```

- [ ] **Step 2: Implement SidebarCommandPaletteHint**

```tsx
// src/components/SidebarCommandPaletteHint.tsx
import { Search } from "lucide-react"

interface Props { onClick: () => void }

export function SidebarCommandPaletteHint({ onClick }: Props) {
  return (
    <button
      className="flex w-full items-center gap-2 border-t px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
      onClick={onClick}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">Search</span>
      <span className="rounded border px-1 text-[10px]">⌘K</span>
    </button>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/SidebarProjectSection.tsx src/components/SidebarCommandPaletteHint.tsx
git commit -m "feat(ui): add SidebarProjectSection nav list and SidebarCommandPaletteHint"
```

---

## Task 18: `WorkspaceHeader` and `WorkspaceStatusBar`

**Files:**
- Create: `src/components/WorkspaceHeader.tsx`
- Create: `src/components/WorkspaceStatusBar.tsx`

- [ ] **Step 1: Implement WorkspaceHeader**

```tsx
// src/components/WorkspaceHeader.tsx
import type { ReactNode } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"

interface Props {
  project: ProjectRecord
  onBack: () => void
  children?: ReactNode  // right-side slot for view/video/primary action buttons
}

export function WorkspaceHeader({ project, onBack, children }: Props) {
  return (
    <header className="flex items-center gap-3 border-b bg-background px-4 py-2">
      <nav className="flex items-center gap-1 text-sm min-w-0">
        <button
          className="text-muted-foreground hover:text-foreground truncate"
          onClick={onBack}
        >
          Dashboard
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium truncate">{project.name}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground truncate">
          {project.sourceLanguage} → {project.targetLanguage}
        </span>
      </nav>
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        {children}
      </div>
    </header>
  )
}
```

- [ ] **Step 2: Implement WorkspaceStatusBar**

```tsx
// src/components/WorkspaceStatusBar.tsx
import type { ReactNode } from "react"

interface Props {
  left?: ReactNode    // peers
  right?: ReactNode   // sync
}

export function WorkspaceStatusBar({ left, right }: Props) {
  return (
    <div className="flex items-center gap-3 border-t bg-muted/30 px-4 py-1 text-xs">
      <div className="flex items-center gap-2 min-w-0">{left}</div>
      <div className="flex-1" />
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/WorkspaceHeader.tsx src/components/WorkspaceStatusBar.tsx
git commit -m "feat(ui): add WorkspaceHeader (breadcrumb) and WorkspaceStatusBar (peers + sync)"
```

---

## Task 19: `AppShell` layout composition

**Files:**
- Create: `src/components/AppShell.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/AppShell.tsx
import type { ReactNode } from "react"

interface Props {
  sidebar: ReactNode
  header: ReactNode
  statusBar: ReactNode
  beforeMain?: ReactNode   // read-only banner, sync-freeze, video player region
  main: ReactNode
  aside?: ReactNode        // drawers (rules/comments/history) rendered next to main
}

export function AppShell({ sidebar, header, statusBar, beforeMain, main, aside }: Props) {
  return (
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r bg-background">
        {sidebar}
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        {header}
        {beforeMain}
        <main className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">{main}</div>
          {aside}
        </main>
        {statusBar}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat(ui): add AppShell layout wrapper"
```

---

## Task 20: Wire everything into `ProjectWorkspace` + delete old Toolbar / ProjectSidebar

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx`
- Delete: `src/components/Toolbar.tsx`
- Delete: `src/components/ProjectSidebar.tsx`

- [ ] **Step 1: Rewrite `ProjectWorkspace.tsx` to use AppShell**

Replace the JSX return with the new shell layout. Keep all the hooks and state above untouched. The relevant replacement is from `return (` onwards — see the full block below. Preserve all existing drawers, the video player, the read-only banner, and the import/search/share dialogs.

Key changes:
- Replace `<Toolbar …>` with `<WorkspaceHeader>` wrapping `<ViewSettingsMenu>` + optional Video button + `<PrimaryActionButton>`.
- Replace `<ProjectSidebar …>` with a sidebar region composed of `<AccountSwitcher>`, `<SuggestionBanner>`, `<ExpandableFileList>`, `<SidebarProjectSection>`, `<SidebarCommandPaletteHint>`.
- Replace the existing `<StatusBar cells={…}>` with a two-row pair: the cell-level `<StatusBar>` stays (it's fine as the bottom-most row) and `<WorkspaceStatusBar>` sits above it for peers + sync.
- Wrap the whole thing with `<EditorScrollProvider>`.
- Add detection-on-load: call `detectSuggestions(project)` on every project state change; compute `suggestionFileIds` set for `ExpandableFileList` and a filtered list honoring `suggestionsDismissedAt` for the banner.

Full new `return` block and added logic:

```tsx
// Add to imports at top
import { useCallback, useMemo, useState, useRef, useEffect } from "react"
import { Film } from "lucide-react"
import { AppShell } from "./AppShell"
import { WorkspaceHeader } from "./WorkspaceHeader"
import { WorkspaceStatusBar } from "./WorkspaceStatusBar"
import { PrimaryActionButton } from "./PrimaryActionButton"
import { AccountSwitcher } from "./AccountSwitcher"
import { ExpandableFileList } from "./ExpandableFileList"
import { SidebarProjectSection } from "./SidebarProjectSection"
import { SidebarCommandPaletteHint } from "./SidebarCommandPaletteHint"
import { SuggestionBanner } from "./SuggestionBanner"
import { ConfirmActionDialog } from "./ConfirmActionDialog"
import { PeerPresence } from "./PeerPresence"
import { SyncButton } from "./SyncButton"
import { ViewSettingsMenu } from "./ViewSettingsMenu"
import { EditorScrollProvider } from "@/context/EditorScrollContext"
import { detectSuggestions, type RenameSuggestion } from "@/lib/file-labeling/detect"
import { applySuggestions, buildUndo } from "@/lib/file-labeling/apply"
import { renameFile, moveFileToCorpus, deleteFile } from "@/lib/store/file-operations"
import { Scale, MessagesSquare, Camera, Share2, Settings } from "lucide-react"
```

Inside the component, after computing `fileProgress` and `openCommentCount`, add:

```tsx
const suggestions = useMemo(
  () => (project ? detectSuggestions(project) : []),
  [project]
)
const bannerSuggestions = useMemo(() => {
  if (!project || project.suggestionsDismissedAt) return []
  return suggestions
}, [project, suggestions])
const suggestionFileIds = useMemo(
  () => new Set(suggestions.map((s) => s.fileId)),
  [suggestions]
)

const [moveTargetId, setMoveTargetId] = useState<string | null>(null)
const [moveCorpus, setMoveCorpus] = useState("")
const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
const [undo, setUndo] = useState<{ project: ProjectRecord } | null>(null)

const handleRename = useCallback(async (fileId: string, newName: string) => {
  if (!project) return
  try {
    const next = renameFile(project, fileId, newName)
    await updateProject(next)
    refresh()
  } catch (e) {
    alert(e instanceof Error ? e.message : "Rename failed")
  }
}, [project, refresh])

const handleDelete = useCallback(async (fileId: string) => {
  if (!project) return
  const next = deleteFile(project, fileId)
  await updateProject(next)
  refresh()
  if (activeFileId === fileId) setActiveFileId(null)
}, [project, refresh, activeFileId, setActiveFileId])

const handleApplySuggestions = useCallback(async (chosen: RenameSuggestion[]) => {
  if (!project) return
  const before = project
  const next = applySuggestions(project, chosen)
  await updateProject(next)
  refresh()
  setUndo({ project: before })
  setTimeout(() => setUndo((u) => (u?.project === before ? null : u)), 10000)
}, [project, refresh])

const handleDismissBanner = useCallback(async () => {
  if (!project) return
  const next = { ...project, suggestionsDismissedAt: new Date().toISOString() }
  await updateProject(next)
  refresh()
}, [project, refresh])

const projectNavItems = useMemo(() => ([
  { id: "rules", label: "Rules", icon: Scale,
    onClick: () => navigate(`/project/${projectId}/rules`) },
  { id: "comments", label: "Comments", icon: MessagesSquare,
    badge: Array.from(openCommentCount.values()).reduce((a, b) => a + b, 0),
    onClick: () => navigate(`/project/${projectId}/comments`) },
  { id: "snapshots", label: "Snapshots", icon: Camera,
    onClick: () => navigate(`/project/${projectId}/snapshots`) },
  { id: "share", label: "Share", icon: Share2,
    onClick: () => setShareOpen(true) },
  { id: "settings", label: "Settings", icon: Settings,
    onClick: () => navigate(`/project/${projectId}/settings`) },
]), [projectId, navigate, openCommentCount])

const actionCtx = useMemo(() => ({
  project: project!,
  activeFileId,
  fileProgress,
}), [project, activeFileId, fileProgress])

const actionArgs = useMemo(() => ({
  openImport: () => setImportOpen(true),
  runCompletions: () => activeFileId && completeBatch(),
  runExport: () => handleExport(),
  runBatchValidate: () => {
    // TODO hook into a future batch-validate helper once wired
    console.info("batch-validate triggered")
  },
  runAgentInput: () => {
    // Placeholder — routed into the agent-input feature when it lands
    console.info("agent-input triggered")
  },
  runImportWip: () => setImportOpen(true),
  navigate,
}), [activeFileId, completeBatch, navigate])
```

Then replace the entire `return (…)` block:

```tsx
return (
  <EditorScrollProvider>
    <AppShell
      sidebar={
        <>
          <div className="border-b p-2">
            <AccountSwitcher />
          </div>
          <SuggestionBanner
            suggestions={bannerSuggestions}
            onApply={handleApplySuggestions}
            onDismiss={handleDismissBanner}
          />
          <ExpandableFileList
            projectId={projectId!}
            files={project.files}
            activeFileId={activeFileId}
            activeFileCells={cells}
            fileProgress={fileProgress}
            suggestionFileIds={suggestionFileIds}
            onSelectFile={setActiveFileId}
            onRename={handleRename}
            onMove={(fileId) => { setMoveTargetId(fileId); setMoveCorpus(project.files.find((f) => f.id === fileId)?.corpusMarker ?? "") }}
            onDelete={(fileId) => setPendingDeleteId(fileId)}
          />
          <SidebarProjectSection items={projectNavItems} />
          <SidebarCommandPaletteHint onClick={() => setSearchOpen(true)} />
        </>
      }
      header={
        <WorkspaceHeader project={project} onBack={() => navigate("/")}>
          <ViewSettingsMenu
            fileOpen={Boolean(activeFileId)}
            lineNumbersEnabled={fileMeta.lineNumbersEnabled}
            textDirection={fileMeta.textDirection}
            cellLabelsEnabled={cellLabelsEnabled}
            onLineNumbersChange={fileMeta.setLineNumbersEnabled}
            onTextDirectionChange={fileMeta.setTextDirection}
            onCellLabelsChange={setCellLabelsEnabled}
          />
          {isSubtitleFile && (
            <button
              className="rounded p-1.5 hover:bg-accent"
              onClick={() => setVideoDialogOpen(true)}
              title="Attach video"
            >
              <Film className="h-4 w-4" />
            </button>
          )}
          <PrimaryActionButton ctx={actionCtx} run={actionArgs} />
        </WorkspaceHeader>
      }
      beforeMain={
        <>
          {isReadOnly && (
            <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900">
              <Lock className="h-3.5 w-3.5" />
              Read-only — imported from git. Push is coming in Phase 2.
            </div>
          )}
          {isSubtitleFile && videoSrc && (
            <ResizableVideoPanel>
              {(height) => (
                <VideoPlayer
                  ref={videoPlayerRef}
                  src={videoSrc}
                  cues={videoCues}
                  startOffset={videoStartOffset}
                  height={height}
                  onTimeUpdate={setCurrentVideoTime}
                />
              )}
            </ResizableVideoPanel>
          )}
          {isSubtitleFile && blobUnavailable && !videoAttachment.videoUrl && (
            <div className="bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              Video file not available on this device. Attach it locally or paste a URL via the Film icon.
            </div>
          )}
        </>
      }
      main={activeFileId ? (doc ? (
        <EditorTable
          ref={editorRef} project={project} cells={cells} doc={doc}
          username={currentUsername}
          isCompletionConfigured={isConfigured} completing={completing}
          examples={examples} errors={errors}
          onCompleteSingle={completeSingle} onCompleteBatch={completeBatch}
          healthMap={healthMap} infractions={infractions} rules={rules}
          onInfractionClick={(ruleId) => {
            setCommentsCellId(null)
            setHistoryCellId(null)
            setDrawerRuleId(ruleId)
          }}
          isBacktranslationConfigured={isBacktranslationConfigured}
          onBacktranslate={runBacktranslation}
          backtranslating={backtranslating}
          backtranslationErrors={backtranslationErrors}
          cellOpenCommentCount={cellOpenCommentCount}
          onOpenComments={(cellId) => {
            setDrawerRuleId(null); setHistoryCellId(null); setCommentsCellId(cellId)
          }}
          onOpenHistory={(cellId) => {
            setDrawerRuleId(null); setCommentsCellId(null); setHistoryCellId(cellId)
          }}
          syncProvider={syncProvider} collabUser={collabUser}
          activeCueIndex={activeCueIndex >= 0 ? activeCueIndex : undefined}
          onSeekToCue={isSubtitleFile ? handleCueSeek : undefined}
          lineNumbersEnabled={fileMeta.lineNumbersEnabled}
          cellLabelsEnabled={cellLabelsEnabled}
          textDirection={fileMeta.textDirection}
        />
      ) : <p className="p-4 text-muted-foreground">Loading file...</p>) : (
        <p className="p-4 text-muted-foreground">Select a file from the sidebar, or use + Import.</p>
      )}
      aside={
        <>
          {drawerRuleId && (
            <RuleDrawer
              rule={drawerRule} infractions={drawerInfractions} cells={cells}
              onClose={() => setDrawerRuleId(null)}
              onNavigateToCell={() => {}}
            />
          )}
          {commentsCell && (
            <CommentsDrawer
              project={project} cell={commentsCell}
              onClose={() => setCommentsCellId(null)}
              onNewThread={(text) => addThread(commentsCell.id, text)}
              onReply={(threadId, text) => addMessage(commentsCell.id, threadId, text)}
              onResolve={(threadId, msg) => resolveThread(commentsCell.id, threadId, msg)}
              onReopen={(threadId) => reopenThread(commentsCell.id, threadId)}
            />
          )}
          {historyCell && (
            <HistoryDrawer cell={historyCell} onClose={() => setHistoryCellId(null)} />
          )}
        </>
      }
      statusBar={
        <>
          <WorkspaceStatusBar
            left={<PeerPresence peers={peers} />}
            right={
              <SyncButton
                project={project}
                onUpdated={handleProjectUpdated}
                sync={runSync}
                phase={syncPhase}
                inFlight={syncInFlight}
                lastResult={syncLastResult}
              />
            }
          />
          <StatusBar cells={cells} projectHealth={projectHealth} />
        </>
      }
    />
    <ImportDialog open={importOpen} onOpenChange={setImportOpen}
      sourceLanguage={project.sourceLanguage} targetLanguage={project.targetLanguage}
      onImported={handleImported} />
    <SearchDialog
      open={searchOpen} onOpenChange={setSearchOpen}
      onReady={buildIndex} loading={searchLoading} ready={searchReady}
      results={searchResults} onSearch={runSearch} onSelect={handleSearchSelect}
    />
    <SharePanel
      open={shareOpen} onOpenChange={setShareOpen}
      projectId={projectId!}
      username={project.username || "anonymous"}
      onSharesChanged={() => setShareRefreshKey((k) => k + 1)}
    />
    <VideoAttachmentDialog
      open={videoDialogOpen} onOpenChange={setVideoDialogOpen}
      current={videoAttachment} onSave={saveVideo}
    />
    <ConfirmActionDialog
      open={pendingDeleteId !== null}
      onOpenChange={(v) => { if (!v) setPendingDeleteId(null) }}
      title="Delete file"
      description={(() => {
        const f = pendingDeleteId ? project.files.find((x) => x.id === pendingDeleteId) : null
        return f ? `Remove "${f.name}" from this project? The underlying data is not deleted from disk.` : ""
      })()}
      confirmLabel="Delete"
      checkboxLabel="I understand this removes the file from the project."
      onConfirm={() => { if (pendingDeleteId) handleDelete(pendingDeleteId); setPendingDeleteId(null) }}
    />
    <Dialog open={moveTargetId !== null} onOpenChange={(v) => { if (!v) setMoveTargetId(null) }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Move to corpus</DialogTitle></DialogHeader>
        <input
          value={moveCorpus}
          onChange={(e) => setMoveCorpus(e.target.value)}
          placeholder="Corpus name (or blank to ungroup)"
          className="w-full rounded border px-2 py-1"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setMoveTargetId(null)}>Cancel</Button>
          <Button onClick={async () => {
            if (!project || !moveTargetId) return
            const next = moveFileToCorpus(project, moveTargetId, moveCorpus)
            await updateProject(next)
            refresh()
            setMoveTargetId(null)
          }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {undo && (
      <div className="fixed bottom-4 right-4 z-[70] flex items-center gap-2 rounded border bg-background px-3 py-2 text-sm shadow-md">
        <span>Applied renames.</span>
        <Button size="sm" variant="outline" onClick={async () => {
          if (!project || !undo) return
          await updateProject(undo.project)
          refresh()
          setUndo(null)
        }}>Undo</Button>
      </div>
    )}
  </EditorScrollProvider>
)
```

You will need to add these imports at the top:

```tsx
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
```

- [ ] **Step 2: Delete the old toolbar and sidebar**

```bash
git rm src/components/Toolbar.tsx src/components/ProjectSidebar.tsx
```

- [ ] **Step 3: Verify build + tests**

Run: `npm run build`
Expected: PASS.

Run: `npm run test`
Expected: PASS (or same failing set as before the change — no NEW failures from this task).

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev` and verify in the browser:
- Create or open a project.
- Account switcher appears top-left with username and chevron menu.
- File list is expandable; clicking chevron shows section progress when a file is open.
- Hovering a file row reveals `⋯` and a greyed-out original filename (if rewritten).
- `⋯` menu has Rename / Move to corpus / Delete.
- `R` on a focused row enters inline rename mode.
- Project section below Files contains Rules, Comments, Snapshots, Share, Settings.
- ⌘K hint at the bottom of the sidebar opens Search.
- Top header shows breadcrumb + ViewSettings/Video icons + split action button.
- Split button label changes based on file progress state.
- Clicking ▾ shows all actions; `Batch validate…` opens confirmation dialog.
- Bottom status bar shows peers + sync.

Record any observations.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectWorkspace.tsx
git commit -m "feat(shell): wire ProjectWorkspace onto AppShell with Linear-inspired layout"
```

---

## Task 21: Consume `EditorScrollContext` in the editor

**Files:**
- Modify: `src/components/EditorTable.tsx`

- [ ] **Step 1: Inspect current scroll API**

Run: `grep -n "scrollToCellIndex\|VirtualList\|virtualizer" src/components/EditorTable.tsx`

- [ ] **Step 2: Add effect that consumes the pending group request**

In `EditorTable`, import `useEditorScroll` from `@/context/EditorScrollContext` and add an effect:

```tsx
import { useEditorScroll } from "@/context/EditorScrollContext"
// ... inside the component, after `cells` is in scope:
const { consume } = useEditorScroll()
useEffect(() => {
  const groupId = consume()
  if (!groupId) return
  const idx = cells.findIndex((c) => (c.group ?? "Ungrouped") === groupId)
  if (idx >= 0) {
    // Defer a tick so the virtualizer has the current cell list
    setTimeout(() => scrollToCellIndex?.(idx), 0)
  }
}, [cells, consume])
```

If the editor exposes scroll via `ref` rather than a local fn, adapt to use the forwarded handle.

- [ ] **Step 3: Verify manually**

Run: `npm run dev`, expand a file with multiple groups, click a section row — the editor should scroll to the first cell of that group.

- [ ] **Step 4: Commit**

```bash
git add src/components/EditorTable.tsx
git commit -m "feat(editor): scroll-to-group driven by EditorScrollContext requests"
```

---

## Task 22: Full-suite regression + lint + type check

- [ ] **Step 1: Run all tests**

Run: `npm run test`
Expected: PASS across all suites.

- [ ] **Step 2: Type check + build**

Run: `npm run build`
Expected: PASS with no type errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS (or same pre-existing warnings).

- [ ] **Step 4: Commit any lint fixes**

If lint surfaces issues introduced by this work, fix and:

```bash
git add -A
git commit -m "chore: post-shell-redesign lint fixes"
```

---

## Notes / Known Follow-ups

- **`agent-input` and `batch-validate` runners are placeholders** in the registry — the action is registered with its default and confirmation behaviors, but the actual runner bodies log `console.info` and do no real work. Wiring them to their real implementations is outside this plan's scope. They were kept in the registry so the extensibility shape is exercised.
- **Export when no file is open** is not re-added as a sidebar entry; users Import, open a file, then Export via the split button. This matches the design.
- **`FrontierLoginForm.onSuccess`** currently calls `saveSession` internally (via `login` → `saveSession`). Because `saveSession` now uses the envelope and activates the new session, "Add another account…" works without changes to the form.
- **Moving files into Tauri** or any platform-specific paths is unchanged.
