# Big Bible performance harness (AQU-1868)

A repeatable, budgeted measurement of the app at **production Bible scale**: one project
with 66 source files, ~31k cells, two target lanes, translated content and real event
history — then p95 numbers for the reads and writes that scale with it, main-thread long
tasks on the editor and project rules screens, and a 50-socket presence load.

It exists because the scaling tickets (progress counters AQU-1826, paged reads AQU-1841,
presence tiers AQU-1825/1831, reconnect jitter AQU-1838, …) all need a before-and-after on
a realistic project, and there was no shared fixture and no agreed budget to point at.

## Run it

```bash
pnpm dev                 # the local stack this measures (auth :8788, sync :8789, SPA :5173)
pnpm perf:seed           # ~31k cells over 66 files → writes .perf/big-bible.json
pnpm perf:measure        # every section, budgets enforced → perf-report/latest.json
pnpm perf:presence       # just the 50-socket presence load
```

A before/after pair is: seed once, `pnpm perf:measure` on `dev`, apply the change,
`pnpm perf:measure` again, diff the two `perf-report/*.json`.

Iterating on the seeder itself does not need the full fixture:

```bash
pnpm perf:seed --books 2 --cells 500 --handle .perf/smoke.json
pnpm perf:measure --handle .perf/smoke.json --only cells.read.page --allow-unmeasured
```

## What is measured

| Section | What it does | Why |
| --- | --- | --- |
| `project.open` | files + progress + first cells page, in order | the SPA's open fan-out |
| `files.read` | `GET /api/v1/projects/:id/files` | grows with the file count |
| `progress.read` | `GET …/files/:id/progress` | the counters the dashboards poll |
| `cells.read.page` | one `limit=500` page | the per-page cost |
| `cells.read.full` | every page of the largest file (PSA, 3,901 cells) | the editor's initial stream |
| `events.commit` | single-cell `target.cell.commit`, N concurrent writers | the write path under contention |
| `browser` | editor + `/project/:id/rules`, long tasks (>50ms) | jank, which latency alone hides |
| `presence` | 50 WebSockets on the project DO | fan-out frame rate + ping RTT |

Each HTTP section reports the full distribution (p50/p95/p99/max); `events.commit` also
reports sustained throughput, because that is the number that moves when a write path stops
serializing.

Commits are measured one per **distinct** cell, each chained on that cell's recorded head —
two concurrent commits on one chain would measure the stale-sibling path instead of a commit.

## Budgets

`scripts/perf/budgets.json` — `max` for latency and long-task metrics, `min` for throughput
and socket capacity. A breach fails the run (exit 1). So does a budgeted metric the run never
measured, unless `--allow-unmeasured`; a partial run that silently stops checking half the
budgets is worse than no harness.

The committed numbers are **opening ceilings set from the 2026-10-10 scaling audit's intent,
not from a measured baseline**. Re-baseline them on a real stack:

```bash
pnpm perf:measure --suggest-budgets    # prints a budgets.json from this run, +30% headroom
```

Keep them as stall ceilings, not stopwatch targets — generous enough that a slower supported
machine passes, tight enough that a path going file-proportional fails (AGENTS.md rule 15).
Say in the commit message which machine and fixture size produced them.

Temporarily lowering one budget is the harness's own smoke test: the run must fail.

```bash
pnpm perf:measure --budgets /tmp/tight-budgets.json
```

## Reports

`perf-report/big-bible-<timestamp>.json` plus `perf-report/latest.json` (both gitignored —
publish the directory as a CI artifact). Each report carries the git sha, the target hosts,
the fixture's shape, every operation's distribution, the flat `metrics` map budgets were
checked against, what was skipped and why, and the verdict.

## Layout

```
scripts/perf/
├── budgets.json           the contract
├── seed-big-bible.ts      CLI: seed the fixture
├── measure.ts             CLI: measure + enforce budgets
├── presence-load.ts       CLI: presence load on its own
└── lib/
    ├── big-bible-plan.ts  the fixture as pure data (deterministic)
    ├── client.ts          the HTTP/WS surface the harness drives
    ├── fixture-handle.ts  .perf/big-bible.json read/write
    ├── stats.ts           percentiles, concurrency runner
    ├── budgets.ts         budget parsing + evaluation
    ├── report.ts          report assembly + rendering
    ├── browser-probe.ts   Playwright long-task probe
    └── presence.ts        the WebSocket load itself
```

The pure modules (`big-bible-plan`, `stats`, `budgets`, `report`) have unit tests in the root
Vitest suite, so the arithmetic a budget verdict rests on is checked without a stack.

## Deliberate limits

- **Local dev stack is the supported target.** `--auth-base` / `--sync-base` / `--app-base`
  point it elsewhere, but the budgets are calibrated for the local stack, and the dev-stack
  `/__dev__/login` bypass the harness signs in with only exists there. Hosts resolve in one
  order for every command: the flag, else `PERF_AUTH_BASE` / `PERF_SYNC_BASE`, else the
  target the handle was seeded against, else the local stack — so a fixture seeded elsewhere
  is measured there without passing the flags again.
- **Readiness selectors for the browser screens are defaults, not truths**
  (`[data-cell-id]` for the editor, `main` for rules). When the UI moves, the probe fails
  with the page it got stuck on and you pass `--editor-ready` / `--rules-ready`. It never
  silently reports a zero.
- **Audio seeding is opt-in and synthetic.** `pnpm perf:seed --audio N` attaches takes whose
  `frontier-audio://` URLs point at no real R2 object: enough to make the audio progress
  columns non-empty, not enough to play. Default 0. Real audio rows need R2 artifacts, which
  belongs with the audio export/import suites rather than here.
- **One writer identity.** Every commit is authored by the dev user, so this measures server
  contention on one project, not per-user authorization cost.

---

# Interaction benchmark (AQU-2654)

The harness above answers "how long does the screen take to open, and how fast does the
server answer". It cannot see a click that takes 800 ms, because that cost is not latency: it is
**how many times React commits for one action × how much of the tree each commit renders × the
work done inside render**. `pnpm perf:interaction` measures exactly those three, per action, in
the real editor. The reasoning and the patterns it guards are in
`docs/decisions/0013-interaction-cost-is-commits-times-tree.md`.

## Run it

```bash
bash scripts/perf/stack-up.sh          # or `pnpm dev`; native Postgres, no Docker needed
pnpm perf:interaction                  # build → serve → seed if needed → measure → enforce budgets
pnpm perf:interaction --no-build       # reuse .perf/interaction-dist from the last run
pnpm perf:interaction --only plain     # one fixture; budgets for the other are not required
pnpm perf:interaction --suggest-budgets
```

It builds the SPA in production mode, **unminified** (so the report can name components), serves
it with `vite preview` on :4175, signs in through the dev stack's login bypass, and drives one
file of a small seeded project at `--throttle 4` (Chrome CPU slowdown — a datacentre core is
several times faster than a translator's laptop). Two fixtures, seeded once into `.perf/`:

- `plain` — 2 files, 400 cells, no glossary;
- `glossary` — the same, plus 664 active terms with forms, affixes and mark folding.

The project is small on purpose. None of the cost this measures comes from the amount of data.

## What is measured

| Phase | The user… | Headline metrics |
| --- | --- | --- |
| `open` | opens a file | `readyMs`, `longTaskTotalMs`, `reactCommits`, `requests` |
| `activate` | clicks into another cell | `ms` to an editable caret, `reactCommits`, `componentRenders` |
| `typing` | types 40 characters | `inputToPaintP95Ms`, `componentRendersPerKey` |
| `commit` | stops typing; the cell commits | `reactCommits`, `workspaceRenders`, `rowRenders`, `requests` |
| `editTab` | makes five short edits, Tab after each | `tabMedianMs`, `reactCommitsPerEdit`, `requestsPerEdit` |
| `tabReturn` | leaves the tab for 30 s and comes back | `blankFrames`, `longTaskTotalMs`, `requests` |

Every metric is `<fixture>.<phase>.<name>`. The report (`perf-report/interaction-latest.json`)
also carries, per phase, `topRenders` (the 25 components that rendered most) and
`repeatedRoutes` (requests sent more than once for that one action).

## Budgets

`scripts/perf/interaction-budgets.json`, `max` only. Two kinds of number:

- **Counts** (`reactCommits`, `componentRenders`, `workspaceRenders`, `requests`, …) do not
  depend on the machine. They are the contract, with 25% headroom over the last measurement.
- **Timings** (`…Ms`) depend on the machine. They carry 100% headroom and exist to catch a
  path going several times slower, not to be a stopwatch (AGENTS.md rule 15).

**A budget is lowered when a change improves the number, and never raised to make a change
pass.** Raising one is a person's decision, made in a PR that says why.

## Finding the cause

The report says *what* rendered. To see *why*, in order of cost:

1. **Read `topRenders` for the phase.** A component that is closed, off-screen, or unrelated to
   the action should not be in the list at all. `workspaceRenders` above 1–2 for a single action
   means several separate state updates; list them (store emits, `setState` after an `await`,
   one per network response).
2. **Read `repeatedRoutes`.** The same route twice for one action is two subscribers doing the
   same read, or a write followed by a read of what it wrote.
3. **Profile.** With the preview still up (`--no-build` leaves the dist in place; serve it with
   `pnpm exec vite preview --outDir .perf/interaction-dist --port 4175`), open Chrome DevTools →
   Performance, CPU 4× slowdown, record the one action. Because the build is unminified the
   flame chart has real names. In the Bottom-Up tab, group by function: time under
   `renderWithHooks` is factor 2 (tree per commit), a hot non-React function called from a
   component body is factor 3 (work in render).

Name the mechanism in one sentence before changing code.
