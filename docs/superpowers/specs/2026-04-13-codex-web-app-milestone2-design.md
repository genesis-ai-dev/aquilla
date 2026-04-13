# Codex Web App — Milestone 2: Empty Targets, Search, LLM Completions, Settings

## Overview

Milestone 2 adds LLM-powered translation completions, a search index for finding translation examples, cell history with validation tracking, project settings, proper client-side routing, and debug routes. Target cells start empty (not pre-filled with source).

## Changes from Milestone 1

### Empty Target Cells

All parsers change from `translated = original` to `translated = ""`. The status bar already uses `translated !== original` to count translated cells — with empty strings this naturally means "cells with any content." The EditorTable textarea rows calculation continues to use `original.length` for sizing.

### Client-Side Router

Add `react-router-dom` with routes:

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `Dashboard` | Project list |
| `/project/:id` | `ProjectWorkspace` | Editor workspace |
| `/project/:id/settings` | `ProjectSettings` | Project configuration |
| `/debug` | `DebugView` | Dashboard state as JSON |
| `/project/:id/debug` | `DebugView` | Project state as JSON |
| `/project/:id/settings/debug` | `DebugView` | Settings state as JSON |

Replace the `activeProjectId` state machine in `App.tsx` with `<BrowserRouter>` + `<Routes>`. Navigation uses `useNavigate()`. The toolbar gets a settings gear icon (lucide-react `Settings` icon).

### Debug Routes

Any route with `/debug` appended renders a `DebugView` component that serializes the relevant state to JSON. This enables programmatic testing of application state regardless of UI.

- `/debug` — `{ projects: ProjectRecord[] }`
- `/project/:id/debug` — `{ project: ProjectRecord, files: FileReference[], activeFileId, cells: CellData[] }`
- `/project/:id/settings/debug` — `{ project: ProjectRecord, completionSettings: CompletionSettings }`

The `DebugView` renders a `<pre>` with `JSON.stringify(state, null, 2)` — raw, machine-readable, no UI chrome.

## Cell History & Validation

### Data Model

Each cell in the Y.Doc gains a `history` field stored as a `Y.Array` inside the cell's `Y.Map`:

```typescript
interface CellHistoryEntry {
  timestamp: string       // ISO date
  value: string           // the translated text at this point
  source: "human" | "llm" // who made the edit
  author: string          // username or model name (e.g. "gemma-4-26B")
  validated: boolean      // true if explicitly approved or human-authored
  examples?: string[]     // cellIds of examples used (LLM completions only)
}
```

### Cell States

A cell can be in one of three states, derived from its history:

- **Empty** — no translation (`translated === ""`, no history entries)
- **Unvalidated** — last history entry has `validated: false` (LLM-generated, no human approval)
- **Validated** — last history entry has `validated: true` (human-edited or explicitly approved)

Rules:
- When a human types or edits `translated`, a history entry is appended with `source: "human"`, `validated: true`, and `author` set to the project's configured username.
- When the LLM fills `translated`, a history entry is appended with `source: "llm"`, `validated: false`, and `author` set to the model name.
- When a user clicks the validate checkmark on an LLM-generated cell, a new history entry is appended with `source: "human"`, `validated: true`, copying the current `translated` value.

### UI Indicators

Each cell row shows a small status indicator:
- Empty: no indicator
- Unvalidated (LLM draft): yellow/amber dot or icon
- Validated: green checkmark icon

For unvalidated cells, a checkmark button appears that the user clicks to validate.

### Yjs Storage

```
Y.Map("cells") → {
  [cellId: string]: Y.Map({
    id: string,
    original: string,
    originalHtml?: string,
    translated: string,
    context: string,
    group: string,
    type: string,
    history: Y.Array<CellHistoryEntry>   // NEW
  })
}
```

The `translated` field remains the current value for quick access and rendering. The `history` Y.Array is the audit trail. History entries are append-only (never modified or deleted).

## Search Index

### Approach

Adapt the context-branching search algorithm from the Codex Editor for client-side use. Instead of SQLite FTS, use an in-memory token-overlap index built from translated cells in the current project.

### SearchIndex Class

```typescript
interface TranslationPair {
  cellId: string
  source: string
  target: string
  fileId: string
}

interface ScoredPair extends TranslationPair {
  score: number
  matchedTokens: string[]       // tokens from query that matched this pair
  coverageRanges: [number, number][]  // character ranges in source that were covered
}

class SearchIndex {
  private pairs: { cellId: string; source: string; target: string; fileId: string; tokens: Set<string> }[]

  // Build from all translated cells across all files in the project
  buildFromProject(projectFiles: { fileId: string; cells: CellData[] }[]): void

  // Add a single pair (when user translates a cell)
  addPair(cellId: string, source: string, target: string, fileId: string): void

  // Remove a pair (when user clears a cell)
  removePair(cellId: string): void

  // Context-branching search
  search(query: string, limit?: number): ScoredPair[]
}
```

### Tokenizer

Same as the reference implementation:
- Lowercase
- Strip HTML tags
- Strip punctuation
- Split on whitespace
- Filter empty strings

### Scoring

Base score: `matchingTokens.size / queryTokens.size` (token overlap ratio).

Coverage boost: `baseScore * (1 + 0.5 * coverage)` where coverage is `matchingTokens.size / queryTokens.size`.

### Branching Logic

Same as the reference `ContextBranchingSearchAlgorithm`:
1. Start with the query as a single branch
2. Find the highest-scoring pair across all branches
3. Add it to results
4. Find the longest covered substring in the chosen branch
5. Remove that substring, splitting the branch into new branches
6. Repeat until `limit` results found or branches exhausted
7. Up to 2 restarts with the original query if branches are exhausted early

Parameters: `candidatesPerBranch = max(limit * 30, 150)`, `maxRestarts = 2`, `maxBranches = 12`, `coverageWeight = 0.5`.

### Index Lifecycle

- **Built** when entering a project workspace — collects all translated cells across all project files
- **Incrementally updated** as the user translates cells (add/update pair) or clears cells (remove pair)
- **Destroyed** when leaving the project workspace
- Future extension point: merge in pairs from a server-configured organization-level corpus

### Hook: `useSearchIndex`

```typescript
function useSearchIndex(projectId: string, files: FileReference[]): {
  index: SearchIndex | null
  loading: boolean
  search: (query: string, limit?: number) => ScoredPair[]
}
```

Builds the index from all project files on mount. Exposes a `search` function. The index updates when cells change (listens for Yjs changes on translated fields).

## LLM Completions

### Completion Settings

```typescript
interface CompletionSettings {
  endpoint: string        // e.g. "http://localhost:8000"
  model: string           // e.g. "gemma-4-26B"
  maxTokens: number       // default 512
  temperature: number     // default 0.3
  systemPrompt: string    // customizable default
}
```

Stored in `ProjectRecord.completionSettings` (optional field). Persisted to IndexedDB with the project.

### Default System Prompt

```
You are a translation assistant. Translate from {sourceLanguage} to {targetLanguage}. Output ONLY the translation, nothing else. Do not include explanations, notes, or the original text.
```

### Prompt Construction

For each cell being translated:

```
System: [configured system prompt]

User:
Source: {example1.source}
Translation: {example1.target}

Source: {example2.source}
Translation: {example2.target}

Source: {cellToTranslate.original}
Translation:
```

Examples are ordered by search score (best first). Number of examples is limited by token budget — pack as many as fit within `maxTokens * 2` estimated input tokens (rough heuristic: 4 chars per token).

### Single Cell Completion

1. Search for examples using `index.search(cell.original, 5)`
2. Build prompt with examples
3. Call `POST {endpoint}/v1/chat/completions` with `stream: true`
4. Stream response into `cell.translated` via Yjs transact
5. Append history entry: `{ source: "llm", author: model, validated: false, examples: [matchedCellIds] }`

### Batch Completion

1. User selects cells via click-and-drag on sparkle icons
2. Search runs once for all selected cells — collect all source texts, run searches, deduplicate example pairs across the batch
3. Fire completion requests concurrently (max 3 concurrent)
4. Each cell fills in independently as its response completes
5. Each cell gets its own history entry with its specific examples

### Error Handling

- If endpoint is not configured: sparkle button is disabled, tooltip says "Configure LLM in settings"
- If request fails: show error inline on the cell (red text below textarea), don't modify translated
- If endpoint returns non-200: show the error message
- Network timeout: 30 seconds per request

## Completion UX

### Sparkle Button

- Each cell row has a sparkle icon (lucide-react `Sparkles`) on the left edge of the target column
- If no completion settings configured: icon is grayed out, tooltip explains
- **Single click:** complete just this cell
- **Click and drag down:** highlights cells in the drag range, completes all on mouse release
- During completion: icon animates (pulse via CSS animation)

### Live Search Highlighting

When completion is triggered (single or batch):

1. Search runs for examples (in-memory, typically <10ms)
2. Results render immediately: the source cell's text gets color highlights showing which tokens were matched by which example
3. Colors come from a rotating palette of 8 visually distinct, accessible colors
4. For batch completions, all cells in the batch show their search highlights at once before LLM requests fire
5. Then the LLM request fires and target cell fills in

### Example Panel

After completion, each completed cell shows an expandable badge: "N examples" (lucide-react `BookOpen` icon + count).

Expanding reveals:
- Each example as a source/target pair card
- Each example assigned a color from the rotating palette: `palette[index % 8]`
- In the **source cell text**: matched token spans highlighted in the example's color
- In the **example card**: the corresponding matched portions highlighted in the same color
- Multiple examples can have overlapping highlights — later colors render on top

### Color Palette

8 rotating colors, chosen for visual distinction and accessibility:

```typescript
const EXAMPLE_COLORS = [
  "#3b82f6", // blue
  "#f97316", // orange
  "#22c55e", // green
  "#a855f7", // purple
  "#14b8a6", // teal
  "#f43f5e", // rose
  "#eab308", // yellow
  "#6366f1", // indigo
]
```

### Batch Color Consistency

For a batch completion, examples are assigned colors globally across all cells in the batch. If cells A, B, and C all used example X, example X is the same color everywhere.

## Project Settings View

### Route

`/project/:id/settings`

### Layout

Same toolbar as workspace (back arrow navigates to `/project/:id`). Settings form in a centered, max-width card layout.

### Sections

**1. Project Info**
- Project name (text input)
- Source language (text input)
- Target language (text input)

**2. User**
- Username (text input) — used as `author` in cell history entries. Default: "local"

**3. LLM Completion**
- Endpoint URL (text input) — e.g. `http://localhost:8000`
- "Connect" button — calls `GET {endpoint}/v1/models`
  - On success: green "Connected" badge, populates model dropdown with model IDs
  - On failure: red error message
- Model (dropdown) — populated after successful connect
- Max tokens (number input, default 512)
- Temperature (slider 0.0-1.0, default 0.3)
- System prompt (textarea, pre-filled with default)

### Persistence

Settings saved to `ProjectRecord` in IndexedDB. Auto-save on field blur or selection change — no save button. Mirrors the editor's auto-save philosophy.

### Extended ProjectRecord

```typescript
interface ProjectRecord {
  // ... existing fields ...
  completionSettings?: CompletionSettings
  username?: string       // default "local"
}
```

## Directory Structure (New/Modified Files)

```
src/
├── App.tsx                           # MODIFY: react-router-dom routes
├── lib/
│   ├── parsers/
│   │   ├── plaintext.ts             # MODIFY: translated = ""
│   │   ├── markdown.ts              # MODIFY: translated = ""
│   │   ├── subtitle.ts             # MODIFY: translated = ""
│   │   ├── usfm.ts                  # MODIFY: translated = ""
│   │   ├── docx.ts                  # MODIFY: translated = ""
│   │   ├── pptx.ts                  # MODIFY: translated = ""
│   │   └── types.ts                 # MODIFY: add CompletionSettings, CellHistoryEntry
│   ├── search/
│   │   ├── tokenizer.ts             # tokenizeText utility
│   │   ├── search-index.ts          # SearchIndex class
│   │   └── search-index.test.ts     # TDD tests
│   └── completion/
│       ├── completion-service.ts    # LLM API calls, prompt construction
│       └── completion-service.test.ts
├── components/
│   ├── EditorTable.tsx              # MODIFY: sparkle button, example panel, highlights
│   ├── ProjectWorkspace.tsx         # MODIFY: search index integration
│   ├── ProjectSettings.tsx          # NEW: settings form
│   ├── DebugView.tsx                # NEW: JSON state viewer
│   ├── ExamplePanel.tsx             # NEW: expandable example viewer with highlights
│   ├── HighlightedText.tsx          # NEW: text with colored token highlights
│   └── SparkleButton.tsx            # NEW: completion trigger with drag behavior
├── hooks/
│   ├── useSearchIndex.ts            # NEW: search index lifecycle
│   ├── useCompletion.ts             # NEW: single + batch completion
│   └── useCellHistory.ts            # NEW: history tracking for cell edits
└── ...
```

## Dependencies (New)

| Package | Purpose |
|---------|---------|
| `react-router-dom` | Client-side routing |

No other new dependencies needed — vLLM calls use `fetch`, search is in-memory, icons come from `lucide-react` (already bundled with ShadCN).

## Not In Scope

- Rich text editing
- Cross-project search corpus
- Server-side organization-level translation pairs API
- Authentication / user management
- Export / rebuild to original format
- Audio / video / timeline
- Undo/redo on cell history
