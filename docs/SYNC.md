# Sync architecture

This document describes the live Aquilla sync stack. The pre-cutover D1 and
`frontier-server` design is retired.

## Data flow

```text
Browser
  |-- IndexedDB outbox -- POST /events --> sync-worker --> Neon event log
  |                                             |          + projections
  |-- authenticated reads ----------------------|
  |-- WebSocket presence/locks <------ ProjectSync Durable Object
  |
  +-- identity, membership, sync tokens ------> auth-worker --> Neon

sync-worker/auth-worker -- media and source blobs --> R2
```

The browser enqueues edits in an IndexedDB outbox and flushes them asynchronously
to the sync Worker with a per-file JWT. The sync Worker appends accepted events to
Postgres and projects them into the read tables in the same datastore. A
per-project `ProjectSync` Durable Object relays accepted events and holds transient
presence and focus-lock leases; it is not a durable event or blob store.

## Service ownership

| Component | Responsibility |
| --- | --- |
| React SPA (`src/`) | Editing UI, local IndexedDB outbox, authenticated reads, realtime client |
| Identity Worker (`auth-worker/`) | Users, organizations, projects, membership, permissions, access tokens, sync-token minting, chat |
| Sync Worker (`sync-worker/`) | Event validation, append-only event log, cell/file projections, project reads, realtime relay, blob endpoints |
| Neon Postgres via Hyperdrive | Durable identity, event, projection, and metadata state |
| ProjectSync Durable Object | Transient presence, focus-lock leases, and broadcast relay only |
| R2 | Media, import-source blobs, and agent artifacts only |

`frontier-server` is not part of the running system. D1 migration files are
historical inputs to the Postgres schema, not a live datastore.

## Event contract

Client event types live in `src/lib/sync/outbox-types.ts`; the immediate server
consumer lives under `sync-worker/src/events/`. The envelope carries a unique event
ID, schema version, kind, project/file/cell scope, author, payload, client timestamp,
and the current parent event where the event kind participates in a chain.

Important invariants:

- The event ID is the idempotency key. Retrying the same event must not duplicate
  its effect.
- Chain-mutating events use first-write-wins against the current parent. A stale
  sibling returns `409` rather than silently overwriting accepted work.
- The sync Worker is the single writer for the event log and its projections.
- A successful write advances the durable projection before realtime broadcast.
- The browser removes an outbox record only after the server accepts it. Rejected
  records remain visible for recovery.
- Producer/consumer changes must be covered through the complete client -> server
  contract, not only by isolated type tests.

## Reads and transient projection gaps

Reads come from Neon projections. A just-accepted event can briefly race another
request while infrastructure settles, so the client uses bounded state-based
retries for known transient missing rows. Exhaustion is an explicit error; it is
never converted to an empty project or destructive reset. See the sync read helpers
and their regression tests for the exact retry contracts.

## Authentication and revocation

The identity Worker mints the per-file sync JWT. The sync Worker verifies its
audience, scope, role, and author and re-checks live membership for writes. New token
mints fail immediately after membership removal; active ProjectSync sessions are
notified and closed. Existing authenticated reads retain the documented bounded
token lifetime.

Secrets are provisioned per named Wrangler environment and are never committed.
The exact environment-to-host and storage mapping is defined in
[Deployment environments](DEPLOYMENT-ENVIRONMENTS.md).

## Local development and tests

`pnpm dev` starts local Postgres, the identity Worker, the sync Worker, and Vite.
Hyperdrive is pointed at the Docker-managed Postgres instance. The dev login at
`http://127.0.0.1:5173/__dev/login` is enabled only under the local Wrangler flag.

Run affected unit/worker tests while implementing. Cross-boundary changes require
the relevant integration or smoke spec, and `pnpm run test:e2e:smoke` is the
pre-push gate. See [e2e/README.md](../e2e/README.md).

## Deployment safety

All live deploys use an explicit named Wrangler profile and end with the public
environment verifier. The verifier checks DNS/TLS, exact unauthenticated API
contracts, and the SPA bundle's embedded API targets. See
[Deployment environments](DEPLOYMENT-ENVIRONMENTS.md) and
[Cloudflare Workers Builds](runbooks/cloudflare-workers-builds.md).
