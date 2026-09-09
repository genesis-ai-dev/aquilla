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

/** Where the map points callers for prose docs.
 *
 *  AQU-1222: this used to be
 *  `https://github.com/genesis-ai-dev/aquilla/blob/main/docs/api/QUICKSTART.md`
 *  — a PRIVATE repo, so the one link every external agent was handed 404'd for
 *  everyone outside the org. The API now documents itself: this path is served
 *  by this same unauthenticated route, from the same static map below, so it
 *  cannot rot and cannot 404 for a logged-out caller. Host-relative for the
 *  same reason the rest of the map is — the caller already reached this host. */
export const DOCS_URL = `${EXTERNAL_ROOT}/docs`

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
      `3a. GET ${EXTERNAL_ROOT}/projects/:projectId — the project itself: settings plus the live settingsVersion a PatchSettings ifMatchVersion must match.`,
      `3b. GET ${EXTERNAL_ROOT}/commands/:kind — what a command kind takes, before you build one.`,
      `4. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets with { "commands": [{ "kind": "SetTranslation", "fileId": "...", "cellId": "...", "value": "..." }] } — stages a plan, returns { changeset, digest, summary, approvalUrl }.`,
      `5. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets/:id/commit — applies it (act mode). In ask mode this returns 428 confirmation_required: show the approvalUrl to a human, wait for their approval, then call commit again.`,
    ],
    endpoints: {
      'GET /api/v1/external/me': 'Who am I: userId, username, mode, scope. Start here.',
      'GET /api/v1/external/projects': 'List accessible projects (up to 100).',
      'GET /api/v1/external/projects/:projectId': 'One project: { id, name, org_id, archived, role, settings, settingsVersion, settingsUpdatedAt }. Read settingsVersion here before staging PatchSettings — its ifMatchVersion must equal it or prepare returns plan_stale.',
      'GET /api/v1/external/commands': 'Index of every command kind you can stage. No auth needed.',
      'GET /api/v1/external/commands/:kind': 'One command kind’s full parameter doc, gotchas, and example (MCP: the describe_command tool). No auth needed.',
      'GET /api/v1/external/docs': 'This API map rendered as Markdown prose. No auth needed.',
      'GET /api/v1/external/projects/:projectId/files': 'List a project’s files.',
      'GET /api/v1/external/projects/:projectId/files/:fileId/cells': 'Read a file’s cells (source + target). Supports since/limit/cursor, and lane=<tag> to filter targets to one target-language lane (see multiLanguage).',
      'GET /api/v1/external/projects/:projectId/search?q=': 'Full-text search cells. Optional side=source|target.',
      'GET /api/v1/external/projects/:projectId/cells/:cellId/history': 'Append-only event history for one cell.',
      'POST /api/v1/external/projects/:projectId/artifacts': 'Upload raw bytes (max 25MB). Headers: x-artifact-name (required), content-type, x-artifact-kind (source|audio).',
      'GET /api/v1/external/projects/:projectId/artifacts/:artifactId': 'Artifact metadata (/content for bytes, /inspect for a format sniff).',
      'POST /api/v1/external/projects/:projectId/artifacts/:artifactId/parse': 'Parse a source artifact with the built-in importers. Default = preview { fileName, fileType, totalCells, sampleCells, warnings }; body { "stage": true } also stages a PlanImport changeset linking the artifact. See "importing" below.',
      'POST /api/v1/external/projects/:projectId/changesets': 'Prepare (stage) a changeset. Body { commands: [...], id?, autonomyMode? }. Command kinds: SetTranslation, PlanImport, CreateProject, UpdateProjectSettings, LinkMedia.',
      'GET /api/v1/external/projects/:projectId/changesets/:id': 'Changeset status/summary/digest/receipt/approvalUrl.',
      'POST /api/v1/external/projects/:projectId/changesets/:id/commit': 'Commit a prepared changeset. Idempotent; safe to retry.',
      'POST /api/v1/external/projects/:projectId/changesets/:id/discard': 'Discard a staged changeset.',
      'POST /api/v1/external/mcp': 'MCP server (JSON-RPC 2.0, streamable HTTP, same bearer token). Tools mirror the REST surface — see "mcp" below.',
    },
    importing: {
      note:
        'Artifact-first file imports: preserve the ORIGINAL bytes first (enables round-trip export), then let the server parse them with Aquilla\'s built-in importers and stage a human-approvable PlanImport changeset. The MCP tools preview_import / prepare_import wrap steps 2–3.',
      workflow: [
        `1. POST ${EXTERNAL_ROOT}/projects/:projectId/artifacts with header "x-artifact-name: <filename>" and the raw file bytes as the body (max 25MB) → { artifactId }.`,
        `2. POST ${EXTERNAL_ROOT}/projects/:projectId/artifacts/:artifactId/parse (empty body) → PREVIEW: { fileName, fileType, totalCells, sampleCells, warnings, results }. Pass { "fileType": "..." } to override detection (required for po/properties/obs/sbv, which are not sniffable).`,
        `3. Same route with { "stage": true } (plus optional fileName/sourceLanguage/targetLanguage/resultIndex) → stages a PlanImport changeset linking the artifact; returns the standard { changeset, digest, summary, approvalUrl }.`,
        `4. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets/:id/commit as usual (ask mode: human approval at the approvalUrl first).`,
      ],
      limits: {
        maxArtifactBytes: 25 * 1024 * 1024,
        planImportMaxCells: 5000,
      },
      serverParseableFormats: ['csv', 'json', 'md', 'obs', 'po', 'properties', 'sbv', 'srt', 'tsv', 'txt', 'usfm', 'vtt'],
      unsupportedFormats:
        'docx, pptx, doc, html, xliff, tmx, usx, idml, paratext-project, zip need DOM/browser parsers and are not yet server-parseable — import them through the in-app Import dialog, or parse them yourself and stage raw PlanImport cells (POST .../changesets with a PlanImport command). A multi-book USFM artifact parses into one file per book; stage each book separately via resultIndex.',
    },
    multiLanguage: {
      note:
        'A project can hold MULTIPLE target languages at once via target-language lanes. A lane is a language tag (e.g. "es", "pt") registered in the project settings array settings.targetLanes; every cell keeps one shared source plus one independent target per lane. Omitting the lane everywhere uses the default lane — single-language callers need no changes. Preconditions/drift are lane-scoped: edits to the same cell in different lanes never invalidate each other\'s changesets.',
      workflow: [
        `1. Register the lanes once: stage { "kind": "UpdateProjectSettings", "projectId": "...", "settings": { ...existing settings, "targetLanes": ["es", "pt"] }, "ifMatchVersion": <live version> } (the write replaces the whole settings blob — merge, don't overwrite).`,
        '2. Write per lane: add "laneId": "es" (or "pt") to each SetTranslation command. An unregistered laneId is rejected at prepare with validation_failed.',
        `3. Read per lane: GET .../files/:fileId/cells?lane=es returns source cells plus only that lane's target cells; omit lane for all lanes (each target row carries its targetLang).`,
        '4. Importing a file can seed several lanes at once: each PlanImport cell takes "variants": [{ "laneId": "es", "content": "..." }, { "laneId": "pt", "content": "..." }].',
      ],
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
        plan_stale: '409 — state drifted since prepare; re-prepare a fresh changeset. details.status distinguishes "stale" (the plan no longer describes reality) from "superseded" (its end-state already exists — a human did the work; nothing to re-prepare).',
        conflict: '409 — CreateProject id claimed by someone else; pick another id and re-prepare.',
        confirmation_required: '428 — ask-mode commit needs a human approval at the approvalUrl first.',
        rate_limited: '429 — too many requests from this credential in the trailing 15 minutes (enforced per credential on every external route; back off and retry later).',
        job_failed: '500 — server-side failure; safe to retry once.',
      },
    },
  }
}

/** Render any JSON value from the API map as Markdown.
 *
 *  Deliberately generic: `apiMap()` above stays the SINGLE source of truth and
 *  this function contributes no prose of its own, so the human-readable docs
 *  cannot drift from the machine-readable map the way a hand-written file in
 *  another repo did (AQU-1222). */
function renderMarkdown(value: unknown, depth: number): string[] {
  if (value === null || value === undefined) return ['_none_']
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]

  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      const [head = '', ...tail] = renderMarkdown(item, depth + 1)
      out.push(`- ${head}`, ...tail.map((line) => `  ${line}`))
    }
    return out
  }

  const out: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const rendered = renderMarkdown(child, depth + 1)
    if (rendered.length === 1 && !rendered[0].startsWith('- ')) {
      out.push(`- **${key}** — ${rendered[0]}`)
    } else {
      // h2..h6 — Markdown has no deeper heading level.
      out.push('', `${'#'.repeat(Math.min(6, depth + 2))} ${key}`, '', ...rendered, '')
    }
  }
  return out
}

/** GET /api/v1/external/docs — the API map as prose, so `docs:` points at
 *  something an external, logged-out caller can actually open. */
function docsMarkdown(): string {
  return ['# Aquilla Agent API', '', ...renderMarkdown(apiMap(), 0), ''].join('\n')
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

  if (path === DOCS_URL) {
    if (request.method !== 'GET') {
      return Response.json(
        { error: { code: 'validation_failed', message: `use GET ${DOCS_URL} for the API docs` } },
        { status: 405, headers: { Allow: 'GET' } },
      )
    }
    return new Response(docsMarkdown(), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    })
  }

  if (path.startsWith(`${EXTERNAL_ROOT}/`)) return externalNotFound(path)

  return null
}
