# Sync Layer

How codex-web-app's Yjs-based sync works, what lives where, and how to run it.

## The shape

```
                ┌──── Frontier JWT ────┐
                │                      ▼
  ┌──────────┐  │  ┌──────────────┐   ┌────────────────────────┐
  │ browser  │──┴─▶│ frontier-     │   │ codex-sync-worker      │
  │ (codex-  │     │ server        │   │  (CF Worker + DO + R2) │
  │ web-app) │     │  (CF Worker)  │   │                        │
  └────┬─────┘     │  /sync-token  │   │  one DO per file       │
       │           │  invites      │   │  R2: snapshots + tails │
       │           └──────┬────────┘   └───────┬────────────────┘
       │                  │  writes to CODEX_DB       ▲
       │                  ▼                           │
       │           ┌──────────────┐                   │
       │           │ frontier-db- │◀──────────────────┘ (DO projects cells)
       │           │ v2 + codex-  │
       │           │ db (D1)      │
       │           └──────────────┘
       │
       └── WSS ──▶ codex-sync-worker /parties/file-sync/{docId}
```

Three services, two D1 databases, one R2 bucket. Everything lives in the
same Cloudflare account so cross-service calls stay on-network.

## The three services

| service                | where                                  | role                                                      |
|------------------------|----------------------------------------|-----------------------------------------------------------|
| **codex-web-app**      | this repo (`src/`)                     | React app. Holds Y.Docs + IndexedDB. Fetches sync tokens. |
| **codex-sync-worker**  | this repo (`sync-worker/`)             | Cloudflare Worker hosting one Durable Object per file.    |
| **frontier-server**    | `~/frontierrnd/frontier-server/cloudflare/` | Identity + project + sync-token minting.             |

Share links go through frontier-server's `POST /api/v2/projects/:id/invites`
(create) and `POST /api/v2/projects/accept-invite` (redeem). Redemption adds
the caller to `project_members`, after which the normal sync-token + sync-
worker path unlocks for them. There is no separate signaling relay.

## The flow (single-user, single-file)

1. User opens a project + file in the browser.
2. `useFileSync` mounts, reads `activeShareToken` (or `null`), constructs a
   `docId = "{projectId}--{fileId}"`.
3. `makeSyncTokenFetcher` is built with the user's Frontier JWT. It's
   passed to `y-partyserver/provider` as the `params` callback, so on
   every WS (re)connect it fetches a short-lived JWT from
   `POST /api/v2/sync-token`.
4. Frontier-server validates the Frontier JWT via `authMiddleware`, looks
   up the caller's role on the project (D1 override → implicit creator →
   GitLab fallback), auto-registers the project if it's unknown, then
   mints a 15-min HS256 JWT signed with `SYNC_SECRET_KEY` carrying
   `{userId, projectId, fileId, role, aud: "sync"}`.
5. Client's YProvider opens a WS to `wss://codex-sync-worker.*.workers.dev/parties/file-sync/{docId}?token=<jwt>`.
6. Sync-worker's `onBeforeConnect` strips any client-supplied role header,
   verifies the JWT, and attaches `X-Codex-Role: <level>` on the request
   passed into the DO.
7. The DO's `onConnect` reads the trusted header and stashes role on the
   connection via `connection.setState({ role })`. `isReadOnly` uses this
   for write-gating — viewer/commenter/reviewer connections receive
   broadcasts but have their Y.Doc updates silently dropped.
8. Yjs sync protocol runs. The DO holds the Y.Doc in memory; `onLoad`
   built it from `projects/{pid}/files/{fid}/snapshot.bin` + any
   `tail/*.bin` objects on first connect.
9. Every edit debounces (2s / max 10s) into `onSave`, which writes
   `tail/{16-digit-ms}.bin` to R2 and then upserts changed cells +
   file rollup to `codex-db` using a per-cell fingerprint dedup.
10. When all clients disconnect for 60s, an alarm fires and the DO
    compacts: merges snapshot + tails via `Y.mergeUpdates`, writes a new
    `snapshot.bin`, deletes tails. Same compaction also fires in the
    background during active sessions once tail count crosses 50.
11. Hidden tab > 5 min → client `provider.disconnect()` lets the DO
    hibernate. Visible again → `provider.connect()` resumes.

## Security model

- **`SECRET_KEY`** (frontier-server) signs Frontier access tokens. Never
  leaves frontier-server.
- **`SYNC_SECRET_KEY`** (shared between frontier-server + codex-sync-worker)
  signs sync tokens + authenticates the admin R2-cleanup endpoint on
  sync-worker. A sync-worker compromise cannot forge Frontier access
  tokens. Never committed; set via `wrangler secret put` on both workers.
- **Role on a connection** is only trusted when we set `X-Codex-Role`
  ourselves from verified JWT claims. Client-supplied headers of that
  name are stripped first.
- **sync-token JWTs intentionally omit `sub`** so they can't pass
  authMiddleware if replayed against frontier-server. `aud: "sync"` check
  belt-and-suspenders.

## D1 schema

Two databases, both owned by frontier-server's migrations.

**`frontier-db-v2`** (identity + permissions):
- `users`, `organizations`, `email_lookup` — pre-existing
- `roles` — numeric ladder (100 viewer → 700 owner, 100-step gaps)
- `projects` — codex-backed projects, FK to users + orgs
- `project_members` — role override per user per project; absence falls
  back to GitLab permission check
- `project_invites` — shareable invite tokens with role + expiry

**`codex-db`** (codex CQRS read model):
- `files` — per-file rollup (cell_count, approved_count, word_count)
- `cells` — per-cell projection (plain text for search, validated flag,
  word count, last editor, last_edit_at guard)
- `cells_fts` — FTS5 virtual table, kept in sync by triggers
- `checkpoints` — named snapshots for recovery

## R2 layout

```
projects/{projectId}/files/{fileId}/
├── snapshot.bin                 # last compacted state
├── tail/
│   ├── 0001776742597623.bin     # 16-digit ms since epoch, lex-sortable
│   └── …
└── checkpoints/
    ├── {checkpoint-id}.bin
    └── …
```

Idempotency: `onLoad` applies snapshot then each tail in order. An update
already in the snapshot is a no-op when reapplied, so compaction is
crash-safe (snapshot is written before tails are deleted).

## Status indicator

`SyncStatusIndicator` in the workspace bar. 5 states derived from the
provider's `wsconnected` + the hook's idle flag:

- **live** (green) — WS connected + initial sync done
- **connecting** (amber) — handshake in progress or reconnect backoff
- **offline** (red) — reserved for explicit hard-offline detection
- **idle** (grey, "Paused") — intentionally disconnected while hidden tab
- **disabled** (grey, "Local only") — no session / no project / disabled

## Running locally

Three terminals:

```sh
# 1. sync-worker (port 8787)
cd sync-worker
cp .dev.vars.example .dev.vars       # first time only
npx wrangler dev --port 8787

# 2. frontier-server (port varies; default 8788 when both run)
cd ~/frontierrnd/frontier-server
npm --prefix cloudflare run dev

# 3. codex-web-app (port 1420)
npm run dev
```

Env knobs for the client:
- `VITE_SYNC_WORKER_HOST` — defaults to `127.0.0.1:8787` in dev,
  `codex-sync-worker.blue-darkness-7674.workers.dev` in prod builds.
- `VITE_FRONTIER_API_URL` — defaults to `https://api.frontierrnd.com`.

## Tests

- **`src/lib/sync/y-partyserver-spike.test.ts`** — round-trip assertions
  against a running `wrangler dev`. Skips cleanly when unreachable.
- **`sync-worker/src/__tests__/*.test.ts`** — pure unit tests for auth
  verification, role gating, compaction invariants, projection extraction,
  projection dedup, admin endpoint.
- **`src/lib/sync/*.test.ts`** — client-side unit tests for token
  fetching, file-projection fetch, invite fetch.
- **`~/frontierrnd/frontier-server/cloudflare/src/tests/*`** — handler
  tests for `/sync-token`, `/projects/:id/files/:id`, `/projects/:id/invites`,
  `/projects/accept-invite`.

## Open follow-ups

- Orphan R2 blobs from failed admin-cleanup calls. A periodic sweeper is
  the right home; currently relies on the inline call succeeding.
- Playwright end-to-end test that spins the full stack and drives the UI.
