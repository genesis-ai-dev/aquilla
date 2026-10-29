# Claude connector verification

Issue: AQU-2127. Checked through 2026-10-29, America/Edmonton.

## Current continuation status

All six backend blocker PRs are merged. The production version document
reports `6b81e47` on `release/2026/10/29-01`; that commit contains all six
merges. The public sync health check reports Postgres and R2 healthy.
The package PR #1603 and specification PR aquilla-specs#30 remain open.
The following earlier results are historical evidence, not a current live
provider pass. See the updated [tool matrix](CLAUDE-CONNECTOR-TOOL-MATRIX.md).

The live catalog contains 42 tools, including `upload_artifact` and the
later `list_style_rules`. Initial post-deployment project calls correctly
reject an organization-mismatched grant. The user reconnects PluginReviewer
to continue isolated fixture testing. No project content changes in that
rejected attempt. The rebuilt package passes `--profile directory` and all
10 package tests. Explicit MIT metadata preserves the repository's license
when distributing the plugin folder separately.

After reconnection, the grant covers only organization `46486`. Hosted
`list_style_rules`, `transcription_status`, and `prepare_draft_cells` pass.
Draft confirmation and readback preserve AI provenance and leave human
validation false. The source upload, preview, import, confirmation and
readback also pass. The tool matrix records IDs and receipts. Successful
coverage reaches all 42 tools. Media confirmation applies two events with no
stale cells. Whisper transcribes the stored take as "Hello." with word timings
and 0.001263 credits charged. The Omnilingual comparison returns a provider
failure despite ready status. This is a remaining provider limitation, not
a passing Omnilingual test. No transcript is saved.

The authenticated directory portal reads all 42 tools with titles and
annotations. Its draft has the server, listing, Productivity category,
existing public logo, three use cases, publisher, CIMD authentication and
reviewer steps filled. The documentation URL returns HTTP 200; the live
privacy policy is readable through the web browser. Private reviewer
credentials and publisher policy acknowledgments remain required. The draft
is saved in its browser tab; no review submission or publication is claimed.
Self-tested is checked after all 42 tools succeed through the custom connector.
The seven publisher policy acknowledgments remain unchecked.


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
Initial verification uses read-only calls. Later writes use only the separate
test project authorized by the user.

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

## Isolated write verification

The user authorizes a separate **Claude connector test AQU-2127** project
and approves its forced-Ask creation proposal in Aquilla. Claude confirms
changeset `01a16912-6923-7181-b0d5-49ca8649f552` successfully, then verifies
project `f7bdfee7-1b1c-4a66-9040-dbb841ff0d1a` in organization `46486`.
The existing Review Spanish fixture stays unchanged.

Two reproducible limitations are tracked separately:

- [AQU-2136](https://linear.app/frontierrandd/issue/AQU-2136): the MCP
  create-project schema omits the command's supported language lanes.
- [AQU-2137](https://linear.app/frontierrandd/issue/AQU-2137): reading or
  waiting for a pre-creation proposal returns project `not_found`.
  Confirmation after human approval succeeds. Reads of later changesets
  in the existing project succeed.

We configure English source lane `f3c9f342` and Spanish target lane
`f9251aa1` through Aquilla, then import a synthetic four-cell USFM fixture.
File `01a16917-9cd6-7737-92f4-88c704ac41d7` contains a header and MAT 1:1–3.
This UI setup does not establish MCP import-tool coverage.

`prepare_translations` stages the Spanish MAT 1:1 target,
“Bienvenidos a nuestra comunidad de prueba.” Its Act-mode proposal has
one addition, no warnings, and no approval URL. `confirm_changeset`
commits changeset `01a16919-064c-7b17-b555-db006ed37c8d`, applying one
change with zero stale cells. The receipt event is
`01a16919-09d1-7a15-a655-54b438bb7a72` at 14:10:23 UTC.

`read_content` verifies persistence, and `read_history` returns the new
`target.cell.commit` event at sequence 8. The target remains unvalidated.
`get_changeset` and `wait_for_changeset` return the committed receipt.
`export_file` succeeds with USFM text: `exportMode: round-trip`,
`lossyVerseCount: 0`, and 226 bytes. Verse 1 contains the Spanish target;
untranslated verses retain their source text, as documented.

Settings tests also pass. `patch_settings` stages changeset
`01a1691b-5e36-76e5-98f7-116653c130f5` to set
`translationBrief.freeformNotes` to synthetic test text. Confirmation
and readback advance the settings version from 0 to 1.
`prepare_replace_project_settings` then stages restoration of the original
empty settings object in `01a1691b-c4fb-741e-9a65-00360fa4ee56`.
Confirmation and readback restore `{}` at version 2. Both use the current
version guard. Lanes remain unchanged. Claude observes an empty replacement
summary despite removing a key; this summary concern needs investigation.

`prepare_hide_cells` and `prepare_show_cells` also pass. We hide MAT 1:3,
verify `hidden: true`, then restore it and verify `hidden: false`.
Changesets are `01a1691c-db1a-7518-888d-50833f205582` and
`01a1691d-41f9-7871-9245-0ef4dba85464`. Each receipt applies one event
with zero stale cells. Server sequence advances from 8 to 9 to 10.
All four original source rows retain their text and order, and the Spanish
target remains unchanged. No permission change is required.

`prepare_insert_cell` commits a new synthetic source row after MAT 1:3.
Its changeset is `01a1691e-8112-7297-83a9-bc6670e488fd`.
`prepare_split_cell` then stages only that new row at a sentence boundary
in changeset `01a1691e-fa39-7dcc-b70e-a7a0cca1d9fa`. The split receipt
applies two events with zero stale cells and no warnings. These operations
use existing permissions and no approval URL. Readback returns the two
new rows at indexes 4 and 5; concatenating their values preserves the exact
original text. Server sequence advances from 10 to 11 to 13.

After explicit human approval on 2026-10-24 (Asia/Singapore),
`prepare_delete_cell` and `discard_changeset` pass. We stage deletion of
only the second synthetic row, discard proposal
`01a16aae-6d60-7eed-9db0-425b8566c75d`, and verify status `discarded`,
no receipt, and no content change at server sequence 13.

Fresh deletion proposals `01a16aae-d5a8-7a9f-9de6-d97a7b5b0eb1` and
`01a16aaf-2c28-7c53-8355-ab97962e5c08` remove the second and first
synthetic rows respectively. Each confirmation applies one event with
zero stale cells and no warnings. Receipt events are
`01a16aae-dac5-7d8c-845d-a2bb91741e64` and
`01a16aaf-316c-7f35-b2ef-7130db22dd3f`. Server sequence reaches 15.
Final readback returns the original four source rows in their original
order and the unchanged MAT 1:1 Spanish target, still unvalidated.
No other project or permission changes occur.

These checks remain pending in hosted Claude:

- `preview_import` and `prepare_import`: the read fixtures expose no
  existing agent source-artifact ID. No identifier is invented.
- `prepare_draft_cells`, `prepare_link_media`, `transcribe_audio`, and
  `transcription_status`.
  Import and media tool descriptions require REST artifact uploads.
  Transcription accepts inline base64 audio; it does not require an artifact.
  `artifacts-route.ts` authenticates ordinary REST requests, while
  `db/shared/api-credentials.ts:299` accepts only REST-audience OAuth tokens
  there. The hosted MCP grant cannot perform that documented upload.
  AQU-2135 also records this related artifact-workflow limitation.
- Excluded-organization rejection and connection revocation in hosted Claude.
- Complete tool-inventory coverage and private delivery of reviewer credentials.

Successful authenticated coverage currently includes 34 distinct tools:
23 read tools and eleven write tools. Failed binary export and pre-creation
reads are recorded separately from successful text export and changeset reads.
Do not interpret package validation or UI fixture setup as all-tool testing.

Direct fetching of Claude's client metadata from this machine returns 403.
The initial authorize route forwards parameters to the consent page without
fetching metadata. Its redirect alone does not establish metadata validation
or token exchange; the successful hosted flow above supplies that evidence.

## Native Claude Code limitation

`auth-worker/src/routes/mcp-oauth.ts` checks redirect URIs with exact array
membership. Claude's native client uses ephemeral loopback ports, which
[Claude's authentication requirements](https://claude.com/docs/connectors/building/authentication)
require matching without the port for both localhost and 127.0.0.1.
AQU-2154 fixes loopback port matching locally, with 47 passing OAuth/client
metadata tests. Non-loopback and confidential-client callbacks remain exact.
A real native OAuth session still requires the fix to be deployed.

## Blocker fixes prepared on 2026-10-24

The user authorizes fixing the remaining blockers. Each fix has an isolated
ticket branch. These are local results, not production deployment claims:

| Issue | Change | Verification |
| --- | --- | --- |
| AQU-2135 | MCP-native source/audio upload, nested import delegation, usable export guidance | 126 targeted worker tests; text/DOCX/multi-book commit composition; actual audio linking; 2 passing OAuth browser smoke tests |
| AQU-2136 | Language lanes in the declared create schema | 50 project-command tests, including forced approval and stored lanes |
| AQU-2137 | Owned pre-creation proposal reads and waits | 15 lifecycle tests, including credential/org/live-role denial |
| AQU-2154 | Registered native loopback port matching | 47 OAuth/client-metadata tests; auth typecheck; `npm run build` |
| AQU-2155 | Authorized organization-scoped MCP OAuth transcription | 18 transcription tests and worker typecheck |
| AQU-2156 | Matching identity Worker service binding for AI bridges | 33 draft/transcription tests; OAuth draft → commit → AI provenance readback; worker typecheck and Wrangler type generation |

The new `upload_artifact` raises the catalog from 40 to 41 tools.
The [tool matrix](CLAUDE-CONNECTOR-TOOL-MATRIX.md) separates hosted results
from local regression evidence. All six previously incomplete workflows
now have local regression coverage. Hosted drafting still returns
`job_failed` without staging. Hosted transcription status hits the
project-only credential gate. Both must be retested after deployment.

Cloudflare documents that unconfigured same-zone `fetch` can bypass a
sibling Worker route. AQU-2156 supplies service bindings instead; the
specific production drafting response remains unobserved. The empty
project generation model is not established as its cause, so we do not
change project settings based on that hypothesis.

The initial browser test environment fails because the shared 2 GiB Docker
VM runs more than twenty containers. Local SQL statements time out there.
A dedicated 4 GiB `aquilla-e2e` Colima profile isolates Postgres, preserves
the original stopped container, and leaves the active Docker context alone.
The final targeted OAuth artifact smoke passes in 7.4 seconds without
slow-request lines. The normal AQU-2135 pre-push gate also passes all 13 affected browser tests.
Earlier attempts are diagnostic failures, not passes.

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

Initial package validation does not require an application build because
it changes only static plugin packaging. The later blocker fixes change
worker code and run the checks recorded above. The full smoke gate remains
a merge/release requirement; no full-suite pass is claimed here.

The changed contract is plugin discovery: Claude consumes the shared HTTP
MCP configuration and three skills through `.claude-plugin/plugin.json`.
The existing OAuth catalog produces the tool names and annotations used
by those skill instructions. The regression in `scripts/chatgpt-plugin.test.ts`
checks that composition, shared identity/version, and HTTP transport.

The packaging commit changes no application UI, persistence, import, or
permission contract. Separate blocker fixes above change MCP import and
authorization behavior and include boundary regressions.
No new browser smoke journey is needed for static packaging.
The existing spec's `04-features/auth-and-account.md`,
**External agent project authorization**, distinguishes device authorization
from MCP OAuth discovery. Packaging changes neither contract; no spec edit
is required for packaging alone. The later fixes add MCP boundary rules
in a separate aquilla-specs worktree under AQU-2127. This does not reconcile
the broader spec backlog.

## Submission status

Not submitted. Listing text, setup instructions, existing icon, and reviewer
journeys are in `CLAUDE-CONNECTOR.md`. The existing repository is public;
the portal accepts `plugins/aquilla` as its plugin path. The package and
guides are pushed to the ticket branch; validation uses that branch.
The hosted OAuth connection and core read workflows now pass. Full
tool-inventory coverage and private delivery of reviewer credentials remain prerequisites. AQU-2135 tracks
the unusable REST fallback guidance found during export testing.
Do not check the portal's all-tools-tested acknowledgment yet.
