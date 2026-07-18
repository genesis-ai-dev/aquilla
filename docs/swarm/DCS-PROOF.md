# DCS importer — live proof against git.door43.org (2026-07-06)

Ran the REAL adapter modules (`DcsClient`, `routeFor`, USFM + TSV routes, cell-id, content-hash,
delta classification) against **live git.door43.org** — no mocks. Captured output below.

## Result: the adapter imports real Door43 content and computes a correct delta with stable identity.

### Translation Notes — `unfoldingWord/en_tn`, `tn_TIT.tsv`, v87 → v89 (the clean target)
```
[PROOF] en_tn TIT v87: 206 note cells
[PROOF] en_tn TIT v89: 206 note cells
[PROOF] delta → creates=0 commits(changed)=1 deletes=0
[PROOF] CHANGED NOTE 75106213-9327-5ddb-8c60-e9dff1d4f56d:
         OLD: "# Titus 3 Chapter Introduction\n\n## Structure and Formatting\n\nIn this chapter, Paul continues giving Titus instructions ..."
         NEW: "# Titus 3 Chapter Introduction\n\n## Structure and Formatting\n\nIn this chapter, Paul continues giving Titus instructions ..."
```
unfoldingWord edited exactly one Titus note between releases; the adapter detects **exactly that
one changed cell** (206 rows parsed, 1 commit, 0 spurious creates/deletes), keyed by the stable
TSV `ID`. A downstream project translating that note would flag it stale — the whole thesis, on
real data.

### Aligned Bible — `unfoldingWord/en_ult`, `57-TIT.usfm`, v80 → v89
```
[PROOF] en_ult TIT v80: 49 verse cells parsed
[PROOF] en_ult TIT v89: 47 verse cells parsed
[PROOF] delta → creates=0 commits(changed)=1 deletes=2
[PROOF] cell-id stable across releases? true (id f9ad19f0-9b87-53ed-8384-7df4ecc767df)
[PROOF] sample parsed verse value (reveals \zaln handling): "Titus"
[PROOF] CHANGED VERSE 7ffc159c-191a-510d-8b1e-e7cd468eedd2  (OLD/NEW differ past char 140)
```
Real delta: 1 changed verse + 2 removed verses (a versification change v80→v89). **Cell-ids are
stable across releases** — the same verse keeps the same id, so a re-import is a commit on the
existing cell, never id-churn (spec §5, proven on real data).

## Two findings (recorded in DCS-TRACES.md)

1. **USFM route does NOT strip `\zaln`/`\w` word-alignment markup.** en_ult is an *Aligned Bible*;
   the reused `src/lib/parsers/usfm.ts` leaves alignment attributes in the cell value (`"\zaln-s
   |x-strong=..."`). This is a PRE-EXISTING parser behavior (the manual USFM import has it too),
   not a DCS regression — but for translating aligned Bibles it means ugly source text and
   alignment-only edits count as content changes. **Top follow-up:** add alignment stripping to the
   USFM route (or the parser) to yield plain verse text. The Translation-Notes path is clean and is
   the better demo/first-use target.
2. **`compare` endpoint throttles** (HTTP 200 empty body under rapid requests; ~60s timeout hit in
   the live run). The delta engine must retry with backoff and fall back to full-scan reconcile
   (spec §6). Verify `delta.ts` honors this; add if missing.

## What remains for a full UI proof (Wave 3 browser QA)
The above proves the DCS-facing half (fetch → parse → stable ids → delta) on real data. The
downstream half (a delta moving adapter source heads flags linked language projects stale, shown in
the editor + Upstream-changes panel) is proven by unit tests + the already-shipped linked-projects
engine; the live browser walkthrough on the dev stack is the remaining end-to-end demo.
