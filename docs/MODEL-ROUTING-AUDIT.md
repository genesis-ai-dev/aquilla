# Model-routing audit — the 90/9/1 split

An audit of every judgment Aquilla's agent surfaces make, against one question:
**does this step need a frontier model, a small model, or no model at all?**

The target shape (the "90/9/1 split") is that most steps in a workflow are
plain code, a small fraction need cheap judgment, and only a few genuinely need
the strongest model. A workflow handed whole to one frontier model pays top rate
for the string comparisons too.

Scope: the autopilot graph (`auth-worker/src/lib/contextual/`), the agent
tool-calling loop (`auth-worker/src/routes/agent.ts`), and the surrounding
check/health/terminology subsystems in `src/lib/`.

Companion docs: `docs/COST-METERING.md` (how to measure), `docs/AGENT-API.md`.

---

## Headline

The architecture is already right. The **wiring is not.**

The autopilot graph is built around a three-tier model interface —
`Tier = "fast" | "mid" | "deep"`, weighted `1 / 5 / 25`, charged per call
against a per-span cap (`lib/contextual/types.ts`). Every node already declares
its tier. Verification stances are already split by cost. Risk routing, vote
tallying, window growth, lint, health, and the LQA checks are already pure code.

But `resolveContextualModels()` (`lib/contextual/tick.ts:76-87`) resolves
`fast`, `mid` and `deep` to the **same model** unless `CONTEXTUAL_FAST_MODEL` /
`CONTEXTUAL_DEEP_MODEL` are set — and they are set in **no `wrangler.toml`, no
deployed environment, and no default**. `mid` is admin-settable via
`platform_settings.agentDraftModel`, and `deep` follows `mid`; `fast` ignores
platform settings entirely and pins to `DEFAULT_LLM_MODEL_ID`. Out of the box,
every tier is `openai/gpt-5.6-luna`.

So the 90 and the 1 are in good shape, and the **9 does not exist**: there is no
cheap-model tier in production, only a budget-weighting fiction that charges
25× for a call that costs exactly the same as the 1×.

`docs/COST-METERING.md` already records the consequence — the report's
`TIER_WEIGHTS calibration` section "self-suppresses when all tiers resolve to
one model."

---

## Ledger: every judgment, and what it should cost

### Already code (the 90) — verified, no action

| Step | Where | Note |
|---|---|---|
| 10 built-in LQA checks (placeholder-integrity, number-integrity, punctuation-integrity, unpaired-symbols, repeated-word, double-space, end-punctuation, abbreviation-mismatch, empty-target, target-equals-source) | `src/lib/lqa/check-functions/*` | Pure `(source, target) => InfractionSpan[]`. No network, no model. |
| Project rule engine + regex cache | `src/lib/rules/rule-engine.ts` | Pure; compiled patterns cached across cells. |
| Terminology matching / compile / violations | `src/lib/terminology/*` | Regex-based; `buildTermRegex` shared with the check pass. |
| "Check file" deterministic pass | `src/lib/check/deterministic-check.ts` | Explicitly "Pure functions, no network, no LLM." |
| Health score, decay, ribbon smoothing | `src/lib/health/*` | Pure math. No model call anywhere in the directory. |
| Risk routing | `lib/contextual/router.ts` | Code heuristic on inspectable fields. |
| Quorum tally + ambiguity veto | `lib/contextual/quorum.ts` | "Pure code, zero tokens." |
| Closure window growth, fixpoint detection, exit classification | `lib/contextual/closure.ts` | Code loop; the model only construes. |
| L2 construal render | `lib/contextual/summarize.ts` `renderConstrualL2` | Deterministic markdown, lossless. |
| Span lint (rules + terminology) | `lib/contextual/lint-node.ts` | Wraps `lintDraft` + `lintTerminology`. |
| Few-shot retrieval | `lib/agent/tools/examples.ts` | Postgres FTS `ts_rank`. No model. |
| Example compression | `src/lib/completion/compress-examples.ts` | "Deterministic selection/truncation — NEVER summarization through a weak model." |
| Monday.com mapping pre-filter | `lib/monday/analyze.ts` | "Only a genuine choice reaches the LLM." |
| Term scoping to the span | `lib/contextual/project-context.ts` `termGuidanceForSpan` | A 900-entry termbase is narrowed in code to the ~8 terms in the passage. |

**Item 1 and item 2 of the brief are already satisfied.** LQA checks and the
health score contain no model calls.

**Item 3 (cache repeated term decisions) is largely satisfied too**, by a better
mechanism than a cache: an approved `Concept` rendering is a *durable* decision,
injected deterministically into the draft prompt and enforced deterministically
by `lintTerminology`. The decision is made once by a human and never re-asked.

### Gaps (ranked by leverage)

| # | Gap | Where | Fix |
|---|---|---|---|
| **G1** | **All three tiers resolve to one frontier model.** The tier architecture exists and is unwired. | `lib/contextual/tick.ts:76-87` | Set `CONTEXTUAL_FAST_MODEL` (and a distinct `CONTEXTUAL_DEEP_MODEL`) per environment. Config, not code. |
| **G2** | `summarize` — compress a construal to ≤1600 chars — runs at `fast` tier, i.e. on the frontier model. One call per span. Textbook small-model work. | `lib/contextual/summarize.ts` | Falls out of G1. |
| **G3** | **Vacuous deep-tier calls.** `verify_ambiguity` is `tier: "deep"`, mandatory, and barrier-required. When the ambiguity register is *empty* it is asked to find violations of an empty list — there is nothing it can find. On a clean span that is a 25-weight call whose answer is structurally predetermined. | `lib/contextual/verify.ts:22-36`, `pipeline.ts` barrier | Route the empty-register case to `fast`, or answer it in code. Guarantee-affecting — needs a product call, so **not implemented here**. |
| **G4** | `exampleCoverage` is not a support signal. `min(validated examples / 10, 1)` measures how many validated pairs the **file** has — it never looks at the draft. It was the router's only retrieval-quality input. | `pipeline.ts:238` | **Implemented** — see below. |
| **G4b** | **The paragraph branch of `deriveSpanSeeds` was unreachable.** `tick.ts` called it with no options, so its `paragraphStartCellIds` input was never supplied and every non-Scripture discourse file — docx, epub, markdown, subtitles — was cut into fixed 10-cell chunks. The importer had recorded every paragraph start in `cells.metadata` all along. | `lib/contextual/tick.ts:1063`, `lib/contextual/segment.ts` | **Fixed** — the tick now reads them, and short paragraphs coalesce to the design's 8–12 band instead of becoming one span each. |
| **G5** | **Autopilot retrieval is unranked.** `validatedExamples()` takes the *first 10 validated pairs in the file*, in file order, ignoring the span's source text — while the agent's `examples` tool does proper FTS ranking against the same database. The more expensive surface gets the worse retrieval. | `lib/contextual/tick.ts:576` vs `lib/agent/tools/examples.ts` | Reuse the FTS query. Pure code, no model cost, and it directly improves G4's signal. |
| **G6** | **Import classification runs on the frontier default.** Pick one of six categories plus a declarative recipe from a file sample. The repo already has the precedent one directory over: `knowledge/index-doc.ts` defaults to `anthropic/claude-haiku-4-5`. | `routes/import-classify.ts:131` | Give it its own `IMPORT_CLASSIFY_MODEL`, defaulting small. |
| **G7** | **One model for every agent round.** `runAgentLoop` runs up to 30 rounds on `agentModel`; only `draft` gets a separate `draftModel`. Read-shaped rounds (`read`/`examples`/`search`/`docs`/`aquifer`) are free in the *iteration* budget but each still costs a full frontier round-trip whose only job is choosing the next tool. Measured: **~41:1 input:output, ~10,500 input tokens per turn** (`docs/COST-METERING.md`). | `routes/agent.ts:81-83, 618+` | Two levers, in order: prompt caching on the fixed prefix (~15 tool schemas re-sent every turn), then a cheaper orchestrator with `draftModel` kept strong. |
| **G8** | **The cost-per-task-type metric already exists and is dark.** `agent_cost_meter` records surface / label / tier / model / tokens / latency per call — exactly the ledger item 7 of the brief asks for — but `COST_METER=1` is off by default and nothing in production writes it. | `lib/cost-meter.ts` | Enable it in a non-production environment on a schedule; the missing half is comparing per-label cost against per-label *value*, which no table currently holds. |

---

## What this change implements: the support check (G4)

The idea, stated plainly: **if the draft was produced from validated pairs 1–N,
its content should be traceable to pairs 1–N.** Wording attested nowhere in the
retrieval is not necessarily wrong, but it is the part of the draft the
retrieval does not vouch for — and it is where a drafting model invents.

That is checkable in code, and the new node
(`auth-worker/src/lib/contextual/support.ts`) is the 90/9/1 split applied to a
single decision:

```
tier 1  CODE        analyzeSupport()   tokenize the draft, attest each token
        free                           against the corpus the prompt actually
                                       carried, flag cells below a floor.
                                       Most cells clear here. Zero tokens.

tier 2  FAST MODEL  confirmSupport()   only the flagged cells, only their novel
        1 unit                         tokens: ordinary morphology and necessary
                                       new vocabulary, or invention? One cheap
                                       call per span, capped at 1024 tokens.

tier 3  DEEP PANEL  classifyRisk()     only cells tier 2 confirms escalate the
        30 units                       span from one verifier to three.
```

Design points worth keeping:

- **Tier 1 exists to keep tier 3 rare; tier 2 exists to keep tier 1's false
  positives from making tier 3 common.** Escalating on the raw code signal alone
  would fire the full panel on every morphologically rich target language — the
  languages this product exists for. That is why the middle tier is not
  optional.
- **Prefix matching (5 leading characters) absorbs inflection.** Exact-token
  attestation alone reports most of a correct agglutinative draft as novel.
- **The check abstains rather than guesses.** Below 5 corpus texts or 60
  distinct target tokens, "unattested" carries no information and
  `applicable: false` keeps it out of the routing decision entirely. A new
  project is not punished for being new.
- **Cells cleared by tier 2 are excluded from the span-level ratio.** Otherwise
  the cheap check would be overruled by the raw measurement it exists to refine,
  and tier 3 would run on exactly the case tier 2 was added to prevent.
- **Failure escalates.** An unavailable, unaffordable, or unparseable
  confirmation treats every flagged cell as risky. A cheap check that cannot run
  must not quietly wave a span through.
- **Both tiers are reported** in `SpanReport.notes`, and confirmed cells appear
  in `Risk.sourceFindingIds` as `support:<cellId>`. A routing decision nobody
  can inspect is a routing decision nobody can fix.

Marginal cost: **1 unit** (one fast call) on spans with flagged cells, against
the **30 units** a blind escalation to the full panel would cost. It pays for
itself if it prevents one escalation in thirty.

Files: `support.ts` (new), `router.ts` (consumes the signal), `pipeline.ts`
(node placement, after lint, before route), `scripts/mock-openrouter.ts`
(`[[ctx:support]]` branch).

---

## Also landed: paragraph-aligned span seeds (G4b)

`segment.ts` documents a three-way priority — canonical refs, then paragraph
starts, then fixed chunks — but the middle branch had no caller. `tick.ts`
invoked `deriveSpanSeeds(run.fileId, pairs)` with no options, so
`paragraphStartCellIds` was always empty and prose files fell straight through
to 10-cell chunks that ignore where the text actually breaks.

The data was already there: `docx.ts` and `markdown.ts` set `paragraphStart` on
the first cell of every paragraph, `src/lib/import.ts` folds it into the create
event's metadata, and the projection lands it in `cells.metadata`. The tick now
reads it with one query, on the first wave only (the cursor is derived once).

Subdivision alone was half a policy. It caps a run that is too big but does
nothing about runs that are too small, and a prose paragraph is one to three
cells — so honouring paragraph marks naively would have made a span per
paragraph and paid a whole construe → summarize → draft → verify pipeline for
two sentences, strictly worse than the chunking it replaces. `coalesceRuns`
merges consecutive paragraphs up to the 12-cell cap without ever splitting one,
so spans stay in the design's band while every boundary lands on a real edge.

Canonical-ref files are deliberately unchanged: chapter runs are already
chapter-sized, and a chapter boundary is a navigation unit a translator
recognizes, so merging across one would trade a real edge for a marginal
saving.

`SegmentOptions.fixedSize` is also in place — a clamped "just cut it every N
cells" override that wins over all derived structure. It has no caller yet; it
is the server-side primitive behind the planned re-segment affordance, so that
work is a route plus UI rather than a route plus UI plus a core change.

---

## Also landed: a per-file segmentation surface

`file_segmentation` (migration 0079) stores one row per file, keyed by
`(project, file)` with **no `target_lang`** — segmentation is a property of the
source, so every language lane reads the same boundaries. Before it, the
segmentation was derived per RUN into `contextual_runs.span_cursor`: two lanes
of the same file recomputed it independently, it was discarded when the run
ended, and nothing outside the run could see or correct it.

Three strategies, resolved by `resolveSpanSeeds` in `tick.ts`, most-specific
first:

- **`explicit`** — an ordered boundary list, stored verbatim. This is the shape
  a re-segmentation pass writes; each entry may carry `title`/`gist`/`depth`, so
  the same rows can later drive a navigation outline.
- **`fixed`** — cut every N cells. The blunt human override.
- **`auto`** — derive from file structure (the default; an absent row is `auto`).

Every stored strategy degrades to `auto` rather than failing — an unreadable
row, a boundary list whose endpoints no longer resolve, a file that changed
shape underneath a saved segmentation. A run with imperfect boundaries still
translates the file; a run with no boundaries translates nothing.

The validation in `db/shared/file-segmentation.ts` is the load-bearing part,
and it is **code, not judgment**. A boundary list is checked against the file's
real ordered cell ids for unknown endpoints, gaps, overlaps, ordering, and full
coverage before it is ever stored. Each of those rules exists because breaking
it loses work *silently*: cells that belong to no span are never drafted by any
run and are never reported as skipped, because nothing knows they were meant to
be covered. When a model starts proposing boundaries, that check is the only
thing standing between a plausible-looking list and a quietly half-translated
book.

`GET /contextual/segmentation` returns the **effective** segmentation, resolved
through the same `resolveSpanSeeds` the run itself calls. A preview computed by
a second, parallel implementation would drift from the real boundaries, and it
would drift silently — so the dialog renders what the server resolved and
computes nothing itself.

The UI is the file row's ⋯ → **Segmentation…**, read-only below Project Lead
(the dialog says why rather than hiding how the file is divided). The AI option
is rendered and disabled: the pass behind it does not exist, but its note box
is live and saved, because that note is the instruction the pass will read.

---

## Recommended order of work

1. **G1 + G2** — set `CONTEXTUAL_FAST_MODEL` to a small model per environment.
   Config-only, immediately measurable via the existing meter, and it turns the
   entire tier architecture (including the new support check) from accounting
   into money. Everything else is smaller.
2. **G5** — reuse the FTS retrieval in the autopilot. Pure code, no model cost,
   improves both draft quality and the support signal's precision.
3. **G8** — turn the meter on somewhere and start reading per-label cost. Nothing
   below should be decided without it.
4. **G6** — small model for import classification.
5. **G7** — prompt caching on the agent loop's fixed prefix, then a cheaper
   orchestrator.
6. **G3** — the empty-register verifier. Cheapest to implement, but it touches a
   stated product guarantee, so it goes last and with a decision behind it.
