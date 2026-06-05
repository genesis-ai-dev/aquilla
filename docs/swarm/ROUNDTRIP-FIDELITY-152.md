# FRO-152 — Round-Trip Fidelity Findings

**Branch:** `swarm/fro-152`  
**Date:** 2026-06-04  
**Scope:** All supported import formats — maps current round-trip status, gaps, and improvement done.

---

## Architecture Overview

Aquilla uses a **side-car pattern** for round-trip fidelity:

1. **Import**: raw source bytes are stored in `file_source_blobs` (D1 TEXT column) alongside the parsed cells.
2. **Export**: the server-side export route (`GET /api/v1/projects/:pid/files/:fid/source`) reads the side-car bytes, fetches current translated cells, and reconstructs the original file with translations substituted.

Currently only **USFM** has a complete server-side serializer (`parseUsfmLossless` + `serializeUsfmLossless`). All other binary formats (DOCX, PPTX) reach the export route and return `501 Not Implemented`.

---

## Round-Trip Support Matrix

| Format | Importable | Exports Round-Trip | Side-car Stored | Fidelity Gap |
|--------|:----------:|:------------------:|:---------------:|--------------|
| **USFM / SFM** | YES | **YES** (lossless) | YES (text) | None — `serializeUsfmLossless` injects translations into original markup. Full paragraph/marker structure preserved. |
| **USX** | YES (converted to USFM) | **YES** (via USFM) | YES (as USFM after convert) | Roundtrip is to USFM, not USX. Original USX-native round-trip deferred (noted in `usx.ts` TODO). |
| **Paratext project (.zip)** | YES | **YES** | YES (per-book raw SFM + target bytes) | Same as USFM. Target Paratext bytes kept as side-car for export. |
| **DOCX** | YES | **NO** (501) | **NO** (before this PR) / **YES** (after this PR, ≤ 512 KB) | Server-side DOCX serializer does not exist. Side-car bytes now captured; export route needs `format === "docx"` branch with XML injection. |
| **PPTX** | YES | **NO** (501) | **NO** (before this PR) / **YES** (after this PR, ≤ 512 KB) | Server-side PPTX serializer does not exist. Side-car bytes now captured; export route needs `format === "pptx"` branch with XML injection. |
| **VTT / SRT (subtitle)** | YES | NO | NO | One-way import into time-ordered cue cells. Round-trip export could be added via a simple VTT serializer (time codes are stored on cells). Medium effort. |
| **XLIFF 1.2** | YES (bilingual) | YES (bilingual) | N/A | XLIFF is inherently bilingual — export → re-import preserves source + target text. Inline `<g>`/`<x>` tags are stripped to plain text (known gap, see `xliff.ts` SWARM-TODO). |
| **TMX 1.4b** | YES | YES (bilingual) | N/A | Same as XLIFF but empty-target cells are dropped (TM format by design). |
| **CSV** | YES | YES (bilingual) | N/A | Full round-trip via RFC-4180 CSV. |
| **TSV** | YES | YES (bilingual) | N/A | Full round-trip with RFC-4180 quoting (fixed in a prior PR). |
| **eBible** | YES | NO | NO | Server-side download-and-parse only. Side-car not applicable (source is remote URL). Round-trip not meaningful. |
| **Plain text (.txt)** | YES | NO (one-way) | NO | `exportPlainText` emits translated text only. No inverse parser. |
| **Markdown (.md)** | YES | NO (one-way) | NO | Same as plain text — source lost on export. |
| **Audio / Video** | YES (media blob) | NO | NO (stored as R2 media) | Media files are opaque blobs. "Round-trip" = R2 download which is a separate path. |

---

## What Was Improved (This PR)

### `src/lib/import.ts` — DOCX + PPTX side-car capture

**Before:** DOCX and PPTX parsed cells but silently discarded the original bytes. Export returned `501`.

**After:** Raw bytes are base64-encoded and stored as `rawSource` / `rawSourceFormat` on import, flowing to `file_source_blobs` via the existing `bulkUploadSource` path. A size guard caps the side-car at 512 KB raw (≈ 700 KB base64, well under D1's 1 MB row limit) to avoid D1 overflow errors on large files.

**Files changed:**
- `src/lib/import.ts`: added `arrayBufferToBase64()` helper; updated `case "docx"` and `case "pptx"` to set `rawSource` + `rawSourceFormat`.

**What this enables:** The `file_source_blobs` row now exists for newly-imported DOCX/PPTX files. A follow-up issue can implement the server-side serializer to complete the round-trip.

---

## Recommended Follow-Up Issues

### FRO-152a — Server-side PPTX export serializer (high value, medium effort)

**Scope:** Add a `format === "pptx"` branch in `sync-worker/src/events/export-route.ts`.

**Approach:**
1. Base64-decode `raw_source` back to binary.
2. Open as JSZip (already a dep, available in the worker via npm).
3. For each `ppt/slides/slideN.xml`, find `<a:t>` runs whose parent path matches the stored `sourceLocation.blockPath`.
4. Substitute `<a:t>` text content with the translated cell value.
5. Return the modified zip as `application/vnd.openxmlformats-officedocument.presentationml.presentation`.

**Risk:** Run text matching must account for split runs (a single visual text string split across multiple `<a:r>` elements). The parser's `extractPptxRuns` already concatenates runs into a single plain text; the serializer must distribute the translation back across the original run structure or flatten to a single `<a:r>`. Flattening loses per-run formatting (bold/italic) — acceptable for translated text, but worth noting.

**Test:** `import → translate → export → re-import structure matches original slide count + cell count`.

### FRO-152b — Server-side DOCX export serializer (high value, medium effort)

**Scope:** Same as 152a but for DOCX. Replace `<w:t>` text in `word/document.xml` using `sourceLocation.blockPath` (e.g. `w:p[2]`).

**Risk:** DOCX paragraph text is often split across multiple `<w:r>` runs (for mixed formatting). Same mitigation as PPTX: flatten to a single run per paragraph on export, accepting that per-run bold/italic is dropped for translated paragraphs.

### FRO-152c — Large-file side-car (> 512 KB DOCX/PPTX)

**Scope:** The current size guard silently skips side-car capture for files above 512 KB. Options:
- R2 for side-car blobs (avoids D1 row limit entirely — same bucket as media).
- Chunk the side-car across multiple D1 rows.
- Surface a warning in the import dialog: "File too large for round-trip export (> 512 KB)".

**Recommendation:** R2 for side-car is the right long-term answer; D1 TEXT is a stopgap.

### FRO-152d — VTT/SRT round-trip export (low effort)

**Scope:** Add a `vtt` export format that reconstructs a subtitle file from timed cells. Time codes (`start_ms`, `end_ms`) are already stored on cue cells. A simple serializer suffices. ExportDialog already has a VTT exporter for the *translated* VTT — the gap is exporting with original timing intact, which the existing exporter already does.

**Actually:** the existing `exportVtt` in `src/lib/export/exporters/vtt.ts` already writes timed cues from cell `start_ms`/`end_ms`. This may already be a working round-trip — verify by checking if VTT re-import recovers timing. Low priority.

---

## Spec Check (`~/frontierrnd/aquilla-specs`)

Checked `04-features/export-and-legacy-import.md`. The v2 Export section mentions DOCX export as a planned format but has no acceptance criteria for round-trip fidelity or the side-car mechanism.

**Added acceptance criterion** to `~/frontierrnd/aquilla-specs/04-features/export-and-legacy-import.md` (see spec commit).

---

## SWARM-TODO Live-UI Steps

The following cannot be verified by tsc/vitest alone and require a running app:

1. Import a `.pptx` file via the Import dialog in the dev app.
2. Verify `file_source_blobs` row is created (check sync-worker D1 or the admin panel).
3. Attempt USFM-style export for the PPTX file — confirm UI shows "501 Not Implemented" (expected until FRO-152a) rather than "404 no side-car" (the previous behavior for all newly-imported PPTX files).
4. Same flow for DOCX.
