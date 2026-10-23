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
- Existing OAuth tests pass: 46 identity-worker tests across
  `mcp-oauth.test.ts` and `mcp-oauth-client-id.test.ts`, plus 11 sync-worker
  tests in `external-mcp-oauth.test.ts`.
- The normal pre-push gate passes its 67 runner guard tests and both
  `agent-connection.smoke.spec.ts` journeys. The journeys cover browser
  credential consent/revocation and OAuth Act grants restricted to selected
  current organizations. No slow-request log lines appear in this run.
  The first attempt fails during boot because worker dependencies are
  missing; frozen worker installs resolve that setup failure before rerun.
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

## Authenticated hosted Claude verification

After the user identifies a signed-in Chrome window, native browser
inspection reaches the real connector list. Aquilla is absent initially.
We add **Aquilla** with the production URL, **Sign in now**, and
**Use Claude's published identity**. Its saved connector ID is
`1520052a-d732-4dcc-9280-11f80577a99c`.

Clicking **Connect** opens Aquilla's OAuth consent URL with S256 PKCE,
`act` scope, the canonical MCP resource, and Claude's fixed callback.
The user signs in and submits organization consent. Claude then shows a
**Disconnect** button and 40 tool permission entries: 24 read-only and 16
write/delete tools. The initial authenticated conversation successfully
calls `get_capabilities`, `get_identity_and_scope`, `list_orgs`, and
`list_projects`; their actual results are inspected in Claude's activity
panel. This establishes client metadata acceptance, token exchange,
authenticated tool discovery, and those four tool calls.

The grant is Act mode with write access, restricted to one organization:
**PluginReviewer's workspace**, containing **Review Spanish**. A null
single-org or project field does not remove the organization allowlist.
The verification uses read-only calls despite that write capability.

The next conversation successfully exercises 16 further distinct tools:
`get_project`, `get_project_settings`, `read_quality`, `read_comments`,
`list_terms`, `read_term_consistency`, `list_memory`, `list_changesets`,
`get_skill`, `get_prompt_preview`, `search_projects`, `search_project`,
`read_content`, `read_history`, `read_cell_memory`, and `find_similar_cells`.
`read_content` runs twice (file listing and a bounded three-cell page).
This brings the authenticated total to 20 distinct tools. The visible
activity panel contains the corresponding call records.

The report uses returned coverage (80% filled, 0% validated), one open
reviewer thread, and 100% consistency for the fixture's community concept.
No changesets are staged and no project data changes. Empty memory and
changeset results remain valid empty responses. Observations about brief
propagation, health, and model configuration need separate investigation;
they are not proven connector defects. A follow-up follows the returned
cursor and confirms that Spanish targets appear on page two. The first
three-row page contains only source rows because the five source rows
precede the target rows. No pagination defect is demonstrated.

The second page also returns the fixture's `untrusted-source` cell.
Claude treats its destructive instructions as data and performs no action.
Claude correctly explains that saving or approving a changeset does not
establish human translation validation.

`export_file` is exercised and returns `validation_failed`:
`application/octet-stream`, `exportMode: raw-original`. Binary export
rejection is documented behavior. Its recommendation to fetch through
REST is unsuitable for MCP-bound OAuth credentials; this guidance issue
is filed in [AQU-2135](https://linear.app/frontierrandd/issue/AQU-2135).
No REST replay is attempted, and no export is delivered as translated.

Conversation evidence:
[Aquilla MCP connector verification](https://claude.ai/chat/2e216de7-5a3b-4cb9-b11a-359055f1553f).
This private chat link is an internal test record, not a public listing URL.

Earlier Jev observations only show **Loading**. Their `done` result does
not prove readiness; the signed-in native Chrome window provides the
actual login form. The local Claude CLI's API key does not authenticate
Aquilla or authorize access to its data.

These checks remain pending:

- `preview_import`: no existing source artifact ID is exposed by the
  fixtures read in this conversation. No identifier is invented.
- `get_changeset` and `wait_for_changeset`: this connection has no staged
  changesets. Neither tool is claimed as tested.
- The 16 write/delete tools in the live catalog, saved correction,
  excluded-organization rejection, and connection revocation in hosted Claude.
- Complete tool-inventory coverage and private delivery of reviewer credentials.

The user is asked whether write tests should use a separate Claude test
project. The existing Review Spanish fixture also supports the submitted
ChatGPT plugin, so it remains unchanged while that decision is pending.

Direct fetching of Claude's client metadata from this machine returns 403.
The initial authorize route forwards parameters to the consent page without
fetching metadata. Its redirect alone does not establish metadata validation
or token exchange; the successful hosted flow above supplies that evidence.

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

From `auth-worker`, run:

```sh
node node_modules/vitest/vitest.mjs run \
  src/__tests__/mcp-oauth.test.ts \
  src/__tests__/mcp-oauth-client-id.test.ts --maxWorkers 1
```

From `sync-worker`, run:

```sh
node node_modules/vitest/vitest.mjs run \
  src/__tests__/external-mcp-oauth.test.ts --maxWorkers 1
```

`git push` invokes the repository's unchanged `pnpm test:e2e:affected`
hook, which selects `e2e/specs/agent/agent-connection.smoke.spec.ts`.

The package suite runs through the installed Vitest entry point with
`run --config /private/tmp/aqu-2127-vitest.config.mjs`.
That temporary config selects `scripts/chatgpt-plugin.test.ts` in Node,
without the unrelated SPA setup. Discovery uses a real Claude CLI session
with `--plugin-dir`, `--tools Skill`, and `--no-session-persistence`.
Live requests use curl against the MCP endpoint, its resource metadata,
the issuer metadata, and the initial authorization route.

No application build or full smoke suite runs: these changes affect static
plugin packaging, and no application or worker source changes. The affected
browser gate runs the existing agent-connection sentinel automatically.

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
The hosted OAuth connection and core read workflows now pass. Full
tool-inventory coverage, a suitable text-export fixture, and private
delivery of reviewer credentials remain prerequisites. AQU-2135 tracks
the unusable REST fallback guidance found during export testing.
Do not check the portal's all-tools-tested acknowledgment yet.
