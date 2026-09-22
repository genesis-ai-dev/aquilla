# Hetzner self-hosted e2e

For the shared 4 GB host and automatic Jev PR comments, use the
[standalone webhook runner](smart-testing-webhook.md). The dedicated-box
bootstrap below replaces system tools and is not suitable for that shared host.

Dedicated Ubuntu box that runs Aquilla Playwright smoke against the same
local stack as a laptop (`wrangler dev` + `aquilla-dev-pg`). GitHub Actions
is the webhook and the job queue. This machine is only the compute.

This does **not** replace Cloudflare Workers Builds. Preview uploads and the
current PR unit/lint/build gate stay on `aquilla-web-preview` until a later
cutover. Live `dev`/`main` deploys stay manual.

## Colima vs Docker Engine

On a Mac, Colima is the light Docker Desktop replacement. `e2e/README.md`
already says `colima start` before push.

On a Linux Hetzner box, Colima is the *heavy* option: Lima + QEMU is a nested
VM and needs nested virtualization. Docker Engine speaks the same `docker`
CLI that `scripts/e2e-up.ts` already calls, with no extra VM.

`bootstrap.sh` defaults to Docker Engine. Pass `--runtime=colima` only if you
want the Mac-shaped stack and the plan supports nested virt.

## What you run over SSH

From a clone on your laptop (do not paste SSH keys into chat):

```bash
# 1. Base packages, Node 22, pnpm, Docker Engine, Playwright OS libs, user `ci`
ssh root@HETZNER 'bash -s' < scripts/hetzner-ci/bootstrap.sh

# Optional Mac-shaped runtime (usually the wrong call on Linux):
# ssh root@HETZNER 'bash -s -- --runtime=colima' < scripts/hetzner-ci/bootstrap.sh

# 2. Start / create aquilla-dev-pg (e2e-up will not create this container)
ssh root@HETZNER 'bash -s' < scripts/hetzner-ci/ensure-e2e-runtime.sh

# 3. Register one Actions runner (enough: smoke already shards 3 ways)
TOKEN=$(gh api -X POST repos/genesis-ai-dev/aquilla/actions/runners/registration-token --jq .token)
ssh root@HETZNER "bash -s -- --token $TOKEN --count 1" < scripts/hetzner-ci/install-runners.sh
```

Recommended size: **4 vCPU / 16 GB**. Smoke boots three isolated stacks
(identity + sync + Vite + Chromium each).

Confirm the runner is **Idle** under GitHub → Settings → Actions → Runners,
then Actions → **E2E (Hetzner)** → Run workflow.

Do not add a `pull_request` trigger until that dispatch is green. A missing
runner queues every PR indefinitely.

## Manual smoke without Actions

```bash
ssh ci@HETZNER
git clone https://github.com/genesis-ai-dev/aquilla.git
cd aquilla
pnpm install && pnpm --dir auth-worker install && pnpm --dir sync-worker install
pnpm exec playwright install chromium
bash scripts/hetzner-ci/ensure-e2e-runtime.sh
pnpm test:e2e:smoke
```

## Security

- This box is CI-only. No prod SSH keys, no Neon prod URLs, no live-deploy
  Cloudflare token on disk.
- The runner account is `ci`. It can talk to Docker. It should not have
  passwordless sudo beyond what bootstrap set.
- Never use `pull_request_target`. Do not auto-run workflows from forks.
- `e2e-hetzner.yml` has `concurrency: e2e-hetzner` + `cancel-in-progress` so
  two smokes cannot share `aquilla-dev-pg` or ports 5173/8787/8788.

## Later (not this runbook)

Re-enable `pull_request` on `.github/workflows/ci.yml` with
`runs-on: [self-hosted, hetzner]`, register more runner processes, and
disconnect Workers Builds from the test gate. Preview upload can stay a
final Actions step with a preview-scoped `CLOUDFLARE_API_TOKEN`.
