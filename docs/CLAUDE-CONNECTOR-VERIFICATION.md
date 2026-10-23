# Claude connector verification

Issue: AQU-2127. Checked on 2026-10-23, Asia/Singapore.

## Completed checks

- `claude plugin validate ./plugins/aquilla` passes with Claude Code 2.1.307.
  Directory checks report no warnings. The CLI suggests a marketplace install
  command after a public marketplace exists; none is claimed yet.
- A real Claude Code session loads the exported bundle and advertises
  `aquilla:attention-queue`, `aquilla:terminology-drift`, and
  `aquilla:translation-status-report` through its Skill tool. The probe
  invokes no Aquilla tools and establishes discovery only.
- `scripts/chatgpt-plugin.test.ts`: 10 tests pass under Vitest 5.0.1,
  using the worktree's own installed runner and a temporary Node config.
  The config selects only this test and caps execution at one worker.
- After the frozen dependency installation completes, the standard app
  test configuration also passes all 10 package tests with one worker.
- The repository's secret scan passes with no credential patterns found.
- An unauthenticated production MCP `initialize` request returns HTTP 401
  with `WWW-Authenticate`, the correct resource metadata URL, and `act` scope.
- The referenced protected-resource document returns the exact MCP URL,
  the identity issuer, header bearer authentication, and `act` scope.
- The production issuer discovery document advertises authorization code,
  S256 PKCE, public-client authentication (`none`), and CIMD support.
- An authorization request carrying Claude's published client metadata URL
  and hosted HTTPS callback returns HTTP 302 to Aquilla's consent screen.
  Client metadata validation occurs later in the session-gated consent API;
  the redirect does not establish that Claude's identity is accepted.
  This check grants no access and exchanges no token.

The production MCP endpoint is:

```text
https://api.aquilla.app/sync/api/v1/external/mcp
```

The initial manual probe uses this client identity and callback:

```text
https://claude.ai/api/oauth/mcp-oauth-client-metadata
https://claude.ai/api/mcp/auth_callback
```

The real hosted Claude connection instead sends
`https://claude.ai/oauth/mcp-oauth-client-metadata` as its client ID.
Record the actual client from the current browser flow rather than pinning
the manual probe's URL into server configuration.

## Pending authenticated verification

After the user identifies a signed-in Chrome window, native browser
inspection reaches the real connector list. Aquilla is absent initially.
We add **Aquilla** with the production URL, **Sign in now**, and
**Use Claude's published identity**. Its saved connector ID is
`1520052a-d732-4dcc-9280-11f80577a99c`.

Clicking **Connect** opens Aquilla's OAuth consent URL with S256 PKCE,
`act` scope, the canonical MCP resource, and Claude's fixed callback.
Aquilla displays its username/email and password form. The user must
sign in before client validation, organization choices, and token exchange
can be tested. No consent is submitted and no access is granted yet.

Earlier Jev observations only show **Loading**. Their `done` result does
not prove readiness; the signed-in native Chrome window provides the
actual login form. The local Claude CLI's API key does not authenticate
Aquilla or authorize access to its data.

Consequently, these checks remain unrun:

- Aquilla sign-in, organization consent, and token exchange.
- Authenticated `initialize`, tool discovery, and each tool invocation in Claude.
- Read-only reports, requested correction, excluded organization rejection,
  prompt injection resistance, and connection revocation in Claude.
- Reviewer account access and complete tool-inventory coverage.

Direct fetching of Claude's client metadata from this machine returns 403.
The initial authorize route forwards parameters to the consent page without
fetching metadata. Its redirect does not establish metadata validation,
browser sign-in, or a complete OAuth flow.

## Native Claude Code limitation

`auth-worker/src/routes/mcp-oauth.ts` checks redirect URIs with exact array
membership. Claude's native client uses ephemeral loopback ports, which
[Claude's authentication requirements](https://claude.com/docs/connectors/building/authentication)
require matching without the port for both localhost and 127.0.0.1.
The package loads locally, but native OAuth compatibility remains unresolved.
This packaging change does not alter authorization validation.

## Test impact

Commands actually run:

```sh
claude plugin validate ./plugins/aquilla
claude plugin validate /private/tmp/aquilla-claude-submission/aquilla
node node_modules/vitest/vitest.mjs run scripts/chatgpt-plugin.test.ts \
  --project app --maxWorkers 1
node node_modules/tsx/dist/cli.mjs scripts/secret-scan.ts
```

The package suite runs through the installed Vitest entry point with
`run --config /private/tmp/aqu-2127-vitest.config.mjs`.
That temporary config selects `scripts/chatgpt-plugin.test.ts` in Node,
without the unrelated SPA setup. Discovery uses a real Claude CLI session
with `--plugin-dir`, `--tools Skill`, and `--no-session-persistence`.
Live requests use curl against the MCP endpoint, its resource metadata,
the issuer metadata, and the initial authorization route.

No application build or full smoke suite runs: these changes affect static
plugin packaging, and no application or worker source changes.

The changed contract is plugin discovery: Claude consumes the shared HTTP
MCP configuration and three skills through `.claude-plugin/plugin.json`.
The existing OAuth catalog produces the tool names and annotations used
by those skill instructions. The regression in `scripts/chatgpt-plugin.test.ts`
checks that composition, shared identity/version, and HTTP transport.

No application UI, persistence, import, or permission contract changes.
No new browser smoke journey is needed for static packaging.
The existing spec's `04-features/auth-and-account.md`,
**External agent project authorization**, distinguishes device authorization
from MCP OAuth discovery. Packaging changes neither contract; no spec edit
is required. This does not reconcile the broader OAuth spec backlog.

## Submission status

Not submitted. Listing text, setup instructions, existing icon, and reviewer
journeys are in `CLAUDE-CONNECTOR.md`. The existing repository is public;
the portal accepts `plugins/aquilla` as its plugin path. Push the final
package and guide to the tracked branch before portal validation.
Reviewer credentials and authenticated tests remain prerequisites.
Do not check the portal's all-tools-tested acknowledgment yet.
