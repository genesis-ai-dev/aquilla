# Sync Layer (v3)

How codex-web-app's event-sourced sync works, what lives where, and how to run it.

## Architecture overview

```
  ┌──────────────┐     POST /events      ┌──────────────────────────┐
  │ browser      │──────────────────────▶│ aquilla-sync-worker       │
  │ (codex-      │     (per-file JWT)     │  (CF Worker)              │
  │  web-app)    │                        │                           │
  │              │◀── WebSocket (presence)│  ┌────────────────────┐  │
  │  IDB outbox  │   /parties/project-   │  │ ProjectSync DO      │  │
  │  + flusher   │   sync/{projectId}    │  │ (per-project)       │  │
  └──────────────┘                        │  │ presence + locks    │  │
         │                                │  │ + broadcast relay  │  │
         │  GET /cells?fileId=…           │  └────────────────────┘  │
         └───────────────────────────────▶│                           │
                                          │  D1: events + projections │
                                          │  R2: media blobs only     │
                                          └──────────────────────────┘
         ┌──────────────┐
         │ frontier-    │  mints per-file sync-token JWTs
         │ server       │  identity + project permissions
         └──────────────┘
```

Two services, one D1 database, one R2 bucket. Everything lives in the same Cloudflare account so cross-service calls stay on-network.

## The two services

| service | where | role |
|---|---|---|
| **codex-web-app** | this repo (`src/`) | React app. Enqueues events in IDB outbox. Reads cells via HTTP. |
| **aquilla-sync-worker** | this repo (`sync-worker/`) | CF Worker + ProjectSync DO. Ingests events, writes D1, broadcasts. |
| **frontier-server** | `~/frontierrnd/frontier-server/cloudflare/` | Identity + project permissions + sync-token minting. |

## Event grammar

Events are the unit of change. All event types are defined in
`src/lib/sync/outbox-types.ts` (client) and `sync-worker/src/events/types.ts`
(server — must stay in sync).

### Event envelope

```ts
{
  id: string          // Client-generated UUIDv7. Idempotency key (INSERT OR IGNORE).
  schemaVersion: 1
  kind: OutboxEventKind
  projectId: string
  fileId?: string     // Omitted for project-scope events.
  cellId?: string     // Omitted for file-scope events.
  parentId?: string | null  // AD-2 chain pointer (see below). null on genesis only.
  author: string      // Username; server validates against JWT claim.
  payload: { ... }   // Kind-specific (see outbox-types.ts).
  clientTs: number    // Wallclock ms at emit. Server ordering uses serverSeq.
}
```

### Event kinds

**Source-side (importer / admin only):** `source.cell.create`, `source.cell.commit`,
`source.cell.delete`, `source.cell.reorder`

**Target-side (translator, contributor+):** `target.cell.create`, `target.cell.commit`,
`target.cell.delete`, `target.cell.reorder`

**Validation:** `cell.validate`, `cell.unvalidate`

**Audio:** `cell.audio.attach`, `cell.audio.select`, `cell.audio.remove`

**File lifecycle:** `file.create`

Genesis events (`source.cell.create`, `target.cell.create`, `file.create`) carry
`parentId = null`. Every other chain-mutating kind must carry the current chain-head
`event_id` of the row being mutated as `parentId`.

## The flow (single-user, single-file)

1. User opens a project + file. The app fetches cells via `GET /cells?fileId=<id>`.
2. User edits a cell. The editor creates an `OutboxRawEvent` (e.g. `target.cell.commit`)
   with the current cell's `event_id` as `parentId` and enqueues it in the IDB outbox.
3. The outbox flusher polls the IDB queue, groups pending events by `fileId`, and
   `POST /events` each batch to the sync-worker with a per-file sync-token JWT.
4. The sync-worker's `/events` handler:
   - Verifies the JWT (`aud: "sync"`, role check via `requiredRoleFor`).
   - Checks idempotency: `INSERT OR IGNORE` on `events.id`.
   - Assigns a monotonic `server_seq`.
   - Runs the **AD-2 first-child-of-parent guard** (FWW conflict resolution).
   - Builds D1 statements for the event row + projection updates.
   - Batch-commits to D1.
   - Calls `ProjectSync.__broadcast` to fan the accepted event out to
     subscribed clients.
5. Subscribed clients receive an `event.applied` frame and soft-revalidate
   their cell projections (no full refetch — a targeted cache invalidation).

## Conflict resolution: first-write-wins (FWW)

Every chain-mutating event carries `parentId` — the `event_id` of the cell
state the client was editing when it emitted the event.

On POST /events the server checks: **is `parentId` still the current
chain-head for this cell?**

- **Yes (fast path):** event is accepted; `cells.event_id` advances to the new
  event's `id`.
- **No (stale sibling):** event is rejected with `409 Conflict`. The first
  writer wins; subsequent writers whose `parentId` no longer matches are told
  to rebase.

This guard is implemented in `sync-worker/src/events/event-projection.ts`.
Idempotency and the FWW guard together make offline editing safe: the IDB
outbox can retry a POST any number of times — duplicate `id` is a silent
no-op; stale `parentId` surfaces an explicit rejection rather than silent data
loss.

## IDB outbox

`src/lib/sync/outbox.ts` — IndexedDB queue that survives tab close. Events
sit in the queue until the flusher drains them (`src/lib/sync/outbox-flush.ts`).

Key properties:
- Events are dequeued only after the server returns 2xx.
- Rejected events (409 Conflict) are moved to a quarantine bucket and
  surfaced in the UI via `usePendingOutboxRecords`.
- The flusher groups events by `fileId` so each POST batch uses a single JWT.
- Max batch size: 100 events per POST.

## Projection tables

The sync-worker maintains these D1 tables from the event log:

| table | purpose |
|---|---|
| `events` | Append-only log. `id` PK, `server_seq` monotonic. |
| `cells` | Per-cell projection: `value`, `valueHtml`, `event_id` (chain head), `is_validated`, `word_count`, `last_editor`, `last_edit_at`. |
| `files` | Per-file rollup: `cell_count`, `approved_count`, `word_count`, `last_edit_at`. |
| `cell_validators` | Validation state (separate from `cells` to avoid contention). |
| `cells_fts` | FTS5 virtual table kept in sync with `cells` via D1 triggers. |
| `checkpoints` | Named snapshots for recovery. |

Projections are always derivable from the event log. If a projection drifts,
replay events from `server_seq = 0` to rebuild.

## ProjectSync Durable Object

One `ProjectSync` instance per project (keyed on `projectId`). Its
responsibilities are **transient only** — it writes nothing to D1 or R2:

- **Presence**: tracks which users are connected to a project and which file
  each is viewing. Clients connect via WebSocket to
  `/parties/project-sync/{projectId}?token=<jwt>`.
- **Focus-locks**: tracks which cell (if any) each connected client holds an
  edit lock on. Lock leases expire when the client disconnects or releases
  explicitly.
- **Broadcast relay**: after the Worker's `/events` handler commits to D1, it
  calls `ProjectSync.__broadcast` to push an `event.applied` frame to all
  WebSocket clients subscribed to that project. Clients react by soft-
  revalidating affected cell projections.

When a room empties (all clients disconnect), ProjectSync discards all
transient state. Late-joining clients discover presence and lock state by
receiving the current snapshot on connect.

## Security model

- **`SECRET_KEY`** (frontier-server) signs Frontier access tokens. Never
  leaves frontier-server.
- **`SYNC_SECRET_KEY`** (shared between frontier-server + aquilla-sync-worker)
  signs sync-token JWTs. Set via `wrangler secret put` on both workers;
  never committed.
- **Sync-token JWTs** carry `{userId, projectId, fileId, role, aud: "sync", exp}`.
  They intentionally omit `sub` so they cannot be replayed against
  frontier-server's `authMiddleware`. The `aud: "sync"` check is belt-and-
  suspenders.
- **Role on a request** is read only from verified JWT claims.

## D1 schema

Two databases:

**`frontier-db-v2`** (identity + permissions, owned by frontier-server):
- `users`, `organizations`, `email_lookup`
- `roles` — numeric ladder (100 viewer → 700 owner)
- `projects`, `project_members`, `project_invites`

**`aquilla-db`** (event log + projections, owned by sync-worker migrations):
- `events`, `cells`, `files`, `cell_validators`, `cells_fts`, `checkpoints`

## R2

R2 (`aquilla-snapshots`) holds **media blobs only** — audio recordings
(`cell.audio.attach`) and generated voice files. Key layout:

```
projects/{projectId}/cells/{cellId}/audio/{audioId}.{ext}
```

There are no Y.Doc snapshots, tail updates, or compaction artifacts in R2.

## Status indicator

`SyncStatusIndicator` in the workspace bar. States derived from outbox depth
+ WebSocket connection:

- **live** (green) — connected + no pending events
- **pending** (amber) — events in outbox awaiting flush
- **connecting** (amber) — WebSocket handshake / reconnect backoff
- **offline** (red) — hard offline or auth failure
- **disabled** (grey, "Local only") — no session / no project

## Running locally

Three terminals:

```sh
# 1. sync-worker (port 8787)
cd sync-worker
cp .dev.vars.example .dev.vars       # first time only
# Create local D1 database if needed:
#   npx wrangler d1 create codex-dev
# Apply schema migrations:
#   npx wrangler d1 migrations apply aquilla-db --local
npx wrangler dev --port 8787

# 2. frontier-server (port 8788)
cd ~/frontierrnd/frontier-server
npm --prefix cloudflare run dev

# 3. codex-web-app (port 1420)
npm run dev
```

Env knobs for the client:
- `VITE_SYNC_WORKER_HOST` — defaults to `127.0.0.1:8787` in dev,
  `aquilla-sync-worker.blue-darkness-7674.workers.dev` in prod builds.
- `VITE_FRONTIER_API_URL` — defaults to `https://api.frontierrnd.com`.

## Tests

- **`sync-worker/src/__tests__/*.test.ts`** — unit tests for auth verification,
  role gating, FWW guard, projection extraction, projection dedup, admin endpoint.
- **`src/lib/sync/*.test.ts`** — client-side unit tests for token fetching,
  outbox logic, event-kind guards.
- **`~/frontierrnd/frontier-server/cloudflare/src/tests/*`** — handler tests
  for `/sync-token`, `/projects/:id/files/:id`, `/projects/:id/invites`,
  `/projects/accept-invite`.
