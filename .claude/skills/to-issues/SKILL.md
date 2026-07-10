---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

**Issue tracker for this repo:** Linear, team `Aquilla` (key `AQU`, id `de0f5d29-418f-4f62-ade7-02f77974c598`), project `Prototype Debugging` (id `215cff7b-1a95-443d-9343-1f1528754462`). See the `/issue` command and `AGENTS.md` → "Issue workflow" for the status pipeline and the agent-vs-human pickup contract.

**Where each slice lands (this is the whole point of the HITL/AFK split):**

- **AFK slice → status `Todo`** (`a3c6383f-3893-4691-a75a-b4add1ff1ce1`). Agent-ready: the swarm and `/issue next` pull from here. Only publish to `Todo` if acceptance criteria are actually present.
- **HITL slice → status `Triage`** (`086173c5-e3e4-4f37-93d5-ae2f069ab6a6`). The human queue — a human must make the decision / do the review / implement before it's agent-ready. Agents never pick these up. `/triage` promotes it to `Todo` once (and if) it becomes AFK.
- Tag every issue with a category label: **`Bug`**, **`Feature`**, or **`Improvement`**.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Discover the destination FIRST

Before quizzing the user, query the issue tracker to enumerate the available **teams and projects** — do not guess from memory or recent context. Every issue needs both a team AND a project. The project is not optional and not an afterthought; an unassigned issue is a defect.

Confirm the target team and project with the user using the real options you just fetched. If a plausible project already exists (e.g. a debugging/triage project for bug-style work), surface it by name rather than making the user paste a URL.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 6. Publish the issues to the issue tracker

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below. **Set the status by the slice's type** (see "Where each slice lands" above): **AFK → `Todo`**, **HITL → `Triage`**. Add the `Bug`/`Feature`/`Improvement` category label. Never publish an AFK slice to `Todo` without acceptance criteria — if you can't write them, it's HITL, and it goes to `Triage`.

**Set BOTH the team and the project on every issue.** Verify the publish response actually shows the project assigned — do not assume it stuck.

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

<issue-template>
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Reproduction / context

How a QA tester recreates the situation cold, with no memory of this conversation. For a bug: the exact steps, route/URL, account or data state, and the observed wrong behavior (error, 500, 0%, etc.). For a feature: the starting state and where to exercise the new behavior. A QA lead must be able to land here and reproduce the original problem without asking anyone.

## Acceptance criteria

Write these so QA can **verify the fix and demonstrate WHY it's fixed**, not just trust that it is. Each criterion must be observable by someone driving the real app — a concrete state, value, or behavior they can see, not an internal implementation detail. Tie at least one criterion back to the reproduction above ("the step that used to fail now does X"). Include the negative/edge case where relevant (e.g. genuinely-empty still shows 0%, no false positive). If a criterion can't be checked by observing the app, it belongs in the description, not here.

- [ ] Criterion 1 (observable: what the tester sees / does)
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.

</issue-template>

Do NOT close or modify any parent issue.
