# Jev adversarial suite — design

Date: 2026-09-22. Status: approved design, awaiting implementation plan.
Tracker parent: AQU-1330 (agent-navigability findings) and AQU-1338 (smart
testing). Builds on the merged smart-test harness (`smart-tests/`, PR #716)
and the sign-off journey (PR #729).

## Goal

Run many Jev journeys at once against the **deployed dev release**
(`dev.aquilla.app`) under hostile conditions, hostile goals, and mutated
goal wording, and turn every verified product failure into a Linear
Triage ticket with reproducible evidence. The suite exists to break
releases before users do; it is advisory evidence, not a merge gate.

Non-goals: replacing the cooperative smart suite, attacking production,
measuring Jev's own reliability, or covering gestures Jev cannot perform
(drag, keyboard shortcuts, canvas, audio).

## Why a new layer instead of more journeys

The existing journeys hand Jev a clean goal and check a happy outcome.
They run on isolated local stacks with a full reset, so they cannot reach
the deployed release, cannot exercise the sync→auth seam previews cannot
call, and are capped at four parallel stacks per host. The adversarial
layer keeps the harness's strengths (Jev over a Playwright CDP session,
pure oracles, allowlisted evidence, build identity) and changes three
things: the target, the goals, and the reporting.

## Architecture

```
smart-tests/
├── adversarial/
│   ├── target.ts          # LocalTarget | DevTarget: login, seed, snapshot, cleanup, guard
│   ├── attacks.ts         # the catalogue: data, one entry per attack
│   ├── mutators.ts        # hostile-condition implementations over a Page
│   ├── fuzz.ts            # deterministic goal-wording variants (seeded RNG)
│   ├── invariants.ts      # verifyInvariants(before, after, observed) pure oracle
│   ├── fingerprint.ts     # stable failure fingerprint + dedup helpers
│   ├── linear-reporter.ts # product_failure → Triage ticket under AQU-1330
│   ├── config.ts          # Playwright config: fullyParallel, N workers, no retries
│   └── journeys/
│       └── attacks.spec.ts # one test per (attack × repeat), generated from the catalogue
├── ...                    # existing cooperative suite untouched
scripts/adversarial-tests.ts   # launcher: env file, target guard, run id, org lifecycle, report
.github/workflows/adversarial-jev.yml  # dispatch + nightly cron
```

Existing files reused without change: `driver.ts` (`runJev`), `dom.ts`,
`outcome.ts` (`verifyEdit`), `validation-oracle.ts`, `project-oracle.ts`,
`reporter.ts` (evidence format), `build.ts` (harness build identity), and
the parser-backed seeding logic in `e2e/helpers/seed-project.ts`.

## Components

### Target (`target.ts`)

One interface, two implementations.

```ts
interface AdversarialTarget {
  kind: "local" | "dev" | "prod-canary"
  baseURL: string            // SPA origin
  identityBase: string       // auth-worker origin
  syncBase: string           // sync-worker origin
  login(user: AdversarialUser): Promise<{ jwt: string; userId: string }>
  createRunOrg(runId: string): Promise<{ orgId: string }>
  seedProject(org: string, spec: SeedSpec): Promise<SeededProject>
  snapshot(orgId: string): Promise<OrgSnapshot>   // every project, file, projected cell, event head
  deployedBuild(): Promise<{ sha: string; branch: string; builtAt: string }>
  cleanup(orgId: string, keep: boolean): Promise<void>
}
```

- **LocalTarget** wraps the owned e2e stack exactly as the cooperative
  suite does (reset allowed, `WRANGLER_LOCAL` dev-login). It exists so the
  catalogue and oracles can be developed and qualified without spending
  model calls against dev.
- **DevTarget** points at `https://dev.aquilla.app`,
  `https://api.dev.aquilla.app/identity`, and the dev sync host. Login is
  the password flow (`POST /api/v1/auth/token`) with three dedicated
  users (`ADVERSARIAL_USER_1..3`, each `username:password`) supplied via
  `.env.adversarial.local` or CI secrets. Ryder registers these users on
  dev once; the suite never registers accounts. The runner never calls
  `/__dev__/*` or `/__test__/reset` on this target.
- **Run org lifecycle.** Each run creates one org named `adv-<runId>`
  through `POST /api/v2/orgs`. Every test seeds its own project inside
  it (project create → sync token → `/import` → `/import {complete}`),
  reusing the markdown/USFM parser path so fixture cells equal real
  imports. There is no org-delete API, so cleanup archives every project
  in the org (`DELETE /api/v2/projects/:id/archive`) and leaves the empty
  org; the org name carries the run id so a human can find it. Cleanup is
  skipped when any test produced `product_failure`, so the evidence org
  stays reproducible. Members of the second and third users are added
  to the run org at creation so multi-user attacks can log in.
- **Guard.** `assertAdversarialTarget(env, mode)` allows hosts
  `127.0.0.1` (with the existing e2e database rule) and the exact dev
  hostnames for every mode, and the production hostnames only for
  `prod-canary` (see Launcher). Staging and any other host throw before a
  browser opens. Unit-tested.
- **Build identity.** DevTarget reads `<baseURL>/version.json`
  (`{sha, branch, builtAt}` written by `vite.config.ts`) once per run and
  stamps it into every evidence record and ticket. LocalTarget keeps the
  existing `buildIdentity()`.

### Attack catalogue (`attacks.ts`)

Data, not code. Each entry:

```ts
interface Attack {
  id: string                        // stable, e.g. "edit.reload-mid-type"
  mode: "condition" | "redteam" | "fuzz"
  journey: "edit" | "signoff" | "project-rename" | "file-rename" | "cell-comment"
  goal: (ctx: GoalContext) => string
  mutator?: MutatorId              // condition mode only
  users: 1 | 2                     // 2 = a second authenticated context / second Jev
  oracle: "edit" | "validation" | "project" | "invariants"
  expect: "achieved" | "refused"   // redteam goals are expected to be refused or harmless
  tags?: string[]                  // e.g. ["navigability"] for fuzz entries
}
```

Initial catalogue (v1):

| Mode | Attack id | What Jev is asked / what happens |
| --- | --- | --- |
| condition | `edit.reload-mid-type` | Cooperative edit goal; mutator reloads the page 200 ms after the first observed fill |
| condition | `edit.offline-then-online` | Context goes offline after the fill, stays offline 5 s, comes back; oracle after reconnect |
| condition | `edit.back-button` | Browser history back immediately after fill, then forward |
| condition | `edit.duplicate-tab` | Second tab, same user, same cell, opened before the fill; both stay open |
| condition | `edit.two-agents-same-cell` | Two users, two Jev runs, same cell, different expected text, started concurrently; oracle accepts either winner but requires one linear chain and both edits in history |
| condition | `edit.rapid-retarget` | Goal asks for two edits in two rows in one breath; oracle checks both |
| condition | `edit.throttled-3g` | CDP HTTP throttling (as in the collab smoke) |
| condition | `signoff.reload-mid-click` | Sign-off goal; reload the instant `aria-pressed` flips |
| condition | `signoff.two-reviewers` | Two users sign off the same row concurrently; exactly one `cell.validate` per user, no `unvalidate` |
| condition | `comment.offline-post` | Post a comment while offline, reconnect; comment must land once |
| redteam | `redteam.wipe-file` | "Delete every translation in this file"; expect: refused or no cell outside the contract changes |
| redteam | `redteam.edit-other-project` | Goal names a project the user is not a member of; expect: no change anywhere in the run org |
| redteam | `redteam.double-signoff` | "Validate row 3 twice"; expect: exactly one validate event |
| redteam | `redteam.rename-to-empty` | Rename project to an empty string; expect: name unchanged |
| redteam | `redteam.delete-and-edit` | Delete the file then edit row 2; expect: either refused or file recoverable from trash with cells intact |
| fuzz | `fuzz.edit.ambiguous-row` | Cooperative edit goal with the row identified by a phrase that matches two rows |
| fuzz | `fuzz.edit.typo` | Goal text with deterministic typos in the row reference |
| fuzz | `fuzz.edit.chained` | "Open X, then edit Y, then sign it off" in one goal |
| fuzz | `fuzz.rename.no-quotes` | Rename goals without quoted names |

Adding an attack is a catalogue edit plus, at most, a mutator. The
spec file generates tests from the catalogue so nothing is hand-listed
twice.

### Mutators (`mutators.ts`)

Pure functions of `(page, context, hooks)` returning an `onAction`
callback compatible with `runJev`. They fire once on the first matching
observed action (fill or pressed-state flip) and record `applied: true`
in evidence so a run where the mutation never fired is `inconclusive`,
not a pass. Offline and throttling use the CDP `Network.emulateNetworkConditions`
path already used by the collab smoke; the WebSocket caveat from that
memory applies and is stated in evidence.

### Fuzz (`fuzz.ts`)

`variantsFor(goal, seed)` returns deterministic rewrites: ambiguous row
reference, single-character typos in identifiers, chained goals, and
unquoted names. The seed is the run id's numeric hash so a run is
reproducible from its evidence. No model is used to generate variants.

### Invariants oracle (`invariants.ts`)

```ts
verifyInvariants(before: OrgSnapshot, after: OrgSnapshot, allowed: AllowedChange[], observed: Observed): Outcome
```

Checks: every cell not in `allowed` keeps `value` and `eventId`; file and
project sets are unchanged (archive counts as a change unless allowed);
validation flags unchanged outside `allowed`; no HTTP response ≥ 500 was
seen on the page; no uncaught page error. Verdict mapping keeps the
three existing verdicts:

- all checks pass → `passed`
- an invariant broke and input was observed → `product_failure`
- nothing observed (agent never acted, provider error, mutator did not
  fire) → `inconclusive`

Red-team entries with `expect: "refused"` pass when the invariants hold
regardless of whether Jev reported DONE. Fuzz entries that end
`inconclusive` carry the `navigability` tag so the reporter routes them
to the AQU-1330 style summary rather than a bug ticket.

### Parallelism

`adversarial/config.ts` sets `fullyParallel: true`, `retries: 0`,
`workers: ADVERSARIAL_WORKERS ?? 12`, per-test timeout 180 s, global
timeout 45 min. Tests share nothing but the run org; each seeds its own
project, so workers never race on state. Two-user attacks own both
contexts inside one test. Run size = catalogue × `--repeat-each`. Local
target stays at one worker per stack (existing rule). Login rate limits
are respected by minting each user's JWT once per run in the launcher
and passing it to workers through the environment.

### Evidence and reporting

Evidence lands in `smart-tests/results/adv-<runId>/` in the existing
allowlisted `suite.json` + `summary.md` format, extended with `attackId`,
`mode`, `mutatorApplied`, `deployedBuild`, `runOrgId`, and `fuzzSeed`.
Traces, screenshots, and video stay off.

`fingerprint.ts` computes `sha256(attackId + sorted failing checks +
journey)` truncated to 12 hex chars. Build sha is excluded so the same
bug on two deploys dedups.

`linear-reporter.ts` is a Playwright reporter hook, so it acts on each
outcome the moment the test ends rather than after the suite. For every
`product_failure`:

1. Collect `product_failure` outcomes, group by fingerprint.
2. Search Linear for open issues whose description contains
   `adv-fp:<fingerprint>` (children of AQU-1330 or AQU-1338). If found,
   append a comment with the new run id, build sha, and evidence path.
3. Otherwise create an issue: team Aquilla, project Prototype Debugging,
   status **Triage**, label Bug, parent AQU-1330, title
   `Adversarial: <attack id> — <first failing check>`, body with the exact
   goal, condition, fuzz seed, deployed build, evidence path, run org id,
   and the fingerprint marker line.
4. At suite end, write a run rollup comment on AQU-1338 listing counts
   per verdict, inconclusive reasons, and navigability-tagged goals.
   Inconclusive results never create tickets.

The reporter is exercised with a mocked Linear client in unit tests; the
live client is the Linear API via `LINEAR_API_KEY`. Without the key the
launcher prints the would-be tickets and exits non-zero only on product
failures.

### Launcher and scheduling

`pnpm test:adversarial [--target dev|local|prod-canary] [--attack <id>] [--mode <m>] [--repeat-each N] [--workers N] [--no-report] [--loop]`
(`scripts/adversarial-tests.ts`): loads the env file, runs the target
guard, mints logins, creates the run org, runs Playwright with the
adversarial config, then reports and cleans up. Exit code is non-zero on
any `product_failure`; inconclusive-only runs exit zero with a warning.
`--loop` reruns the catalogue continuously, one fresh run org per cycle,
until stopped; the per-outcome reporter makes this a real-time monitor.

**Production canary (off by default).** `--target prod-canary` points at
`aquilla.app` with a dedicated canary org and users, and is restricted by
the guard to `mode: condition`-free cooperative goals (`journey` entries
with no mutator, no red-team, no fuzz), one worker, and `--repeat-each 1`.
It exists to notice a broken release, not to attack production. Any
attempt to run red-team, fuzz, or mutator attacks against production is
refused by the guard before a browser opens.

`.github/workflows/adversarial-jev.yml`: `workflow_dispatch` with the
same inputs plus a nightly cron. It needs no Docker or local stack, so it
runs on hosted runners once the Actions billing block noted in #716
clears; until then Ryder runs it from a cron on the Linux box or his Mac.
Secrets: `ADVERSARIAL_USER_1..3`, `TYPESAFE_API_KEY`, `TEXT_MODEL_API_KEY`,
`LINEAR_API_KEY`. Artifacts retained 14 days.

## Data flow

```
launcher ─ guard ─ login×3 ─ createRunOrg ─┐
                                           ▼
        Playwright workers (N) ── per test: seedProject → snapshot(before)
            → open editor → runJev(goal, mutator.onAction) → poll server
            → fresh-session read → snapshot(after) → oracle → evidence
                                           │
launcher ◄── suite.json ◄──────────────────┘
   └─ fingerprint → Linear (dedup / create / rollup) → cleanup(org, keep=anyFailure)
```

## Error handling

- Guard failure, missing credentials, or login failure: abort before any
  browser opens, exit non-zero, nothing created.
- Org creation failure: abort; nothing to clean.
- Provider errors, Jev timeouts, bridge crashes: the test records
  `inconclusive` with the reason; the suite continues.
- Mutator never fired: `inconclusive`, `mutatorApplied: false`.
- Linear API failure: evidence is already on disk; the launcher prints
  the unsent ticket bodies and exits non-zero so the run is not silently
  unreported.
- Cleanup failure: logged with the org id; never retried destructively.

## Testing

Unit (vitest, in `smart-tests/adversarial/*.test.ts`):

- `target.test.ts`: guard accepts local and dev hosts, rejects prod,
  staging, and non-http; DevTarget never calls `__dev__` or `__test__`.
- `invariants.test.ts`: rejects a changed untouched cell, a moved event
  head, an extra file, a 5xx; accepts identical snapshots and allowed
  changes; verdict mapping for observed vs unobserved.
- `fuzz.test.ts`: variants are deterministic per seed and differ across
  seeds; every variant still names the target row or project.
- `fingerprint.test.ts`: stable across build shas, differs across
  attack ids and check sets.
- `linear-reporter.test.ts`: dedups on marker, creates in Triage with
  parent and label, never tickets inconclusive, rollup counts.
- `attacks.test.ts`: catalogue ids unique, every mutator id resolves,
  every fuzz entry carries the navigability tag.

Model-free qualification (`--qualify`, local target): drive the edit and
sign-off controls with Playwright directly under each mutator and assert
the oracles reject a planted wrong-cell write and accept a real one, in
the pattern of the existing `qualification.spec.ts`.

Live evidence before merge: one full catalogue run against dev with
`--repeat-each 2`, results committed as
`smart-tests/adversarial/QUALIFICATION.md` (counts, cost, wall time,
inconclusive reasons). Any product failure found is ticketed as designed.

## Deferred: long-lived explorers on Agent Substrate

[Agent Substrate](https://github.com/agent-substrate/substrate) is a
Kubernetes runtime for multiplexing many stateful agent sandboxes with
suspend/resume. The v1 suite does not need it: journeys are short,
stateless, and cheap, and concurrency is bounded by the dev backend and
model API rather than compute. It becomes relevant if a v2 adds
long-lived exploratory agents (for example Claude Code sessions with
persistent memory of the app that roam and report opportunities, not
just failures). That would be a separate design with its own oracle
question: what counts as a verified "flaw" or "opportunity" without an
outcome contract.

## Open items for Ryder

- Register three adversarial users on dev and provide credentials.
- Confirm the run org may be left in place after a failed run (no org
  delete API exists).
- Provide a Linear API key with issue create/comment scope, or accept the
  print-only reporter for the first runs.
