# Editor QoL: Line Numbers, Cell Labels, RTL, Corpus Grouping, File Route

**Date:** 2026-04-16
**Status:** Draft

## Goal

Bring four quality-of-life improvements to the codex-web-app editor, mirroring the conventions already established in the codex-editor VS Code extension (`/Users/ryderwishart/frontierrnd/codex-editor`):

1. **Line numbers** in a muted gutter, toggled via a view-settings menu.
2. **Cell labels** rendered next to each cell when present (`cell.metadata.cellLabel` from the codex source).
3. **Text direction (LTR/RTL)** toggle, with auto-detection from the project's target language and metadata override.
4. **Corpus grouping** of files in the project sidebar (mirrors `navigationWebviewProvider.groupByCorpus`).
5. **File ID in the URL route** so refresh keeps the active file open.

## Non-goals

- Editing `cellLabel` from the web app (read-only for now; desktop owns the editing UX).
- Editing `corpusMarker` from the web app.
- Per-line-number generation logic for biblical content (chapter-based verse numbers, child-cell `parent.N` syntax). v1 uses simple row index; that can land later if needed.
- Persisting `cellLabelsEnabled` to file metadata (web-only `localStorage` setting; desktop has no equivalent).

## Reference: how the desktop app does this

| Concern | Desktop reference |
|---|---|
| Line numbers display | `CellContentDisplay.tsx:742-756` — muted gutter, `var(--vscode-descriptionForeground)`, right-aligned, `0.9em`, `minWidth: 1.6ch` |
| Line numbers toggle | `ChapterNavigationHeader.tsx:937-968` — dropdown item writes `metadata.lineNumbersEnabled` (boolean) and calls `updateNotebookMetadata` |
| Cell label data shape | `cell.metadata.cellLabel?: string` — semantic label like `"5:12"`, `"Narrator"`, `"Jesus"` (`types/index.d.ts:85`) |
| Cell label display | Always shown when present, separate from line number; rendered via `<CellLabelText label={cellLabel} />` |
| Text direction toggle | `ChapterNavigationHeader.tsx:859-868` — dropdown item flips `notebook.metadata.textDirection: "ltr" \| "rtl"` |
| Corpus grouping | `navigationWebviewProvider.ts:640-741` — group by `metadata.corpusMarker`, fall back to OT/NT testament from Bible-book map; sort OT, NT, alphabetical, then ungrouped last |

## Design

### 1. Surface `cellLabel` from Y.Doc (`useCells.ts`)

Add `cellLabel?: string` to `CellData`. Read it from the cell's `__source.metadata.cellLabel`, which is already stashed during import (`git-importer.ts:166-169`). For non-codex sources (md/docx/etc.) the field is undefined.

```ts
const source = cell.get("__source") as { metadata?: { cellLabel?: string } } | undefined
const cellLabel = source?.metadata?.cellLabel || undefined
```

### 2. New `useFileMeta(doc)` hook

Reactive read/write helper for the file-level meta map (`doc.getMap("meta")`). Returns:

```ts
interface FileMeta {
  lineNumbersEnabled: boolean      // default: true
  textDirection: "ltr" | "rtl"     // see seed logic below
  setLineNumbersEnabled: (v: boolean) => void
  setTextDirection: (v: "ltr" | "rtl") => void
}
```

**Storage layout:** stored on `meta.__source` (already the canonical place for codex notebook metadata, see `file-doc.ts:240`):

- `meta.__source.lineNumbersEnabled: boolean`
- `meta.__source.textDirection: "ltr" | "rtl"`

Writes mutate `__source` in a single Y transaction so the serializer round-trips correctly.

**Auto-seeding text direction:**

On first observation, if `textDirection` is unset, derive from the project's `targetLanguage` and write it back (so subsequent edits are user overrides):

```ts
const RTL_LANGS = new Set(["ar", "arc", "dv", "fa", "ha", "he", "khw", "ks", "ku", "ps", "sd", "ur", "yi"])
function detectDirection(lang?: string): "ltr" | "rtl" {
  const code = (lang || "").toLowerCase().split(/[-_]/)[0]
  return RTL_LANGS.has(code) ? "rtl" : "ltr"
}
```

The hook accepts `targetLanguage` as a parameter so it can seed without re-reading project state.

### 3. New `ViewSettingsMenu` component

Placed in `Toolbar.tsx` between the `Search` button and `Share` button. Uses `@base-ui/react/menu` (already in dependencies; matches the dialog primitive pattern). Trigger is a small eye-icon ghost button (`lucide-react` `Eye`).

Three menu items, in this order (matches desktop grouping):

1. **Show line numbers** — toggles `meta.__source.lineNumbersEnabled`. Active state shown as a small "On"/"Off" pill.
2. **Show cell labels** — toggles `localStorage["codex:cellLabels:" + projectId]`. Default `true`.
3. **Text Direction (LTR/RTL)** — toggles `meta.__source.textDirection`.

The menu trigger is always visible; items 1 and 3 (file-scoped) are disabled when no file is open. Item 2 (project-scoped) stays enabled.

### 4. `EditorTable` row layout changes

Current grid: `[24px _ 1fr_1fr]` (`EditorTable.tsx:94`).

New grid: `[gutter _ 1fr_1fr]` where `gutter` is computed:
- `48px` if line numbers OR cell labels visible
- `24px` otherwise (preserve current spacing)

Inside the gutter, render a small vertical stack:
- Line number badge (top): `text-xs text-muted-foreground tabular-nums` — index+1, hidden when `cell.type === "paratext"` per desktop convention
- Cell label badge (below): `text-xs text-muted-foreground bg-muted/40 px-1 rounded`, only when `cell.cellLabel` present and `cellLabelsEnabled`

Apply `dir={textDirection}` to the **target** column wrapper only. Source column keeps its native direction (often the source language has different directionality from the target).

### 5. Corpus grouping in `ProjectSidebar`

**Data flow:** corpus marker per file is needed at sidebar render time. Options considered:

- **(A)** Open every file's Y.Doc on sidebar mount — simple but loads all docs eagerly.
- **(B)** Cache `corpusMarker` on `FileReference` itself — populated at import time, mutated when the user edits in desktop and we sync.
- **(C)** Read from a sidecar map on the project record.

**Chosen: B.** Reasons:
- Import already reads notebook metadata (`git-importer.ts:128-130`); adding `corpusMarker` to the `FileReference` push is one line.
- `FileReference` is already loaded with the project — no extra IO at render time.
- Stale-after-sync risk is low: corpus marker rarely changes, and a follow-up could refresh from `meta.__source` after a sync. Out of scope for v1.

**Schema change:**
```ts
// src/lib/parsers/types.ts
export interface FileReference {
  id: string
  name: string
  type: FileType
  createdAt: string
  cellCount: number
  corpusMarker?: string   // NEW — from notebook metadata.corpusMarker, or OT/NT fallback
}
```

**Bible-book → testament map:** small static map in `src/lib/codex-editor/bible-books.ts` (~66 entries). Keys are 3-letter abbreviations (`GEN`, `MAT`, etc.); values are `"OT"` or `"NT"`. Used during import as the fallback when `metadata.corpusMarker` is unset and the file stem matches a known book.

**Backfill for existing projects:** add a one-shot migration that runs in `useProject` — for any file with no `corpusMarker`, open its Y.Doc, read `meta.__source.corpusMarker`, write back to `FileReference` via `updateProject`. Runs in the background; sidebar shows the file ungrouped until the read completes. (Migration is best-effort; failures are silent.)

**`groupByCorpus` helper:** new `src/lib/sidebar/group-by-corpus.ts`. Mirrors `navigationWebviewProvider.ts:640-741`:

```ts
interface CorpusGroup {
  label: string                    // "OT" | "NT" | corpus name | "Ungrouped"
  files: FileReference[]
}

function groupByCorpus(files: FileReference[], bookMap: Map<string, "OT" | "NT">): CorpusGroup[]
```

Normalize markers via trim + lowercase compare so `"subtitle"` and `"Subtitle"` group together (matches desktop's `normalizeCorpusMarker` behavior). Sort: `OT` first, then `NT`, then named groups alphabetically, then `Ungrouped` last.

**Sidebar UI:** replace the flat `<ul>` in `ProjectSidebar.tsx:43-94` with a list of `<details>` sections (one per corpus group), each defaulting to `open`. The "Ungrouped" group renders without a header if there are no other groups (preserves current look for projects with no corpus markers).

### 6. URL route for active file

**Route:** add `/project/:id/file/:fileId` alongside the existing `/project/:id` route in `App.tsx:33-47`.

**Wiring in `ProjectWorkspace.tsx`:**
- Replace `useState<string | null>(null)` for `activeFileId` with derivation from `useParams<{ fileId?: string }>()`.
- `setActiveFileId(id)` becomes `navigate(\`/project/${projectId}/file/${id}\`)` (uses `replace: false` so back button works).
- A `null` fileId (the bare `/project/:id` route) keeps current behavior — no file open, sidebar hint shown.
- Validation: if `fileId` from URL doesn't exist in `project.files`, fall back to `null` and `replace` the URL to `/project/:id` so refresh after a delete doesn't 404.

**Other routes unchanged:** `/settings`, `/rules`, `/comments`, `/snapshots` keep their existing shape. They don't need a fileId because they're project-scoped.

## Files touched

**New:**
- `src/hooks/useFileMeta.ts`
- `src/components/ViewSettingsMenu.tsx`
- `src/components/ui/dropdown-menu.tsx` (base-ui menu wrapper, only if needed; could colocate in `ViewSettingsMenu.tsx`)
- `src/lib/codex-editor/bible-books.ts`
- `src/lib/sidebar/group-by-corpus.ts`
- Tests for each of the above.

**Modified:**
- `src/hooks/useCells.ts` — add `cellLabel`
- `src/lib/parsers/types.ts` — add `corpusMarker` to `FileReference`
- `src/lib/importer/git-importer.ts` — populate `corpusMarker` on `FileReference` push (~line 235-241)
- `src/components/EditorTable.tsx` — gutter, line numbers, cell labels, `dir` attribute
- `src/components/ProjectSidebar.tsx` — corpus grouping
- `src/components/Toolbar.tsx` — add `ViewSettingsMenu`
- `src/components/ProjectWorkspace.tsx` — `activeFileId` ⇄ URL params; pass `fileMeta` to `Toolbar` and `EditorTable`
- `src/App.tsx` — new route
- `src/hooks/useProject.ts` — opportunistic corpusMarker backfill (or a separate hook)

## Testing

- **`useFileMeta`** — unit test: defaults, RTL auto-detect for `ar`/`he`/`fa`, override persistence, no re-seed when value already set.
- **`group-by-corpus`** — unit test: OT/NT ordering, alphabetical named groups, normalization of casing/whitespace, Ungrouped last, empty input.
- **`useCells`** — extend existing tests to assert `cellLabel` propagation from `__source.metadata.cellLabel`.
- **`git-importer`** — assert `corpusMarker` populated on `FileReference` from notebook metadata, and from OT/NT fallback for biblical book stems.
- **Routing** — manual smoke: open file, refresh, verify file reopens; navigate to invalid fileId, verify graceful fallback.
- **EditorTable** — visual smoke (no test infra for that here): line number gutter shows/hides; cell labels show when present; `dir="rtl"` applied to target column for Arabic project.

## Open questions / deferrals

- **Per-cell text direction.** Some cells may need a different direction than the file (e.g. Latin loanword in an Arabic translation). Desktop doesn't support this; we'll defer.
- **Corpus marker editing.** Future work; desktop has it (`navigationWebviewProvider.editCorpusMarker`).
- **Chapter-based verse numbers for line numbers.** Desktop's `generateLineNumber` (`CellList.tsx:569`) is rich. v1 uses row index. Revisit if users complain.
