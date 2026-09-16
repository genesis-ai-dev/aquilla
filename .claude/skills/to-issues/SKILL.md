---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

**Issue tracker for this repo:** Linear, team `Aquilla` (key `AQU`, id `de0f5d29-418f-4f62-ade7-02f77974c598`), project `Prototype Debugging` (id `215cff7b-1a95-443d-9343-1f1528754462`). See the `/issue` command and `AGENTS.md` → "Issue workflow" for the status pipeline and the agent-vs-human pickup contract.

**Where each slice lands:**

- **Every slice is created with status `Triage`** (`086173c5-e3e4-4f37-93d5-ae2f069ab6a6`) — new issues are **never created in `Todo`** (`a3c6383f-3893-4691-a75a-b4add1ff1ce1`), whatever their type. The HITL/AFK split determines what happens *after* creation:
  - **AFK slice** — agent-ready once promoted: a human promotes it `Triage → Todo` (via `/triage`, or by explicitly approving promotion in step 6 of an interactive run), and only then do the swarm and `/issue next` see it. A slice without acceptance criteria isn't AFK.
  - **HITL slice** — stays in `Triage`: a human must make the decision / do the review / implement before it's agent-ready. Agents never pick these up. `/triage` promotes it to `Todo` once (and if) it becomes AFK.
- **Every issue is created from one of the Aquilla team's issue templates** (`Bug Report`,
  `Feature Request`, or `Task` — see step 6). The template applies the category label
  (**`Bug`**, **`Feature`**, or **`Improvement`** for `Task`) by itself.
- **Every issue carries a Prototype Debugging milestone** — the Road to V1 area it belongs
  to (see step 6). An issue with no milestone is uncategorized and invisible to the Road to
  V1 views.

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

Before quizzing the user, query the issue tracker to enumerate the available **teams and projects** — do not guess from memory or recent context. Every issue needs both a team AND a project. The project is not optional and not an afterthought; an unassigned issue is a defect. In `Prototype Debugging`, every issue also needs a **milestone** (its Road to V1 area) — `list_milestones` the project for the live list.

Confirm the target team and project with the user using the real options you just fetched. If a plausible project already exists (e.g. a debugging/triage project for bug-style work), surface it by name rather than making the user paste a URL.

### 5. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Milestone**: the Prototype Debugging milestone (Road to V1 area) the slice lands in
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 6. Publish the issues to the issue tracker

For each approved slice, publish a new issue **from one of the Aquilla team's issue
templates** — pass `template` to `save_issue`:

- **`Bug Report`** — something is broken
- **`Feature Request`** — a new user-facing capability
- **`Task`** — everything else (chores, improvements, refactors, infra)

The template applies the matching category label by itself (`Bug` / `Feature` /
`Improvement` for `Task`) — don't re-pass it; extra labels you do pass are merged, not
replaced.

**Create every issue with status `Triage`** (see "Where each slice lands" above) — never
`Todo`, even for AFK slices. ⚠️ **All three templates embed status `Todo`**: you MUST pass
`state: Triage` explicitly on every create (an explicit `state` overrides the template's),
and **verify the create response says `status: Triage`** — if it came back `Todo`,
immediately re-save it to `Triage`.

**Leave every issue unassigned.** The team's auto-assign rotation sets an assignee at
create time (it wins even if you pass no assignee) — if the create response shows an
assignee, immediately re-save with `assignee: null` and confirm the response no longer
lists one.

Mark the slice's type (HITL/AFK) in the issue body (see below). If the user is present and
explicitly approves it, promote the AFK slices to `Todo` after creation; in an unattended
run, leave everything in `Triage` for `/triage` to promote. An AFK slice you can't write
acceptance criteria for isn't AFK — it's HITL.

**Set BOTH the team and the project on every issue.** Verify the publish response actually
shows the project assigned — do not assume it stuck.

**Set a milestone on every issue** (`milestone` on `save_issue`, by name). Prototype
Debugging's milestones are the Road to V1 areas: `Media Timeline`, `Living Memory`, `Dashboard`, `Project Management`, `Autopilot`, `Editor`, `Importing`, `Exporting`, `Login/Logout`, plus the catch-all buckets `Audio & Voice`, `Agents & Agent API`, `Comments & Notifications`, `Codex Migration`, `Infra & Deploy`, `Process & Docs`, `Marketing & Billing`.
Fetch the live list with `list_milestones` rather than trusting this text. When the source
is an existing issue, inherit its milestone; otherwise pick the area the slice's user-facing
surface belongs to and confirm it in step 5. If the parent issue is in a cycle, pass the same
`cycle` so the slice stays in the cycle. Verify the create response shows the milestone.

Publish issues in dependency order (blockers first) so you can reference real issue
identifiers in the "Blocked by" field.

**Fill the template's body, don't replace it.** Passing a `description` replaces the
template's pre-filled body wholesale, so author the description using the template's exact
section headings, filled with real content (never placeholder text), then append the
slice-tracking sections at the end. Section requirements:

<template-bodies>

Common to all three templates (they all end with `## Acceptance Criteria` then
`## Test Checklist`):

- **Acceptance Criteria** — write these so QA can **verify the fix and demonstrate WHY it's
  fixed**, not just trust that it is. Each criterion is a checkbox observable by someone
  driving the real app — a concrete state, value, or behavior they can see, not an internal
  implementation detail. Tie at least one criterion back to the reproduction ("the step that
  used to fail now does X"). Include the negative/edge case where relevant (e.g.
  genuinely-empty still shows 0%, no false positive). If a criterion can't be checked by
  observing the app, it belongs in the description sections, not here.
- **Test Checklist** — the concrete checks a tester performs to prove the criteria (what to
  drive, what to observe), grouped under sub-headers when there are distinct surfaces.
- Avoid specific file paths or code snippets — they go stale fast. Exception: a
  prototype-produced snippet that encodes a decision more precisely than prose can (state
  machine, reducer, schema, type shape) — inline just the decision-rich parts and note it
  came from a prototype.

**`Bug Report`** (`## Description`, `## Steps to Reproduce`, `## Expected Behavior`,
`## Actual Behavior`, then the common sections): Steps to Reproduce must let a QA tester
recreate the situation cold, with no memory of this conversation — exact steps, route/URL,
account or data state. Actual Behavior carries the observed wrong behavior (error, 500,
0%, etc.).

**`Feature Request`** (`## Summary`, `## Problem`, then the common sections): Summary
describes the end-to-end slice behavior, not layer-by-layer implementation. Problem gives
the starting state, the current workflow and why it falls short, and where a tester
exercises the new behavior.

**`Task`** (`## Summary`, `## Context`, then the common sections): Summary is the slice's
end-to-end behavior; Context is why it needs doing, plus background and links.

Append these tracking sections to every issue body, after the template's sections:

```
## Slice

HITL or AFK (one line on why, if HITL).

## Parent

A reference to the parent issue (omit this section if the source wasn't an existing issue).

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.
```

</template-bodies>

Do NOT close or modify any parent issue.
