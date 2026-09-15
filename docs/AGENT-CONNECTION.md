# Browser authorization for external agents

AQU-1205 adds secret-free connection instructions to **Preferences → API tokens**.
The agent requests access, the human signs in and approves one project, and the
agent receives the credential directly. Existing manual tokens remain available.

## Protocol choice

Reviewed September 9, 2026:

- [MCP authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
  uses OAuth authorization-code flows with PKCE and discovery for capable MCP
  clients. That is the appropriate future path for automatic MCP client setup.
- [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) defines device
  authorization for clients that can make outbound requests but cannot reliably
  receive browser callbacks. This fits generic terminal and hosted agents.

- [RFC 10027 / BCP 247](https://www.rfc-editor.org/rfc/rfc10027.html)
  (August 2026) describes cross-device consent phishing and layered mitigations.
  This flow uses short-lived, unique, one-use codes, rate limits, explicit
  initiation confirmation, and limited project scope. Code comparison does not
  authenticate the agent's identity or eliminate social engineering.

This implementation provides the RFC 8628 device grant for the existing Aquilla
Agent API and MCP bearer transport. It does **not** claim to implement the full
MCP OAuth discovery/authorization-code profile. Agents follow the public
`/api/v2/agent-connect` instructions; MCP clients requiring automatic OAuth
registration and PKCE discovery still need a separate integration.

## User journey

1. Copy connection instructions from API tokens into the agent chat.
2. The agent POSTs `client_id=aquilla-agent`, a self-reported `agent_name`, optional
   `project_id`, and `scope=ask` (default) or `act` to
   `/api/v2/agent-connect/device_authorization` on the identity worker.
3. The response contains a private `device_code`, a displayed `user_code`, a
   verification URL, `expires_in=600`, and `interval=5`.
4. The human opens the URL, signs in if necessary, reviews the request, chooses
   a project, compares the displayed code with their agent, and approves or denies.
5. The agent POSTs the device code, client ID, and
   `grant_type=urn:ietf:params:oauth:grant-type:device_code` to `/token`.
   It respects `authorization_pending`, `slow_down` (+5 seconds), `access_denied`,
   and `expired_token`. JSON and form bodies are supported.
6. Successful redemption returns a Bearer credential valid for 30 days. The
   agent stores it privately and verifies it against the Agent API `/me`.

The token never appears in browser consent responses. Agents must handle the
response in code and store credentials without printing them into tool output,
chat, command arguments, or logs. Prompt instructions cannot guarantee a third
party agent's storage practices; agents without suitable storage must stop.
There is no refresh token. Reconnect after expiry or a lost redemption response.

## Authorization and lifecycle

- The public client ID describes this generic protocol, not a verified identity.
  The consent page explicitly marks agent names as self-reported.
- Approval always requires an existing session JWT, an explicit code confirmation,
  and one selected project. Requested project IDs cannot be substituted.
- `ask` requires Contributor; `act` requires Maintainer. Roles are checked again
  at redemption. Existing API authorization checks live roles on every call.
- Both codes persist only as SHA-256 hashes. The verification link carries only
  the user code in its fragment, avoiding server access-log and referrer exposure.
- Requests expire in ten minutes. Approval and denial use conditional updates;
  redemption consumes the grant and inserts its credential in one SQL statement.
- Polling is atomically claimed; early polls increase the interval. Initiation
  and browser-code attempts use existing indexed rate-limit infrastructure.
- Credentials appear in the existing token list and use its revoke endpoint.
- Migration `0090_agent_authorizations.sql` is required before deployment.
  `BASE_URL` must point to the matching SPA, including for local/dev deployments.

## Verification

Worker tests exercise real Postgres through PGlite and pass issued credentials to
`validateApiCredential`, including revocation, denial, expiry, role loss, and
concurrent redemption. RTL covers secret-free copying and explicit browser consent.
The smoke journey crosses the SPA, identity worker, Postgres, and sync worker:
request → consent → redemption → `/me` → revocation → rejected `/me`.
