# Initial qualification — 2026-09-21

Baseline: Aquilla `dev` at `707287dfd6c7e121ebbfda1b9aaf81878504d8c4`.
Tests ran against the AQU-1336 working tree on a local Mac, with synthetic
users, a generated project, and three invented source paragraphs.

## Demonstrated failure detection

- Run `2026-09-21T18-03-25-916Z`: Jev reached the editor and typed the
  correction. Immediate hard navigation lost it. Server state and a fresh
  browser both rejected the outcome. Unrelated cells stayed unchanged.
- The existing AQU-1334 page-hide callback alone still failed this outcome
  in run `2026-09-21T18-05-48-897Z`. Calling an async commit during teardown
  did not guarantee that its IndexedDB transaction completed.
- The deterministic import-and-edit smoke reproduced the same loss after
  immediate navigation. Both that smoke and the live journey pass after the
  account-scoped event recovery journal closes the teardown gap.
- Model-free oracle qualification rejects an absent write and an intentionally
  incorrect projection, while accepting a real durable edit.

This establishes detection of this lost-edit failure. It does not establish
a general false-pass rate or coverage of every regression.

## Complete suite run

Command: `SMART_TEST_ENV_FILE=.env.smart-tests.local pnpm test:smart`.
Run: `2026-09-21T18-11-26-365Z`. Result: **5 passed in 51.6 seconds**,
excluding local service startup and compilation.

| Condition | Jev walk | Full test | Executed actions | Reported model cost, USD |
| --- | ---: | ---: | ---: | ---: |
| Normal edit | 4.404 s | 9.065 s | 5 | $0.001890270 |
| Immediate departure | 3.958 s | 8.827 s | 5 | $0.001596718 |
| Delayed HTTP | 13.361 s | 18.780 s | 4 | $0.001149114 |

All three pass the correct-cell, durable-target, fresh-session, and
unrelated-cell checks. The normal and delayed walks stop at `DONE`; the
departure walk stops at the harness's deliberate navigation checkpoint.

Decision-call medians range from 167–197 ms. The three walks report
**$0.004636102 total model cost**, including decision calls and text generation.
All 23 model responses include cost data. This excludes earlier debugging
runs and infrastructure costs. Models: `typesafe/jev-1.13-20260917` and
`inception/mercury-2.5`. These measurements are observations, not a budget guarantee.

The DOM audit covers eight initial route surfaces plus editor activation.
It finds no action whose label is merely its role on those snapshots.
That check does not discover every clickable element omitted by the reader,
every offscreen control, or every dialog state.

Earlier runs also include inconclusive navigation and provider/driver
outcomes. They remain in local evidence; this green run is not a claim that
the suite is consistently reliable enough to replace release checks.

## Product and harness boundaries

The product fixes expose project links, a plan-to-editor link, cell activation
buttons, useful cell labels, keyboard file selection, and corpus rename controls.
The harness waits on public loading semantics and checks actual translation
content separately from collaborator cursor labels.

The recovery journal stores the same account-scoped target event envelope
before the async outbox write. Startup replays it into IndexedDB without
overwriting an existing event's quarantine state. Entries disappear after
durable storage; replay uses the original event ID. Browsers that deny both
storage mechanisms cannot provide offline durability. Abrupt process or
device failure before page-hide is outside this demonstrated contract.

The existing spec already requires no data loss on navigation
(`05-user-stories/translate-a-cell.md`, Acceptance criteria) and accessible
controls (`09-design-and-ux.md`, Accessibility in practice). These fixes
restore those contracts. No separate product-spec change is required.

CI wiring uses the existing dispatch-only Hetzner workflow. The repository
has no registered Actions runner at verification time. No hosted or
preview-environment run is claimed.
