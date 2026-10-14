# Automatic Jev PR testing on the shared Hetzner host

The service runs independently of GitHub Actions. Its webhook endpoint is
`https://aquilla-qa.5-161-201-46.sslip.io/aquilla-qa/github`. It accepts signed
`push` events for `genesis-ai-dev/aquilla` only. A run starts when the ref is
`refs/heads/release/YYYY/MM/DD-NN` and `after` is that commit. Pull requests,
other branches, tags, deletions, and a repeat push of the same commit do not
run. GitHub's ping is acknowledged.

That push is how a release-branch HEAD starts the one Hetzner run. The deploy
bot's cut is a push, so an ordinary slice starts Jev at the cut. A held slice
is cut alone; a person checks it and ready pull requests are added onto the
branch. That later push is a new HEAD and starts another run. The runner asks
GitHub whether the branch still points at the job's commit. A moved branch
supersedes the old job. Only a result for the current HEAD counts. The report
is a commit comment on that commit, marker `<!-- aquilla-smart-tests -->`. A
journey `FAIL` means that HEAD does not deploy. `INCONCLUSIVE` and
`HARNESS UNAVAILABLE` do not hold.

A SQLite queue survives restarts. One suite runs at a time. Before setup,
before tests, and before each report, the controller checks that the release
branch still points at the job's commit. A stale run cannot publish a pass
for a newer commit.
No automatic test retries turn failures into passes. A restart marks an
interrupted run inconclusive instead of rerunning it silently. Failed final
comment deliveries retry from an outbox without rerunning the tests.

## Trust boundary

- `aquilla-qa-webhook.service` runs as `aquillaqa`, without Docker access or
  GitHub/model credentials. It verifies HMAC-SHA256 before parsing a payload.
- `aquilla-qa-runner.service` runs reviewed controller code from
  `/opt/aquilla-qa`. It holds a GitHub credential in root-only
  `/etc/aquilla-qa/runner.json`. It never imports PR code on the host.
- The controller downloads the exact PR archive into a fresh app container.
  A reviewed bootstrap replaces all app source. It reuses installed dependencies
  only when manifests and lockfiles match exactly. Patches, custom configuration,
  and install hooks disable reuse. Changed dependencies install inside that
  credential-free container. No per-PR Docker image build or dependency copy runs.
- The app runs in a disposable container with synthetic database credentials.
  A fresh Postgres container owns that run's database. No host directories,
  SSH keys, Docker socket, or provider/GitHub credentials enter either container.
- The reviewed harness image runs in a separate container. It shares only the
  stack's network namespace so localhost-only reset safeguards still apply.
  Filesystem and process namespaces remain separate. Only this trusted image
  receives model credentials. It runs Jev and independent outcome checks.
- The bootstrap script comes from the reviewed harness. PR versions of app
  code and dependencies run normally, but cannot replace the server controller
  or the tests. New journeys require deploying a reviewed harness revision.
- Evidence identifies both `build` (PR commit) and `harnessBuild` (reviewed
  test commit). Missing evidence produces HARNESS UNAVAILABLE, never a pass.

The reporting credential currently uses the owner's existing GitHub identity.
It stays outside all containers. Rotate it in `runner.json` when the CLI token
changes. A dedicated GitHub App installation credential can replace it later.

## Resource limits and parallelism

This host also serves Koine Greek. QA uses a separate 24 GB container filesystem,
a shared cgroup capped at 1.5 CPUs and 2500 MB RAM, and at most 512 MB swap.
Containers have process limits, bounded logs, no Linux capabilities, and no
privilege escalation. The QA bridge cannot reach host or private-network
addresses. Host Node and the existing application service remain unchanged.

The suite already supports four isolated stacks on a larger machine through
`SMART_TEST_SHARDS=4`. This host deliberately runs one stack. Starting four
stacks on 4 GB would compete for memory and CPU. Measure test time separately
from source preparation, dependency installation, and app build time before
increasing concurrency. A second PR waits in the queue.

## Installation and reviewed updates

Install Ubuntu's `docker.io` package without upgrading host Node. Then run
`scripts/hetzner-ci/install-smart-host.sh` as root. It refuses to place a
filesystem over Docker storage that contains existing images or containers.
It adds service definitions and network limits; it does not start testing.
Run `scripts/hetzner-ci/bound-containerd-storage.sh` before building images.
Modern Docker keeps its containerd image store outside `DockerRootDir`; the
script places both stores on the bounded filesystem and adds boot ordering.
It requires a QA-only Docker installation with no existing containers.

Copy the reviewed Python controller, webhook, `app_bootstrap.py`, report helper,
and harness Dockerfile into `/opt/aquilla-qa`. Copy `scripts/smart-test-comment.mjs` beside
`report.mjs`. Build `Dockerfile.smart` using a `git archive` of a reviewed
commit, named `source.tar`; tag it `aquilla-qa-harness:<commit>`.
Build with `DOCKER_BUILDKIT=0`, network `aquilla-qa`, the `aquillaqa.slice`
cgroup parent, and matching build CPU/memory caps.

Provision these files without putting secrets in command arguments or logs:

- `/etc/aquilla-qa/webhook.json`: `secret`, readable by `aquillaqa` only.
- `/etc/aquilla-qa/runner.json`: `github_token`, `author`, `harness_sha`, and
  `model_env`. Root only. `model_env` holds all seven provider settings from
  the local smart-test environment file, including `TEXT_MODEL_BASE_URL` and
  `TEXT_MODEL_REASONING`. The controller rejects missing settings and URLs
  outside the explicitly provisioned OpenRouter endpoints before execution. No Cloudflare or production DB keys.

Run `scripts/hetzner-ci/install-smart-https.sh` to add a separate nginx virtual
host for `aquilla-qa.5-161-201-46.sslip.io`.
This hostname resolves directly to the server without changing application DNS.
Issue its own certificate with Certbot webroot authentication and retain renewal.
Add an exact `/aquilla-qa/` nginx prefix that proxies to `127.0.0.1:9086`.
Limit requests to 1 MB, disable access logging for artifact bearer URLs,
validate nginx configuration, and reload nginx without restarting the app.
Register a GitHub repository webhook with JSON content, this secret, HTTPS
validation enabled, and `push` events. `pull_request` deliveries are ignored.
Enable the two QA services.

For a harness update, build a new immutable commit tag, verify it, then replace
`harness_sha` in the root-only config. The next job reads it automatically.
PR pushes never update controller code or harness images automatically.

### Pending harness update

The translation sign-off journey (`smart-tests/journeys/validation-outcomes.spec.ts`),
its oracle (`smart-tests/validation-oracle.ts`), the validation fixture seeding in
`smart-tests/fixture.ts`, and the second qualification in
`smart-tests/journeys/qualification.spec.ts` are journeys, so the deployed harness
must be rebuilt at a reviewed commit containing them. Until that happens, reports
from this host plan the smaller suite and those three checks are NOT VERIFIED, not
passed. This requires no credential or infrastructure change: build the new tag,
verify it, and replace `harness_sha`.

## Re-dispatching a run (AQU-1354)

The same commit is not re-run. `enqueue()` rejects a `(sha)` that already has
a job row, so a repeat `push` of that commit returns `duplicate`. Closing a
pull request does nothing: pull requests are not a trigger.

The two ways to get another run:

- **Push a new commit onto the release branch.** That is the pile-on, or the
  fix after a `FAIL`. The new HEAD enqueues a fresh job. Only that HEAD's
  result counts.
- **Ask the QA host operator to requeue.** With root on the host, delete the
  job row for that commit and re-deliver the webhook:
  `sqlite3 /var/lib/aquilla-qa/queue.sqlite "DELETE FROM jobs WHERE sha='<sha>'"`,
  then redeliver the `push` event from the repository webhook's Recent
  Deliveries. Confirm with `journalctl -u aquilla-qa-runner`.

## Reading a HARNESS UNAVAILABLE report

`HARNESS UNAVAILABLE` (AQU-1350; this header read `INCONCLUSIVE` before) means
the run produced no usable evidence — it never means the product passed, and
since AQU-1354 it also never means "we cannot say which part broke". The comment
names the disqualifying precondition (`evidenceDefect` in
`scripts/smart-test-comment.mjs`):

| Reason on the PR | Where to look |
| --- | --- |
| No evidence file reached the reporter | Setup failed before the suite finished: `docker`/readiness errors in `journalctl -u aquilla-qa-runner` and `/var/lib/aquilla-qa-jobs/<id>/{app,db,tests}.log` |
| Schema version is not 2 | The deployed harness image predates this reporter — rebuild `aquilla-qa-harness:<commit>` and update `harness_sha` |
| Evidence was collected for another commit | `SMART_TEST_APP_SHA` disagrees with the release HEAD, or a stale artifact was read |
| The tested checkout was not clean | Something wrote into the container's tracked tree during setup |
| No journey plan | Playwright collected zero tests: a config or harness-image fault, not a product fault |

The same header, with no journey table, appears when an oracle qualification
did not pass or when no journey reached a verdict at all: the self-test
qualifies every other verdict in the run, so without it no row says anything
about the commit. The comment names the self-test that did not pass.

A per-journey verdict is not the same thing. A DOM audit that runs and fails an
assertion reads `FAIL (model-free check)`, because that is real evidence about
the product. Only a test timeout, an interrupted run, or a skip stays
`INCONCLUSIVE`. Both are still "not a pass"; only the first is a bug to fix in
the app. An oracle qualification attaches its evidence only after every
assertion passes, so one that fails never reads `FAIL`: it makes the whole run
`HARNESS UNAVAILABLE`.

Changes to `scripts/smart-test-comment.mjs` reach a release comment only after
the file is copied beside `report.mjs` in `/opt/aquilla-qa`, and changes under
`smart-tests/` only after a reviewed harness image is rebuilt and `harness_sha`
is updated. Merging them to `dev` is not enough.

## What still has to happen on the host

A commit in this repo does not deploy the QA box. After this trigger change
is reviewed, on the host:

1. Copy `scripts/hetzner-ci/webhook.py`, `scripts/hetzner-ci/runner.py`,
   `scripts/hetzner-ci/report.mjs`, and `scripts/smart-test-comment.mjs` into
   `/opt/aquilla-qa`. `smart-test-comment.mjs` sits beside `report.mjs`.
2. Restart `aquilla-qa-webhook` and `aquilla-qa-runner`. The runner adds a
   `ref` column to the existing sqlite queue on startup. Queued pull-request
   jobs have an empty `ref` and are marked superseded; they are not run.
3. On the GitHub repository webhook, send `push`. Leave `pull_request` off;
   those deliveries are ignored.
4. The harness image does not need a rebuild for this trigger change. A
   journey change still does: build a new `aquilla-qa-harness:<commit>` tag
   and replace `harness_sha`.

## Operations and evidence

Inspect `systemctl status aquilla-qa-webhook aquilla-qa-runner` and
`journalctl -u aquilla-qa-runner`. The public health endpoint proves ingress
is listening; it does not prove tests passed. Job logs stay root-only in
`/var/lib/aquilla-qa-jobs/<id>`. Do not publish raw application/build logs.

Each release HEAD receives a starting commit comment, then the same comment updates with
verified outcomes, inconclusive checks, failures, model cost, both commits,
and elapsed time. JSON evidence lives under `/var/lib/aquilla-qa-evidence`.
Its URL contains a random 256-bit bearer token, has no directory listing,
and expires after seven days. The controller retains at most 200 job and
artifact directories; build and test logs stop recording at 8 MB each. Treat the link as private; GitHub comment
access controls do not apply once someone shares that link.

Disable new execution with `systemctl stop aquilla-qa-runner`. Stop the webhook
service or disable its GitHub hook to stop ingestion. Delete containers with
the matching `aquilla-qa-<job>-` prefix if stopping an active run. Starting the
runner records interrupted jobs as inconclusive and removes their containers.

Controller checks:

```bash
PYTHONPYCACHEPREFIX=/tmp/qa-pycache python3 -m unittest \
  discover -s scripts/hetzner-ci -p 'test_*.py'
pnpm test:smart:unit
pnpm test:smart:types
```
