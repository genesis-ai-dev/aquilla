# Automatic Jev PR testing on the shared Hetzner host

The service runs independently of GitHub Actions. Its webhook endpoint is
`https://aquilla-qa.5-161-201-46.sslip.io/aquilla-qa/github`. It accepts signed `pull_request`
events for `genesis-ai-dev/aquilla` only. Drafts, forks, closed PRs, unrelated
events, and duplicate PR/commit pairs do not run. GitHub's ping is acknowledged.

A SQLite queue survives restarts. One suite runs at a time. Before setup,
before tests, and before each report, the controller checks the current PR
head through GitHub. A stale run cannot publish a pass for a newer commit.
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
  test commit). Missing evidence produces INCONCLUSIVE, never a pass.

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
  `model_env`. Root only. `model_env` holds the same five provider settings as
  the local smart-test environment file. No Cloudflare or production DB keys.

Run `scripts/hetzner-ci/install-smart-https.sh` to add a separate nginx virtual
host for `aquilla-qa.5-161-201-46.sslip.io`.
This hostname resolves directly to the server without changing application DNS.
Issue its own certificate with Certbot webroot authentication and retain renewal.
Add an exact `/aquilla-qa/` nginx prefix that proxies to `127.0.0.1:9086`.
Limit requests to 1 MB, disable access logging for artifact bearer URLs,
validate nginx configuration, and reload nginx without restarting the app.
Register a GitHub repository webhook with JSON content, this secret, HTTPS
validation enabled, and `pull_request` events. Enable the two QA services.

For a harness update, build a new immutable commit tag, verify it, then replace
`harness_sha` in the root-only config. The next job reads it automatically.
PR pushes never update controller code or harness images automatically.

## Operations and evidence

Inspect `systemctl status aquilla-qa-webhook aquilla-qa-runner` and
`journalctl -u aquilla-qa-runner`. The public health endpoint proves ingress
is listening; it does not prove tests passed. Job logs stay root-only in
`/var/lib/aquilla-qa-jobs/<id>`. Do not publish raw application/build logs.

Each PR receives a starting comment, then the same comment updates with
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
