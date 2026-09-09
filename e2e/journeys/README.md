# Agent journeys

Plain-English user journeys that an AI agent walks through the running app
with [agent-browser](https://github.com/vercel-labs/agent-browser). The agent
reads each story, drives the browser, judges the end state, and reports.

This is **not** a merge gate. The Playwright smoke suite in `e2e/specs` stays
the deterministic gate. Agent journeys are advisory: they cope with moved
buttons, notice things a selector cannot, and write a readable report. They
are also non-deterministic and cost tokens per run, so a red here is a lead,
not a verdict.

## Why both

| | Playwright smoke | Agent journey |
| --- | --- | --- |
| Who holds the steps | a spec file, fixed in advance | the agent, decided from each snapshot |
| Cost per run | none | model tokens |
| Breaks when | a selector stops matching | the story is ambiguous or the harness misfires |
| Good at | exact assertions, races, ten clients at once | exploring, judging, reporting |
| Role | gate | scout |

## Story format

One file per journey. Keep the section names; the agent looks for them.

- **Smoke twin**: the Playwright spec that covers the same journey, if any.
- **Preconditions**: account, org, data that must exist first.
- **Steps**: what a person would do, naming controls by their visible label.
- **Expected end state**: what must be true at the end.
- **Counts as a failure**: the specific wrong outcomes, so the agent does not
  invent its own bar.
- **Notes for the agent**: harness quirks learned on earlier runs.

## Running a story

Install once:

```bash
npm i -g agent-browser && agent-browser install
```

Boot the local stack (`pnpm dev`, needs the `aquilla-dev-pg` container), then
hand an agent the story and this prompt:

> Walk `e2e/journeys/<story>.md` against http://127.0.0.1:5173 with
> agent-browser. Log in by opening `/__dev/login?as=alice`. Use a named
> session. Re-snapshot after every page change. Report PASS or FAIL against
> "Expected end state", quote the evidence, and attach a screenshot of the end
> state. Do not fix the app.

The calibration rule from the 2026-09-03 call: a story earns trust only after
it has passed five times in a row on a build known to be good. Until then a
red means the story or the harness is wrong, not the app.

## Replays and streaks

The cold run is the agent's job: read the story, find the path. Once a path
is found it is written down as a replay, `replays/<slug>.sh`, a short shell
script of agent-browser commands that exits 0 on PASS with its evidence on
the last line. `streak.sh <slug> [runs]` runs the replay back to back and
appends one line per run to `streaks.tsv`. Five passes in a row on the dev
tip is the bar a story must clear before its red is trusted.

Be clear about what each measures. A cold run measures whether an agent can
find the path from the story alone. A streak measures whether the harness
and the app hold that path steady. Both matter; only the second is cheap
enough to run every night. A replay is deliberately not a Playwright spec:
it has no fixtures, no network interception, and no reset, and it is allowed
to fail for harness reasons. When it does, fix the replay, never the app.

```bash
sh e2e/journeys/streak.sh projects-create 5
```

Run streaks one story at a time against one stack. Two runs at once are
fine; three agents at once took the sync worker down. `wrangler dev` also
exits when a browser closes mid-socket (`Network connection lost.`), and
the dev-stack script then stops everything, so a scheduled run needs a
supervisor that restarts the stack and retries. A `FAIL: login` under five
seconds means the stack was down, not that login broke.

## Harness notes

Learned on the first runs (see `FINDINGS-2026-09-08.md`):

- Prefer snapshot refs (`@eN`). `find role <role> --name` missed sidebar links
  and a dialog checkbox that the snapshot listed plainly.
- `wait --url` with a glob timed out on URLs it should have matched. Use
  `wait --text` or `wait --load networkidle`, then read `get url`.
- `wait --text` is page-wide. A project title in the breadcrumb or the
  "Back to" history button satisfies it while the table row is absent. Scope
  checks with `snapshot -s <selector>` or `get count`.
- After clicking a cell's read view, wait for the editable element to mount
  and type into it by ref. Typing at "current focus" is lost.
- Language pickers on the create dialog accept a typed code (`en`, `fr`).
- `wait --text` reads visible text only. A search box's placeholder such as
  `Search projects…` never satisfies it; wait for the element instead
  (`wait "table"`).
- To act on a control that `find` misses, pull its ref out of the snapshot:
  `ab snapshot -i -c | grep -o 'checkbox "I understand[^]]*ref=e[0-9]*'`,
  then `check @eN`. `replays/projects-archive.sh` shows the pattern.
