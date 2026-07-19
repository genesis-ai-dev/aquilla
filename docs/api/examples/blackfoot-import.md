# Worked example: importing a small USFM file end-to-end

This is the AQU-533 §6 gate-9 worked example: mint a credential, upload a source artifact,
inspect it, stage and commit a `PlanImport` changeset, read the imported cells back — first with
an **act**-mode credential (auto-confirmed), then the identical flow with an **ask**-mode
credential to show the human-approval step. It stands in for the real Blackfoot / USFM dogfood
import (AQU-533 §6 gate 5) with a small, honest, three-verse fragment — the mechanics are
identical for a full book; only the byte count and cell count differ.

Every request below shows **which host it targets** — identity vs sync — because they differ per
environment (see [`docs/api/agent-api.md`](../agent-api.md) §1). Substitute your own hosts,
project id, and session JWT; everything else is copy-pasteable.

```bash
export IDENTITY_HOST=https://api.aquilla.app/identity   # auth-worker
export SYNC_HOST=https://api.aquilla.app/sync            # sync-worker
export PROJECT_ID=proj_blackfoot_demo
export SESSION_JWT=eyJ...your-aquilla-browser-session-jwt...   # from logging into the SPA
```

The minting user must hold **≥ MAINTAINER** on `$PROJECT_ID` to mint an `act`-mode credential
scoped to it (act mode requires ≥ MAINTAINER at mint time), and the `PlanImport` command itself
requires **≥ PROJECT_LEAD** at commit time (checked live, by the `/events` perimeter, not by the
credential's mint-time scope check) — a MAINTAINER satisfies both.

---

## Part 1 — act mode (auto-confirmed)

### 1. Mint an act-mode credential — identity host

```bash
curl -sS -X POST "$IDENTITY_HOST/api/v2/credentials" \
  -H "Authorization: Bearer $SESSION_JWT" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "blackfoot-import-act",
        "mode": "act",
        "projectId": "'"$PROJECT_ID"'"
      }'
```

```json
{
  "token": "aqk_9f2a3b1c...redacted...",
  "credential": {
    "id": "5b6a1d2e-...",
    "name": "blackfoot-import-act",
    "mode": "act",
    "orgId": null,
    "projectId": "proj_blackfoot_demo",
    "tokenPrefix": "aqk_9f2a3b1c",
    "createdAt": "2026-07-13T00:00:00.000Z",
    "expiresAt": null,
    "lastUsedAt": null,
    "revokedAt": null
  }
}
```

Save the token — it is shown once and never retrievable again:

```bash
export ACT_TOKEN=aqk_9f2a3b1c...redacted...
```

### 2. Upload the source artifact — sync host

A small three-verse USFM fragment (stand-in for a full Blackfoot book — same mechanics, more
cells):

```bash
cat > /tmp/genesis-fragment.usfm <<'EOF'
\id GEN
\h Genesis
\mt Genesis
\c 1
\p
\v 1 In the beginning God created the heavens and the earth.
\v 2 The earth was without form and void.
\v 3 And God said, Let there be light: and there was light.
EOF

curl -sS -X POST "$SYNC_HOST/api/v1/external/projects/$PROJECT_ID/artifacts" \
  -H "Authorization: Bearer $ACT_TOKEN" \
  -H "x-artifact-name: genesis-fragment.usfm" \
  -H "Content-Type: text/plain" \
  --data-binary @/tmp/genesis-fragment.usfm
```

```json
{
  "artifactId": "8c1e4a2f-...",
  "sha256": "b4a9c1...",
  "sizeBytes": 191
}
```

```bash
export ARTIFACT_ID=8c1e4a2f-...
```

### 3. Inspect the artifact — sync host

```bash
curl -sS "$SYNC_HOST/api/v1/external/projects/$PROJECT_ID/artifacts/$ARTIFACT_ID/inspect" \
  -H "Authorization: Bearer $ACT_TOKEN"
```

```json
{
  "detectedFormat": "usfm",
  "details": {
    "byteCount": 191,
    "sniffedBytes": 191,
    "lineCount": 8,
    "truncated": false
  }
}
```

`inspect` only **detects** the format (a marker sniff over the first 64KB) — it does not parse
USFM into cells. Parsing is the agent's job today (see "not yet available" in the practitioner
guide): the agent runs Aquilla's USFM parser (or its own) client-side and hands the server
already-split cells, exactly like the SPA's `/import` path.

### 4. Prepare a `PlanImport` changeset — sync host

The agent parsed the fragment into three source cells. `PlanImport` must be the **only** command
in its changeset.

```bash
curl -sS -X POST "$SYNC_HOST/api/v1/external/projects/$PROJECT_ID/changesets" \
  -H "Authorization: Bearer $ACT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "commands": [
          {
            "kind": "PlanImport",
            "fileName": "Genesis.usfm",
            "fileType": "usfm",
            "sourceLanguage": "en",
            "targetLanguage": "bla",
            "artifactId": "'"$ARTIFACT_ID"'",
            "cells": [
              { "canonicalRef": "GEN 1:1", "content": "In the beginning God created the heavens and the earth.", "type": "verse" },
              { "canonicalRef": "GEN 1:2", "content": "The earth was without form and void.", "type": "verse" },
              { "canonicalRef": "GEN 1:3", "content": "And God said, Let there be light: and there was light.", "type": "verse" }
            ]
          }
        ]
      }'
```

```json
{
  "changeset": {
    "id": "01911a2b-...",
    "projectId": "proj_blackfoot_demo",
    "autonomyMode": "act",
    "status": "staged",
    "digest": "3f7c9a...",
    "summary": {
      "filesCreated": 1,
      "sourceCellsAdded": 3,
      "artifactLinked": "8c1e4a2f-...",
      "warnings": []
    },
    "receipt": null,
    "expiresAt": "2026-07-13T01:00:00.000Z"
  },
  "summary": { "filesCreated": 1, "sourceCellsAdded": 3, "artifactLinked": "8c1e4a2f-...", "warnings": [] },
  "digest": "3f7c9a...",
  "approvalUrl": "https://api.aquilla.app/identity/approve/01911a2b-..."
}
```

Note the effect summary — `filesCreated: 1`, `sourceCellsAdded: 3` — is server-computed from the
plan, not narrated by the agent. `approvalUrl` is present on every prepare response regardless of
mode; an act-mode agent simply doesn't need it.

```bash
export CHANGESET_ID=01911a2b-...
export DIGEST=3f7c9a...
```

### 5. Commit — sync host

```bash
curl -sS -X POST \
  "$SYNC_HOST/api/v1/external/projects/$PROJECT_ID/changesets/$CHANGESET_ID/commit" \
  -H "Authorization: Bearer $ACT_TOKEN"
```

```json
{
  "receipt": {
    "eventIds": ["...", "...", "...", "..."],
    "appliedCount": 4,
    "staleCount": 0,
    "warnings": [],
    "committedAt": "2026-07-13T00:05:00.000Z",
    "fileId": "b2f1c3d4-..."
  }
}
```

Four applied events: one `file.create` + three `source.cell.create`. Committing is idempotent —
calling `.../commit` again returns this same receipt without re-applying.

### 6. Read the cells back — sync host

```bash
export FILE_ID=b2f1c3d4-...

curl -sS "$SYNC_HOST/api/v1/external/projects/$PROJECT_ID/files/$FILE_ID/cells" \
  -H "Authorization: Bearer $ACT_TOKEN"
```

```json
{
  "data": [
    { "id": "...", "cellId": "...", "canonicalRef": "GEN 1:1", "sourceContent": "In the beginning God created the heavens and the earth.", "targetContent": null },
    { "id": "...", "cellId": "...", "canonicalRef": "GEN 1:2", "sourceContent": "The earth was without form and void.", "targetContent": null },
    { "id": "...", "cellId": "...", "canonicalRef": "GEN 1:3", "sourceContent": "And God said, Let there be light: and there was light.", "targetContent": null }
  ],
  "nextCursor": null,
  "maxServerSeq": 4
}
```

(Exact field names on cell rows come from the internal cells-read route this endpoint delegates
to — check the response you actually get rather than relying on this sketch verbatim.)

---

## Part 2 — the identical flow with an ask-mode credential

Same operations; the credential now caps at `ask`, so commit requires a human in the loop.

### 1. Mint an ask-mode credential — identity host

Ask mode has no maintainer requirement — CONTRIBUTOR is enough to scope it — but this walkthrough
still uses a PROJECT_LEAD-or-above user so the eventual commit (which needs PROJECT_LEAD for
`PlanImport`) succeeds once approved.

```bash
curl -sS -X POST "$IDENTITY_HOST/api/v2/credentials" \
  -H "Authorization: Bearer $SESSION_JWT" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "blackfoot-import-ask",
        "mode": "ask",
        "projectId": "'"$PROJECT_ID"'"
      }'
```

```bash
export ASK_TOKEN=aqk_ab12cd34...redacted...
```

### 2–4. Upload, inspect, prepare — identical to Part 1, steps 2–4

Same requests, just `-H "Authorization: Bearer $ASK_TOKEN"`. The prepare response now matters:

```json
{
  "changeset": { "id": "0191...", "autonomyMode": "ask", "status": "staged", "...": "..." },
  "summary": { "filesCreated": 1, "sourceCellsAdded": 3, "warnings": [] },
  "digest": "7a2f1c...",
  "approvalUrl": "https://api.aquilla.app/identity/approve/0191..."
}
```

```bash
export ASK_CHANGESET_ID=0191...
export ASK_DIGEST=7a2f1c...
```

### 5. Attempt commit — sync host — returns `confirmation_required`

```bash
curl -sS -X POST \
  "$SYNC_HOST/api/v1/external/projects/$PROJECT_ID/changesets/$ASK_CHANGESET_ID/commit" \
  -H "Authorization: Bearer $ASK_TOKEN"
```

```json
{
  "error": {
    "code": "confirmation_required",
    "message": "ask-mode changeset requires a valid, unconsumed human approval"
  }
}
```

HTTP status `428 Precondition Required`. **Nothing was applied.** The agent's job now is to
surface `approvalUrl` (`https://api.aquilla.app/identity/approve/0191...` from the prepare
response — or `https://<web-app-host>/approve/0191...` if the SPA is served from a different
host than the identity worker's `BASE_URL`) to the human it's acting for.

### 6. Human approves — in a browser, via the identity host

This step is not a curl call an agent makes — it is the human, signed into the Aquilla SPA,
visiting the approval URL. The page (`src/pages/ApproveChangeset/ApproveChangeset.tsx`) itself
calls:

```bash
# What the browser does, for illustration — requires the HUMAN's session JWT, not the API credential
curl -sS "$IDENTITY_HOST/api/v2/changesets/$ASK_CHANGESET_ID/approval" \
  -H "Authorization: Bearer $SESSION_JWT"
# -> { changesetId, projectId, status: "staged", summary: {...}, digest: "7a2f1c...", ... }

curl -sS -X POST "$IDENTITY_HOST/api/v2/changesets/$ASK_CHANGESET_ID/approve" \
  -H "Authorization: Bearer $SESSION_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "digest": "7a2f1c..." }'
# -> { "confirmationId": "...", "expiresAt": "...", "message": "Approved — the agent may now call commit/confirm_changeset." }
```

The confirmation is single-use and expires in **15 minutes**. Only the human whose session
matches `changesets.created_by_user_id` (the user who owns the credential that staged it) can
approve or reject.

### 7. Agent commits again — sync host

```bash
curl -sS -X POST \
  "$SYNC_HOST/api/v1/external/projects/$PROJECT_ID/changesets/$ASK_CHANGESET_ID/commit" \
  -H "Authorization: Bearer $ASK_TOKEN"
```

```json
{
  "receipt": {
    "eventIds": ["...", "...", "...", "..."],
    "appliedCount": 4,
    "staleCount": 0,
    "warnings": [],
    "committedAt": "2026-07-13T00:20:00.000Z",
    "fileId": "..."
  }
}
```

Same receipt shape as act mode — the pipeline past the confirmation gate is identical for both
modes.

---

## Using MCP instead of raw REST

The equivalent MCP tool sequence (any MCP client, `$SYNC_HOST/api/v1/external/mcp`):

1. `tools/call get_capabilities` — confirm your credential's mode and the current limits.
2. `tools/call prepare_translations` — **note:** as of this wave, `PlanImport` (this whole
   worked example) has **no MCP tool** — only `SetTranslation` batches are exposed over MCP.
   To run this exact import flow over MCP you would need a REST-capable host to call the
   artifact + `PlanImport` changeset endpoints directly (as above), then use MCP only for the
   translation/read/verify steps that follow the import. This is a real gap, not an oversight —
   see `docs/swarm/AGENT-API-TRACES.md`.
3. `tools/call get_changeset` / `confirm_changeset` — same ask/act semantics as REST, described
   in [`docs/api/agent-api.md`](../agent-api.md) §3.
