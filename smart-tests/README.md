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
browser. It tests the verifier; it does not measure Jev's reliability.

For live journeys, put credentials in an ignored `.env.smart-tests.local`:

```dotenv
TYPESAFE_API_KEY=<decision-provider-key>
TYPESAFE_URL=https://openrouter.ai/api/alpha/decisions
TYPESAFE_MODEL=typesafe/jev-1.13
TEXT_MODEL_API_KEY=<text-provider-key>
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

The default command runs eight checks: six live journeys, the DOM audit,
and oracle qualification. The additional journeys rename a project, rename a
file, and post one comment on the intended cell. Each checks server state,
a fresh browser, unchanged identities, and unchanged translation content.
The comment goal names the row's More actions menu; it does not establish
unguided discovery of that workflow. See [the initial evidence](./QUALIFICATION.md).

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

The command posts one starting comment, runs all eight checks, and updates
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

**Automatic live PR execution is not activated.** On 2026-09-21, GitHub
reports zero registered runners and blocks hosted jobs because of account
billing. Provider secrets are also absent from GitHub Actions. Restoring
billing or supplying a Linux host addresses compute, but execution still
needs a boundary between PR code and model/reporting credentials. Do not
attach the local PR command to an untrusted webhook or put provider keys
into a persistent runner executing arbitrary PR heads. Use disposable test
environments and a trusted model/report controller, or require review before
a credential-bearing run. The reporting script needs no model of its own.

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
