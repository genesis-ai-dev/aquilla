# Research plan and status

Where each phase of [SPEC.md §7](SPEC.md) stands, what evidence exists for
each stop condition (§9), and what to do next. Gate A numbers are in
[GATE-A.md](GATE-A.md).

## Phase status

| Phase | Exit criterion | Status | Evidence |
|---|---|---|---|
| 1 Functional core | Native files survive extraction and no-op round-tripping | **Met (structurally)** | Byte-identical no-op round trip on 10 IDML files incl. 9 real InDesign exports; every non-story ZIP record byte-identical after translation. Not yet opened in InDesign. |
| 2 Incremental updates | A source edit updates relevant target content without destroying unrelated work | **Met** | `test/lifecycle.test.ts`; Gate A stability/incremental rows: 0 unaffected units retranslated, 406/406 human edits survived random source edits. |
| 3 Layout assurance | Editable publication + trustworthy exception report | **Partial** | Report + estimator + repair proposals exist; trust requires the InDesign oracle ([LAYOUT.md](LAYOUT.md)). |
| 4 Ambient operation | A customer completes a real update without operating a TMS | **Mechanism ready, untested with a customer** | Watched folder, edits in place, WebDAV "any language" drive, MCP agent tools. No remote drive connector yet. |
| 5 Generality | Second adapter without redesigning sync/decisions | **Met (two extra formats)** | Markdown (no native ids) and JSON strings (all native ids) on an unchanged core; same lifecycle tests pass. |

## Stop conditions — current evidence

| Stop condition | Evidence so far | Signal |
|---|---|---|
| Round-tripping requires rebuilding InDesign's document model | Surgical slot replacement + per-member merge was enough for every construct in the corpus; nothing re-serialised | 🟢 so far — but real customer files will be the test (tables-in-tables, tracked changes, XML-tagged workflows, linked stories) |
| Identity reconciliation needs extensive human intervention | 0 wrong attributions, ~98% recall, ambiguity < 0.1% on generated edits | 🟢 on synthetic edits; measure on the customer's real revision history |
| Incremental costs more than regeneration | 2% edit → 2% of translation jobs; engine overhead ≈ one full extraction/render (~0.6 s per 1,000 paragraphs) | 🟢 |
| Review and layout repair eat the savings | Unknown: depends on real overset rates and translation quality | ⚪ measure in the engagement |
| Second adapter needs format-specific core changes | None needed for Markdown or JSON | 🟢 |
| Customers prefer their existing workflow | Unknown | ⚪ Gate B/C |
| Value is bespoke conversion, not software | Unknown | ⚪ watch how much per-customer adapter work the engagement needs |

## Next steps, in order

1. **Get the engagement's real IDML in.** Run `pnpm gate` on it (drop files
   into `fixtures/private/`, git-ignored — add the path to the gate's corpus).
   Every unsupported construct the extractor reports is a concrete work item.
2. **Close "opens in InDesign".** Wire the InDesign Server UXP gate from
   aquilla (`docs/IDML_ADOBE_VALIDATION.md`) as a `LayoutOracle`; produce the
   real Gate A integrity and overset rows.
3. **Real translation quality loop.** Run the Claude translator on the
   corpus; measure tag-validity failure rate, `FORMATTING_SIMPLIFIED` rate,
   and reviewer edit distance. Feed accepted corrections and approved
   human translations as few-shot context (already plumbed through `prior`).
4. **Set `AppliedLanguage`** on translated character ranges (hyphenation).
5. **A remote source.** Google Drive or a shared folder sync as the first
   connector (Phase 4). The workspace abstraction only needs read/write bytes
   + change notifications.
6. **Customer pilot instrumentation (Gate B).** Log setup time, first-output
   time and human handling time per update from the ledger itself (facts
   already carry HLC timestamps and actors).
7. **Decide reuse of aquilla's `packages/idml-roundtrip`.** It is a stricter,
   more battle-tested slot engine (locators, legacy migration, Adobe gate).
   This repo's IDML adapter is ~1,000 lines and was built to prove the
   architecture; if the engagement needs Aquilla parity, put the v2 engine
   behind the `ContentAdapter` interface instead of growing this one.

## Gate B / C experiments (cannot be measured in code)

- **Setup ≤ 15 min:** time a non-technical person from zero to first
  translated file using only `ambient init` + a folder (or a hosted
  equivalent). Record where they stall.
- **≥ 80% less handling time:** shadow the customer's current update cycle
  for one real publication change; repeat with ambient sync; compare
  minutes of human handling (not machine time).
- **Context compounds:** from the ledger, count corrections per 1,000 units
  across successive cycles; expect it to fall as terms and approvals accumulate.
- **Integration is the value:** offer pilots both the folder flow and a plain
  upload/download page with identical translation; record which they use.
- **Willingness to pay:** price the maintained capability (per document set
  per language per month), not per word.

## Decisions waiting for you

1. Which customer files can enter the test corpus, and under what handling
   rules (keep them out of git; the gate never writes source text to reports).
2. Default policy when the source changes under a human translation:
   `revise` (current default: model edits the human text, flagged) or `hold`.
3. Whether this stays a standalone repo or becomes `packages/ambient` in
   aquilla once the engagement validates it.
4. Hosted shape for Phase 4: Cloudflare Worker + R2 (matches aquilla) vs a
   desktop/folder agent (matches "drop files in a folder").

## Ideas from the origin note, mapped

| Idea | What exists | Next |
|---|---|---|
| "All the context under the hood" | Terms, rules, corrections, prior human translations and neighbours flow into every request; context revisions make it incremental | Import Aquilla org decisions/termbase |
| "Generate the UI you need live" | MCP `ambient_view` writes a focused review page for exactly the units under discussion | Let the agent choose the view shape (diff, table, side-by-side PDF preview) |
| "Lives in all your normal tools" | Folder, InDesign (edit the translated file), any editor, WebDAV mount, Claude via MCP | Drive, Git (PR per language), email digest of the sync report |
| "Drop files in a folder, open them in any language" | `translations/<lang>/`, `ambient open --in`, `/files/<lang>/…`, `/dav/<lang>/…` | A real OS-level virtual drive (FileProvider / FUSE) |
