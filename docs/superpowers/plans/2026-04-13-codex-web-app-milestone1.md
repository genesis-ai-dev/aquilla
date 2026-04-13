# Codex Web App — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a client-side translation editor where users create projects, import source files (MD, DOCX, PPTX, TXT, VTT, SRT, USFM), view aligned source/target content in a virtualized table, and edit translations — all persisted locally via Yjs CRDTs in IndexedDB.

**Architecture:** Two-level app state (`activeProjectId: null | string`) switches between Dashboard and ProjectWorkspace. Project metadata lives in a plain IndexedDB store. Each imported file becomes its own `Y.Doc` with cells map + order array, persisted via `y-indexeddb`. Parsers are pure functions that extract `TranslatableString[]` from each format. The editor table is virtualized with `@tanstack/react-virtual` and bound to Yjs for live persistence.

**Tech Stack:** Vite, React 19, TypeScript, Tailwind CSS, ShadCN/UI, Yjs + y-indexeddb, @tanstack/react-virtual, JSZip, DOMPurify, Vitest + happy-dom

---

## File Structure

```
src/
├── main.tsx                          # React root mount
├── App.tsx                           # activeProjectId state machine
├── test-setup.ts                     # fake-indexeddb setup for tests
├── lib/
│   ├── parsers/
│   │   ├── types.ts                  # TranslatableString, FileType, CellType, detectFileType
│   │   ├── text-splitter.ts          # splitIntoSegments, mergeSegments
│   │   ├── plaintext.ts             # extractPlaintextStrings
│   │   ├── markdown.ts              # extractMarkdownStrings
│   │   ├── subtitle.ts             # extractVttStrings, extractSrtStrings
│   │   ├── usfm.ts                  # extractUsfmStrings (returns per-book arrays)
│   │   ├── docx.ts                  # extractDocxStrings (async, uses JSZip)
│   │   └── pptx.ts                  # extractPptxStrings (async, uses JSZip)
│   ├── store/
│   │   ├── project-index.ts         # IndexedDB CRUD for ProjectRecord[] via idb
│   │   └── file-doc.ts              # Y.Doc lifecycle: create, load, destroy
│   ├── import.ts                     # Import orchestrator: file → parse → Y.Doc → project index
│   └── utils.ts                      # cn() helper (created by ShadCN init)
├── components/
│   ├── ui/                           # ShadCN components (auto-generated)
│   ├── Dashboard.tsx                 # Project grid + create dialog trigger
│   ├── ProjectCard.tsx               # Card showing project name, languages, file count
│   ├── ProjectCreateDialog.tsx       # Dialog: name, source lang, target lang
│   ├── ProjectWorkspace.tsx          # Shell: toolbar + sidebar + editor area
│   ├── ProjectSidebar.tsx            # File list, click to switch
│   ├── EditorTable.tsx               # Virtualized source/target rows bound to Yjs
│   ├── ImportDialog.tsx              # Drag-drop + file picker, triggers import
│   ├── Toolbar.tsx                   # Back, project name, languages, import button
│   └── StatusBar.tsx                 # Cell count, translated %, progress
└── hooks/
    ├── useProject.ts                 # Load project record + refresh
    ├── useFileDoc.ts                 # Y.Doc loading + y-indexeddb provider
    └── useCells.ts                   # Subscribe to cells map + order array
```

Test files live alongside source as `*.test.ts`:

```
src/lib/parsers/text-splitter.test.ts
src/lib/parsers/plaintext.test.ts
src/lib/parsers/markdown.test.ts
src/lib/parsers/subtitle.test.ts
src/lib/parsers/usfm.test.ts
src/lib/parsers/docx.test.ts
src/lib/parsers/pptx.test.ts
src/lib/store/project-index.test.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `src/test-setup.ts`

- [ ] **Step 1: Create Vite project**

Run from `/Users/ryderwishart/prototypes/codex-web-app`:

```bash
npm create vite@latest . -- --template react-ts
```

If prompted about existing files, confirm overwrite. This creates the base React + TypeScript project.

Expected: `package.json`, `vite.config.ts`, `tsconfig.json`, `src/` directory created.

- [ ] **Step 2: Install production dependencies**

```bash
npm install yjs y-indexeddb @tanstack/react-virtual jszip uuid dompurify idb
```

- [ ] **Step 3: Install dev dependencies**

```bash
npm install -D vitest happy-dom fake-indexeddb @types/dompurify @types/uuid
```

- [ ] **Step 4: Initialize ShadCN**

```bash
npx shadcn@latest init
```

When prompted, accept defaults (New York style, Zinc base color, CSS variables). This installs Tailwind, configures path aliases, creates `src/lib/utils.ts` and `src/components/ui/`.

- [ ] **Step 5: Add ShadCN components**

```bash
npx shadcn@latest add button card dialog input label scroll-area
```

- [ ] **Step 6: Configure Vitest**

Replace `vite.config.ts` with:

```typescript
/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
  },
})
```

Create `src/test-setup.ts`:

```typescript
import "fake-indexeddb/auto"
```

Add test script to `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 7: Minimal App.tsx**

Replace `src/App.tsx` with:

```tsx
import { useState } from "react"

export default function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  if (activeProjectId) {
    return (
      <div>
        <button onClick={() => setActiveProjectId(null)}>Back</button>
        <p>Project: {activeProjectId}</p>
      </div>
    )
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Codex Translator</h1>
      <p className="text-muted-foreground">No projects yet.</p>
    </div>
  )
}
```

- [ ] **Step 8: Verify dev server starts**

```bash
npm run dev
```

Expected: Vite dev server starts on `http://localhost:5173`, page renders "Codex Translator".

- [ ] **Step 9: Verify tests run**

```bash
npx vitest run
```

Expected: Vitest runs, 0 tests found, exits cleanly.

- [ ] **Step 10: Initialize git and commit**

```bash
git init
```

Create `.gitignore`:

```
node_modules
dist
.env
*.local
```

```bash
git add -A
git commit -m "chore: scaffold Vite + React + TS + Tailwind + ShadCN project"
```

---

### Task 2: Core Types & Text Splitter

**Files:**
- Create: `src/lib/parsers/types.ts`, `src/lib/parsers/text-splitter.ts`, `src/lib/parsers/text-splitter.test.ts`

- [ ] **Step 1: Create core types**

Create `src/lib/parsers/types.ts`:

```typescript
export type FileType = "md" | "docx" | "pptx" | "txt" | "vtt" | "srt" | "usfm"

export type CellType =
  | "text"
  | "heading"
  | "list"
  | "blockquote"
  | "cue"
  | "verse"
  | "paratext"

export interface TranslatableString {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  type: CellType
}

export interface ProjectRecord {
  id: string
  name: string
  sourceLanguage: string
  targetLanguage: string
  createdAt: string
  files: FileReference[]
  members: ProjectMember[]
}

export interface FileReference {
  id: string
  name: string
  type: FileType
  createdAt: string
  cellCount: number
}

export interface ProjectMember {
  userId: string
  role: "owner" | "translator" | "reviewer"
}

export function detectFileType(fileName: string): FileType | null {
  const ext = fileName.split(".").pop()?.toLowerCase()
  const map: Record<string, FileType> = {
    md: "md",
    markdown: "md",
    docx: "docx",
    pptx: "pptx",
    txt: "txt",
    vtt: "vtt",
    srt: "srt",
    usfm: "usfm",
    sfm: "usfm",
  }
  return map[ext || ""] || null
}
```

- [ ] **Step 2: Write failing test for text splitter**

Create `src/lib/parsers/text-splitter.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { splitIntoSegments, mergeSegments } from "./text-splitter"

describe("splitIntoSegments", () => {
  it("returns single segment for short text", () => {
    const result = splitIntoSegments("Hello world")
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("Hello world")
    expect(result[0].group).toBeTruthy()
  })

  it("all segments share the same group ID", () => {
    const longText = "A".repeat(100) + ". " + "B".repeat(100) + ". " + "C".repeat(100)
    const result = splitIntoSegments(longText, 150)
    expect(result.length).toBeGreaterThan(1)
    const groups = new Set(result.map((s) => s.group))
    expect(groups.size).toBe(1)
  })

  it("splits on sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence."
    const result = splitIntoSegments(text, 40)
    expect(result.length).toBeGreaterThan(1)
    expect(result[0].text).toContain("First sentence.")
  })

  it("splits on paragraph boundaries first", () => {
    const text = "Paragraph one is here.\n\nParagraph two is here."
    const result = splitIntoSegments(text, 30)
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe("Paragraph one is here.")
    expect(result[1].text).toBe("Paragraph two is here.")
  })

  it("handles text shorter than maxLength", () => {
    const result = splitIntoSegments("Short", 200)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("Short")
  })
})

describe("mergeSegments", () => {
  it("rejoins segments into original text", () => {
    const segments = [
      { text: "Hello world.", group: "g1" },
      { text: "Goodbye world.", group: "g1" },
    ]
    expect(mergeSegments(segments)).toBe("Hello world. Goodbye world.")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/lib/parsers/text-splitter.test.ts
```

Expected: FAIL — module `./text-splitter` not found.

- [ ] **Step 4: Implement text splitter**

Create `src/lib/parsers/text-splitter.ts`:

```typescript
import { v4 as uuid } from "uuid"

const BREAK_PATTERNS: RegExp[] = [
  /\n\n+/,                  // paragraph
  /\n/,                     // line
  /(?<=[.!?])\s+/,          // sentence
  /(?<=[;:])\s+/,           // clause
  /,\s+/,                   // comma
  /\s*[—–]\s*|\s+-\s+/,    // dash
  /\s+/,                    // word
]

export function splitIntoSegments(
  text: string,
  maxLength = 200
): { text: string; group: string }[] {
  const group = uuid()

  if (text.length <= maxLength) {
    return [{ text, group }]
  }

  return recursiveSplit(text, maxLength, 0).map((t) => ({ text: t, group }))
}

function recursiveSplit(text: string, maxLength: number, level: number): string[] {
  if (text.length <= maxLength || level >= BREAK_PATTERNS.length) {
    return [text]
  }

  const parts = text.split(BREAK_PATTERNS[level]).filter((p) => p.trim().length > 0)

  if (parts.length <= 1) {
    return recursiveSplit(text, maxLength, level + 1)
  }

  const merged: string[] = []
  let current = parts[0]

  for (let i = 1; i < parts.length; i++) {
    const combined = current + " " + parts[i]
    if (combined.length <= maxLength) {
      current = combined
    } else {
      merged.push(current)
      current = parts[i]
    }
  }
  merged.push(current)

  return merged.flatMap((chunk) =>
    chunk.length > maxLength ? recursiveSplit(chunk, maxLength, level + 1) : [chunk]
  )
}

export function mergeSegments(segments: { text: string; group: string }[]): string {
  return segments.map((s) => s.text).join(" ")
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/lib/parsers/text-splitter.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/parsers/text-splitter.ts src/lib/parsers/text-splitter.test.ts
git commit -m "feat: add core types and text splitter with TDD"
```

---

### Task 3: Plain Text Parser

**Files:**
- Create: `src/lib/parsers/plaintext.ts`, `src/lib/parsers/plaintext.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/parsers/plaintext.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { extractPlaintextStrings } from "./plaintext"

describe("extractPlaintextStrings", () => {
  it("splits on double newlines into paragraphs", () => {
    const text = "First paragraph.\n\nSecond paragraph."
    const result = extractPlaintextStrings(text)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("First paragraph.")
    expect(result[0].context).toBe("Paragraph 1")
    expect(result[0].type).toBe("text")
    expect(result[1].original).toBe("Second paragraph.")
    expect(result[1].context).toBe("Paragraph 2")
  })

  it("sets translated equal to original", () => {
    const result = extractPlaintextStrings("Hello")
    expect(result[0].translated).toBe(result[0].original)
  })

  it("assigns unique IDs and group IDs", () => {
    const result = extractPlaintextStrings("A\n\nB")
    expect(result[0].id).toBeTruthy()
    expect(result[1].id).toBeTruthy()
    expect(result[0].id).not.toBe(result[1].id)
  })

  it("segments long paragraphs", () => {
    const longParagraph = Array(20).fill("This is a sentence.").join(" ")
    const result = extractPlaintextStrings(longParagraph)
    expect(result.length).toBeGreaterThan(1)
    const groups = new Set(result.map((r) => r.group))
    expect(groups.size).toBe(1) // all from same paragraph share group
  })

  it("handles empty input", () => {
    expect(extractPlaintextStrings("")).toHaveLength(0)
    expect(extractPlaintextStrings("   ")).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/parsers/plaintext.test.ts
```

Expected: FAIL — module `./plaintext` not found.

- [ ] **Step 3: Implement plain text parser**

Create `src/lib/parsers/plaintext.ts`:

```typescript
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"

export function extractPlaintextStrings(content: string): TranslatableString[] {
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0)
  const results: TranslatableString[] = []

  paragraphs.forEach((para, index) => {
    const trimmed = para.trim()
    const segments = splitIntoSegments(trimmed)

    for (const seg of segments) {
      results.push({
        id: uuid(),
        original: seg.text,
        translated: seg.text,
        context: `Paragraph ${index + 1}`,
        group: seg.group,
        type: "text",
      })
    }
  })

  return results
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/parsers/plaintext.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parsers/plaintext.ts src/lib/parsers/plaintext.test.ts
git commit -m "feat: add plain text parser with TDD"
```

---

### Task 4: Markdown Parser

**Files:**
- Create: `src/lib/parsers/markdown.ts`, `src/lib/parsers/markdown.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/parsers/markdown.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { extractMarkdownStrings } from "./markdown"

describe("extractMarkdownStrings", () => {
  it("parses headings with correct context", () => {
    const md = "# Title\n\n## Subtitle"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Title")
    expect(result[0].context).toBe("Heading 1")
    expect(result[0].type).toBe("heading")
    expect(result[1].original).toBe("Subtitle")
    expect(result[1].context).toBe("Heading 2")
  })

  it("parses paragraphs", () => {
    const md = "First paragraph.\n\nSecond paragraph."
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("First paragraph.")
    expect(result[0].context).toBe("Paragraph")
    expect(result[0].type).toBe("text")
  })

  it("parses list items", () => {
    const md = "- Item one\n- Item two\n* Item three"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(3)
    expect(result[0].original).toBe("Item one")
    expect(result[0].type).toBe("list")
  })

  it("parses numbered list items", () => {
    const md = "1. First\n2. Second"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("First")
    expect(result[0].type).toBe("list")
  })

  it("parses blockquotes", () => {
    const md = "> This is a quote"
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("This is a quote")
    expect(result[0].type).toBe("blockquote")
  })

  it("converts bold to originalHtml", () => {
    const md = "This is **bold** text"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("This is <b>bold</b> text")
  })

  it("converts italic to originalHtml", () => {
    const md = "This is *italic* text"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("This is <i>italic</i> text")
  })

  it("converts strikethrough to originalHtml", () => {
    const md = "This is ~~struck~~ text"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("This is <s>struck</s> text")
  })

  it("converts inline code to originalHtml", () => {
    const md = "Use `console.log` here"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBe("Use <code>console.log</code> here")
  })

  it("does not set originalHtml when no inline formatting", () => {
    const md = "Plain text paragraph"
    const result = extractMarkdownStrings(md)
    expect(result[0].originalHtml).toBeUndefined()
  })

  it("sets translated equal to original (plain text, no markdown)", () => {
    const md = "**Bold** text"
    const result = extractMarkdownStrings(md)
    expect(result[0].translated).toBe("Bold text")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/parsers/markdown.test.ts
```

Expected: FAIL — module `./markdown` not found.

- [ ] **Step 3: Implement markdown parser**

Create `src/lib/parsers/markdown.ts`:

```typescript
import { v4 as uuid } from "uuid"
import type { TranslatableString, CellType } from "./types"
import { splitIntoSegments } from "./text-splitter"

export function extractMarkdownStrings(content: string): TranslatableString[] {
  const lines = content.split("\n")
  const results: TranslatableString[] = []
  let paragraphLines: string[] = []

  function flushParagraph() {
    if (paragraphLines.length === 0) return
    const text = paragraphLines.join(" ")
    paragraphLines = []
    addEntry(text, "Paragraph", "text")
  }

  function addEntry(rawText: string, context: string, type: CellType) {
    const plain = stripMarkdownInline(rawText)
    const html = markdownInlineToHtml(rawText)
    const segments = splitIntoSegments(plain)

    for (const seg of segments) {
      results.push({
        id: uuid(),
        original: seg.text,
        originalHtml: segments.length === 1 && html !== plain ? html : undefined,
        translated: seg.text,
        context,
        group: seg.group,
        type,
      })
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "") {
      flushParagraph()
      continue
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      flushParagraph()
      addEntry(headingMatch[2], `Heading ${headingMatch[1].length}`, "heading")
      continue
    }

    // List item (unordered)
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)/)
    if (ulMatch) {
      flushParagraph()
      addEntry(ulMatch[1], "List item", "list")
      continue
    }

    // List item (ordered)
    const olMatch = trimmed.match(/^\d+\.\s+(.+)/)
    if (olMatch) {
      flushParagraph()
      addEntry(olMatch[1], "List item", "list")
      continue
    }

    // Blockquote
    const quoteMatch = trimmed.match(/^>\s*(.*)/)
    if (quoteMatch) {
      flushParagraph()
      addEntry(quoteMatch[1], "Blockquote", "blockquote")
      continue
    }

    paragraphLines.push(trimmed)
  }

  flushParagraph()
  return results
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
}

function markdownInlineToHtml(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/parsers/markdown.test.ts
```

Expected: All 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parsers/markdown.ts src/lib/parsers/markdown.test.ts
git commit -m "feat: add markdown parser with inline formatting support"
```

---

### Task 5: Subtitle Parsers — VTT & SRT

**Files:**
- Create: `src/lib/parsers/subtitle.ts`, `src/lib/parsers/subtitle.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/parsers/subtitle.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { extractVttStrings, extractSrtStrings } from "./subtitle"

describe("extractVttStrings", () => {
  it("parses VTT cues", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
This is a test`

    const result = extractVttStrings(vtt)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].context).toBe("00:00:01.000 --> 00:00:04.000")
    expect(result[0].type).toBe("cue")
    expect(result[1].original).toBe("This is a test")
    expect(result[1].context).toBe("00:00:05.000 --> 00:00:08.000")
  })

  it("handles multi-line cue text", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Line one
Line two`

    const result = extractVttStrings(vtt)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Line one\nLine two")
  })

  it("handles empty input", () => {
    expect(extractVttStrings("WEBVTT")).toHaveLength(0)
  })

  it("sets translated equal to original", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello`

    const result = extractVttStrings(vtt)
    expect(result[0].translated).toBe("Hello")
  })
})

describe("extractSrtStrings", () => {
  it("parses SRT cues", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,000
This is a test`

    const result = extractSrtStrings(srt)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].context).toBe("00:00:01,000 --> 00:00:04,000")
    expect(result[0].type).toBe("cue")
    expect(result[1].original).toBe("This is a test")
  })

  it("handles multi-line cue text", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two`

    const result = extractSrtStrings(srt)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Line one\nLine two")
  })

  it("handles empty input", () => {
    expect(extractSrtStrings("")).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/parsers/subtitle.test.ts
```

Expected: FAIL — module `./subtitle` not found.

- [ ] **Step 3: Implement subtitle parsers**

Create `src/lib/parsers/subtitle.ts`:

```typescript
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"

const TIMESTAMP_VTT = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/
const TIMESTAMP_SRT = /^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/

export function extractVttStrings(content: string): TranslatableString[] {
  const lines = content.split("\n")
  const results: TranslatableString[] = []
  let currentTimestamp = ""
  let currentText: string[] = []

  function flush() {
    if (currentTimestamp && currentText.length > 0) {
      const text = currentText.join("\n")
      results.push({
        id: uuid(),
        original: text,
        translated: text,
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
      })
    }
    currentTimestamp = ""
    currentText = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (TIMESTAMP_VTT.test(trimmed)) {
      flush()
      currentTimestamp = trimmed
      continue
    }

    if (trimmed === "" || trimmed === "WEBVTT" || trimmed.startsWith("NOTE")) {
      if (currentTimestamp) flush()
      continue
    }

    if (currentTimestamp) {
      currentText.push(trimmed)
    }
  }

  flush()
  return results
}

export function extractSrtStrings(content: string): TranslatableString[] {
  const lines = content.split("\n")
  const results: TranslatableString[] = []
  let currentTimestamp = ""
  let currentText: string[] = []

  function flush() {
    if (currentTimestamp && currentText.length > 0) {
      const text = currentText.join("\n")
      results.push({
        id: uuid(),
        original: text,
        translated: text,
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
      })
    }
    currentTimestamp = ""
    currentText = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (TIMESTAMP_SRT.test(trimmed)) {
      flush()
      currentTimestamp = trimmed
      continue
    }

    if (trimmed === "" && currentTimestamp) {
      flush()
      continue
    }

    // Skip cue index numbers
    if (/^\d+$/.test(trimmed) && !currentTimestamp) {
      continue
    }

    if (currentTimestamp) {
      currentText.push(trimmed)
    }
  }

  flush()
  return results
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/parsers/subtitle.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parsers/subtitle.ts src/lib/parsers/subtitle.test.ts
git commit -m "feat: add VTT and SRT subtitle parsers"
```

---

### Task 6: USFM Parser

**Files:**
- Create: `src/lib/parsers/usfm.ts`, `src/lib/parsers/usfm.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/parsers/usfm.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { extractUsfmStrings } from "./usfm"

describe("extractUsfmStrings", () => {
  it("parses verses with book/chapter/verse context", () => {
    const usfm = `\\id GEN
\\c 1
\\p
\\v 1 In the beginning God created the heavens and the earth.
\\v 2 The earth was without form and void.`

    const result = extractUsfmStrings(usfm)
    expect(result).toHaveLength(1)
    expect(result[0].bookId).toBe("GEN")
    expect(result[0].strings).toHaveLength(2)
    expect(result[0].strings[0].original).toBe(
      "In the beginning God created the heavens and the earth."
    )
    expect(result[0].strings[0].context).toBe("GEN 1:1")
    expect(result[0].strings[0].type).toBe("verse")
    expect(result[0].strings[1].context).toBe("GEN 1:2")
  })

  it("splits multiple books by \\id marker", () => {
    const usfm = `\\id GEN
\\c 1
\\v 1 First verse of Genesis.

\\id EXO
\\c 1
\\v 1 First verse of Exodus.`

    const result = extractUsfmStrings(usfm)
    expect(result).toHaveLength(2)
    expect(result[0].bookId).toBe("GEN")
    expect(result[1].bookId).toBe("EXO")
  })

  it("parses section headings", () => {
    const usfm = `\\id GEN
\\c 1
\\s The Creation
\\v 1 In the beginning.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    expect(strings[0].original).toBe("The Creation")
    expect(strings[0].type).toBe("heading")
    expect(strings[1].type).toBe("verse")
  })

  it("parses paratext markers", () => {
    const usfm = `\\id GEN
\\mt Genesis
\\c 1
\\v 1 In the beginning.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    expect(strings[0].original).toBe("Genesis")
    expect(strings[0].type).toBe("paratext")
  })

  it("treats file without \\id as single document", () => {
    const usfm = `\\c 1
\\v 1 A verse without book ID.`

    const result = extractUsfmStrings(usfm)
    expect(result).toHaveLength(1)
    expect(result[0].bookId).toBe("unknown")
  })

  it("handles chapter transitions", () => {
    const usfm = `\\id GEN
\\c 1
\\v 1 Chapter one verse one.
\\c 2
\\v 1 Chapter two verse one.`

    const result = extractUsfmStrings(usfm)
    const strings = result[0].strings
    expect(strings[0].context).toBe("GEN 1:1")
    expect(strings[1].context).toBe("GEN 2:1")
  })

  it("sets translated equal to original", () => {
    const usfm = `\\id GEN
\\c 1
\\v 1 Test verse.`

    const result = extractUsfmStrings(usfm)
    expect(result[0].strings[0].translated).toBe("Test verse.")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/parsers/usfm.test.ts
```

Expected: FAIL — module `./usfm` not found.

- [ ] **Step 3: Implement USFM parser**

Create `src/lib/parsers/usfm.ts`:

```typescript
import { v4 as uuid } from "uuid"
import type { TranslatableString, CellType } from "./types"
import { splitIntoSegments } from "./text-splitter"

export interface UsfmBookResult {
  bookId: string
  strings: TranslatableString[]
}

export function extractUsfmStrings(content: string): UsfmBookResult[] {
  const hasId = /\\id\s/.test(content)

  if (!hasId) {
    return [parseBookSection(content, "unknown")]
  }

  const sections = content.split(/(?=\\id\s)/).filter((s) => s.trim().length > 0)
  return sections.map((section) => {
    const idMatch = section.match(/\\id\s+(\S+)/)
    const bookId = idMatch ? idMatch[1] : "unknown"
    return parseBookSection(section, bookId)
  })
}

function parseBookSection(section: string, bookId: string): UsfmBookResult {
  const lines = section.split("\n")
  const strings: TranslatableString[] = []
  let chapter = 0
  let verse = 0

  function addString(text: string, context: string, type: CellType) {
    const segments = splitIntoSegments(text)
    for (const seg of segments) {
      strings.push({
        id: uuid(),
        original: seg.text,
        translated: seg.text,
        context,
        group: seg.group,
        type,
      })
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // \id — skip, already parsed
    if (trimmed.startsWith("\\id ")) continue

    // \c — chapter
    const chapterMatch = trimmed.match(/^\\c\s+(\d+)/)
    if (chapterMatch) {
      chapter = parseInt(chapterMatch[1])
      verse = 0
      continue
    }

    // \v — verse
    const verseMatch = trimmed.match(/^\\v\s+(\d+)\s+(.*)/)
    if (verseMatch) {
      verse = parseInt(verseMatch[1])
      addString(verseMatch[2], `${bookId} ${chapter}:${verse}`, "verse")
      continue
    }

    // \s — section heading
    const sectionMatch = trimmed.match(/^\\s\d?\s+(.*)/)
    if (sectionMatch) {
      addString(sectionMatch[1], `${bookId} ${chapter}`, "heading")
      continue
    }

    // \p — paragraph marker, skip
    if (/^\\p\s*$/.test(trimmed)) continue

    // Paratext markers: \mt, \ms, \r
    const paratextMatch = trimmed.match(/^\\(mt|ms|r)\d?\s+(.*)/)
    if (paratextMatch) {
      addString(paratextMatch[2], bookId, "paratext")
      continue
    }

    // Continuation text (no marker) — append to last entry
    if (!trimmed.startsWith("\\") && strings.length > 0) {
      const last = strings[strings.length - 1]
      last.original += " " + trimmed
      last.translated = last.original
    }
  }

  return { bookId, strings }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/parsers/usfm.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parsers/usfm.ts src/lib/parsers/usfm.test.ts
git commit -m "feat: add USFM parser with book splitting"
```

---

### Task 7: DOCX Parser

**Files:**
- Create: `src/lib/parsers/docx.ts`, `src/lib/parsers/docx.test.ts`

- [ ] **Step 1: Write failing test**

The test creates minimal DOCX zip files programmatically using JSZip for isolated testing.

Create `src/lib/parsers/docx.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { extractDocxStrings } from "./docx"

function makeDocx(bodyXml: string): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`

  const zip = new JSZip()
  zip.file("word/document.xml", xml)
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("extractDocxStrings", () => {
  it("extracts plain paragraph text", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r><w:t>Hello world</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].context).toBe("Paragraph")
    expect(result[0].type).toBe("text")
  })

  it("detects heading styles", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:t>Chapter Title</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].context).toBe("Heading 1")
    expect(result[0].type).toBe("heading")
  })

  it("extracts bold formatting as originalHtml", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r><w:t>Normal </w:t></w:r>
        <w:r>
          <w:rPr><w:b/></w:rPr>
          <w:t>bold</w:t>
        </w:r>
        <w:r><w:t> text</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].original).toBe("Normal bold text")
    expect(result[0].originalHtml).toBe("Normal <b>bold</b> text")
  })

  it("extracts italic formatting", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r>
          <w:rPr><w:i/></w:rPr>
          <w:t>italic</w:t>
        </w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].originalHtml).toBe("<i>italic</i>")
  })

  it("concatenates multiple runs", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r><w:t>First </w:t></w:r>
        <w:r><w:t>second</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].original).toBe("First second")
  })

  it("skips empty paragraphs", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>Text</w:t></w:r></w:p>
      <w:p></w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result).toHaveLength(1)
  })

  it("sets translated equal to original", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].translated).toBe("Hello")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/parsers/docx.test.ts
```

Expected: FAIL — module `./docx` not found.

- [ ] **Step 3: Implement DOCX parser**

Create `src/lib/parsers/docx.ts`:

```typescript
import JSZip from "jszip"
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"

export async function extractDocxStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  const zip = await JSZip.loadAsync(buffer)
  const xmlStr = await zip.file("word/document.xml")!.async("string")
  const doc = new DOMParser().parseFromString(xmlStr, "application/xml")
  const results: TranslatableString[] = []
  const paragraphs = doc.getElementsByTagName("w:p")

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    const { plain, html, hasFormatting } = extractRuns(p)
    if (!plain.trim()) continue

    const style = getParaStyle(p)
    const context = style || "Paragraph"
    const type = style?.startsWith("Heading") ? ("heading" as const) : ("text" as const)
    const segments = splitIntoSegments(plain)

    for (const seg of segments) {
      results.push({
        id: uuid(),
        original: seg.text,
        originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
        translated: seg.text,
        context,
        group: seg.group,
        type,
      })
    }
  }

  return results
}

function extractRuns(p: Element): { plain: string; html: string; hasFormatting: boolean } {
  const runs = p.getElementsByTagName("w:r")
  let plain = ""
  let html = ""
  let hasFormatting = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const textEls = run.getElementsByTagName("w:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) {
      text += textEls[j].textContent || ""
    }

    if (!text) continue

    const rPr = run.getElementsByTagName("w:rPr")[0]
    const bold = rPr?.getElementsByTagName("w:b").length > 0
    const italic = rPr?.getElementsByTagName("w:i").length > 0
    const underline = rPr?.getElementsByTagName("w:u").length > 0
    const strike = rPr?.getElementsByTagName("w:strike").length > 0

    plain += text

    let htmlText = text
    if (bold) { htmlText = `<b>${htmlText}</b>`; hasFormatting = true }
    if (italic) { htmlText = `<i>${htmlText}</i>`; hasFormatting = true }
    if (underline) { htmlText = `<u>${htmlText}</u>`; hasFormatting = true }
    if (strike) { htmlText = `<s>${htmlText}</s>`; hasFormatting = true }
    html += htmlText
  }

  return { plain, html, hasFormatting }
}

function getParaStyle(p: Element): string | null {
  const pPr = p.getElementsByTagName("w:pPr")[0]
  if (!pPr) return null
  const pStyle = pPr.getElementsByTagName("w:pStyle")[0]
  if (!pStyle) return null
  const val = pStyle.getAttribute("w:val") || ""

  const headingMatch = val.match(/^Heading(\d+)$/i)
  if (headingMatch) return `Heading ${headingMatch[1]}`
  if (val === "Title") return "Title"
  return val
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/parsers/docx.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parsers/docx.ts src/lib/parsers/docx.test.ts
git commit -m "feat: add DOCX parser with style and formatting extraction"
```

---

### Task 8: PPTX Parser

**Files:**
- Create: `src/lib/parsers/pptx.ts`, `src/lib/parsers/pptx.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/parsers/pptx.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { extractPptxStrings } from "./pptx"

function makePptx(slides: Record<string, string>): Promise<ArrayBuffer> {
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

describe("extractPptxStrings", () => {
  it("extracts text from a single slide", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Hello slide</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello slide")
    expect(result[0].context).toBe("Slide 1")
    expect(result[0].type).toBe("text")
  })

  it("extracts from multiple slides in order", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Slide one</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
      "slide2.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Slide two</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(2)
    expect(result[0].context).toBe("Slide 1")
    expect(result[1].context).toBe("Slide 2")
  })

  it("extracts bold formatting", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p>
            <a:r><a:t>Normal </a:t></a:r>
            <a:r><a:rPr b="1"/><a:t>bold</a:t></a:r>
          </a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result[0].original).toBe("Normal bold")
    expect(result[0].originalHtml).toBe("Normal <b>bold</b>")
  })

  it("skips empty paragraphs", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Text</a:t></a:r></a:p>
          <a:p></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(1)
  })

  it("sets translated equal to original", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Test</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result[0].translated).toBe("Test")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/parsers/pptx.test.ts
```

Expected: FAIL — module `./pptx` not found.

- [ ] **Step 3: Implement PPTX parser**

Create `src/lib/parsers/pptx.ts`:

```typescript
import JSZip from "jszip"
import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"
import { splitIntoSegments } from "./text-splitter"

export async function extractPptxStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  const zip = await JSZip.loadAsync(buffer)
  const results: TranslatableString[] = []

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0")
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0")
      return numA - numB
    })

  for (let slideIndex = 0; slideIndex < slideFiles.length; slideIndex++) {
    const xmlStr = await zip.file(slideFiles[slideIndex])!.async("string")
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml")
    const paragraphs = doc.getElementsByTagName("a:p")

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i]
      const { plain, html, hasFormatting } = extractPptxRuns(p)
      if (!plain.trim()) continue

      const context = `Slide ${slideIndex + 1}`
      const segments = splitIntoSegments(plain)

      for (const seg of segments) {
        results.push({
          id: uuid(),
          original: seg.text,
          originalHtml: segments.length === 1 && hasFormatting ? html : undefined,
          translated: seg.text,
          context,
          group: seg.group,
          type: "text",
        })
      }
    }
  }

  return results
}

function extractPptxRuns(p: Element): { plain: string; html: string; hasFormatting: boolean } {
  const runs = p.getElementsByTagName("a:r")
  let plain = ""
  let html = ""
  let hasFormatting = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const textEls = run.getElementsByTagName("a:t")
    let text = ""
    for (let j = 0; j < textEls.length; j++) {
      text += textEls[j].textContent || ""
    }
    if (!text) continue

    const rPr = run.getElementsByTagName("a:rPr")[0]
    const bold = rPr?.getAttribute("b") === "1"
    const italic = rPr?.getAttribute("i") === "1"
    const underline = rPr?.getAttribute("u") === "sng"
    const strike = rPr?.getAttribute("strike") === "sngStrike"

    plain += text

    let htmlText = text
    if (bold) { htmlText = `<b>${htmlText}</b>`; hasFormatting = true }
    if (italic) { htmlText = `<i>${htmlText}</i>`; hasFormatting = true }
    if (underline) { htmlText = `<u>${htmlText}</u>`; hasFormatting = true }
    if (strike) { htmlText = `<s>${htmlText}</s>`; hasFormatting = true }
    html += htmlText
  }

  return { plain, html, hasFormatting }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/parsers/pptx.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parsers/pptx.ts src/lib/parsers/pptx.test.ts
git commit -m "feat: add PPTX parser with slide ordering and formatting"
```

---

### Task 9: Project Index Store

**Files:**
- Create: `src/lib/store/project-index.ts`, `src/lib/store/project-index.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/store/project-index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  storeOriginalFile,
  getOriginalFile,
} from "./project-index"
import type { ProjectRecord } from "../parsers/types"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "test-" + Math.random().toString(36).slice(2),
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

beforeEach(async () => {
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
})

describe("project-index", () => {
  it("creates and retrieves a project", async () => {
    const project = makeProject({ id: "p1", name: "My Project" })
    await createProject(project)
    const fetched = await getProject("p1")
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe("My Project")
  })

  it("lists all projects", async () => {
    await createProject(makeProject({ id: "p1" }))
    await createProject(makeProject({ id: "p2" }))
    const all = await listProjects()
    expect(all).toHaveLength(2)
  })

  it("updates a project", async () => {
    const project = makeProject({ id: "p1", name: "Original" })
    await createProject(project)
    await updateProject({ ...project, name: "Updated" })
    const fetched = await getProject("p1")
    expect(fetched!.name).toBe("Updated")
  })

  it("deletes a project", async () => {
    const project = makeProject({ id: "p1" })
    await createProject(project)
    await deleteProject("p1")
    const fetched = await getProject("p1")
    expect(fetched).toBeUndefined()
  })

  it("returns undefined for missing project", async () => {
    const fetched = await getProject("nonexistent")
    expect(fetched).toBeUndefined()
  })

  it("stores and retrieves original file buffer", async () => {
    const buffer = new ArrayBuffer(8)
    new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8])
    await storeOriginalFile("file1", buffer)
    const retrieved = await getOriginalFile("file1")
    expect(retrieved).toBeDefined()
    expect(new Uint8Array(retrieved!)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/store/project-index.test.ts
```

Expected: FAIL — module `./project-index` not found.

- [ ] **Step 3: Implement project index store**

Create `src/lib/store/project-index.ts`:

```typescript
import { openDB, type DBSchema } from "idb"
import type { ProjectRecord } from "../parsers/types"

interface CodexDB extends DBSchema {
  projects: {
    key: string
    value: ProjectRecord
  }
  originals: {
    key: string
    value: ArrayBuffer
  }
}

const DB_NAME = "codex"
const DB_VERSION = 1

function getDb() {
  return openDB<CodexDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" })
      }
      if (!db.objectStoreNames.contains("originals")) {
        db.createObjectStore("originals")
      }
    },
  })
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const db = await getDb()
  return db.getAll("projects")
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  const db = await getDb()
  return db.get("projects", id)
}

export async function createProject(project: ProjectRecord): Promise<void> {
  const db = await getDb()
  await db.put("projects", project)
}

export async function updateProject(project: ProjectRecord): Promise<void> {
  const db = await getDb()
  await db.put("projects", project)
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb()
  await db.delete("projects", id)
}

export async function storeOriginalFile(fileId: string, buffer: ArrayBuffer): Promise<void> {
  const db = await getDb()
  await db.put("originals", buffer, `codex:original:${fileId}`)
}

export async function getOriginalFile(fileId: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb()
  return db.get("originals", `codex:original:${fileId}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/lib/store/project-index.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store/project-index.ts src/lib/store/project-index.test.ts
git commit -m "feat: add IndexedDB project index store with CRUD operations"
```

---

### Task 10: File Doc Store (Yjs)

**Files:**
- Create: `src/lib/store/file-doc.ts`

- [ ] **Step 1: Implement file doc store**

Create `src/lib/store/file-doc.ts`:

```typescript
import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import type { TranslatableString, FileType } from "../parsers/types"

export interface FileDocHandle {
  doc: Y.Doc
  persistence: IndexeddbPersistence
}

export function createFileDoc(
  fileId: string,
  fileName: string,
  fileType: FileType,
  sourceLanguage: string,
  targetLanguage: string,
  strings: TranslatableString[]
): FileDocHandle {
  const doc = new Y.Doc()

  const meta = doc.getMap("meta")
  const cells = doc.getMap("cells")
  const order = doc.getArray<string>("order")

  doc.transact(() => {
    meta.set("fileId", fileId)
    meta.set("fileName", fileName)
    meta.set("fileType", fileType)
    meta.set("sourceLanguage", sourceLanguage)
    meta.set("targetLanguage", targetLanguage)

    for (const str of strings) {
      const cell = new Y.Map<string>()
      cell.set("id", str.id)
      cell.set("original", str.original)
      if (str.originalHtml) cell.set("originalHtml", str.originalHtml)
      cell.set("translated", str.translated)
      cell.set("context", str.context)
      cell.set("group", str.group)
      cell.set("type", str.type)
      cells.set(str.id, cell)
      order.push([str.id])
    }
  })

  const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc)
  return { doc, persistence }
}

export function loadFileDoc(fileId: string): FileDocHandle {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc)
  return { doc, persistence }
}

export function destroyFileDoc(handle: FileDocHandle): void {
  handle.persistence.destroy()
  handle.doc.destroy()
}
```

- [ ] **Step 2: Verify all existing tests still pass**

```bash
npx vitest run
```

Expected: All tests PASS (no regressions).

- [ ] **Step 3: Commit**

```bash
git add src/lib/store/file-doc.ts
git commit -m "feat: add Yjs file doc store for CRDT cell management"
```

---

### Task 11: Import Orchestrator

**Files:**
- Create: `src/lib/import.ts`

- [ ] **Step 1: Implement import orchestrator**

Create `src/lib/import.ts`:

```typescript
import { v4 as uuid } from "uuid"
import type { FileType, FileReference, TranslatableString } from "./parsers/types"
import { detectFileType } from "./parsers/types"
import { extractPlaintextStrings } from "./parsers/plaintext"
import { extractMarkdownStrings } from "./parsers/markdown"
import { extractVttStrings, extractSrtStrings } from "./parsers/subtitle"
import { extractUsfmStrings } from "./parsers/usfm"
import { extractDocxStrings } from "./parsers/docx"
import { extractPptxStrings } from "./parsers/pptx"
import { createFileDoc, destroyFileDoc } from "./store/file-doc"
import { storeOriginalFile } from "./store/project-index"

interface ImportResult {
  name: string
  strings: TranslatableString[]
}

export async function importFile(
  file: File,
  sourceLanguage: string,
  targetLanguage: string
): Promise<FileReference[]> {
  const fileType = detectFileType(file.name)
  if (!fileType) {
    throw new Error(`Unsupported file type: ${file.name}`)
  }

  const results = await parseFile(file, fileType)
  const refs: FileReference[] = []

  for (const result of results) {
    const fileId = uuid()
    const handle = createFileDoc(
      fileId,
      result.name,
      fileType,
      sourceLanguage,
      targetLanguage,
      result.strings
    )

    await new Promise<void>((resolve) => {
      if (handle.persistence.synced) {
        resolve()
      } else {
        handle.persistence.once("synced", () => resolve())
      }
    })

    if (fileType === "docx" || fileType === "pptx") {
      await storeOriginalFile(fileId, await file.arrayBuffer())
    }

    refs.push({
      id: fileId,
      name: result.name,
      type: fileType,
      createdAt: new Date().toISOString(),
      cellCount: result.strings.length,
    })

    destroyFileDoc(handle)
  }

  return refs
}

async function parseFile(file: File, fileType: FileType): Promise<ImportResult[]> {
  switch (fileType) {
    case "txt": {
      const text = await file.text()
      return [{ name: file.name, strings: extractPlaintextStrings(text) }]
    }
    case "md": {
      const text = await file.text()
      return [{ name: file.name, strings: extractMarkdownStrings(text) }]
    }
    case "vtt": {
      const text = await file.text()
      return [{ name: file.name, strings: extractVttStrings(text) }]
    }
    case "srt": {
      const text = await file.text()
      return [{ name: file.name, strings: extractSrtStrings(text) }]
    }
    case "usfm": {
      const text = await file.text()
      const books = extractUsfmStrings(text)
      return books.map((b) => ({ name: b.bookId, strings: b.strings }))
    }
    case "docx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractDocxStrings(buffer)
      return [{ name: file.name, strings }]
    }
    case "pptx": {
      const buffer = await file.arrayBuffer()
      const strings = await extractPptxStrings(buffer)
      return [{ name: file.name, strings }]
    }
  }
}
```

- [ ] **Step 2: Verify all existing tests still pass**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/import.ts
git commit -m "feat: add import orchestrator bridging parsers to Yjs store"
```

---

### Task 12: React Hooks

**Files:**
- Create: `src/hooks/useProject.ts`, `src/hooks/useFileDoc.ts`, `src/hooks/useCells.ts`

- [ ] **Step 1: Create useProject hook**

Create `src/hooks/useProject.ts`:

```typescript
import { useCallback, useEffect, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { getProject } from "@/lib/store/project-index"

export function useProject(projectId: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    setLoading(true)
    getProject(projectId).then((p) => {
      setProject(p || null)
      setLoading(false)
    })
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { project, loading, refresh }
}
```

- [ ] **Step 2: Create useFileDoc hook**

Create `src/hooks/useFileDoc.ts`:

```typescript
import { useEffect, useState } from "react"
import * as Y from "yjs"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"

export function useFileDoc(fileId: string | null) {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!fileId) {
      setDoc(null)
      setLoading(false)
      return
    }

    setLoading(true)
    const handle = loadFileDoc(fileId)

    function onSynced() {
      setDoc(handle.doc)
      setLoading(false)
    }

    if (handle.persistence.synced) {
      onSynced()
    } else {
      handle.persistence.once("synced", onSynced)
    }

    return () => {
      destroyFileDoc(handle)
      setDoc(null)
    }
  }, [fileId])

  return { doc, loading }
}
```

- [ ] **Step 3: Create useCells hook**

Create `src/hooks/useCells.ts`:

```typescript
import { useEffect, useState } from "react"
import * as Y from "yjs"

export interface CellData {
  id: string
  original: string
  originalHtml?: string
  translated: string
  context: string
  group: string
  type: string
}

export function useCells(doc: Y.Doc | null): CellData[] {
  const [cells, setCells] = useState<CellData[]>([])

  useEffect(() => {
    if (!doc) {
      setCells([])
      return
    }

    const cellsMap = doc.getMap("cells")
    const orderArray = doc.getArray<string>("order")

    function update() {
      const ordered: CellData[] = []
      const ids = orderArray.toArray()
      for (const id of ids) {
        const cell = cellsMap.get(id) as Y.Map<string> | undefined
        if (!cell) continue
        ordered.push({
          id: cell.get("id") as string,
          original: cell.get("original") as string,
          originalHtml: cell.get("originalHtml") as string | undefined,
          translated: cell.get("translated") as string,
          context: cell.get("context") as string,
          group: cell.get("group") as string,
          type: cell.get("type") as string,
        })
      }
      setCells(ordered)
    }

    update()
    cellsMap.observeDeep(update)
    orderArray.observe(update)

    return () => {
      cellsMap.unobserveDeep(update)
      orderArray.unobserve(update)
    }
  }, [doc])

  return cells
}
```

- [ ] **Step 4: Verify all existing tests still pass**

```bash
npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useProject.ts src/hooks/useFileDoc.ts src/hooks/useCells.ts
git commit -m "feat: add React hooks for project, file doc, and cells"
```

---

### Task 13: Dashboard UI

**Files:**
- Create: `src/components/Dashboard.tsx`, `src/components/ProjectCard.tsx`, `src/components/ProjectCreateDialog.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create ProjectCard component**

Create `src/components/ProjectCard.tsx`:

```tsx
import type { ProjectRecord } from "@/lib/parsers/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface ProjectCardProps {
  project: ProjectRecord
  onClick: () => void
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{project.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {project.sourceLanguage} → {project.targetLanguage}
        </p>
        <p className="text-sm text-muted-foreground">
          {project.files.length} file{project.files.length !== 1 ? "s" : ""}
        </p>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Create ProjectCreateDialog component**

Create `src/components/ProjectCreateDialog.tsx`:

```tsx
import { useState } from "react"
import { v4 as uuid } from "uuid"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createProject } from "@/lib/store/project-index"
import type { ProjectRecord } from "@/lib/parsers/types"

interface ProjectCreateDialogProps {
  onCreated: (project: ProjectRecord) => void
}

export function ProjectCreateDialog({ onCreated }: ProjectCreateDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()) return

    const project: ProjectRecord = {
      id: uuid(),
      name: name.trim(),
      sourceLanguage: sourceLanguage.trim(),
      targetLanguage: targetLanguage.trim(),
      createdAt: new Date().toISOString(),
      files: [],
      members: [{ userId: "local", role: "owner" }],
    }

    await createProject(project)
    onCreated(project)
    setName("")
    setSourceLanguage("")
    setTargetLanguage("")
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>+ New Project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Project Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Translation Project"
            />
          </div>
          <div>
            <Label htmlFor="source">Source Language</Label>
            <Input
              id="source"
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              placeholder="en"
            />
          </div>
          <div>
            <Label htmlFor="target">Target Language</Label>
            <Input
              id="target"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              placeholder="fr"
            />
          </div>
          <Button type="submit" className="w-full">
            Create Project
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Create Dashboard component**

Create `src/components/Dashboard.tsx`:

```tsx
import { useEffect, useState } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { listProjects } from "@/lib/store/project-index"
import { ProjectCard } from "./ProjectCard"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

interface DashboardProps {
  onSelectProject: (projectId: string) => void
}

export function Dashboard({ onSelectProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectRecord[]>([])

  useEffect(() => {
    listProjects().then(setProjects)
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex items-center justify-between px-6 py-4">
          <h1 className="text-xl font-semibold">Codex Translator</h1>
          <ProjectCreateDialog
            onCreated={(project) => setProjects((prev) => [...prev, project])}
          />
        </div>
      </header>
      <main className="px-6 py-6">
        {projects.length === 0 ? (
          <p className="text-muted-foreground">
            No projects yet. Create one to get started.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onClick={() => onSelectProject(p.id)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 4: Update App.tsx**

Replace `src/App.tsx` with:

```tsx
import { useState } from "react"
import { Dashboard } from "@/components/Dashboard"

export default function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  if (activeProjectId) {
    return (
      <div className="p-8">
        <button onClick={() => setActiveProjectId(null)}>← Back</button>
        <p>Project: {activeProjectId}</p>
        <p className="text-muted-foreground">Workspace coming in next task.</p>
      </div>
    )
  }

  return <Dashboard onSelectProject={setActiveProjectId} />
}
```

- [ ] **Step 5: Start dev server and verify manually**

```bash
npm run dev
```

Open `http://localhost:5173`. Verify:
1. Dashboard renders with "Codex Translator" header and "+ New Project" button.
2. Click "+ New Project" opens a dialog with name, source language, target language fields.
3. Fill in fields, click "Create Project" — project card appears in the grid.
4. Click a project card — placeholder workspace text appears with back button.
5. Click "← Back" — returns to dashboard. Project persists (refresh page to confirm).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/Dashboard.tsx src/components/ProjectCard.tsx src/components/ProjectCreateDialog.tsx
git commit -m "feat: add Dashboard with project creation and listing"
```

---

### Task 14: Project Workspace UI

**Files:**
- Create: `src/components/ProjectWorkspace.tsx`, `src/components/Toolbar.tsx`, `src/components/ProjectSidebar.tsx`, `src/components/StatusBar.tsx`, `src/components/ImportDialog.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create Toolbar component**

Create `src/components/Toolbar.tsx`:

```tsx
import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"

interface ToolbarProps {
  project: ProjectRecord
  onBack: () => void
  onImport: () => void
}

export function Toolbar({ project, onBack, onImport }: ToolbarProps) {
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
    </header>
  )
}
```

- [ ] **Step 2: Create ProjectSidebar component**

Create `src/components/ProjectSidebar.tsx`:

```tsx
import type { FileReference } from "@/lib/parsers/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface ProjectSidebarProps {
  files: FileReference[]
  activeFileId: string | null
  onSelectFile: (fileId: string) => void
}

export function ProjectSidebar({
  files,
  activeFileId,
  onSelectFile,
}: ProjectSidebarProps) {
  return (
    <ScrollArea className="h-full w-56 border-r">
      <div className="p-2">
        <h3 className="mb-2 px-2 text-sm font-medium text-muted-foreground">
          Files
        </h3>
        {files.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">
            No files imported yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {files.map((file) => (
              <li key={file.id}>
                <button
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                    activeFileId === file.id && "bg-accent font-medium"
                  )}
                  onClick={() => onSelectFile(file.id)}
                >
                  <div className="truncate">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {file.cellCount} cells
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScrollArea>
  )
}
```

- [ ] **Step 3: Create StatusBar component**

Create `src/components/StatusBar.tsx`:

```tsx
import type { CellData } from "@/hooks/useCells"

interface StatusBarProps {
  cells: CellData[]
}

export function StatusBar({ cells }: StatusBarProps) {
  const total = cells.length
  const translated = cells.filter((c) => c.translated !== c.original).length
  const percentage = total > 0 ? Math.round((translated / total) * 100) : 0

  return (
    <footer className="border-t px-4 py-1.5 text-sm text-muted-foreground">
      {total.toLocaleString()} cells · {translated.toLocaleString()} translated · {percentage}%
    </footer>
  )
}
```

- [ ] **Step 4: Create ImportDialog component**

Create `src/components/ImportDialog.tsx`:

```tsx
import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { importFile } from "@/lib/import"
import type { FileReference } from "@/lib/parsers/types"

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceLanguage: string
  targetLanguage: string
  onImported: (refs: FileReference[]) => void
}

export function ImportDialog({
  open,
  onOpenChange,
  sourceLanguage,
  targetLanguage,
  onImported,
}: ImportDialogProps) {
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setImporting(true)
      setError(null)
      const allRefs: FileReference[] = []

      try {
        for (const file of Array.from(files)) {
          const refs = await importFile(file, sourceLanguage, targetLanguage)
          allRefs.push(...refs)
        }
        onImported(allRefs)
        onOpenChange(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed")
      } finally {
        setImporting(false)
      }
    },
    [sourceLanguage, targetLanguage, onImported, onOpenChange]
  )

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Files</DialogTitle>
        </DialogHeader>
        <div
          className={cn(
            "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
            dragOver ? "border-primary bg-primary/5" : "border-muted"
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {importing ? (
            <p className="text-sm text-muted-foreground">Importing...</p>
          ) : (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                Drag & drop files here, or
              </p>
              <Button variant="outline" size="sm" asChild>
                <label className="cursor-pointer">
                  Choose Files
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    accept=".md,.markdown,.docx,.pptx,.txt,.vtt,.srt,.usfm,.sfm"
                    onChange={handleFileInput}
                  />
                </label>
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Supported: MD, DOCX, PPTX, TXT, VTT, SRT, USFM
              </p>
            </>
          )}
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 5: Create ProjectWorkspace component**

Create `src/components/ProjectWorkspace.tsx`:

```tsx
import { useState } from "react"
import { useProject } from "@/hooks/useProject"
import { useFileDoc } from "@/hooks/useFileDoc"
import { useCells } from "@/hooks/useCells"
import { updateProject } from "@/lib/store/project-index"
import type { FileReference } from "@/lib/parsers/types"
import { Toolbar } from "./Toolbar"
import { ProjectSidebar } from "./ProjectSidebar"
import { StatusBar } from "./StatusBar"
import { ImportDialog } from "./ImportDialog"

interface ProjectWorkspaceProps {
  projectId: string
  onBack: () => void
}

export function ProjectWorkspace({ projectId, onBack }: ProjectWorkspaceProps) {
  const { project, loading, refresh } = useProject(projectId)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const { doc } = useFileDoc(activeFileId)
  const cells = useCells(doc)

  if (loading || !project) {
    return <div className="p-8 text-muted-foreground">Loading...</div>
  }

  async function handleImported(refs: FileReference[]) {
    if (!project) return
    const updated = {
      ...project,
      files: [...project.files, ...refs],
    }
    await updateProject(updated)
    refresh()
    if (refs.length > 0) {
      setActiveFileId(refs[0].id)
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        project={project}
        onBack={onBack}
        onImport={() => setImportOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar
          files={project.files}
          activeFileId={activeFileId}
          onSelectFile={setActiveFileId}
        />
        <main className="flex-1 overflow-hidden">
          {activeFileId ? (
            doc ? (
              <div className="p-4 text-sm text-muted-foreground">
                Editor table coming in next task. {cells.length} cells loaded.
              </div>
            ) : (
              <p className="p-4 text-muted-foreground">Loading file...</p>
            )
          ) : (
            <p className="p-4 text-muted-foreground">
              Select a file from the sidebar, or import files.
            </p>
          )}
        </main>
      </div>
      <StatusBar cells={cells} />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        sourceLanguage={project.sourceLanguage}
        targetLanguage={project.targetLanguage}
        onImported={handleImported}
      />
    </div>
  )
}
```

- [ ] **Step 6: Wire up App.tsx**

Replace `src/App.tsx`:

```tsx
import { useState } from "react"
import { Dashboard } from "@/components/Dashboard"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"

export default function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  if (activeProjectId) {
    return (
      <ProjectWorkspace
        projectId={activeProjectId}
        onBack={() => setActiveProjectId(null)}
      />
    )
  }

  return <Dashboard onSelectProject={setActiveProjectId} />
}
```

- [ ] **Step 7: Start dev server and verify manually**

```bash
npm run dev
```

Open `http://localhost:5173`. Verify:
1. Create a new project, click into it.
2. Toolbar shows project name, language pair, "← Back" and "+ Import" buttons.
3. Sidebar says "No files imported yet."
4. Click "+ Import" → dialog opens with drag-drop zone and file picker.
5. Import a `.txt` file with some text → file appears in sidebar.
6. Click file in sidebar → "N cells loaded" message appears.
7. Status bar at bottom shows cell count and 0% translated.
8. Click "← Back" → dashboard. Click project again → files still listed (persisted).

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/components/ProjectWorkspace.tsx src/components/Toolbar.tsx src/components/ProjectSidebar.tsx src/components/StatusBar.tsx src/components/ImportDialog.tsx
git commit -m "feat: add project workspace with sidebar, toolbar, import, and status bar"
```

---

### Task 15: Editor Table & Final Integration

**Files:**
- Create: `src/components/EditorTable.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Create EditorTable component**

Create `src/components/EditorTable.tsx`:

```tsx
import { useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import * as Y from "yjs"
import DOMPurify from "dompurify"
import type { CellData } from "@/hooks/useCells"

interface EditorTableProps {
  cells: CellData[]
  doc: Y.Doc
}

export function EditorTable({ cells, doc }: EditorTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: cells.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
  })

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 grid grid-cols-2 gap-2 border-b bg-background px-4 py-2 text-sm font-medium text-muted-foreground">
        <div>Source</div>
        <div>Target</div>
      </div>

      {/* Virtualized rows */}
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const cell = cells[virtualRow.index]
          return (
            <div
              key={cell.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <EditorRow cell={cell} doc={doc} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EditorRow({ cell, doc }: { cell: CellData; doc: Y.Doc }) {
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const cellsMap = doc.getMap("cells")
    const yCell = cellsMap.get(cell.id) as Y.Map<string>
    if (yCell) {
      doc.transact(() => {
        yCell.set("translated", e.target.value)
      })
    }
  }

  // NOTE: All HTML passed to dangerouslySetInnerHTML is sanitized via DOMPurify.
  // The parsers only generate safe tags (<b>, <i>, <u>, <s>, <code>), and
  // DOMPurify at the render boundary provides defense-in-depth against XSS.
  return (
    <div className="grid grid-cols-2 gap-2 border-b px-4 py-2">
      {/* Source column */}
      <div>
        <span className="mb-1 block text-xs text-muted-foreground">
          {cell.context}
        </span>
        {cell.originalHtml ? (
          <div
            className="text-sm"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(cell.originalHtml),
            }}
          />
        ) : (
          <div className="text-sm">{cell.original}</div>
        )}
      </div>

      {/* Target column */}
      <div>
        <textarea
          className="w-full resize-none rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          value={cell.translated}
          onChange={handleChange}
          rows={Math.max(2, Math.ceil(cell.original.length / 50))}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire EditorTable into ProjectWorkspace**

In `src/components/ProjectWorkspace.tsx`, add the import at the top:

```tsx
import { EditorTable } from "./EditorTable"
```

Replace the placeholder content inside `<main>`:

Change this:

```tsx
{activeFileId ? (
  doc ? (
    <div className="p-4 text-sm text-muted-foreground">
      Editor table coming in next task. {cells.length} cells loaded.
    </div>
  ) : (
    <p className="p-4 text-muted-foreground">Loading file...</p>
  )
) : (
  <p className="p-4 text-muted-foreground">
    Select a file from the sidebar, or import files.
  </p>
)}
```

To:

```tsx
{activeFileId ? (
  doc ? (
    <EditorTable cells={cells} doc={doc} />
  ) : (
    <p className="p-4 text-muted-foreground">Loading file...</p>
  )
) : (
  <p className="p-4 text-muted-foreground">
    Select a file from the sidebar, or import files.
  </p>
)}
```

- [ ] **Step 3: Start dev server and verify full flow**

```bash
npm run dev
```

Open `http://localhost:5173`. Full end-to-end test:

1. **Create project:** Click "+ New Project", fill name="Test", source="en", target="fr", submit.
2. **Enter project:** Click the project card.
3. **Import .txt file:** Click "+ Import", pick a `.txt` file with several paragraphs.
4. **Verify sidebar:** File appears in sidebar with cell count.
5. **Verify editor:** Click file → virtualized table with Source | Target columns.
6. **Verify source display:** Source column shows original text with context labels.
7. **Edit translation:** Click a target textarea, type a translation.
8. **Verify persistence:** Refresh the page → navigate back to the project and file → edited translation persists.
9. **Verify status bar:** Shows total cells, translated count updates when you edit, percentage updates.
10. **Test with .md file:** Import a markdown file with headings, lists, bold text → verify context labels ("Heading 1", "List item"), verify bold text renders in source column.
11. **Scroll performance:** Import a large file (or paste many paragraphs into a .txt) → scroll should be smooth (virtualized).

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: All tests PASS. No regressions.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorTable.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat: add virtualized editor table with Yjs-bound translation editing"
```

---

## Summary

| Task | What it builds | Test type |
|------|---------------|-----------|
| 1 | Vite + React + TS + Tailwind + ShadCN + Vitest | Scaffold |
| 2 | Core types, text splitter | Unit (6 tests) |
| 3 | Plain text parser | Unit (5 tests) |
| 4 | Markdown parser | Unit (11 tests) |
| 5 | VTT + SRT subtitle parsers | Unit (7 tests) |
| 6 | USFM parser | Unit (7 tests) |
| 7 | DOCX parser | Unit (7 tests) |
| 8 | PPTX parser | Unit (5 tests) |
| 9 | Project index store | Integration (6 tests) |
| 10 | Yjs file doc store | Regression check |
| 11 | Import orchestrator | Regression check |
| 12 | React hooks | Regression check |
| 13 | Dashboard + project cards + create dialog | Manual |
| 14 | Workspace + toolbar + sidebar + import + status bar | Manual |
| 15 | Virtualized editor table + final integration | Manual E2E |

Total automated tests: ~54
