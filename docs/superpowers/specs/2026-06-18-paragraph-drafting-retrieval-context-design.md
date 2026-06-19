# Paragraph-unit AI drafting + retrieval-compressed context — design

**Date:** 2026-06-18
**Status:** Approved design, pending implementation plan
**Related:** [`2026-06-17-translation-brief-design.md`](2026-06-17-translation-brief-design.md), [`2026-06-17-translator-profile-summary-design.md`](2026-06-17-translator-profile-summary-design.md), [`2026-06-12-translation-agent-design.md`](2026-06-12-translation-agent-design.md)

## Summary

Move the default AI-drafting unit from the **single cell** to the **paragraph** (an ordered group of cells), and feed the draft a **discourse window** (committed target text on the left, source on the right) plus **retrieval-compressed few-shot examples** matched on the *source* side. Lean on primitives that already exist (`text-splitter.ts`, `/search/passages`, `buildBatchPrompt()`, `compile.ts`). The goal is to fix the failures that kept v1 from gaining traction — discourse incoherence, participant-reference errors, translationese — while *reducing* prompt token cost, not raising it.

## Background — why (the v1 retrospective, condensed)

The per-cell "sparkle" draft was good at the parts experienced translators find **cheap** (fluency, project-term consistency) and bad at the parts they find **expensive** (discourse cohesion, participant reference, naturalness). Post-editing fluent-but-discourse-wrong text is *slower and more demoralizing* than drafting from scratch, so the feature imposed a net cost on the work that matters and burned first-impression trust with the reference cohort (SIL/UBS consultants). Three root causes, three workstreams:

1. **Per-cell generation structurally produces translationese** — it cannot restructure across sentence boundaries or track participants across a scene. → **Workstream A + B**: draft at the paragraph, with a discourse window.
2. **The prompt paid full token price for the *invariant* (raw few-shot dumps) every call**, leaving no room for the *variant* (discourse window, cast). → **Workstream C**: retrieval-compressed examples; compression is what *buys back* the budget for discourse context.
3. **Participant reference was invisible to the model** — no representation of who is on stage. → **Workstream D** (phase 2): a compact cast legend.

Two principles thread through all of it:

- **Never split below the alignment unit.** The source↔target cell correspondence is sacred — the whole alignment/BT/terminology stack depends on it. Paragraph is a *grouping over* cells, never a re-segmentation of them.
- **Don't pre-digest evidence through a weak model.** Compression here is *deterministic selection + truncation* (lossless within what's shown), not lossy summarization. The `bt-glosser` Markov aligner is explicitly kept **out** of the draft path: it is weak on low-resource targets and its noise would be read as ground-truth consistency.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Paragraph = an **ordered group of cells**, identified by a paragraph-start marker on a cell; membership is **derived** (scan to next paragraph-start). The cell stays the alignment + commit unit. | Reuses the existing `group` primitive; honors "never split below the alignment unit"; derive-on-read over materialize. |
| D2 | Splitting policy **branches by corpus type**. Scripture (USFM): verse stays the cell; paragraph detected from `\p`/`\q`/`\m`/`\b` markers *without* splitting the verse. Non-scripture (md/docx/txt): paragraph is the natural cell; recursive splitter sub-divides only when over the size threshold, sharing a `group`. | `\p` and `\v` are orthogonal in USFM; sub-verse splitting would shred alignment. |
| D3 | Default draft unit = the paragraph group, implemented as a **scoped batch** over its cells (reuse `buildBatchPrompt()` + `<vN>` fan-out). Single-cell "draft just this cell" remains as a fallback affordance. | Discourse coherence; the batch→per-cell commit seam already exists. |
| D4 | Prompt left-context = **committed target text** of preceding paragraph(s) within a token budget; right-context = **source** of following paragraph(s). Fall back to source on the left when no target is committed yet. | Target-side left-context is what gives real discourse flow (connectives, established reference). |
| D5 | Few-shot examples retrieved by **source-side** similarity via `/search/passages`; target carried via the existing pairing. Start with FTS lexical; add embeddings only if recall proves narrow. | Source is the high-resource side — safe for low-resource targets; no model touches the target. Lexical is deterministic and debuggable. |
| D6 | Each retrieved example is compressed by **source-span selection + ellipsis (`…`) truncation** with a ~10–20% context margin, snapping to the **same `BREAK_PATTERNS` boundaries** used by the splitter. **Source truncated freely; target left whole** unless a high-confidence alignment exists. | Truncating the target needs within-cell alignment we don't trust; cells are small, so little is gained by chopping them. |
| D7 | Terminology is an **optional enrichment**: when concepts exist, inject compiled rules (already done) *and* elide covered terms from examples (double compression). When absent, pure retrieval — nothing breaks. | Terminology is the cheapest invariant→legend compression, but must never be a dependency. |
| D8 | `bt-glosser` Markov aligner is **not** used in the drafting path. | Weak on low-resource languages; lossy summarization through a weak model injects misleading "consistency." |
| D9 | Participant/cast legend is **deferred to phase 2**, drawing on existing speaker data (`buildBulkCellsWithSpeakers`). | Highest-signal-per-token fix for reference, but exploratory; don't block the discourse win on it. |
| D10 | Context-window sizes are a **configurable project setting** (`draftContext` in `project_settings.settings`), exposing only the **L2 budgets** — preceding-target tokens, following-source tokens, examples tokens. **L1 (system + brief summary + terminology rules) is not configurable.** | You tune the *variant* layer, never the *invariant*. Keeps the cacheable prefix stable for prompt caching and matches the frequency-curve budget rule. |
| D11 | Paragraph draft **output protocol = the existing `<vN>` tagged-segment format**, keyed by **stable cell id** (not positional), parsed into per-cell commits. **Not** newline/special-token (newlines occur inside a cell — the prompt preserves line breaks) and **not** JSON (streams poorly; forces escaping of quotes/newlines that fill translations). Output is **verse-bounded**; cross-verse restructuring (verse bridges) is out of scope. | Tags stream cleanly (open→route live text→close finalizes), are newline-safe, need no escaping, and the parser + commit fan-out already exist. |

> **Reconcile loudly (D11):** match emitted tags to the paragraph's cells by id; a cell with no emitted content stays untouched and **flagged** (never committed empty); unknown/extra tags are discarded with a warning. Silent misalignment is the trust-killer that sank v1 — surface what didn't map.

## Context as a cache hierarchy

The drafting prompt is a vertical-agent context; structure it as L1/L2/L3:

- **L1 — resident every draft (the cacheable prefix / invariant):** system prompt + brief L1 summary + compiled terminology rules. Stable across the project. Pin with prompt caching; compress obsessively (terminology legend). *Not* user-configurable (D10).
- **L2 — per-paragraph variant:** discourse window (preceding committed target + following source) + retrieved/compressed examples. Changes per paragraph; this is where `draftContext` budgets apply.
- **L3 — escape hatch (already exists):** full brief L2 markdown via `docs('brief')`, full source document, raw `/search`. The agent descends here rather than guess.

Budget rule (mirrors the frequency curve): most tokens on the 80% — the paragraph being drafted plus its discourse window — a thin slice on examples, near-nothing on the tail. v1 inverted this (whole budget on re-dumped examples, no discourse window); the cache framing is how we keep it corrected.

**`draftContext` setting (proposed schema):** `{ precedingTargetTokens, followingSourceTokens, examplesTokens }`, each with a sane default and an app-level UI in project settings (lives beside `translationBrief` / `terminology` in the settings JSON blob).

## Design

### Workstream A — Paragraph as a grouping over cells

- **Primitive:** extend the existing `group` concept (`src/lib/parsers/types.ts` `TranslatableString.group`) into a stable **paragraph marker** on the cell that *starts* a paragraph. Membership = cells from one paragraph-start (inclusive) to the next (exclusive). Derived, not materialized.
- **USFM** (`src/lib/parsers/usfm-lossless.ts`): paragraph-class markers (`\p \q1-4 \m \b \pi \li`) currently stay *inside* verse text (lines ~220–246). Detect a paragraph-start when such a marker appears at verse-start and **set the paragraph marker on that verse-cell** — without altering verse boundaries. Verses remain the cells.
- **Non-scripture** (`markdown.ts`, `plaintext.ts`, `docx.ts`): paragraph is already the cell unit. When a paragraph exceeds the size threshold, `splitIntoSegments()` sub-divides and all sub-cells share the paragraph `group`.
- **Threshold tuning (open):** current `text-splitter.ts` `maxLength = 200` chars governs *when a cell sub-splits*. This is the cell-size knob, **not** the draft-window knob. See Open Questions.

### Workstream B — Paragraph draft unit + discourse window

- New entry point `completeParagraph(paragraphId)` alongside `completeSingle` / `completeBatch` in `src/lib/completion/completion-service.ts`. It scopes a batch to the paragraph's cells.
- Prompt assembly (`buildBatchPrompt()`, lines ~217–291) gains a **discourse window** block:
  - `precedingTarget`: committed `translated` text of the prior paragraph(s), to a token budget (D4).
  - `followingSource`: `original` text of the next paragraph(s), to a token budget.
  - `castLegend` (phase 2, D9).
- Existing blocks (`briefSummary`, `rules`, `validatedPairs`, `examples`) stay; `examples` is replaced by the Workstream C retriever.
- **Output protocol + commit fan-out (D11):** extend the existing `<vN>` tagged-segment format, keyed by stable cell id. A streaming parser routes live text into each open tag's cell buffer and finalizes on close; reconciliation matches tags→cells and flags any unmapped/missing cell (never commits empty). Each mapped cell emits one `target.cell.commit` with `ai_suggestion: true` (`ProjectWorkspace.commitCompletedCell`, `events-emit.emitTargetCellCommit`). **Verify at implementation:** the existing batch parser's exact streaming granularity, and that per-cell *progressive* streaming depends on the Frontier SSE fix (streaming is currently disabled for the default Frontier provider; until fixed, the parse is on-complete, which the tag format still supports).

### Workstream C — Retrieval-compressed examples

Replaces `collectValidatedPairs()` token-overlap ranking (lines ~34–58) as the example source.

1. **Retrieve** (source-side): query `/search/passages` with salient n-grams from the paragraph's source text; get ranked aligned `{source, target}` pairs.
2. **Select for coverage:** dedup near-identical sources; fill a fixed **examples token budget** with diverse pairs (each earns its tokens by demonstrating a distinct construction), rather than top-k cosine.
3. **Compress each example:** keep the matched source span ± ~10–20% margin, snapped to `BREAK_PATTERNS` boundaries, eliding the rest with `…`. Target shown whole (D6).
4. **Terminology elision (D7):** when concepts cover a term appearing in the legend, drop it from inline examples.
5. **Lossless boundary:** the source *being translated* and exact key terms are never compressed; only redundant retrieved context is.

### Workstream D — Cast legend (phase 2)

- Derive a compact per-paragraph legend from existing speaker/character data: `Cast: 1 Naomi · 2 Ruth · 3 Boaz; speaker=2`.
- Inject into the discourse window; render as a checkable overlay (serves "make quality visible"). Spec separately before building.

## Rationale-in-code (required)

Per the request, the *why* must live next to the code, concise, pointing back here. Place these short comment blocks at the decision sites:

- **`src/lib/parsers/text-splitter.ts`** (corpus branch / threshold):
  > `// Paragraph is a GROUPING over cells, never a re-segmentation of them. For aligned`
  > `// corpora (USFM) the verse-cell is the alignment unit and must NOT be split below —`
  > `// the alignment/BT/terminology stack depends on source↔target cell correspondence.`
  > `// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D1,D2).`

- **`completion-service.ts`** (retriever — source-side match):
  > `// Retrieve examples by SOURCE-side similarity (the high-resource side) and carry the`
  > `// target via existing pairing. No model touches the low-resource target — that's what`
  > `// keeps this safe for low-resource languages. (D5)`

- **`completion-service.ts`** (compression — target left whole, no Markov):
  > `// Truncate the SOURCE span only; leave the (small) target whole. Target ellipsis would`
  > `// need within-cell alignment we don't trust on low-resource targets. The bt-glosser`
  > `// Markov aligner is deliberately NOT used here: lossy summarization through a weak model`
  > `// injects misleading "consistency." Compression = deterministic selection, not summary. (D6,D8)`

- **`completion-service.ts` / `buildBatchPrompt`** (left-context is target):
  > `// Left-context is the COMMITTED TARGET of preceding paragraphs (not source): this is what`
  > `// gives real discourse flow — connectives and participant reference that follow what was`
  > `// actually said in the target language. Falls back to source before anything is committed. (D4)`

- **`completion-service.ts`** (the budget tradeoff — top of paragraph-prompt assembly):
  > `// We compress the INVARIANT (examples/terminology) precisely so the freed token budget`
  > `// can hold the VARIANT (discourse window, cast). v1 spent the whole budget re-dumping`
  > `// examples and had no room for discourse — which is why it produced translationese. (background)`

## Phasing — easy wins first

The L2 (prompt/context) improvements are **decoupled** from the L1-of-segmentation change and deliver value against the *current per-cell unit* with no import/migration risk. Sequence accordingly:

**Phase 0 — prompt-only wins (no segmentation change, all inside `completion-service.ts` + project settings):**

1. **Left-context = committed target (D4).** Even at per-cell granularity, feed the preceding cell/paragraph's committed `translated` text into the prompt. Cheapest, highest-leverage discourse fix; directly attacks participant reference and connectives. *Ship first.* **Phase-0 status: SHIPPED** — committed-target only; the D4 *source* fallback for not-yet-translated left-context is **deferred to Phase 1** (empty-target cells are currently skipped, not source-substituted).
2. **Source-side retrieval (D5).** Replace `collectValidatedPairs()` token-overlap with `/search/passages` source-side queries.
3. **Source-span compression + terminology elision (D6, D7).** Reuse `BREAK_PATTERNS` for ellipsis snapping; elide legend-covered terms.
4. **`draftContext` configurable budgets (D10).** Project-settings knob for the L2 budgets.

Phase 0 improves the existing draft immediately and de-risks Phase 1.

**Phase 1 — segmentation (the broad change):** Workstreams A + B — paragraph grouping (corpus-branched splitter), `completeParagraph()` draft unit (scoped batch), paragraph default with per-cell fallback. Rationale comments land here too.

**Phase 2 — deferred:** Workstream D (cast legend); embedding-based retrieval; high-confidence target-side truncation; participant-reference overlay UI. No change to the commit/event model in any phase.

## Testing (intent, not just behavior)

- **A/B segmentation:** USFM import — a verse containing `\p` is *not* split; the verse beginning a paragraph carries the paragraph marker; paragraph membership spans the right verses. (Encodes D1/D2 — fails if alignment unit is ever subdivided.)
- **Recursive fallback:** an over-long markdown paragraph sub-splits on the highest available boundary and all sub-cells share one `group`.
- **Left-context is target:** when preceding paragraph has committed target, the prompt contains that target text, not its source; falls back to source when uncommitted. (Encodes D4.)
- **Retrieval source-side:** retriever queries source, returns paired target; never embeds/aligns the target. (Encodes D5.)
- **Compression:** retrieved source is truncated on a `BREAK_PATTERNS` boundary with `…`; target is whole; the source-under-translation is never truncated. (Encodes D6.)
- **Terminology optional:** drafting works with zero saved concepts; with concepts, covered terms are elided from examples. (Encodes D7.)
- **Commit fan-out:** a paragraph draft commits N cells with `ai_suggestion: true`; projection sets `ai_drafted` per cell. (Existing path, regression guard.)

## Open questions

1. ~~Ideal draft-window size.~~ **Resolved (D10):** configurable `draftContext` budgets in project settings; ship sane defaults. Defaults still want a short sourced research pass on RAG chunk tradeoffs for the *retrieval* side specifically — separable from shipping.
2. **Replace vs toggle:** paragraph as the hard default with per-cell fallback (proposed), or a user/project setting? *Minor; default to fallback affordance unless a setting is wanted.*
3. ~~Cast legend phase.~~ **Resolved (D9):** deferred to phase 2.
