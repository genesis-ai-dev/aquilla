# Hello AO Bible API: import type + translator's helps sidebar

Date: 2026-06-12
Status: approved (Ryder confirmed all four scope decisions in session)

## Context

[bible.helloao.org](https://bible.helloao.org/docs/) ("Free Use Bible API", AO Lab)
serves 1,256 bible translations as JSON — no API keys, no usage limits, CORS `*`,
CloudFront-cached, and explicitly free for commercial use. Book ids are USFM
codes (`GEN`, `EXO`) and verses are numbered per chapter, so its references map
1:1 onto our canonical ref scheme (`GEN 1:1`) used by eBible/USFM imports.

Verified endpoints:

- `GET /api/available_translations.json` — list with language, direction, license URL
- `GET /api/{translation}/books.json` — books with chapter counts
- `GET /api/{translation}/{book}/{chapter}.json` — one chapter (content array)
- `GET /api/{translation}/complete.json` — whole translation in one response (~7 MB for BSB)

Chapter `content` is an array of typed nodes: `verse` (number + mixed
string/formatted-text/footnote-ref content), `heading`, `line_break`,
`hebrew_subtitle`.

## Feature 1 — "Hello AO Bible" import type

A new option in the import dialog, mirroring the eBible source-import flow.

**Flow:** landing tile → translation picker (search by name / language) →
**book selection step** (presets: Whole Bible / Old Testament / New Testament,
plus per-book checkboxes from `books.json`) → confirm → progress → done.

**Decisions (confirmed):**

- **Always fetch `complete.json`** — one request per import regardless of
  selection; filter to selected books client-side. Kindest possible usage of
  their API (1 request vs up to 1,189 per-chapter calls) and simplest code.
- **Source files only** — `role: "source"` via the existing `emitParsedFile`
  → `bulkUploadSource` streaming path. No target-matching flow in v1 (eBible's
  AQU-191 flow can be generalized later).
- One imported file per import (like eBible), `fileType: "helloao"`, added to
  `SCRIPTURE_FILE_TYPES` so chapter sections/sidebar work.

**Parsing:** each `verse` node → one `TranslatableString` with
`type: "verse"`, `context: "GEN 1:1"`, `group: "GEN"`, `section: "GEN 1"`,
`globalReferences: ["GEN 1:1"]` (same shape `parseEBibleCorpus` produces).
Formatted-text objects flatten to their `text`; footnote refs (`{noteId}`) and
inline line breaks are dropped; `heading` nodes become `type: "heading"` cells.
Multi-verse content joins with spaces.

**New code:**

- `src/lib/parsers/helloao.ts` — types, `fetchHelloaoTranslations()`,
  `fetchHelloaoBooks(id)`, `fetchHelloaoComplete(id, onProgress, signal)`,
  `fetchHelloaoChapter(id, book, chapter)`, `parseHelloaoBooks(complete, selectedBooks)`
- `importHelloao()` in `src/lib/import.ts` (mirrors `importEBible`)
- `HelloaoPanel` + book-selection UI in `src/components/ImportDialog.tsx`
- `"helloao"` in `FileType` + `SCRIPTURE_FILE_TYPES` (`src/lib/parsers/types.ts`)

## Feature 2 — Translator's helps sidebar (parallel versions)

When viewing a scripture file, a slim edge button on the right opens a
slide-out panel showing the current chapter in other bible versions,
auto-tracking scroll position.

**Decisions (confirmed):** parallel **versions only** in v1 — the API's
commentaries/cross-reference datasets become a follow-up tab later.

**Tracking:** EditorTable already derives the first visible cell from the
virtualizer (`getVirtualItemForOffset`). Surface that cell's canonical ref
(`group`, e.g. `GEN 1:1`) up to ProjectWorkspace; the panel derives
`{book, chapter, verse}` and fetches `/{translation}/{book}/{chapter}.json`
for each pinned version. The tracked verse is highlighted in each version.

**API kindness:** per-chapter fetches only (the granularity the API is built
for), an in-memory chapter cache (version+book+chapter → parsed verses) so
scrolling within a chapter makes zero requests, and fetches fire only while
the panel is open, debounced on chapter change.

**Version picker:** searchable list from `available_translations.json`;
pinned versions persist in `localStorage` per user (no project-settings sync
in v1 — helps are a personal reading aid, not project data).

**Visibility:** the edge button renders only for files whose cells carry
canonical refs (scripture files) — same `fileTypeHasSections` style gate.

**New code:**

- `src/components/TranslatorHelpsPanel.tsx` — panel + version picker
- visible-ref callback from `EditorTable` → `ProjectWorkspace` → panel
- chapter fetch + cache in `src/lib/parsers/helloao.ts` (shared client)

## Out of scope (v1)

- Commentaries / profiles / cross-reference datasets tab
- Import-as-target matching into existing source files
- Per-chapter fetch optimization for tiny imports
- Offline caching of helps chapters (IndexedDB)

## Testing

- Vitest: chapter-content parsing (verses, headings, footnote stripping,
  formatted-text flattening, ranges), book/testament filtering, ref shapes.
- Browser verification: import BSB (single book + NT preset) on the dev
  stack, open the file, toggle the helps panel, scroll and confirm tracking.
