# Architecture

How the spec's functional architecture (SPEC §4) is realised, and the
decisions behind it. Read with the code: every section names its module.

## 1. The loop

`src/engine/pipeline.ts` — `syncDocument()` runs, per document:

1. **Extract** the source with its adapter → `ContentUnit[]` (scope, optional
   native anchor, structural path, tagged text, hash).
2. **Reconcile** against the previous observation → a logical id and a status
   for every unit (`src/core/reconcile.ts`). Ambiguous units raise a conflict.
3. Per target locale:
   1. **Capture human edits** in the published target file by extracting it and
      comparing with the bytes we published last time (`src/engine/feedback.ts`).
      Each edit becomes a `translation.edited` fact; short phrase replacements
      also become *suggested corrections*.
   2. **Plan** every unit: keep / translate / hold, with a reason
      (`src/core/plan.ts`).
   3. **Translate** only the units the plan requires, with context (terms,
      rules, prior translations, neighbours). Every result is validated against
      the source's tag structure before it becomes a fact; invalid output is
      retried once, then reported.
   4. **Post-edit** agent output with accepted corrections (deterministic,
      no model call).
   5. **Patch** the last published state toward the desired state through the
      patch engine (`src/core/patch.ts`) — preconditions, authority, idempotency.
   6. **Render** the native artifact from the *source* plus translations.
   7. **Merge** with the target if a person edited it (`merge3`), keeping their
      layout work.
   8. **Validate** and run **layout** assurance.
   9. **Publish**: write the file, store its bytes, record `publish.recorded`.
4. Record `source.observed` (last, so planning compared against the previous revision).

Running the loop twice with nothing changed records no facts and writes no
files. That idempotence is tested (`test/lifecycle.test.ts`).

## 2. Content model

`src/core/types.ts`, `src/core/tagged.ts`

A unit's text is *tagged text*: literal text plus `<gN>…</gN>` formatting runs
and `<xN/>` protected inline objects. Every adapter maps its native structure
to this notation and back, so translators, similarity, terms and reports never
see native markup.

- IDML: runs are character-formatting contexts (CharacterStyleRange ×
  hyperlink × XML tag). Runs with identical formatting share an id, so a
  translator sees `<g1>…</g1><g2>bold</g2><g1>…</g1>`, not three unrelated runs.
  Tokens are anchored frames, variables, footnote references, tables, special
  character PIs, etc.
- Markdown: runs are emphasis and link text; tokens are code spans, URLs,
  images, inline HTML, footnote refs, escapes.
- JSON: tokens are ICU/i18next/printf placeholders; runs are numbered React tags.

## 3. Identity reconciliation

`src/core/reconcile.ts` — format-agnostic by design (see §8).

Passes, from most to least certain:

| Pass | Evidence | Status |
|---|---|---|
| 1 | human assertion, unique native anchor | as found |
| 2 | exact hash, longest common subsequence within a scope | unchanged |
| 3 | exact hash elsewhere | moved |
| 4 | splits/merges, then monotonic fuzzy alignment inside each gap | split / merged / modified |
| 5 | global fuzzy pass | moved (edited) |
| 6 | leftovers | inserted / deleted |

Guards that make "never guess" true in practice (each one came from a
counterexample found by the property tests):

- duplicate texts whose multiplicity changed and that carry human decisions
  skip the positional passes and are escalated;
- a fuzzy pairing is refused if either side has a clearly better partner
  elsewhere (mutual best), or if the current text is a verbatim fragment of
  another unmatched paragraph;
- split/merge explanations must beat every 1→1 explanation by a margin, may
  not swallow a paragraph that has its own good match, and pick the best
  contiguous run (interior deletions allowed for merges);
- thresholds: fuzzy ≥ 0.65 (Dice blend of words and character trigrams),
  split/merge containment ≥ 0.85 and similarity ≥ 0.75.

Measured on 6,000 generated edit scripts (`pnpm gate`): zero wrong
attributions, ~98% recall. Unmatched heavy rewrites become delete+insert, which
is the conservative failure: the paragraph is retranslated, nothing is
attributed wrongly.

Cost: features are memoised and encoded as sorted integer arrays. 2,000
paragraphs with scattered edits reconcile in ~0.25 s; a fully rewritten
400-paragraph chapter in ~1.7 s (the quadratic worst case).

## 4. Durable state: the ledger

`src/core/ledger.ts`

An append-only set of sealed facts (`opId` = hash of actor + fact + HLC):

| Fact | Meaning |
|---|---|
| `source.observed` | a source revision and its units (ids, lineage, deletions) |
| `translation.proposed` | immutable model (or post-edit) output with provenance, source hash and context revision |
| `translation.edited` | human translation, with `basedOn` (the content the person was looking at) |
| `translation.approved` | approval of specific content |
| `decision.term` / `decision.rule` / `decision.correction` | organisation decisions |
| `identity.asserted` | a person resolved an ambiguous identity |
| `publish.recorded` | what was published: per-unit content hash, observed hash, source hash, authority; output bytes hash |
| `conflict.raised` / `conflict.resolved` | escalations |

State is `fold(facts)`: de-duplicate by `opId`, sort by (HLC, `opId`), apply.
Any delivery order, any duplicates → identical state; two replicas exchanging
ledgers converge (`importLedger`). Semantic conflicts are *derived*: two human
edits with the same `basedOn` and different content are a fork until a later
edit builds on one of them (`humanConflicts`).

**Effective translation** for (unit, locale, source hash, context revision):
latest human/approved version for this source hash; else the latest agent
proposal for this source hash *and* this context revision; else nothing.
Timestamps never let a model beat a person.

Besides the ledger, `.ambient/objects/` stores the exact bytes of each
published output (content-addressed). That is the "necessary
synchronization metadata": without it we could neither detect what a person
changed in a target file nor roll back.

## 5. Context and policy

`src/core/context.ts`

`contextRevision` for a unit = hash of the glossary terms whose source occurs
in the unit + retroactive rules. A new term about "church hall" invalidates
only paragraphs that mention a church hall (cross-unit dependency, SPEC §4.3).
Non-retroactive rules change `policyRevision` (recorded) but don't invalidate.

Accepted corrections are applied as deterministic post-edits to agent output
(provenance records which corrections were applied), so "correct once,
propagate" costs no model calls and is idempotent. With an LLM translator the
corrections and prior human translations are also passed as context.

## 6. Authority

Two layers, both tested:

1. **Planner** (`plan.ts`): human/approved content for the current source is
   always kept; when the source changes under it, policy `revise` sends the
   human text as the base to the translator and flags the result for review;
   policy `hold` keeps publishing the human text and flags it.
2. **Patch engine** (`patch.ts`): an agent patch over human/approved content
   is rejected unless explicitly marked as a revision; concurrent siblings are
   resolved by authority, then operation id — never by arrival order.

## 7. IDML adapter

`src/adapters/zip.ts`, `xml.ts`, `idml/*`

- ZIP: reads central directory; keeps every member's original local record;
  rewrites only changed members (mimetype stays stored and first). Rejects
  ZIP64, encryption, unknown compression, unsafe paths, duplicate members,
  suspicious compression ratios.
- XML: an offset-preserving scanner; nothing is ever re-serialised. DOCTYPE is
  rejected.
- Stories: paragraphs are split at `<Br/>` and ParagraphStyleRange ends; table
  cells, footnotes and endnotes are nested scopes; notes, cross-reference text,
  tracked changes and unknown text-bearing elements are preserved and reported.
- Write-back: translation text is placed into existing `<Content>` slots.
  Tokens never move. If a translation reorders runs in a way slot replacement
  cannot express, text is placed in reading order and the unit is flagged
  `FORMATTING_SIMPLIFIED` for review — the file stays valid.
- Three-way merge (`merge3`): per ZIP member; a member only the person changed
  keeps their bytes; only we changed → ours; both → ours if the person changed
  only text in a story (already captured as decisions), otherwise a conflict
  that keeps the person's version.
- Validation: package members/order, non-story members byte-identical, XML
  well-formed, story skeletons (text masked) identical, tokens preserved.
- Layout: see [LAYOUT.md](LAYOUT.md).

## 8. Why reconciliation is not in the adapter

The spec's adapter contract includes `reconcile`. Here adapters only provide
scopes, anchors and structural paths; reconciliation is one core function.
That is deliberate: Phase 5's question is whether a second format needs its
own synchronization engine. With three adapters (IDML: paragraph identity by
reconciliation within stories/cells; Markdown: no native ids at all; JSON:
every unit natively anchored) sharing one reconciler, ledger, planner, patch
engine, feedback loop and surfaces, the answer so far is no. The Markdown
adapter is ~370 lines and the JSON adapter ~200, with zero changes to the core
when they were added.

## 9. Surfaces

All surfaces call the same operations (`src/ambient/ops.ts`):

- watched folder and CLI (`workspace.ts`, `cli.ts`);
- inspector UI + JSON API + WebDAV (`server.ts`, `inspector-html.ts`), bound to
  127.0.0.1, writes serialised;
- MCP server (`mcp.ts`) with tools for status, sync, units, edit, approve,
  terms, corrections, open-in-any-language, and `ambient_view`, which writes a
  focused self-contained review page — the smallest version of "generate the
  UI you need".
