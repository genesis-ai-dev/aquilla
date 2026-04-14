# Codex Web App — Milestone 9: Rich Text Editing

## Overview

Replace each cell's plain `<textarea>` target input with a TipTap + ProseMirror editor bound to a `Y.XmlFragment`. Minimal schema: paragraphs + `bold/italic/underline/strike/code` inline marks + hard breaks. No toolbar clutter — a bubble menu appears on text selection, hidden otherwise. Paste handling strips to allowed marks only. Full refactor to make `Y.XmlFragment` the single source of truth for target text.

## Single Source of Truth

Every cell's target content lives in exactly one place: `cell.get("translatedXml")` as a `Y.XmlFragment`. The previous `translated: string` field is removed entirely. All readers that need a plain-text view call `getPlainText(frag)`; all writers (LLM streaming, validation, history) go through `setPlainText(frag, text)`. Both are implemented once in `src/lib/richtext/translated-xml.ts` and reused.

Rationale: two-source designs (string + fragment kept in sync via observers) drift under race conditions and make debugging hard. A single Yjs fragment with dedicated extract/replace helpers is simpler and rock-solid.

## Schema

TipTap schema restricted to exactly:
- `doc → paragraph+`
- `paragraph → (text | hardBreak)*`
- Inline marks: `bold`, `italic`, `underline`, `strike`, `code`

No headings, lists, blockquotes, images, tables, links, or any other node types. Cell-level types (heading, list item, blockquote) are already expressed via `cell.type`, not via editor content.

## Paste Handling

TipTap's `transformPastedHTML` hook strips all pasted HTML except the allowed marks. Users can paste from Word / Google Docs / browsers; only the formatting that round-trips cleanly survives.

## UI

### TranslatedEditor Component

`src/components/TranslatedEditor.tsx`:

- Props: `fragment: Y.XmlFragment`, `onBlur?: () => void`, `placeholder?: string`
- Internal: TipTap editor bound via y-prosemirror's `ySyncPlugin`
- Bubble menu: floating toolbar with B / I / U / S / `</>` icons, toggles marks on selection
- Bubble menu appears only when there's a non-empty selection AND the editor is focused
- Styled to look like the existing textarea: same border, padding, focus ring, resize behavior
- Dynamic height based on content

### Editor Table Integration

`EditorTable.tsx` swaps the `<textarea>` for `<TranslatedEditor>`. The rest of the row layout is unchanged.

## Refactor Surface

Every reader of `translated` → call `getPlainText(cell.translatedXml)` (or read from derived `translated` on `CellData` — see below).

Every writer of `translated` → call `setPlainText(frag, text)` inside `doc.transact()`.

### CellData Compatibility

For downstream components that want plain text without thinking about fragments, `CellData.translated` becomes a computed string synthesized by `useCells` at render time via `getPlainText(fragment)`. Read-only. All writes go through the fragment.

This keeps the rest of the app (StatusBar, health engine, rule engine, search, completion prompts, backtranslation prompts, export rebuilders, sidebar badges) unchanged — they see `cell.translated` as a string as before.

### Affected Files

**New:**
- `src/lib/richtext/translated-xml.ts` — getPlainText, getFragmentHtml, setPlainText, setFragmentFromHtml
- `src/lib/richtext/translated-xml.test.ts` — TDD
- `src/components/TranslatedEditor.tsx` — TipTap editor with bubble menu

**Modified:**
- `src/lib/store/file-doc.ts` — createFileDoc seeds `translatedXml` Y.XmlFragment (no more `translated` string field); collectExportCells extracts plain text
- `src/hooks/useCells.ts` — read XmlFragment, expose computed `translated: string` derived from fragment
- `src/hooks/useCellHistory.ts` — appendCellHistory and validateCell route writes through `setPlainText`
- `src/hooks/useCompletion.ts` — LLM streaming writes fragment
- `src/hooks/useBacktranslation.ts` — LLM streaming writes fragment
- `src/components/EditorTable.tsx` — swap textarea for TranslatedEditor
- `src/lib/export/surgical-export.ts` — convert fragment HTML to multiple DOCX/PPTX runs (preserving bold/italic/etc.)
- `src/lib/export/rebuilders/markdown.ts` — map HTML marks → markdown syntax (`<b>` → `**text**`, `<code>` → `` `text` ``, etc.)

### Snapshot Compatibility

Old snapshots (M8 pre-refactor) will contain Y.Docs with string `translated` fields. Restoring them into a post-refactor cell would produce cells the editor can't bind to.

**Approach:** add a schema version marker. Every new snapshot carries `schemaVersion: 2`; old snapshots default to 1. On restore, if `schemaVersion < 2`, show an error: "This snapshot was created before M9 and cannot be restored. Please delete it or keep it as an archive."

Since there are no users yet, this is acceptable. Noted in release notes.

## Migration on Load

Each cell's Y.Map needs a `translatedXml` Y.XmlFragment. Strategy:

1. New cells created by parsers: `createFileDoc` seeds the fragment directly, no transitional string field.
2. Existing pre-M9 cells: on first load by `useCells`, if `translatedXml` is missing, initialize it inside a Yjs transaction from the old `translated` string. Then the old field can be ignored (but we leave it to avoid mid-transaction divergence; it's simply never read after the refactor).

Since pre-M9 projects mostly have empty translated fields (we only recently added LLM completions), this migration is low-risk.

## Testing

Unit tests for `translated-xml.ts`:
- getPlainText on empty fragment → ""
- getPlainText extracts from paragraphs with mixed marks
- setPlainText overwrites fragment with single paragraph
- HTML ↔ fragment round-trip preserves allowed marks
- Hard breaks preserved

Regression: all existing tests must pass after the refactor.

## Dependencies

New packages:
- `@tiptap/core`
- `@tiptap/react`
- `@tiptap/starter-kit` (provides paragraph, text, hardBreak, bold, italic, strike, code, history)
- `@tiptap/extension-underline`
- `y-prosemirror` (Yjs ↔ ProseMirror binding)
- `@tiptap/extension-collaboration` (Yjs plugin for TipTap)
- `prosemirror-*` (transitive, but some may need explicit install depending on TipTap version)

## Not In Scope

- Keyboard-triggered formatting picker (bubble menu only)
- Link editing
- Image embedding
- Tables within cells
- Rich paste preservation beyond allowed marks
- Collaborative cursors in the editor (possible future enhancement with y-prosemirror awareness)
