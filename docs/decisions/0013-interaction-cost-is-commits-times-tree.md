# 0013 — An interaction costs commits × rendered tree × work in render

*Decided and recorded 2026-11-19, from the AQU-2654 investigation.*

## Context

A BibleProject advisor reported that the app "takes a deep breath after every
action, click, or letter typed". The report read as a large-glossary problem.
It was not: the same pause was measured on a 239-cell project with no glossary
at all. On a production build at 4× CPU slowdown (a translator's laptop, not a
datacentre core):

| Action | Blocked main thread | React commits | Component renders |
| --- | --- | --- | --- |
| Click into another cell | 0.7 s | 16 | 5,300 |
| One cell commits | 1.7 s | 30 | 15,600 |
| Five short edits, Tab after each | 10 s | 267 | 101,000 |
| Return to the tab | 1.4 s | 38 | 18,300 |

Typing itself was fast (47 ms input-to-paint at p95). The pause was never one
slow function. A CPU profile put 11 of 16 busy seconds inside React's render
and commit, and the app's own logic at a small share. Three factors multiply:

1. **Commits per action.** One commit of one cell made React commit 30 times
   and rendered the workspace component 15 times: an optimistic store write,
   one store emit per outbox notification, the applied rows, cleanup emits,
   focus state, and the responses of seven requests, two of them sent twice.
2. **Tree per commit.** `src/components/ProjectWorkspace.tsx` is one component
   that holds the workspace's state, so any change to any of it re-renders
   everything it returns: about twenty closed dialogs, and a tooltip, popover
   and context-menu root for every control on every visible row.
3. **Work in render.** `src/lib/terminology/source-lookup.ts::conceptsForSourceSurface`
   ran from render once per highlighted term per row, and built a regular
   expression for every glossary concept on every call. With 664 terms that
   turned factor 1 × factor 2 into 137 seconds of blocked main thread to open
   a file.

The glossary was the multiplier, not the cause, and the stopgap the ticket
proposed (turn affix matching off) would not have helped: the cost was in
rebuilding, not in what was built.

The harness that existed (AQU-1868) could not see any of this. It budgets how
long a screen takes to open and how fast the server answers, and neither
number moves when a click takes 800 ms.

## Decision

**Every interaction is instant, or it is in the background with a status the
user can see.** "Instant" is measured by `scripts/perf/interaction.ts`, which
counts React commits and component renders per action through the probe in
`scripts/perf/lib/interaction-probe.ts::INTERACTION_INIT_SCRIPT` and enforces
`scripts/perf/interaction-budgets.json`. Counts are the contract because they
do not depend on the machine; timings are reported beside them.

A budget in that file is lowered when a change improves a number, and is not
raised to make a change pass. Raising one is a person's decision.

The patterns below are what the three factors look like in a diff. A reviewer
can apply each one without a profiler.

*Commits per action*

- **One user action is one state transition.** Mutations that belong to one
  event are applied together and announced once. A store that emits per
  mutation, or a handler that sets state on both sides of an `await`, makes
  one commit per step.
- **A write does not read back what it just wrote.** The response to a write,
  or the applied frame, carries the result. A follow-up `GET` of the same
  rows, or the same `GET` from two subscribers, is a defect.
- **Coming back to the tab is one refresh, not one per hook.** Reads that many
  components need are shared and coalesced; a settings read sent eight times
  for one focus event is eight commits.

*Tree per commit*

- **State lives in the smallest component that needs it.** Adding `useState`
  to the workspace component makes every keystroke of that state a render of
  the whole workspace. Put it in the leaf, or in a store read by a selector.
- **Closed is unmounted.** A dialog, popover, menu or tooltip that is not open
  renders nothing and mounts nothing, and one instance per row is replaced by
  one instance per list that is told which row it is for.
- **A row's props are stable.** A list row is memoized, and what it is given
  does not change identity unless its own content changed: no object, array,
  map or closure built in the parent's render.
- **Subscribe to what you render.** A component that reads a store re-renders
  for the slice it shows, not for every emit.

*Work in render*

- **Render does not compile, parse, scan or sort.** Building a regular
  expression, walking every cell, or testing every glossary term is done once
  and cached on the identity of its inputs, as
  `src/lib/terminology/match.ts::conceptToRegexSource` now is — or it is done
  when the user asks (the popover opens), not when the row draws.
- **A cache is keyed on what can change the answer, by content when callers
  build the input in render** (`src/lib/terminology/match.ts::termMatchingKey`).
  A cache keyed on an object that is rebuilt every render never hits.

*Background work*

- **Long work is honest about itself.** Anything that outlives the gesture
  that started it shows progress, shows completion, and fails loudly. A batch
  that stops without saying so is indistinguishable from a slow one.

## Consequences

- A change that adds a commit to an action, or a mounted-while-closed overlay
  to a row, fails `pnpm perf:interaction` rather than waiting for a user to
  feel it. The check needs a built SPA and the local stack, so it runs in the
  nightly routine (`docs/routines/PERF-NIGHTLY.md`), not on every push.
- The benchmark reports component names only on an unminified build, which is
  what it builds. Its timings are therefore not production timings; its counts
  are.
- Memoizing the matcher means a concept or a termbase array must be replaced,
  not edited in place, for a change to be seen. The concept cache re-checks
  the fields it was built from; the lookup cache relies on array identity.
- The React Compiler memoizes values inside a component. It does not stop a
  component from rendering when its own state changed, and it does not move
  state out of a component that is too large. Structure is still the author's
  job.

## Not covered yet

- The workspace component is still one component. This record sets the rule
  for new state; taking the existing state apart is incremental work the
  nightly routine picks from.
- Surfaces other than the editor are not all measured. The coverage table in
  `docs/routines/PERF-NIGHTLY.md` lists which are.
- Server latency. The benchmark runs against a local stack with no network
  delay, so a slow `POST /events` in production is invisible to it; the
  AQU-1868 harness and the slow-request logs cover that side.
- No lint rule enforces the patterns. They are review rules plus a budget.
