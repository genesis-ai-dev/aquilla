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
