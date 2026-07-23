# Aquilla Agent API — quickstart

**This page is written to be handed to an AI agent.** It is complete enough to go from a bare
API token to committed writes. The full reference is [`agent-api.md`](agent-api.md); the API
also describes itself at runtime — `GET $SYNC_HOST/api/v1/external` returns this same map as
JSON, unauthenticated.

## The 30-second conceptual model

1. **One token, two hosts.** Your `aqk_...` token authenticates everything an agent does, on
   the **sync host**. The separate **identity host** is only for humans (minting tokens in a
   browser, approving changesets). As an agent you will likely never call the identity host.
2. **Reads are plain GETs.** Search, files, cells, history.
3. **Every write is a two-step changeset:**
   - **prepare** — `POST .../changesets` stages an immutable plan. Nothing is applied. You get
     back `{ changeset, digest, summary, approvalUrl }`.
   - **commit** — `POST .../changesets/:id/commit` applies it.
4. **Your credential has an autonomy mode** (see `GET /me`):
   - `act` — commit applies immediately.
   - `ask` — commit returns `428 confirmation_required` until a **human** opens the
     `approvalUrl` in their browser and approves. Then call commit again. You cannot skip,
     forge, or automate this step — show the URL to your human and wait.
5. **Errors are always** `{ "error": { "code", "message", "details?" } }`. Branch on `code`:
   `plan_stale` → re-prepare; `confirmation_required` → surface the approvalUrl;
   `validation_failed` → fix the request; `permission_denied`/`scope_denied` → stop and tell
   your human; `job_failed` → retry once.

## Hosts

| Environment | Sync host (`$SYNC_HOST` below) | Identity host (humans only) |
| --- | --- | --- |
| Production | `https://api.aquilla.app/sync` | `https://api.aquilla.app/identity` |
| Local dev | `http://127.0.0.1:8787` (see `.env.example`) | `http://127.0.0.1:8788` |

⚠️ In production the `/sync` prefix is **part of the URL**: the MCP endpoint is
`https://api.aquilla.app/sync/api/v1/external/mcp`, not `https://api.aquilla.app/api/v1/external/mcp`.

## Getting a token (human step, once)

A signed-in human mints the token in the Aquilla app: **Preferences → Account → API tokens**.
The token (`aqk_...`) is shown exactly once. Tokens carry a scope (project/org/unscoped) and a
mode (`ask`/`act`); permissions are the minting user's live role, re-checked on every call.

## Option A: REST (curl-able golden path)

```bash
export SYNC_HOST=https://api.aquilla.app/sync
export TOKEN=aqk_...
AUTH="Authorization: Bearer $TOKEN"

# 0. What is this API? (no auth needed)
curl -s $SYNC_HOST/api/v1/external

# 1. Who am I? (mode, scope)
curl -s -H "$AUTH" $SYNC_HOST/api/v1/external/me

# 2. Find a project
curl -s -H "$AUTH" $SYNC_HOST/api/v1/external/projects
# → { "data": [{ "id": "proj_abc", "name": "...", ... }], "nextCursor": null }

# 3. Read content
curl -s -H "$AUTH" $SYNC_HOST/api/v1/external/projects/proj_abc/files
curl -s -H "$AUTH" $SYNC_HOST/api/v1/external/projects/proj_abc/files/FILE_ID/cells
curl -s -H "$AUTH" "$SYNC_HOST/api/v1/external/projects/proj_abc/search?q=covenant"

# 4. PREPARE a write (stages a plan — applies nothing)
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -X POST $SYNC_HOST/api/v1/external/projects/proj_abc/changesets \
  -d '{"commands":[{"kind":"SetTranslation","fileId":"FILE_ID","cellId":"CELL_ID","value":"New translation"}]}'
# → { "changeset": { "id": "...", "autonomyMode": "ask" }, "digest": "...",
#     "summary": {...}, "approvalUrl": "https://aquilla.app/approve/..." }

# 5. COMMIT it
curl -s -H "$AUTH" -X POST \
  $SYNC_HOST/api/v1/external/projects/proj_abc/changesets/CHANGESET_ID/commit
# act mode  → 200 + execution receipt
# ask mode  → 428 confirmation_required: show approvalUrl to your human,
#             wait for them to approve in the browser, then re-run this exact command.
```

Commit is idempotent — retrying (including after a crash mid-commit) is always safe.

## Option B: MCP

Any MCP client speaking streamable HTTP with bearer auth:

```bash
claude mcp add aquilla --transport http \
  "$SYNC_HOST/api/v1/external/mcp" \
  --header "Authorization: Bearer $TOKEN"
```

Then: `get_capabilities` (returns a numbered quickstart) → `get_identity_and_scope` →
`list_projects` → `read_content` / `search_project` → `prepare_translations` →
`confirm_changeset`. The MCP tools and REST endpoints are the same command layer — same
permissions, same error codes, same changesets.

Two things are REST-only (MCP is JSON text and can't carry binaries): **artifact upload**
(`POST .../artifacts`, raw bytes, max 25 MB) and **`PlanImport`** staging.

## Command kinds (the writes you can stage)

| Kind | What it does | Min role | Notes |
| --- | --- | --- | --- |
| `SetTranslation` | Set a cell's target text | CONTRIBUTOR | Batch freely in one changeset. |
| `PlanImport` | Create a file + source cells | PROJECT_LEAD | REST-only; sole command; ≤5,000 cells. |
| `CreateProject` | Create a project | org MAINTAINER | Sole command; **always ask-mode** — human approval required by design. |
| `UpdateProjectSettings` | Write settings blob | MAINTAINER | Sole command; needs `ifMatchVersion`. |
| `LinkMedia` | Attach uploaded audio to a cell | CONTRIBUTOR | Upload artifact first with `x-artifact-kind: audio`. |

## When something goes wrong

- **401** — token missing/invalid/revoked/expired. The message tells you the header shape.
- **404 with a hint** — you guessed a wrong path; `GET /api/v1/external` lists every real one.
  If everything 404s, check you kept the `/sync` prefix in the production host.
- **`plan_stale` (409)** — project state moved since prepare. Re-read, re-prepare. Never loop
  on commit.
- **`confirmation_required` (428)** — not an error, a handoff: give the `approvalUrl` to your
  human, then commit again after they approve. Approval expires 15 minutes after granting;
  staged changesets expire after 1 hour.

Worked end-to-end import example: [`examples/blackfoot-import.md`](examples/blackfoot-import.md).
Machine-readable spec: [`openapi.yaml`](openapi.yaml).
