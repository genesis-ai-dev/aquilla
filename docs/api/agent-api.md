# Aquilla Agent API — practitioner guide

Status: **implemented surface, v1** · 2026-07-13 · matches code in `sync-worker/src/external/*`
and `auth-worker/src/routes/{credentials,changeset-approvals}.ts`. Design rationale and vocabulary
live in [`docs/AGENT-API.md`](../AGENT-API.md) (AQU-533) — this document describes what is
actually implemented and callable today. Where the two disagree, this document is right; call
those spots out explicitly rather than paper over them.

A worked, copy-pasteable example lives in
[`docs/api/examples/blackfoot-import.md`](examples/blackfoot-import.md). A minimal OpenAPI 3.1
description of the REST surface lives in [`docs/api/openapi.yaml`](openapi.yaml).

## Hosts

Two Workers, two hosts. Which one you call depends on the operation — **hosts differ per
environment**, so treat the values below as the production shape and substitute your
environment's actual host.

| Surface | Worker | Production host (prefix stripped before routing) |
| --- | --- | --- |
| Credentials, changeset approval (human browser flow) | `aquilla-identity` (auth-worker) | `https://api.aquilla.app/identity` |
| MCP, artifacts, changesets (agent flow), reads | `aquilla-sync-worker` (sync-worker) | `https://api.aquilla.app/sync` |

In local dev these are typically `http://127.0.0.1:8788` (identity) and
`http://127.0.0.1:8787` or `http://127.0.0.1:8789` (sync) — see `.env.example`
(`VITE_AUTH_BASE`, `VITE_SYNC_WORKER_HOST`) and `pnpm dev`'s stack. Every example below uses
placeholder hosts `$IDENTITY_HOST` and `$SYNC_HOST`; set them to match your target environment.

All external endpoints return the same JSON error envelope regardless of host — see
[Error contract](#error-contract) below.

## 1. Minting a credential

Credentials (personal access tokens, prefix `aqk_`) are minted on the **identity** host.

```
POST $IDENTITY_HOST/api/v2/credentials
Authorization: Bearer <your Aquilla session JWT>
Content-Type: application/json

{
  "name": "blackfoot-import-bot",
  "mode": "act",                          // "ask" | "act"
  "projectId": "proj_abc123",             // or "orgId"; omit both for an unscoped credential
  "expiresAt": "2026-12-31T00:00:00Z"     // optional ISO-8601, must be in the future
}
```

Response (`201`):

```json
{
  "token": "aqk_9f2a...redacted...",
  "credential": {
    "id": "5b6...",
    "name": "blackfoot-import-bot",
    "mode": "act",
    "orgId": null,
    "projectId": "proj_abc123",
    "tokenPrefix": "aqk_9f2a3b1c",
    "createdAt": "2026-07-13T00:00:00.000Z",
    "expiresAt": "2026-12-31T00:00:00.000Z",
    "lastUsedAt": null,
    "revokedAt": null
  }
}
```

**The token is shown exactly once, in this response.** It is never stored in retrievable
form — only its SHA-256 hash (`api_credentials.token_hash`) is persisted, and `GET
/api/v2/credentials` never returns hashes or plaintext, only `tokenPrefix` (first 12 chars,
including the `aqk_` tag) for display. If you lose the token, revoke the credential and mint a
new one.

### Ask vs act semantics

| Mode | Can prepare a changeset | Can commit a changeset |
| --- | --- | --- |
| `ask` | yes | **no** — commit returns `confirmation_required` until a human approves via the browser (§3 below) |
| `act` | yes | yes, immediately, auto-confirmed |

The credential's mode is a **ceiling**, not a default: a `prepare` request may pass
`autonomyMode: "ask"` to downgrade an `act` credential for one changeset, but nothing can
upgrade an `ask` credential to `act` (`sync-worker/src/external/prepare.ts`: `autonomyMode =
requested === 'ask' || cred.mode === 'ask' ? 'ask' : 'act'`).

### Scoping rules (enforced at mint time, `auth-worker/src/routes/credentials.ts`)

- A credential may be scoped to a **project** (`projectId`), an **org** (`orgId`), or neither
  (unscoped — usable against any project/org the user can reach). You cannot supply both.
- Scoping to a project or org requires the minting user to hold **≥ CONTRIBUTOR (400)** on it
  at mint time (live-resolved), else `403 scope_denied`.
- **`act`-mode credentials must be scoped** (project or org) and require **≥ MAINTAINER (600)**
  on that scope, else `403 scope_denied`. There is no unscoped act-mode credential.
- **Live re-resolution on every call**: the credential only carries a scope and an autonomy
  ceiling — it does **not** cache a role. Every external request re-resolves the calling user's
  *current* project role (`resolveProjectRoleShared`) and gates the operation against that,
  exactly like the in-app path. A credential from a user later demoted or removed from a
  project loses access immediately, without revoking the token itself.

### Listing and revoking

```
GET    $IDENTITY_HOST/api/v2/credentials             # list your credentials (no hashes/tokens)
DELETE $IDENTITY_HOST/api/v2/credentials/:id          # revoke — owner or platform admin, idempotent
```

Revocation sets `revoked_at` (idempotent — repeat calls keep the original timestamp via
`COALESCE`). A revoked credential fails `validateApiCredential` on every subsequent call.

## 2. Connecting an MCP client

The MCP endpoint is a single stateless JSON-RPC 2.0 route on the **sync** host:

```
POST $SYNC_HOST/api/v1/external/mcp
GET  $SYNC_HOST/api/v1/external/mcp    # 405 — tools-only, no SSE stream
```

There is no session handshake or connector-directory listing (OAuth 2.1 is deferred, D12 in
`docs/AGENT-API.md`) — auth is the same `aqk_` bearer token re-validated on **every** JSON-RPC
call (`sync-worker/src/external/mcp-route.ts`). A missing/invalid/revoked/expired credential is
an HTTP 401 with the standard error envelope, before any JSON-RPC method runs.

### Claude Code

```bash
claude mcp add aquilla --transport http \
  https://api.aquilla.app/sync/api/v1/external/mcp \
  --header "Authorization: Bearer $AQUILLA_TOKEN"
```

### `.mcp.json` (works with any MCP client that supports streamable HTTP)

```json
{
  "mcpServers": {
    "aquilla": {
      "type": "http",
      "url": "https://api.aquilla.app/sync/api/v1/external/mcp",
      "headers": {
        "Authorization": "Bearer aqk_your_token_here"
      }
    }
  }
}
```

This is a plain streamable-HTTP MCP server with a fixed tool catalog — it works with any MCP
host that speaks JSON-RPC 2.0 over HTTP with bearer auth (Claude Code, Codex, Cursor, or a
hand-rolled client), not just Claude products.

### Tool catalog (`tools/list`, from `sync-worker/src/external/mcp-tools.ts`)

| Tool | Purpose |
| --- | --- |
| `get_capabilities` | API version, credential mode, command kinds, limits, error codes, ask-mode flow explanation. Call this first. |
| `get_identity_and_scope` | Who you are (userId, username), your mode, org/project scope, credentialId. |
| `list_projects` | Up to 100 accessible, non-archived projects. |
| `get_project` | One project by id (requires ≥ VIEWER). |
| `search_project` | Full-text search over source/target cells. |
| `read_content` | List a project's files, or read one file's cells (with `since`/`limit`/`cursor`). |
| `read_history` | Append-only event history for one cell. |
| `prepare_translations` | Stage a `SetTranslation` batch as a changeset (see §3). |
| `get_changeset` | Fetch a changeset's status/summary/digest/receipt/approvalUrl. |
| `confirm_changeset` | Commit a prepared changeset (ask or act). |
| `discard_changeset` | Discard a staged/stale/expired changeset. |

There is **no MCP tool for artifacts or `PlanImport`** yet — uploading an artifact and staging
an import changeset are REST-only in v1 (§4 below); an MCP-based agent must shell out to REST
for those two steps, or a REST-capable host must do them on its behalf. `create_project` /
`update_project`, `run_checks`, jobs, and export tools from the design doc's §4 table are **not
yet available** at all (no command layer support). See `docs/swarm/AGENT-API-TRACES.md` for the
open list.

## 3. The ask-mode loop, narrated agent-side

This is the actual sequence an ask-mode credential must follow — enforced server-side, not just
documented convention.

1. **Prepare.** `prepare_translations` (MCP) or `POST .../changesets` (REST) stages an
   immutable plan. The response always includes a server-computed `summary` (never
   agent-narrated) and a `digest` (SHA-256 over the canonicalized commands + preconditions).
   For an `ask`-mode credential (or a request that explicitly downgrades to `ask`), the response
   also includes an `approvalUrl` of the form `{BASE_URL}/approve/{changesetId}`.
2. **Surface the approvalUrl to a human.** The agent cannot fabricate approval — it must show
   this URL to the human it's acting on behalf of (chat message, terminal output, whatever the
   host supports).
3. **Human approves at `/approve/:id`.** This is a page in the Aquilla SPA
   (`src/pages/ApproveChangeset/ApproveChangeset.tsx`), gated behind a normal Aquilla **browser
   session** (not the API credential). It calls the **identity** host:
   - `GET $IDENTITY_HOST/api/v2/changesets/:id/approval` — loads the changeset (only the human
     who owns the credential that staged it may view/approve/reject: `created_by_user_id ===
     session.user.id`).
   - `POST $IDENTITY_HOST/api/v2/changesets/:id/approve` with `{ "digest": "<from the GET>" }` —
     the page always uses the digest it just fetched, never one embedded in the URL, so what's
     approved is provably what the server staged. Mints a one-time `changeset_confirmations` row
     with a **15-minute TTL** (`CONFIRMATION_TTL_MS` in `auth-worker/src/routes/changeset-
     approvals.ts`). Idempotent: a second approve within the TTL returns the existing
     unconsumed confirmation rather than minting a duplicate.
   - `POST $IDENTITY_HOST/api/v2/changesets/:id/reject` — discards the changeset (irreversible;
     status becomes `discarded`).
4. **Confirm.** The agent calls `confirm_changeset` (MCP) or `POST .../changesets/:id/commit`
   (REST) again. `sync-worker/src/external/commit.ts` atomically consumes the confirmation
   (`UPDATE changeset_confirmations SET consumed_at = now() WHERE ... consumed_at IS NULL AND
   expires_at > now() RETURNING id`) — if no valid, unconsumed confirmation exists, the response
   is `428 confirmation_required` and **nothing is applied**. On success, the commit proceeds
   through the same pipeline `act` mode uses and returns the execution **receipt**.

Act-mode credentials skip steps 2–3 entirely: `confirm_changeset` / `POST .../commit` applies
immediately.

Polling: an agent may call `get_changeset` between steps 2 and 4 to observe `status` transition
from `staged` to `committed` once a human has approved *and* the agent has re-called confirm —
approval alone does not commit; the agent's own confirm call is still required.

## 4. REST endpoint reference

All paths below are relative to `$SYNC_HOST` unless marked **(identity)**, which is relative to
`$IDENTITY_HOST`. Auth column: `session` = browser-session JWT (`authMiddleware`); `aqk_` = API
credential bearer token (`validateApiCredential`). "Min role" is the live-resolved project role
required, using `ROLE` from `sync-worker/src/events/role-policy.ts` (VIEWER=100,
CONTRIBUTOR=400, PROJECT_LEAD=500, MAINTAINER=600).

| Method & path | Auth | Min role | Notes |
| --- | --- | --- | --- |
| `POST /api/v2/credentials` **(identity)** | session | — (≥ CONTRIBUTOR on requested scope; ≥ MAINTAINER for `act`) | Mint a credential. Returns token once. |
| `GET /api/v2/credentials` **(identity)** | session | — | List caller's credentials. |
| `DELETE /api/v2/credentials/:id` **(identity)** | session | — | Owner or platform admin. Idempotent. |
| `GET /api/v2/changesets/:id/approval` **(identity)** | session | — (must be `created_by_user_id`) | Load changeset for approval UI. |
| `POST /api/v2/changesets/:id/approve` **(identity)** | session | — | Body `{ digest }`. Mints one-time confirmation. |
| `POST /api/v2/changesets/:id/reject` **(identity)** | session | — | Discards the changeset. |
| `POST /api/v1/external/mcp` | `aqk_` | per-tool | JSON-RPC 2.0 (`initialize`, `ping`, `tools/list`, `tools/call`). |
| `GET /api/v1/external/projects/:projectId/search?q=&side=&limit=&cursor=` | `aqk_` | VIEWER | Full-text search. `{ data, nextCursor }`. |
| `GET /api/v1/external/projects/:projectId/files?limit=&cursor=` | `aqk_` | VIEWER | List files. |
| `GET /api/v1/external/projects/:projectId/files/:fileId/cells?since=&limit=&cursor=` | `aqk_` | VIEWER | Read a file's cells; supports delta reads via `since`. |
| `GET /api/v1/external/projects/:projectId/cells/:cellId/history?limit=&cursor=` | `aqk_` | VIEWER | Append-only event history for one cell (not fileId-scoped, unlike the internal route). |
| `POST /api/v1/external/projects/:projectId/artifacts` | `aqk_` | CONTRIBUTOR | Body = raw bytes; headers `x-artifact-name` (required), `content-type`. Returns `{ artifactId, sha256, sizeBytes }`. Max 25MB. |
| `GET /api/v1/external/projects/:projectId/artifacts/:artifactId` | `aqk_` | VIEWER | Metadata. |
| `GET /api/v1/external/projects/:projectId/artifacts/:artifactId/content` | `aqk_` | VIEWER | Raw bytes. |
| `GET /api/v1/external/projects/:projectId/artifacts/:artifactId/inspect` | `aqk_` | VIEWER | Lightweight format sniff (first 64KB): `usfm`, `xliff`, `tmx`, `json`, `csv`, `tsv`, `plaintext`. |
| `POST /api/v1/external/projects/:projectId/changesets` | `aqk_` | CONTRIBUTOR (SetTranslation) / PROJECT_LEAD (PlanImport, enforced at commit) | Prepare (stage) a changeset. Body `{ commands: [...], id?, autonomyMode? }`. |
| `GET /api/v1/external/projects/:projectId/changesets/:id` | `aqk_` | — (must be the staging credential) | Fetch status/summary/digest/receipt + `approvalUrl`. |
| `POST /api/v1/external/projects/:projectId/changesets/:id/commit` | `aqk_` | — (must be the staging credential) | Commit (ask requires a consumed confirmation; act auto-confirms). Idempotent on `committed`. |
| `POST /api/v1/external/projects/:projectId/changesets/:id/discard` | `aqk_` | — (must be the staging credential) | Discard a staged/stale/expired changeset. Cannot discard `committed`. |

Notes on commands:
- **`SetTranslation`** (`{ kind: "SetTranslation", fileId, cellId, value, valueHtml? }`) compiles
  to `target.cell.commit`, requires **CONTRIBUTOR** at commit time (routed through the same
  `/events` perimeter as in-app writes).
- **`PlanImport`** (`{ kind: "PlanImport", fileName, fileType, sourceLanguage?, targetLanguage?,
  artifactId?, cells: [{ id?, content, canonicalRef?, section?, type? }] }`) compiles to one
  `file.create` + N `source.cell.create` events and requires **PROJECT_LEAD (500)** — a
  contributor-scoped credential gets `403 permission_denied` at commit, even though prepare
  succeeds (permission is enforced by the same `/events` perimeter Wave-1 uses, not re-derived).
  A `PlanImport` must be the **sole command** in its changeset. Capped at **5,000 cells**
  (`PLAN_IMPORT_MAX_CELLS`); above that, `validation_failed`.
- Currently **not implemented**: `CreateProject`, `UpdateProjectSettings`, `LinkMedia` from the
  design doc's command set. No REST endpoint creates projects, updates settings, or links media.

## 5. Error contract

Every external endpoint (identity's `/api/v2/credentials`, `/api/v2/changesets/*`, and every
`/api/v1/external/*` route on sync) returns errors as:

```json
{ "error": { "code": "plan_stale", "message": "human-readable", "details": { "...": "optional" } } }
```

(`sync-worker/src/external/errors.ts` is the canonical owner; `auth-worker`'s changeset-approval
routes mirror the same shape and codes by convention.)

| Code | HTTP status | Meaning | Agent's correct reaction |
| --- | --- | --- | --- |
| `permission_denied` | 403 | Credential invalid/revoked/expired, or the live-resolved role is below the operation's minimum. | Don't retry with the same credential. Surface to the human — they may need a higher role or a new credential. |
| `scope_denied` | 403 | The credential's org/project scope doesn't cover the target resource. | Don't retry. Mint or use a credential scoped correctly. |
| `plan_stale` | 409 | Project state changed since `prepare` (a precondition drifted), or a `confirm_changeset` digest doesn't match the stored plan. | Re-`prepare` a fresh changeset against current state; do not blindly retry `commit`. |
| `confirmation_required` | 428 | Ask-mode changeset has no valid, unconsumed human approval. | Surface the `approvalUrl` (present in the error's `details` from MCP; re-fetch `get_changeset` for REST) to a human; only call commit again after they approve. |
| `validation_failed` | 400 | Malformed request, bad command shape, oversize artifact, expired changeset, wrong changeset status for the action, etc. | Fix the request per `details`/`message`; do not retry unchanged. |
| `job_failed` | 500 | Unexpected server-side failure (misconfiguration, unhandled exception, partial apply on `PlanImport`). | Safe to retry once; if it persists, treat as a bug — check `details.receipt` for a `PlanImport` partial-apply accounting. |
| `rate_limited` | 429 | Reserved in the error contract; **not currently enforced anywhere in code** — no rate limiter exists in v1. | N/A today; documented for forward compatibility. |
| `not_found` | 404 | Resource (changeset, artifact, project, credential) doesn't exist or isn't visible to this credential. | Don't retry with the same id. |

MCP tool errors use the identical code set inside the tool result (`isError: true`, JSON text
body `{ error: { code, message, details? } }`) — an agent can branch on `code` the same way
across both adapters (`sync-worker/src/external/mcp-handlers.ts`).

## 6. Provenance

Every event **applied through a changeset commit** (both `SetTranslation` and `PlanImport`
paths, `sync-worker/src/external/commit.ts`) is stamped with a provenance envelope written to
`events.provenance` (JSONB) *after* the event is accepted by the `/events` perimeter:

```json
{
  "origin": "agent",
  "human_authority": { "user_id": "...", "credential_id": "..." },
  "agent": null,
  "channel": "rest",
  "autonomy_mode": "ask",
  "changeset_id": "...",
  "confirmation_id": "..."
}
```

| Field | Source | Verified? |
| --- | --- | --- |
| `origin` | Always `"agent"` for changeset-committed events. | Verified (server-set constant). |
| `human_authority.user_id`, `.credential_id` | The changeset's `created_by_user_id` / `credential_id`, resolved from the credential that staged it. | Verified. |
| `channel` | Always `"rest"` today — both the REST commit route and the MCP `confirm_changeset` tool delegate to the same commit handler, which hardcodes `channel: 'rest'`. **Note:** the design doc's envelope sketch implies `channel` should distinguish `"mcp"` vs `"rest"`; the implementation does not yet make that distinction — call this out as a spec/implementation gap. | Verified but not currently MCP-aware. |
| `autonomy_mode` | The changeset's stored `autonomy_mode` (`ask`\|`act`). | Verified. |
| `changeset_id` | The committing changeset's id. | Verified. |
| `confirmation_id` | Present only when an ask-mode confirmation was consumed to commit. | Verified. |
| `agent` | Parsed from the caller-supplied `x-agent-meta` request header (JSON), or `null` if absent/invalid. Never validated against a real provider/model. | **Caller-declared, not verified** — recorded as testimony only. |

Non-event operations (artifact upload, credential mint/revoke) are **not** covered by the
provenance envelope at all — there is no separate audit-ledger table in the current schema
(`agent_runs`/`agent_sessions` exist in `db/postgres/schema.sql` but are not wired to the
external API's writes as of this wave). The design doc's §2 "audit ledger for reads/searches/
discarded plans" is **not yet implemented** — treat it as aspirational, not shipped.

## 7. Limits

| Limit | Value | Source |
| --- | --- | --- |
| Max artifact upload size | 25 MB | `MAX_ARTIFACT_BYTES`, `sync-worker/src/external/artifacts-route.ts` |
| Max cells per `PlanImport` | 5,000 | `PLAN_IMPORT_MAX_CELLS`, `sync-worker/src/external/commands.ts` |
| Changeset TTL (staged → auto-expires) | 1 hour | `CHANGESET_TTL_MS`, `sync-worker/src/external/prepare.ts` |
| Ask-mode confirmation TTL | 15 minutes | `CONFIRMATION_TTL_MS`, `auth-worker/src/routes/changeset-approvals.ts` |
| Internal sync-token lifetime (implementation detail, not caller-facing) | 300 seconds | `INTERNAL_TOKEN_TTL_SECONDS`, `sync-worker/src/external/token-bridge.ts` |
| Max commands per `SetTranslation` changeset | none enforced | `validateCommands` has no hard cap; `get_capabilities.limits.maxCommandsPerChangeset` reports `null` for this reason |
| `PlanImport` commit chunk size to the `/events` perimeter | 100 events/POST | `PLAN_IMPORT_CHUNK`, `sync-worker/src/external/commit.ts` (implementation detail — large imports are chunked internally, not something a caller sets) |
| Artifact inspect sniff window | 64 KB | `INSPECT_SNIFF_BYTES`, `sync-worker/src/external/artifacts-route.ts` |
| Cell history page cap | 200 rows | `HISTORY_MAX_LIMIT`, `sync-worker/src/external/read-routes.ts` |
| Rate limiting | **not implemented** | `rate_limited` is a reserved error code with no enforcement in code today |

## 8. What's not yet available

Documented explicitly so you don't go looking for it:

- **`run_checks`** (rules/health verification tool) — no MCP tool, no REST endpoint, no command.
- **Jobs** (`get_job`) — imports/commits are synchronous within a single HTTP request; there is
  no async job queue, polling endpoint, or job id in any response.
- **Export** (`prepare_export`, `get_export`) — not implemented.
- **`CreateProject` / `UpdateProjectSettings` / `LinkMedia`** commands — not implemented; no way
  to create a project or attach media via this API yet.
- **OAuth 2.1 / MCP connector-directory listing** — auth is PAT-only (`aqk_` bearer).
- **Presigned upload/download URLs** — artifact bytes are worker-proxied (streamed through the
  Worker), not signed-URL, despite the design doc's D10 decision to use signed URLs.
- **Server-side import parsing** (`preview_import`) — `PlanImport` requires already-parsed
  `cells[]`; the server only sniffs format on `/inspect`, it does not parse USFM/XLIFF/JSON into
  cells.
- **Rate limiting** — the `rate_limited` error code exists in the contract but nothing enforces it.
- **Manifest-in-R2 for large imports** — large `PlanImport`s must be split into ≤5,000-cell
  changesets; there is no digest-referenced manifest object.

See `docs/swarm/AGENT-API-TRACES.md` for the full, evolving list of open implementation gaps.
