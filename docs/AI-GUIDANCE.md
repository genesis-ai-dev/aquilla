# AI guidance — what the drafting AI is told, and from where

AQU-2342. Everything a drafting model receives is in its system or user prompt.
The app exposes **four** standing concepts and one transient one. Anything else
that used to look like guidance is now either folded into one of these or is
plumbing.

| Concept | What it is | How it reaches a prompt | Where it is edited |
| --- | --- | --- | --- |
| **Instructions** | One prose text: how this project translates. | Always, in full, on every drafting path, right after the role text. | Living Memory → Instructions (Settings → AI links there). `settings.translationInstructions`, ≤ 8000 chars. |
| **Terminology** | The termbase (the project's concepts + subscribed org termbases). | Only the terms whose source form occurs in the text being drafted, with approved/forbidden renderings and the entry's note (clipped to 160 chars). | Terminology page. |
| **Examples** | Validated work — committed, validated cells. | Picked automatically per line/span (retrieval + validated fallback). Never configured as text. | By validating cells. |
| **Checks** | Rules verified **after** drafting: project rules (incl. lane-scoped), org rules, style rules (scoped by book/genre/file/range), built-in and Bible data checks. | Verified on the draft, and **hinted** in the prompt (one "Checks" block). Built-in checks are algorithmic and add no hint text; the Language-profile data they verify against does. | Living Memory → Checks: one list, scope shown as a chip. |
| *Run directions* | Per-run steering: Autopilot directions, the agent chat, the draft tool's `instructions` argument. | Only for that run, after all standing guidance. | Not a setting — never stored as guidance. |

Knowledge ("Source documents") is a document library. It never reaches a
drafting prompt directly: the agent's knowledge tools read it, and style-rule
extraction proposes Checks from it.

## One block builder, one order

`db/shared/prompt-blocks.ts` builds the Instructions, Checks and Terminology
blocks for every path, and `assemblePromptSections` joins sections in one order:

```
role → instructions → checks → terminology → examples → context → this run's directions → output contract
```

| Path | Code | System message | User message |
| --- | --- | --- | --- |
| Copilot (single / batch / paragraph) | `src/lib/completion/prompt-build.ts`, `completion-service.ts` | role, instructions, checks, terminology, output addenda | examples, preceding context, the source |
| Prompt preview (Agent API) | `sync-worker/src/external/prompt-preview.ts` | same builder as the copilot (`parts.instructions`, `parts.checks`, `parts.terminology`) | same |
| Agent chat | `auth-worker/src/lib/agent/schema-card.ts` | role, instructions, checks (terms/examples are per line — its draft tool adds them) | the conversation |
| Agent draft tool / DraftCells | `auth-worker/src/lib/agent/tools/draft.ts` | role, instructions, checks, terminology, [E#] examples, [C#] context, run directions, the pass's task | the segments (+ the research record) |
| Autopilot performer | `auth-worker/src/lib/contextual/draft.ts` | role, instructions, checks, terminology, examples, scene brief + register + preceding + facts note, run directions, output rules | the segments |

`auth-worker/src/__tests__/prompt-section-parity.test.ts` drives every path
with one project and asserts byte-equal blocks in this order.

Before phase 2 the order and content differed per path: the copilot rendered
rules as regex prose and terms without notes, with style rules in a second
block; Autopilot rendered rule descriptions, terms with notes, plus a separate
"Project decisions" block (Language profile + decision log), examples in the
user message; the draft tool got **no** rules and **no** terms (it only linted
after); the agent chat got neither.

## Precedence

1. **Checks and terminology are hard.** They are verified after drafting; no
   instruction or run direction overrides them.
2. **Run directions beat Instructions — for that run only**, never Checks or
   terminology (the directions heading says so to the model).
3. **More specific scope wins.** Lane-scoped rules apply only in their lane;
   project rules are listed before org rules; style rules resolve through the
   applicability graph (segment → passage → section → document → genre →
   global), so a narrower assignment or exclusion beats a broader one.

## Where each old setting went

Nothing stored was deleted. Old keys stay readable: until the project saves its
Instructions, `resolveTranslationInstructions` composes them on read (in this
order, de-duplicated); once saved, the old keys are ignored by every prompt.

| Old setting | Now |
| --- | --- |
| Translation brief (summary / sections / notes) | Instructions (migrate-on-read). "Help me write this" runs the brief interview into Instructions. |
| Customised copilot system prompt (`systemPrompt`) | Instructions (the hand-written part only; the role text is fixed). |
| Living Memory "instruction" entries | Instructions (migrate-on-read). |
| Living Memory "standard" entries | Instructions (migrate-on-read) — phase 2. |
| Decision log `settings.projectFacts` (Autopilot decision cards) | Instructions: answering a card appends `- key: answer (scope) — note`; existing facts fold in on read as a "Project decisions:" paragraph. The log is kept as the record of answered questions (so a question is never asked twice) and for the Bible data checks' agreed names. |
| Language profile `settings.languageProfile` (12 slots) | Data behind **Checks**: the Bible data checks need it structured, so it stays its own store. Its editor lives in the Checks pane; its filled slots ride in every checks hint. A decision card whose key names a slot still writes the slot (maintainer floor). |
| Agent `project_briefs` (legacy agent brief) | Instructions (migrate-on-read). |
| Agent memory `decisions/` | Approval (in-app review or an ask-mode AddDecision approved by a lead) appends the decision to Instructions; already-approved decisions fold in on read. The memory row stays as the record. A full Instructions box refuses the approval. |
| Agent memory `examples/` (AddExample) | Kept as agent working memory (chat memory index only). Not routed to Examples: Examples are validated cells, and an example pair is not a cell — to teach every draft a pair, validate a cell or add a term. Descriptions corrected (they claimed the copilot read them). |
| Agent memory `notes/`, `observations/` | Agent working memory, unchanged. Never drafting guidance. |
| Agent tool `propose_brief_update` | Retired from the tool list; a legacy call becomes a `propose_memory` under `decisions/instructions-<hash>.md` (same human gate; approval appends to Instructions). |
| Project rules, lane rules, org rules, style rules, built-in check overrides | One **Checks** list in the UI (stores unchanged). One hint renderer for every path; org rules and style rules now also reach the draft tool and Autopilot. |
| `knowledgeBaseEnabled` ("use knowledge base in drafting") | Switch removed: no drafting path ever read it. The stored value is untouched. |

## Role note for decision cards

Answering a card is CONTRIBUTOR+ (unchanged) and now appends to the Instructions,
whose editor is maintainer-gated. That is deliberate: the card flow already let
contributors set project policy (the fact), and there is no pending-suggestion
mechanism for Instructions edits to route through. A card whose key names a
Language-profile slot keeps its maintainer floor. Agent `decisions/` memories
reach the Instructions only through the existing memory review (PROJECT_LEAD+).
