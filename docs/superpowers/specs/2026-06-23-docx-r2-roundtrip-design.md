# DOCX R2 Round-Trip — Design

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Author:** Ryder Wishart + Claude

## Problem

A beta user reported: "when you round trip a word doc you lose the formatting."

Investigation found the current DOCX round-trip (FRO-233) is real but broken in two
independent ways:

1. **Storage cap.** The original `.docx` is base64-encoded and stored in a Postgres
   TEXT column (`file_source_blobs.raw_source`), written inside the import event JSON.
   Import silently skips saving the original for any file over **512 KB**
   (`src/lib/import.ts:1396`) because Postgres/D1 TEXT rows cap near 1 MB. For those
   files, export hard-errors: *"no source blob recorded for this file — re-import to
   enable export"* (`sync-worker/src/events/export-route.ts:84`). Real Word documents
   with images/styling routinely exceed 512 KB.

2. **Injection flattening.** Even on a successful round-trip, the exporter consumes
   only `cell.translated` (plain text), discards the translator's own inline formatting
   (`cell.translatedHtml`), and **clones the *source's* dominant run formatting onto the
   translated text** (`src/lib/export/exporters/docx.ts:230`). All runs of a translated
   paragraph collapse to a single run. A bold word, colored word, hyperlink, or footnote
   marker *inside* a translated paragraph is wiped.

## Contract

- **Our responsibility:** store the original Word file verbatim, and on export reinsert
  the *translated* content as runs back into the original document in place — replacing
  only the runs of units that have a translation, leaving untranslated units' original
  runs untouched.
- **Not our responsibility:** deciding the translation's inline styling. That belongs to
  the translator and is carried on the translation itself (`translatedHtml`), never copied
  from the source.

## Section 1 — Storage & transport

**Bucket.** Reuse the existing `SNAPSHOTS` R2 bucket (`aquilla-snapshots`), mirroring the
audio key convention (`src/audio.ts:30` `audioObjectKey`):

```
{prefix}projects/{projectId}/files/{fileId}/source/original.{docx|pptx}
```

**Upload path (new).** On import, after parsing, the client `PUT`s the raw original bytes
to a new authenticated sync-worker endpoint (`PUT /api/v1/projects/{projectId}/files/{fileId}/source`)
that streams them straight into R2 — no base64, no size cap, separate from the import event
JSON. The import event stops carrying `rawSource`.

**DB record.** `file_source_blobs` is repurposed from a blob store to a pointer:
- keep `file_id`, `project_id`, `format`, `created_at`
- make `raw_source` **nullable** (legacy fallback only)
- add `r2_key TEXT` and `size_bytes INTEGER`

The key is deterministic, but the row cheaply records format + existence + size.

**Export (server).** `GET /files/{fileId}/source` reads from R2 when `r2_key` is present,
falls back to the legacy `raw_source` column when it is null, and streams the bytes back
with the unchanged `X-Export-Mode: raw-sidecar` header. Transport to the client is unchanged.

**Migration.** Dual-read, **no backfill job**. Old small docs keep working via the legacy
column. Docs previously over the cap were never saved at all, so they simply need a
re-import to gain export — strictly better than today.

## Section 2 — In-place reinsertion (formatting contract)

A pure client-side rewrite of `injectTranslationIntoParagraph` in
`src/lib/export/exporters/docx.ts`.

1. **Consume `cell.translatedHtml`, not `cell.translated`.** Parse it into an ordered list
   of `(text, marks)` spans, where `marks ⊆ {bold, italic, underline, strike, code}`.

2. **Build one `<w:r>` per span.** Each run gets a base `rPr` (font/size taken from the
   paragraph's dominant source run, so inserted text matches the document's typography)
   plus the translator's own toggles layered on. A plain translation with no marks → a
   single plain run. A translation with a bold word → multiple runs, bold honored.
   This is the inverse of today: **translator formatting wins; source inline emphasis is
   not force-stamped.**

3. **Replace only the runs, keep everything else.** `w:pPr` (paragraph style, list
   numbering, spacing, alignment) stays untouched. Tables, images, headers/footers survive
   automatically because only text runs inside translated paragraphs are rewritten.

4. **Untranslated units: zero-touch.** A unit with no translation keeps all its original
   runs verbatim — no flattening, no replacement.

**Matching robustness.** Today paragraphs are matched to translations by recomputed
non-empty-index, which silently desyncs if the import skip-logic and the export filter ever
diverge. Import already records `sourceLocation.blockPath = "w:p[N]"` per unit
(`src/lib/parsers/docx.ts`). Match on that stored paragraph index, falling back to
positional — so reinsertion targets the same paragraph the text was extracted from.

**Honest boundary.** If the source had "the **LORD** said" and the translator typed plain
"the Lord said", the bold is gone — correctly, because the translator chose plain. Source
emphasis is not transferred onto translated text. Suggesting source emphasis to translators
is a separate editor feature, not export.

## Section 3 — Scope, non-goals, testing

**In scope**
- New `PUT`/`GET …/files/{fileId}/source` R2 path; `file_source_blobs` becomes a pointer.
- Client upload of the original to R2 on import; remove `rawSource` from the import event.
- Rewrite of `injectTranslationIntoParagraph` to build runs from `translatedHtml` and match
  by stored `blockPath`.

**Non-goals (explicit)**
- **PPTX injection.** PPTX shares the same cap and single-run collapse, but its injection
  target is `ppt/slides/slideN.xml`, not `word/document.xml`. The **storage** half (R2,
  dual-read) is built format-agnostic so PPTX rides along for free; the PPTX **injection**
  rewrite is a separate slice.
- Source-emphasis suggestion to translators (an editor feature, not export).
- The slow health-ring issue (validated cells showing no confidence ring) — tracked
  separately.
- Backfilling legacy DB blobs into R2 — dual-read covers it.

**Testing (intent)**
- **Round-trip fidelity:** import a fixture `.docx` with a heading, a list, a table, an
  image, and a mixed-bold paragraph → translate a subset → export → re-open the zip and
  assert: (a) untranslated paragraphs are byte-identical to the original, (b) translated
  paragraphs carry the translator's marks as separate runs, (c) `w:pPr`/list/table/image
  XML is preserved, (d) the image part still exists in the zip.
- **Over-cap:** a >512 KB original survives import → R2 → export (impossible today).
- **Matching:** a doc where the non-empty filter and stored `blockPath` would disagree →
  reinsertion lands on the right paragraph.
- **Dual-read:** a file with only a legacy `raw_source` (no `r2_key`) still exports.

## Key references

- Storage cap: `src/lib/import.ts:1396`
- Legacy blob write: `sync-worker/src/events/import-route.ts:207`
- Export route (server): `sync-worker/src/events/export-route.ts:74`
- Injection (to rewrite): `src/lib/export/exporters/docx.ts:206`
- R2 key convention: `src/audio.ts:30`
- Stored paragraph index: `src/lib/parsers/docx.ts` (`sourceLocation.blockPath`)
- Schema: `db/postgres/schema.sql:406` (`file_source_blobs`)
