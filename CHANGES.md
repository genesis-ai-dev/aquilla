# CHANGES — Matecat Parity Run (matecat-parity-2026-07-04)

Branch: `claude/aquilla-matecat-parity-zdcu73`, base `e43f18d`.
Every file below is grouped by capability. Companion documents:
`PARITY_MATRIX.yaml` (frozen scorecard), `BATCH_ENDPOINT_CONTRACT.md`,
`QA_TEST_PLAN.md`, `ITERATION_LOG.md`, `PARITY_FINAL_REPORT.md`.

## Headline

- Parity score **100.0% weighted** — P0 33/33, P1 15/15, P2 3/3, EXCEEDS 5/5.
- Round-trip structural fidelity **100% dev (122/122) and 100% holdout (82/82)**,
  re-verified after the seeded 10% holdout refresh.
- All 3,385 pre-existing root tests green; zero pre-existing tests deleted,
  skipped, or loosened (F5). `tsc -b` clean. One pre-existing eslint error
  remains in `src/components/EditorTable.tsx` (react-hooks refs; file untouched
  by this run).

## New dependencies

| Package | Version | License | Where | Why |
|---|---|---|---|---|
| `yaml` | ^2.9.0 | ISC | devDependency | parse PARITY_MATRIX.yaml in the scorer |

No other dependencies added. No external paid resources used (C3).

## Migrations

**None.** All governance state uses the existing versioned JSON blobs
(`org_settings.settings.enterprise`, `project_settings.settings.contributeToGlobalTm`)
— zero schema changes, trivially reversible (C6 satisfied vacuously).

## Feature flags / gating

- **Batch API** (`src/lib/batch/*`): library + in-process stub only. NOT mounted
  on any Worker route — the real endpoint must implement
  `BATCH_ENDPOINT_CONTRACT.md` and pass `parity/batch/contract.test.ts`. Net
  new surface: OFF by construction.
- **Global few-shot / TM governance** (`src/lib/global-tm/*`,
  `src/lib/entitlements/*`): inert library, nothing existing imports it yet.
  Worker wiring (backed by `cells_fts`/`value_tsv`) is follow-up work and must
  keep the read-path exclusion + write gate exactly as tested.
- **Export fidelity report in ExportDialog**: additive UI (amber warning list
  after a successful export), enabled by default **at the principal's explicit
  direction** ("warnings about inline style mismatches… critical") — a logged
  deviation from the C7 default-off convention. No export byte output changed.
- All legacy exporters (`exportPlainText`, `exportMarkdown`, `exportXliff`,
  `exportTmx`, `exportVtt`) are byte-identical; round-trip behavior ships as
  NEW sibling functions (C7).

## ADRs (C5)

None required — no substrate contract (auth, sync/event grammar, Living
Memory, health internals) was modified. The import/export additions ride on
existing public interfaces (`TranslatableString.metadata`, exporter modules).

## Files by capability

### Importers/exporters — text family
- `src/lib/parsers/plaintext.ts` (M): CRLF/CR normalization bugfix (Windows
  files no longer import as one giant paragraph).
- `src/lib/export/exporters/plaintext.ts` (M): + `exportPlainTextStructured`
  (paragraph-preserving; legacy export untouched).
- `src/lib/parsers/markdown.ts` (M): additive `metadata.md.listKind/index` so
  ordered lists round-trip as ordered.
- `src/lib/export/exporters/markdown.ts` (M): + `exportMarkdownStructured`
  (heading levels, ordered/unordered markers, list grouping, no anchor
  comments).
- `src/lib/export/exporters/srt.ts` (A): SRT exporter (numbered cues, ms
  timecodes, tag passthrough).
- `src/lib/export/exporters/vtt-structured.ts` (A): CAT-grade VTT export
  (payload tags verbatim, `<v>` from imported speaker).
- `src/lib/export/exporters/structured-roundtrip.test.ts` (A): unit tests.

### Importers/exporters — XLIFF / TMX
- `src/lib/parsers/xliff.ts` (M): additive `XliffSegmentMeta` capture (unit/seg
  ids, states, inline-tag skeletons via a deterministic serializer); code-aware
  text extraction (bpt/ept/ph/it content is native code per spec; `<sub>`
  re-enters); exported helpers `serializeInner`, `codeAwareTextContent`,
  `fragmentText`.
- `src/lib/export/exporters/xliff12-structured.ts` (A): skeleton-aware XLIFF
  1.2 export, status→state mapping, OASIS-XSD-valid.
- `src/lib/export/exporters/xliff20.ts` (A): XLIFF 2.0 export (unit/segment
  regrouping, NMTOKEN sanitation, spec-enum states), OASIS-XSD-valid.
- `src/lib/parsers/tmx.ts` (M): additive `TmxSegmentMeta` skeleton capture;
  code-aware extraction.
- `src/lib/export/exporters/tmx-structured.ts` (A): TMX 1.4b export with
  Matecat-style keep/strip-tags variants, DTD-valid.
- `src/lib/import/xliff-reimport.ts` (A): offline round-trip matcher
  ("XLIFF to Target" analog) — unit-id then source-text matching, unmatched
  reported.

### Importers/exporters — office / structured formats
- `src/lib/export/exporters/docx.ts` (M): additive `warnings` field on
  `DocxExportResult` (mixed-run formatting simplification per paragraph).
- `src/lib/export/exporters/pptx.ts` (A) + `pptx.export.test.ts` (A): PPTX
  skeleton-injection exporter mirroring docx (group-mapped paragraphs,
  first-run styling, paired empty `<a:t></a:t>` normalization, `warnings`).
- `src/lib/parsers/html.ts` (A) + `html.test.ts` (A): HTML block extractor
  (outermost-leaf rule, script/style skipped, list-kind metadata) + skeleton
  exporter.
- `src/lib/parsers/json-i18n.ts` (A) + tests: JSON i18n resources (path-keyed
  leaves, indent preservation, structure untouched).
- `src/lib/parsers/po.ts` (A) + tests: gettext PO (plurals, msgctxt, comments;
  byte-preserving export that rewrites only msgstr lines).
- `src/lib/parsers/properties.ts` (A) + tests: Java .properties (escapes,
  continuations, separator styles preserved on export).
- `src/lib/parsers/sbv.ts` (A) + tests: YouTube SBV subtitles (import).
- `src/lib/import.ts` (M): `arrayBufferToBase64` exported (Download-Original
  acceptance); no behavior change.

### Export fidelity (block styles + inline-style warnings)
- `src/lib/export/fidelity.ts` (A): `compareBlockStyles` (round-trip block
  comparator: type, heading level, list kind) and
  `collectInlineStyleWarnings` (XLIFF/TMX skeletons, originalHtml blocks,
  subtitle payload tags → per-segment warnings).
- `src/components/ExportDialog.tsx` (M): renders the fidelity report after
  docx / single-file / project-zip exports; state reset on close. Only UI
  addition of the run.

### Analysis (volume/word counts)
- `src/lib/analysis/wordcount.ts` (A): Matecat counting rules (CJK per-char,
  URLs/numbers once, punctuation excluded) + per-file/project aggregation.
- `src/lib/analysis/buckets.ts` (A): repetition + windowed internal-fuzzy
  (75–99% Dice) bucketing.
- `src/lib/analysis/payable.ts` (A): frozen default rate table + custom
  billing models, band breakdown, discount %.

### QA checks
- `src/lib/qa/checks.ts` (A): tag consistency (blocking/error/warning tiers,
  placeholder syntaxes), whitespace, special symbols, format-tolerant numbers,
  project-wide translation conflicts.
- `src/lib/qa/termbase.ts` (A): Matecat-template spreadsheet termbase →
  existing `Concept` model (forbidden/notes columns).
- `src/lib/qa/glossary.ts` (A): missing-approved-rendering (count rule) +
  forbidden-term checks on Concepts.

### Workflow
- `src/lib/workflow/autopropagation.ts` (A): repetition propagation engine
  (validated cells protected).
- `src/lib/workflow/stats.ts` (A): per-status segment/word counts + completion
  % (Matecat stats analog).

### Batch translation (C4)
- `src/lib/batch/types.ts`, `src/lib/batch/pipeline.ts` (A): contract types +
  transport-agnostic `BatchService` (validation, idempotency, capability
  tokens, cursor pagination, per-segment failure isolation, cancel, few-shot
  retrieval with `examplesUsed` audit).
- `parity/batch/stub-server.ts` (A): reference in-process endpoint.
- `parity/batch/contract.test.ts` (A): canonical contract-suite location.

### TM governance (F6 / C8)
- `src/lib/entitlements/entitlements.ts` (A): billing stub + paid
  `global-tm-opt-out` feature; effective `contributeToGlobalTm` (default TRUE).
- `src/lib/global-tm/index.ts` (A): global retrieval index; enterprise-org and
  opted-out-project exclusion enforced inside `retrieve()` (non-bypassable,
  read-time re-check); write gate in `contribute()`.

### Run infrastructure (parity/)
- `PARITY_MATRIX.yaml` (A): frozen matrix + 2 logged post-freeze appends.
- `BATCH_ENDPOINT_CONTRACT.md` (A): frozen API contract.
- `parity/instruments/*.ts` (A): parity:score, roundtrip:score (frozen, F7),
  time, spend.
- `parity/corpus/generate.ts` + 204 corpus files + `split.json` (A): seeded
  corpus, committed split (F2), holdout refresh mode.
- `parity/roundtrip/{checks.ts,runner.test.ts,ooxml-check.py}` (A): frozen
  fidelity checks — xmllint vs official OASIS XSDs / TMX DTD, python-stdlib
  OOXML structural diff (F4), blinded holdout reporting.
- `parity/roundtrip/adapters.ts` (A): format→parser/exporter wiring (the
  non-frozen surface under test).
- `parity/schemas/*` (A): vendored official schemas; only `schemaLocation`
  hints repointed to the local `xml.xsd`.
- `parity/acceptance/*.test.ts` (A): 12 tagged acceptance suites (69 tests).
- `parity/vitest.config.ts` (A); `vite.config.ts` (M): `parity/**` excluded
  from the default suite (acceptance rows are red-by-design until built).
- `package.json` (M): parity scripts + `yaml` devDep; `pnpm-workspace.yaml`
  (M): `onlyBuiltDependencies` drops `onnxruntime-node` (its postinstall
  downloads binaries, blocked by the sandbox proxy; runtime unaffected —
  the app uses `onnxruntime-web`).
- `ITERATION_LOG.md`, `parity/run-meta.json`, `parity/spend-ledger.json` (A).

## Test-change ledger (F5)

- Pre-existing tests: **zero modified, skipped, or deleted.**
- New tests added this run: ~200 across acceptance + colocated suites.
- One new-this-run fixture expectation corrected mid-run (TMX `{0}` inside
  `<ph>` is native code, excluded from text) — logged in ITERATION_LOG cycle 3.
