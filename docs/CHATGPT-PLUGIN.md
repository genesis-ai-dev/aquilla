# Aquilla as a ChatGPT plugin

Aquilla's Agent API already speaks MCP (`/api/v1/external/mcp`). This document
covers what makes it installable as a ChatGPT plugin (and, through the shared
plugin directory, a Codex plugin): OAuth sign-in for MCP hosts, tool metadata
that drives ChatGPT's approval prompts, server instructions, and a plugin
package with project-management skills.

## What a user sees

1. They add Aquilla in ChatGPT (directory listing, or Developer Mode with the
   MCP URL below).
2. ChatGPT sends them to Aquilla. They sign in, select **one or more organizations**. **All current organizations**
   selects the organizations available today. OAuth connections always use **Act**.
3. Back in ChatGPT they ask things like "write a status report on my Aquilla
   projects". Reads run freely. Changes use changesets and can save within the selected
   organizations, subject to current permissions and ChatGPT confirmations.
   Saving a translation does not mark it as human validated. Existing
   command-specific approval rules, including project creation, still apply.
4. The connection appears under **Preferences → API tokens** with the app's
   name. Revoking it there disconnects ChatGPT.

## How sign-in works

OAuth 2.1 authorization code + PKCE, with the identity worker as the
authorization server and the sync worker as the protected resource.

```
ChatGPT ──POST /sync/api/v1/external/mcp (no token)──▶ sync-worker
        ◀─401 WWW-Authenticate: Bearer resource_metadata="…/sync/.well-known/oauth-protected-resource/api/v1/external/mcp"
        ──GET that URL (RFC 9728)──▶ { resource, authorization_servers: [https://api.aquilla.app/identity] }
        ──GET /.well-known/oauth-authorization-server/identity (RFC 8414)──▶ identity worker
        ──browser: /identity/oauth/authorize?… ──302──▶ https://aquilla.app/oauth/consent?…
                     SPA: sign in, POST /api/v2/mcp-oauth/request, then /decision
        ◀─browser: redirect_uri?code=…&state=…&iss=https://api.aquilla.app/identity
        ──POST /identity/oauth/token (code + code_verifier)──▶ { access_token: "aqk_…", token_type: "Bearer", scope: "act" }
        ──POST /sync/api/v1/external/mcp  Authorization: Bearer aqk_…──▶ tools
```

Design decisions:

- **The access token is an ordinary `aqk_` API credential.** Same table, same
  live-role check on every call, same revoke button. The saved organization
  allowlist also intersects live organization membership on every request.
- **No expiry, no refresh token** — the same contract as the device flow
  (`docs/AGENT-CONNECTION.md`): a connected host keeps working until the human
  revokes it.
- **Client registration is by URL (Client ID Metadata Documents).** ChatGPT's
  client id is `https://chatgpt.com/oauth/client.json`; the identity worker
  fetches it and trusts only the `redirect_uris` it lists. There is no dynamic
  registration endpoint and no client table. The consent page shows the
  self-declared name next to the domain that served the document.
- **Every client is public.** PKCE S256 is mandatory; client authentication
  methods in a metadata document are not used.
- **RFC 9207 `iss`** is on every authorization response, success or error.
- **Codes** are stored as SHA-256 hashes, live five minutes, redeem once, and
  a replayed code revokes the credential the first redemption minted.
- **OAuth always grants `act`.** The user selects organizations rather than an
  autonomy mode. Device-flow and API-token connections retain Ask/Act controls.
- **Organization selection is a snapshot.** New projects inside selected
  organizations can be accessed with current permissions. Later organization
  memberships require a new grant. Removed memberships cannot retain access.
- **`resource`** (RFC 8707) must be an Aquilla MCP URL on the issuer's host.
  Tokens are not audience-bound — every Agent API surface accepts them.

| Piece | Where |
| --- | --- |
| 401 challenge, RFC 9728 metadata | `sync-worker/src/external/mcp-oauth-metadata.ts`, `mcp-route.ts` |
| RFC 8414 metadata, authorize, token, consent API | `auth-worker/src/routes/mcp-oauth.ts` |
| Client metadata fetch + validation | `auth-worker/src/lib/mcp-oauth/client-metadata.ts` |
| Consent page | `src/pages/OAuthConsent.tsx` (route `/oauth/consent`) |
| Organization consent | `src/pages/OAuthConsent.tsx` |
| Code storage | `0118_mcp_oauth_codes.sql`, `0119_mcp_oauth_org_scope.sql` |

Configuration: `MCP_OAUTH_ISSUER` on the identity worker (production
`https://api.aquilla.app/identity`, development
`https://api.dev.aquilla.app/identity`) must equal the sync worker's
`AUTH_WORKER_URL`. Locally both fall back to `http://127.0.0.1:8788`. The
identity worker also owns the zone route
`api.*.aquilla.app/.well-known/oauth-authorization-server/*`.

PR previews cannot exercise this flow: a preview sync worker cannot reach a
preview identity worker (see `docs/DEPLOYMENT-ENVIRONMENTS.md`).

## What ChatGPT reads from the MCP server

- **`instructions`** in the `initialize` result
  (`sync-worker/src/external/mcp-instructions.ts`): session order, the approval
  contract, and how to report to a manager.
- **Tool `annotations`** (`TOOL_KINDS` in `mcp-tools.ts`): reads are
  `readOnlyHint`, staging tools are writes but not destructive, and
  `confirm_changeset` is the only `destructiveHint` tool. ChatGPT's "ask before
  changes" setting keys off these. A test fails if a new tool is not classified.
- **`securitySchemes`** (`oauth2`) on every tool.

## The plugin package

`plugins/aquilla/` is the installable package (`.codex-plugin/plugin.json`,
`.mcp.json`, `skills/`, `assets/`). Skills:

| Skill | Use |
| --- | --- |
| `translation-status-report` | Plain-language report for a manager or funder |
| `attention-queue` | Ranked list of what needs attention in one project |
| `terminology-drift` | Find inconsistent key terms; prepare and save authorized fixes |

`scripts/chatgpt-plugin.test.ts` keeps the package honest: every tool a skill
names must exist, every path must resolve, and the MCP URL must match the
production deployment manifest.

## Testing it in ChatGPT

1. Deploy this branch to development (migrations `0118` and `0119` first).
2. In ChatGPT, turn on Developer Mode (under Settings → Apps & Connectors →
   Advanced; the location varies by plan), then create an app with MCP URL
   `https://api.dev.aquilla.app/sync/api/v1/external/mcp` and OAuth
   authentication.
3. Connect. Expect the Aquilla consent page, then a return to ChatGPT.
4. Run the three skills' prompts against a real project. Record the number of
   tool calls and every place the model goes wrong.
5. Revoke the connection under Preferences → API tokens and confirm ChatGPT
   asks to reconnect.

## Not done yet

- **Dynamic client registration** (RFC 7591) for hosts that do not support
  client metadata documents. Add it only if a target host needs it.
- **`outputSchema`** on read tools, which OpenAI recommends for structured
  results.
- **UI cards** (MCP Apps): a project progress card and a changeset diff card.
- **Directory submission**: screenshots, review test account, and the MCP
  server review requirements.
