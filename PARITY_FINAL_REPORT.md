# FINAL REPORT — Matecat Parity Run (matecat-parity-2026-07-04)

## Scores vs exit criteria

| Criterion | Bar | Result |
|---|---|---|
| Parity score (P0) | 100% | **33/33 = 100%** ✓ |
| Parity score (P1) | ≥90% | **15/15 = 100%** ✓ |
| Parity (P2, no bar) | — | 3/3 |
| Weighted total | — | **100.0%** |
| Round-trip fidelity, HOLDOUT | ≥98% | **82/82 = 100%** ✓ (held after seeded 10% refresh) |
| Round-trip fidelity, dev | — | 122/122 = 100% |
| Batch contract tests | green | 10/10 ✓; throughput 10k segments ≪ 5-min bar |
| Few-shot exclusion (F6) | zero leaks | 500 property queries + red-team probes, **0 leaks** ✓ |
| Pre-existing tests | all green | 3,385/3,385 ✓ (none modified/skipped/deleted) |
| EXCEEDS rows | green every cycle | 5/5 green at every scored cycle ✓ |

Scoring commands: `pnpm parity:score`, `pnpm roundtrip:score [--dev|--holdout]`.

## Budget

- **Wall clock:** exit criteria met at **2h21m**; principal's mid-run
  block-style/inline-warning directive absorbed and green by **~2h35m**;
  deliverables complete comfortably inside the **10h** budget. Phase 0 matrix
  freeze at 15m (bar: 90m); corpus+instruments complete at ~1h38m.
- **Spend:** ~1.2M tokens estimated across 10 cycles (ledger:
  `parity/spend-ledger.json`; `pnpm parity:spend`). Largest line items were
  Phase-0 research (~250k) and the parallel P1 format sweep (~320k). No
  external paid resources used.

## What a commercial buyer gets now

- **Import AND round-trip export** for XLIFF 1.2/2.0 (OASIS-schema-valid, tag
  skeletons preserved, Matecat-compatible state mapping), TMX 1.4 (DTD-valid,
  with/without tags), DOCX and PPTX in the original file, HTML, JSON, PO,
  .properties, CSV/TSV, TXT, Markdown (heading levels + ordered lists intact),
  SRT/VTT (ms-precise timecodes, voice tags), SBV/XLSX import.
- **Fidelity honesty:** per-export warnings whenever inline formatting could
  not be carried into an edited translation (beyond Matecat's documented
  surface), plus a block-style round-trip comparator used by the scorer.
- **Analysis:** Matecat-rule word counts, repetition/internal-fuzzy buckets,
  payable words with the documented default rates and custom billing models.
- **QA:** tag/whitespace/symbol/number/conflict checks, spreadsheet termbase
  import onto Aquilla's Concept model, glossary QA with forbidden terms.
- **Batch API:** frozen contract + reference stub + conformance suite the real
  endpoint must pass; pipeline with idempotency, capability tokens, streaming
  pagination, per-segment failure isolation, few-shot audit counts.
- **Global-TM governance:** enterprise-org exclusion and per-project opt-out
  entitlement, adversarially tested with canaries.

## Remaining gaps, ranked by commercial impact

1. **HIGH — Wiring the new libraries into the product surface.** Batch API is
   not mounted on a Worker; global few-shot retrieval is not wired into the
   copilot/branching-search; QA checks and autopropagation are not surfaced in
   the editor; PPTX/HTML/JSON/PO/properties exporters are not yet options in
   ExportDialog (DOCX and the text family are). The libraries are tested and
   contract-frozen; the wiring is deliberate follow-up so each surface can go
   behind its own flag.
2. **HIGH — >512 KB DOCX/PPTX side-car cap.** Original-format export only
   works for files ≤512 KB (D1 row limit). Migration 0046 already adds
   `r2_key` columns; the R2 blob path needs Worker code. Until then large
   office files cannot round-trip.
3. **MEDIUM — Tag placement in edited targets (Guess Tags analog).** Edited
   translations export as plain text with a warning; Matecat places tags via
   an ML model. Ours is honest but manual.
4. **MEDIUM — Legacy CAT interop formats** (SDLXLIFF/TTX/TXML), IDML, DITA,
   RTF/legacy Office, PDF/OCR conversion tier — enumerated in the matrix
   research but out of scope this run.
5. **LOW — TM lookup bands (75–99/100/101 ICE) against the global index** in
   the analysis flow; job splitting; revision R2 workflow parity.

## Three highest-risk areas for human review

1. **TM governance semantics before any Worker wiring ships**
   (`src/lib/global-tm/index.ts`, `src/lib/entitlements/entitlements.ts`):
   the exclusion invariants are only as good as the resolvers the Worker
   injects (`org_settings.settings.enterprise`,
   `project_settings.settings.contributeToGlobalTm`). Re-run the canary suite
   end-to-end against the real database, and decide the intended behavior for
   unentitled opt-outs once real billing exists (currently: opt-out only takes
   effect WITH the paid feature; the stub grants it to everyone).
2. **Skeleton-reuse equality checks in XLIFF/TMX exporters**
   (`fragmentText` comparisons): whitespace-sensitive edge cases (xml:space,
   exotic entities) could mis-classify an unedited target as edited (safe:
   tags dropped + warning) or, worse, the reverse. The corpus covers BOM/CDATA
   /entities, but a human should eyeball exports from one real customer XLIFF.
3. **ExportDialog integration** (`src/components/ExportDialog.tsx`): the only
   UI file touched. Verify the warning panel renders correctly across brands
   and that no export path regressed (manual pass per QA_TEST_PLAN §1–2).

## Process notes (fences)

- Clean room (C1): all Matecat evidence is public docs/guides URLs recorded
  per matrix row; no Matecat source was read by the run or its subagents.
- The scorer (F7) was never modified after freeze. One scorer limitation was
  logged rather than "fixed" (re-parse checks can't see tag stripping; the
  acceptance rows cover it). The single scorer-adjacent product change
  (paired empty `<a:t></a:t>`) is documented in ITERATION_LOG cycle 8 with an
  overfit reflection.
- Matrix appends: 2 rows (cycle 10, principal directive), both P0, both green.
- Holdout blinding (F2) held: holdout files were never opened/diffed; the
  holdout report prints aggregates + blinded check names only.
