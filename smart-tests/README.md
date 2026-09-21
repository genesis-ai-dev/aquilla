# Smart testing

Aquilla owns user outcomes, reset fixtures, independent verification, and
release evidence. Jev chooses how to reach those outcomes through the browser.
The pinned dependency stays in `jev-ultrafast`; product journeys live here.

The first journey opens a project and file, changes one translation, and
preserves the other cells. It runs under normal conditions, immediate hard
navigation after input, and delayed HTTP. Each condition starts from a reset
database and a new browser context. This is the first complete outcome
contract, not coverage of every Aquilla workflow.

## Run locally

Use the prerequisites from [E2E setup](../e2e/README.md): Node, pnpm, Docker
with `aquilla-dev-pg`, and Playwright Chromium. Install the root, auth-worker,
and sync-worker dependencies. Install [uv](https://docs.astral.sh/uv/), then:

```sh
pnpm test:smart:setup
pnpm test:smart:unit
pnpm test:smart:types
pnpm test:smart:qualify
pnpm test:smart:audit
```

Qualification and DOM audit use real browsers and local workers, but no live
model. Qualification rejects a missing write and a deliberately wrong target
projection, then accepts a real UI edit verified through the server and a fresh
browser. A second qualification rejects an unsigned file and a sign-off moved
to a neighbouring cell, then accepts a real click on the editor's validation
control. Both test the verifier; they do not measure Jev's reliability.

For live journeys, put credentials in an ignored `.env.smart-tests.local`:

```dotenv
TYPESAFE_API_KEY=<decision-provider-key>
TYPESAFE_URL=https://openrouter.ai/api/alpha/decisions
TYPESAFE_MODEL=typesafe/jev-1.13
TEXT_MODEL_API_KEY=<text-provider-key>
TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1
TEXT_MODEL_REASONING=none
TEXT_MODEL=inception/mercury-2.5
```

```sh
SMART_TEST_ENV_FILE=.env.smart-tests.local pnpm test:smart
# Select a condition or collect repeated, independently reported runs:
SMART_TEST_ENV_FILE=.env.smart-tests.local pnpm test:smart -- \
  --grep immediate-departure
SMART_TEST_ENV_FILE=.env.smart-tests.local pnpm test:smart -- \
  --repeat-each=5
```

The default command runs twelve checks: eight live journeys, two DOM
audits, and two oracle qualifications. The additional journeys rename a project,
rename a file, post one comment on the intended cell, and sign off on one
finished translation. Each checks server state, a fresh browser, unchanged
identities, and unchanged translation content.

The sign-off journey starts from a file whose rows are all translated and
none validated, seeded through the same `POST /events` boundary the SPA
writes to. It asks for the LAST row only, so reaching the first control is
not enough. Besides the projection, it reads the append-only event log: a
clean pass is exactly one `cell.validate`, by the reviewer, with no
`cell.unvalidate` undoing it. A run that signs off and withdraws again
never demonstrated the outcome, even though the projection ends up matching
an unsigned file. Its adverse condition tears the document down the instant
the control flips, before the outbox can flush.
The comment goal names the row's More actions menu; it does not establish
unguided discovery of that workflow. See [the initial evidence](./QUALIFICATION.md).

### Parallel runs

```sh
SMART_TEST_SHARDS=4 SMART_TEST_ENV_FILE=.env.smart-tests.local pnpm test:smart
# Same exact-commit PR reporting, with merged evidence:
SMART_TEST_SHARDS=4 SMART_TEST_ENV_FILE=.env.smart-tests.local \
  pnpm test:smart:pr -- <PR-number>
```

Choose one to four stacks; the default stays one until machine capacity is
known. Parallel runs reserve E2E slots 9–12, beyond the smoke runner's maximum
eight slots. Each owns its database, ports, Wrangler state, frontend build,
browser, auth-state namespace, and evidence directory. Each stack still runs
one test at a time. Increasing Playwright workers within a shared database
would race destructive fixture resets, so the parallel launcher rejects that
override. Do not overlap two parallel smart-suite processes on one machine.

The launcher collects the full selected test manifest before starting shards.
Missing, duplicate, interrupted, or wrong-build shard evidence fails the merged
suite; a successful subset never becomes a whole-suite pass. Per-shard results
remain available beside the merged directory. Existing run IDs cannot be reused.

An initial four-stack local run completes all eight checks in 51.3 seconds
including setup; its slowest test shard takes 29.6 seconds. The earlier serial
test phase took roughly 70 seconds excluding setup. These are individual runs,
not a stability study or a Hetzner capacity measurement. More parallelism can
increase CPU, Postgres, browser, and provider contention. Measure both setup
and test time on the target host before raising the cap or changing defaults.

The launcher reserves E2E stack four: database `aquilla_e2e_s3`, app port
6473, identity port 10087, sync port 10088. It runs one journey at a time.
Do not start two smart-suite processes on the same machine. The existing
three smoke stacks have separate databases and ports. Reset rejects nonlocal
services and database names outside the E2E namespace.

The runner currently targets its owned local stack. It does not reset shared
dev, production, or PR-preview data. Preview execution needs a scoped fixture
service before this reset contract can extend there.

## Independent outcomes

An agent's `DONE` is never a pass. The runner checks:

- The intended cell actually receives the exact requested input.
- The sync-worker projection stores that value on the correct target cell.
- A new browser context reads the same value, without the writer's cache.
- Every other source and target keeps its value and event head.
- The browser raises no uncaught application error.

The immediate-departure condition navigates away directly after Jev types,
before the idle-save window. It then reopens the writer so its durable outbox
can recover, and verifies from a separate browser context. It cannot recover
the discarded editor's in-memory state. The delayed-network condition delays
HTTP and connection establishment; it does not simulate delayed WebSocket
frames or concurrent editing.

Results are `passed`, `product_failure`, or `inconclusive`. A missing durable
outcome after observed input is a product failure. An agent that cannot reach
the input, a provider error, or an interrupted verifier is inconclusive.
Neither is a release pass. Playwright retries are disabled; repetitions retain
each result rather than hiding failures behind a final green attempt.

## Browser and evidence boundary

Playwright owns an isolated Chromium context and its CDP session. A small
Python bridge runs the pinned Jev policy, DOM reader, freshness checks, and
executor against that session. No personal browser profile or Browser Harness
daemon is involved. Only synthetic local fixture content reaches the model.

The bridge waits for visible `aria-busy` regions to finish, with a bounded
timeout. It supplies no route-specific next action. User goals remain free
of test selectors. Selectors appear only in setup and independent checks.

Jev currently supports its observed click, fill, select, scroll, and wait
actions. This suite does not establish coverage for drag gestures, keyboard
shortcuts, canvas controls, audio quality, or every dialog. Native controls,
meaningful names, accurate read-only states, and visible navigation help both
agents and assistive technology.

Every completed test writes allowlisted evidence to
`smart-tests/results/<run-id>/suite.json` and `summary.md`, including successes.
Evidence includes goals, actions, observations, outcome checks, provider usage,
build identity, and condition. It excludes credentials, raw CDP traffic,
network headers, and signed query strings. Browser traces and screenshots are
disabled for this suite. The DOM audit records eight initial route surfaces
and the target activation transition; it is an inventory, not proof of every
control's behavior.

## CI and release confidence

For a reviewed local checkout matching an open PR's exact head, run:

```sh
SMART_TEST_ENV_FILE=.env.smart-tests.local pnpm test:smart:pr -- <PR-number>
```

The command posts one starting comment, runs all twelve checks, and updates
that comment with the results. Commit and push changes first. It refuses a
dirty checkout or a mismatched PR head. Authenticate `gh` before running it.
Evidence stays under `smart-tests/results/pr-<number>-<timestamp>/` locally.
The comment reports model cost, each outcome, and missing checks. It never
accepts a provider's DONE verdict as verification. A newer PR commit makes
an older run's comment update a no-op. Interrupted runs may retain a starting
comment; that is never a completed pass.

The existing automatic Cloudflare preview comment now points reviewers to
these reports and explicitly says that preview deployment does not run Jev.
Absence of a completed report matching the commit means NOT VERIFIED.

The Hetzner host runs a pinned, separately reviewed harness. Adding a
journey to this repository does not deploy it there: that host must be
updated to a harness commit containing `smart-tests/validation-oracle.ts`,
the sign-off journey, and the new qualification before its reports can
cover them. Until it is, a report from that host lists the smaller planned
suite, and the missing checks are NOT VERIFIED rather than passed. Server
credentials and infrastructure are unchanged by this repository change.

The standalone [Hetzner webhook runner](../docs/runbooks/smart-testing-webhook.md)
executes same-repository PRs without GitHub Actions compute. A signed webhook
feeds a durable queue. Fresh containers reuse exact dependency inputs and build PR code,
then runs a separately pinned, reviewed harness against it. GitHub credentials
stay in the controller; model credentials enter only the trusted harness.
PR code cannot replace the deployed outcome checks. Reports identify both
commits and link seven-day evidence. One suite runs at a time on the shared
4 GB host; laptop execution still supports four isolated stacks.

Do not attach `test:smart:pr` directly to an untrusted webhook. The local command
assumes a reviewed checkout and does not provide this container boundary.
GitHub-hosted Actions were billing-blocked during installation; this service
does not depend on hosted jobs or a GitHub Actions runner registration.

The existing **E2E (Hetzner)** dispatch accepts `smart`, `smart-qualify`, and
`smart-audit`. Live mode uses repository secrets `TYPESAFE_API_KEY` and
`TEXT_MODEL_API_KEY`, plus optional provider/model variables. Artifacts retain
all outcomes for 14 days. The workflow remains dispatch-only under the
existing runner policy. No registered runner was available during setup;
local verification does not establish that CI execution works.

We evaluate this suite by the failures it catches and the confidence it adds
per unit of time and cost. Before changing release gates, add outcome
contracts for the workflows at risk, demonstrate failures against broken
builds, and measure false passes, false failures, inconclusive runs, and
runtime. A fixed number of green runs alone cannot establish that coverage.
Existing checks can retire when replacement evidence supports that decision.

To add a journey, define a synthetic starting state, a user goal, an
independent outcome verifier, and a realistic adverse condition. Keep the
Jev dependency pinned and qualify changes to the bridge or verifier. Update
the [journey map](../e2e/JOURNEYS.md) with the actual covered outcome.
