# USFM Structural Round-Trip

**Scope:** Make edited-verse USFM export preserve intra-verse structure
(footnotes, cross-references, inline character markers, poetry/paragraph
breaks) instead of flattening it to plain text, and flag inline-marker drift
as a rule. Ported onto `main` as a **server + rules** slice (Phase 1); the
editor affordances are deferred to **Phase 2** (see below).

## The gap

The lossless side-car (`usfm-lossless.ts`) makes **unedited** export
byte-perfect: the original `.SFM` bytes are stored and passed through, only
translated verse spans are spliced in. But the splice (`serializeUsfmLossless`)
replaced the **entire verse span** with the translator's plain text. So
translating a verse that contained a footnote `\f … \f*`, poetry lines `\q1`/
`\q2`, or inline markers `\nd`/`\wj` silently destroyed that structure.

`main` already surfaced this loss via **FRO-276**: `countLossyVerses` counts
translated verses whose original span had intra-verse markers, and the export
route returns it as the `X-Usfm-Lossy-Verse-Count` header, which `ExportDialog`
turns into a warning. That tells the translator loss happened — it does not
prevent it.

## Phase 1 — server + rules (this change)

### Bidirectional span mapper

`src/lib/parsers/usfm-html.ts` (SPA) + `sync-worker/src/lib/usfm-html.ts`
(worker mirror — kept in sync by convention, same as `usfm-lossless.ts`):

- `usfmSpanToHtml(span)` — inline markers → `<span/strong/em data-usfm="…">`,
  notes → `<sup data-usfm="f" data-usfm-body="…">caller</sup>`, breaks →
  `<br data-usfm="q1">`.
- `htmlSpanToUsfm(html)` — the inverse. **DOM-free** (runs in the Worker export
  route, no `DOMParser`); recovers markers from `data-usfm`, falling back to the
  semantic tag so an editor that strips `data-*` still round-trips emphasis.
- `usfmSpanBlocks` / `extractTargetBlocks` — block-level segmentation used by the
  per-run serializer; `diffInlineMarkers` / `inlineMarkersInHtml` /
  `restoreFormattingToTarget` / `markMismatchedSourceMarkers` — inline-marker
  drift helpers used by the rule (and, in Phase 2, the editor).

### Source HTML for the rule (derived, not stored)

The `usfm-marker-integrity` rule needs the source's structured HTML. Rather than
store it on the source cell's `value_html` at import — which would flip USFM
source rendering from the rich `UsfmSourceText` (footnotes, terminology chips,
highlights, inline-rule clicks) to a plain sanitized `<div>` (EditorTable keys
that branch on `cell.originalHtml` being present) — the check **derives** it on
demand: `sourceHtml = ctx?.sourceHtml ?? usfmSpanToHtml(source)`, where `source`
is the raw verse span (`cell.original`). So import is untouched, source rendering
is unchanged, and the rule still sees the full inline structure. (Phase 2 may
revisit storing structured source HTML deliberately, alongside a render path that
preserves the `UsfmSourceText` affordances.)

### Export — per-block re-insertion

The export route (`sync-worker/src/events/export-route.ts`) now selects
`t.value_html` and calls `serializeUsfmPerRun(doc, targets)` instead of
`serializeUsfmLossless`. For each verse it splits the source span at **block
markers only** (`usfmSpanBlocks`; notes/inline styles stay inside a block) and
splits the target at `<br>`/`<p>`/`<div>` (`extractTargetBlocks`):

1. **Block counts match** → rebuild the span keeping the block markers + their
   whitespace **byte-for-byte from the source**, replacing each block's inline
   content with the target's (`htmlSpanToUsfm` of that block). Text, character
   styles, and footnotes/cross-refs are all **target-driven**.
2. **Counts differ** (translator merged/split lines) → fall back to whole-span
   reconstruction via `htmlSpanToUsfm` (or plain `value`).
3. **No targets** → output is byte-identical to `doc.raw`.

This is a **strict superset** of the legacy behavior: a plain-text target (no
`value_html`) for a single-block verse behaves exactly like
`serializeUsfmLossless`, but block structure is now preserved whenever the
translation's block structure lines up with the source's.

**FRO-276 is preserved.** The route still computes `countLossyVerses(doc,
overrides)` from the plain-text values and emits `X-Usfm-Lossy-Verse-Count`. The
warning stays meaningful: per-run keeps block markers, but inline notes/styles a
plain-text cell omits are still dropped — until Phase 2 has the editor emit
structured `value_html`, plain-text targets remain the common case.

### `usfm-marker-integrity` built-in check (default on, minor)

`src/lib/lqa/check-functions/usfm-marker-integrity.ts`, registered in
`builtin-registry.ts`. It diffs the inline markers in the source HTML against the
target HTML (`diffInlineMarkers`):

- **Formatting** (`\nd \bd \it \wj \sc …`) missing in the target → infraction
  (auto-restorable in Phase 2).
- **Footnotes / cross-refs** (`\f \x`) missing → infraction, flag only.

It is HTML-aware, so the builtin-check framework grew an optional third arg
(`BuiltinCheckContext { sourceHtml, targetHtml }`); `rule-engine.ts` threads
`cell.originalHtml` / `cell.translatedHtml` through. Plain-text checks ignore it.

### Tests

`usfm-html.test.ts` (mapper round-trip), `usfm-structural-roundtrip.test.ts`
(import→edit→export), `usfm-marker-integrity.test.ts` (the check), and new
`export-route.test.ts` cases (byte-identity with no cells, `\q2` preserved when
blocks align, footnote reconstructed from `value_html`). The FRO-276 header tests
are unchanged and still pass.

## Phase 2 — editor affordances (deferred / to be researched)

The full benefit of inline reconstruction needs the editor to emit
USFM-structured `value_html` (data-usfm spans, `<sup>` notes) rather than plain
bold/italic, plus translator-facing UX:

- underline the mismatched source styling (`markMismatchedSourceMarkers`),
- a **"restore formatting"** chip (`restoreFormattingToTarget`) that re-applies
  dropped formatting and commits the new `value_html`,
- a **"footnote"** chip flagging a dropped note.

`main`'s `EditorTable.tsx` / `TranslatedEditor.tsx` (TipTap) have diverged
substantially from where this was first prototyped, so Phase 2 should first
research how the TipTap editor produces `value_html` today and recommend the
least-invasive integration before building. The helpers above are already in
`usfm-html.ts` and unit-tested, ready for that work.
