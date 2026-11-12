# Jev decisions in the react loop — design

Date: 2026-09-30. Status: approved (Ryder, 2026-09-30). Builds on the v3 react
loop in `2026-08-28-agent-social-workspace-design.md` §v3, as ported onto dev's
AQU-1300 trust gate in PR #479.

## Problem

The react loop decides with fixed rules only. Every human edit that passes the
gates (react on, 60 s debounce, discourse file, run not busy or paused, 10 min
cooldown, batch cap) starts or wakes a run told to "reassess the surrounding
passages and update drafts". A typo fix costs a drafting run. A terminology
change that should become a project rule gets a redraft instead. An edit whose
intent is unclear gets acted on instead of asked about.

Jev (`typesafe/jev-1.13`, TypeSafe's decisions model through OpenRouter's
`/api/alpha/decisions` route) answers yes/no and 0–4 questions about a JSON
state with calibrated probabilities. It is fast and cheap. It cannot write
text. Dev already calls it for seam scoring (`auth-worker/src/routes/ai-seams.ts`).

## Scope

In scope:

1. A shared server-side decision module (`auth-worker/src/lib/jev/decide.ts`).
2. Two react-loop decisions: **whether** to react, and **what** to do.

Out of scope here (see `2026-09-30-agent-pr-threads-design.md`): timeline
salience and QA-finding triage. They reuse the module from this spec.

## 1. The shared module

`auth-worker/src/lib/jev/decide.ts` exports one function:

```ts
decide(env, {
  purpose,            // "seams" | "react" | … — names the use in logs and caps
  projectId,          // cap key
  state,              // JSON the model reads
  questions,          // Jev question set (noul / score)
  fallback,           // () => answers with the same keys, from fixed rules
  deadline?,          // absolute ms timestamp; default now + 10 s
}): Promise<{
  answers,            // one answer per question key
  decidedBy: "model" | "heuristic" | "mixed",
  reason?: "disabled" | "no_key" | "capped" | "timeout" | "upstream" | "partial",
  model: string | null,
  usage: { input_tokens: number; output_tokens: number } | null,
}>
```

- Moves out of the seam route: resolving the decisions URL, the pinned model
  id, the timeout, and answer parsing. `ai-seams.ts` calls `decide()`; its
  existing tests must pass unchanged.
- Never throws. Missing key, the kill switch, the cap, a timeout, or an
  upstream error return the fallback answers with `decidedBy: "heuristic"` and
  a reason. A response missing some keys fills them from the fallback
  (`decidedBy: "mixed"`, `reason: "partial"`).
- Cost: Jev stays outside the credit guard, as dev decided for seams (it is not
  a drafting model and must never become user-selectable). Spend is bounded by
  a per-project sliding window of **120 decisions per hour**, using the same
  rate-limit primitive the seam route uses. The seam route keeps its own
  per-user window.
- Kill switch: env `JEV_REACT=off` makes `purpose: "react"` calls return the
  fallback without calling Jev.
- `decide()` stores nothing. Each caller stores its decision with the thing
  decided.

## 2. React decisions

### Where

In `reactCheckProject`, after every existing gate and before start/wake. Jev
only spends on signals that would otherwise react today. The whole sweep gets a
20 s Jev budget (`deadline`); signals after it use the fallback.

### State

Per (file, lane) signal: file name and kind, edit count, and up to 5 of the
most recent edited cells with ref, source text, text before, and text after,
each cut to 400 characters. "Before" is the parent event's text.
`readExpertEvents` returns `id` and `parent_id`; a new `readEditSamples`
fetches the texts in one query.

### Questions

| key | type | question |
|---|---|---|
| `substantive` | noul | Does this change meaning, terminology, names, or style — not just a typo, punctuation, or spacing fix? |
| `unclear_intent` | noul | Is the intent unclear enough that asking the expert beats acting? |
| `want_redraft` | noul | Should nearby passages be redrafted in light of this edit? |
| `want_check` | noul | Should nearby drafts be re-checked instead? |
| `want_learn` | noul | Does it express a reusable rule (a term, name spelling, style) the team should remember? |

### Routing (code, constants in `react-route.ts`)

1. `substantive < 0.5` → **skip**. No run, no cooldown stamp. Reported only in
   the react-check result (`reason: "not_substantive"`).
2. `unclear_intent ≥ 0.6` → **ask**. `raiseDecision` with a templated question
   ("You changed GEN 1:3 from '…' to '…'. Should the team apply this
   elsewhere?"). No run.
3. Otherwise the highest of redraft / check / learn that is ≥ 0.5, filtered by
   the project's `agentMode.scope` (`qa` scope cannot redraft):
   - **redraft** — today's reaction direction.
   - **check** — the QA direction ("verify and report… do not redraft unless a
     check fails").
   - **learn** — a direction to capture the change as a proposed memory or
     terminology entry and not redraft. Proposals land in the existing
     approval queue (`proposeMemory` pins `status = 'proposed'`).
4. None ≥ 0.5 → **check**.

The same action sets the steering direction when a parked `awaiting_input` run
is woken.

### Fallback rules

- `substantive`: the text differs after removing whitespace, punctuation, and
  case.
- action: **redraft**, or **check** under `qa` scope. This is today's
  behaviour minus reactions to formatting-only edits.

## 3. Failures, visibility, testing, rollout

- Actions keep every existing guard: credit and word caps on starts, never
  overriding a paused run, the capped input grant before waking, proposals
  pending human approval. The cursor advances on every outcome.
- The reaction breadcrumb (`announceReaction`) states the action and a
  plain-language why, and notes "rule-based" when the fallback decided. Jev
  probabilities go in the message details for the step inspector.
- Tests: `decide()` failure modes, cap, partial answers, deadline; routing
  table (skip, ask, scope filter, default); route tests against the mock
  OpenRouter (formatting-only edit starts nothing and stamps no cooldown; learn
  and check directions; ask raises a decision without a run; Jev down equals
  today); `ai-seams.test.ts` unchanged.
- Threshold tuning: an offline eval script over ~30 labelled real edits,
  like `scripts/seam-eval.ts`. Not a CI gate.
- Rollout: only where react mode is on (inside the `agentModes` experiment);
  `JEV_REACT=off` reverts to fallback without a code deploy.
