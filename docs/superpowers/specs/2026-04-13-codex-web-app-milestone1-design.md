# Codex Web App — Milestone 1: Import, View, Edit

## Overview

The first milestone of a web-based Codex Translation Editor. Users import source files, view aligned source/target content in a table, and edit translations in the browser. All data lives client-side in IndexedDB via Yjs CRDTs, ready for real-time multi-user collaboration in a future milestone.

## User Journey

1. **Dashboard** — user sees their project list, creates a new project by choosing a name and source/target language pair.
2. **Project workspace** — user enters a project. Imports files via drag-drop or file picker.
3. **Parsing** — parsers extract `TranslatableString[]` from the imported file. Each file (or Bible book, for USFM) becomes its own Yjs document.
4. **Sidebar navigation** — imported files appear in the sidebar. Click to load.
5. **Editor table** — virtualized rows of source (read-only) | target (editable plain text), bound to Yjs.
6. **Persistence** — edits auto-persist to IndexedDB via `y-indexeddb`. No save button.

## Architecture

### Two-Level App State

The app has two levels, managed by a simple `activeProjectId: string | null` state in `App.tsx`:

- `null` → render `Dashboard`
- `string` → render `ProjectWorkspace`

No client-side router needed for this milestone.

### Storage: Project Index

A plain JSON record in IndexedDB (not Yjs). One entry per project.

```typescript
interface ProjectRecord {
  id: string;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: string; // ISO date
  files: FileReference[];
  members: ProjectMember[]; // stubbed for future use
}

interface FileReference {
  id: string;
  name: string;
  type: FileType; // "md" | "docx" | "pptx" | "txt" | "vtt" | "srt" | "usfm"
  createdAt: string;
  cellCount: number;
}

interface ProjectMember {
  userId: string;
  role: string; // "owner" | "translator" | "reviewer"
}
```

CRUD operations via a thin wrapper around IndexedDB (`idb` library or raw API).

### Storage: Per-File Y.Doc

Each imported file gets its own `Y.Doc`, persisted via `y-indexeddb` using the key `codex:file:{fileId}`.

```
Y.Map("meta") → {
  fileId: string,
  fileName: string,
  fileType: FileType,
  sourceLanguage: string,
  targetLanguage: string
}

Y.Map("cells") → {
  [cellId: string]: Y.Map({
    id: string,
    original: string,
    originalHtml?: string,
    translated: string,
    context: string,
    group: string,
    type: string        // "text" | "heading" | "list" | "blockquote" | "cue" | "verse" | "paratext"
  })
}

Y.Array("order") → [cellId, cellId, ...]  // preserves sequence
```

`Y.Map("cells")` keyed by ID so individual cell edits don't conflict. `Y.Array("order")` separately tracks sequence. This is the standard Yjs pattern for ordered collections with independent item edits.

### Original File Storage

For formats that need original bytes to round-trip on export (DOCX, PPTX), the raw `ArrayBuffer` is stored as a Blob in IndexedDB keyed by `codex:original:{fileId}`. Not in the Y.Doc — binary blobs don't benefit from CRDT.

## Parsers

All parsers produce `TranslatableString[]`:

```typescript
interface TranslatableString {
  id: string;         // uuid
  original: string;   // source text
  originalHtml?: string; // styled HTML for display (sanitized via DOMPurify before rendering)
  translated: string; // initially same as original
  context: string;    // "Heading 1", "Slide 3", "Genesis 1:1", etc.
  group: string;      // uuid — segments sharing a group rejoin on export
}
```

### Text Splitter

Long strings are split into segments (~200 chars) at natural boundaries using a recursive splitter with ordered break points: paragraph → line → sentence → clause → comma → dash → word. Segments share a `group` ID for reassembly on export.

### Supported Formats

| Format | Extension(s) | Strategy |
|--------|-------------|----------|
| Markdown | `.md`, `.markdown` | Line-by-line: headings, list items, blockquotes, paragraphs. Inline styles (bold/italic/strikethrough/code) converted to HTML for `originalHtml`. |
| DOCX | `.docx` | JSZip to extract `word/document.xml`. Parse `<w:p>` paragraphs, detect styles (Heading1-3, Title, list). Extract run-level bold/italic/underline/strikethrough for `originalHtml`. |
| PPTX | `.pptx` | JSZip to extract `ppt/slides/slideN.xml`. Parse `<a:p>` paragraphs per slide. Run-level styles for `originalHtml`. Context = "Slide N". |
| Plain text | `.txt` | Split on double newlines (paragraphs), then segment. Context = "Paragraph". |
| VTT | `.vtt` | Parse cue blocks: timestamp line + text. Each cue = one cell. Timestamps stored in cell metadata. Context = "Cue N" or timestamp range. |
| SRT | `.srt` | Parse numbered cue blocks: index, timestamp, text. Same treatment as VTT. |
| USFM/SFM | `.usfm`, `.sfm` | Parse USFM markers. `\id` splits books (each book = separate Y.Doc). If no `\id` marker, treat entire file as one document. `\c` = chapter, `\v` = verse, `\s` = section heading, `\p` = paragraph marker. Context = "Book Chapter:Verse" (e.g. "Genesis 1:1"). Paratext markers (`\mt`, `\ms`, `\r`, etc.) become paratext-type cells. |

### Import Flow

1. User drops file(s) or picks via dialog.
2. Detect type by extension.
3. Parse into `TranslatableString[]`. For USFM, split by `\id` into multiple arrays (one per book).
4. For each resulting file:
   a. Create `Y.Doc`, populate `meta`, `cells`, `order`.
   b. Persist via `y-indexeddb`.
   c. If DOCX/PPTX, store original `ArrayBuffer` in IndexedDB.
   d. Add `FileReference` to project index.
5. Navigate to the first imported file.

## Security

### HTML Sanitization

`originalHtml` fields contain parser-generated HTML for styled source display (bold, italic, etc.). Before rendering, all HTML is sanitized via DOMPurify to prevent XSS. The parsers themselves only generate a safe subset of tags (`<b>`, `<i>`, `<u>`, `<s>`, `<code>`), but sanitization at the render boundary provides defense in depth.

## UI Components

### Dashboard

```
┌──────────────────────────────────────────────────┐
│  Codex Translator              [+ New Project]   │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌─────────────┐  ┌─────────────┐               │
│  │ Project A   │  │ Project B   │               │
│  │ EN → FR     │  │ EN → SW     │               │
│  │ 12 files    │  │ 3 files     │               │
│  │ [Members]   │  │ [Members]   │               │
│  └─────────────┘  └─────────────┘               │
│                                                  │
└──────────────────────────────────────────────────┘
```

- `Dashboard.tsx` — grid of `ProjectCard` components
- `ProjectCard.tsx` — name, language pair, file count, stubbed members badge
- `ProjectCreateDialog.tsx` — ShadCN dialog: name input, source language, target language

### Project Workspace

```
┌─────────────────────────────────────────────────┐
│  Toolbar: [< Back] Project Name  EN → FR  [+]  │
├──────────┬──────────────────────────────────────┤
│ Sidebar  │  EditorTable                         │
│          │  ┌──────────┬───────────────┐        │
│ Files:   │  │ Source   │ Target        │        │
│ > Gen    │  ├──────────┼───────────────┤        │
│   Exo    │  │ In the   │ [Au commencem │        │
│   Lev    │  │ beginning │ ent          ]│        │
│   ...    │  │ God      │ [Dieu        ]│        │
│          │  │ created  │ [crea        ]│        │
│ report.  │  │ ...      │ ...           │        │
│ docx     │  └──────────┴───────────────┘        │
├──────────┴──────────────────────────────────────┤
│  Status: 1,533 cells · 42% translated           │
└─────────────────────────────────────────────────┘
```

- `ProjectWorkspace.tsx` — shell: toolbar + sidebar + editor area
- `Toolbar.tsx` — back button, project name, language labels, import button
- `ProjectSidebar.tsx` — file list from project index, click to switch active file
- `EditorTable.tsx` — virtualized with `@tanstack/react-virtual`. Each row:
  - Source column: `<div>` rendering `original` text, or sanitized `originalHtml` via DOMPurify
  - Target column: `<textarea>` bound to `Y.Map` cell's `translated` field via Yjs `observeDeep`
  - Context shown as a subtle label (e.g., "Genesis 1:1" or "Heading 2")
- `ImportDialog.tsx` — drag-drop zone + file picker, shows progress during parse
- `StatusBar.tsx` — total cells, translated count (cells where `translated !== original`), percentage

### Virtualization

Bible books can have 1,000+ verses. `@tanstack/react-virtual` renders only visible rows. Estimated row height with dynamic measurement for cells with varying text length.

## Yjs Integration

### Hook: `useFileDoc(fileId: string)`

```typescript
// Loads or creates Y.Doc for a file, attaches y-indexeddb provider
// Returns: { doc, meta, cells, order, loading }
```

### Hook: `useCells(doc: Y.Doc)`

```typescript
// Subscribes to cells map + order array via observeDeep
// Returns: CellData[] in order, re-renders on any cell change
```

### Cell Editing

Each `<textarea>` `onChange`:
1. Get the cell's `Y.Map` from `cells`
2. `cell.set("translated", newValue)` inside `doc.transact()`
3. Yjs handles persistence to IndexedDB automatically

No debounce needed — Yjs batches transactions efficiently, and `y-indexeddb` writes are already debounced internally.

## Directory Structure

```
src/
├── main.tsx
├── App.tsx                        # activeProjectId state machine
├── lib/
│   ├── parsers/
│   │   ├── types.ts               # TranslatableString, FileType, detectFileType
│   │   ├── markdown.ts            # extractMarkdownStrings, rebuildMarkdown
│   │   ├── docx.ts                # extractDocxStrings, rebuildDocx
│   │   ├── pptx.ts                # extractPptxStrings, rebuildPptx
│   │   ├── plaintext.ts           # extractPlaintextStrings
│   │   ├── subtitle.ts            # extractVttStrings, extractSrtStrings
│   │   ├── usfm.ts                # extractUsfmStrings (splits by book)
│   │   └── text-splitter.ts       # splitIntoSegments, mergeSegments
│   ├── store/
│   │   ├── project-index.ts       # IndexedDB CRUD for ProjectRecord[]
│   │   └── file-doc.ts            # Y.Doc lifecycle: create, load, hydrate, destroy
│   └── utils.ts
├── components/
│   ├── Dashboard.tsx
│   ├── ProjectCard.tsx
│   ├── ProjectCreateDialog.tsx
│   ├── ProjectWorkspace.tsx
│   ├── ProjectSidebar.tsx
│   ├── EditorTable.tsx
│   ├── ImportDialog.tsx
│   ├── Toolbar.tsx
│   └── StatusBar.tsx
└── hooks/
    ├── useProject.ts              # Load project record, file list
    ├── useFileDoc.ts              # Y.Doc loading + y-indexeddb provider
    └── useCells.ts                # Subscribe to cells for rendering
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `vite` | Build tool |
| `react`, `react-dom` | UI framework |
| `typescript` | Type safety |
| `yjs` | CRDT document model |
| `y-indexeddb` | Yjs persistence to IndexedDB |
| `@tanstack/react-virtual` | Row virtualization for large cell lists |
| `tailwindcss` | Utility CSS (required by ShadCN) |
| `shadcn/ui` | Component library (Button, Card, Dialog, Input, Table, etc.) |
| `jszip` | DOCX/PPTX parsing |
| `uuid` | Cell and group IDs |
| `dompurify` | HTML sanitization for `originalHtml` rendering |

## Not In Scope

These are explicitly deferred to future milestones:

- Rich text editing (Quill / `y-quill`)
- Audio / video / timeline
- LLM completion / batch translation / backtranslation
- Validation workflows
- Multi-user real-time sync (WebSocket/WebRTC provider)
- Export / rebuild to original format
- Full-text search / indexing
- Authentication (Frontier API integration)
- Server-side anything
