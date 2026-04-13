# Codex Web App — Milestone 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-powered translation completions with example search, cell history/validation tracking, project settings, client-side routing, and debug routes. Target cells start empty.

**Architecture:** Search index built in-memory from already-translated cells (context-branching algorithm). Completion service calls vLLM-compatible OpenAI API with few-shot examples from search. Cell edits tracked in Y.Array history per cell. React Router for navigation. Debug routes expose raw state as JSON.

**Tech Stack:** react-router-dom (new), lucide-react (already via ShadCN), existing stack (Vite, React, TS, Yjs, Tailwind, ShadCN)

---

## File Structure

```
src/
├── App.tsx                           # REWRITE: react-router-dom routes
├── main.tsx                          # MODIFY: wrap in BrowserRouter
├── lib/
│   ├── parsers/
│   │   ├── types.ts                  # MODIFY: add CompletionSettings, CellHistoryEntry, extend ProjectRecord
│   │   ├── plaintext.ts             # MODIFY: translated = ""
│   │   ├── markdown.ts              # MODIFY: translated = ""
│   │   ├── subtitle.ts             # MODIFY: translated = ""
│   │   ├── usfm.ts                  # MODIFY: translated = ""
│   │   ├── docx.ts                  # MODIFY: translated = ""
│   │   └── pptx.ts                  # MODIFY: translated = ""
│   ├── search/
│   │   ├── tokenizer.ts             # NEW: tokenizeText utility
│   │   ├── tokenizer.test.ts        # NEW: TDD
│   │   ├── search-index.ts          # NEW: SearchIndex class with branching search
│   │   └── search-index.test.ts     # NEW: TDD
│   ├── completion/
│   │   ├── completion-service.ts    # NEW: prompt building + vLLM API calls
│   │   └── completion-service.test.ts # NEW: TDD
│   └── store/
│       └── file-doc.ts              # MODIFY: add history Y.Array to cells
├── components/
│   ├── EditorTable.tsx              # REWRITE: sparkle button, status, example panel, highlights
│   ├── ProjectWorkspace.tsx         # REWRITE: useParams, search index, completion
│   ├── Dashboard.tsx                # MODIFY: useNavigate instead of callback
│   ├── ProjectCard.tsx              # no change needed (onClick prop is fine)
│   ├── Toolbar.tsx                  # MODIFY: add onSettings prop, settings icon
│   ├── StatusBar.tsx                # MODIFY: show empty/unvalidated/validated counts
│   ├── ProjectSettings.tsx          # NEW: settings form
│   ├── DebugView.tsx                # NEW: JSON state viewer
│   ├── ExamplePanel.tsx             # NEW: expandable example viewer with highlights
│   ├── HighlightedText.tsx          # NEW: text with colored token highlights
│   └── SparkleButton.tsx            # NEW: completion trigger with drag behavior
├── hooks/
│   ├── useCells.ts                  # MODIFY: add history, status to CellData
│   ├── useSearchIndex.ts            # NEW: search index lifecycle
│   ├── useCompletion.ts             # NEW: single + batch completion
│   └── useCellHistory.ts            # NEW: append history entries on cell edit
└── ...
```

---

### Task 1: Extended Types + Empty Targets

**Files:**
- Modify: `src/lib/parsers/types.ts`
- Modify: all 6 parser files + their tests

- [ ] **Step 1: Extend types.ts**

Add these interfaces to `src/lib/parsers/types.ts`:

```typescript
export interface CompletionSettings {
  endpoint: string
  model: string
  maxTokens: number
  temperature: number
  systemPrompt: string
}

export interface CellHistoryEntry {
  timestamp: string
  value: string
  source: "human" | "llm"
  author: string
  validated: boolean
  examples?: string[]
}
```

Add fields to `ProjectRecord` (add before the closing `}`):

```typescript
  completionSettings?: CompletionSettings
  username?: string
```

- [ ] **Step 2: Change all parsers to set `translated = ""`**

In every parser file, change `translated: seg.text` (or `translated: text`) to `translated: ""`. The files and the specific lines:

- `src/lib/parsers/plaintext.ts`: `translated: seg.text` → `translated: ""`
- `src/lib/parsers/markdown.ts`: `translated: seg.text` → `translated: ""`
- `src/lib/parsers/subtitle.ts`: two places (VTT and SRT): `translated: text` → `translated: ""`
- `src/lib/parsers/usfm.ts`: `translated: seg.text` → `translated: ""` AND remove the line `last.translated = last.original` in the continuation handler (replace with a comment: `// translated stays empty`)
- `src/lib/parsers/docx.ts`: `translated: seg.text` → `translated: ""`
- `src/lib/parsers/pptx.ts`: `translated: seg.text` → `translated: ""`

- [ ] **Step 3: Update tests**

In each parser test file, find the test that asserts `translated` equals original and change it to assert `translated` equals `""`:

- `plaintext.test.ts`: `expect(result[0].translated).toBe(result[0].original)` → `expect(result[0].translated).toBe("")`
- `markdown.test.ts`: `expect(result[0].translated).toBe("Bold text")` → `expect(result[0].translated).toBe("")`
- `subtitle.test.ts`: `expect(result[0].translated).toBe("Hello")` → `expect(result[0].translated).toBe("")`
- `usfm.test.ts`: `expect(result[0].strings[0].translated).toBe("Test verse.")` → `expect(result[0].strings[0].translated).toBe("")`
- `docx.test.ts`: `expect(result[0].translated).toBe("Hello")` → `expect(result[0].translated).toBe("")`
- `pptx.test.ts`: `expect(result[0].translated).toBe("Test")` → `expect(result[0].translated).toBe("")`

- [ ] **Step 4: Run tests**

```bash
npx vitest run
```

Expected: All 54 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parsers/
git commit -m "feat: empty target cells and add completion/history types"
```

---

### Task 2: Router + Debug Routes

**Files:**
- Modify: `src/main.tsx`
- Rewrite: `src/App.tsx`
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/components/ProjectWorkspace.tsx`
- Create: `src/components/DebugView.tsx`
- Create: `src/components/ProjectSettings.tsx` (stub)

- [ ] **Step 1: Install react-router-dom**

```bash
npm install react-router-dom
```

- [ ] **Step 2: Wrap main.tsx in BrowserRouter**

Read `src/main.tsx` first to see current content, then modify to add BrowserRouter wrapping `<App />`:

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
```

- [ ] **Step 3: Rewrite App.tsx with routes**

```tsx
import { Routes, Route } from "react-router-dom"
import { Dashboard } from "@/components/Dashboard"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"
import { ProjectSettings } from "@/components/ProjectSettings"
import { DebugView } from "@/components/DebugView"

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/debug" element={<DebugView />} />
      <Route path="/project/:id" element={<ProjectWorkspace />} />
      <Route path="/project/:id/debug" element={<DebugView />} />
      <Route path="/project/:id/settings" element={<ProjectSettings />} />
      <Route path="/project/:id/settings/debug" element={<DebugView />} />
    </Routes>
  )
}
```

- [ ] **Step 4: Update Dashboard — remove prop, use useNavigate**

Replace `src/components/Dashboard.tsx` — change `DashboardProps` to no props, use `useNavigate` for project selection:

```tsx
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import { listProjects } from "@/lib/store/project-index"
import { ProjectCard } from "./ProjectCard"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const navigate = useNavigate()

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
                onClick={() => navigate(`/project/${p.id}`)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 5: Update Toolbar with settings icon**

Replace `src/components/Toolbar.tsx`:

```tsx
import { Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"

interface ToolbarProps {
  project: ProjectRecord
  onBack: () => void
  onImport: () => void
  onSettings: () => void
}

export function Toolbar({ project, onBack, onImport, onSettings }: ToolbarProps) {
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
      <Button variant="ghost" size="sm" onClick={onSettings}>
        <Settings className="h-4 w-4" />
      </Button>
    </header>
  )
}
```

- [ ] **Step 6: Update ProjectWorkspace to use useParams/useNavigate**

Replace `src/components/ProjectWorkspace.tsx` — remove props interface, use `useParams` for projectId and `useNavigate` for navigation:

```tsx
import { useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { useFileDoc } from "@/hooks/useFileDoc"
import { useCells } from "@/hooks/useCells"
import { updateProject } from "@/lib/store/project-index"
import type { FileReference } from "@/lib/parsers/types"
import { Toolbar } from "./Toolbar"
import { ProjectSidebar } from "./ProjectSidebar"
import { StatusBar } from "./StatusBar"
import { ImportDialog } from "./ImportDialog"
import { EditorTable } from "./EditorTable"

export function ProjectWorkspace() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { project, loading, refresh } = useProject(projectId!)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const { doc } = useFileDoc(activeFileId)
  const cells = useCells(doc)

  if (loading || !project) {
    return <div className="p-8 text-muted-foreground">Loading...</div>
  }

  async function handleImported(refs: FileReference[]) {
    if (!project) return
    const updated = { ...project, files: [...project.files, ...refs] }
    await updateProject(updated)
    refresh()
    if (refs.length > 0) setActiveFileId(refs[0].id)
  }

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        project={project}
        onBack={() => navigate("/")}
        onImport={() => setImportOpen(true)}
        onSettings={() => navigate(`/project/${projectId}/settings`)}
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
              <EditorTable cells={cells} doc={doc} />
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

- [ ] **Step 7: Create DebugView**

Create `src/components/DebugView.tsx`:

```tsx
import { useEffect, useState } from "react"
import { useParams, useLocation } from "react-router-dom"
import { listProjects, getProject } from "@/lib/store/project-index"

export function DebugView() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const [state, setState] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      if (!id) {
        const projects = await listProjects()
        setState({ projects })
      } else if (location.pathname.includes("/settings/debug")) {
        const project = await getProject(id)
        setState({
          project: project || null,
          completionSettings: project?.completionSettings || null,
          username: project?.username || "local",
        })
      } else {
        const project = await getProject(id)
        setState({
          project: project || null,
          files: project?.files || [],
        })
      }
      setLoading(false)
    }
    load()
  }, [id, location.pathname])

  if (loading) return <pre>Loading...</pre>

  return (
    <pre style={{ padding: "1rem", fontFamily: "monospace", fontSize: "0.875rem" }}>
      {JSON.stringify(state, null, 2)}
    </pre>
  )
}
```

- [ ] **Step 8: Create ProjectSettings stub**

Create `src/components/ProjectSettings.tsx`:

```tsx
import { useParams, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"

export function ProjectSettings() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          ← Back to Editor
        </Button>
        <h2 className="font-semibold">Project Settings</h2>
      </header>
      <main className="mx-auto max-w-2xl p-6">
        <p className="text-muted-foreground">Settings form coming in Task 6.</p>
      </main>
    </div>
  )
}
```

- [ ] **Step 9: Run tests + build**

```bash
npx vitest run && npm run build
```

Expected: All tests pass, clean build.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add react-router-dom with routes, debug views, and settings stub"
```

---

### Task 3: Tokenizer + Search Index (TDD)

**Files:**
- Create: `src/lib/search/tokenizer.ts`, `src/lib/search/tokenizer.test.ts`
- Create: `src/lib/search/search-index.ts`, `src/lib/search/search-index.test.ts`

- [ ] **Step 1: Write tokenizer test**

Create `src/lib/search/tokenizer.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { tokenizeText } from "./tokenizer"

describe("tokenizeText", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenizeText("Hello World")).toEqual(["hello", "world"])
  })

  it("strips HTML tags", () => {
    expect(tokenizeText("This is <b>bold</b> text")).toEqual(["this", "is", "bold", "text"])
  })

  it("strips punctuation", () => {
    expect(tokenizeText("Hello, world! How's it?")).toEqual(["hello", "world", "how", "s", "it"])
  })

  it("handles empty input", () => {
    expect(tokenizeText("")).toEqual([])
    expect(tokenizeText("   ")).toEqual([])
  })

  it("filters empty strings", () => {
    expect(tokenizeText("  multiple   spaces  ")).toEqual(["multiple", "spaces"])
  })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
npx vitest run src/lib/search/tokenizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement tokenizer**

Create `src/lib/search/tokenizer.ts`:

```typescript
export function tokenizeText(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/<[^>]*?>/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}
```

- [ ] **Step 4: Run tokenizer test**

```bash
npx vitest run src/lib/search/tokenizer.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Write search index test**

Create `src/lib/search/search-index.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import { SearchIndex } from "./search-index"

describe("SearchIndex", () => {
  let index: SearchIndex

  beforeEach(() => {
    index = new SearchIndex()
  })

  it("returns empty results for empty index", () => {
    expect(index.search("hello world")).toHaveLength(0)
  })

  it("finds a matching pair by token overlap", () => {
    index.addPair("c1", "In the beginning God created", "Au commencement Dieu crea", "f1")
    const results = index.search("In the beginning")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
    expect(results[0].score).toBeGreaterThan(0)
  })

  it("ranks better matches higher", () => {
    index.addPair("c1", "the cat sat on the mat", "le chat", "f1")
    index.addPair("c2", "In the beginning God created the heavens", "Au commencement", "f1")
    const results = index.search("In the beginning God created", 2)
    expect(results[0].cellId).toBe("c2")
  })

  it("returns matchedTokens for highlighting", () => {
    index.addPair("c1", "God created the heavens and the earth", "Dieu crea", "f1")
    const results = index.search("God created the heavens")
    expect(results[0].matchedTokens.length).toBeGreaterThan(0)
    expect(results[0].matchedTokens).toContain("god")
    expect(results[0].matchedTokens).toContain("created")
  })

  it("uses branching to find multiple diverse results", () => {
    index.addPair("c1", "In the beginning God created", "Au commencement Dieu crea", "f1")
    index.addPair("c2", "the heavens and the earth", "les cieux et la terre", "f1")
    index.addPair("c3", "and the earth was without form", "et la terre etait informe", "f1")
    const results = index.search("In the beginning God created the heavens and the earth", 3)
    expect(results.length).toBeGreaterThanOrEqual(2)
    const ids = results.map((r) => r.cellId)
    expect(ids).toContain("c1")
    expect(ids).toContain("c2")
  })

  it("removePair removes from index", () => {
    index.addPair("c1", "hello world", "bonjour monde", "f1")
    expect(index.search("hello")).toHaveLength(1)
    index.removePair("c1")
    expect(index.search("hello")).toHaveLength(0)
  })

  it("buildFromProject populates index from translated cells only", () => {
    index.buildFromProject([{
      fileId: "f1",
      cells: [
        { id: "c1", original: "hello", translated: "bonjour", originalHtml: undefined, context: "", group: "", type: "text" },
        { id: "c2", original: "world", translated: "", originalHtml: undefined, context: "", group: "", type: "text" },
      ],
    }])
    expect(index.search("hello")).toHaveLength(1)
    expect(index.search("world")).toHaveLength(0)
  })

  it("handles empty query", () => {
    index.addPair("c1", "hello", "bonjour", "f1")
    expect(index.search("")).toHaveLength(0)
  })
})
```

- [ ] **Step 6: Run to verify fail**

```bash
npx vitest run src/lib/search/search-index.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Implement search index**

Create `src/lib/search/search-index.ts`:

```typescript
import { tokenizeText } from "./tokenizer"

export interface TranslationPair {
  cellId: string
  source: string
  target: string
  fileId: string
}

export interface ScoredPair extends TranslationPair {
  score: number
  matchedTokens: string[]
}

interface IndexedPair extends TranslationPair {
  tokens: Set<string>
}

interface CellInput {
  id: string
  original: string
  translated: string
  originalHtml?: string
  context: string
  group: string
  type: string
}

export class SearchIndex {
  private pairs: Map<string, IndexedPair> = new Map()

  buildFromProject(files: { fileId: string; cells: CellInput[] }[]): void {
    this.pairs.clear()
    for (const file of files) {
      for (const cell of file.cells) {
        if (cell.translated && cell.translated.trim()) {
          this.addPair(cell.id, cell.original, cell.translated, file.fileId)
        }
      }
    }
  }

  addPair(cellId: string, source: string, target: string, fileId: string): void {
    this.pairs.set(cellId, {
      cellId, source, target, fileId,
      tokens: new Set(tokenizeText(source)),
    })
  }

  removePair(cellId: string): void {
    this.pairs.delete(cellId)
  }

  search(query: string, limit = 5): ScoredPair[] {
    const cleanQuery = query.trim()
    if (!cleanQuery) return []

    const coverageWeight = 0.5
    const maxRestarts = 2
    const maxBranches = 12

    const results: ScoredPair[] = []
    let queryBranches: string[] = [cleanQuery]
    const usedCellIds = new Set<string>()
    let restartCount = 0

    while (results.length < limit && restartCount <= maxRestarts) {
      if (queryBranches.length === 0) {
        restartCount += 1
        if (restartCount > maxRestarts) break
        queryBranches = [cleanQuery]
        continue
      }

      let bestScore = -Infinity
      let bestPair: ScoredPair | null = null
      let bestBranchIndex = -1
      let bestBranchQuery = ""
      let bestSourceText = ""

      for (let branchIdx = 0; branchIdx < queryBranches.length; branchIdx++) {
        const branchQuery = queryBranches[branchIdx]
        if (!branchQuery.trim()) continue

        const branchTokens = tokenizeText(branchQuery)
        const branchTokenSet = new Set(branchTokens)

        for (const [, pair] of this.pairs) {
          if (usedCellIds.has(pair.cellId)) continue

          const matched: string[] = []
          for (const t of branchTokenSet) {
            if (pair.tokens.has(t)) matched.push(t)
          }
          if (matched.length === 0) continue

          const coverage = branchTokenSet.size > 0 ? matched.length / branchTokenSet.size : 0
          const baseScore = coverage
          const score = baseScore * (1 + coverageWeight * coverage)

          if (score > bestScore) {
            bestScore = score
            bestBranchIndex = branchIdx
            bestBranchQuery = branchQuery
            bestSourceText = pair.source
            bestPair = {
              cellId: pair.cellId, source: pair.source, target: pair.target,
              fileId: pair.fileId, score, matchedTokens: matched,
            }
          }
        }
      }

      if (!bestPair) break
      results.push(bestPair)
      usedCellIds.add(bestPair.cellId)

      const covered = this.findLongestCoveredSubstring(bestBranchQuery, bestSourceText)
      if (bestBranchIndex >= 0) queryBranches.splice(bestBranchIndex, 1)
      if (covered) {
        const newBranches = this.removeSubstringAndSplit(bestBranchQuery, covered)
        for (const nb of newBranches) {
          if (nb && nb !== bestBranchQuery) queryBranches.push(nb)
          if (queryBranches.length >= maxBranches) break
        }
      }
    }

    return results.slice(0, limit)
  }

  private findLongestCoveredSubstring(queryText: string, sourceText: string): string {
    const queryWords = tokenizeText(queryText)
    const sourceWords = new Set(tokenizeText(sourceText))
    let longest = ""
    for (let i = 0; i < queryWords.length; i++) {
      for (let j = i + 1; j <= queryWords.length; j++) {
        const slice = queryWords.slice(i, j)
        if (slice.every((w) => sourceWords.has(w))) {
          const substring = slice.join(" ")
          if (substring.length > longest.length) longest = substring
        }
      }
    }
    return longest
  }

  private removeSubstringAndSplit(queryText: string, coveredSubstring: string): string[] {
    if (!coveredSubstring) return []
    const q = tokenizeText(queryText).join(" ")
    const c = tokenizeText(coveredSubstring).join(" ")
    const remaining = (" " + q + " ").replace(` ${c} `, " | ").trim()
    return remaining.split("|").map((s) => s.trim()).filter((s) => s.length > 0)
  }
}
```

- [ ] **Step 8: Run search index test**

```bash
npx vitest run src/lib/search/search-index.test.ts
```

Expected: 8 tests PASS.

- [ ] **Step 9: Run all tests**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 10: Commit**

```bash
git add src/lib/search/
git commit -m "feat: add tokenizer and context-branching search index with TDD"
```

---

### Task 4: Completion Service (TDD)

**Files:**
- Create: `src/lib/completion/completion-service.ts`, `src/lib/completion/completion-service.test.ts`

- [ ] **Step 1: Write test**

Create `src/lib/completion/completion-service.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest"
import { buildPrompt, fetchModels, DEFAULT_SYSTEM_PROMPT } from "./completion-service"

describe("buildPrompt", () => {
  it("builds a prompt with examples and source text", () => {
    const messages = buildPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      sourceText: "In the beginning",
      examples: [
        { source: "God created", target: "Dieu crea" },
        { source: "the heavens", target: "les cieux" },
      ],
    })
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[0].content).toContain("English")
    expect(messages[0].content).toContain("French")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("God created")
    expect(messages[1].content).toContain("Dieu crea")
    expect(messages[1].content).toContain("In the beginning")
  })

  it("builds a prompt with no examples", () => {
    const messages = buildPrompt({
      sourceLanguage: "English",
      targetLanguage: "French",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      sourceText: "Hello world",
      examples: [],
    })
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toContain("Hello world")
  })

  it("uses custom system prompt with placeholders", () => {
    const messages = buildPrompt({
      sourceLanguage: "English",
      targetLanguage: "Spanish",
      systemPrompt: "Translate {sourceLanguage} to {targetLanguage}.",
      sourceText: "test",
      examples: [],
    })
    expect(messages[0].content).toBe("Translate English to Spanish.")
  })
})

describe("fetchModels", () => {
  it("extracts model IDs from /v1/models response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        object: "list",
        data: [{ id: "gemma-4-26B", object: "model" }, { id: "llama-3", object: "model" }],
      }),
    }))
    const models = await fetchModels("http://localhost:8000")
    expect(models).toEqual(["gemma-4-26B", "llama-3"])
    vi.unstubAllGlobals()
  })

  it("throws on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }))
    await expect(fetchModels("http://localhost:8000")).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
npx vitest run src/lib/completion/completion-service.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement completion service**

Create `src/lib/completion/completion-service.ts`:

```typescript
export const DEFAULT_SYSTEM_PROMPT =
  "You are a translation assistant. Translate from {sourceLanguage} to {targetLanguage}. Output ONLY the translation, nothing else. Do not include explanations, notes, or the original text."

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export function buildPrompt(options: {
  sourceLanguage: string
  targetLanguage: string
  systemPrompt: string
  sourceText: string
  examples: { source: string; target: string }[]
}): ChatMessage[] {
  const systemContent = options.systemPrompt
    .replace(/\{sourceLanguage\}/g, options.sourceLanguage)
    .replace(/\{targetLanguage\}/g, options.targetLanguage)

  let userContent = ""
  for (const ex of options.examples) {
    userContent += `Source: ${ex.source}\nTranslation: ${ex.target}\n\n`
  }
  userContent += `Source: ${options.sourceText}\nTranslation:`

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent.trim() },
  ]
}

export async function fetchModels(endpoint: string): Promise<string[]> {
  const response = await fetch(`${endpoint}/v1/models`)
  if (!response.ok) throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
  const data = await response.json()
  return data.data.map((m: { id: string }) => m.id)
}

export async function complete(options: {
  endpoint: string
  model: string
  messages: ChatMessage[]
  maxTokens: number
  temperature: number
  stream?: boolean
  onChunk?: (text: string) => void
}): Promise<string> {
  const response = await fetch(`${options.endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: options.stream || false,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Completion failed: ${response.status} ${text}`)
  }

  if (options.stream && options.onChunk && response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let full = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = decoder.decode(value, { stream: true }).split("\n").filter((l) => l.startsWith("data: "))
      for (const line of lines) {
        const json = line.slice(6)
        if (json === "[DONE]") break
        try {
          const delta = JSON.parse(json).choices?.[0]?.delta?.content || ""
          if (delta) { full += delta; options.onChunk(full) }
        } catch { /* skip malformed */ }
      }
    }
    return full.trim()
  }

  const data = await response.json()
  return data.choices[0]?.message?.content?.trim() || ""
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/completion/completion-service.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/completion/
git commit -m "feat: add completion service with prompt building and vLLM API"
```

---

### Task 5: Cell History + useCells Update

**Files:**
- Modify: `src/lib/store/file-doc.ts`
- Rewrite: `src/hooks/useCells.ts`
- Create: `src/hooks/useCellHistory.ts`

- [ ] **Step 1: Update file-doc.ts**

In `src/lib/store/file-doc.ts`, change `new Y.Map<string>()` to `new Y.Map()` and add history array after `cell.set("type", ...)`:

```typescript
      const cell = new Y.Map()
      cell.set("id", str.id)
      cell.set("original", str.original)
      if (str.originalHtml) cell.set("originalHtml", str.originalHtml)
      cell.set("translated", str.translated)
      cell.set("context", str.context)
      cell.set("group", str.group)
      cell.set("type", str.type)
      cell.set("history", new Y.Array())
```

- [ ] **Step 2: Rewrite useCells with status + history**

Replace `src/hooks/useCells.ts`:

```typescript
import { useEffect, useState } from "react"
import * as Y from "yjs"
import type { CellHistoryEntry } from "@/lib/parsers/types"

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
}

function deriveStatus(translated: string, history: CellHistoryEntry[]): "empty" | "unvalidated" | "validated" {
  if (!translated || !translated.trim()) return "empty"
  if (history.length === 0) return "validated"
  return history[history.length - 1].validated ? "validated" : "unvalidated"
}

export function useCells(doc: Y.Doc | null): CellData[] {
  const [cells, setCells] = useState<CellData[]>([])

  useEffect(() => {
    if (!doc) { setCells([]); return }

    const cellsMap = doc.getMap("cells")
    const orderArray = doc.getArray<string>("order")

    function update() {
      const ordered: CellData[] = []
      for (const id of orderArray.toArray()) {
        const cell = cellsMap.get(id) as Y.Map<unknown> | undefined
        if (!cell) continue
        const translated = (cell.get("translated") as string) || ""
        const historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
        const history: CellHistoryEntry[] = historyArr ? historyArr.toArray() : []
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
        })
      }
      setCells(ordered)
    }

    update()
    cellsMap.observeDeep(update)
    orderArray.observe(update)
    return () => { cellsMap.unobserveDeep(update); orderArray.unobserve(update) }
  }, [doc])

  return cells
}
```

- [ ] **Step 3: Create useCellHistory**

Create `src/hooks/useCellHistory.ts`:

```typescript
import * as Y from "yjs"
import type { CellHistoryEntry } from "@/lib/parsers/types"

export function appendCellHistory(
  doc: Y.Doc,
  cellId: string,
  entry: Omit<CellHistoryEntry, "timestamp">
): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return

  doc.transact(() => {
    cell.set("translated", entry.value)
    let historyArr = cell.get("history") as Y.Array<CellHistoryEntry> | undefined
    if (!historyArr) {
      historyArr = new Y.Array<CellHistoryEntry>()
      cell.set("history", historyArr)
    }
    historyArr.push([{ ...entry, timestamp: new Date().toISOString() }])
  })
}

export function validateCell(doc: Y.Doc, cellId: string, username: string): void {
  const cellsMap = doc.getMap("cells")
  const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) return
  const translated = (cell.get("translated") as string) || ""
  if (!translated.trim()) return
  appendCellHistory(doc, cellId, { value: translated, source: "human", author: username, validated: true })
}
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store/file-doc.ts src/hooks/useCells.ts src/hooks/useCellHistory.ts
git commit -m "feat: add cell history tracking with validation status"
```

---

### Task 6: Project Settings Page

**Files:**
- Rewrite: `src/components/ProjectSettings.tsx`

- [ ] **Step 1: Implement full settings page**

Replace `src/components/ProjectSettings.tsx` with the full implementation including Project Info, User, and LLM Completion sections. The component uses `useParams` for project ID, loads the project from IndexedDB, and auto-saves on blur.

Key elements:
- Project name, source/target language inputs (auto-save on blur)
- Username input (auto-save on blur)
- Endpoint URL input with "Connect" button that calls `fetchModels()`
- Model dropdown (populated after connect)
- Max tokens number input
- Temperature range slider
- System prompt textarea

Use lucide-react icons: `ArrowLeft`, `CheckCircle`, `XCircle`, `Loader2`. Use ShadCN components: `Button`, `Input`, `Label`, `Card`, `CardContent`, `CardHeader`, `CardTitle`.

Full implementation (read the ProjectSettings stub first, then replace):

```tsx
import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, CheckCircle, XCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getProject, updateProject } from "@/lib/store/project-index"
import { fetchModels } from "@/lib/completion/completion-service"
import type { ProjectRecord, CompletionSettings } from "@/lib/parsers/types"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"

export function ProjectSettings() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)

  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [username, setUsername] = useState("")

  const [endpoint, setEndpoint] = useState("")
  const [model, setModel] = useState("")
  const [maxTokens, setMaxTokens] = useState(512)
  const [temperature, setTemperature] = useState(0.3)
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)

  const [models, setModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!id) return
    getProject(id).then((p) => {
      if (!p) return
      setProject(p)
      setName(p.name)
      setSourceLanguage(p.sourceLanguage)
      setTargetLanguage(p.targetLanguage)
      setUsername(p.username || "local")
      if (p.completionSettings) {
        setEndpoint(p.completionSettings.endpoint)
        setModel(p.completionSettings.model)
        setMaxTokens(p.completionSettings.maxTokens)
        setTemperature(p.completionSettings.temperature)
        setSystemPrompt(p.completionSettings.systemPrompt)
      }
      setLoading(false)
    })
  }, [id])

  async function save(updates: Partial<ProjectRecord>) {
    if (!project) return
    const updated = { ...project, ...updates }
    await updateProject(updated)
    setProject(updated)
  }

  function saveCompletionSettings() {
    save({
      completionSettings: { endpoint: endpoint.trim(), model, maxTokens, temperature, systemPrompt },
    })
  }

  async function handleConnect() {
    if (!endpoint.trim()) return
    setConnecting(true)
    setConnectionError(null)
    setConnected(false)
    try {
      const list = await fetchModels(endpoint.trim())
      setModels(list)
      setConnected(true)
      if (list.length > 0 && !model) setModel(list[0])
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      setConnecting(false)
    }
  }

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Project Settings</h2>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <Card>
          <CardHeader><CardTitle>Project Info</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="pname">Project Name</Label>
              <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => save({ name })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="sl">Source Language</Label>
                <Input id="sl" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} onBlur={() => save({ sourceLanguage })} />
              </div>
              <div>
                <Label htmlFor="tl">Target Language</Label>
                <Input id="tl" value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} onBlur={() => save({ targetLanguage })} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>User</CardTitle></CardHeader>
          <CardContent>
            <Label htmlFor="un">Username</Label>
            <Input id="un" value={username} onChange={(e) => setUsername(e.target.value)} onBlur={() => save({ username })} placeholder="local" />
            <p className="mt-1 text-xs text-muted-foreground">Used as author name in translation history.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>LLM Completion</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ep">Endpoint URL</Label>
              <div className="flex gap-2">
                <Input id="ep" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://localhost:8000" className="flex-1" />
                <Button size="sm" onClick={handleConnect} disabled={connecting || !endpoint.trim()}>
                  {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
                </Button>
              </div>
              {connected && <p className="mt-1 flex items-center gap-1 text-xs text-green-600"><CheckCircle className="h-3 w-3" /> Connected — {models.length} model(s)</p>}
              {connectionError && <p className="mt-1 flex items-center gap-1 text-xs text-destructive"><XCircle className="h-3 w-3" /> {connectionError}</p>}
            </div>
            {models.length > 0 && (
              <div>
                <Label htmlFor="mdl">Model</Label>
                <select id="mdl" value={model} onChange={(e) => { setModel(e.target.value); saveCompletionSettings() }} className="w-full rounded border bg-background px-3 py-2 text-sm">
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="mt">Max Tokens</Label>
                <Input id="mt" type="number" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} onBlur={saveCompletionSettings} />
              </div>
              <div>
                <Label>Temperature ({temperature})</Label>
                <input type="range" min="0" max="1" step="0.05" value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} onMouseUp={saveCompletionSettings} className="mt-2 w-full" />
              </div>
            </div>
            <div>
              <Label htmlFor="sp">System Prompt</Label>
              <textarea id="sp" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} onBlur={saveCompletionSettings} rows={4} className="w-full rounded border bg-background px-3 py-2 text-sm" />
              <p className="mt-1 text-xs text-muted-foreground">Use {"{sourceLanguage}"} and {"{targetLanguage}"} as placeholders.</p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Build check**

```bash
npm run build
```

Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ProjectSettings.tsx
git commit -m "feat: add project settings page with LLM configuration"
```

---

### Task 7: Hooks — useSearchIndex + useCompletion

**Files:**
- Create: `src/hooks/useSearchIndex.ts`
- Create: `src/hooks/useCompletion.ts`

- [ ] **Step 1: Create useSearchIndex**

Create `src/hooks/useSearchIndex.ts`:

```typescript
import { useEffect, useRef, useCallback } from "react"
import { SearchIndex, type ScoredPair } from "@/lib/search/search-index"
import type { FileReference } from "@/lib/parsers/types"
import type { CellData } from "./useCells"

export function useSearchIndex(files: FileReference[], currentCells: CellData[]) {
  const indexRef = useRef(new SearchIndex())

  useEffect(() => {
    // For now, build from current file's cells only. The index can be extended
    // to load cells from all project files in a future iteration.
    if (currentCells.length > 0) {
      indexRef.current.buildFromProject([{ fileId: "current", cells: currentCells }])
    }
  }, [currentCells])

  const search = useCallback((query: string, limit?: number): ScoredPair[] => {
    return indexRef.current.search(query, limit)
  }, [])

  return { search, index: indexRef.current }
}
```

- [ ] **Step 2: Create useCompletion**

Create `src/hooks/useCompletion.ts`:

```typescript
import { useState, useCallback } from "react"
import * as Y from "yjs"
import type { CompletionSettings } from "@/lib/parsers/types"
import type { ScoredPair } from "@/lib/search/search-index"
import type { CellData } from "./useCells"
import { buildPrompt, complete, DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { appendCellHistory } from "./useCellHistory"

export function useCompletion(
  doc: Y.Doc | null,
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  search: (query: string, limit?: number) => ScoredPair[]
) {
  const [completing, setCompleting] = useState<Map<string, string>>(new Map())
  const [examples, setExamples] = useState<Map<string, ScoredPair[]>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())

  const isConfigured = Boolean(settings?.endpoint && settings?.model)

  const completeSingle = useCallback(async (cell: CellData) => {
    if (!doc || !settings || !isConfigured) return

    setCompleting((p) => new Map(p).set(cell.id, "searching"))

    const found = search(cell.original, 5)
    setExamples((p) => new Map(p).set(cell.id, found))
    setCompleting((p) => new Map(p).set(cell.id, "generating"))

    try {
      const messages = buildPrompt({
        sourceLanguage, targetLanguage,
        systemPrompt: settings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        sourceText: cell.original,
        examples: found.map((e) => ({ source: e.source, target: e.target })),
      })

      const result = await complete({
        endpoint: settings.endpoint, model: settings.model,
        messages, maxTokens: settings.maxTokens, temperature: settings.temperature,
        stream: true,
        onChunk: (text) => {
          const cells = doc.getMap("cells")
          const yCell = cells.get(cell.id) as Y.Map<unknown> | undefined
          if (yCell) doc.transact(() => { yCell.set("translated", text) })
        },
      })

      appendCellHistory(doc, cell.id, {
        value: result, source: "llm", author: settings.model,
        validated: false, examples: found.map((e) => e.cellId),
      })
      setCompleting((p) => new Map(p).set(cell.id, "done"))
    } catch (err) {
      setCompleting((p) => new Map(p).set(cell.id, "error"))
      setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
    }
  }, [doc, settings, isConfigured, sourceLanguage, targetLanguage, search])

  const completeBatch = useCallback(async (cells: CellData[]) => {
    if (!doc || !settings || !isConfigured) return

    // Search phase
    const allExamples = new Map<string, ScoredPair[]>()
    for (const cell of cells) {
      setCompleting((p) => new Map(p).set(cell.id, "searching"))
      allExamples.set(cell.id, search(cell.original, 5))
    }
    for (const cell of cells) {
      setExamples((p) => new Map(p).set(cell.id, allExamples.get(cell.id) || []))
      setCompleting((p) => new Map(p).set(cell.id, "generating"))
    }

    // Generate phase (concurrent, max 3)
    const queue = [...cells]
    async function worker() {
      while (queue.length > 0) {
        const cell = queue.shift()!
        const found = allExamples.get(cell.id) || []
        try {
          const messages = buildPrompt({
            sourceLanguage, targetLanguage,
            systemPrompt: settings!.systemPrompt || DEFAULT_SYSTEM_PROMPT,
            sourceText: cell.original,
            examples: found.map((e) => ({ source: e.source, target: e.target })),
          })
          const result = await complete({
            endpoint: settings!.endpoint, model: settings!.model,
            messages, maxTokens: settings!.maxTokens, temperature: settings!.temperature,
          })
          appendCellHistory(doc!, cell.id, {
            value: result, source: "llm", author: settings!.model,
            validated: false, examples: found.map((e) => e.cellId),
          })
          setCompleting((p) => new Map(p).set(cell.id, "done"))
        } catch (err) {
          setCompleting((p) => new Map(p).set(cell.id, "error"))
          setErrors((p) => new Map(p).set(cell.id, err instanceof Error ? err.message : "Failed"))
        }
      }
    }
    await Promise.all(Array.from({ length: 3 }, () => worker()))
  }, [doc, settings, isConfigured, sourceLanguage, targetLanguage, search])

  return { completeSingle, completeBatch, isConfigured, completing, examples, errors }
}
```

- [ ] **Step 3: Build check**

```bash
npm run build
```

Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSearchIndex.ts src/hooks/useCompletion.ts
git commit -m "feat: add useSearchIndex and useCompletion hooks"
```

---

### Task 8: UI Components — HighlightedText + ExamplePanel + SparkleButton

**Files:**
- Create: `src/components/HighlightedText.tsx`
- Create: `src/components/ExamplePanel.tsx`
- Create: `src/components/SparkleButton.tsx`

- [ ] **Step 1: Create HighlightedText**

Create `src/components/HighlightedText.tsx`:

```tsx
import { useMemo } from "react"

export const EXAMPLE_COLORS = [
  "#3b82f6", "#f97316", "#22c55e", "#a855f7",
  "#14b8a6", "#f43f5e", "#eab308", "#6366f1",
]

export interface TokenHighlight {
  token: string
  colorIndex: number
}

export function HighlightedText({ text, highlights }: { text: string; highlights: TokenHighlight[] }) {
  const highlightMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const h of highlights) map.set(h.token.toLowerCase(), h.colorIndex)
    return map
  }, [highlights])

  if (highlights.length === 0) return <span>{text}</span>

  const parts = text.split(/(\s+)/)
  return (
    <span>
      {parts.map((part, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>
        const token = part.toLowerCase().replace(/[^\w]/g, "")
        const colorIdx = highlightMap.get(token)
        if (colorIdx !== undefined) {
          const color = EXAMPLE_COLORS[colorIdx % EXAMPLE_COLORS.length]
          return (
            <mark key={i} style={{ backgroundColor: color + "30", borderBottom: `2px solid ${color}`, borderRadius: "2px" }}>
              {part}
            </mark>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

export function buildHighlightsFromExamples(
  examples: { matchedTokens: string[] }[],
  globalColorOffset = 0
): TokenHighlight[] {
  const highlights: TokenHighlight[] = []
  const seen = new Set<string>()
  for (let i = 0; i < examples.length; i++) {
    const colorIndex = (i + globalColorOffset) % EXAMPLE_COLORS.length
    for (const token of examples[i].matchedTokens) {
      const lower = token.toLowerCase()
      if (!seen.has(lower)) { seen.add(lower); highlights.push({ token: lower, colorIndex }) }
    }
  }
  return highlights
}
```

- [ ] **Step 2: Create ExamplePanel**

Create `src/components/ExamplePanel.tsx`:

```tsx
import { useState } from "react"
import { BookOpen, ChevronDown, ChevronRight } from "lucide-react"
import type { ScoredPair } from "@/lib/search/search-index"
import { HighlightedText, EXAMPLE_COLORS } from "./HighlightedText"
import { tokenizeText } from "@/lib/search/tokenizer"

export function ExamplePanel({ examples, globalColorOffset = 0 }: { examples: ScoredPair[]; globalColorOffset?: number }) {
  const [expanded, setExpanded] = useState(false)
  if (examples.length === 0) return null

  return (
    <div className="mt-1">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <BookOpen className="h-3 w-3" />
        {examples.length} example{examples.length !== 1 ? "s" : ""}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1.5 rounded border bg-muted/30 p-2">
          {examples.map((ex, i) => {
            const colorIndex = (i + globalColorOffset) % EXAMPLE_COLORS.length
            const sourceTokens = new Set(tokenizeText(ex.source))
            const matched = ex.matchedTokens.filter((t) => sourceTokens.has(t.toLowerCase()))
            return (
              <div key={ex.cellId} className="rounded border-l-2 bg-background p-2 text-xs" style={{ borderLeftColor: EXAMPLE_COLORS[colorIndex] }}>
                <div className="text-muted-foreground">
                  <HighlightedText text={ex.source} highlights={matched.map((t) => ({ token: t, colorIndex }))} />
                </div>
                <div className="mt-0.5 font-medium">{ex.target}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create SparkleButton**

Create `src/components/SparkleButton.tsx`:

```tsx
import { Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"

export function SparkleButton({ disabled, loading, onComplete, onDragStart, onDragEnter, tooltip }: {
  disabled?: boolean; loading?: boolean; onComplete: () => void
  onDragStart?: () => void; onDragEnter?: () => void; tooltip?: string
}) {
  return (
    <button
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded transition-colors",
        disabled ? "cursor-not-allowed text-muted-foreground/30" : "cursor-pointer text-muted-foreground hover:text-primary",
        loading && "animate-pulse text-primary"
      )}
      disabled={disabled}
      title={tooltip}
      onClick={(e) => { e.stopPropagation(); if (!disabled && !loading) onComplete() }}
      onMouseDown={(e) => { e.stopPropagation(); if (!disabled && !loading && onDragStart) onDragStart() }}
      onMouseEnter={() => { if (!disabled && !loading && onDragEnter) onDragEnter() }}
    >
      <Sparkles className="h-3.5 w-3.5" />
    </button>
  )
}
```

- [ ] **Step 4: Build check**

```bash
npm run build
```

Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/HighlightedText.tsx src/components/ExamplePanel.tsx src/components/SparkleButton.tsx
git commit -m "feat: add HighlightedText, ExamplePanel, and SparkleButton components"
```

---

### Task 9: EditorTable Rewrite + Full Integration

**Files:**
- Rewrite: `src/components/EditorTable.tsx`
- Rewrite: `src/components/ProjectWorkspace.tsx`
- Modify: `src/components/StatusBar.tsx`

- [ ] **Step 1: Rewrite EditorTable**

Replace `src/components/EditorTable.tsx` with the full implementation that includes:
- 3-column grid: sparkle button | source | target
- SparkleButton per row with drag-to-select batch behavior
- HighlightedText on source column when examples are present
- ExamplePanel below source text
- Validation checkmark for unvalidated cells, green check for validated
- Cell history tracking via `appendCellHistory` on user edits
- Error display for failed completions

Read the current file first, then replace entirely. The new EditorTable accepts additional props: `username`, `isCompletionConfigured`, `completing`, `examples`, `errors`, `onCompleteSingle`, `onCompleteBatch`.

The drag selection works via: `onMouseDown` on sparkle sets `isDragging = true` and initializes selection set, `onMouseEnter` on other sparkles adds to selection, `onMouseUp` on the container triggers batch completion if selection size > 1.

Use `appendCellHistory` from `@/hooks/useCellHistory` instead of direct Y.Doc writes for user edits, passing `source: "human"`, `validated: true`.

Use `validateCell` from `@/hooks/useCellHistory` for the checkmark button.

Security note: `dangerouslySetInnerHTML` is always guarded by `DOMPurify.sanitize()`. This is intentional defense-in-depth per the spec.

Full component code — see Task 9 in the first draft of this plan (the full EditorTable code with all features was provided there). Implement it matching that specification exactly.

- [ ] **Step 2: Rewrite ProjectWorkspace to wire everything**

Replace `src/components/ProjectWorkspace.tsx`:
- Use `useParams`/`useNavigate` from react-router-dom
- Add `useSearchIndex(project.files, cells)` 
- Add `useCompletion(doc, project.completionSettings, ...)` 
- Pass all new props to EditorTable

- [ ] **Step 3: Update StatusBar**

Replace `src/components/StatusBar.tsx` to show empty/unvalidated/validated counts:

```tsx
import type { CellData } from "@/hooks/useCells"

export function StatusBar({ cells }: { cells: CellData[] }) {
  const total = cells.length
  const empty = cells.filter((c) => c.status === "empty").length
  const unvalidated = cells.filter((c) => c.status === "unvalidated").length
  const validated = cells.filter((c) => c.status === "validated").length
  const translated = total - empty
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0

  return (
    <footer className="border-t px-4 py-1.5 text-sm text-muted-foreground">
      {total.toLocaleString()} cells · {translated} translated ({pct}%)
      {unvalidated > 0 && <span className="ml-2 text-amber-500">· {unvalidated} unvalidated</span>}
      {validated > 0 && <span className="ml-2 text-green-500">· {validated} validated</span>}
    </footer>
  )
}
```

- [ ] **Step 4: Run all tests + build**

```bash
npx vitest run && npm run build
```

Expected: All pass, clean build.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorTable.tsx src/components/ProjectWorkspace.tsx src/components/StatusBar.tsx
git commit -m "feat: integrate completion UI with sparkle button, examples, and validation"
```

---

## Summary

| Task | What it builds | Test type |
|------|---------------|-----------|
| 1 | Empty targets + extended types | Unit (54 updated) |
| 2 | Router + debug + settings stub | Build check |
| 3 | Tokenizer + search index | Unit (13 new) |
| 4 | Completion service | Unit (5 new) |
| 5 | Cell history + useCells update | Regression |
| 6 | Project settings page (full) | Manual |
| 7 | useSearchIndex + useCompletion | Build check |
| 8 | HighlightedText + ExamplePanel + SparkleButton | Build check |
| 9 | EditorTable rewrite + full integration | Manual E2E |

New automated tests: ~18. Total after: ~72.
