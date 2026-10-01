# Agent runs as pull requests — design

Date: 2026-09-30. Status: approved direction (Ryder, 2026-09-30: "one run = one
PR", "review + inline" QA, Jev for salience and triage; detail left to the
implementer). Builds on the Team workspace in PR #479 and on
`2026-09-30-jev-react-decisions-design.md` (the shared `decide()` module).

## Problem

A long autopilot run reads as a flat feed: every passage's start, phases,
scene notes, staged drafts, and outcome, one after another. Review is a
separate one-cell-at-a-time screen. The verifier panel's work is invisible:
the pipeline knows which accepted cells drew a dissenting verifier vote, a
lint flag, or an unsupported-wording flag, and discards all of it when it
stages (`tick.ts` stages with `verdicts: {}`). A reviewer cannot tell a clean
passage from one that squeaked through.

## Model: one run = one pull request

| GitHub | Aquilla |
|---|---|
| PR title + state badge | run title + Drafting / Needs review / Done / Stopped |
| description | who started it (you, autopilot, a reaction), scope, lane |
| Conversation tab | the run's timeline, grouped by passage |
| review entry in the timeline | the Reviewer's per-passage review ("2 findings, 1 needs you") |
| Files changed + line comments | the run's pending drafts as diff cards, findings attached to their cell |
| Checks tab | every finding, "needs you" first |
| Merge | approve drafts (per cell, or "Approve all without findings") |

URL: the existing `?view=review` becomes the **Files changed** tab; a new
`?view=checks` is the **Checks** tab; no view param is **Conversation**.

## 1. Findings: keep what the pipeline already knows

In `pipeline.ts`, for each accepted cell, collect categorical finding codes
from the final attempt:

- `dissent:<verifier>` — a verifier (force / naturalness) voted no on the cell
  but the quorum accepted it. (An ambiguity "no" is a veto, so it never reaches
  staging.)
- `lint:<ruleId>` — a lint flag on the cell.
- `unsupported` — the support check confirmed the cell as risky.
- `redrafted` — the cell was rejected once and redrafted with constraints.

`stage()` receives them per cell and stores them in the draft's existing
`verdicts` jsonb as `{ "<code>": "flag" }`. Codes only: the rule that raw
verifier or model prose is never durable holds. No migration.

## 2. Triage (Jev)

At staging, cells with at least one finding go to `decide({ purpose:
"triage" })`: per cell, source, draft text, finding codes (and lint rule
messages, which are project configuration), with two questions per cell:

- `c<i>_needs_human` (noul) — would a translator reviewer need to look at this
  before approving?
- `c<i>_severity` (score 0–4) — how serious is the risk to meaning?

Stored alongside the codes: `_triage: "human" | "advisory"`,
`_severity: "0".."4"`, `_decidedBy: "model" | "heuristic"`.

Fallback: `unsupported` or any `dissent:*` → human, severity 3; `lint:*` only
→ advisory, severity 2; `redrafted` only → advisory, severity 1.

Triage never blocks staging: a failed or slow call falls back, and the draft
is staged either way.

## 3. Timeline salience

A passage is **notable** when any of its drafts is triaged `human`, its
outcome is failed or partial, or it raised a question. Notable passages render
expanded; the rest collapse to one summary line ("Drafted MRK 4:1–4:8 · 6
drafts · no issues"). This reuses triage, so there is one Jev decision per
staged passage at most, not one per event. The existing rule (2+ routine phase
updates collapse) still applies inside an expanded passage.

## 4. UI

- **Header** (`TeamConversationHeader`, run mode): state badge, a one-line
  description, and the tab row with counts. Team chat and the questions
  conversation keep today's header.
- **Conversation**: the feed grouped by passage (`groupFeedByPassage` in
  `social-feed.ts`), each passage a collapsible section with the summary line,
  plus a Reviewer review entry when the passage has findings.
- **Files changed**: every pending draft of the run as a card — source,
  current text, proposed text — with its findings as comment chips (i18n
  labels per code, severity, "needs you"). Per card: Approve and Edit, reusing
  the existing review actions in `agent-draft-review.ts`. A bulk **Approve all
  without findings** approves only cards with no findings at all.
- **Checks**: findings grouped "Needs you" then "Advisory", each linking to
  its card in Files changed.

## 5. Testing

- Pipeline: findings codes per accepted cell (dissent, lint, unsupported,
  redrafted); ambiguity vetoes never appear as findings; stage receives them.
- Triage: model answers mapped per cell; fallback table; failure never blocks
  staging.
- `groupFeedByPassage` and notability: clean passages collapse, notable ones
  stay open.
- RTL: header tabs and counts; Files changed cards with finding chips; Approve
  all without findings skips cards that have findings; Checks lists "needs you"
  first and links to the card.
