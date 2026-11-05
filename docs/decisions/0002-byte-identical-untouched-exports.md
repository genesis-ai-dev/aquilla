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

- The guarantee is stated for the IDML package path only. The other exporters
  render from cells (`src/lib/export/export-service.ts`) and make no byte-level
  promise; a USFM or DOCX export of an untouched project is *equivalent*, not
  identical.
- Nothing in the app surfaces the distinction to a user: there is no "this
  export is byte-identical to your upload" signal in the export dialog.
