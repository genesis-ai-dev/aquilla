# Aquilla documentation

Use this index to distinguish current operational documentation from historical
design and audit material.

## Current operational truth

- [Deployment environments](DEPLOYMENT-ENVIRONMENTS.md) — canonical branch,
  Wrangler profile, hostname, Worker, Neon branch, R2 bucket, and deploy-command
  mapping.
- [System specification](SPEC.md) — current product and system boundaries.
- [Sync architecture](SYNC.md) — current event, projection, realtime, and blob
  ownership.
- [Cloudflare Workers Builds](runbooks/cloudflare-workers-builds.md) — disconnected
  build integrations, explicit deployment ownership, previews, and verification.
- [E2E](../e2e/README.md) — local integration and smoke-test environment.
- [RLS rollout](RLS-ROLLOUT.md) — Postgres row-level-security operations.
- [Operational security](OPSEC.md) — sensitive data inventory, threat model,
  open risks, and which security controls are actually enforced. Re-run its
  mechanical checks with `pnpm run scan:secrets` and `pnpm audit --prod`.

Runtime configuration in `wrangler.toml`, `auth-worker/wrangler.toml`,
`sync-worker/wrangler.toml`, the deploy workflows, and `package.json` is enforced
against the deployment matrix by `scripts/worker-deployment-contract.test.ts`.
Change the configuration, matrix, and test together.

## Product behavior specification

The sibling `aquilla-specs` repository is the source of truth for intended product
behavior. Its implementation documents describe the deployed topology and
environment contract. This repository remains the source of truth for exact live
resource identifiers and executable deploy commands.

## Historical and reference material

Dated audits, incident notes, rollout logs, and material under `docs/design/`,
`docs/superpowers/`, `docs/swarm/`, and `docs/v3-audit/` preserve decisions and
provenance. They are not live deployment instructions unless a current document
above links to them for a specific procedure. In particular, references to D1 as
the live event store, `frontier-server`, or a VS Code extension describe retired
architectures.
