# Codex Web App — Milestone 5: Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the round-trip — export translated cells back to their original file format (surgical for DOCX/PPTX, reconstruct for TXT/MD/VTT/SRT/USFM).

**Architecture:** Two export strategies. Surgical: load original ArrayBuffer, open with JSZip, find blocks by stored sourceLocation path, atomically replace block text content (dropping inline runs), preserve all other structure. Reconstruct: rebuild format from cell data directly. Single entry point `exportFile()` dispatches based on file type and presence of original.

**Tech Stack:** JSZip (already installed), DOMParser/XMLSerializer (browser), happy-dom (tests), existing cell data model

---

## File Structure

```
src/
├── lib/
│   ├── export/
│   │   ├── export-service.ts           # NEW: exportFile entry point
│   │   ├── surgical-export.ts          # NEW: DOCX/PPTX surgical
│   │   ├── surgical-export.test.ts     # NEW: TDD
│   │   └── rebuilders/
│   │       ├── plaintext.ts            # NEW
│   │       ├── markdown.ts             # NEW
│   │       ├── subtitle.ts             # NEW (VTT + SRT)
│   │       ├── usfm.ts                 # NEW
│   │       └── rebuilders.test.ts      # NEW: TDD for all 5 rebuilders
│   └── parsers/
│       ├── types.ts                    # MODIFY: add SourceLocation
│       ├── docx.ts                     # MODIFY: set sourceLocation per block
│       ├── docx.test.ts                # MODIFY: assert sourceLocation set
│       ├── pptx.ts                     # MODIFY: set sourceLocation per block
│       └── pptx.test.ts                # MODIFY: assert sourceLocation set
├── hooks/
│   └── useCells.ts                     # MODIFY: expose sourceLocation on CellData
├── lib/store/
│   └── file-doc.ts                     # MODIFY: persist sourceLocation in Y.Map, collectExportCells helper
└── components/
    └── Toolbar.tsx                     # MODIFY: add Download button
```

---

### Task 1: SourceLocation type + parser updates

**Files:**
- Modify: `src/lib/parsers/types.ts`
- Modify: `src/lib/parsers/docx.ts`
- Modify: `src/lib/parsers/docx.test.ts`
- Modify: `src/lib/parsers/pptx.ts`
- Modify: `src/lib/parsers/pptx.test.ts`

- [ ] **Step 1: Add SourceLocation to types.ts**

In `src/lib/parsers/types.ts`, add the SourceLocation interface (after existing interfaces, before ProjectRecord):

```typescript
export interface SourceLocation {
  file: string       // e.g. "word/document.xml", "ppt/slides/slide3.xml"
  blockPath: string  // indexed path to block, e.g. "w:p[2]" or "p:sp[1]/p:txBody/a:p[3]"
}
```

Add optional `sourceLocation` field to `TranslatableString`:

```typescript
export interface TranslatableString {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  type: CellType
  sourceLocation?: SourceLocation
}
```

- [ ] **Step 2: Modify DOCX parser to track block paths**

Read `src/lib/parsers/docx.ts`. Modify the main loop to track block index and set sourceLocation on every extracted string.

Replace the existing loop with this structure:

```typescript
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const { plain, html, hasFormatting } = extractRuns(p)
    if (!plain.trim()) continue

    const style = getParaStyle(p)
    const context = style || "Paragraph"
    const type = style?.startsWith("Heading") ? ("heading" as const) : ("text" as const)
    const segments = splitIntoSegments(plain)
    const sourceLocation = {
      file: "word/document.xml",
      blockPath: `w:p[${i + 1}]`, // 1-based index
    }

    for (const seg of segments) {
      results.push({
        id: uuid(),
        original: seg.text,
        originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
        translated: "",
        context,
        group: seg.group,
        type,
        sourceLocation,
      })
    }
  }
```

Note: the block index is based on `<w:p>` position in the full document. This is position among all extracted blocks, matching what `getElementsByTagName("w:p")` returns.

- [ ] **Step 3: Add DOCX parser test for sourceLocation**

In `src/lib/parsers/docx.test.ts`, add a new test after the existing tests:

```typescript
  it("sets sourceLocation with block path", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result).toHaveLength(2)
    expect(result[0].sourceLocation).toEqual({
      file: "word/document.xml",
      blockPath: "w:p[1]",
    })
    expect(result[1].sourceLocation).toEqual({
      file: "word/document.xml",
      blockPath: "w:p[2]",
    })
  })
```

- [ ] **Step 4: Run DOCX tests**

```bash
npx vitest run src/lib/parsers/docx.test.ts
```

Expected: all tests PASS including the new sourceLocation test.

- [ ] **Step 5: Modify PPTX parser to track block paths**

Read `src/lib/parsers/pptx.ts`. The current parser iterates slides and paragraphs. Modify to track shape and paragraph indices.

Replace the slide-processing loop with this structure:

```typescript
  for (let slideIndex = 0; slideIndex < slideFiles.length; slideIndex++) {
    const slideFile = slideFiles[slideIndex]
    const xmlStr = await zip.file(slideFile)!.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")

    // Find shapes with text bodies; track shape and paragraph indices
    const shapes = doc.getElementsByTagName("p:sp")

    for (let spIdx = 0; spIdx < shapes.length; spIdx++) {
      const shape = shapes[spIdx]
      const paragraphs = shape.getElementsByTagName("a:p")

      for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const p = paragraphs[pIdx]
        const { plain, html, hasFormatting } = extractPptxRuns(p)
        if (!plain.trim()) continue

        const context = `Slide ${slideIndex + 1}`
        const segments = splitIntoSegments(plain)
        const sourceLocation = {
          file: slideFile,
          blockPath: `p:sp[${spIdx + 1}]/p:txBody/a:p[${pIdx + 1}]`,
        }

        for (const seg of segments) {
          results.push({
            id: uuid(),
            original: seg.text,
            originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
            translated: "",
            context,
            group: seg.group,
            type: "text",
            sourceLocation,
          })
        }
      }
    }
  }
```

This changes the iteration from "all paragraphs in slide" to "all paragraphs in each shape", which gives us proper shape-scoped indices.

- [ ] **Step 6: Add PPTX parser test for sourceLocation**

In `src/lib/parsers/pptx.test.ts`, add a new test:

```typescript
  it("sets sourceLocation with shape and paragraph path", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>First para</a:t></a:r></a:p>
          <a:p><a:r><a:t>Second para</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(2)
    expect(result[0].sourceLocation).toEqual({
      file: "ppt/slides/slide1.xml",
      blockPath: "p:sp[1]/p:txBody/a:p[1]",
    })
    expect(result[1].sourceLocation).toEqual({
      file: "ppt/slides/slide1.xml",
      blockPath: "p:sp[1]/p:txBody/a:p[2]",
    })
  })
```

- [ ] **Step 7: Update existing PPTX tests that test multiple slides**

The refactor changed how paragraphs are collected. Check that the existing "extracts from multiple slides in order" test still passes — it uses one shape per slide with one paragraph, which should work. Other tests also use single shapes.

Run:

```bash
npx vitest run src/lib/parsers/pptx.test.ts
```

Expected: all tests PASS including the new sourceLocation test.

- [ ] **Step 8: Run all tests to ensure no regressions**

```bash
npx vitest run
```

Expected: all 105 existing tests PASS + 2 new tests.

- [ ] **Step 9: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/parsers/docx.ts src/lib/parsers/docx.test.ts src/lib/parsers/pptx.ts src/lib/parsers/pptx.test.ts
git commit -m "feat: capture SourceLocation metadata in DOCX and PPTX parsers"
```

---

### Task 2: Persist sourceLocation in Yjs + expose on CellData

**Files:**
- Modify: `src/lib/store/file-doc.ts`
- Modify: `src/hooks/useCells.ts`

- [ ] **Step 1: Persist sourceLocation when creating cells**

Read `src/lib/store/file-doc.ts`. In `createFileDoc`, inside the `doc.transact` block, add sourceLocation persistence. Find the cell creation loop and add this after `cell.set("history", new Y.Array())`:

```typescript
      if (str.sourceLocation) cell.set("sourceLocation", str.sourceLocation)
```

The complete loop becomes:

```typescript
    for (const str of strings) {
      const cell = new Y.Map()
      cell.set("id", str.id)
      cell.set("original", str.original)
      if (str.originalHtml) cell.set("originalHtml", str.originalHtml)
      cell.set("translated", str.translated)
      cell.set("context", str.context)
      cell.set("group", str.group)
      cell.set("type", str.type)
      cell.set("history", new Y.Array())
      if (str.sourceLocation) cell.set("sourceLocation", str.sourceLocation)
      cells.set(str.id, cell)
      order.push([str.id])
    }
```

- [ ] **Step 2: Extend collectValidatedPairs-style helper for export**

In the same file, after the `collectValidatedPairs` function, add a new helper `collectExportCells`:

```typescript
export interface ExportCell {
  id: string
  original: string
  translated: string
  context: string
  group: string
  type: string
  sourceLocation?: { file: string; blockPath: string }
}

export interface ExportData {
  fileId: string
  fileName: string
  fileType: string
  sourceLanguage: string
  targetLanguage: string
  cells: ExportCell[]
}

// Load a single file's export data: meta + all cells in order.
export async function collectExportCells(fileId: string): Promise<ExportData> {
  const handle = loadFileDoc(fileId)
  try {
    await new Promise<void>((resolve) => {
      if (handle.persistence.synced) resolve()
      else handle.persistence.once("synced", () => resolve())
    })

    const meta = handle.doc.getMap("meta")
    const cellsMap = handle.doc.getMap("cells")
    const orderArray = handle.doc.getArray<string>("order")

    const cells: ExportCell[] = []
    for (const cellId of orderArray.toArray()) {
      const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
      if (!cell) continue
      cells.push({
        id: (cell.get("id") as string) || cellId,
        original: (cell.get("original") as string) || "",
        translated: (cell.get("translated") as string) || "",
        context: (cell.get("context") as string) || "",
        group: (cell.get("group") as string) || "",
        type: (cell.get("type") as string) || "text",
        sourceLocation: cell.get("sourceLocation") as { file: string; blockPath: string } | undefined,
      })
    }

    return {
      fileId,
      fileName: (meta.get("fileName") as string) || "untitled",
      fileType: (meta.get("fileType") as string) || "txt",
      sourceLanguage: (meta.get("sourceLanguage") as string) || "",
      targetLanguage: (meta.get("targetLanguage") as string) || "",
      cells,
    }
  } finally {
    destroyFileDoc(handle)
  }
}
```

- [ ] **Step 3: Expose sourceLocation on CellData**

Read `src/hooks/useCells.ts`. Add `sourceLocation` to the `CellData` interface:

```typescript
import type { CellHistoryEntry, SourceLocation } from "@/lib/parsers/types"

export interface CellData {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  type: string
  status: "empty" | "unvalidated" | "validated"
  history: CellHistoryEntry[]
  sourceLocation?: SourceLocation
}
```

In the `update` function inside the useEffect, read sourceLocation from the cell:

```typescript
        ordered.push({
          id: cell.get("id") as string,
          original: cell.get("original") as string,
          originalHtml: cell.get("originalHtml") as string | undefined,
          translated,
          context: cell.get("context") as string,
          group: cell.get("group") as string,
          type: cell.get("type") as string,
          status: deriveStatus(translated, history),
          history,
          sourceLocation: cell.get("sourceLocation") as SourceLocation | undefined,
        })
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: all tests still PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/store/file-doc.ts src/hooks/useCells.ts
git commit -m "feat: persist sourceLocation in Y.Doc and expose on CellData"
```

---

### Task 3: Plaintext + Markdown rebuilders (TDD)

**Files:**
- Create: `src/lib/export/rebuilders/plaintext.ts`
- Create: `src/lib/export/rebuilders/markdown.ts`
- Create: `src/lib/export/rebuilders/rebuilders.test.ts`

- [ ] **Step 1: Write rebuilder tests**

Create `src/lib/export/rebuilders/rebuilders.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { rebuildPlaintext } from "./plaintext"
import { rebuildMarkdown } from "./markdown"
import type { ExportCell } from "@/lib/store/file-doc"

function makeCell(overrides: Partial<ExportCell> & { id: string }): ExportCell {
  return {
    original: "",
    translated: "",
    context: "",
    group: "",
    type: "text",
    ...overrides,
  }
}

describe("rebuildPlaintext", () => {
  it("emits paragraphs separated by double newlines", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "A", translated: "un", context: "Paragraph 1", group: "g1" }),
      makeCell({ id: "c2", original: "B", translated: "deux", context: "Paragraph 2", group: "g2" }),
    ]
    expect(rebuildPlaintext(cells)).toBe("un\n\ndeux")
  })

  it("joins segments in same group with spaces", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "First half.", translated: "Première partie.", context: "Paragraph 1", group: "g1" }),
      makeCell({ id: "c2", original: "Second half.", translated: "Deuxième partie.", context: "Paragraph 1", group: "g1" }),
    ]
    expect(rebuildPlaintext(cells)).toBe("Première partie. Deuxième partie.")
  })

  it("falls back to original when translated is empty", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Hello", translated: "", context: "Paragraph 1", group: "g1" }),
      makeCell({ id: "c2", original: "World", translated: "Monde", context: "Paragraph 2", group: "g2" }),
    ]
    expect(rebuildPlaintext(cells)).toBe("Hello\n\nMonde")
  })

  it("handles empty input", () => {
    expect(rebuildPlaintext([])).toBe("")
  })
})

describe("rebuildMarkdown", () => {
  it("emits headings with correct level", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Title", translated: "Titre", context: "Heading 1", group: "g1", type: "heading" }),
      makeCell({ id: "c2", original: "Sub", translated: "Sous", context: "Heading 2", group: "g2", type: "heading" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("# Titre\n\n## Sous")
  })

  it("emits list items with dashes", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "First", context: "List item", group: "g1", type: "list" }),
      makeCell({ id: "c2", translated: "Second", context: "List item", group: "g2", type: "list" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("- First\n- Second")
  })

  it("emits blockquotes with > prefix", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "A quote", context: "Blockquote", group: "g1", type: "blockquote" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("> A quote")
  })

  it("emits paragraphs plainly", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Normal text", context: "Paragraph", group: "g1", type: "text" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("Normal text")
  })

  it("joins segments of same group with spaces within a block", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Part one.", context: "Paragraph", group: "g1", type: "text" }),
      makeCell({ id: "c2", translated: "Part two.", context: "Paragraph", group: "g1", type: "text" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("Part one. Part two.")
  })

  it("falls back to original when translated is empty", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Fallback", translated: "", context: "Paragraph", group: "g1", type: "text" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("Fallback")
  })

  it("mixes heading levels correctly", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "H1", context: "Heading 1", group: "g1", type: "heading" }),
      makeCell({ id: "c2", translated: "Para", context: "Paragraph", group: "g2", type: "text" }),
      makeCell({ id: "c3", translated: "H3", context: "Heading 3", group: "g3", type: "heading" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("# H1\n\nPara\n\n### H3")
  })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
npx vitest run src/lib/export/rebuilders/rebuilders.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement plaintext rebuilder**

Create `src/lib/export/rebuilders/plaintext.ts`:

```typescript
import type { ExportCell } from "@/lib/store/file-doc"

export function rebuildPlaintext(cells: ExportCell[]): string {
  // Group cells by their group ID; each group is one paragraph (potentially split)
  const groups: { groupId: string; cells: ExportCell[] }[] = []
  const groupIndex = new Map<string, number>()

  for (const cell of cells) {
    const idx = groupIndex.get(cell.group)
    if (idx === undefined) {
      groupIndex.set(cell.group, groups.length)
      groups.push({ groupId: cell.group, cells: [cell] })
    } else {
      groups[idx].cells.push(cell)
    }
  }

  const paragraphs: string[] = []
  for (const { cells } of groups) {
    const parts = cells.map((c) => (c.translated.trim() ? c.translated : c.original))
    paragraphs.push(parts.join(" "))
  }

  return paragraphs.join("\n\n")
}
```

- [ ] **Step 4: Implement markdown rebuilder**

Create `src/lib/export/rebuilders/markdown.ts`:

```typescript
import type { ExportCell } from "@/lib/store/file-doc"

export function rebuildMarkdown(cells: ExportCell[]): string {
  // Group cells by group ID; each group is one block
  const groups: { groupId: string; cells: ExportCell[] }[] = []
  const groupIndex = new Map<string, number>()

  for (const cell of cells) {
    const idx = groupIndex.get(cell.group)
    if (idx === undefined) {
      groupIndex.set(cell.group, groups.length)
      groups.push({ groupId: cell.group, cells: [cell] })
    } else {
      groups[idx].cells.push(cell)
    }
  }

  const blocks: string[] = []
  for (const { cells: groupCells } of groups) {
    const first = groupCells[0]
    const text = groupCells
      .map((c) => (c.translated.trim() ? c.translated : c.original))
      .join(" ")

    switch (first.type) {
      case "heading": {
        // Extract level from context like "Heading 3"
        const match = first.context.match(/Heading\s+(\d+)/)
        const level = match ? parseInt(match[1]) : 1
        const hashes = "#".repeat(Math.max(1, Math.min(6, level)))
        blocks.push(`${hashes} ${text}`)
        break
      }
      case "list":
        blocks.push(`- ${text}`)
        break
      case "blockquote":
        blocks.push(`> ${text}`)
        break
      default:
        blocks.push(text)
    }
  }

  return blocks.join("\n\n")
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/lib/export/rebuilders/rebuilders.test.ts
```

Expected: all rebuilder tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/export/rebuilders/plaintext.ts src/lib/export/rebuilders/markdown.ts src/lib/export/rebuilders/rebuilders.test.ts
git commit -m "feat: add plaintext and markdown rebuilders with TDD"
```

---

### Task 4: Subtitle + USFM rebuilders (TDD)

**Files:**
- Create: `src/lib/export/rebuilders/subtitle.ts`
- Create: `src/lib/export/rebuilders/usfm.ts`
- Modify: `src/lib/export/rebuilders/rebuilders.test.ts`

- [ ] **Step 1: Add subtitle tests**

Append to `src/lib/export/rebuilders/rebuilders.test.ts`:

```typescript
import { rebuildVtt, rebuildSrt } from "./subtitle"

describe("rebuildVtt", () => {
  it("emits WEBVTT header and cues", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Bonjour", context: "00:00:01.000 --> 00:00:04.000", group: "g1", type: "cue" }),
      makeCell({ id: "c2", translated: "Au revoir", context: "00:00:05.000 --> 00:00:08.000", group: "g2", type: "cue" }),
    ]
    expect(rebuildVtt(cells)).toBe(
      "WEBVTT\n\n" +
      "00:00:01.000 --> 00:00:04.000\nBonjour\n\n" +
      "00:00:05.000 --> 00:00:08.000\nAu revoir"
    )
  })

  it("falls back to original for empty translations", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Hello", translated: "", context: "00:00:01.000 --> 00:00:04.000", group: "g1", type: "cue" }),
    ]
    expect(rebuildVtt(cells)).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello")
  })

  it("handles empty input", () => {
    expect(rebuildVtt([])).toBe("WEBVTT")
  })
})

describe("rebuildSrt", () => {
  it("emits numbered cues with timestamps", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Bonjour", context: "00:00:01,000 --> 00:00:04,000", group: "g1", type: "cue" }),
      makeCell({ id: "c2", translated: "Au revoir", context: "00:00:05,000 --> 00:00:08,000", group: "g2", type: "cue" }),
    ]
    expect(rebuildSrt(cells)).toBe(
      "1\n00:00:01,000 --> 00:00:04,000\nBonjour\n\n" +
      "2\n00:00:05,000 --> 00:00:08,000\nAu revoir"
    )
  })

  it("handles empty input", () => {
    expect(rebuildSrt([])).toBe("")
  })
})
```

- [ ] **Step 2: Implement subtitle rebuilder**

Create `src/lib/export/rebuilders/subtitle.ts`:

```typescript
import type { ExportCell } from "@/lib/store/file-doc"

function cueText(cell: ExportCell): string {
  return cell.translated.trim() ? cell.translated : cell.original
}

export function rebuildVtt(cells: ExportCell[]): string {
  if (cells.length === 0) return "WEBVTT"
  const blocks: string[] = ["WEBVTT"]
  for (const cell of cells) {
    blocks.push(`${cell.context}\n${cueText(cell)}`)
  }
  return blocks.join("\n\n")
}

export function rebuildSrt(cells: ExportCell[]): string {
  if (cells.length === 0) return ""
  const blocks: string[] = []
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    blocks.push(`${i + 1}\n${cell.context}\n${cueText(cell)}`)
  }
  return blocks.join("\n\n")
}
```

- [ ] **Step 3: Run subtitle tests**

```bash
npx vitest run src/lib/export/rebuilders/rebuilders.test.ts
```

Expected: new subtitle tests PASS, existing tests still PASS.

- [ ] **Step 4: Add USFM tests**

Append to `src/lib/export/rebuilders/rebuilders.test.ts`:

```typescript
import { rebuildUsfm } from "./usfm"

describe("rebuildUsfm", () => {
  it("emits \\id, \\c, \\v markers from context", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Au commencement.", context: "GEN 1:1", group: "g1", type: "verse" }),
      makeCell({ id: "c2", translated: "La terre était.", context: "GEN 1:2", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\v 1 Au commencement.\n\\v 2 La terre était."
    )
  })

  it("emits \\s for section headings", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "La Création", context: "GEN 1", group: "g1", type: "heading" }),
      makeCell({ id: "c2", translated: "Au commencement.", context: "GEN 1:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\s La Création\n\\v 1 Au commencement."
    )
  })

  it("emits \\mt for paratext", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Genèse", context: "GEN", group: "g1", type: "paratext" }),
      makeCell({ id: "c2", translated: "Verse", context: "GEN 1:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\mt Genèse\n\\c 1\n\\v 1 Verse"
    )
  })

  it("handles chapter transitions", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "V1 of ch1", context: "GEN 1:1", group: "g1", type: "verse" }),
      makeCell({ id: "c2", translated: "V1 of ch2", context: "GEN 2:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\v 1 V1 of ch1\n\\c 2\n\\v 1 V1 of ch2"
    )
  })

  it("handles multiple books", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Gen verse", context: "GEN 1:1", group: "g1", type: "verse" }),
      makeCell({ id: "c2", translated: "Exo verse", context: "EXO 1:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\v 1 Gen verse\n\n\\id EXO\n\\c 1\n\\v 1 Exo verse"
    )
  })

  it("handles empty input", () => {
    expect(rebuildUsfm([])).toBe("")
  })
})
```

- [ ] **Step 5: Implement USFM rebuilder**

Create `src/lib/export/rebuilders/usfm.ts`:

```typescript
import type { ExportCell } from "@/lib/store/file-doc"

function cellText(cell: ExportCell): string {
  return cell.translated.trim() ? cell.translated : cell.original
}

// Parse context like "GEN 1:1" into { book, chapter, verse }
// Or "GEN 1" (section heading in chapter) → { book: "GEN", chapter: 1 }
// Or "GEN" (book-level paratext) → { book: "GEN" }
function parseContext(context: string): { book?: string; chapter?: number; verse?: number } {
  const verseMatch = context.match(/^(\S+)\s+(\d+):(\d+)$/)
  if (verseMatch) return { book: verseMatch[1], chapter: parseInt(verseMatch[2]), verse: parseInt(verseMatch[3]) }
  const chapterMatch = context.match(/^(\S+)\s+(\d+)$/)
  if (chapterMatch) return { book: chapterMatch[1], chapter: parseInt(chapterMatch[2]) }
  const bookMatch = context.match(/^(\S+)$/)
  if (bookMatch) return { book: bookMatch[1] }
  return {}
}

export function rebuildUsfm(cells: ExportCell[]): string {
  if (cells.length === 0) return ""

  // Group cells by book. Preserves first-seen order.
  const books: { book: string; cells: ExportCell[] }[] = []
  const bookIndex = new Map<string, number>()

  for (const cell of cells) {
    const { book } = parseContext(cell.context)
    const key = book || "unknown"
    const idx = bookIndex.get(key)
    if (idx === undefined) {
      bookIndex.set(key, books.length)
      books.push({ book: key, cells: [cell] })
    } else {
      books[idx].cells.push(cell)
    }
  }

  const output: string[] = []

  for (const { book, cells: bookCells } of books) {
    const lines: string[] = [`\\id ${book}`]
    let currentChapter = 0

    for (const cell of bookCells) {
      const parsed = parseContext(cell.context)
      const text = cellText(cell)

      switch (cell.type) {
        case "paratext":
          lines.push(`\\mt ${text}`)
          break
        case "heading": {
          // Emit chapter marker if needed
          if (parsed.chapter !== undefined && parsed.chapter !== currentChapter) {
            lines.push(`\\c ${parsed.chapter}`)
            currentChapter = parsed.chapter
          }
          lines.push(`\\s ${text}`)
          break
        }
        case "verse": {
          if (parsed.chapter !== undefined && parsed.chapter !== currentChapter) {
            lines.push(`\\c ${parsed.chapter}`)
            currentChapter = parsed.chapter
          }
          if (parsed.verse !== undefined) {
            lines.push(`\\v ${parsed.verse} ${text}`)
          } else {
            lines.push(text)
          }
          break
        }
        default:
          lines.push(text)
      }
    }
    output.push(lines.join("\n"))
  }

  return output.join("\n\n")
}
```

- [ ] **Step 6: Run all rebuilder tests**

```bash
npx vitest run src/lib/export/rebuilders/rebuilders.test.ts
```

Expected: all rebuilder tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/export/rebuilders/subtitle.ts src/lib/export/rebuilders/usfm.ts src/lib/export/rebuilders/rebuilders.test.ts
git commit -m "feat: add subtitle and USFM rebuilders with TDD"
```

---

### Task 5: Surgical export (DOCX + PPTX, TDD)

**Files:**
- Create: `src/lib/export/surgical-export.ts`
- Create: `src/lib/export/surgical-export.test.ts`

- [ ] **Step 1: Write surgical export tests**

Create `src/lib/export/surgical-export.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { surgicalExport } from "./surgical-export"
import type { ExportCell } from "@/lib/store/file-doc"

async function makeDocx(bodyXml: string): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`
  const zip = new JSZip()
  zip.file("word/document.xml", xml)
  return zip.generateAsync({ type: "arraybuffer" })
}

async function readDocxXml(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return zip.file("word/document.xml")!.async("string")
}

async function makePptx(slides: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(slides)) {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${content}</p:spTree></p:cSld>
</p:sld>`
    zip.file(`ppt/slides/${name}`, xml)
  }
  return zip.generateAsync({ type: "arraybuffer" })
}

async function readPptxXml(buffer: ArrayBuffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return zip.file(`ppt/slides/${name}`)!.async("string")
}

function cell(overrides: Partial<ExportCell> & { id: string }): ExportCell {
  return {
    original: "", translated: "", context: "", group: "", type: "text",
    ...overrides,
  }
}

describe("surgicalExport DOCX", () => {
  it("replaces text in a single paragraph", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "Bonjour", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Bonjour")
    expect(xml).not.toContain("Hello")
  })

  it("replaces text in multiple paragraphs", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>First</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    `)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "First", translated: "Premier", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
      cell({ id: "c2", original: "Second", translated: "Deuxième", group: "g2",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[2]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Premier")
    expect(xml).toContain("Deuxième")
    expect(xml).not.toContain("First")
    expect(xml).not.toContain("Second")
  })

  it("reassembles split segments from same group", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Long paragraph with two parts</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Long paragraph", translated: "Long paragraphe", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
      cell({ id: "c2", original: "with two parts", translated: "avec deux parties", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Long paragraphe avec deux parties")
  })

  it("preserves paragraph style (pPr)", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r>
      </w:p>
    `)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Title", translated: "Titre", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Titre")
    expect(xml).toContain("Heading1") // pPr preserved
    expect(xml).not.toContain("<w:b/>") // inline formatting dropped (acceptable)
  })

  it("falls back to original when translated is empty", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Hello")
  })

  it("skips cells without sourceLocation", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "Bonjour", group: "g1" }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Hello") // unchanged
    expect(xml).not.toContain("Bonjour")
  })
})

describe("surgicalExport PPTX", () => {
  it("replaces text in a slide paragraph", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Hello</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "Bonjour", group: "g1",
             sourceLocation: { file: "ppt/slides/slide1.xml", blockPath: "p:sp[1]/p:txBody/a:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "pptx")
    const xml = await readPptxXml(resultBuffer, "slide1.xml")
    expect(xml).toContain("Bonjour")
    expect(xml).not.toContain("Hello")
  })

  it("replaces text across multiple slides", async () => {
    const buffer = await makePptx({
      "slide1.xml": `<p:sp><p:txBody><a:p><a:r><a:t>Slide1</a:t></a:r></a:p></p:txBody></p:sp>`,
      "slide2.xml": `<p:sp><p:txBody><a:p><a:r><a:t>Slide2</a:t></a:r></a:p></p:txBody></p:sp>`,
    })
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Slide1", translated: "Diapo1", group: "g1",
             sourceLocation: { file: "ppt/slides/slide1.xml", blockPath: "p:sp[1]/p:txBody/a:p[1]" } }),
      cell({ id: "c2", original: "Slide2", translated: "Diapo2", group: "g2",
             sourceLocation: { file: "ppt/slides/slide2.xml", blockPath: "p:sp[1]/p:txBody/a:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "pptx")
    expect(await readPptxXml(resultBuffer, "slide1.xml")).toContain("Diapo1")
    expect(await readPptxXml(resultBuffer, "slide2.xml")).toContain("Diapo2")
  })
})
```

- [ ] **Step 2: Run tests to verify fail**

```bash
npx vitest run src/lib/export/surgical-export.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement surgical export**

Create `src/lib/export/surgical-export.ts`:

```typescript
import JSZip from "jszip"
import type { ExportCell } from "@/lib/store/file-doc"

export async function surgicalExport(
  originalBuffer: ArrayBuffer,
  cells: ExportCell[],
  fileType: "docx" | "pptx"
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(originalBuffer)

  // Filter cells with sourceLocation; group by file, then by block
  const byFile = new Map<string, Map<string, ExportCell[]>>()

  for (const cell of cells) {
    if (!cell.sourceLocation) continue
    const { file, blockPath } = cell.sourceLocation
    let byBlock = byFile.get(file)
    if (!byBlock) {
      byBlock = new Map<string, ExportCell[]>()
      byFile.set(file, byBlock)
    }
    const existing = byBlock.get(blockPath) || []
    existing.push(cell)
    byBlock.set(blockPath, existing)
  }

  for (const [filePath, blockMap] of byFile) {
    const file = zip.file(filePath)
    if (!file) continue

    const xmlStr = await file.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")

    // Process blocks in reverse document order to avoid path invalidation
    // (Even though we use DOM mutation which doesn't invalidate, we keep this for predictability.)
    const blockPaths = Array.from(blockMap.keys()).sort((a, b) => b.localeCompare(a))

    for (const blockPath of blockPaths) {
      const blockCells = blockMap.get(blockPath)!
      const blockElement = findBlock(doc, blockPath)
      if (!blockElement) continue

      // Reassemble translated text from segments (cells share group)
      const text = blockCells
        .map((c) => (c.translated.trim() ? c.translated : c.original))
        .join(" ")

      replaceBlockText(blockElement, text, fileType)
    }

    const serialized = new XMLSerializer().serializeToString(doc)
    zip.file(filePath, serialized)
  }

  return zip.generateAsync({ type: "arraybuffer" })
}

// Find a block element given a blockPath like "w:p[2]" or "p:sp[1]/p:txBody/a:p[3]".
function findBlock(doc: Document, blockPath: string): Element | null {
  const segments = blockPath.split("/")
  // Find body context for DOCX or slide root for PPTX
  // For DOCX: w:p[N] — look inside w:body
  // For PPTX: p:sp[S]/p:txBody/a:p[P] — walk from the document root

  // Start from the most likely container: find the root then walk
  const roots = doc.getElementsByTagName("w:body")
  const pptxRoots = doc.getElementsByTagName("p:spTree")
  let current: Element | Document = doc
  if (roots.length > 0) current = roots[0]
  else if (pptxRoots.length > 0) current = pptxRoots[0]

  for (const segment of segments) {
    const match = segment.match(/^([^[]+)\[(\d+)\]$/)
    if (!match) return null
    const tag = match[1]
    const index = parseInt(match[2]) // 1-based

    // Get direct children with this tag name
    const children = getChildrenByTagName(current as Element, tag)
    if (index < 1 || index > children.length) return null
    current = children[index - 1]
  }

  return current as Element
}

function getChildrenByTagName(parent: Element, tagName: string): Element[] {
  const result: Element[] = []
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes[i]
    if (node.nodeType === 1 /* ELEMENT_NODE */ && (node as Element).nodeName === tagName) {
      result.push(node as Element)
    }
  }
  return result
}

function replaceBlockText(block: Element, newText: string, fileType: "docx" | "pptx"): void {
  const doc = block.ownerDocument!
  const runTag = fileType === "docx" ? "w:r" : "a:r"
  const textTag = fileType === "docx" ? "w:t" : "a:t"

  // Collect all existing runs (direct + nested) and remove them
  const runs = Array.from(block.getElementsByTagName(runTag))
  for (const run of runs) {
    run.parentNode?.removeChild(run)
  }

  // Create a new run with a single text element containing the translated text
  const newRun = doc.createElement(runTag)
  const newTextEl = doc.createElement(textTag)
  // Preserve leading/trailing whitespace
  if (fileType === "docx") {
    newTextEl.setAttribute("xml:space", "preserve")
  }
  newTextEl.textContent = newText
  newRun.appendChild(newTextEl)
  block.appendChild(newRun)
}
```

- [ ] **Step 4: Run surgical export tests**

```bash
npx vitest run src/lib/export/surgical-export.test.ts
```

Expected: all 9 surgical export tests PASS.

- [ ] **Step 5: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/export/surgical-export.ts src/lib/export/surgical-export.test.ts
git commit -m "feat: add surgical DOCX/PPTX export with block-level text replacement"
```

---

### Task 6: Export service + Toolbar integration

**Files:**
- Create: `src/lib/export/export-service.ts`
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Create export service**

Create `src/lib/export/export-service.ts`:

```typescript
import { collectExportCells, type ExportData } from "@/lib/store/file-doc"
import { getOriginalFile } from "@/lib/store/project-index"
import { surgicalExport } from "./surgical-export"
import { rebuildPlaintext } from "./rebuilders/plaintext"
import { rebuildMarkdown } from "./rebuilders/markdown"
import { rebuildVtt, rebuildSrt } from "./rebuilders/subtitle"
import { rebuildUsfm } from "./rebuilders/usfm"

const MIME_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  vtt: "text/vtt",
  srt: "application/x-subrip",
  usfm: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

export interface ExportResult {
  blob: Blob
  filename: string
}

export async function exportFile(fileId: string): Promise<ExportResult> {
  const data = await collectExportCells(fileId)
  const { fileName, fileType, cells } = data

  const extension = fileType
  const baseName = stripExtension(fileName)
  const filename = `${baseName}.translated.${extension}`

  if (fileType === "docx" || fileType === "pptx") {
    const original = await getOriginalFile(fileId)
    const hasLocations = cells.some((c) => c.sourceLocation)
    if (original && hasLocations) {
      const buffer = await surgicalExport(original, cells, fileType)
      return {
        blob: new Blob([buffer], { type: MIME_TYPES[fileType] }),
        filename,
      }
    }
    // No original or no location data → fall back to plaintext
    const text = rebuildPlaintext(cells)
    return {
      blob: new Blob([text], { type: "text/plain" }),
      filename: `${baseName}.translated.txt`,
    }
  }

  let content: string
  switch (fileType) {
    case "txt":
      content = rebuildPlaintext(cells)
      break
    case "md":
      content = rebuildMarkdown(cells)
      break
    case "vtt":
      content = rebuildVtt(cells)
      break
    case "srt":
      content = rebuildSrt(cells)
      break
    case "usfm":
      content = rebuildUsfm(cells)
      break
    default:
      content = rebuildPlaintext(cells)
  }

  return {
    blob: new Blob([content], { type: MIME_TYPES[fileType] || "text/plain" }),
    filename,
  }
}

function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".")
  if (lastDot <= 0) return filename
  return filename.slice(0, lastDot)
}

// Trigger a browser download of a blob with the given filename.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export type { ExportData }
```

- [ ] **Step 2: Add Download button to Toolbar**

Read `src/components/Toolbar.tsx`. Add a `Download` import and button.

Replace the entire file with:

```tsx
import { Settings, Scale, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"

interface ToolbarProps {
  project: ProjectRecord
  onBack: () => void
  onImport: () => void
  onSettings: () => void
  onRules: () => void
  onExport: () => void
  exportEnabled: boolean
}

export function Toolbar({ project, onBack, onImport, onSettings, onRules, onExport, exportEnabled }: ToolbarProps) {
  return (
    <header className="flex items-center gap-4 border-b px-4 py-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← Back
      </Button>
      <h2 className="font-semibold">{project.name}</h2>
      <span className="text-sm text-muted-foreground">
        {project.sourceLanguage} → {project.targetLanguage}
      </span>
      <div className="flex-1" />
      <Button size="sm" onClick={onImport}>
        + Import
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onExport}
        disabled={!exportEnabled}
        title={exportEnabled ? "Export translated file" : "Select a file to export"}
      >
        <Download className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onRules} title="Translation rules">
        <Scale className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onSettings}>
        <Settings className="h-4 w-4" />
      </Button>
    </header>
  )
}
```

- [ ] **Step 3: Wire export in ProjectWorkspace**

Read `src/components/ProjectWorkspace.tsx`. Add import and handler.

At the top, add:

```typescript
import { exportFile, downloadBlob } from "@/lib/export/export-service"
```

Inside the ProjectWorkspace component, before the return statement, add an export handler:

```typescript
  async function handleExport() {
    if (!activeFileId) return
    try {
      const { blob, filename } = await exportFile(activeFileId)
      downloadBlob(blob, filename)
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }
```

Update the Toolbar usage in the return block to pass `onExport` and `exportEnabled`:

```tsx
      <Toolbar
        project={project}
        onBack={() => navigate("/")}
        onImport={() => setImportOpen(true)}
        onSettings={() => navigate(`/project/${projectId}/settings`)}
        onRules={() => navigate(`/project/${projectId}/rules`)}
        onExport={handleExport}
        exportEnabled={Boolean(activeFileId)}
      />
```

- [ ] **Step 4: Run all tests + build**

```bash
npx vitest run && npm run build
```

Expected: all tests pass, clean build.

- [ ] **Step 5: Manual smoke test**

```bash
npm run dev
```

Open `http://localhost:5173`:

1. Create a project, import a TXT file with a few paragraphs.
2. Translate one or two cells manually.
3. Click the Download icon in the toolbar.
4. Browser downloads `<name>.translated.txt`.
5. Open the downloaded file — translated cells should be in place, untranslated ones fallback to original.
6. Repeat with an MD file, verify headings/lists look correct.
7. Repeat with a DOCX file — downloaded file should open in Word with translated text in place of the source.

- [ ] **Step 6: Commit**

```bash
git add src/lib/export/export-service.ts src/components/Toolbar.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat: wire export service into toolbar with download button"
```

---

## Summary

| Task | What it builds | Test type |
|------|---------------|-----------|
| 1 | SourceLocation type + DOCX/PPTX parsers capture block paths | Unit (+2 tests) |
| 2 | Persist sourceLocation in Yjs, expose on CellData, add collectExportCells | Regression |
| 3 | Plaintext + Markdown rebuilders | Unit (+12 tests) |
| 4 | Subtitle + USFM rebuilders | Unit (+10 tests) |
| 5 | Surgical DOCX/PPTX export | Unit (+9 tests) |
| 6 | Export service + Toolbar integration | Manual E2E |

New automated tests: ~33. Total after: ~138.
