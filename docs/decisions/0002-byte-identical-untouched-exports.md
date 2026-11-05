# 0002 — Byte-identical untouched exports

*Decided before 2026-11; recorded 2026-11-05 (AQU-2387).*

## Context

An IDML package is a publisher's typeset artefact: spreads, style catalogs,
preferences, embedded resources. A translation touches the literal text inside
story members and nothing else. If export re-serialized the whole package, a
user who exported without translating would get a file that *looks* the same
and differs everywhere — attribute order, whitespace, zip entry order — and
nobody downstream could tell a translation from a re-render.

Trust in the round trip is the product here: a publisher has to be able to put
a file through Aquilla and diff it.

## Decision

**An export that changes nothing returns the original bytes.** Not an
equivalent package — the same bytes.

- `packages/idml-roundtrip/src/engine.ts::exportIdml` with an empty
  translation list returns the parsed package's input bytes untouched.
- A repackage only ever carries the members that actually changed; unchanged
  members are copied, not re-emitted. `packages/idml-roundtrip/src/engine.ts::releaseOversizedNoBreakInPackage`
  is the same rule in miniature: it returns the input bytes unless a member's
  XML really differs.
- Export runs in strict mode only — `exportIdml` rejects a call without
  `strict: true` rather than guessing a lenient path.
- Structural verification is a separate call,
  `packages/idml-roundtrip/src/engine.ts::validateExport`, which checks package
  membership and non-literal XML structure against the source manifest.

## Consequences

- Any change that normalizes or rewrites whole members — a prettier, an XML
  round trip "for consistency", a zip rebuild — breaks the guarantee even when
  every test still passes semantically. Member-scoped edits are the only safe
  shape.
- Because `validateExport` deliberately leaves literal `Content` values out of
  its structural fingerprints, it cannot tell an intended translation from
  tampered literal text without the original translation inputs. It answers
  "is this still the same package?", not "is this the translation I asked
  for?".
- The IDML release gate (`scripts/assert-idml-release-gate.ts`, `pnpm idml:gate`)
  exists because this promise is checked against real Adobe output, not only
  against our own reader.

## Not covered yet

- *Amended 2026-11-05 (AQU-2383).* Written for the IDML package path alone;
  the other exporters rendered from cells (`src/lib/export/export-service.ts`)
  and made no byte-level promise. The rule now also holds for an untouched
  plain-text, DOCX and PPTX export, and USFM already held it: the per-file
  route returns the stored upload when the lane has no translation and no cell
  was left out (`sync-worker/src/events/export-route.ts::handleExportSourceRequest`),
  and `src/lib/export/exporters/docx.ts::exportDocx` and
  `src/lib/export/exporters/pptx.ts::exportPptx` return the uploaded package
  when they spliced nothing. Which formats hold the rule, and why the rest
  (SRT, VTT, XLIFF, TMX, CSV, TSV, Markdown, HTML) still rebuild, is recorded
  in `src/lib/export/byte-fidelity.ts::UNTOUCHED_EXPORT_FIDELITY` and locked
  to its proof by `src/lib/export/untouched-export.soak.test.ts`. That
  registry does not claim IDML yet: the engine returns the upload for an empty
  translation list, but the `NoBreak` repair pass above runs on every export
  and rewrites a member holding an over-long `NoBreak` run whether or not
  anything was translated, and no soak case covers the untouched IDML export.
- Nothing in the app surfaces the distinction to a user: there is no "this
  export is byte-identical to your upload" signal in the export dialog.
