# Codex Web App — Milestone 6: Search & Back-translation

## Overview

Two focused features: cross-project cell search (`Cmd+K`) and word-for-word literal backtranslation to verify translation accuracy.

## User-Facing Search

### Trigger

- Keyboard shortcut: `Cmd+K` (Mac) / `Ctrl+K` (Windows/Linux)
- Search icon button in toolbar
- Only active when a project workspace is open

### Scope

Searches all cells across all files in the current project. Matches on:
- Source text (`original`)
- Target text (`translated`)
- Context label (e.g. "Genesis 3:15", "Slide 2")

### Workspace Index

Distinct from the completion `SearchIndex` (which only indexes translated pairs for LLM few-shot). The workspace index includes every cell regardless of status.

```typescript
interface WorkspaceSearchResult {
  cellId: string
  fileId: string
  fileName: string
  original: string
  translated: string
  context: string
  matchedTokens: string[]  // for highlighting in results
  score: number
}

class WorkspaceIndex {
  buildFromProject(files: { fileId: string; fileName: string; cells: ExportCell[] }[]): void
  search(query: string, limit?: number): WorkspaceSearchResult[]
}
```

Uses the existing `tokenizeText` function. Scoring is token overlap with IDF weighting (same as completion search). No branching needed — results are a flat list sorted by score.

### Lifecycle

Built lazily: index is empty until the user first opens the search dialog. `collectExportCells` per file to collect data. Invalidated whenever files change (new import, cell deletion). For live cell edits, we can skip updating the index until the dialog reopens — slight staleness is acceptable for search.

### UI

**SearchDialog** — ShadCN Dialog with:
- Input field (autofocused) at top
- Scrollable results list below
- Each result: file name, context label, source snippet (with matched tokens highlighted), target snippet
- Keyboard: ↑/↓ navigate, Enter to jump, Esc to close
- Empty states: "Type to search" (no query), "No matches" (no results)

**Navigation on click/Enter:**
1. Set `activeFileId` to the result's file
2. After file loads, scroll virtualizer to the result's cell index
3. Focus the cell's textarea if target, otherwise scroll and visually highlight

**Scroll-to-cell** via `useVirtualizer`'s `scrollToIndex(index, { align: "center" })`.

### Files

```
src/
├── lib/search/
│   └── workspace-index.ts           # NEW: WorkspaceIndex class
├── components/
│   ├── SearchDialog.tsx              # NEW: Cmd+K palette
│   └── EditorTable.tsx               # MODIFY: expose virtualizer + scrollToCell
└── hooks/
    └── useWorkspaceSearch.ts         # NEW: lazy index + search function
```

## Back-translation

### Purpose

Word-for-word literal backtranslation of target text into source language. Preserves structure even if unnatural. Helps translators verify what their translation actually says at a word level.

### Data Model

Two new fields on each cell's Y.Map:
- `backtranslation: string` — the backtranslation text
- `backtranslationUpdatedAt: string` — ISO timestamp of last generation
- `backtranslationForText: string` — the target text that was backtranslated (used to detect staleness)

Exposed on `CellData`:
```typescript
interface CellData {
  // existing fields...
  backtranslation?: string
  backtranslationUpdatedAt?: string
  backtranslationForText?: string
}
```

Staleness: if `backtranslationForText !== translated`, the backtranslation is stale (shown with a small warning indicator).

### Service

`src/lib/completion/backtranslation-service.ts`:

```typescript
export const BACKTRANSLATION_SYSTEM_PROMPT = `You are a backtranslation assistant. You will be given text in {targetLanguage} that is a translation. Your job is to provide a word-for-word, literal translation of that text BACK into {sourceLanguage}.

A backtranslation preserves the exact words and structure of the translated text, even if it sounds unnatural. For example, if the translation says "house of him", the backtranslation should say "house of him" — not "his house". This shows exactly what the translation says at a word level.

The purpose is verification: translators use backtranslations to confirm their translation conveys the intended meaning and doesn't drift.

Return ONLY the backtranslation text. No explanations, no markdown, no notes.`

export async function generateBacktranslation(options: {
  targetText: string
  sourceLanguage: string
  targetLanguage: string
  settings: CompletionSettings
  examples: { target: string; backtranslation: string }[]  // few-shot
  onChunk?: (text: string) => void
}): Promise<string>
```

Few-shot examples use `WorkspaceIndex` (or a dedicated lookup) to find cells with similar target text that already have backtranslations.

### Hook

`src/hooks/useBacktranslation.ts` — provides:
```typescript
function useBacktranslation(
  doc: Y.Doc | null,
  settings: CompletionSettings | undefined,
  sourceLanguage: string,
  targetLanguage: string,
  allCells: CellData[]  // for similar-example lookup
): {
  generate: (cell: CellData) => Promise<void>
  generating: Set<string>  // cellIds currently generating
  errors: Map<string, string>
}
```

Persists result via a new helper in `useCellHistory.ts`:
```typescript
export function setCellBacktranslation(
  doc: Y.Doc,
  cellId: string,
  backtranslation: string,
  forText: string
): void
```

### UI

**EditorRow**:
- New `Languages` icon button (lucide-react) in the validation column next to the checkmark
- Only enabled if LLM is configured AND target has content
- Click → calls `generate(cell)` → streams backtranslation into an inline section below the target textarea
- Loading state: icon spins/pulses

**Backtranslation display**:
- Appears below the target textarea when `cell.backtranslation` exists
- Muted italic text with small "↺" icon to regenerate
- If stale (`backtranslationForText !== translated`): small amber warning "Translation changed since backtranslation"
- Click the regenerate icon to re-run

### Files

```
src/
├── lib/completion/
│   └── backtranslation-service.ts    # NEW: generateBacktranslation
├── lib/store/
│   └── file-doc.ts                   # MODIFY: persist backtranslation fields
├── hooks/
│   ├── useCells.ts                   # MODIFY: expose backtranslation on CellData
│   ├── useCellHistory.ts             # MODIFY: setCellBacktranslation helper
│   └── useBacktranslation.ts         # NEW
└── components/
    └── EditorTable.tsx               # MODIFY: backtranslation button + display
```

## Not In Scope

- Bulk backtranslation (one cell at a time for M6)
- Editing backtranslations (M6 only generates; editing is manual through regeneration)
- Search within current file only mode (M6 is always project-wide)
- Search by metadata filters (severity, rule infractions, etc.)
