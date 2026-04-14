# Codex Web App — Milestone 5: Export

## Overview

Close the round-trip: export translated cells back to their original file format. Two strategies depending on available source data:

1. **Surgical export** (DOCX, PPTX): use stored original ArrayBuffer + position metadata captured at import time, swap text content block-by-block, preserve all non-text structure (images, tables, styles, layout).
2. **Reconstruct export** (TXT, MD, VTT, SRT, USFM): rebuild format from cell data directly.

Both fall back gracefully. Untranslated cells fall back to original text.

## Position Metadata

Extend `TranslatableString` with an optional source location captured at parse time:

```typescript
interface SourceLocation {
  file: string       // e.g. "word/document.xml", "ppt/slides/slide3.xml"
  blockPath: string  // indexed path to the block element, e.g. "w:p[2]"
}

interface TranslatableString {
  // existing fields...
  sourceLocation?: SourceLocation
}
```

**Block granularity, not run granularity.** One block (paragraph, slide paragraph, subtitle cue) maps to one `sourceLocation` shared by all segments from that block. Segments share the same `group` ID.

**Why block-level:** When a block's text is split into multiple segments (long paragraphs), and inline formatting existed within that block (bold, italic mid-paragraph), translation changes word order. Inline formatting can't reliably survive translation. Standard behavior for translation tools: preserve block-level styles (heading level, list marker, slide position), drop inline run-level formatting on writeback.

## Export Flow

Single entry point in `src/lib/export/export-service.ts`:

```typescript
export async function exportFile(fileId: string): Promise<{ blob: Blob; filename: string }>
```

Logic:
1. Load file's Y.Doc, read all cells into memory (including `sourceLocation`, `group`, `original`, `translated`, `type`, `context`)
2. Look up original ArrayBuffer via `getOriginalFile(fileId)`
3. Read file type from Y.Doc meta
4. Dispatch:
   - DOCX/PPTX with original + position metadata → surgical export
   - Everything else (or missing original) → reconstruct export

## Surgical Export (DOCX/PPTX)

```typescript
async function surgicalExport(
  originalBuffer: ArrayBuffer,
  cells: CellData[],
  fileType: "docx" | "pptx"
): Promise<Blob>
```

### Algorithm

1. Load zip with JSZip
2. Group cells by `sourceLocation.file`, then by `sourceLocation.blockPath`
3. For each XML file:
   a. Parse with DOMParser
   b. For each unique `blockPath`:
      - Collect all cells at this block (one per group, but there may only be one group per block)
      - Sort segments within the group by cell insertion order (array order)
      - Reassemble translated text: join segments with spaces. If any segment is empty-translated, use its `original` instead
      - Find the block element using the `blockPath`
      - Replace the block's text content atomically:
        - DOCX: remove all child `<w:r>` runs, insert a single `<w:r><w:t xml:space="preserve">…text…</w:t></w:r>`. Preserve `<w:pPr>` if present.
        - PPTX: same pattern — remove all `<a:r>` runs in the paragraph, insert a single `<a:r><a:t>…text…</a:t></a:r>`. Preserve `<a:pPr>` if present.
   c. Serialize XML back to string via XMLSerializer
   d. Replace file content in zip
4. Generate new zip as Blob

### Working Backwards Principle

When multiple blocks in the same XML file are being replaced, process them in **reverse document order**. This avoids any possibility of XPath/indexed-path invalidation after mutations. For our approach (DOM node replacement, not byte manipulation) this matters less, but we follow it anyway for predictability.

### Block Path Format

For DOCX: `w:p[N]` where N is the 1-based index of the `<w:p>` element within `<w:body>`. Nested structures (tables, text boxes) use extended paths like `w:tbl[1]/w:tr[2]/w:tc[1]/w:p[1]`. M5 supports top-level paragraphs only; nested structures fall through to reconstruct export or preserve as-is.

For PPTX: `a:p[N]` within the shape's `<p:txBody>`, scoped by shape index: `p:sp[S]/p:txBody/a:p[N]`.

**Scope for M5:** support top-level `<w:p>` under `<w:body>` for DOCX, and `<a:p>` within top-level `<p:sp>` for PPTX. Unsupported nested structures preserve original content unchanged.

## Reconstruct Export

Per-format rebuilder functions in `src/lib/export/rebuilders/`:

```typescript
function rebuildPlaintext(cells: CellData[]): string
function rebuildMarkdown(cells: CellData[]): string
function rebuildVtt(cells: CellData[]): string
function rebuildSrt(cells: CellData[]): string
function rebuildUsfm(cells: CellData[]): string
```

### Fallback behavior

For every cell: use `translated` if non-empty, else fall back to `original`.

### Per-format details

**Plaintext:** Group cells by context (Paragraph N). Within each paragraph, join segments from the same `group` with spaces. Join paragraphs with `\n\n`.

**Markdown:** Inspect `cell.type` and `cell.context`:
- `heading` + context like "Heading 3" → emit `### text`
- `list` → emit `- text`
- `blockquote` → emit `> text`
- `text` → plain paragraph
- Join blocks with `\n\n`. Segments within a group rejoin with spaces.

**VTT:** Emit `WEBVTT\n\n` header. For each cell (each is one cue): emit `context\n` (the timestamp line) then `translated\n\n`.

**SRT:** For each cell (each is one cue), emit `index\ntimestamp\ntranslated\n\n`. Index is 1-based sequential.

**USFM:** Parse `context` values like "GEN 1:5" to reconstruct book/chapter/verse markers. Emit `\id BOOK`, `\c N`, `\v N text`, `\s text` (for headings), `\mt text` (for paratext). Group cells by book first, then process in order.

## UI

### Toolbar Download Button

Add `Download` icon (from lucide-react) to the Toolbar, between Import and Rules. Only enabled when a file is active.

Click handler:
1. Call `exportFile(activeFileId)`
2. Create object URL from blob
3. Trigger download via synthetic `<a download={filename}>` click
4. Revoke object URL

Filename: original name with `.translated` inserted before the extension: `report.docx` → `report.translated.docx`.

### Error Handling

If export throws, show a toast/alert with the error message. For M5 use `alert()`; a proper toast system can come later.

## Parser Changes

Each parser needs to set `sourceLocation` at extraction time.

### DOCX parser
- Track the index of each `<w:p>` encountered: `blockIndex` starting at 1
- Set `sourceLocation: { file: "word/document.xml", blockPath: \`w:p[${blockIndex}]\` }` on every extracted `TranslatableString` from that block

### PPTX parser
- For each slide file (`ppt/slides/slideN.xml`):
  - Track `<p:sp>` index and `<a:p>` index within each sp
  - Set `sourceLocation: { file: slideFilename, blockPath: \`p:sp[${spIdx}]/p:txBody/a:p[${pIdx}]\` }`

### Text-based parsers

TXT, MD, VTT, SRT, USFM do not need `sourceLocation` — reconstruction regenerates from cell data. Leave the field undefined.

## File Structure

```
src/
├── lib/
│   ├── export/
│   │   ├── export-service.ts       # NEW: exportFile entry point
│   │   ├── surgical-export.ts      # NEW: DOCX/PPTX text swap via JSZip
│   │   ├── surgical-export.test.ts # NEW: TDD
│   │   └── rebuilders/
│   │       ├── plaintext.ts        # NEW
│   │       ├── markdown.ts         # NEW
│   │       ├── subtitle.ts         # NEW (VTT + SRT)
│   │       ├── usfm.ts             # NEW
│   │       └── rebuilders.test.ts  # NEW: TDD
│   └── parsers/
│       ├── types.ts                # MODIFY: add SourceLocation
│       ├── docx.ts                 # MODIFY: set sourceLocation per block
│       └── pptx.ts                 # MODIFY: set sourceLocation per block
├── components/
│   └── Toolbar.tsx                 # MODIFY: add Download button
```

## Testing Strategy

**Surgical export tests:** programmatically build minimal DOCX/PPTX with JSZip (similar to existing parser tests), run through surgical export with translations, assert that:
- Text content is replaced
- Non-text structure (styles, pPr) is preserved
- Images and other elements pass through untouched
- Empty translations fall back to original

**Rebuilder tests:** for each format, given known cell data, assert output matches expected format.

**End-to-end round-trip:** import → translate → export → re-import. Verify cell count and text content preserved. Not automated for M5 (manual test only).

## Future Enhancements (not in scope)

- **Inline formatting loss indicator:** when a source cell has bold/italic/underline/strike styles in its HTML but the target cell has no such formatting (expected, since plain textarea doesn't support rich text), show a small alert icon indicating formatting may be lost on export. Would help translators who *do* want to preserve emphasis.
- Nested block support (tables, text boxes) for DOCX surgical export
- Comments, headers/footers, speaker notes in DOCX
- Notes slides in PPTX
- Preserve inline formatting when translator explicitly marks spans (future rich text editor)
- Export to different format than input (e.g., USFM → MD)
