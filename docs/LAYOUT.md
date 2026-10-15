# Layout assurance

SPEC §5 asks to "detect overset text, missing content, font problems, and
layout regressions" and to treat repair as constrained optimisation. This is
what exists, what it can and cannot claim, and how to close the gap.

## What exists

`src/adapters/idml/layout.ts`

1. **Frame capacity** per story from spreads and master spreads: threaded
   frames, path-geometry bounds × item transform scale, columns, gutters,
   insets.
2. **Text demand** per paragraph: lines = ⌈em-width / column width⌉ ×
   leading, with point size and leading from the paragraph style chain
   (`BasedOn`) or local overrides, and per-script average advance widths
   (Latin ≈ 0.5 em, capitals 0.62, spaces 0.25, CJK 1.0, combining marks 0).
3. **Calibration.** The source is known to fit, so when the raw estimate
   overfills the source frame, the target estimate is scaled by the same factor.
4. **Findings** per story: `ok` / `tight` (> 95%) / `overset` (> 100%), with
   source fill, target fill and expansion ratio, in every sync report.
5. **Repair proposals** within policy limits (tracking ≥ −20/1000 em,
   horizontal scale ≥ 96%): the cheapest adjustment that fits, else "beyond
   automatic limits — shorten copy, enlarge or add a threaded frame". Proposals
   are reported, not applied.

Missing content is covered by the text-preservation checks in validation
(every unit reads back, in order, tokens intact).

## What it cannot claim

The estimate ignores kerning, hyphenation and justification, text wrap,
baseline grids, fonts actually available, and anchored objects' space. Gate A
reports it as **PARTIAL**: on a constructed corpus it raises no false alarms
and catches most clear overflows, but borderline cases are missed. It is a
triage signal, not evidence.

Font problems (missing glyphs for the target script) are not detected yet.

## Closing the gap: an InDesign oracle

Aquilla already has the harness: `docs/IDML_ADOBE_VALIDATION.md` in the main
repo describes an InDesign Server UXP script that opens, recomposes,
preflights, exports and reopens IDML and records overset story ids, structure
and preflight results without recording text.

Plan:

1. Implement `LayoutOracle` with two backends: the current estimator and an
   `IndesignServerOracle` that submits `(source, candidate)` pairs to that
   script and maps its overset story ids to `LayoutFinding`s.
2. Run both on the engagement corpus; use the oracle as ground truth to
   calibrate the estimator (per-font width tables if needed) and to fill the
   two non-green Gate A rows.
3. Add font coverage: read `Resources/Fonts.xml`, check target text against
   each applied font's cmap when font files are supplied.
4. Only then consider applying repairs: write `Tracking`/`HorizontalScale` on
   the affected story's character ranges (a formatting patch with its own
   authority and review flag), re-verify with the oracle, and keep frame
   geometry changes behind explicit approval.

Also open: set InDesign's `AppliedLanguage` on translated text so hyphenation
and spelling use the target language.
