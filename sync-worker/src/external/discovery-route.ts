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

import { matchUiOnly, uiOnlyHint, uiOnlySection } from './ui-only'
import { AGENT_SKILLS } from '../../../db/shared/agent-skills'

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
      `0. Setting up a partner project? GET ${EXTERNAL_ROOT}/skills/project-setup and follow it (one ProjectSetup command, one approval).`,
      `1. GET ${EXTERNAL_ROOT}/me — confirm your token works; learn your mode (ask|act) and scope.`,
      `2. GET ${EXTERNAL_ROOT}/projects — find a projectId you can access.`,
      `3. GET ${EXTERNAL_ROOT}/projects/:projectId/files — list files; then .../files/:fileId/cells to read content.`,
      `3a. GET ${EXTERNAL_ROOT}/projects/:projectId — the project itself: settings plus the live settingsVersion a PatchSettings ifMatchVersion must match.`,
      `3b. GET ${EXTERNAL_ROOT}/commands/:kind — what a command kind takes, before you build one.`,
      `4. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets with { "commands": [{ "kind": "SetTranslation", "fileId": "...", "cellId": "...", "value": "..." }] } — stages a plan, returns { changeset, digest, summary, approvalUrl }.`,
      `5. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets/:id/commit — applies it (act mode). In ask mode this returns 428 confirmation_required: show the approvalUrl to a human, wait for their approval, then call commit again.`,
    ],
    endpoints: {
      'GET /api/v1/external/me': 'Which token am I: credentialId, autonomy mode, scope. Start here. Human identity (userId/username) is returned ONLY for a credential minted with pii enabled — see privacy below.',
      'GET /api/v1/external/orgs': 'List the organizations this credential covers (up to 100): { id, name, role, role_source }. See "orgScopedReads".',
      'GET /api/v1/external/orgs/:orgId/projects': 'List one org’s projects. An org outside the credential’s scope returns scope_denied.',
      'GET /api/v1/external/projects': 'List accessible projects (up to 100). Optional ?orgId= narrows to one org.',
      'GET /api/v1/external/projects/:projectId': 'One project: { id, name, org_id, archived, role, settings, settingsVersion, settingsUpdatedAt }. Read settingsVersion here before staging PatchSettings — its ifMatchVersion must equal it or prepare returns plan_stale.',
      'GET /api/v1/external/search?q=&projectIds=a,b': 'Full-text search SEVERAL projects in one call; every result carries its projectId. Optional side=source|target. See "orgScopedReads".',
      'GET /api/v1/external/commands': 'Index of every command kind you can stage. No auth needed.',
      'GET /api/v1/external/commands/:kind': 'One command kind’s full parameter doc, gotchas, and example (MCP: the describe_command tool). No auth needed.',
      'GET /api/v1/external/docs': 'This API map rendered as Markdown prose. No auth needed.',
      'GET /api/v1/external/skills': 'Index of agent skills — L2 playbooks that sequence existing commands (MCP: the get_skill tool). No auth needed.',
      'GET /api/v1/external/skills/:name': 'One skill’s full Markdown body. Start with project-setup when standing up a partner project. No auth needed.',
      'GET /api/v1/external/setup-template': 'The partner intake form as Markdown (to email a partner) plus the JSON schema of the ProjectSetup body it produces. No auth needed.',
      'POST /api/v1/external/setup-template/parse': 'Body { markdown } (the filled intake form) → { setup, warnings, nextStep }: a ProjectSetup body minus kind/projectId, every blank named, required: true on the four never-guess fields. Pure transform; no auth needed.',
      'GET /api/v1/external/projects/:projectId/files': 'List a project’s files.',
      'GET /api/v1/external/projects/:projectId/files/:fileId/cells': 'Read a file’s cells (source + target). Supports since/limit/cursor, and lane=<tag> to filter targets to one target-language lane (see multiLanguage).',
      'GET /api/v1/external/projects/:projectId/files/:fileId/export': 'Export a file in its delivered format (round-trip: the original artifact with current translations substituted in). Optional lane=<tag>. See "exporting" below.',
      'GET /api/v1/external/projects/:projectId/search?q=': 'Full-text search cells. Optional side=source|target.',
      'GET /api/v1/external/projects/:projectId/similar?cellId=': 'Translation memory: source cells most LIKE this one, each with its current target and a score in [0,1]. Pass cellId (the query cell is excluded) or text=<free text>, not both. Optional limit (default 10, max 50). LEXICAL ONLY — scored by term overlap, NOT by meaning: it will not find a paraphrase that shares no words. Use search when you know the words you want; use this when you have a line and want prior renderings of similar lines.',
      'GET /api/v1/external/projects/:projectId/cells/:cellId/history': 'Append-only event history for one cell.',
      'GET /api/v1/external/projects/:projectId/comments':
        'Reviewer comment threads, oldest first. Optional fileId, or fileId+cellId for one cell; limit (default 50, max 200) + cursor to page. parentCommentId null = thread root. `author` is a per-project pseudonym unless the credential was minted with real identities; `viaAgent` marks comments this API posted. Reply with an EmitEvents changeset carrying comment.create + parentCommentId.',
      'GET /api/v1/external/projects/:projectId/settings': 'Project settings blob + its live version: { projectId, settings, version, updatedAt }. Read this before staging a PatchSettings command — `version` is the ifMatchVersion that command requires. No settings row yet reads as {} at version 0.',
      'GET /api/v1/external/projects/:projectId/cells/:cellId/prompt-preview': 'The prompt the project copilot would actually send for this cell — assembled messages plus labeled parts (base instructions, brief, rules block, injected terms, retrieved examples, discourse context). Optional targetLang=<lane>, fileId=<id>. Use it to verify a PatchSettings prompt/terminology change instead of guessing.',
      'GET /api/v1/external/projects/:projectId/memory': 'Living Memory: the project brief plus every memory entry (examples, decisions, notes, observations) with its status — the same rows the in-app Memory page shows. Filter with ?status=proposed|approved|rejected|archived and ?kind=example|decision|note|observation|other. Each entry carries inRetrieval: whether the copilot is actually being given it.',
      'GET /api/v1/external/projects/:projectId/files/:fileId/cells/:cellId/memory': 'What the copilot’s retrieval would inject for that cell’s draft: the brief plus the capped approved-memory index. Retrieval is project-scoped today (no per-cell narrowing) — the response says so in retrieval.scope.',
      'GET /api/v1/external/projects/:projectId/quality': 'Quality signals per file: health score (0-100), coverage (total/filled/validated cells + percentages) and the project rollup. Optional fileId=<id> to scope to one file, lane=<tag> for one target-language lane. Same numbers the in-app health ring and progress surfaces show.',
      'GET /api/v1/external/projects/:projectId/terms/consistency': 'Term-consistency drift: per active concept, how many occurrences used an approved rendering, which cells used which rendering, and which cells used none. Optional fileId=<id>, lane=<tag>, onlyDrift=1 (findings with flagged cells only). Runs the same scan as the in-app "Check file" pass.',
      'POST /api/v1/external/projects/:projectId/artifacts': 'Upload raw bytes (max 25MB). Headers: x-artifact-name (required), content-type, x-artifact-kind (source|audio).',
      'GET /api/v1/external/projects/:projectId/artifacts/:artifactId': 'Artifact metadata (/content for bytes, /inspect for a format sniff).',
      'POST /api/v1/external/projects/:projectId/artifacts/:artifactId/parse': 'Parse a source artifact with the built-in importers. Default = preview { fileName, fileType, totalCells, sampleCells, warnings }; body { "stage": true } also stages a PlanImport changeset linking the artifact. See "importing" below.',
      'POST /api/v1/external/projects/:projectId/changesets': 'Prepare (stage) a changeset. Body { commands: [...], id?, autonomyMode? }. Command kinds: SetTranslation, PlanImport, LinkMedia, RenameFile, EmitEvents, PatchSettings, UpdateProjectSettings, CreateProject, CreateOrg, RenameProject, ArchiveProject, UnarchiveProject, InsertCell, DeleteCell, SplitCell, HideCell, ShowCell, SetSource, SetTranscription, SetTiming, SetTrackOverride — call describe_command (MCP) or see docs/COMMAND-REGISTRY.md for per-kind params, floors, and sole-command rules. See "settings" below for the PatchSettings shape. CreateOrg needs an unscoped credential and takes only { name }; the :projectId in the path is just the changeset’s filing id (no project is created) and its receipt carries orgId.',
      'GET /api/v1/external/projects/:projectId/changesets/:id': 'Changeset status/summary/digest/receipt/approvalUrl.',
      'POST /api/v1/external/projects/:projectId/changesets/:id/commit': 'Commit a prepared changeset. Idempotent; safe to retry.',
      'POST /api/v1/external/projects/:projectId/changesets/:id/discard': 'Discard a staged changeset.',
      'POST /api/v1/external/mcp': 'MCP server (JSON-RPC 2.0, streamable HTTP, same bearer token). Tools mirror the REST surface — see "mcp" below.',
    },
    privacy: {
      note:
        'Translator identity is not agent-readable by default (AQU-1180). Everything this API returns ends up in whatever AI console holds the token, so author fields are pseudonymous unless a human deliberately opted in.',
      authorFields:
        'Cell reads carry lastEditor and history events carry author. By default both are a stable per-project opaque id (e.g. "u_3f9ab21c"): you can tell that two edits came from the SAME person, and nothing else. The ids are per-project — the same translator is a different id in another project, so do not correlate across projects. Machine authors ("importer", "system", "agent") pass through under their real names.',
      pii: 'A credential minted with pii enabled returns real usernames, and GET /me additionally returns userId + username. Only an OWNER of the credential\'s org/project can mint one, and it is off unless they asked for it.',
      agentAuthorship:
        'A project may set agentAuthorship: "none", in which case lastEditor and author are ABSENT from the payload entirely (the key is missing, not null) regardless of the token. Do not treat a missing author as a data error; the project has opted out of authorship exposure. An agent may SET this to "none" (tightening — AQU-1282), and may never clear it.',
      auditing: 'Every read call is recorded against the calling credential (which project, which file or cell, how many rows).',
    },
    // AQU-1178: what is deliberately NOT here, so an agent stops guessing at
    // endpoints that will never exist. Same list the MCP get_capabilities tool
    // publishes and the 404 hints quote (sync-worker/src/external/ui-only.ts).
    uiOnly: uiOnlySection(),
    // AQU-1294: skills — server-owned sequencing prose. Same shared set the MCP
    // get_skill tool and the in-app harness serve (db/shared/agent-skills.ts).
    skills: {
      index: AGENT_SKILLS.map((s) => ({ name: s.name, title: s.title, oneLiner: s.oneLiner })),
      endpoint: `GET ${EXTERNAL_ROOT}/skills/:name`,
      note:
        'A skill sequences EXISTING commands and routes; it adds no capability and stages nothing on its own. project-setup: intake template → one ProjectSetup command → one approval → verification receipt.',
    },
    orgScopedReads: {
      note:
        'Credentials are scoped org-or-project. An ORG-scoped token can work a partner’s whole workspace from one credential: list its orgs, enumerate each org’s projects, and search several projects in one call. Scope only ever narrows — a PROJECT-scoped token sees exactly its one project (and that project’s org) from these routes, and naming anything outside the scope returns scope_denied rather than an empty list, so "not yours" never looks like "empty".',
      workflow: [
        `1. GET ${EXTERNAL_ROOT}/orgs → { data: [{ id, name, role, role_source }] } — the orgs this credential covers.`,
        `2. GET ${EXTERNAL_ROOT}/orgs/:orgId/projects (or ${EXTERNAL_ROOT}/projects?orgId=:orgId) → that org’s projects.`,
        `3. GET ${EXTERNAL_ROOT}/search?q=term&projectIds=proj-a,proj-b → one merged, rank-ordered result set; each row carries its projectId, and the response echoes the projectIds searched.`,
      ],
      maxProjectsPerSearch: 10,
      strictness:
        'Cross-project search is all-or-nothing: if ANY listed project is unknown, outside the credential’s scope, or one you have no membership on, the whole call fails (not_found / scope_denied / permission_denied) instead of returning a quietly partial result set. It also costs one search-rate-limit unit per project searched.',
      privacy:
        'These routes expose ids, names, and YOUR role level only — no org member lists, emails, or owner identities.',
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
      serverParseableFormats: ['csv', 'docx', 'json', 'md', 'obs', 'po', 'properties', 'sbv', 'srt', 'tsv', 'txt', 'usfm', 'vtt'],
      unsupportedFormats:
        'pptx, doc, html, xliff, tmx, usx, idml, paratext-project, zip need DOM/browser parsers and are not yet server-parseable — import them through the in-app Import dialog, or parse them yourself and stage raw PlanImport cells (POST .../changesets with a PlanImport command). A multi-book USFM artifact parses into one file per book; stage each book separately via resultIndex.',
    },
    livingMemory: {
      note:
        'Living Memory is what the copilot has learned about a project: one human-authored brief plus path-keyed entries (examples/<slug>.md, decisions/<slug>.md, notes/<file>/<cell>-<digest>.md, observations/…) that move proposed -> approved -> archived under human review. Only APPROVED entries reach a prompt, and only the most-recently-updated indexRenderCap of them; the copilot is given each one as path + first line and pulls full text just-in-time.',
      reading: [
        `GET ${EXTERNAL_ROOT}/projects/:projectId/memory — brief + entries + per-entry inRetrieval. Read this before proposing an entry: it tells you whether one already exists at that path and whether it was approved.`,
        `GET ${EXTERNAL_ROOT}/projects/:projectId/files/:fileId/cells/:cellId/memory — exactly what retrieval would inject for that cell's draft, so you can predict what the copilot is working from.`,
      ],
      privacy:
        'Author fields (createdBy/reviewedBy/brief.updatedBy) are per-project pseudonyms, never usernames — stable within a project, uncorrelatable across projects. Translator identity is not agent-readable.',
    },
    exporting: {
      note:
        'The other end of the import loop (AQU-858): pull a finished file back out in the format its consumer actually reads — USFM for Paratext, say — without a human clicking Export in the app. The export reconstructs the ORIGINAL artifact preserved at import time with the current translations substituted in; untranslated segments keep their source text so the file stays valid. The MCP tool export_file wraps the same route.',
      workflow: [
        `1. GET ${EXTERNAL_ROOT}/projects/:projectId/files — find the fileId.`,
        `2. GET ${EXTERNAL_ROOT}/projects/:projectId/files/:fileId/export (add ?lane=<tag> for one target-language lane) → the file bytes, with Content-Disposition naming it.`,
        '3. Check the fidelity headers before delivering (below), then hand the bytes to whatever consumes them.',
      ],
      fidelityHeaders: {
        'X-Export-Mode':
          'Absent = round-trip (translations were substituted). "raw-original" / "raw-sidecar" = this format has no server-side target serializer yet, so the response is the preserved ORIGINAL bytes with NO translations in them — do not deliver it as a translation.',
        'X-Usfm-Lossy-Verse-Count':
          'USFM only: verses whose intra-verse markers (footnotes, poetry, character markers) the plain-text substitution dropped. 0 = clean round-trip.',
      },
      roleFloor:
        'Export is gated HIGHER than reading: the floor is the org\'s exportMinRole setting, MAINTAINER by default (an org may raise or lower it). A VIEWER/CONTRIBUTOR credential that can read a project still gets permission_denied here, and retrying will not change that.',
      notes:
        'A file with no preserved source artifact returns not_found — it must be re-imported before it can be exported. Binary results (docx/pptx/idml side-cars) come back as raw bytes over REST; the MCP export_file tool cannot carry them (JSON-RPC is text) and fails with validation_failed naming this URL instead.',
    },
    settings: {
      note:
        'Project settings are read with GET .../projects/:projectId/settings and changed with the PatchSettings command — a FIELD-SCOPED write: keys you do not name are left byte-identical, so you can never clobber settings you have not read. Prefer it over UpdateProjectSettings (deprecated whole-blob replace).',
      workflow: [
        `1. GET ${EXTERNAL_ROOT}/projects/:projectId/settings → { projectId, settings, version, updatedAt }.`,
        `2. POST ${EXTERNAL_ROOT}/projects/:projectId/changesets with { "commands": [{ "kind": "PatchSettings", "projectId": "...", "ops": [{ "key": "targetLanes", "value": ["es", "pt"] }], "ifMatchVersion": <that version> }] } — one op per key (duplicates rejected); top-level keys only; each op replaces its key's value wholesale. JSON cannot carry undefined, so write null rather than deleting a key.`,
        '3. Commit as usual (ask mode: a human approves at the approvalUrl first). `ifMatchVersion` is re-checked at commit — a racing writer surfaces as plan_stale, so re-read and re-prepare.',
      ],
      rules:
        'PatchSettings must be the SOLE command in its changeset. Floors: `terminology` needs the org termbase-edit floor (default PROJECT_LEAD 500); every other key needs MAINTAINER 600. The policy keys that govern agent oversight itself — agentMemoryAutonomy, validationRoleFloor, validationNamedUsers, validationCount, validationCountAudio, allowSelfValidation, harmonize_min_role, contributeToGlobalTm, cellEditingFloor, agentAuthorship — are writable in the RESTRICTIVE direction ONLY (AQU-1282): a write that TIGHTENS oversight stages like any other, a write that would LOOSEN it returns permission_denied naming the key in details.loosening, and the direction is re-checked against live settings at commit. GET /api/v1/external/commands/PatchSettings has the per-key direction table. UpdateProjectSettings (deprecated whole-blob replace) is still rejected outright if its blob would change any policy key.',
    },
    multiLanguage: {
      note:
        'A project can hold MULTIPLE target languages at once via target-language lanes. A lane is a language tag (e.g. "es", "pt") registered in the project settings array settings.targetLanes; every cell keeps one shared source plus one independent target per lane. Omitting the lane everywhere uses the default lane — single-language callers need no changes. Preconditions/drift are lane-scoped: edits to the same cell in different lanes never invalidate each other\'s changesets.',
      workflow: [
        `1. Register the lanes once: GET .../settings for the live version, then stage { "kind": "PatchSettings", "projectId": "...", "ops": [{ "key": "targetLanes", "value": ["es", "pt"] }], "ifMatchVersion": <that version> } — field-scoped, so the rest of the settings blob is untouched (see "settings" above).`,
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
        rate_limited: '429 — too many requests from this credential in the trailing 15 minutes (enforced per credential on every external route; back off and retry later). CreateOrg has its own, much tighter cap: 5 staged org creations per credential per 15 minutes.',
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
  // AQU-1178: a probe at a deliberately browser-only surface is not a typo —
  // saying "no such route" invites another guess, so name the exclusion, the
  // reason, and where a human does it instead.
  const uiOnly = matchUiOnly(pathname)
  const hint = uiOnly
    ? uiOnlyHint(uiOnly, EXTERNAL_ROOT)
    : `GET ${EXTERNAL_ROOT} returns the full API map (endpoints, auth, quickstart, and a uiOnly list of intentional exclusions). Common fixes: project routes live under ${EXTERNAL_ROOT}/projects/:projectId/..., and in production this worker is mounted at https://api.aquilla.app/sync — the /sync prefix is part of the URL.`

  return Response.json(
    {
      error: {
        code: 'not_found',
        message: `no external API route matches ${pathname}`,
        details: {
          hint,
          ...(uiOnly ? { uiOnly: uiOnly.id } : {}),
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
