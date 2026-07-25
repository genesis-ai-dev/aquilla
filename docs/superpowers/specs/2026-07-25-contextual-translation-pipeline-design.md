# Contextual Translation Pipeline — design

**Date:** 2026-07-25
**Graph spec:** [`2026-07-25-contextual-translation.graph.yaml`](./2026-07-25-contextual-translation.graph.yaml) (lint-clean: 0 errors, 0 warnings)
**Companion reading:** `2026-06-18-paragraph-drafting-retrieval-context-design.md` (L1/L2/L3 context doctrine this design extends)

## 1. Summary

Today's drafting pipeline translates wordings: few-shot examples + (sometimes) a 3-cell
discourse window → one cell's target text. This design replaces that with a two-role
architecture derived from a contextual model of translation:

- An **analyzer** construes the *scene* around a span of cells — situation, participants,
  tenor, speech-act sequence — by expanding its reading window backwards and forwards until
  the construal stops changing (a fixpoint, not a fixed radius), and records what is
  *genuinely ambiguous* in an explicit ambiguity register.
- A **performer** drafts the span *from the scene brief*, not wording-by-wording — free to
  reach for target-language idioms the wording-level path suppresses.
- A **verifier panel** tries to break the draft on the three failure modes the model
  predicts: altered social force, **resolved ambiguity** (over-clarification — imposing an
  interpretation is as much a failure as an error), and unnatural target wording.

Everything exits through the existing safety perimeter: `stageEvents()` provenance + role
floors + staleness checks, the in-memory `AgentProposal` human approval gate, and the
outbox. **The pipeline never commits anything.**

A floating **play/pause pill** in the editor drives the run over the open file, span by
span: play starts/resumes, pause stops *between* spans (in-flight span finishes), cancel
aborts.

## 2. Scope-check verdict

This is a graph, not a prompt. It has genuine parallel work (three verifier stances),
expensive judgment concentrated by a router, an evidence trail too large for one context
(a Gospel's worth of scenes), a convergence loop with real runaway risk, and a wrong answer
that costs something (a translator reviewing subtly-wrong drafts, or a reader receiving an
imposed interpretation). Single-prompt drafting is what we have today; its failure modes
(batch path has *zero* discourse context; over-clarification is unchecked) are the
motivation.

## 3. Phase 1 — anchor

**Task type.** Contextually translate one span of a discourse file: construe its scene,
draft target cells from the construal, verify fidelity, stage for human approval. (One
graph instance = one span. The client driver sequences spans.)

**Task distribution / eval set** (freeze real instances of each before building):

| instance | shape | why it's in the set |
|---|---|---|
| USFM Gospel (e.g. MRK) | large, scripture, pericopes cross chapter breaks | bread-and-butter; seeds unreliable by design |
| OBS story file | 50 cells, image-per-cell metadata | small discourse file, one situation per story |
| VTT subtitles w/ speakers | timed cues, `speaker` tags, scene = timing gaps | tenor comes from cast; mode is oral |
| Markdown/docx doc | headings as stage seeds | heading misuse stress-tests seed distrust |
| json-i18n strings file | no discourse at all | must be routed *around* the graph, not through it |
| USFM poetry (Psalms) | move-level units ≫ verse cells | span-vs-cell mismatch stress test |

**Codebase facts** (verified against the tree, 2026-07-25):

| fact | value |
|---|---|
| Agent loop | `auth-worker/src/routes/agent.ts` — single SSE run, OpenRouter, budgets `MAX_TOOL_ITERATIONS=12` / `MAX_TOTAL_ROUNDS=30` / `TOKEN_CEILING=100k` / cost cap 500¢; **no pause/resume, no queues, no DO alarms, no job table** |
| Staging perimeter | `auth-worker/src/lib/agent/emit-stage.ts` `stageEvents()` — role floors, alias resolution, staleness pre-check, `ai_suggestion`/`agent_run_id` injection, deterministic lint; verdicts `staged\|rejected\|stale` |
| Human gate | in-memory `AgentProposal` → `proposal` frame → `deriveWorkingSet` → per-row accept/edit/reject → `applyStagedEvents` → outbox. Client can apply only `target.cell.commit`, `comment.create`, `cell.validate` |
| Checkpointed-loop precedent | `tools/draft.ts` — 10-cell batches + "N more remain — call draft again" verdict; separate stronger `agentDraftModel` |
| Cell selection/order | `tools/select-cells.ts` — `orderPairs()` (sequence_index → canonical ref → anchor-chain walk), `statusOf()`, `parseRefRange()` |
| Discourse window today | `src/lib/completion/draft-context.ts` — 3 preceding validated targets, single-cell path only; **`buildBatchPrompt` takes no discourse context at all**; `contextSize` setting is persisted+editable but read by nothing |
| Idle asset | `completeParagraph` (`useCompletion.ts`) — finished, tested, symmetric-window, `<c id>` protocol drafter that no UI calls |
| Brief injection | `translationBrief.l1Summary` already lands in every draft prompt between system prompt and rules (`buildBriefBlock`) |
| Provenance | `AiDraftProvenance { model, promptVersion(hash), exampleIds, mode, ... }` — `mode` has room for `"contextual"`; post-hoc scoring free via AD-14 confidence propagation |
| Long-run progress UI | module pub-sub + `useSyncExternalStore` (`batch-completion.ts` is canonical: monotonic `runId` guard, AbortController, retain-on-failure summary); cancel exists, **pause does not** |
| Artifact storage | `ProjectWideSettings` = multi-MB blob, MAINTAINER write floor, whole-key replacement → **wrong** for per-span data; `agent_memories` = right lifecycle (proposed/approved, 10KB cap, provenance) but path-string key; agent-artifacts = write-only R2 → disqualified |
| Feature flags | `src/lib/features/flags.ts` **does not exist yet** — forward-referenced by `ProjectRecord.experimentalFlags`; device-local by design |

**Definition of done (per run).** Every untranslated cell in scope has either a staged
draft (with `sceneBriefId`, `promptVersion`, `exampleIds`, quorum verdicts) or a named skip
reason in the run report. Scene briefs persisted with ambiguity registers. No accepted
draft resolves a registered ambiguity. Nothing bypasses the human gate. A partial run says
so — no silent coverage claims.

## 4. Phase 2 — the path that exists today, and where it fails

```
"Run AI completions" → untranslated.slice(0, batchSize) → buildBatchPrompt
  [system + project L1 brief + rules] + [validated few-shot] + <v1..vN> cells
  → one LLM call per 10 cells → commit unvalidated (mode: "batch")
```

Known failure locations (these place the node boundaries and verifiers):

1. **No discourse window in the batch path** — the primary mass-drafting route is strictly
   weaker than the single-cell sparkle. → the analyzer/window machinery.
2. **Wording-level units** — idioms and move-level meaning translated element-by-element;
   retrieval failure silently degrades to zero-shot. → performer works from the brief.
3. **Over-clarification is unchecked** — nothing in the pipeline can even represent "this
   was ambiguous on purpose." → ambiguity register + mandatory `verify_ambiguity`.
4. **Confident-but-wrong drafts** — author self-review only (lint is mechanical). →
   independent verifier panel with quorum in code.

## 5. Phase 3 — node ledger

| id | decision (one verb) | kind | in | out | tier | failure mode |
|---|---|---|---|---|---|---|
| scope | resolve ordered cell pairs + status | code | — | SCOPE | — | stale projection (re-read at stage time covers it) |
| segment | derive span seeds from parser structure | code | SCOPE | SPAN_SEED | — | bad seeds (by design recoverable — seeds are anchors, not boundaries) |
| construe | construe the situation the window enacts | model | SPAN_SEED, WINDOW | CONSTRUAL | mid | premature closure; hallucinated participants |
| expand_window | widen window per open questions | code | CONSTRUAL | WINDOW | — | runaway growth (loop stops bound it) |
| register | move still-open questions to ambiguity register | code | CONSTRUAL | CONSTRUAL | — | conflating "genuinely open" with "ran out of budget" (two distinct exits, see §6) |
| summarize | compress construal to L1 (≤1600 chars) | model | CONSTRUAL | SCENE_BRIEF | fast | lossy compression (L2 retained on the row) |
| persist | upsert scene_briefs row (proposed) | code | SCENE_BRIEF | SCENE_BRIEF | — | version conflict (per-row ifMatchVersion) |
| draft | perform the span from the scene brief | model | SCENE_BRIEF, SCOPE | DRAFT | mid | wording-drift back toward source syntax |
| lint_rules | run deterministic rule checks | code | DRAFT | FLAGS | — | — |
| route_risk | send high-risk spans to the panel | router | DRAFT, FLAGS | RISK | fast | misrouting (mandatory ambiguity check limits blast radius) |
| verify_force | *stance:* find a move whose social force the draft alters | verifier | SCENE_BRIEF, DRAFT | VOTE | deep | agreeing by default (stance + independence) |
| verify_ambiguity | *stance:* find where the draft resolves a registered ambiguity | verifier | SCENE_BRIEF, DRAFT | VOTE | deep | same |
| verify_naturalness | *stance:* find wording no native speaker would use here | verifier | SCENE_BRIEF, DRAFT | VOTE | mid | same |
| quorum | accept a cell on 2-of-3 approvals | code | VOTE | DRAFT | — | — (ambiguity veto counted in code) |
| stage | stage accepted commits via emit-stage | code | DRAFT | STAGED | — | staleness (perimeter's `stale` verdict handles) |
| report | aggregate span outcomes | code | STAGED, FLAGS | REPORT | — | — |

Deterministic work is code, no exceptions: segmentation, window growth, registry split,
quorum counting, lint, staging, reporting all cost zero tokens.

## 6. Phase 4 — topology, one justification per addition

```
scope → segment → ┌─────────────────────┐
                  │ construe ⇄ expand   │  (scene_closure loop, fixpoint exit)
                  └─────────────────────┘
        → register → summarize → persist
        → ┌──────────────────────────────────────────────┐
          │ draft → lint → route_risk ─┬→ verify_force   │
          │                            ├→ verify_ambig.  │──[barrier 2/3,
          │                            └→ verify_natural.│   ambiguity mandatory]
          │                        → quorum ─────────────│  (redraft loop, ≤2 iters)
          └──────────────────────────────────────────────┘
        → stage → report
```

- **scene_closure loop** (construe ⇄ expand_window): the analyzer's "look backwards and
  forwards recursively until it understands." A *dry round* = the last expansion changed
  nothing in the construal — the fixpoint. Expansion order: adjacent **approved scene
  briefs** first (compressed, memoized context — backward looks are usually one brief-read,
  not a raw re-read), then raw cells forward, then one layer up (file intro / project
  brief). **Two distinct exits:** fixpoint-with-open-questions is a *success* — those
  questions become the ambiguity register; budget exhaustion marks the span `incomplete`
  for a human. Conflating these is the loop's one deadly failure mode.
- **Verifier fan-out** passes the distinctness test: three stances = the three distinct
  failure families of the translation model (force, ambiguity, naturalness). None needs a
  sibling's output; each covers a failure family no sibling covers.
- **Barrier at quorum**: `min_success: 2`, **`verify_ambiguity` mandatory** — preserving
  registered ambiguity is this design's distinctive guarantee; a run where that verifier
  died cannot claim it. `on_partial: retry` once, then the span ships `incomplete`.
- **Router** concentrates the deep tier: low-risk spans (small register, clean lint, strong
  validated-example support) get only the ambiguity verifier; high-risk spans get the full
  panel. Routing is on inspectable fields (`level`), branched in code.
- **redraft loop**: rejected cells get *one* retry with the losing verdicts attached as
  constraints (never "improve this"); a second rejection is reported as skipped — a worse
  draft is not shipped to look complete.
- **Verifiers receive the brief + the draft, not the performer's reasoning** — independence
  is the point; inherited framing is how panels rubber-stamp.

## 7. Phase 5/6 — edges, tiers, budget

Schemas are in the graph spec. Rules carried over from the skill: stable ids everywhere,
`sourceFindingIds`-style traceability (`DRAFT.sceneBriefId`, `RISK.sourceFindingIds`,
`STAGED.verdicts`), no load-bearing free text between nodes.

**Tier → model mapping** (resolved server-side like `resolveAgentModel`/`resolveDraftModel`
today, overridable via `platform_settings`):

| tier | default | used by |
|---|---|---|
| fast | `anthropic/claude-haiku-4-5` | summarize, route_risk |
| mid | `agentDraftModel` (today's draft model) | construe, draft, verify_naturalness |
| deep | strongest configured (e.g. `anthropic/claude-sonnet-5`) | verify_force, verify_ambiguity |

**Budget report** (lint output, worst case per span — all loops maxed, panel engaged):

```
nodes: 16  model-backed: 7  est. calls: 17  est. units: 153   (caps: 200 units / 24 calls)
  50  verify_force (deep x2)      50  verify_ambiguity (deep x2)
  30  construe (mid x6)           10  draft (mid x2)           10  verify_naturalness (mid x2)
```

Bread-and-butter span (2 construe rounds, low risk, no redraft): construe 10 + summarize 1
+ draft 5 + route 1 + verify_ambiguity 25 = **~42 units**, 5 calls. The deep panel is
~65% of worst-case cost — exactly what the router exists to gate. Per-file cost = spans ×
this; the FAB surfaces running cost and the run inherits the agent-route credit guard.

## 8. Execution architecture

**No new job machinery.** The repo has no queues/alarms/job tables, and a page reload kills
an SSE run. So the durable unit is small: **one span-batch = one SSE request** to a new
deterministic orchestrator route, and the **client run-store is the sequencer**:

```
POST /api/v1/ai/contextual/run   (auth-worker, sibling of /ai/agent/run)
  body: { projectId, fileId, targetLang, spanSeeds?: [...], maxSpans: 3 }
  SSE frames (additive AgentFrame variants — old reducers ignore unknown types):
    run_start · progress · scene.construed {sceneBrief} · span.drafted {cells}
    · verify.votes {votes} · proposal (existing frame!) · usage · budget · done
```

The route is **code-orchestrated** (the graph above is the program, not a prompt): it
reuses `selectCellPairs`/`orderPairs`, `executeExamples`, `lintDraft`, and exits through
`stageEvents` — same dedicated-PG-connection pattern as `agent.ts` (the request-scoped shim
closes before the stream ends), same credit guard before the stream opens, same
`agent_runs` accounting. Drafts stage with `mode: "contextual"` and `sceneBriefId` added to
`AiDraftProvenance`; the client applies accepted rows via the **unchanged**
proposal → working-set → `applyStagedEvents` path. `maxSpans: 3` per request is the
`draft`-tool checkpoint idiom: the `done` frame reports `remainingSpans`, and the client
issues the next request — which is precisely where pause lives.

**Why not inside the existing agent loop?** The conversational agent stays able to invoke
this (a `/contextual` slash command → same route), but the pipeline itself is
deterministic: routers branch in code, quorum is counted in code, and budget/latency are
predictable — none of which survive being delegated to a model orchestrator.

**Crash/pause semantics.** Completed spans have persisted scene briefs (DB) and delivered
proposals (client store, localStorage when not streaming). A reload mid-span loses only
that span's in-flight work; play resumes from the first span without an approved brief +
staged drafts. Pause never aborts in-flight work; cancel aborts via the store's
AbortController.

## 9. Scene-brief storage

New table + thin route, modeled on `agent_memories` (NOT `ProjectWideSettings` — wrong
cardinality, MAINTAINER floor, whole-blob 409s on the multi-MB settings row; NOT
agent-artifacts — write-only opaque R2):

```sql
CREATE TABLE scene_briefs (
  id TEXT PRIMARY KEY,                  -- uuidv7
  project_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  start_cell_id TEXT NOT NULL,          -- endpoint UUIDs, never ordinals:
  end_cell_id TEXT NOT NULL,            --   membership = walk document order between them
  target_lang TEXT NOT NULL DEFAULT '',
  construal TEXT NOT NULL,              -- L2: situation/participants/tenor/moves markdown
  ambiguity_register JSONB NOT NULL DEFAULT '[]',
  l1_summary TEXT,                      -- ≤1600 chars, injected into draft prompts
  l1_generated_at TEXT, l1_model_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','rejected','archived')),
  human_edited INTEGER NOT NULL DEFAULT 0,
  provenance JSONB,                     -- {runId, spanSeedSource, closureRounds, windowCellIds}
  created_by TEXT, reviewed_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX scene_briefs_live
  ON scene_briefs (project_id, file_id, start_cell_id, end_cell_id, target_lang)
  WHERE status = 'approved';
CREATE INDEX scene_briefs_lookup ON scene_briefs (project_id, file_id, start_cell_id);
```

Row logic in `db/shared/scene-briefs.ts` (reachable from both workers, like
`agent-memory.ts`); routes `GET/POST /api/v2/projects/:id/scene-briefs` +
`POST .../:sbId/review` in auth-worker, mounted beside `agent-memory.ts`; 10KB-per-row cap
and secret-pattern scan mirrored from `MEMORY_MAX_BYTES`; per-row `ifMatchVersion` (a
conflict scopes to one scene, not the project); propose = CONTRIBUTOR, review =
PROJECT_LEAD — scene briefs are translation work product, and translators can read/refine
the analyzer's construals. Display labels (`"LUK 1:1–1:8"`) are derived from
`canonical_ref` at read time, never authoritative. Endpoint-tombstoned cells are handled
explicitly (snap to nearest live cell inside the span; flag the brief stale).

L1/L2 discipline is `src/lib/brief/` verbatim: deterministic L2, LLM-condensed L1 with a
stated + hard-truncated char budget, staleness derived (`updated_at > l1_generated_at`),
never stored.

## 10. UI — the play/pause pill

**Mount.** Inside the editor viewport wrapper (`ProjectWorkspace.tsx` `main` slot wrapper,
already `relative`), positioned `absolute bottom-4 right-4 z-30` — *not* `fixed`. It
thereby disappears automatically on non-editor surfaces (agent workbench, settings pages)
with zero `centerSurface !== …` guards, clears the toast lane (`fixed … z-60`), the
`SelectionBar` (bottom-center), and `VersionBadge`/`UpdateBanner` (bottom-left). AppShell's
z-scale comment is authoritative; `z-30` is the floating-chip layer.

**Shape.** A `rounded-full` pill (SelectionBar's container classes:
`pointer-events-auto … rounded-full border bg-card px-4 py-2 text-xs ring-1
ring-foreground/10`), not a circle — it must show state:

- **Idle:** icon-only `Play` button (`Button size="icon-sm" variant="ghost"`, lucide icon)
  + "Contextual draft" label on hover/tooltip. AI-not-configured uses the `SparkleButton`
  `onSetupNeeded` idiom — clickable, opens setup, never `disabled`.
- **Running:** `Pause` button + hand-rolled progress bar (`h-1.5 bg-muted` track /
  `bg-primary` fill — the house pattern; there is no `progress.tsx`) + `{phase} ·
  {spanLabel}` + `{done}/{total}` in tabular-nums. Phase strings are user-words
  ("Reading context…", "Drafting…", "Checking…") — `ui-jargon-guard.test.ts` bans spec
  jargon. Clicking the span label calls
  `EditorScrollContext.requestScrollToSection(spanLabel, fileId)`.
- **Pausing:** pause is *requested* → "Finishing this passage…" until the in-flight span's
  request settles; then paused state shows `Play` (resume) + an X (cancel/dismiss).
- **Finished with failures:** retained summary (batch-completion's `finished: true`
  pattern), red accent, dismiss via X.

**Store.** New `src/lib/contextual/run-store.ts`, modeled line-for-line on
`batch-completion.ts` but **separate** (so a contextual run and a "Translate all" run
cannot supersede each other): monotonic `runId` guard on every mutator, AbortController for
cancel, **`paused` as a distinct state from `cancelled`** (pause does not abort in-flight
work), retain-on-failure summary. Split hooks (`useContextualRunState` /
`useContextualRunProgress`) à la `play-queue` so per-token updates don't re-render the pill
chrome. The driver loop: `while (spans remain && !paused && !cancelled) { POST /contextual/run
(maxSpans: 3); consume frames → store + proposals }`.

**Gate.** Author `src/lib/features/flags.ts` (the registry `ProjectRecord.experimentalFlags`
already forward-references): `contextualTranslation: { label, description, default: false }`,
`isFlagEnabled(project, key)`. Device-local by design (settings blob explicitly excludes
experimental flags); toggle in ProjectSettings, persisted via `updateProject()`. Non-discourse
files (json/po/properties/csv-without-scripture) don't show the FAB at all — the existing
"Run AI completions" remains their path (the route-around from §3's eval set).

## 11. Phase 7/8 — instrumentation, and the three things to measure first

Per node, per run (into `agent_runs`-style accounting + PostHog): tier, tokens, latency,
output count, schema-valid, rejected-by-verifier, `contributed_to_final`.

1. **Closure behavior of `scene_closure`** — distribution of rounds-to-fixpoint and the
   incomplete rate per file type. If most spans close in 1 round, the analyzer is
   rubber-stamping seeds (tighten the closure test); if many hit `max_iterations`, the
   expansion order is wrong or seeds are too small.
2. **Verifier veto rate, by stance** — how often `verify_ambiguity` kills a draft that the
   other two approved. This is the design's thesis metric: if it never fires, either the
   performer already respects the register (great — consider demoting the panel via the
   router) or the register is empty (the analyzer is resolving instead of registering —
   bad). Distinguish via mean register size.
3. **Human edit-distance on accepted drafts vs. `mode:"batch"` baseline** — same files, same
   translators, provenance already distinguishes modes. This is the eval-set score: the
   pipeline earns its ~10–40× per-cell cost premium only if review effort drops measurably.

Improvement is by subtraction first (skill order): the first ablation candidates are
`verify_force` at deep→mid, and `summarize` (inline into construe's final round) — each is
one eval-set re-run.

## 12. Out of scope (explicitly)

- Any auto-commit / auto-validate path — the human gate is a design invariant, not a phase.
- Server-side pause/resume machinery (queues, DO alarms) — the span-checkpoint idiom makes
  it unnecessary at this scale; revisit only if spans routinely exceed request limits.
- Replacing single-cell sparkle drafting or the external Agent API changeset surface.
- Wiring the dead `contextSize` setting — it stays dead until this ships; then it can be
  repurposed as the analyzer's *initial* window / roam budget, with its existing UI.
- Cross-file scene briefs (a scene spanning two files) — registered as a known limitation.
