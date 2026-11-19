# Dependency rules

Dependabot version updates are off. Upgrades are now done by hand, in a pull
request that cites the rules below. This file keeps every hold the old
`.github/dependabot.yml` carried, with its reason, so the knowledge does not
disappear with the config.

## How the audit replaces Dependabot

Dependabot opened pull requests. On 2026-11-13 one of them, a major bump of
`postgres` (4.0.0, PR #1939), reached production and exhausted the database
pool. Nothing in CI could have caught it: Workers runtime and Hyperdrive
behavior do not run there.

What stays is the weekly audit:

- `.github/workflows/dependency-audit.yml` runs every Monday at 09:00 UTC.
- `scripts/audit-deps.mjs` checks the lockfiles of the root workspace
  (pnpm), `auth-worker`, `sync-worker`, `agent-worker`, `monitor-worker` and
  `zapier` (npm). The workflow also runs `cargo audit` on `src-tauri`.
- `.github/audit-allowlist.json` records advisories we accept, each with a
  written reason and a `reviewBy` date. Past that date an entry stops
  suppressing anything.
- Each scheduled run files one Linear ticket per package and directory with
  un-allowlisted advisories (`scripts/audit-tickets.ts`). Tickets start in
  Triage, so a person reads them before an agent can pick one up from Todo.
  A package covered by a hold below gets the `HITL` label. An existing ticket
  is updated when its advisories change; the workflow never moves, reopens or
  closes one.

The audit reports advisories. It proposes no upgrades and it does not watch for
new releases. Two things are not covered: GitHub Actions pins and the Docker
base images in `agent-worker/Dockerfile`. A person bumps those when they touch
the file or when a GitHub security alert names them. GitHub's own Dependabot
alerts (not version updates) are a separate setting and are unaffected.

### Upgrading a dependency

1. Open an ordinary pull request. One package, or one tightly coupled group.
2. Say in the body which rules below apply and why the change respects them.
3. Read the release notes. Do not take a release on the day it ships; the old
   policy held every ecosystem one week behind the latest version, and that
   lag is still the rule (see Cooldown).
4. Anything that touches a database driver, a pool, or the Workers runtime
   needs a person to verify it against a deployed preview, because CI cannot.

## Holds

Each hold below carries a `<!-- holds: ... -->` line naming the packages it
covers (`*` at the end matches a prefix). `scripts/audit-tickets.ts` reads those
lines to mark audit tickets `HITL` and to quote the rule in the ticket. Add the
line when you add a hold.

### postgres: exactly 4.0.0, and only with `max_pipeline: 1`

<!-- holds: postgres -->

Applies to the root, `auth-worker` and `sync-worker` manifests.

postgres.js 4 is a rewrite. At its defaults it writes a statement to a busy
connection where 3.x queued it, and through Hyperdrive that left an unprepared
statement half-sent: Postgres sat in `ClientRead` holding an origin connection
until Hyperdrive dropped the client ten minutes later. Production ran out of
connections twice (2026-11-13 and 2026-11-16). The driver was pinned to 3.4.9
in between.

4.0.0 is back on these terms, all of which live in `db/shim/postgres.ts`:

- `db/shim/postgres.ts::MAX_PIPELINE` is 1, so the driver never doubles
  statements up on a pool connection. Measured on the development Hyperdrive:
  4.0.0 at its default wedged 3 runs of 3, 4.0.0 at 1 wedged 0 of 105, and
  3.4.9 wedged 0 of 105.
- `db/shim/postgres.ts::fromPostgresJs` orders unprepared statements inside a
  transaction, which `max_pipeline` does not reach.
- `db/shim/postgres.ts::capInFlight` keeps a handle inside its pool.

The record is `docs/decisions/0011-in-flight-statement-cap.md`.

The version is exact in all three `package.json` files. Change them together
or not at all; `db/shim/postgres.ts` resolves the driver from the root one.
Any other version, 4.x patch releases included, is a new driver as far as
Hyperdrive is concerned: repeat the measurement above on a deployed
environment before it merges, and do not raise `MAX_PIPELINE` without doing
the same.

A deploy bundles whatever is installed, not what the lockfile says. The second
outage was a release whose manifests pinned 3.4.9 and whose bundle contained
4.0.0. Install from the lockfile before deploying by hand.

### @tanstack/react-table: stay on v8

<!-- holds: @tanstack/react-table -->

> v9 is a full API rewrite (no useReactTable/getCoreRowModel root
> exports); ~18 files still use the v8 API. Remove once a deliberate
> migration lands.

### @livestore/*: no minor bumps

<!-- holds: @livestore/* -->

> LiveStore is pre-1.0 and ships breaking changes in MINOR versions (its
> changelog says so), so a minor bump does not belong in this group.
> 0.4 -> 0.5 is the Effect 3 -> Effect 4 migration: Schema.Literal became
> single-valued (13 call sites in src/lib/offline/schema.ts), the pnpm
> patch on @livestore/common@0.4.0 is silently dropped, the offline data
> generation and its eventlog fixture must be bumped, and every existing
> client store rebuilds once. PR #1759 went red on all four checks from
> that one bump. Remove once a deliberate migration lands.

### @cloudflare/sandbox and the sandbox-shim stage: bump together

<!-- holds: @cloudflare/sandbox -->

> The Sandbox SDK client (@cloudflare/sandbox) and the `sandbox-shim` helper it
> runs inside the container (the `FROM docker.io/cloudflare/sandbox:<version>
> AS sandbox-shim` donor stage in agent-worker/Dockerfile) speak a versioned
> protocol and must be the exact same release; agent-worker/test/
> runtime-policy.test.ts fails otherwise. An npm-only group bumped the SDK
> twice (0.7.0 -> 0.12.5, 0.12.5 -> 0.12.9) and left the Dockerfile behind both
> times, because a single-ecosystem PR cannot touch a Dockerfile. Cloudflare
> publishes both artifacts together [...]

Change `agent-worker/package.json` and the `FROM` line in
`agent-worker/Dockerfile` in the same pull request. If the two ever differ,
align them by hand. The `agent-worker` npm dependencies and its Docker images
used to ride one Dependabot pull request for this reason.

### Python in agent-worker/Dockerfile: stay on the current minor

<!-- holds: python -->

> The Python minor is a deliberate choice: every wheel pinned in the
> Dockerfile is built per interpreter minor, so 3.13 -> 3.14 is a tested
> change, not a tag bump.

Patch releases of the same minor are fine.

### Cooldown: one week behind the latest release

> Version-update lag policy (AQU-681): never take a release on the day it ships.
> `cooldown.default-days: 7` holds every ecosystem one week behind the latest
> published version — most malicious or broken fresh releases are caught and
> yanked within ~24h, so a week is the cheapest useful supply-chain buffer.

Security fixes are the exception. A fix for an advisory the audit reports does
not wait a week, but it still goes through a pull request and the rules above.

### Batch size

The old config opened at most two Dependabot pull requests a month per
ecosystem, on purpose, to keep review volume low. By hand the same idea holds:
do not merge a pile of unrelated bumps in one pull request.

## Allowlist entries

An entry in `.github/audit-allowlist.json` is an accepted risk with a reason,
not a mute button. Write why the vulnerable code is not reachable in what we
ship (a Worker or web bundle), name the dependency path, and set `reviewBy`
no more than a month out. When the date passes, the advisory goes red again
and someone decides again: upgrade, or renew with a fresh reason.
