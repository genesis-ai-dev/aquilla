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
- **What was tried / result:** (filled in at freeze, below)
