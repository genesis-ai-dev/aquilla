# Aquilla Agent API — practitioner guide

Status: **implemented surface, v1.1** · 2026-07-17 · matches code in `sync-worker/src/external/*`,
`auth-worker/src/routes/{credentials,changeset-approvals}.ts`, and `db/shared/projects.ts`. Design
rationale and vocabulary live in [`docs/AGENT-API.md`](../AGENT-API.md) (AQU-533) and
[`docs/superpowers/specs/2026-07-17-agent-api-v1.1-design.md`](../superpowers/specs/2026-07-17-agent-api-v1.1-design.md)
— this document describes what is actually implemented and callable today. Where the two disagree,
this document is right; call those spots out explicitly rather than paper over them.

**Pointing an agent at this API? Hand it [`QUICKSTART.md`](QUICKSTART.md)** — a single
compact page with the conceptual model and the curl-able golden path. The API also
self-describes at runtime: `GET $SYNC_HOST/api/v1/external` (unauthenticated) returns a
machine-readable map of endpoints, auth, quickstart, and error codes, and every unmatched
`/api/v1/external/*` path returns a JSON 404 pointing back at it.

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

`name` is **required** (`z.string().min(1).max(200)` in `auth-worker/src/routes/credentials.ts`) —
a mint request with an empty/missing name is `400 validation_failed` (surfaced by the framework's
schema validator, not a hand-written check). Use it to tell credentials apart in the list view;
it is never shown back to anyone but the minting user.

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
GET  $SYNC_HOST/api/v1/external/mcp    # 405 (JSON body explains how to connect) — tools-only, no SSE stream
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
| `prepare_translations` | Stage a changeset (see §3): a `SetTranslation` batch via `translations`, and/or `CreateProject` / `UpdateProjectSettings` / `LinkMedia` commands via `commands` (Agent API v1.1 — §4.1 below). |
| `get_changeset` | Fetch a changeset's status/summary/digest/receipt/approvalUrl. |
| `confirm_changeset` | Commit a prepared changeset (ask or act). |
| `discard_changeset` | Discard a staged/stale/expired changeset. |

`prepare_translations` is the generic propose step and `confirm_changeset` the generic commit
step for every MCP-stageable command kind — they are not SetTranslation-specific despite the
tool's name (kept for backward compatibility). `get_capabilities` publishes the full, current
list of `commandKinds` and per-kind staging notes (`projectLifecycle`, `linkMedia`) — call it
first rather than trusting a stale copy of this table.

There is **no MCP tool for artifact upload or `PlanImport`** — uploading an artifact (source or
audio) and staging an import changeset are REST-only (§4 below); an MCP-based agent must shell
out to REST for those two steps, or a REST-capable host must do them on its behalf.
`run_checks`, jobs, and export tools from the design doc's §4 table are **not yet available** at
all (no command layer support). See `docs/swarm/AGENT-API-TRACES.md` for the open list.

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
approval alone does not commit; the agent's own confirm call is still required. A changeset may
also transiently read `committing` — the mid-apply state a commit sets before flipping to
`committed` (§4.1 "commit idempotency" below); treat it the same as `staged` and poll again.

**`CreateProject` is ask-mode only, by construction.** `prepare` **forces every `CreateProject`
changeset to ask-mode**, whatever the credential's or request's mode — an org-scoped `act`
credential (which the mint endpoint still permits, for its *other* commands) does not commit a
project unattended; its `CreateProject` changeset is staged ask-mode all the same and still
requires human approval. (A project-scoped credential can never `CreateProject` at all —
`403 scope_denied` at prepare.) Every agent-initiated project creation therefore passes through
human approval at `/approve/:id`. This is intentional, not a gap: project creation is the one
operation this API deliberately keeps a human in the loop for, enforced in code rather than left
to the mint dialog's UX.

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
| `GET /api/v1/external` | none | — | Unauthenticated discovery root: machine-readable API map (endpoints, auth, quickstart, MCP config, error codes). |
| `GET /api/v1/external/me` | `aqk_` | — | Cold-start bootstrap: identity, mode (ask\|act), scope, next-step hints. |
| `GET /api/v1/external/projects` | `aqk_` | — | List up to 100 accessible projects (REST mirror of the MCP `list_projects` tool, same shared query). `{ data, nextCursor }`. |
| `POST /api/v1/external/mcp` | `aqk_` | per-tool | JSON-RPC 2.0 (`initialize`, `ping`, `tools/list`, `tools/call`). GET returns a JSON 405 explaining how to connect. |
| `GET /api/v1/external/projects/:projectId/search?q=&side=&limit=&cursor=` | `aqk_` | VIEWER | Full-text search. `{ data, nextCursor }`. |
| `GET /api/v1/external/projects/:projectId/files?limit=&cursor=` | `aqk_` | VIEWER | List files. |
| `GET /api/v1/external/projects/:projectId/files/:fileId/cells?since=&limit=&cursor=` | `aqk_` | VIEWER | Read a file's cells; supports delta reads via `since`. |
| `GET /api/v1/external/projects/:projectId/cells/:cellId/history?limit=&cursor=` | `aqk_` | VIEWER | Append-only event history for one cell (not fileId-scoped, unlike the internal route). |
| `POST /api/v1/external/projects/:projectId/artifacts` | `aqk_` | CONTRIBUTOR | Body = raw bytes; headers `x-artifact-name` (required), `content-type`, `x-artifact-kind` (`source` default, or `audio` — §4.1). Returns `{ artifactId, sha256, sizeBytes }`. Max 25MB. |
| `GET /api/v1/external/projects/:projectId/artifacts/:artifactId` | `aqk_` | VIEWER | Metadata. |
| `GET /api/v1/external/projects/:projectId/artifacts/:artifactId/content` | `aqk_` | VIEWER | Raw bytes. |
| `GET /api/v1/external/projects/:projectId/artifacts/:artifactId/inspect` | `aqk_` | VIEWER | Lightweight format sniff (first 64KB): `usfm`, `xliff`, `tmx`, `json`, `csv`, `tsv`, `plaintext`. Audio artifacts return size + content type only — no duration/waveform sniffing. |
| `POST /api/v1/external/projects/:projectId/changesets` | `aqk_` | Per command kind — see §4.1 | Prepare (stage) a changeset. Body `{ commands: [...], id?, autonomyMode? }`. |
| `GET /api/v1/external/projects/:projectId/changesets/:id` | `aqk_` | — (must be the staging credential) | Fetch status/summary/digest/receipt + `approvalUrl`. |
| `POST /api/v1/external/projects/:projectId/changesets/:id/commit` | `aqk_` | — (must be the staging credential) | Commit (ask requires a consumed confirmation; act auto-confirms). Idempotent on `committed` **and safe to retry from `committing`** (§4.1). |
| `POST /api/v1/external/projects/:projectId/changesets/:id/discard` | `aqk_` | — (must be the staging credential) | Discard a staged/stale/expired changeset. Cannot discard `committed` **or `committing`** (a mid-apply plan must not be stranded). |

### 4.1 Commands, audio artifacts, and commit idempotency

Every command below shares the one `POST .../changesets` → `.../commit` pipeline. `SetTranslation`
and `PlanImport` are unchanged from v1; `CreateProject`, `UpdateProjectSettings`, and `LinkMedia`
are new in v1.1 (`sync-worker/src/external/{commands,prepare,commit}.ts`).

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
- **`CreateProject`** (`{ kind: "CreateProject", name, projectId?, orgId? }`) — **receipt-only**:
  applies a plain row write via `db/shared/projects.ts` (creates the `projects` row plus an owner
  (700) `project_members` row for the caller), not an event. Must be the **sole command** in its
  changeset. `projectId` is optional; when omitted, the **definitive** new project id is the
  changeset's URL project id (the `:projectId` segment of `POST .../projects/:projectId/
  changesets` — yes, even though that project doesn't exist yet). Either way the definitive id is
  pinned into the plan at prepare time, so a crash-and-retry commit re-applies the same id rather
  than minting a new one. **Scope/role gate:** the credential must be unscoped or org-scoped to
  the target org (a project-scoped credential is `403 scope_denied` — it can never create a
  project); the caller needs **org role ≥ MAINTAINER** in the target org (checked at the org level
  — there is no project yet to resolve a project role against). A personal (org-less) project
  needs no org-role check at all. If the chosen project id is claimed by another caller between
  prepare and commit, commit returns **`409 conflict`** (not `plan_stale` — this is a genuine
  race, distinguished from the credential's own crash-retry, which is idempotent success).
- **`UpdateProjectSettings`** (`{ kind: "UpdateProjectSettings", projectId, settings,
  ifMatchVersion }`) — **receipt-only**: applies a version-guarded write via the same shared
  module auth-worker's internal settings route uses (first-write insert vs `version + 1` update;
  a validation-threshold change re-runs the `cells.validated` / `files.approved_count` projection
  fan-out locally). Must be the **sole command** in its changeset. Requires **project role ≥
  MAINTAINER**. `ifMatchVersion` must equal the live settings version both at prepare and at
  commit — a mismatch at either point is `409 plan_stale` (re-fetch the current version and
  re-prepare, don't blindly retry commit).
- **`LinkMedia`** (`{ kind: "LinkMedia", fileId, cellId, artifactId }`) — **event-native**:
  compiles to `cell.audio.attach` + `cell.audio.select`, requires **CONTRIBUTOR** at commit time
  (same perimeter as SetTranslation). `artifactId` must reference an `audio`-kind artifact already
  uploaded to the same project (see the audio-upload paragraph below) — a missing, wrong-kind, or
  cross-project artifact is `validation_failed` at prepare, or `plan_stale` if it disappears
  between prepare and commit. Multiple `LinkMedia` commands may share one changeset; a `LinkMedia`
  changeset cannot mix with any other command kind. Commit copies the artifact's bytes into the
  target cell's file's audio key (the same R2 layout `sync-worker/src/audio.ts` reads), so the
  app's native playback route serves externally-attached audio with no special-casing.

**Uploading audio for `LinkMedia`.** MCP is JSON-RPC and cannot carry a 25MB binary body, so audio
always goes through the REST artifact endpoint first, regardless of which transport stages the
`LinkMedia` command itself:

```
POST /api/v1/external/projects/:projectId/artifacts
x-artifact-name: recording.wav
x-artifact-kind: audio
content-type: audio/wav

<raw bytes>
```

Accepted `content-type`s: `audio/wav`, `audio/mpeg` (mp3), `audio/mp4` / `audio/x-m4a`, `audio/ogg`
— anything else is `400 validation_failed` with the accepted list in `details`. The size cap is
unchanged (25MB, `MAX_ARTIFACT_BYTES`). Omit `x-artifact-kind` (or send `source`) for the existing
verbatim-import-preservation upload path — that behavior is byte-for-byte unchanged.

**Commit idempotency (crash-and-retry).** `commit.ts` mints every id an apply step needs (event
ids for `SetTranslation`/`LinkMedia`; the file id, `file.create` event id, and per-cell ids for
`PlanImport`) at **prepare** time and stores them in the plan, then sets the changeset's status to
`committing` the instant it starts applying, flipping to `committed` only once every write has
landed. A worker eviction mid-commit (a 5,000-cell `PlanImport` chunks into ~50 event-batch POSTs
in one request) leaves the changeset in `committing`, never `staged` again. `POST .../commit`
accepts a changeset in **either** `staged` or `committing`: a `committing` changeset is read as
"my own prior attempt crashed, resume it" — the retry replays the exact same stored ids, and the
`/events` idempotency layer (or, for the receipt-only commands, an id-ownership check) absorbs the
duplicate rather than creating a second file/event/project. Callers never need to distinguish a
fresh commit from a crash-retry; the same request works for both.

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
| `plan_stale` | 409 | Project state changed since `prepare` (a precondition drifted), a `confirm_changeset` digest doesn't match the stored plan, an `UpdateProjectSettings.ifMatchVersion` no longer matches the live settings version, or a `LinkMedia` artifact/cell disappeared before commit. | Re-`prepare` a fresh changeset against current state; do not blindly retry `commit`. |
| `confirmation_required` | 428 | Ask-mode changeset has no valid, unconsumed human approval. | Surface the `approvalUrl` (present in the error's `details` from MCP; re-fetch `get_changeset` for REST) to a human; only call commit again after they approve. |
| `validation_failed` | 400 | Malformed request, bad command shape, oversize/wrong-content-type artifact, expired changeset, wrong changeset status for the action, a `CreateProject`/`UpdateProjectSettings`/`LinkMedia` not staged as the sole (or only-LinkMedia) command in its changeset, etc. | Fix the request per `details`/`message`; do not retry unchanged. |
| `conflict` | 409 | `CreateProject` only: the chosen project id was claimed by a different caller between `prepare` and `commit` — a genuine race, distinct from your own crash-retry (which is idempotent success, not a conflict). | Don't retry with the same id. Choose a different `projectId` (or omit it and let the next changeset's URL id pick a fresh one) and re-`prepare`. |
| `job_failed` | 500 | Unexpected server-side failure (misconfiguration, unhandled exception, partial apply on `PlanImport`). | Safe to retry once; if it persists, treat as a bug — check `details.receipt` for a `PlanImport` partial-apply accounting. |
| `rate_limited` | 429 | Reserved in the error contract; **not currently enforced anywhere in code** — no rate limiter exists in v1. | N/A today; documented for forward compatibility. |
| `not_found` | 404 | Resource (changeset, artifact, project, credential) doesn't exist or isn't visible to this credential. | Don't retry with the same id. |

MCP tool errors use the identical code set inside the tool result (`isError: true`, JSON text
body `{ error: { code, message, details? } }`) — an agent can branch on `code` the same way
across both adapters (`sync-worker/src/external/mcp-handlers.ts`).

## 6. Provenance

Every event **applied through a changeset commit** (`SetTranslation`, `PlanImport`, and
`LinkMedia` — the three event-native command kinds, `sync-worker/src/external/commit.ts`) is
stamped with a provenance envelope written to `events.provenance` (JSONB) *after* the event is
accepted by the `/events` perimeter:

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
| `channel` | `"mcp"` when the commit request is the MCP `confirm_changeset` tool's synthetic in-process request (marked with an internal `x-aquilla-channel: mcp` header), `"rest"` for a direct `POST .../commit` call. Distinguished as of v1.1 — the v1 practitioner guide's earlier "hardcoded to rest" note no longer applies. | Verified. |
| `autonomy_mode` | The changeset's stored `autonomy_mode` (`ask`\|`act`). | Verified. |
| `changeset_id` | The committing changeset's id. | Verified. |
| `confirmation_id` | Present only when an ask-mode confirmation was consumed to commit. | Verified. |
| `agent` | Parsed from the caller-supplied `x-agent-meta` request header (JSON), or `null` if absent/invalid. Never validated against a real provider/model. | **Caller-declared, not verified** — recorded as testimony only. |

`CreateProject` and `UpdateProjectSettings` are **receipt-only** — they write a plain `projects` /
`project_settings` row, not an event, so there is no `events.provenance` row to stamp. Their
provenance lives entirely in the changeset's `receipt` instead:

```json
{
  "credentialId": "...",
  "channel": "mcp",
  "changesetId": "...",
  "command": "UpdateProjectSettings",
  "appliedAt": "2026-07-17T00:00:00.000Z",
  "projectId": "proj_abc123",
  "version": 3
}
```

`version` is present only on `UpdateProjectSettings` (the new settings version after the write);
`CreateProject`'s `projectId` is the created project's id. Same `channel` distinction as above.

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
| Accepted `audio`-kind artifact content types | `audio/wav`, `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/ogg` | `AUDIO_CONTENT_TYPES`, `sync-worker/src/external/artifacts-route.ts`. Same 25 MB cap as any artifact — audio gets no separate limit. |
| Credential `name` length | 1–200 chars | `createSchema`, `auth-worker/src/routes/credentials.ts` |
| Rate limiting | **not implemented** | `rate_limited` is a reserved error code with no enforcement in code today |

## 8. What's not yet available

Documented explicitly so you don't go looking for it:

- **`run_checks`** (rules/health verification tool) — no MCP tool, no REST endpoint, no command.
- **Jobs** (`get_job`) — imports/commits are synchronous within a single HTTP request; there is
  no async job queue, polling endpoint, or job id in any response. (The `committing` status and
  prepare-time id ledger added in v1.1 exist partly to make room for an eventual async commit
  mode — see the v1.1 design doc §6 — but nothing in this wave adopts it.)
- **Export** (`prepare_export`, `get_export`) — not implemented.
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
