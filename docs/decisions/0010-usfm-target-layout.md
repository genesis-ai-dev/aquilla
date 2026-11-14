# 0010 — USFM target layout lives in the verse's own translation

*Decided 2026-11-13 (AQU-2559), with the Bible document layout and the live
export preview.*

## Context

A USFM verse's raw span runs to the next `\v`. It therefore holds the bare
`\p` or `\q1` line that opens the NEXT verse's paragraph. The export replaced
the whole span with the translation, so every translated verse deleted the
paragraph break after it, and a translated book exported as one paragraph per
chapter.

The document layout also lets a translator add a paragraph break or a section
heading that the source does not have. That layout belongs to one target
language, must survive history, undo and the head compare-and-swap, and must
come out in the exported file.

## Decision

- **A verse span has a body and a tail.** The tail is its trailing bare
  paragraph-marker lines (`db/shared/usfm-layout.ts::splitUsfmTail`). A
  translation replaces the body only; the tail stays.
- **Layout the translation adds is a lead on the verse that follows it.** The
  lead is the leading lines of that verse's target value that are section
  headings or bare paragraph markers
  (`db/shared/usfm-layout.ts::splitUsfmLead`). On export the lead replaces the
  bare marker lines before that verse's `\v`. A lead of exactly `\nb` means
  "no break here" and writes nothing.
- **A verse whose layout matches the source carries no lead.** The document
  compares each verse with the source's `paragraphStart` / `paragraphMarker`
  and writes a lead only for a difference
  (`src/lib/bible-document/doc-model.ts::readDoc`).
- **One serializer for the download and the preview.**
  `db/shared/usfm-layout.ts::renderUsfmWithLayout` runs in sync-worker
  (`sync-worker/src/events/export-route.ts::handleExportSourceRequest`) and in
  the browser (`src/lib/bible-document/export-plan.ts::renderUsfmPreview`).
  With no translations its output is the upload, byte for byte.
- No new event kind and no schema change. A lead is part of an ordinary
  `target.cell.commit` value.

## Consequences

- A translated book keeps the source's paragraphs and poetry lines in the
  export. This changes the exported file for existing projects: paragraph
  lines that used to be lost are now kept.
- A target value can begin with marker lines. The table hides the markers: a
  `\p` lead reads as a line break, and a `\s1` lead as a line of its own with
  no heading style.
- A break or heading added before an untranslated verse stores a value that is
  only a lead. The export keeps the source words for that verse, but progress
  counts the cell as translated.
- The browser builds its export plan from the cells on screen
  (`src/lib/bible-document/export-plan.ts::buildClientUsfmPlan`) and the server
  from SQL. The two must agree; `src/lib/bible-document/export-plan.test.ts`
  holds the shared rules.

## Not covered yet

- A heading the translator adds is part of the next verse's value. It is not a
  cell of its own, so it cannot be validated or commented on separately.
- Footnotes and character styles inside a source verse are still replaced by a
  plain translation. The preview counts those verses.
- USX uploads, and every format other than USFM, have no export preview.
- Other exporters (HTML, plain text) do not read leads as headings.
