# Editor QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add line numbers + cell labels (with toggle), text-direction toggle (with RTL auto-detect), corpus grouping in the sidebar, and persist the active file in the URL.

**Architecture:** Reuse the `__source` metadata already stashed on each cell and on the file's `meta` Y.Map by the importer. Surface new fields through existing hooks (`useCells`, plus a new `useFileMeta`). Sidebar reads a cached `corpusMarker` from `FileReference` to avoid opening every Y.Doc. Routing makes the active file part of the URL.

**Tech Stack:** React 19, react-router-dom 7, yjs, @base-ui/react (menu primitive), tailwind 4, vitest + happy-dom + fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-04-16-editor-qol-line-numbers-corpus-routing-design.md`

---

## File map

**New:**
- `src/lib/codex-editor/bible-books.ts` — static `Map<string, "OT" | "NT">` for ~66 abbreviations
- `src/lib/codex-editor/bible-books.test.ts`
- `src/lib/sidebar/group-by-corpus.ts` — pure grouping function
- `src/lib/sidebar/group-by-corpus.test.ts`
- `src/hooks/useFileMeta.ts` — reactive per-file settings
- `src/hooks/useFileMeta.test.ts`
- `src/components/ViewSettingsMenu.tsx`

**Modified:**
- `src/lib/parsers/types.ts` — add `corpusMarker?: string` to `FileReference`
- `src/lib/importer/git-importer.ts` — populate `corpusMarker` when pushing `FileReference`
- `src/lib/importer/git-importer.test.ts` — assert population
- `src/hooks/useCells.ts` — surface `cellLabel` from `__source.metadata.cellLabel`
- `src/components/EditorTable.tsx` — gutter, line numbers, cell labels, `dir` on target column
- `src/components/ProjectSidebar.tsx` — render corpus groups
- `src/components/Toolbar.tsx` — render `ViewSettingsMenu`
- `src/components/ProjectWorkspace.tsx` — pass `fileMeta` to Toolbar/EditorTable; sync `activeFileId` ⇄ URL
- `src/App.tsx` — add `/project/:id/file/:fileId` route

---

## Task 1: Bible book → testament map

**Files:**
- Create: `src/lib/codex-editor/bible-books.ts`
- Test: `src/lib/codex-editor/bible-books.test.ts`

Used by import-time corpus fallback (`navigationWebviewProvider.ts:647-648` does the same in the desktop app).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/codex-editor/bible-books.test.ts
import { describe, it, expect } from "vitest"
import { getTestament } from "./bible-books"

describe("getTestament", () => {
  it("returns OT for Old Testament books", () => {
    expect(getTestament("GEN")).toBe("OT")
    expect(getTestament("MAL")).toBe("OT")
  })
  it("returns NT for New Testament books", () => {
    expect(getTestament("MAT")).toBe("NT")
    expect(getTestament("REV")).toBe("NT")
  })
  it("is case-insensitive on the abbreviation", () => {
    expect(getTestament("gen")).toBe("OT")
    expect(getTestament("Mat")).toBe("NT")
  })
  it("returns undefined for unknown abbreviations", () => {
    expect(getTestament("xyz")).toBeUndefined()
    expect(getTestament("")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/codex-editor/bible-books.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement bible-books.ts**

```ts
// src/lib/codex-editor/bible-books.ts
const OT = ["GEN","EXO","LEV","NUM","DEU","JOS","JDG","RUT","1SA","2SA","1KI","2KI","1CH","2CH","EZR","NEH","EST","JOB","PSA","PRO","ECC","SNG","ISA","JER","LAM","EZK","DAN","HOS","JOL","AMO","OBA","JON","MIC","NAM","HAB","ZEP","HAG","ZEC","MAL"] as const

const NT = ["MAT","MRK","LUK","JHN","ACT","ROM","1CO","2CO","GAL","EPH","PHP","COL","1TH","2TH","1TI","2TI","TIT","PHM","HEB","JAS","1PE","2PE","1JN","2JN","3JN","JUD","REV"] as const

const BOOK_TO_TESTAMENT = new Map<string, "OT" | "NT">([
  ...OT.map((b) => [b, "OT" as const] as [string, "OT"]),
  ...NT.map((b) => [b, "NT" as const] as [string, "NT"]),
])

export function getTestament(abbr: string): "OT" | "NT" | undefined {
  return BOOK_TO_TESTAMENT.get((abbr || "").toUpperCase())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/codex-editor/bible-books.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codex-editor/bible-books.ts src/lib/codex-editor/bible-books.test.ts
git commit -m "feat(qol): add Bible-book testament map for corpus grouping"
```

---

## Task 2: Corpus grouping helper

**Files:**
- Create: `src/lib/sidebar/group-by-corpus.ts`
- Test: `src/lib/sidebar/group-by-corpus.test.ts`

Mirrors `navigationWebviewProvider.ts:640-741` — group by normalized marker, sort `OT, NT, alpha, Ungrouped`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sidebar/group-by-corpus.test.ts
import { describe, it, expect } from "vitest"
import type { FileReference } from "@/lib/parsers/types"
import { groupByCorpus } from "./group-by-corpus"

function f(name: string, corpusMarker?: string): FileReference {
  return { id: name, name, type: "txt", createdAt: "", cellCount: 0, corpusMarker }
}

describe("groupByCorpus", () => {
  it("returns empty array for empty input", () => {
    expect(groupByCorpus([])).toEqual([])
  })

  it("places files with no corpusMarker into 'Ungrouped'", () => {
    const groups = groupByCorpus([f("a"), f("b")])
    expect(groups).toEqual([{ label: "Ungrouped", files: [f("a"), f("b")] }])
  })

  it("groups files by corpusMarker and orders OT, NT, alpha, Ungrouped last", () => {
    const groups = groupByCorpus([
      f("zeta", "Subtitle"),
      f("a", "NT"),
      f("b", "OT"),
      f("c", "Aardvark"),
      f("d"),
    ])
    expect(groups.map((g) => g.label)).toEqual(["OT", "NT", "Aardvark", "Subtitle", "Ungrouped"])
  })

  it("normalizes case and whitespace so 'Subtitle' and ' subtitle ' merge", () => {
    const groups = groupByCorpus([f("a", "Subtitle"), f("b", " subtitle ")])
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toHaveLength(2)
    // Display label uses the first-seen casing
    expect(groups[0].label).toBe("Subtitle")
  })

  it("sorts files within a group by name", () => {
    const groups = groupByCorpus([f("zeta", "OT"), f("alpha", "OT")])
    expect(groups[0].files.map((x) => x.name)).toEqual(["alpha", "zeta"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sidebar/group-by-corpus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement group-by-corpus.ts**

```ts
// src/lib/sidebar/group-by-corpus.ts
import type { FileReference } from "@/lib/parsers/types"

export interface CorpusGroup {
  label: string
  files: FileReference[]
}

function normalize(marker: string): string {
  return marker.trim().toLowerCase()
}

export function groupByCorpus(files: FileReference[]): CorpusGroup[] {
  const groupsByKey = new Map<string, { label: string; files: FileReference[] }>()
  const ungrouped: FileReference[] = []

  for (const file of files) {
    const raw = file.corpusMarker?.trim()
    if (!raw) {
      ungrouped.push(file)
      continue
    }
    const key = normalize(raw)
    const existing = groupsByKey.get(key)
    if (existing) {
      existing.files.push(file)
    } else {
      groupsByKey.set(key, { label: raw, files: [file] })
    }
  }

  for (const group of groupsByKey.values()) {
    group.files.sort((a, b) => a.name.localeCompare(b.name))
  }
  ungrouped.sort((a, b) => a.name.localeCompare(b.name))

  const named = Array.from(groupsByKey.values()).sort((a, b) => {
    if (a.label === "OT") return -1
    if (b.label === "OT") return 1
    if (a.label === "NT") return -1
    if (b.label === "NT") return 1
    return a.label.localeCompare(b.label)
  })

  const result: CorpusGroup[] = named
  if (ungrouped.length > 0) result.push({ label: "Ungrouped", files: ungrouped })
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sidebar/group-by-corpus.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sidebar/group-by-corpus.ts src/lib/sidebar/group-by-corpus.test.ts
git commit -m "feat(qol): add groupByCorpus helper mirroring desktop nav order"
```

---

## Task 3: Add corpusMarker to FileReference and populate during import

**Files:**
- Modify: `src/lib/parsers/types.ts:84-90`
- Modify: `src/lib/importer/git-importer.ts:235-241`
- Modify: `src/lib/importer/git-importer.test.ts` (add new assertion)

- [ ] **Step 1: Add the field to the type**

Edit `src/lib/parsers/types.ts`, replace lines 84-90:

```ts
export interface FileReference {
  id: string
  name: string
  type: FileType
  createdAt: string
  cellCount: number
  corpusMarker?: string  // From notebook metadata.corpusMarker, OT/NT fallback for biblical book stems
}
```

- [ ] **Step 2: Write failing test for importer population**

Append to `src/lib/importer/git-importer.test.ts`:

```ts
describe("importFromOpfs corpusMarker", () => {
  it("derives OT/NT from the file stem for biblical books when notebook metadata omits corpusMarker", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/repo/files/target", { recursive: true });
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true });
    await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"));
    // sample.codex has metadata { id: "tgt-gen", originalName: "Genesis Target", videoUrl: ... } (no corpusMarker)
    // The file is on disk as `sample.codex` — rename for this test by re-using existing fixture content
    const codexRaw = readFix("sample.codex");
    await fs.promises.writeFile("/repo/files/target/GEN.codex", codexRaw);
    await fs.promises.writeFile("/repo/.project/sourceTexts/GEN.source", readFix("sample.source"));

    const { project } = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
    });

    expect(project.files[0].name).toBe("GEN");
    expect(project.files[0].corpusMarker).toBe("OT");
  });

  it("uses notebook metadata.corpusMarker when present (overrides OT/NT fallback)", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/repo/files/target", { recursive: true });
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true });
    await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"));
    // Inject corpusMarker into the codex notebook metadata
    const nb = JSON.parse(readFix("sample.codex"));
    nb.metadata.corpusMarker = "Pentateuch";
    await fs.promises.writeFile("/repo/files/target/GEN.codex", JSON.stringify(nb));
    await fs.promises.writeFile("/repo/.project/sourceTexts/GEN.source", readFix("sample.source"));

    const { project } = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
    });

    expect(project.files[0].corpusMarker).toBe("Pentateuch");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/importer/git-importer.test.ts -t corpusMarker`
Expected: FAIL — `corpusMarker` undefined on `FileReference`.

- [ ] **Step 4: Implement population in importer**

In `src/lib/importer/git-importer.ts`, add the import at the top:

```ts
import { getTestament } from "@/lib/codex-editor/bible-books";
```

Then replace the `files.push(...)` block at lines 235-241 with:

```ts
    const corpusMarker = (nb.metadata?.corpusMarker as string | undefined) || getTestament(stem);

    files.push({
      id: fileId,
      name: stem,
      type: fileType,
      createdAt: new Date().toISOString(),
      cellCount: paired.length,
      ...(corpusMarker ? { corpusMarker } : {}),
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/importer/git-importer.test.ts -t corpusMarker`
Expected: PASS — 2 tests.

Then run the full importer suite to confirm no regressions:

Run: `npx vitest run src/lib/importer/git-importer.test.ts`
Expected: PASS — all tests including pre-existing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/importer/git-importer.ts src/lib/importer/git-importer.test.ts
git commit -m "feat(qol): populate FileReference.corpusMarker on import (metadata + OT/NT fallback)"
```

---

## Task 4: Surface `cellLabel` on `CellData`

**Files:**
- Modify: `src/hooks/useCells.ts`
- Test: `src/hooks/useCells.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useCells.test.ts`:

```ts
import "fake-indexeddb/auto"
import { describe, it, expect } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import { useCells } from "./useCells"

function buildDoc(label: string | undefined): Y.Doc {
  const doc = new Y.Doc()
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order")
  const yCell = new Y.Map<unknown>()
  yCell.set("id", "c1")
  yCell.set("original", "Hello")
  yCell.set("translatedXml", new Y.XmlFragment())
  yCell.set("history", new Y.Array())
  yCell.set("context", "")
  yCell.set("group", "g")
  yCell.set("type", "text")
  if (label !== undefined) {
    yCell.set("__source", { metadata: { id: "c1", cellLabel: label } })
  }
  cellsMap.set("c1", yCell)
  order.push(["c1"])
  return doc
}

describe("useCells cellLabel surfacing", () => {
  it("returns cellLabel from __source.metadata.cellLabel when present", async () => {
    const doc = buildDoc("Narrator")
    const { result } = renderHook(() => useCells(doc))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].cellLabel).toBe("Narrator")
  })

  it("returns undefined cellLabel when __source is absent", async () => {
    const doc = buildDoc(undefined)
    const { result } = renderHook(() => useCells(doc))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].cellLabel).toBeUndefined()
  })
})
```

Verify `@testing-library/react` is available — if not, install it before this step:

```bash
npm ls @testing-library/react 2>/dev/null || npm install --save-dev @testing-library/react
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useCells.test.ts`
Expected: FAIL — `cellLabel` is undefined or not on type.

- [ ] **Step 3: Add `cellLabel` to the `CellData` type**

In `src/hooks/useCells.ts`, modify the `CellData` interface at lines 7-23 to add:

```ts
  cellLabel?: string  // From cell.__source.metadata.cellLabel (codex source); user-editable label like "Narrator", "5:12"
```

(Insert after the `id` field for grouping with identifiers.)

- [ ] **Step 4: Read `cellLabel` in `computeOrdered`**

In the same file, inside `computeOrdered`'s for-loop (around line 50), after the `threads` line and before the `ordered.push(...)`, add:

```ts
        const source = cell.get("__source") as { metadata?: { cellLabel?: string } } | undefined
        const cellLabel = source?.metadata?.cellLabel || undefined
```

Then in the `ordered.push({...})` object, add:

```ts
          ...(cellLabel ? { cellLabel } : {}),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useCells.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useCells.ts src/hooks/useCells.test.ts package.json package-lock.json
git commit -m "feat(qol): surface cellLabel from __source on CellData"
```

---

## Task 5: `useFileMeta` hook

**Files:**
- Create: `src/hooks/useFileMeta.ts`
- Test: `src/hooks/useFileMeta.test.ts`

Encapsulates per-file `lineNumbersEnabled` and `textDirection` stored on `meta.__source`. Auto-seeds `textDirection` from the project's `targetLanguage` on first use. Writes update `meta.__source` (not a separate Y.Map key) to round-trip through the serializer.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useFileMeta.test.ts`:

```ts
import "fake-indexeddb/auto"
import { describe, it, expect } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import { useFileMeta } from "./useFileMeta"

function buildDoc(initialMeta: Record<string, unknown> = {}): Y.Doc {
  const doc = new Y.Doc()
  doc.getMap("meta").set("__source", { id: "f", originalName: "f", ...initialMeta })
  return doc
}

describe("useFileMeta", () => {
  it("returns defaults when meta has nothing set", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en"))
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(true))
    expect(result.current.textDirection).toBe("ltr")
  })

  it("auto-seeds textDirection to rtl when targetLanguage is Arabic", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "ar"))
    await waitFor(() => expect(result.current.textDirection).toBe("rtl"))
    // The seed is persisted to __source so future reads / serializers see it
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("rtl")
  })

  it("does not re-seed when textDirection is already set", async () => {
    const doc = buildDoc({ textDirection: "ltr" })
    const { result } = renderHook(() => useFileMeta(doc, "ar"))
    await waitFor(() => expect(result.current.textDirection).toBe("ltr"))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("ltr")
  })

  it("setLineNumbersEnabled writes to __source", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en"))
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(true))
    act(() => { result.current.setLineNumbersEnabled(false) })
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(false))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.lineNumbersEnabled).toBe(false)
  })

  it("setTextDirection writes to __source", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en"))
    await waitFor(() => expect(result.current.textDirection).toBe("ltr"))
    act(() => { result.current.setTextDirection("rtl") })
    await waitFor(() => expect(result.current.textDirection).toBe("rtl"))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("rtl")
  })

  it("returns sane defaults for null doc", () => {
    const { result } = renderHook(() => useFileMeta(null, "en"))
    expect(result.current.lineNumbersEnabled).toBe(true)
    expect(result.current.textDirection).toBe("ltr")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useFileMeta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useFileMeta`**

```ts
// src/hooks/useFileMeta.ts
import { useCallback, useEffect, useState } from "react"
import * as Y from "yjs"

const RTL_LANGS = new Set(["ar", "arc", "dv", "fa", "ha", "he", "khw", "ks", "ku", "ps", "sd", "ur", "yi"])

function detectDirection(lang: string | undefined): "ltr" | "rtl" {
  const code = (lang || "").toLowerCase().split(/[-_]/)[0]
  return RTL_LANGS.has(code) ? "rtl" : "ltr"
}

interface MetaSource {
  lineNumbersEnabled?: boolean
  textDirection?: "ltr" | "rtl"
  [key: string]: unknown
}

export interface FileMeta {
  lineNumbersEnabled: boolean
  textDirection: "ltr" | "rtl"
  setLineNumbersEnabled: (v: boolean) => void
  setTextDirection: (v: "ltr" | "rtl") => void
}

function readSource(doc: Y.Doc): MetaSource | undefined {
  return doc.getMap("meta").get("__source") as MetaSource | undefined
}

function writeSource(doc: Y.Doc, patch: Partial<MetaSource>): void {
  doc.transact(() => {
    const meta = doc.getMap("meta")
    const current = (meta.get("__source") as MetaSource | undefined) || {}
    meta.set("__source", { ...current, ...patch })
  })
}

export function useFileMeta(doc: Y.Doc | null, targetLanguage: string | undefined): FileMeta {
  const [lineNumbersEnabled, setLineNumbersEnabledState] = useState(true)
  const [textDirection, setTextDirectionState] = useState<"ltr" | "rtl">("ltr")

  useEffect(() => {
    if (!doc) return
    const meta = doc.getMap("meta")

    function read() {
      const src = readSource(doc!)
      const ln = src?.lineNumbersEnabled
      setLineNumbersEnabledState(ln === undefined ? true : Boolean(ln))
      const td = src?.textDirection
      if (td === "ltr" || td === "rtl") {
        setTextDirectionState(td)
      } else {
        const detected = detectDirection(targetLanguage)
        setTextDirectionState(detected)
        // Seed only if the field was never set
        writeSource(doc!, { textDirection: detected })
      }
    }

    read()

    function onChange() { queueMicrotask(read) }
    meta.observeDeep(onChange)
    return () => { meta.unobserveDeep(onChange) }
  }, [doc, targetLanguage])

  const setLineNumbersEnabled = useCallback((v: boolean) => {
    if (!doc) return
    writeSource(doc, { lineNumbersEnabled: v })
  }, [doc])

  const setTextDirection = useCallback((v: "ltr" | "rtl") => {
    if (!doc) return
    writeSource(doc, { textDirection: v })
  }, [doc])

  return { lineNumbersEnabled, textDirection, setLineNumbersEnabled, setTextDirection }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useFileMeta.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useFileMeta.ts src/hooks/useFileMeta.test.ts
git commit -m "feat(qol): add useFileMeta hook (lineNumbers, textDirection w/ RTL detect)"
```

---

## Task 6: `ViewSettingsMenu` component

**Files:**
- Create: `src/components/ViewSettingsMenu.tsx`

No unit test (UI component); covered by visual smoke at the end. Built on `@base-ui/react/menu` to match the dialog primitive pattern (`src/components/ui/dialog.tsx`).

- [ ] **Step 1: Implement the component**

```tsx
// src/components/ViewSettingsMenu.tsx
import { useEffect, useState } from "react"
import { Menu } from "@base-ui/react/menu"
import { Eye } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ViewSettingsMenuProps {
  fileOpen: boolean
  lineNumbersEnabled: boolean
  textDirection: "ltr" | "rtl"
  cellLabelsEnabled: boolean
  onLineNumbersChange: (v: boolean) => void
  onTextDirectionChange: (v: "ltr" | "rtl") => void
  onCellLabelsChange: (v: boolean) => void
}

export function ViewSettingsMenu({
  fileOpen,
  lineNumbersEnabled,
  textDirection,
  cellLabelsEnabled,
  onLineNumbersChange,
  onTextDirectionChange,
  onCellLabelsChange,
}: ViewSettingsMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button variant="ghost" size="sm" title="View settings">
            <Eye className="h-4 w-4" />
          </Button>
        }
      />
      <Menu.Portal>
        <Menu.Positioner sideOffset={4}>
          <Menu.Popup className="z-50 min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            <Menu.Item
              disabled={!fileOpen}
              onClick={() => onLineNumbersChange(!lineNumbersEnabled)}
              className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
            >
              <span>Show line numbers</span>
              <Pill on={lineNumbersEnabled} />
            </Menu.Item>
            <Menu.Item
              onClick={() => onCellLabelsChange(!cellLabelsEnabled)}
              className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
            >
              <span>Show cell labels</span>
              <Pill on={cellLabelsEnabled} />
            </Menu.Item>
            <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
            <Menu.Item
              disabled={!fileOpen}
              onClick={() => onTextDirectionChange(textDirection === "ltr" ? "rtl" : "ltr")}
              className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
            >
              <span>Text Direction</span>
              <span className="text-xs text-muted-foreground">{textDirection.toUpperCase()}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function Pill({ on }: { on: boolean }) {
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[10px] font-medium " +
        (on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")
      }
    >
      {on ? "On" : "Off"}
    </span>
  )
}

const STORAGE_KEY = "codex:cellLabelsEnabled:"

export function useCellLabelsPreference(projectId: string): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY + projectId)
    setEnabled(raw === null ? true : raw === "true")
  }, [projectId])

  const setAndPersist = (v: boolean) => {
    setEnabled(v)
    localStorage.setItem(STORAGE_KEY + projectId, String(v))
  }

  return [enabled, setAndPersist]
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors. (Resolve any imports that don't match — `Menu.Separator`/`Menu.Popup` exist in `@base-ui/react/menu`; if a part has a different export name, look in `node_modules/@base-ui/react/menu/index.d.ts` and adjust.)

If `Menu.Separator` is missing, replace with `<div className="-mx-1 my-1 h-px bg-border" role="separator" />`.

- [ ] **Step 3: Commit**

```bash
git add src/components/ViewSettingsMenu.tsx
git commit -m "feat(qol): add ViewSettingsMenu component (line nums / labels / dir)"
```

---

## Task 7: Wire `ViewSettingsMenu` into `Toolbar`

**Files:**
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`

Toolbar receives the props pre-resolved from the workspace so the menu stays presentational.

- [ ] **Step 1: Extend `ToolbarProps` and render the menu**

Edit `src/components/Toolbar.tsx`:

Add to imports:
```ts
import { ViewSettingsMenu } from "./ViewSettingsMenu"
```

Add to `ToolbarProps` interface (after `exportEnabled`):

```ts
  fileOpen: boolean
  lineNumbersEnabled: boolean
  textDirection: "ltr" | "rtl"
  cellLabelsEnabled: boolean
  onLineNumbersChange: (v: boolean) => void
  onTextDirectionChange: (v: "ltr" | "rtl") => void
  onCellLabelsChange: (v: boolean) => void
```

Add to the destructured args of `Toolbar`:
```ts
  fileOpen, lineNumbersEnabled, textDirection, cellLabelsEnabled,
  onLineNumbersChange, onTextDirectionChange, onCellLabelsChange,
```

Render the `<ViewSettingsMenu>` immediately before the existing `<Button onClick={onSearch}>` block (line 55):

```tsx
      <ViewSettingsMenu
        fileOpen={fileOpen}
        lineNumbersEnabled={lineNumbersEnabled}
        textDirection={textDirection}
        cellLabelsEnabled={cellLabelsEnabled}
        onLineNumbersChange={onLineNumbersChange}
        onTextDirectionChange={onTextDirectionChange}
        onCellLabelsChange={onCellLabelsChange}
      />
```

- [ ] **Step 2: Wire props from `ProjectWorkspace`**

In `src/components/ProjectWorkspace.tsx`:

Add imports near the top (around lines 35-43):

```ts
import { useFileMeta } from "@/hooks/useFileMeta"
import { useCellLabelsPreference } from "./ViewSettingsMenu"
```

Inside the component, after the existing `const cells = useCells(doc)` call (around line 60):

```tsx
  const fileMeta = useFileMeta(doc, project?.targetLanguage)
  const [cellLabelsEnabled, setCellLabelsEnabled] = useCellLabelsPreference(projectId!)
```

Pass the new props to `<Toolbar>` (around line 311):

```tsx
        fileOpen={Boolean(activeFileId)}
        lineNumbersEnabled={fileMeta.lineNumbersEnabled}
        textDirection={fileMeta.textDirection}
        cellLabelsEnabled={cellLabelsEnabled}
        onLineNumbersChange={fileMeta.setLineNumbersEnabled}
        onTextDirectionChange={fileMeta.setTextDirection}
        onCellLabelsChange={setCellLabelsEnabled}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/Toolbar.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(qol): mount ViewSettingsMenu in Toolbar with workspace state"
```

---

## Task 8: `EditorTable` — line-number gutter, cell-label badge, `dir` on target

**Files:**
- Modify: `src/components/EditorTable.tsx`

- [ ] **Step 1: Extend `EditorTableProps`**

In `src/components/EditorTable.tsx`, add to `EditorTableProps` (around line 23-49):

```ts
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  textDirection: "ltr" | "rtl"
```

Add to the destructured args of the `forwardRef` callback (around line 51-60):

```ts
  lineNumbersEnabled, cellLabelsEnabled, textDirection,
```

- [ ] **Step 2: Compute the dynamic gutter and update the header grid**

Inside the component body (after the `useImperativeHandle`):

```ts
  const showGutterContent = lineNumbersEnabled || cellLabelsEnabled
  const gutterCls = showGutterContent ? "w-12" : "w-6"
  const gridTemplate = showGutterContent
    ? "grid-cols-[48px_1fr_1fr]"
    : "grid-cols-[24px_1fr_1fr]"
```

Replace the header line (around line 94) with:

```tsx
      <div className={`sticky top-0 z-10 grid ${gridTemplate} gap-2 border-b bg-background px-4 py-2 text-sm font-medium text-muted-foreground`}>
        <div />
        <div>Source</div>
        <div>Target</div>
      </div>
```

- [ ] **Step 3: Render gutter content + pass `dir` to the row**

`EditorRow` already lays out source/target. Locate where the row content is composed (search for `Source` or for the `<div>` containing source text). Wrap the gutter cell at the row level — i.e. inside the `virtualizer.getVirtualItems()` map callback in `EditorTable`, *before* `<EditorRow ...>`:

Replace the `<EditorRow ... />` invocation with a wrapper that injects the gutter alongside the row. The simplest approach: pass new props to `EditorRow` and let it render the gutter.

Add to `EditorRowProps` (around line 171):

```ts
  rowIndex: number
  lineNumbersEnabled: boolean
  cellLabelsEnabled: boolean
  textDirection: "ltr" | "rtl"
  showGutterContent: boolean
```

Pass these in the parent map callback (around line 129):

```tsx
              <EditorRow
                cell={cell}
                doc={doc}
                username={username}
                editable={canEdit}
                rowIndex={virtualRow.index}
                lineNumbersEnabled={lineNumbersEnabled}
                cellLabelsEnabled={cellLabelsEnabled}
                textDirection={textDirection}
                showGutterContent={showGutterContent}
                /* ... rest of existing props ... */
```

In `EditorRow`'s body, find the outer grid (search for `grid-cols-`). Currently each row uses the same `[24px_1fr_1fr]` template. Replace with a dynamic template using the props, and render the gutter:

```tsx
  const lineNumber = cell.type === "paratext" ? "" : String(rowIndex + 1)
  const gridCols = showGutterContent ? "grid-cols-[48px_1fr_1fr]" : "grid-cols-[24px_1fr_1fr]"
```

Inside the row render, the leftmost cell of the grid becomes:

```tsx
        <div className="flex flex-col items-end gap-0.5 pr-1">
          {lineNumbersEnabled && lineNumber && (
            <span className="text-[10px] tabular-nums text-muted-foreground/70" title={`Line ${lineNumber}`}>
              {lineNumber}
            </span>
          )}
          {cellLabelsEnabled && cell.cellLabel && (
            <span className="rounded bg-muted/40 px-1 text-[10px] text-muted-foreground" title="Cell label">
              {cell.cellLabel}
            </span>
          )}
        </div>
```

The target column wrapper (search for "Target" text or for the `translatedXml` editor binding) gets `dir={textDirection}`:

```tsx
        <div dir={textDirection}>
          {/* existing target editor */}
        </div>
```

(Find the existing second-column wrapper in `EditorRow` and add the `dir` attribute. If the target column is rendered without a wrapping element, add a `<div className="contents" dir={textDirection}>` around the editor.)

- [ ] **Step 4: Wire from `ProjectWorkspace`**

In `ProjectWorkspace.tsx`, pass the new props to `<EditorTable>` (around line 369):

```tsx
                lineNumbersEnabled={fileMeta.lineNumbersEnabled}
                cellLabelsEnabled={cellLabelsEnabled}
                textDirection={fileMeta.textDirection}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Visual smoke**

Start the dev server:

```bash
npm run dev
```

Open a project. Verify:
- Line numbers show in the gutter, are muted, hidden for paratext cells.
- Open the View menu — toggle line numbers, verify they hide/show.
- Toggle cell labels — verify the badge hides/shows for cells with labels.
- For an Arabic-target project, the target column is right-aligned (`dir="rtl"`); toggle direction in the menu and verify it flips.
- Refresh — settings persist (line numbers + dir from `meta`, cell labels from localStorage).

- [ ] **Step 7: Commit**

```bash
git add src/components/EditorTable.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(qol): line-number gutter, cell-label badges, dir on target column"
```

---

## Task 9: `ProjectSidebar` — corpus grouping

**Files:**
- Modify: `src/components/ProjectSidebar.tsx`

- [ ] **Step 1: Render groups instead of a flat list**

Edit `src/components/ProjectSidebar.tsx`:

Add to imports:
```ts
import { groupByCorpus } from "@/lib/sidebar/group-by-corpus"
```

Inside the component body, before the `return`:

```ts
  const groups = groupByCorpus(files)
  const showHeaders = groups.length > 1 || (groups[0]?.label !== "Ungrouped")
```

Replace the existing flat `<ul>` (lines 43-93) with a loop over groups. Extract the existing `<li>` body into a helper, or inline it inside the group loop:

```tsx
        {files.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No files imported yet.</p>
        ) : (
          <div className="space-y-2">
            {groups.map((group) => (
              <details key={group.label} open className="group">
                {showHeaders && (
                  <summary className="cursor-pointer list-none px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </summary>
                )}
                <ul className="space-y-1">
                  {group.files.map((file) => {
                    const progress = fileProgress.get(file.id)
                    const health = fileHealth.get(file.id) ?? 0
                    const translatedPct = progress && progress.total > 0
                      ? Math.round((progress.translated / progress.total) * 100) : 0
                    const validatedPct = progress && progress.total > 0
                      ? Math.round((progress.validated / progress.total) * 100) : 0
                    return (
                      <li key={file.id}>
                        <button
                          className={cn(
                            "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                            activeFileId === file.id && "bg-accent font-medium"
                          )}
                          onClick={() => onSelectFile(file.id)}
                        >
                          <div className="flex items-center gap-1.5">
                            <HealthRing health={health} size={16} strokeWidth={2} />
                            <span className="truncate">{file.name}</span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-blue-400/50 transition-all duration-500" style={{ width: `${translatedPct}%` }} />
                          </div>
                          <div className="-mt-1.5 h-1.5 w-full overflow-hidden rounded-full">
                            <div className="h-full rounded-full bg-green-500 transition-all duration-500" style={{ width: `${validatedPct}%` }} />
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {progress ? `${progress.translated}/${progress.total}` : `${file.cellCount} cells`}
                          </div>
                          {openCommentCount && (openCommentCount.get(file.id) || 0) > 0 && (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-blue-500">
                              <MessageCircle className="h-2.5 w-2.5" />
                              {openCommentCount.get(file.id)} open
                            </div>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </details>
            ))}
          </div>
        )}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Visual smoke**

Run `npm run dev`. Open a project that has Bible files (e.g. `GEN.codex`, `MAT.codex`, etc.). Verify:
- Files appear under "OT" / "NT" headers.
- A project with no recognized corpus markers (e.g. a markdown-only project) still renders flat (no header shown).
- Mixed corpus + ungrouped: ungrouped sit under an "Ungrouped" header at the bottom.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProjectSidebar.tsx
git commit -m "feat(qol): group sidebar files by corpus (mirrors desktop nav)"
```

---

## Task 10: Backfill `corpusMarker` for existing imported projects

**Files:**
- Modify: `src/components/ProjectWorkspace.tsx` (or new hook `src/hooks/useCorpusBackfill.ts`)

Existing projects in IndexedDB don't have `corpusMarker` on their `FileReference`s. Run a one-time backfill on workspace mount: for each file missing a marker, open its Y.Doc, read `meta.__source.corpusMarker`, fall back to `getTestament(file.name)`, write back via `updateProject`.

- [ ] **Step 1: Implement the backfill hook**

Create `src/hooks/useCorpusBackfill.ts`:

```ts
import { useEffect, useRef } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { updateProject } from "@/lib/store/project-index"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { getTestament } from "@/lib/codex-editor/bible-books"

export function useCorpusBackfill(project: ProjectRecord | null, onUpdated: () => void) {
  const ranFor = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    if (ranFor.current === project.id) return
    ranFor.current = project.id

    const missing = project.files.filter((f) => !f.corpusMarker)
    if (missing.length === 0) return

    let cancelled = false
    ;(async () => {
      const updates: Record<string, string> = {}
      for (const file of missing) {
        const handle = loadFileDoc(file.id)
        try {
          await new Promise<void>((resolve) => {
            if (handle.persistence.synced) resolve()
            else handle.persistence.once("synced", () => resolve())
          })
          if (cancelled) return
          const meta = handle.doc.getMap("meta").get("__source") as { corpusMarker?: string } | undefined
          const marker = meta?.corpusMarker || getTestament(file.name)
          if (marker) updates[file.id] = marker
        } finally {
          destroyFileDoc(handle)
        }
      }
      if (cancelled || Object.keys(updates).length === 0) return
      const updatedFiles = project.files.map((f) =>
        updates[f.id] ? { ...f, corpusMarker: updates[f.id] } : f
      )
      await updateProject({ ...project, files: updatedFiles })
      if (!cancelled) onUpdated()
    })()

    return () => { cancelled = true }
  }, [project, onUpdated])
}
```

- [ ] **Step 2: Mount the hook in `ProjectWorkspace`**

In `src/components/ProjectWorkspace.tsx`, add to imports:

```ts
import { useCorpusBackfill } from "@/hooks/useCorpusBackfill"
```

After the existing `useAutoSync(...)` call (around line 265):

```ts
  useCorpusBackfill(project ?? null, refresh)
```

- [ ] **Step 3: Type-check + smoke**

Run: `npx tsc --noEmit` — Expected: PASS.

Run `npm run dev`. Open an existing biblical project (one that was imported before this branch). The sidebar should reorganize into OT/NT groups within a few seconds (the time for each Y.Doc to sync from IndexedDB).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useCorpusBackfill.ts src/components/ProjectWorkspace.tsx
git commit -m "feat(qol): backfill corpusMarker on existing projects (one-shot)"
```

---

## Task 11: URL routing for the active file

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Add the new route**

In `src/App.tsx`, add a new `<Route>` after the existing project route (around line 36):

```tsx
        <Route path="/project/:id/file/:fileId" element={<ProjectWorkspace />} />
```

(The route order matters only if there's overlap — but `/project/:id` and `/project/:id/file/:fileId` don't overlap.)

- [ ] **Step 2: Replace `useState` with URL-derived `activeFileId`**

In `src/components/ProjectWorkspace.tsx`:

Modify the `useParams` call (line 46) to also pull `fileId`:

```ts
  const { id: projectId, fileId: routeFileId } = useParams<{ id: string; fileId?: string }>()
```

Remove the `useState` for `activeFileId` (line 49).

Add a derived value + a setter that navigates:

```ts
  const activeFileId = routeFileId ?? null

  const setActiveFileId = useCallback((fileId: string | null) => {
    if (!projectId) return
    if (fileId) {
      navigate(`/project/${projectId}/file/${fileId}`)
    } else {
      navigate(`/project/${projectId}`)
    }
  }, [projectId, navigate])
```

(Place this near the top of the component, after the existing `const navigate = useNavigate()`.)

- [ ] **Step 3: Validate the URL fileId**

Add an effect that resets the URL if the fileId doesn't exist in the project (e.g. after a file was deleted):

```ts
  useEffect(() => {
    if (!project || !routeFileId) return
    const exists = project.files.some((f) => f.id === routeFileId)
    if (!exists) {
      navigate(`/project/${projectId}`, { replace: true })
    }
  }, [project, routeFileId, projectId, navigate])
```

- [ ] **Step 4: Adjust the import handler**

The existing `handleImported` calls `setActiveFileId(refs[0].id)` (line 296) — this still works since `setActiveFileId` is now a navigate. Confirm by re-reading the function.

- [ ] **Step 5: Type-check + smoke**

Run: `npx tsc --noEmit` — Expected: PASS.

Run `npm run dev`. Verify:
- Click a file in the sidebar — URL updates to `/project/<id>/file/<fileId>`.
- Refresh the page — same file is open.
- Manually edit the URL to a non-existent fileId — workspace returns to `/project/<id>` with no file open.
- Browser back button moves between files.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat(qol): persist active file in URL (/project/:id/file/:fileId)"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests including pre-existing.

If any pre-existing test fails because of the changes (e.g. a `FileReference` shape assertion), update the assertion to match the new optional `corpusMarker` field. Do NOT skip tests.

- [ ] **Step 2: Type-check the project**

Run: `npm run build`
Expected: PASS — build completes.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS or only pre-existing warnings (no new errors).

- [ ] **Step 4: End-to-end smoke**

Run `npm run dev`. Walk through:
1. Open a project that has biblical content.
2. Sidebar shows OT/NT groups.
3. Open a file — line numbers visible in muted gutter.
4. Cell labels visible where present.
5. Open View menu — toggle each item, verify behavior.
6. Refresh page — file stays open via URL, settings persist.
7. For an Arabic-target project (or one you can quickly create via the Import dialog): target column renders RTL by default.

- [ ] **Step 5: No further commit**

All work is committed in prior tasks. If you find issues during smoke, fix them inline and amend or add a follow-up commit.

---

## Self-review notes

- **Spec coverage:** All five spec sections are covered (1: Tasks 1-3,9; 2: Task 4; 3: Tasks 5-8; 4: Task 11; "RTL auto-detect" is in Task 5; corpus backfill is in Task 10). ✓
- **Type consistency:** `FileMeta`, `FileReference.corpusMarker`, `CellData.cellLabel`, and `groupByCorpus` signatures are defined once and referenced consistently across tasks.
- **No placeholders:** every step has actual code or an exact command. The only "find the existing X" guidance is in Task 8 step 3 where `EditorRow`'s internal layout is too verbose to inline; the engineer adapts the existing two-column layout to the new template — explicit grid template + render code is provided.
