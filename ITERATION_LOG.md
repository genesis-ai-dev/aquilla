# ITERATION_LOG — Matecat Parity Run (matecat-parity-2026-07-04)

Append-only. One entry per cycle. Re-read at the start of every cycle.
Format per entry: time instrument snapshot, hypothesis, expected failure mode,
what was tried, diagnostic result, metric delta, overfit reflection (F1–F7 check).

---

## Cycle 0 — Phase 0: derive & freeze the target

- **Start:** 2026-07-04T15:12:09Z (elapsed 0h00m; remaining 10h00m; Phase 0 deadline 16:42Z)
- **Spend:** ~250k tokens est. (4 research/recon subagents + scaffolding)
- **Hypothesis:** Matecat's commercial surface can be decomposed into ~40–60 capability rows
  from public docs alone; Aquilla already covers a meaningful fraction (existing xliff/tmx/docx/
  pptx/subtitle/csv parsers + export service), so the matrix will concentrate net-new work in:
  XLIFF/TMX round-trip export fidelity, analysis/word-count, batch API, few-shot global retrieval
  with enterprise exclusion, and TM opt-out entitlement.
- **Expected failure mode:** docs too vague on round-trip fidelity specifics → mitigate by writing
  behavioral acceptance tests from black-box descriptions, never from Matecat source (C1).
- **Provenance note (C1):** all Matecat evidence in PARITY_MATRIX.yaml is public doc/guide URLs.
  No Matecat source files were opened by this run or its subagents (research agents were
  explicitly instructed docs-only).
- **What was tried / result:**
  - 4 research subagents (3× Matecat public docs, 1× Aquilla codebase map). Matrix (39 rows +
    5 EXCEEDS) frozen 15:27Z; BATCH_ENDPOINT_CONTRACT.md frozen alongside.
  - Corpus: 204 seeded files / 17 formats; split 122 dev / 82 holdout committed BEFORE
    inspection (seed 20260704).
  - Instruments: parity:score, roundtrip:score (xmllint + python-stdlib OOXML validators),
    parity:time, parity:spend all running. Scorer FROZEN 16:50Z.
  - **Baselines:** parity 0.0% weighted (0/31 P0, 0/15 P1, 0/3 P2; EXCEEDS 5/5 green).
    Roundtrip dev 57/122 = 46.7% (green: csv, docx, tmx, tsv, xliff12, xlsx; red: html/json/
    po/properties/sbv no parser, srt/pptx/xliff20 no exporter, txt/md paragraph-structure
    loss, vtt 6/7).
- **Diagnostic notes:** (1) One adapter bug found+fixed (docx/pptx parsers are async).
  (2) Known scorer limitation, logged not "fixed": reparse-sources cannot detect inline-tag
  stripping because both parse passes strip tags — tag preservation is enforced by the
  fmt.xliff*.import acceptance rows instead. Scorer stays frozen (F7).
- **Overfit reflection:** corpus + split generated from a committed seed before inspection;
  no eval-shaped code exists yet. Building general parsers/exporters next, not corpus-shaped
  special cases.
- **Elapsed at cycle end:** 1h38m (matrix froze at 15m; research+install+corpus dominated).

---

## Cycle 1 — Text-family round-trip P0 rows (txt/md/srt + acceptance for green formats)

- **Hypothesis:** exportPlainText/exportMarkdown lose paragraph/block structure (roundtrip
  shows txt 3/7, md 0/7); an SRT exporter is missing entirely. Fixing exporters to preserve
  block structure + writing tagged acceptance tests flips 6 P0 rows (txt/csv/tsv/srt/vtt/md)
  and lifts roundtrip ~15 pts.
- **Expected failure mode:** changing exporter output breaks pre-existing assertions in
  cat-roundtrip.test.ts / exporters.test.ts that pin the old (one-way) behavior — F5 requires
  logging any assertion change here: changes will be strictly strengthening (one-way → true
  round-trip), never loosening.

- **Result (c1):** roundtrip dev 46.7% → 62.3%; txt/md/srt/vtt 100%. Root causes were real
  product gaps (paragraph structure dropped on export, no SRT exporter, VTT tags stripped,
  CRLF import bug) — not corpus quirks. All pre-existing tests stayed green; new exporters
  additive per C7. Overfit reflection: fixes are format-spec-driven, none keyed to corpus
  content. No F-violations.

---

## Cycle 2 — XLIFF 1.2/2.0 block
- **Hypothesis:** capturing an inline-tag skeleton at import (metadata.xliff) lets exporters
  re-emit tags verbatim; schema-valid 1.2 + 2.0 exporters flip 7 P0 rows.
- **Result:** roundtrip dev 62.3% → 70.5% (xliff20 0→100%). One design correction mid-cycle:
  "unedited" detection must compare against the imported TARGET text, not the source.
  8 tagged acceptance tests green; xmllint/OASIS XSD validation used throughout (F4).
- **Overfit reflection:** skeleton capture is spec-shaped (works for any XLIFF), not
  corpus-shaped. No enumeration lists added (F3 clean).

## Cycle 3 — TMX + DOCX + Download-Original P0 rows
- **Result:** TMX skeleton + keep/strip-tags export variants (DTD-validated); code-aware text
  extraction (bpt/ept/ph/it content is native code per spec — excluded from segment text,
  <sub> re-enters). My own new fixture initially encoded the WRONG expectation ({0} in text);
  corrected the test, not the spec. fmt.export.original pinned to the real 512KB sidecar
  boundary — the >512KB gap is documented, not hidden. Full default suite 3311 green.
- **F5 note:** no pre-existing assertions changed in c1–c3; only additive tests.

## Cycle 4+5 — analysis + QA libraries
- **Result:** wordcount (CJK chars/URLs/numbers/punctuation rules), repetition +
  internal-fuzzy bucketing (windowed Dice), frozen payable rate table w/ custom models;
  QA checks tags/whitespace/symbols/numbers/conflicts. 16 acceptance tests green first run.

## Cycle 6 — batch pipeline
- **Result:** BatchService + stub implementing the frozen contract; 10 contract tests green;
  throughput 10k segments ≈ instant vs 5-min bar. Cursor encoding rewritten without Buffer
  (Workers/browser compat).

## Cycle 7 — TM governance (F6/C8)
- **Result:** P0 31/31 (100%) — weighted 40.5% → 78.6%. Global-TM index with read-path
  enterprise + opt-out exclusion (non-bypassable, defense-in-depth vs legacy rows), write
  gate, billing-stubbed entitlement (default contribute=TRUE; opt-out requires paid feature).
  500 seeded property queries + red-team probes: zero canary leaks.
- **Overfit reflection:** canaries/queries are synthetic and seeded; exclusion logic filters by
  org/project resolvers, not by canary patterns — a new enterprise org is excluded without
  code change. No eval-shaped artifacts.

## Knob audit (5-cycle checkpoint)
Highest effort-to-gain so far: (1) corpus generator OOXML plumbing (large upfront cost, paid
off across docx/pptx/xlsx rows — keep, already sunk); (2) chasing per-file dev failures one
at a time in c1 (switch: batch by failure-check histogram first); (3) hand-writing long
acceptance fixtures (keep minimal fixtures; prefer spec-driven cases). No change type banned
yet; spend/pace healthy (P0 cleared at ~2h elapsed of 10h).

## Cycle 8 — P1 format sweep (parallel subagents) + workflow/glossary libs
- **Hypothesis:** the five remaining format modules (html, json-i18n, po, properties+sbv,
  pptx exporter) are independent; parallel subagents with tight specs clear them in one
  wall-clock cycle while the main loop implements workflow/glossary/termbase/reimport rows.
- **Result:** roundtrip dev 70.5% → 95.1% (all formats but PO green), then 100% once the PO
  agent landed. One scorer-interaction incident, resolved on the exporter side: blanked PPTX
  runs serialized self-closing (<a:t/>) and dropped out of the frozen validator's element
  count — fixed by emitting paired empty tags, which is what ECMA-376 producers write anyway.
  Scorer untouched (F7).
- **Overfit reflection:** the <a:t/> normalization is the closest this run came to an
  eval-shaped change; judged legitimate because it aligns the exporter with real-producer
  convention rather than special-casing corpus content. No enumeration lists anywhere (F3).

## Cycle 9 — PO lands; exit criteria met; holdout checkpoint
- **parity:score 100.0% weighted** (P0 31/31, P1 15/15, P2 3/3, EXCEEDS 5/5).
- **roundtrip dev 122/122 = 100%; holdout 82/82 = 100%** — and still 82/82 after the
  mandated 10% holdout refresh with a fresh sub-seed (cycle-8 refresh, seed 1584035895),
  so the number is not memorized aggregates.
- Full default suite 3385 green; lint errors introduced by the run fixed; the single
  remaining lint error is pre-existing (src/components/EditorTable.tsx, untouched).
- **Elapsed at exit-criteria-met: 2h21m of 10h.** Remaining budget goes to deliverables and
  stabilization, per plan.

## Cycle 10 — principal directive: block-style round trips + inline-style warnings
- **Trigger:** user message mid-run: "make sure the import/export loops are *round trips*
  with full fidelity checks for block styles and warnings about inline style mismatches."
- **Matrix change:** APPENDED two P0 rows (fmt.blockstyle.fidelity, qa.inline-warnings) —
  append-only rule respected; justification: explicit principal scope addition. Weighted
  score recomputes over the larger denominator (score may drop until rows pass — expected).
- **Known real gaps this targets:** (1) markdown ordered lists re-export as "- " unordered;
  (2) docx mixed-run inline formatting silently simplified; (3) pptx multi-run paragraphs
  collapse to first-run styling; (4) xliff/tmx edited targets lose inline tags with no
  user-visible signal; (5) html translated blocks lose inline markup silently.
- **Plan:** md parser records list kind/index additively (metadata.md) + exporter re-emits
  ordered markers; new src/lib/export/fidelity.ts (block-style comparator + inline-style
  warning collector); docx/pptx export results gain additive `warnings`; ExportDialog renders
  the report (additive UI; default ON at the principal's direction — logged deviation from
  the C7 default-off convention for this one surface).
- **Result (c10):** both appended rows GREEN — P0 33/33, weighted 100% over the enlarged
  matrix. Implemented: markdown ordered-list round-trip (metadata.md.listKind + numbered
  markers, adjacent items joined as one list), html list-kind capture, fidelity module
  (block-style comparator + inline-style warning collector covering XLIFF/TMX skeletons,
  originalHtml blocks, subtitle payload tags), docx/pptx exporters now return per-paragraph
  mixed-formatting warnings (additive result field), and ExportDialog renders the fidelity
  report after every export (docx, single-file, and project-zip paths). Full suite 3385
  green; roundtrip dev 100% unchanged; tsc/eslint clean (1 pre-existing EditorTable error).
- **Overfit reflection:** the warning collector keys on structural properties (skeleton
  metadata, originalHtml, tag multisets), not on any corpus/test content. The comparator was
  verified to actually catch degradation (ol→ul fault-injection assertion), so the check is
  falsifiable, not decorative.

---

## Run close-out (2026-07-04 ~17:50Z)

Final instruments: parity 100.0% weighted (P0 33/33, P1 15/15, P2 3/3, EXCEEDS 5/5);
roundtrip dev 122/122 and holdout 82/82 (post-refresh); batch contract 10/10 with
throughput far under bar; F6 canaries zero leaks; default suite 3385 green; tsc clean;
1 pre-existing eslint error (EditorTable.tsx, untouched). Deliverables: PARITY_MATRIX.yaml,
BATCH_ENDPOINT_CONTRACT.md, CHANGES.md, QA_TEST_PLAN.md, PARITY_FINAL_REPORT.md, this log.
Wall clock at close ≈ 2h40m of 10h. Remaining gaps and review priorities are in
PARITY_FINAL_REPORT.md (§gaps, §risk areas).

## Cycle 11 — user-facing round-trip exports (principal directive, part 2)
- The parity adapters were using the structured exporters but the USER-facing
  ExportDialog/project-zip still called the legacy one-way ones — exactly the gap the
  principal's "output users expect" message targets. Switched txt/md/xlf/tmx to the
  structured exporters, added SRT as an export option, refreshed option descriptions.
- VTT deliberately stays on the cast-aware legacy exporter (the TTS/cast voice-tag workflow
  is a product behavior, not an accident); fidelity warnings still fire on tag mismatches.
- **F5 ledger:** one pre-existing assertion modified WITH justification (project-zip md test
  pinned anchor comments, which are incompatible with round-trip re-import; new assertion
  pins the anchor-free output; legacy exportMarkdown + its own tests untouched).
- **C7 ledger:** this changes default export output by explicit principal direction —
  logged as a sanctioned deviation (same as the warnings panel).
