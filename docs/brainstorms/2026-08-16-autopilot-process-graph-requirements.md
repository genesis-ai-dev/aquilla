---
date: 2026-08-16
topic: autopilot-process-graph
---

# Autopilot process graph

## Summary

Add a small, quiet picture of the real Autopilot process graph — every engine step, with visible DAG edges — at the top of the activity inspector, and a quieter miniature on the project Autopilot card. Lit nodes show current activity (several at once when several spans are in flight). Hover a node for the live span, scene brief, and structured decision; click through to the existing inspector details for reassurance.

## Problem Frame

Autopilot already records durable activity, but the inspector presents it as a text log. A translator or project manager watching a run has to read and interpret that log to know where the engine is. The project card is worse: it mostly says the run is working. The need is glanceable status that still lets someone dig in without operating an engineer console.

## Key Decisions

- **Real topology, quiet chrome.** Show the actual process nodes (scope through report, including the three verifiers and the construe/expand and redraft loops). Keep labels and reasons on hover so the picture stays little. Draw flow between nodes — directed edges, loop/back-edges as quieter dashed curves, active edges with a restrained flow.
- **Structured reasons only.** Hover and inspect use persisted construal, scene brief, verifier/skip/risk reasons, and span identity. No model chain-of-thought and no prompts.
- **Spans stay spans.** Do not change seed size or serialize the engine. A localized tooltip explains that a span is usually 8–12 cells so Autopilot can read surrounding context.
- **Parallel tokens.** Several in-flight spans can light several nodes at once. The project card cannot honestly label every node; it is a glow-map of the same topology. The sheet is where names and inspect live.
- **The graph stays.** Idle, paused, failed, and finished runs keep the map as a quiet record you can still hover, rather than hiding it.
- **Reuse the inspector.** The graph sits on top of the existing sheet and card. It does not replace the timeline, review, or technical evidence, and it does not add a dedicated run page.

## Actors

- A1. Translator or project manager watching a live or recent run
- A2. Autopilot engine (existing span graph, waves, activity events)

## Key Flows

- F1. Glance during a live run
  - **Trigger:** A run is working, or the inspector is open on a run.
  - **Actors:** A1, A2
  - **Steps:** The card shows the miniature graph with live glow. Opening activity shows the readable graph at the top of the selected run. Active nodes and edges mark current steps; more than one node may be lit.
  - **Outcome:** A1 knows the run is in a real workflow, not merely “working.”
- F2. Hover to inspect what is in play
  - **Trigger:** A1 hovers a node.
  - **Steps:** The hover shows the node’s name and role, the live or latest span label, the scene brief when one exists, and the last structured decision for that step.
  - **Outcome:** A1 can check the passage and the decision without reading the log.
- F3. Dig in for reassurance
  - **Trigger:** A1 clicks a node on the inspector graph.
  - **Steps:** An inspect panel under the graph shows the same structured evidence in a bit more space. The existing activity, review, context, and technical sections remain below.
  - **Outcome:** A1 can confirm what happened without leaving the sheet.

## Requirements

**Glance and surfaces**

- R1. The selected run in the activity inspector shows the full process graph above the existing step timeline.
- R2. The project Autopilot card shows a quieter miniature of the same topology (glow and structure, not labeled nodes).
- R3. With no hover and no click, the inspector graph makes the live span, overall passage progress, current region of the graph, and last structured decision visible.
- R4. Several in-flight spans may light several nodes and edges at the same time.
- R5. Finished, paused, failed, and idle runs still show the graph as a quiet record.

**Graph shape**

- R6. The graph includes the real engine steps: scope, segment, construe, expand, register, summarize, persist, draft, lint, route, force, ambiguity, naturalness, quorum, stage, and report.
- R7. Directed edges show typical flow. The construe↔expand loop and the quorum→draft redraft path are visible as quieter dashed back-edges.
- R8. Node names stay visually quiet; hover (and the inspector inspect panel) is where names, roles, and reasons are read.
- R9. A localized tooltip explains that a span is usually 8–12 cells so Autopilot can use surrounding context.

**Inspect**

- R10. Hovering a node shows source-span identity (label / cell range), the scene brief when present, and the last structured decision at that step.
- R11. Inspect uses only structured persisted reasons (construal, ambiguities, skip/risk/verifier outcomes). It does not show prompts or model thinking text.
- R12. Clicking a node on the inspector graph opens an inspect panel that leads into the existing evidence sections rather than replacing them.

**Honesty**

- R13. Node lighting is derived from durable activity the client already has (span start, phase, scene ready, drafts staged, span outcome, plus the run’s coarse phase). The first cut does not require new per-node telemetry. Where a phase only identifies a region, the region lights rather than inventing a more precise node.

## Acceptance Examples

- AE1. Live checking span
  - **Covers R1, R3, R4, R6, R10.**
  - **Given:** A run is working and the latest events say span `LUK 1:1–1:8` is in the checking phase.
  - **When:** A1 opens the inspector.
  - **Then:** The graph is at the top of that run, the checking-region nodes are lit, the last decision line is readable without hover, and hovering a lit node names `LUK 1:1–1:8` and any scene brief or skip/risk reason already on the activity.
- AE2. Two spans in flight
  - **Covers R4, R7.**
  - **Given:** One span is drafting and another is still reading.
  - **When:** A1 looks at the inspector graph.
  - **Then:** Both regions are lit and their inbound edges show flow. The picture does not collapse to a single “current step.”
- AE3. Finished run
  - **Covers R5, R12.**
  - **Given:** The run is complete.
  - **When:** A1 opens activity later.
  - **Then:** The graph is still there, settled rather than glowing as live work. Clicking a node still opens inspect and the timeline below still has the record.
- AE4. Project card
  - **Covers R2, R8.**
  - **Given:** A1 is on the project overview, not in the editor.
  - **When:** A run is working.
  - **Then:** The Autopilot card shows the miniature unlabeled graph with live glow. Opening activity is how they read node names.

## Success Criteria

- A translator or project manager can tell where a run is without reading the activity log.
- The picture is small enough to live in the inspector header and the overview card without becoming a dashboard.
- Someone who wants reassurance can hover or click and see structured evidence, then keep scrolling into the existing inspector.

## Scope Boundaries

**Deferred for later**

- Per-node live telemetry from the worker (construe vs expand vs summarize as distinct events)
- Source-cell text on the activity payload when the span label and scene brief are not enough
- Changing span size, serializing waves, or a dedicated second-screen run page
- Showing prompts or model chain-of-thought

**Outside this cut**

- Replacing the inspector timeline, review, or technical evidence
- A new Autopilot home or run-history product

## Dependencies / Assumptions

- Durable activity events already include `span_started`, `phase`, `scene_ready`, `drafts_staged`, and `span_outcome`, plus scene briefs and staged drafts on the activity payload.
- Overview file rows do not carry per-node phase, so the card miniature is a glow-map unless a later change adds that field.
- Missing translation keys fall back to English.

## Sources / Research

- Process topology: `docs/superpowers/specs/2026-07-25-contextual-translation.graph.yaml`
- Current inspector: `src/components/contextual/AutopilotActivityInspector.tsx`
- Project card: `src/components/org/ProjectAutopilotPanel.tsx`
- Activity events: `auth-worker/src/lib/contextual/tick.ts` (`persistContextualProgressFrame`)
- Prior observability: AQU-826
