// Agent API discovery root (AQU-533 cold-start hardening).
//
//   GET /api/v1/external          — unauthenticated machine-readable API map.
//   *   /api/v1/external/<other>  — JSON 404 fallback with a pointer back to
//                                   the map (mounted AFTER every real external
//                                   handler in index.ts, so it only ever sees
//                                   paths nothing else claimed).
//
// Rationale: an agent holding only an `aqk_` token has no way to learn the
// path shape, the two-host split, or the prepare→approve→commit model — every
// wrong guess used to be a bare plain-text 404. This route makes the API
// self-describing at its root so a cold-start agent converges in one request
// instead of burning tokens guessing. It exposes no data (static text only),
// so it is deliberately unauthenticated.

const EXTERNAL_ROOT = '/api/v1/external'

export const DOCS_URL =
  'https://github.com/genesis-ai-dev/aquilla/blob/main/docs/api/QUICKSTART.md'

/** One-line auth teaching string, shared with the 401 sites in this tier. */
export const AUTH_HINT =
  `send header "Authorization: Bearer aqk_..." (an Aquilla API credential); GET ${EXTERNAL_ROOT} for the API map`

/** The static API map served at the discovery root. Host-relative paths on
 *  purpose — the caller already reached this host, so relative paths are the
 *  only ones guaranteed correct in every environment. */
function apiMap(): Record<string, unknown> {
  return {
    name: 'Aquilla Agent API',
    version: 'v1.1',
    docs: DOCS_URL,
    conceptualModel: [
      'Reads are plain authenticated GETs.',
      'Every WRITE is a two-step changeset: (1) prepare — stage an immutable plan, get back { changesetId, digest, summary }; (2) commit — apply it by echoing that digest.',
      'Your credential has an autonomy mode. mode=act: commit applies immediately. mode=ask: commit fails with confirmation_required until a human opens the approvalUrl (returned by prepare) in a browser and approves; then call commit again.',
      'Nothing is ever applied by prepare alone, and approval alone never applies anything — your commit call does.',
    ],
    auth: {
      header: 'Authorization: Bearer aqk_...',
      note:
        'Same token for REST and MCP. Tokens are minted by a signed-in human at Preferences → Account → "API tokens" in the Aquilla app (or POST /api/v2/credentials on the identity host with a browser-session JWT — NOT with an aqk_ token). 401 means the token is missing, malformed, revoked, or expired.',
    },
    hosts: {
      thisHost: 'sync — everything under /api/v1/external/* (reads, artifacts, changesets, MCP) lives here.',
      identityHost:
        'A separate host serves /api/v2/credentials (minting, browser session required) and the human approval pages. In production: this host is https://api.aquilla.app/sync, identity is https://api.aquilla.app/identity. Agents normally never call the identity host.',
    },
    quickstart: [
      `1. GET ${EXTERNAL_ROOT}/me — confirm your token works; learn your mode (ask|act) and scope.`,
      `2. GET ${EXTERNAL_ROOT}/projects — find a projectId you can access.`,
      `3. GET ${EXTERNAL_ROOT}/projects/:projectId/files — list files; then .../files/:fileId/cells to read content.`,
      `4. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets with { "commands": [{ "kind": "SetTranslation", "fileId": "...", "cellId": "...", "value": "..." }] } — stages a plan, returns { changeset, digest, summary, approvalUrl }.`,
      `5. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets/:id/commit — applies it (act mode). In ask mode this returns 428 confirmation_required: show the approvalUrl to a human, wait for their approval, then call commit again.`,
    ],
    endpoints: {
      'GET /api/v1/external/me': 'Who am I: userId, username, mode, scope. Start here.',
      'GET /api/v1/external/projects': 'List accessible projects (up to 100).',
      'GET /api/v1/external/projects/:projectId/files': 'List a project’s files.',
      'GET /api/v1/external/projects/:projectId/files/:fileId/cells': 'Read a file’s cells (source + target). Supports since/limit/cursor.',
      'GET /api/v1/external/projects/:projectId/search?q=': 'Full-text search cells. Optional side=source|target.',
      'GET /api/v1/external/projects/:projectId/cells/:cellId/history': 'Append-only event history for one cell.',
      'POST /api/v1/external/projects/:projectId/artifacts': 'Upload raw bytes (max 25MB). Headers: x-artifact-name (required), content-type, x-artifact-kind (source|audio).',
      'GET /api/v1/external/projects/:projectId/artifacts/:artifactId': 'Artifact metadata (/content for bytes, /inspect for a format sniff).',
      'POST /api/v1/external/projects/:projectId/changesets': 'Prepare (stage) a changeset. Body { commands: [...], id?, autonomyMode? }. Command kinds: SetTranslation, PlanImport, CreateProject, UpdateProjectSettings, LinkMedia.',
      'GET /api/v1/external/projects/:projectId/changesets/:id': 'Changeset status/summary/digest/receipt/approvalUrl.',
      'POST /api/v1/external/projects/:projectId/changesets/:id/commit': 'Commit a prepared changeset. Idempotent; safe to retry.',
      'POST /api/v1/external/projects/:projectId/changesets/:id/discard': 'Discard a staged changeset.',
      'POST /api/v1/external/mcp': 'MCP server (JSON-RPC 2.0, streamable HTTP, same bearer token). Tools mirror the REST surface — see "mcp" below.',
    },
    mcp: {
      endpoint: `${EXTERNAL_ROOT}/mcp`,
      note:
        'Any MCP client that speaks streamable HTTP with bearer auth works. First tool to call: get_capabilities.',
      claudeCode:
        'claude mcp add aquilla --transport http <this-host>/api/v1/external/mcp --header "Authorization: Bearer $AQUILLA_TOKEN"',
      mcpJson: {
        mcpServers: {
          aquilla: {
            type: 'http',
            url: '<this-host>/api/v1/external/mcp',
            headers: { Authorization: 'Bearer aqk_your_token_here' },
          },
        },
      },
    },
    errors: {
      shape: '{ "error": { "code", "message", "details?" } }',
      codes: {
        permission_denied: '401/403 — bad token, or your live project role is below the operation’s minimum. Do not retry unchanged.',
        scope_denied: '403 — credential’s org/project scope does not cover this resource.',
        validation_failed: '400 — malformed request; fix per message, do not retry unchanged.',
        not_found: '404 — no such resource (or not visible to you).',
        plan_stale: '409 — state drifted since prepare; re-prepare a fresh changeset.',
        conflict: '409 — CreateProject id claimed by someone else; pick another id and re-prepare.',
        confirmation_required: '428 — ask-mode commit needs a human approval at the approvalUrl first.',
        rate_limited: '429 — reserved, not currently enforced.',
        job_failed: '500 — server-side failure; safe to retry once.',
      },
    },
  }
}

/** JSON body for unmatched /api/v1/external/* paths — same error envelope as
 *  every other external error, plus enough of a hint to self-correct. */
function externalNotFound(pathname: string): Response {
  return Response.json(
    {
      error: {
        code: 'not_found',
        message: `no external API route matches ${pathname}`,
        details: {
          hint: `GET ${EXTERNAL_ROOT} returns the full API map (endpoints, auth, quickstart). Common fixes: project routes live under ${EXTERNAL_ROOT}/projects/:projectId/..., and in production this worker is mounted at https://api.aquilla.app/sync — the /sync prefix is part of the URL.`,
          docs: DOCS_URL,
        },
      },
    },
    { status: 404 },
  )
}

/**
 * Mounted in index.ts AFTER every other external handler: serves the map at
 * the root, and converts what would have been a bare plain-text 404 into a
 * self-describing JSON 404 for anything else under /api/v1/external.
 */
export function handleExternalDiscoveryRequest(request: Request): Response | null {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === EXTERNAL_ROOT || path === `${EXTERNAL_ROOT}/`) {
    if (request.method !== 'GET') {
      return Response.json(
        {
          error: {
            code: 'validation_failed',
            message: `use GET ${EXTERNAL_ROOT} for the API map`,
          },
        },
        { status: 405, headers: { Allow: 'GET' } },
      )
    }
    return Response.json(apiMap())
  }

  if (path.startsWith(`${EXTERNAL_ROOT}/`)) return externalNotFound(path)

  return null
}
