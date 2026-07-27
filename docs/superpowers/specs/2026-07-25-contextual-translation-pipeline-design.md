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

Everything exits through the existing safety perimeter: staged with provenance, role
floors, and staleness preconditions, gated by **persisted changesets** a human reviews on
their own schedule. **The pipeline never commits anything.**

The run is **autonomous and long-lived**: press play once and the agent works the file
continuously — through tab closes, overnight, until done — staging drafts as it goes. What
streams to the UI is **steps and outcomes** (scene construed, span drafted, votes, staged),
never model token output or reasoning. The human expert is not an operator but a
**steering input**: validations, edits, comments, and direct instructions land in a
steering channel the agent reads between spans, and each one makes the agent better
(validated cells become examples; corrected briefs re-scope future construals). A floating
**play/pause pill** in the editor is the transport control and live status readout for
that run; pause suspends the durable run itself, not a client loop.

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

## 8. Execution architecture — durable, autonomous, steerable

The product intent is an **always-on agent**: play once, the run outlives the browser, the
human injects direction while it works. That rules out the client as sequencer and makes
**Cloudflare Workflows** the execution engine — the repo's first durable-execution surface,
and a deliberate one:

- **One Workflow instance per (project, file, targetLang) run.** Each graph node executes
  inside `step.do()` with a retry policy; the step-result cache *is* crash recovery (a
  restart replays cached node outputs and resumes at the first incomplete step — the same
  semantics §6's loops assume, now platform-enforced).
- **Pause/resume are instance operations.** The FAB's pause calls the Workflows API
  `pause()` on the instance; play calls `resume()` (or creates an instance). No in-flight
  span is aborted; the instance parks at the next step boundary. Cancel = `terminate()`.
- **The graph stays code-orchestrated** inside the workflow: routers branch in code, quorum
  is counted in code, loops carry their three stops. The Workflow adds durability, not
  judgment. Node implementations are **plain async functions with serializable in/out**
  (guaranteed by the typed edge schemas) so they are testable without the Workflows
  runtime, and so vitest covers them in `happy-dom` like everything else.

**Progress channel: the project DO, not SSE.** A detached run has no request to stream
over. Each step completion POSTs a compact outcome event to the existing `ProjectSync` DO
(same pattern as `settings-changed` notify), which broadcasts to connected clients:

```
contextual.run.state   {runId, fileId, status: running|paused|done|failed, done, total}
contextual.scene       {runId, sceneBriefId, spanLabel, ambiguityCount}
contextual.span        {runId, spanLabel, staged, skipped, verdictSummary}
```

Outcomes only — **never token deltas, never model reasoning**. A client that was closed
missed nothing: state is reconstructable from rows (`scene_briefs`, staged drafts,
`agent_runs` accounting); the DO feed is a live view, not the record.

> **v1 implementation notes (2026-07-26).** Two deliberate narrowings shipped in the first
> build: (1) the durable engine is a Postgres-backed run row (`contextual_runs`) driven by
> a one-span-per-tick executor with server-side self-continuation — all state resumable
> from rows, so the Cloudflare Workflows binding can wrap the same tick function later as
> a pure scheduler swap (wrangler 3.x local-dev support for Workflows is not yet solid
> enough to sit under the e2e gate); (2) staged drafts persist in a `contextual_drafts`
> table reviewed via the existing client apply path, with the full external-changeset
> (preconditions/digest) migration as follow-up. Neither changes the graph, the human
> gate, or the frame contract.

**Persisted proposals (the gate moves from System A to System B).** With no client
guaranteed present, in-memory `AgentProposal` frames can't carry the human gate. Staged
drafts become **persisted changesets** — reusing the existing `changesets` machinery
(preconditions, digest, `staged → committing → committed`, staleness on commit) with
`autonomy_mode: 'ask'`. The agent **works ahead without waiting**: drafting span N+1 is
never blocked on approval of span N (approval affects only what's *committed*, and
freshly-validated cells feed forward as examples whenever approval does happen). The
review surface is the working set fed from persisted changesets instead of frames — the
per-row accept/edit/reject UX is unchanged.

**Steering channel.** The human stimulates the agent; the agent reads steering **between
spans** (a checkpoint boundary), never mid-step:

| input | mechanism | effect on the run |
|---|---|---|
| validate / edit a target cell | existing events, no new UI | example pool improves for later spans (no staleness — see re-work tiers below) |
| source-side change (edit/insert/re-import) | existing events | span's brief marked stale instantly; re-construal per the debounce policy below |
| edit / reject a scene brief | `scene_briefs` review routes | agent re-runs construe for that span before drafting it (or re-drafts if already staged) |
| free-text direction ("keep the register formal in dialogue") | steering entry, appended to a `contextual_steering` table (10KB cap, provenance) | injected into construe + draft prompts for subsequent spans, displayed as an active-direction chip |
| reject a staged draft with reason | changeset reject + note | reason attaches as a constraint if the span re-enters the redraft loop |

Between spans the workflow does one cheap read: new steering rows + newly-validated cells
+ brief reviews since the last checkpoint. Nothing polls; a paused or finished run is
woken by `waitForEvent()` when steering arrives (this is also how "usually just on" works
without burning tokens while idle — the run parks when the file is converged and wakes on
change: new source cells, an edit invalidating a span, or a steering entry).

### Staleness and re-work policy

Two clocks, deliberately decoupled: **marking is instant, re-work is debounced.** Stale
marking is pure code (an event inside an approved span sets `stale_since`/`stale_reason`
on its scene brief and pushes a `contextual.scene` frame so the badge appears immediately);
re-work costs tokens, so it waits. The user can always collapse the wait.

Re-work is **tiered by what actually changed** — not every change dirties the construal:

| tier | trigger | work |
|---|---|---|
| example-refresh | target-side only (validation, target edit) | none on the brief — the source situation didn't change; the improved example pool simply feeds later drafting |
| re-verify | adjacent span's brief changed (this brief's expansion consumed it) | cheap fast-tier check: "does the neighbor's new construal contradict this one?" — escalate to re-construe only on contradiction |
| re-construe | source-side change inside the span (edit, insert, delete, re-import) | construe re-runs **with the prior construal + the diff as input**; round 1 asks whether the change alters the construal, so unchanged scenes close in one mid-tier call |
| re-draft | brief changed after cells were staged | affected staged changesets are already `plan_stale` by precondition; span re-enters at `draft` |

**Scenarios** (the policy, exercised):

1. **Translator typing inside a span.** First commit marks the brief stale instantly;
   every further event resets a **long debounce** (default 10 min of quiet, tunable in the
   run settings). While any cell in the span holds an active focus lease, the agent never
   re-drafts it — the lease system is already the "human is here" signal; the agent
   respects it like any collaborator. After the quiet period the span enters the re-work
   queue at normal priority.
2. **Reviewer validates twenty cells.** Example-refresh tier: no staleness, no
   re-construal. The next spans the run reaches simply retrieve better examples; cells
   previously skipped by quorum may be re-attempted with the richer pool.
3. **Source re-import touches the span.** Immediate stale + the staged changesets covering
   it go `plan_stale` on their own preconditions. Highest autonomous priority: this is the
   one tier that jumps the debounce (the drafts on screen are provably against dead
   source), re-construing with the diff-aware prior.
4. **User clicks "Update now" on the stale badge.** A `refresh_span` steering entry jumps
   the queue; a parked or paused run wakes for that one span (bounded wake — process it,
   re-park). Manual trigger always wins over any debounce or budget slice.
5. **Stale span left alone.** It runs eventually on its own: the parked run's wake-ups
   include a maintenance sweep processing stale spans oldest-first under a **maintenance
   budget slice** (default ≤20% of the run's daily units) so re-work can never starve
   fresh drafting — and vice versa: fresh drafting can't indefinitely defer maintenance,
   because the sweep runs at every wake before the run re-parks.
6. **Cascade guard.** A re-construal that *changes* a brief marks only its **one-hop
   neighbors** (spans whose expansion consumed it) as re-verify tier — never auto
   re-construe, never transitive. A contradiction found by re-verify escalates that one
   neighbor, which may in turn mark *its* neighbors — so a genuine meaning shift ripples
   hop by hop with a model check gating each hop, while a cosmetic change dies at radius 1.
   (Same instinct as AD-14's per-hop decay: influence fades with distance from the change.)

Priority order in the queue, highest first: user-triggered → source-dead spans (scenario
3) → spans blocking untranslated cells → re-verify checks → stale-but-fully-translated
spans. Every deferral is visible: the stale badge shows *why* it's waiting ("editing in
progress", "queued behind 3 spans", "maintenance window").

**Identity and budget.** A detached run cannot ride the user's ephemeral JWT. The instance
runs under a **project-scoped stored authorization** (the credential model the external
Agent API already defines), snapshotting the initiating user + role; role floors are
re-evaluated at stage time by `stageEvents` as always, and the run self-suspends (status
`paused`, reason surfaced) if the initiator loses the role mid-run. Credit/budget guards
run per span, not per request: daily caps from the existing `runAiGuard`/credit-guard
plumbing, plus the per-span unit cap from §7 — an always-on agent's failure mode is a
quiet money leak, so `budget` outcomes go on the DO feed and the pill.

**Dev/test.** `wrangler dev` runs Workflows locally; `dev-stack.ts` gains the binding and
points model calls at the existing mock OpenRouter. Node functions unit-test without the
runtime; one e2e drives play → steering injection → pause → resume → review.

**Why not inside the existing conversational agent loop?** It remains a *client* of this
system (a `/contextual` slash command can start or steer a run), but the pipeline is
deterministic code — budget, latency, and auditability don't survive delegation to a
model orchestrator.

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
  stale_since TEXT,                     -- instant marker; NULL = fresh
  stale_reason TEXT,                    -- 'source-edit' | 'neighbor-change' | 'endpoint-tombstoned' | ...
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
- **Pausing:** pause is *requested* (instance `pause()`) → "Finishing this passage…" until
  the workflow parks at its next step boundary; then paused state shows `Play` (resume) +
  an X (terminate). Closing the tab changes nothing — the run continues; the pill simply
  re-attaches to live state on return.
- **Parked (converged):** when the file is done and the run is waiting on change, the pill
  shows a quiet "Watching for changes" state — the always-on posture made visible.
- **Finished with failures:** retained summary (batch-completion's `finished: true`
  pattern), red accent, dismiss via X.

**Store.** New `src/lib/contextual/run-store.ts` — same module pub-sub +
`useSyncExternalStore` idiom as `batch-completion.ts`, but it is a **mirror, not a
driver**: state hydrates from a `GET /contextual/runs?fileId=` snapshot and updates from
`contextual.*` DO frames on the existing project WebSocket; play/pause/terminate are
transport commands (`POST /contextual/runs`, `.../:runId/pause|resume|terminate`).
`paused` stays distinct from `terminated`. Split hooks (`useContextualRunState` /
`useContextualRunProgress`) à la `play-queue` so frequent progress frames don't re-render
the pill chrome. Step outcomes also append to the agent dock's timeline (the existing
`TimelineItem` surface) so the "streaming steps and outcomes" feed has a full-height home;
the pill is the always-visible summary of the same store.

**Steering input.** The composer already exists — the agent dock. A new "direct the run"
affordance posts a `contextual_steering` entry (and the `/contextual` slash command does
the same from chat); active directions render as dismissible chips above the dock
timeline. Cell edits, validations, and scene-brief reviews steer implicitly with no new UI.

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

### Anchors and frozen rules

The verifier panel is an LLM judging an LLM against an LLM's register — left alone, the
three can converge into mutual confirmation: everything consistent, nothing verified. So
the system's **anchors** — measurements that settle against the world, not against another
model — are named here, and every tuning decision must key off them alone:

- human edit-distance on accepted drafts vs. the `mode:"batch"` baseline (metric 3);
- human validation / rejection rates on staged drafts;
- scene-brief review outcomes (approve / edit / reject by a person).

Metric 2 (the ambiguity-veto rate) is a *diagnostic*, never an optimization target —
optimizing toward it teaches the performer to please the verifier, not the reader.

**Frozen rules** — never tunable by any optimization pass, ablation, or future automation,
precisely because they are what an optimizer would most want to relax: the human gate (no
commit without a person), the mandatory `verify_ambiguity` stance with its code-counted
veto, and the validated-only example pool. Changing any of these is a human design
decision recorded in this document, not a parameter sweep.

## 12. Out of scope (explicitly)

- Any auto-commit / auto-validate path — the human gate is a design invariant, not a
  phase. Autonomy means the agent *works ahead* unattended; it never means commits land
  without a human decision.
- Replacing single-cell sparkle drafting; the external Agent API surface is *reused*
  (changesets, credential model), not replaced.
- Multi-file / whole-project runs in v1 — one instance per file keeps blast radius,
  budget, and the review queue legible; a project-level "play all" is a later composition.
- Wiring the dead `contextSize` setting — it stays dead until this ships; then it can be
  repurposed as the analyzer's *initial* window / roam budget, with its existing UI.
- Cross-file scene briefs (a scene spanning two files) — registered as a known limitation.
