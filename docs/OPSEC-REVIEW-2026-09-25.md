# Operational Security Review — 2026-09-25

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-09-23.md`
(OPS-35…OPS-36, input validation & injection attacks). New findings continue the
**OPS-n** series at **OPS-37**._

**Scope for this pass: infrastructure & deployment security** — the Friday slot in
the rotating weekly cycle (auth/session Mon, authz/access Tue, injection Wed,
API/data exposure Thu, **infra/deployment Fri**). No prior pass in this series has
been scoped to this theme by name, though individual infra items have surfaced in
passing (OPS-21's red CI gate, the operator-side D4 recommendations in this
document's own §5). This pass swept CI/CD workflows (`.github/workflows/*.yml`),
all six `wrangler.toml`s, the deployment/preview scripts, the `agent-worker`
sandbox, the two Modal services (`infra/modal/*.py`), the Hetzner self-hosted QA
runner (`scripts/hetzner-ci/`), and secret handling repo-wide, then cross-checked
anything that looked new against every prior `docs/OPSEC*.md` before treating it as
a finding.

Most of this surface is already unusually well-built: every GitHub Action is
pinned to a full commit SHA, `pull_request_target` is not used anywhere,
`workflow_dispatch` inputs are validated before reaching a shell, preview/deploy
scripts pass arguments as argv arrays rather than interpolating into shell
strings, `resolve-deployment-target.sh` fails closed on any ref it doesn't
recognize, and the agent sandbox and both Modal services already carry
constant-time secret comparisons, path-traversal guards, and an SSRF-hardened URL
fetcher with DNS-rebinding protection. The two findings below are real gaps in
that otherwise solid design — both are controls the repo had already built
correctly for one pipeline (production web/worker deploys; IPv4 QA containment)
that quietly didn't carry over to a neighboring one.

Every finding is labelled **FACT** (verified against a file:line in this tree) or
**JUDGMENT** (reasoned inference about exploitability that can't be fully proven
without live infrastructure access this review doesn't have).

---

## Findings

### OPS-37 — Desktop code-signing secrets were reachable by anyone who could push a `v*` tag, with no reviewer gate — **FIXED** [FACT]

`.github/workflows/tauri-release.yml:1-4` triggers on `push: tags: ["v*"]` with no
branch restriction, no `environment:` gate, and no equivalent of the
`resolve-deployment-target.sh` fail-closed check the production web/worker path
enforces. Per `docs/DEPLOYMENT-ENVIRONMENTS.md`, production deploys of the web app
and Workers already **enter the GitHub `production` Environment, whose
deployment-branch policy admits only `release/*/*/*`** — that is the repo's own
established pattern for "don't let an unreviewed ref reach production secrets."
The desktop release pipeline is the one other path that ships something directly
to end users (a signed installer, auto-updated via `TAURI_SIGNING_PRIVATE_KEY`),
and it had no analog of that gate at all.

Concretely, before this fix, the `build` job (`tauri-release.yml:6-101`):

1. Checks out the exact commit the tag points at (`actions/checkout`, line 24).
2. Runs `pnpm install --frozen-lockfile`, `cargo test`, `pnpm run build`, and the
   Tauri CLI against that commit's own code — all of which can execute arbitrary
   code from it (npm lifecycle scripts, a Rust `build.rs`, the build tooling
   itself).
3. Only *after* that untrusted build has already run, injects six real signing
   secrets into `tauri-apps/tauri-action`'s environment (lines 79-94):
   `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_CERTIFICATE`(+password),
   `APPLE_SIGNING_IDENTITY`, `WINDOWS_CERTIFICATE`(+password),
   `TAURI_SIGNING_PRIVATE_KEY`(+password) — and produces a real, signed, ready-to-
   publish (draft) release across macOS/Windows/Linux.

`docs/OPSEC.md` D4 already names exactly this: "the ability to ship a signed
malicious desktop build" as the reason these six secrets are the highest-stakes
credential set in the repo, and its operator-side §5 already recommends
compartmentalizing them. What was missing was the mechanism that recommendation
was about — the actual trigger this workflow reacts to had no review step in
front of it. Tag-push permission on GitHub is coarser than "can open a PR" (it
does not require passing CI or a review, and depending on repo settings can be
available to anyone with write access, not just release managers), so this
amounted to: one `git push origin v1.2.3` against any reachable commit, and CI
runs that commit's code with real code-signing material available to it, with no
human step in between.

**Reachable by:** anyone with tag-push permission on the repository, targeting
any commit they can push a tag at (not necessarily one that went through review —
there is no ref restriction on this trigger, unlike the `release/*/*/*` policy the
production Worker/web path enforces).

**Fix.** The `build` job now declares `environment: desktop-release-signing`
(`.github/workflows/tauri-release.yml`). A GitHub Environment with required
reviewers configured holds the entire job — including the checkout and build
steps, not just the signing step — at "Waiting" until an authorized reviewer
approves it, the same mechanism `deploy-workers.yml` already uses for production.
This is a same-shaped fix to a same-shaped gap, not new infrastructure.

**This fix is necessarily incomplete from inside the repo.** A declared
Environment with no protection rules configured holds nothing — GitHub
Environment protection rules (required reviewers, and optionally a deployment tag
policy scoping it to `v*`) are configured in repository Settings, not in
workflow YAML, and are not visible or verifiable from this tree (the same
out-of-band caveat this review series has applied to branch protection and
CODEOWNERS enforcement throughout). `docs/OPSEC.md` §5 now carries the specific
action item. **This is the one piece of this finding that needs a human to
actually close** — see the PR description and the tracked issue.

### OPS-38 — The Hetzner QA sandbox's network containment was IPv4-only; IPv6 egress was unfiltered by default — **FIXED** [FACT]

`scripts/hetzner-ci/install-smart-host.sh:38-50` builds the firewall for
`br-aquillaqa`, the bridge every PR-triggered QA container runs on. Its own
comment states the design goal plainly: "PR containers can reach public
package/model endpoints, not the host or LAN." The implementation
(lines 42-49, before this fix) was `iptables`-only: it blocks `INPUT` from the
bridge to the host, and drops the RFC1918 ranges, link-local, loopback, and the
host's own public IPv4 (`5.161.201.46/32`) via a dedicated `AQUILLA_QA` chain
hooked into `DOCKER-USER`. There was **no `ip6tables` equivalent anywhere in this
script or `scripts/hetzner-ci/`**.

This runner executes same-repo PR code — `webhook.py:33` gates dispatch to
`head.repo.id == REPO_ID`, so not arbitrary fork PRs, but any branch pushed by
anyone with repo write access — inside containers that run real `pnpm install`
and app-boot cycles, i.e. exactly the kind of code that can make outbound network
calls of its own choosing (a malicious or compromised dependency, a build script,
a test that shells out). If the host has IPv6 routing enabled — the normal
default for a Hetzner Cloud VM, which is typically issued a routed public `/64` —
a container on this bridge could reach the host itself, other reachable IPv6
destinations, or exfiltrate data over IPv6, entirely outside the containment
policy the IPv4 rules implement. The gap is not a misconfiguration in an existing
rule; it's an entire address family the firewall design never had an opinion
about, so it defaulted to allowed.

**Reachable by:** any process running inside a QA container, if the host has
IPv6 routing enabled (not verifiable from this repo — a Hetzner-side network
setting).

**Fix.** `firewall.sh` now also drops all IPv6 traffic from the bridge outright
(`ip6tables`, guarded by `command -v ip6tables` so the script doesn't fail on a
host without IPv6 support compiled in): block `INPUT` from `br-aquillaqa` the same
way the IPv4 rule does, and a `DOCKER-USER`-hooked chain that drops everything
forwarded from the bridge, full stop — no attempt to allowlist "public IPv6
endpoints only." Nothing on this path is known to need IPv6 (package registries
and model endpoints this runner talks to are all reachable over IPv4), and the
host's own IPv6 address — unlike its IPv4, which is a fixed, knowable literal
(`5.161.201.46/32`) — isn't something this script can enumerate the way the IPv4
rule does, so there's no safe equivalent of that one allow-by-omission the IPv4
ruleset relies on. Blocking the whole address family removes it as a containment
bypass rather than leaving it implicitly open.

---

## Reviewed, no new finding

Each item below was actually checked against the code or config, not assumed
safe by category.

- **GitHub Actions workflow injection** — every `.github/workflows/*.yml`
  (`ci.yml`, `deploy-workers.yml`, `dependency-audit.yml`, `dev-neon-refresh.yml`,
  `e2e-hetzner.yml`, `audio-delta-sync.yml`, plus `tauri-release.yml` above) uses
  only pinned, full-SHA third-party actions; no `pull_request_target`; every
  `workflow_dispatch` input is either a `type: choice` enum or validated
  (`resolve-deployment-target.sh`'s ref-pattern match) before it can reach a shell
  command, so there's no `${{ github.event.inputs.* }}`-into-`run:` injection
  surface anywhere in the tree.
- **All six `wrangler.toml`s** (root, `auth-worker/`, `sync-worker/`,
  `agent-worker/`, `resource-worker/` — the last currently undeployed) — no
  committed secrets; the one plaintext-looking value, a Stripe `pk_test_...`
  publishable key, is meant to be public by Stripe's own design, and
  `ADMIN_EMAILS` is an intentionally-visible allowlist, not a credential.
  Environment-scoped bindings are correctly separated (`[env.development]` /
  `[env.production]`), and unnamed/default profiles are local-only by the
  convention `CLAUDE.md` documents.
- **Deployment/preview scripts** (`scripts/cloudflare-stack-preview.mjs`,
  `scripts/cloudflare-pr-preview.mjs`, `scripts/resolve-deployment-target.sh`) —
  branch names and PR numbers are sanitized (regex-validated, or hashed) before
  use, every shell-out uses `spawn()`/`execFileSync` with an argv array rather
  than a shell string, and `resolve-deployment-target.sh` hits its `*)` case —
  abort — for any ref it doesn't explicitly recognize.
- **`agent-worker` sandbox** (`docs/AGENT-SANDBOX.md`) — the shared
  `AGENT_SANDBOX_KEY` bearer is compared with `secureCompare` (constant-time);
  the workspace path resolver rejects `..` and anything outside `/workspace`;
  the Sandbox Durable Object is created with `enableInternet: false`, i.e.
  default-deny egress rather than an allowlist a new code path could bypass by
  omission.
- **`infra/modal/diarization.py` and `seed_vc.py`** — both compare their shared
  secret with `hmac.compare_digest`; both validate any user-supplied URL through
  an SSRF guard that re-validates redirects (closing the classic
  redirect-to-internal-IP bypass) and resolves DNS itself before connecting
  (closing DNS rebinding); `seed_vc.py`'s upstream clone is pinned to a specific
  commit, not a moving branch.
- **Secrets committed to the repo** — grepped for API-key-shaped literals
  (`sk-`, `AKIA`, PEM private-key headers, hardcoded `Bearer `/password
  literals) across the tree; nothing live turned up. `.env.example` /
  `.dev.vars.example` files contain only placeholder values, and `.gitignore`
  correctly excludes the real `.env`/`.dev.vars` files.
- **`dependency-audit.yml`'s allowlist** — every suppressed advisory carries a
  dated justification tied to a specific package/version, not a blanket
  suppression.

## Secondary checks — confirmed still open, not re-investigated (out of this pass's exact theme, but infra-adjacent)

- **V7/SEC-1** (`auth-worker/wrangler.toml` — production and development share
  `SECRET_KEY`/`SYNC_SECRET_KEY`) — still present, still flagged in this
  document's own §1 as the highest-leverage open item in the whole series, most
  recently re-confirmed by the 09-21 pass. Directly infra-shaped (it's a
  `wrangler.toml` secret-binding decision), but splitting it is a coordinated,
  cross-environment deploy — the same reason it has been carried forward rather
  than fixed on each pass that touches it.
- **OPS-11's documented remaining half** (`sync-worker/src/lib/service-auth.ts`)
  — `SYNC_SECRET_KEY` still doubles as both the sync-token signing key and the
  identity→sync service-to-service bearer; the module's own header comment
  already names this as deliberate, unfinished follow-up work blocked on a
  coordinated sender/receiver credential swap, not a gap this pass discovered.
  Re-confirmed still true; not re-fixed here since it's the same known,
  already-tracked item.
- **CODEOWNERS enforcement** (`.github/CODEOWNERS` requires `@ryderwishart`
  review on `**/wrangler.toml`, `agent-worker/Dockerfile`,
  `.github/workflows/`, `scripts/hetzner-ci/`, `docs/DEPLOYMENT-ENVIRONMENTS.md`
  — added after commit `27afb72b` landed an `ADMIN_EMAILS` grant as an ordinary,
  unreviewed commit) — the file itself is correctly scoped to exactly the
  infra-sensitive paths this pass covers, but it only has teeth if "Require
  review from Code Owners" is turned on in branch protection, which — like
  OPS-37's Environment reviewers — is a repo setting, not something visible from
  this tree. Flagged in the PR/issue for the same human follow-up as OPS-37,
  since both are "a control this repo declared in code but GitHub settings must
  still switch on."

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-37 | `tauri-release.yml` ran the tagged commit's own build tooling and then exposed six code-signing secrets, gated by nothing but tag-push permission | Medium — requires tag-push permission on the repo, which is a coarser bar than "passed review," but needs no further trickery once held | High — the one pipeline in this repo that can ship a signed, auto-updating malicious desktop build directly to real users | **High** | Fixed in code; needs a repo-settings follow-up to take effect (see above) |
| OPS-38 | QA sandbox firewall had no IPv6 rules, so IPv6 egress/host-reachability was unfiltered wherever the host routes it | Low-Medium — depends on the host actually having IPv6 routing enabled, and on PR-authored code choosing to use it; reachable only by repo-write-access authors (webhook is same-repo-only), not arbitrary forks | Medium — bypasses the sandbox's stated containment boundary (reach public endpoints, not host/LAN), potential data exfiltration or host-reachability path | **Medium** | Fixed |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| `build` job gated behind a `desktop-release-signing` GitHub Environment, held until a required reviewer approves | `.github/workflows/tauri-release.yml` |
| `docs/OPSEC.md` D4 row and operator-side §5 updated with the new Environment and the outstanding repo-settings step | `docs/OPSEC.md` |
| QA bridge (`br-aquillaqa`) firewall now drops all IPv6 traffic (`INPUT` and forwarded, mirroring the existing IPv4 `AQUILLA_QA` chain into a new `AQUILLA_QA6`), guarded by an `ip6tables` presence check | `scripts/hetzner-ci/install-smart-host.sh` |

No UX/UI change: both fixes are CI/infra-only. OPS-37 adds one manual-approval
click to the desktop release process for whoever pushes the release tag — this
is the one piece of friction this pass added, and it's deliberate: it's gating
the single highest-blast-radius action in the entire pipeline (shipping signed
code to end users), matching the friction the production web/worker deploy path
already accepts for the equivalent action. OPS-38 is invisible to any legitimate
QA run; the runner never depended on IPv6 in the first place.

## Verification

* `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/tauri-release.yml'))"`
  — parses cleanly after the `environment:` addition.
* `bash -n scripts/hetzner-ci/install-smart-host.sh` — parses cleanly after the
  `ip6tables` addition.
* Both changes are additive/declarative (a workflow `environment:` key; a
  firewall script's heredoc gains more rules under the same `set -euo pipefail`
  script it already ran) — neither changes any existing IPv4 rule, deploy
  target, or build step, so no existing pipeline behavior changes for a run that
  was already passing.
* The `install-smart-host.sh` change could not be exercised against a live
  Hetzner host from this environment (no such host is reachable here); it was
  verified by reading the resulting `ip6tables` invocations against the existing,
  already-deployed IPv4 pattern they mirror; a human operator should re-run
  `install-smart-host.sh` (idempotent — every rule uses `-C ... || -I/-A ...`) on
  the actual QA host and confirm with `ip6tables -L -n` that the QA bridge has no
  path to the host.

## Not fixed here — needs follow-up

1. **Configure GitHub Environment protection rules for `desktop-release-signing`**
   (required reviewers; optionally a tag deployment policy of `v*`). This is the
   part of OPS-37 that only a repository admin can complete — see the PR
   description and the linked Linear issue.
2. **Confirm "Require review from Code Owners" is enabled in branch protection**
   for the branches CODEOWNERS is meant to protect — same category of follow-up,
   surfaced while re-checking CODEOWNERS' scope against this pass's theme.
3. **V7/SEC-1 and OPS-11's remaining half** — both re-confirmed still open, both
   out of this pass's scope to fix (cross-environment secret split; coordinated
   sender/receiver credential swap), tracked in this document's own history
   rather than re-opened here.

---

_Re-run the mechanical parts of this review with:
`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/tauri-release.yml'))"`,
`bash -n scripts/hetzner-ci/install-smart-host.sh`, and a manual read of
`.github/workflows/tauri-release.yml`'s `environment:` key against whatever
GitHub Environment protection rules are configured at review time._
