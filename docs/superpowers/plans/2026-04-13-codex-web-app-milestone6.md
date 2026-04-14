# Codex Web App — Milestone 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-facing `Cmd+K` search across all project cells, and per-cell LLM back-translation for verification.

**Architecture:** New WorkspaceIndex covers all cells (not just translated). SearchDialog is a ShadCN dialog with keyboard shortcut and scroll-to-cell navigation. Backtranslations persist as Y.Map fields on each cell with staleness detection.

**Tech Stack:** Existing: tokenizer, SearchIndex, completion service, Y.Doc. New: WorkspaceIndex, SearchDialog, backtranslation service.

---

## File Structure

```
src/
├── lib/
│   ├── search/
│   │   ├── workspace-index.ts           # NEW: WorkspaceIndex class
│   │   └── workspace-index.test.ts      # NEW: TDD
│   ├── completion/
│   │   ├── backtranslation-service.ts   # NEW
│   │   └── backtranslation-service.test.ts # NEW: TDD
│   └── store/
│       └── file-doc.ts                  # MODIFY: persist backtranslation fields
├── hooks/
│   ├── useCells.ts                      # MODIFY: expose backtranslation
│   ├── useCellHistory.ts                # MODIFY: setCellBacktranslation
│   ├── useWorkspaceSearch.ts            # NEW: lazy index + debounced search
│   └── useBacktranslation.ts            # NEW
├── components/
│   ├── SearchDialog.tsx                 # NEW
│   ├── EditorTable.tsx                  # MODIFY: backtranslation UI + scrollToCell
│   ├── Toolbar.tsx                      # MODIFY: search button
│   └── ProjectWorkspace.tsx             # MODIFY: search + back-translation wiring
```

---

### Task 1: WorkspaceIndex (TDD)

**Files:**
- Create: `src/lib/search/workspace-index.ts`, `src/lib/search/workspace-index.test.ts`

- [ ] **Step 1: Write tests**

Create `src/lib/search/workspace-index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import { WorkspaceIndex } from "./workspace-index"
import type { ExportCell } from "@/lib/store/file-doc"

function makeCell(overrides: Partial<ExportCell> & { id: string }): ExportCell {
  return {
    original: "", translated: "", context: "", group: "", type: "text",
    ...overrides,
  }
}

describe("WorkspaceIndex", () => {
  let index: WorkspaceIndex
  beforeEach(() => { index = new WorkspaceIndex() })

  it("returns empty results for empty query", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "Hello", translated: "Bonjour", context: "P1" }),
    ]}])
    expect(index.search("")).toHaveLength(0)
  })

  it("finds matches on source text", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "In the beginning God created", translated: "", context: "V1" }),
    ]}])
    const results = index.search("beginning")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
    expect(results[0].fileId).toBe("f1")
    expect(results[0].fileName).toBe("test.txt")
  })

  it("finds matches on target text", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "Hello", translated: "Bonjour le monde", context: "P1" }),
    ]}])
    const results = index.search("monde")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
  })

  it("finds matches on context", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "text", translated: "", context: "Genesis 3:15" }),
    ]}])
    const results = index.search("Genesis")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
  })

  it("returns matched tokens", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "God created the heavens", translated: "", context: "" }),
    ]}])
    const results = index.search("God heavens")
    expect(results[0].matchedTokens).toContain("god")
    expect(results[0].matchedTokens).toContain("heavens")
  })

  it("ranks more matches higher", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "cat only", translated: "", context: "" }),
      makeCell({ id: "c2", original: "cat and dog together", translated: "", context: "" }),
    ]}])
    const results = index.search("cat dog together")
    expect(results[0].cellId).toBe("c2")
  })

  it("respects limit", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "hello world", translated: "", context: "" }),
      makeCell({ id: "c2", original: "hello there", translated: "", context: "" }),
      makeCell({ id: "c3", original: "hello friend", translated: "", context: "" }),
    ]}])
    const results = index.search("hello", 2)
    expect(results).toHaveLength(2)
  })

  it("searches across multiple files", () => {
    index.buildFromProject([
      { fileId: "f1", fileName: "one.txt", cells: [makeCell({ id: "c1", original: "apple", translated: "", context: "" })] },
      { fileId: "f2", fileName: "two.txt", cells: [makeCell({ id: "c2", original: "apple banana", translated: "", context: "" })] },
    ])
    const results = index.search("apple")
    expect(results).toHaveLength(2)
    const fileIds = results.map((r) => r.fileId)
    expect(fileIds).toContain("f1")
    expect(fileIds).toContain("f2")
  })

  it("indexes empty cells too (unlike SearchIndex)", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "empty target cell", translated: "", context: "" }),
    ]}])
    const results = index.search("empty")
    expect(results).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Verify fail**

```bash
npx vitest run src/lib/search/workspace-index.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/search/workspace-index.ts`:

```typescript
import { tokenizeText } from "./tokenizer"
import type { ExportCell } from "@/lib/store/file-doc"

export interface WorkspaceSearchResult {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  matchedTokens: string[]
  score: number
}

interface IndexedCell {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  tokens: Set<string>
}

const MIN_SCORE = 0.01

export class WorkspaceIndex {
  private cells: IndexedCell[] = []
  private docFreq: Map<string, number> = new Map()
  private docCount = 0

  buildFromProject(files: { fileId: string; fileName: string; cells: ExportCell[] }[]): void {
    this.cells = []
    this.docFreq.clear()
    this.docCount = 0

    for (const file of files) {
      for (const cell of file.cells) {
        const combined = `${cell.original} ${cell.translated} ${cell.context}`
        const tokens = new Set(tokenizeText(combined))
        this.cells.push({
          cellId: cell.id,
          fileId: file.fileId,
          fileName: file.fileName,
          original: cell.original,
          translated: cell.translated,
          context: cell.context,
          tokens,
        })
        this.docCount += 1
        for (const t of tokens) {
          this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1)
        }
      }
    }
  }

  search(query: string, limit = 20): WorkspaceSearchResult[] {
    const cleaned = query.trim()
    if (!cleaned) return []

    const queryTokens = new Set(tokenizeText(cleaned))
    if (queryTokens.size === 0) return []

    const results: WorkspaceSearchResult[] = []

    for (const cell of this.cells) {
      const matched: string[] = []
      let idfSum = 0
      for (const t of queryTokens) {
        if (cell.tokens.has(t)) {
          matched.push(t)
          const df = this.docFreq.get(t) || 1
          idfSum += Math.log((this.docCount + 1) / (df + 1))
        }
      }
      if (matched.length === 0) continue

      const coverage = matched.length / queryTokens.size
      const maxIdf = queryTokens.size * Math.log((this.docCount + 1) / 2)
      const normalizedIdf = maxIdf > 0 ? idfSum / maxIdf : 0
      const score = 0.3 * coverage + 0.7 * normalizedIdf

      if (score < MIN_SCORE) continue

      results.push({
        cellId: cell.cellId,
        fileId: cell.fileId,
        fileName: cell.fileName,
        original: cell.original,
        translated: cell.translated,
        context: cell.context,
        matchedTokens: matched,
        score,
      })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/search/workspace-index.test.ts
```

Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search/workspace-index.ts src/lib/search/workspace-index.test.ts
git commit -m "feat: add WorkspaceIndex for cross-file cell search"
```

---

### Task 2: useWorkspaceSearch hook + SearchDialog + Toolbar integration

**Files:**
- Create: `src/hooks/useWorkspaceSearch.ts`
- Create: `src/components/SearchDialog.tsx`
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`
- Modify: `src/components/EditorTable.tsx` (expose scrollToIndex imperative handle)

- [ ] **Step 1: Create useWorkspaceSearch hook**

Create `src/hooks/useWorkspaceSearch.ts`:

```typescript
import { useCallback, useMemo, useRef, useState } from "react"
import { WorkspaceIndex, type WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { collectExportCells } from "@/lib/store/file-doc"
import type { FileReference } from "@/lib/parsers/types"

export function useWorkspaceSearch(files: FileReference[]) {
  const indexRef = useRef(new WorkspaceIndex())
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])

  const filesKey = useMemo(() => files.map((f) => f.id).join(","), [files])
  const lastBuiltKey = useRef<string>("")

  const buildIndex = useCallback(async () => {
    if (lastBuiltKey.current === filesKey && ready) return
    setLoading(true)
    try {
      const fileDatas = await Promise.all(
        files.map(async (f) => {
          const data = await collectExportCells(f.id)
          return { fileId: f.id, fileName: data.fileName, cells: data.cells }
        })
      )
      indexRef.current.buildFromProject(fileDatas)
      lastBuiltKey.current = filesKey
      setReady(true)
    } finally {
      setLoading(false)
    }
  }, [files, filesKey, ready])

  const search = useCallback((query: string) => {
    if (!ready) {
      setResults([])
      return
    }
    setResults(indexRef.current.search(query, 20))
  }, [ready])

  // Invalidate if files list changes
  if (lastBuiltKey.current !== filesKey && ready) {
    setReady(false)
  }

  return { buildIndex, search, results, loading, ready }
}
```

- [ ] **Step 2: Create SearchDialog**

Create `src/components/SearchDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from "react"
import { Search as SearchIcon, FileText } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { HighlightedText } from "./HighlightedText"
import { cn } from "@/lib/utils"

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onReady: () => void | Promise<void>  // build index when opened
  loading: boolean
  ready: boolean
  results: WorkspaceSearchResult[]
  onSearch: (query: string) => void
  onSelect: (result: WorkspaceSearchResult) => void
}

export function SearchDialog({
  open, onOpenChange, onReady, loading, ready, results, onSearch, onSelect,
}: SearchDialogProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      setActiveIndex(0)
      onReady()
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open, onReady])

  useEffect(() => {
    const timer = setTimeout(() => onSearch(query), 100)
    return () => clearTimeout(timer)
  }, [query, onSearch, ready])

  useEffect(() => {
    setActiveIndex(0)
  }, [results])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const r = results[activeIndex]
      if (r) {
        onSelect(r)
        onOpenChange(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-4 pt-3">
          <DialogTitle className="text-sm">Search all cells</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <SearchIcon className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? "Building index..." : "Type to search..."}
            disabled={loading}
            className="border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[400px] overflow-auto">
          {!query.trim() ? (
            <p className="p-4 text-sm text-muted-foreground">
              {loading ? "Loading project cells..." : "Type to search across all files."}
            </p>
          ) : results.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul>
              {results.map((r, i) => (
                <li key={`${r.fileId}-${r.cellId}`}>
                  <button
                    onClick={() => { onSelect(r); onOpenChange(false) }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      "w-full border-b px-4 py-2 text-left",
                      i === activeIndex ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <FileText className="h-3 w-3" />
                      <span className="truncate">{r.fileName}</span>
                      {r.context && <span>· {r.context}</span>}
                    </div>
                    <div className="mt-0.5 text-sm">
                      <HighlightedText
                        text={r.original}
                        highlights={r.matchedTokens.map((t) => ({ token: t, colorIndex: 0 }))}
                      />
                    </div>
                    {r.translated && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        →{" "}
                        <HighlightedText
                          text={r.translated}
                          highlights={r.matchedTokens.map((t) => ({ token: t, colorIndex: 0 }))}
                        />
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {ready && (
          <div className="border-t px-4 py-1.5 text-[10px] text-muted-foreground">
            ↑↓ navigate · Enter select · Esc close
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Update EditorTable to expose scroll-to-cell**

Read `src/components/EditorTable.tsx`. Add a ref-based imperative API.

At the top of the file, change the import:
```typescript
import { useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from "react"
```

Add an interface for the handle (add near the top of the file, after imports):

```typescript
export interface EditorTableHandle {
  scrollToCellIndex: (index: number) => void
}
```

Wrap the `EditorTable` component in `forwardRef`. Change the export:

```typescript
export const EditorTable = forwardRef<EditorTableHandle, EditorTableProps>(function EditorTable({
  cells, doc, username, isCompletionConfigured,
  completing, examples, errors,
  onCompleteSingle, onCompleteBatch, healthMap,
  infractions = new Map(), rules = [], onInfractionClick,
}: EditorTableProps, ref) {
  // ... existing body ...

  useImperativeHandle(ref, () => ({
    scrollToCellIndex(index: number) {
      if (index >= 0 && index < cells.length) {
        virtualizer.scrollToIndex(index, { align: "center" })
      }
    },
  }), [virtualizer, cells.length])

  // ... existing return JSX ...
})
```

Add the `useImperativeHandle` call inside the function body before the `return` statement.

At the very end of the file, after the forwardRef, note that displayName may be helpful but not required. TypeScript may need explicit display name if strict.

- [ ] **Step 4: Update Toolbar with search button**

Read `src/components/Toolbar.tsx`. Add a Search import and button.

Replace the file with:

```tsx
import { Settings, Scale, Download, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"

interface ToolbarProps {
  project: ProjectRecord
  onBack: () => void
  onImport: () => void
  onSettings: () => void
  onRules: () => void
  onExport: () => void
  onSearch: () => void
  exportEnabled: boolean
}

export function Toolbar({ project, onBack, onImport, onSettings, onRules, onExport, onSearch, exportEnabled }: ToolbarProps) {
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
      <Button variant="ghost" size="sm" onClick={onSearch} title="Search (Cmd+K)">
        <Search className="h-4 w-4" />
      </Button>
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

- [ ] **Step 5: Wire in ProjectWorkspace**

Read `src/components/ProjectWorkspace.tsx`. Add imports:

```typescript
import { useRef, useEffect } from "react"
// if useRef/useEffect aren't already imported
import { useWorkspaceSearch } from "@/hooks/useWorkspaceSearch"
import { SearchDialog } from "./SearchDialog"
import type { EditorTableHandle } from "./EditorTable"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
```

Inside the component body, add:

```typescript
  const [searchOpen, setSearchOpen] = useState(false)
  const editorRef = useRef<EditorTableHandle>(null)
  const { buildIndex, search: runSearch, results: searchResults, loading: searchLoading, ready: searchReady } = useWorkspaceSearch(project?.files || [])

  // Cmd+K / Ctrl+K shortcut
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

  async function handleSearchSelect(result: WorkspaceSearchResult) {
    if (result.fileId !== activeFileId) {
      setActiveFileId(result.fileId)
      // Wait for cells to load, then scroll — use a short timeout since useFileDoc is async
      setTimeout(() => {
        const idx = cells.findIndex((c) => c.id === result.cellId)
        if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
      }, 300)
    } else {
      const idx = cells.findIndex((c) => c.id === result.cellId)
      if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
    }
  }
```

Update the Toolbar to pass `onSearch`:
```tsx
        onSearch={() => setSearchOpen(true)}
```

Update the EditorTable to pass the ref:
```tsx
<EditorTable
  ref={editorRef}
  cells={cells} doc={doc} username={project.username || "local"}
  // ... existing props
/>
```

Add SearchDialog at the bottom of the component (alongside ImportDialog):

```tsx
<SearchDialog
  open={searchOpen}
  onOpenChange={setSearchOpen}
  onReady={buildIndex}
  loading={searchLoading}
  ready={searchReady}
  results={searchResults}
  onSearch={runSearch}
  onSelect={handleSearchSelect}
/>
```

- [ ] **Step 6: Run all tests + build**

```bash
npx vitest run && npm run build
```

Expected: all tests pass, clean build.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useWorkspaceSearch.ts src/components/SearchDialog.tsx src/components/Toolbar.tsx src/components/ProjectWorkspace.tsx src/components/EditorTable.tsx
git commit -m "feat: add Cmd+K search across all project cells with navigation"
```

---

### Task 3: Back-translation service (TDD) + persistence

**Files:**
- Create: `src/lib/completion/backtranslation-service.ts`, `src/lib/completion/backtranslation-service.test.ts`
- Modify: `src/lib/store/file-doc.ts`
- Modify: `src/hooks/useCells.ts`
- Modify: `src/hooks/useCellHistory.ts`

- [ ] **Step 1: Write backtranslation service tests**

Create `src/lib/completion/backtranslation-service.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest"
import { buildBacktranslationPrompt, BACKTRANSLATION_SYSTEM_PROMPT } from "./backtranslation-service"

describe("buildBacktranslationPrompt", () => {
  it("constructs system prompt with language placeholders", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour le monde",
      examples: [],
    })
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toContain("English")
    expect(messages[0].content).toContain("French")
    expect(messages[0].content).toContain("word-for-word")
  })

  it("includes target text in user message", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour le monde",
      examples: [],
    })
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("Bonjour le monde")
  })

  it("includes few-shot examples", () => {
    const messages = buildBacktranslationPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      targetText: "Bonjour",
      examples: [
        { target: "Je suis un chat", backtranslation: "I am a cat" },
        { target: "Le livre rouge", backtranslation: "The book red" },
      ],
    })
    const content = messages[1].content
    expect(content).toContain("Je suis un chat")
    expect(content).toContain("I am a cat")
    expect(content).toContain("Le livre rouge")
    expect(content).toContain("The book red")
    expect(content).toContain("Bonjour")
  })

  it("exports BACKTRANSLATION_SYSTEM_PROMPT constant", () => {
    expect(BACKTRANSLATION_SYSTEM_PROMPT).toContain("word-for-word")
    expect(BACKTRANSLATION_SYSTEM_PROMPT).toContain("{sourceLanguage}")
    expect(BACKTRANSLATION_SYSTEM_PROMPT).toContain("{targetLanguage}")
  })
})
```

- [ ] **Step 2: Implement backtranslation service**

Create `src/lib/completion/backtranslation-service.ts`:

```typescript
import { complete } from "./completion-service"
import type { CompletionSettings } from "@/lib/parsers/types"

export const BACKTRANSLATION_SYSTEM_PROMPT = `You are a backtranslation assistant. You will be given text in {targetLanguage} that is a translation. Your job is to provide a word-for-word, literal translation of that text BACK into {sourceLanguage}.

A backtranslation preserves the exact words and structure of the translated text, even if it sounds unnatural. For example, if the translation says "house of him", the backtranslation should say "house of him" — not "his house". This shows exactly what the translation says at a word level.

The purpose is verification: translators use backtranslations to confirm their translation conveys the intended meaning and doesn't drift.

Return ONLY the backtranslation text. No explanations, no markdown, no notes.`

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

interface BuildOptions {
  sourceLanguage: string
  targetLanguage: string
  targetText: string
  examples: { target: string; backtranslation: string }[]
}

export function buildBacktranslationPrompt(options: BuildOptions): ChatMessage[] {
  const systemContent = BACKTRANSLATION_SYSTEM_PROMPT
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  let userContent = ""
  for (const ex of options.examples) {
    userContent += `Text: ${ex.target}\nBacktranslation: ${ex.backtranslation}\n\n`
  }
  userContent += `Text: ${options.targetText}\nBacktranslation:`

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent.trim() },
  ]
}

export interface GenerateBacktranslationOptions extends BuildOptions {
  settings: CompletionSettings
  onChunk?: (text: string) => void
}

export async function generateBacktranslation(options: GenerateBacktranslationOptions): Promise<string> {
  const messages = buildBacktranslationPrompt({
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    targetText: options.targetText,
    examples: options.examples,
  })

  return complete({
    endpoint: options.settings.endpoint,
    model: options.settings.model,
    messages,
    maxTokens: options.settings.maxTokens,
    temperature: 0.1, // low temperature for literal backtranslation
    stream: Boolean(options.onChunk),
    onChunk: options.onChunk,
  })
}
```

- [ ] **Step 3: Run backtranslation tests**

```bash
npx vitest run src/lib/completion/backtranslation-service.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 4: Persist backtranslation in Y.Doc**

Read `src/lib/store/file-doc.ts`. In the `collectExportCells` function, extend `ExportCell` to include backtranslation fields. Replace the `ExportCell` interface:

```typescript
export interface ExportCell {
  id: string
  original: string
  translated: string
  context: string
  group: string
  type: string
  sourceLocation?: { file: string; blockPath: string }
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
}
```

In the `collectExportCells` function body, add the backtranslation fields when building the cell object:

```typescript
      cells.push({
        id: (cell.get("id") as string) || cellId,
        original: (cell.get("original") as string) || "",
        translated: (cell.get("translated") as string) || "",
        context: (cell.get("context") as string) || "",
        group: (cell.get("group") as string) || "",
        type: (cell.get("type") as string) || "text",
        sourceLocation: cell.get("sourceLocation") as { file: string; blockPath: string } | undefined,
        backtranslation: cell.get("backtranslation") as string | undefined,
        backtranslationUpdatedAt: cell.get("backtranslationUpdatedAt") as string | undefined,
        backtranslationForText: cell.get("backtranslationForText") as string | undefined,
      })
```

- [ ] **Step 5: Expose backtranslation on CellData**

Read `src/hooks/useCells.ts`. Update `CellData` interface:

```typescript
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
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
}
```

Inside the `update` function, read these fields from the Y.Map:

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
          backtranslation: cell.get("backtranslation") as string | undefined,
          backtranslationUpdatedAt: cell.get("backtranslationUpdatedAt") as string | undefined,
          backtranslationForText: cell.get("backtranslationForText") as string | undefined,
        })
```

- [ ] **Step 6: Add setCellBacktranslation helper**

Read `src/hooks/useCellHistory.ts`. Append a new function:

```typescript
export function setCellBacktranslation(
  doc: Y.Doc,
  cellId: string,
  backtranslation: string,
  forText: string
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    cell.set("backtranslation", backtranslation)
    cell.set("backtranslationUpdatedAt", new Date().toISOString())
    cell.set("backtranslationForText", forText)
  })
}
```

- [ ] **Step 7: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/completion/backtranslation-service.ts src/lib/completion/backtranslation-service.test.ts src/lib/store/file-doc.ts src/hooks/useCells.ts src/hooks/useCellHistory.ts
git commit -m "feat: add backtranslation service and Y.Doc persistence"
```

---

### Task 4: useBacktranslation hook + EditorTable UI

**Files:**
- Create: `src/hooks/useBacktranslation.ts`
- Modify: `src/components/EditorTable.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`

- [ ] **Step 1: Create useBacktranslation hook**

Create `src/hooks/useBacktranslation.ts`:

```typescript
import { useCallback, useState } from "react"
import * as Y from "yjs"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { CellData } from "./useCells"
import { generateBacktranslation } from "@/lib/completion/backtranslation-service"
import { setCellBacktranslation } from "./useCellHistory"

interface FindExamples {
  (cell: CellData): { target: string; backtranslation: string }[]
}

export function useBacktranslation(
  doc: Y.Doc | null,
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  findExamples: FindExamples
) {
  const [generating, setGenerating] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())

  const isConfigured = Boolean(settings?.endpoint && settings?.model)

  const generate = useCallback(async (cell: CellData) => {
    if (!doc || !settings || !isConfigured) return
    const targetText = cell.translated.trim()
    if (!targetText) return

    setGenerating((p) => new Set(p).add(cell.id))
    setErrors((p) => { const n = new Map(p); n.delete(cell.id); return n })

    try {
      const examples = findExamples(cell)
      // Clear existing backtranslation as streaming begins
      setCellBacktranslation(doc, cell.id, "", targetText)

      const result = await generateBacktranslation({
        sourceLanguage,
        targetLanguage,
        targetText,
        examples,
        settings,
        onChunk: (text) => {
          setCellBacktranslation(doc, cell.id, text, targetText)
        },
      })

      setCellBacktranslation(doc, cell.id, result, targetText)
    } catch (err) {
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    } finally {
      setGenerating((p) => { const n = new Set(p); n.delete(cell.id); return n })
    }
  }, [doc, settings, isConfigured, sourceLanguage, targetLanguage, findExamples])

  return { generate, generating, errors, isConfigured }
}
```

- [ ] **Step 2: Add backtranslation UI to EditorTable**

Read `src/components/EditorTable.tsx`. Changes:

1. Add imports:
```typescript
import { Languages, RefreshCw, AlertTriangle as StaleIcon } from "lucide-react"
```

2. Extend `EditorTableProps`:
```typescript
  isBacktranslationConfigured?: boolean
  onBacktranslate?: (cell: CellData) => void
  backtranslating?: Set<string>
  backtranslationErrors?: Map<string, string>
```

3. Thread through to `EditorRow`. Add to `EditorRowProps`:
```typescript
  isBacktranslationConfigured?: boolean
  isBacktranslating?: boolean
  backtranslationError?: string
  onBacktranslate?: (cell: CellData) => void
```

4. In EditorRow, add a backtranslation icon button in the validation column (after the health ring and status indicator). Logic:
   - Show only when `cell.translated.trim()` has content
   - Disabled when `!isBacktranslationConfigured`
   - Spinner when `isBacktranslating`

```tsx
{cell.translated && cell.translated.trim() && isBacktranslationConfigured !== undefined && (
  <button
    className={cn(
      "mt-1 flex h-5 w-5 items-center justify-center rounded",
      isBacktranslating ? "animate-pulse text-primary" : "text-muted-foreground hover:text-primary",
      !isBacktranslationConfigured && "cursor-not-allowed text-muted-foreground/30"
    )}
    disabled={!isBacktranslationConfigured || isBacktranslating}
    onClick={() => onBacktranslate?.(cell)}
    title={
      !isBacktranslationConfigured
        ? "Configure LLM in settings"
        : isBacktranslating
          ? "Generating..."
          : cell.backtranslation ? "Regenerate backtranslation" : "Generate backtranslation"
    }
  >
    <Languages className="h-3 w-3" />
  </button>
)}
```

5. Below the target textarea (still inside the target column `<div>`), add a backtranslation display:

```tsx
{cell.backtranslation && (
  <div className="mt-1 rounded border-l-2 border-blue-400 bg-muted/30 px-2 py-1 text-xs italic text-muted-foreground">
    <div className="flex items-center gap-1.5">
      {cell.backtranslationForText !== cell.translated && (
        <span title="Translation has changed since backtranslation" className="text-amber-500">
          <StaleIcon className="h-3 w-3 inline" /> stale
        </span>
      )}
      <button
        onClick={() => onBacktranslate?.(cell)}
        disabled={!isBacktranslationConfigured || isBacktranslating}
        className="text-muted-foreground hover:text-primary"
        title="Regenerate"
      >
        <RefreshCw className={cn("h-3 w-3 inline", isBacktranslating && "animate-spin")} />
      </button>
      <span className="text-[10px]">backtranslation:</span>
    </div>
    <div className="mt-0.5">{cell.backtranslation}</div>
  </div>
)}
{backtranslationError && (
  <p className="mt-0.5 text-xs text-destructive">{backtranslationError}</p>
)}
```

6. Pass the new props from EditorTable body into EditorRow. Add to the JSX rendering EditorRow:

```tsx
<EditorRow
  // existing props...
  isBacktranslationConfigured={isBacktranslationConfigured}
  isBacktranslating={backtranslating?.has(cell.id)}
  backtranslationError={backtranslationErrors?.get(cell.id)}
  onBacktranslate={onBacktranslate}
/>
```

- [ ] **Step 3: Wire backtranslation in ProjectWorkspace**

Read `src/components/ProjectWorkspace.tsx`. Add:

```typescript
import { useBacktranslation } from "@/hooks/useBacktranslation"
```

After `useCompletion`, add `useBacktranslation`:

```typescript
  // Find similar cells with existing backtranslations for few-shot context
  const findBacktranslationExamples = useCallback((target: CellData) => {
    const target_text = target.translated.trim().toLowerCase()
    if (!target_text) return []
    // Find cells with backtranslations whose target text shares tokens
    return cells
      .filter((c) => c.id !== target.id && c.backtranslation && c.backtranslationForText === c.translated)
      .map((c) => ({ target: c.translated, backtranslation: c.backtranslation! }))
      .slice(0, 3)
  }, [cells])

  const {
    generate: generateBacktranslation,
    generating: backtranslating,
    errors: backtranslationErrors,
    isConfigured: isBacktranslationConfigured,
  } = useBacktranslation(
    doc,
    project?.completionSettings,
    project?.sourceLanguage || "",
    project?.targetLanguage || "",
    findBacktranslationExamples
  )
```

Add `useCallback` to the react import if not already present.

Update the EditorTable JSX:
```tsx
<EditorTable
  ref={editorRef}
  cells={cells} doc={doc} username={project.username || "local"}
  isCompletionConfigured={isConfigured} completing={completing}
  examples={examples} errors={errors}
  onCompleteSingle={completeSingle} onCompleteBatch={completeBatch}
  healthMap={healthMap}
  infractions={infractions}
  rules={rules}
  onInfractionClick={(ruleId) => setDrawerRuleId(ruleId)}
  isBacktranslationConfigured={isBacktranslationConfigured}
  onBacktranslate={generateBacktranslation}
  backtranslating={backtranslating}
  backtranslationErrors={backtranslationErrors}
/>
```

- [ ] **Step 4: Run all tests + build**

```bash
npx vitest run && npm run build
```

Expected: all tests pass, clean build.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useBacktranslation.ts src/components/EditorTable.tsx src/components/ProjectWorkspace.tsx
git commit -m "feat: add per-cell backtranslation with inline display and staleness indicator"
```

---

## Summary

| Task | What it builds | Test type |
|------|---------------|-----------|
| 1 | WorkspaceIndex for cross-file search | Unit (+9 tests) |
| 2 | useWorkspaceSearch + SearchDialog + Cmd+K + scroll-to-cell | Manual |
| 3 | Back-translation service + Y.Doc persistence | Unit (+4 tests) |
| 4 | useBacktranslation hook + EditorTable UI | Manual |

New automated tests: ~13. Total after: ~150.
