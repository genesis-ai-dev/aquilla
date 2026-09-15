// MCP tool catalog for the Aquilla Agent API (AQU-533 §4).
//
// The DESCRIPTIONS ARE THE PUBLIC DOCS — per the spec, an agent must be able to
// learn the whole API from `get_capabilities` + these tool descriptions alone
// (the cold-start gate, §6.10). Keep them outcome-oriented and specific: name
// the workflow each tool sits in, the error codes it can return, and the next
// tool to call. `inputSchema` is JSON Schema (draft 2020-12 subset) so hosts can
// validate arguments before dispatch.

/** A single MCP tool definition as returned by tools/list. */
export interface McpToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

const projectIdProp = {
  projectId: { type: 'string', description: 'Aquilla project id (TEXT primary key).' },
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'get_capabilities',
    description:
      'Discover what this API and THIS credential can do before attempting anything. ' +
      'Returns the API version, the autonomy mode of the calling credential (ask|act), ' +
      'the domain command kinds available (SetTranslation, PlanImport, CreateProject, ' +
      'UpdateProjectSettings, LinkMedia — PlanImport stages via preview_import/' +
      'prepare_import or REST, the other four stage/commit via ' +
      'prepare_translations/confirm_changeset — see the returned importing, ' +
      'projectLifecycle and linkMedia fields for per-kind rules), the operational limits (changeset ' +
      'expiry, PlanImport max cells, artifact max bytes, max commands per changeset), the ' +
      'full list of stable machine-actionable error codes, and an explanation of the ' +
      'ask-mode approval flow (prepare -> approvalUrl -> a human approves in a browser -> ' +
      'confirm_changeset). This is the recommended first call: it tells an agent its ' +
      'ceiling so it does not attempt commits it cannot make. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_identity_and_scope',
    description:
      'Return the identity and scope resolved from the calling credential: userId, ' +
      'username, autonomy mode (ask|act), the org and/or project the credential is ' +
      'scoped to (null means unscoped/any), and the credentialId. Use this to confirm ' +
      'which user you are acting as and which resources you may touch. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_projects',
    description:
      'List up to 100 projects the credential owner can access (via project membership, ' +
      'project creation, or org membership), further narrowed to the credential org/project ' +
      'scope. Archived projects are excluded. Each item has { id, name, org_id, role_source } ' +
      'where role_source hints how access is granted (creator|member|org). Use before ' +
      'get_project / search_project to find a project id. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_project',
    description:
      'Fetch a single project by id after checking the credential scope and that the owner ' +
      'has at least VIEWER role on it. Returns { id, name, org_id, archived, role } or a ' +
      'not_found / scope_denied / permission_denied tool error.',
    inputSchema: {
      type: 'object',
      properties: { ...projectIdProp },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_project',
    description:
      'Full-text search a project\'s cells (the read/grep primitive). Returns matching ' +
      'source and/or target cells so an agent can assemble translation context (prior ' +
      'renderings, glossary hits, adjacent cells). Args: projectId (required), q (required, ' +
      'the query), side (optional, "source"|"target"), limit (optional). Returns ' +
      '{ data, nextCursor }. An invalid query returns a validation_failed tool error.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        q: { type: 'string', description: 'Search query string.' },
        side: { type: 'string', enum: ['source', 'target'], description: 'Restrict to one side.' },
        limit: { type: 'number', description: 'Max results (default 50).' },
      },
      required: ['projectId', 'q'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_similar_cells',
    description:
      'Translation memory (the "how did we render lines like this before?" primitive). ' +
      'Returns the source cells most SIMILAR to a given line, each with its current ' +
      'target and a score in [0,1] (1 = identical wording), so you can reuse an existing ' +
      'rendering instead of inventing one. Args: projectId (required), then exactly one of ' +
      'cellId (a source cell in the project — it is excluded from its own results) or text ' +
      '(free text); limit (optional, default 10, max 50). Returns { data, nextCursor } where ' +
      'each row is { cellId, fileId, sourceValue, targetValue, targetLang, score }; cells ' +
      'with no target yet are never returned. SIMILARITY IS LEXICAL (shared terms), NOT ' +
      'semantic — a paraphrase with no words in common scores 0. Prefer search_project when ' +
      'you already know which words to look for.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        cellId: { type: 'string', description: 'Source cell to find precedents for.' },
        text: { type: 'string', description: 'Free text to find precedents for.' },
        limit: { type: 'number', description: 'Max results (default 10, max 50).' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_content',
    description:
      'Read project content. Omit fileId to LIST the project\'s files; provide fileId to ' +
      'READ that file\'s cells (source + target). Supports incremental reads: pass since ' +
      '(a server sequence) to fetch only changed cells, and limit/cursor for pagination. ' +
      'Multi-language projects: a cell can carry one target per LANE (a language tag ' +
      'registered in the project\'s settings.targetLanes, e.g. "es", "pt" — see ' +
      'get_capabilities.multiLanguage). Pass lane to filter target cells to one lane ' +
      '(source cells are always included); omit it to get every lane — each target row ' +
      'carries its targetLang. Returns { data, nextCursor, ... }. Use this together with ' +
      'search_project to gather context before staging translations.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        fileId: { type: 'string', description: 'Omit to list files; provide to read its cells.' },
        since: { type: 'number', description: 'Only cells changed after this server seq (delta read).' },
        limit: { type: 'number', description: 'Page size.' },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a prior nextCursor.' },
        lane: {
          type: 'string',
          description:
            'Target-language lane filter (e.g. "es"). Only target cells in this lane are returned; omit for all lanes.',
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_history',
    description:
      'Read the append-only event history for one cell (the git-log/blame primitive): every ' +
      'source and target event on that cell, newest first, with author, timestamps, kind, ' +
      'and payload. Args: projectId, cellId. Use to understand who changed a translation and ' +
      'why before overwriting it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        cellId: { type: 'string', description: 'Cell id whose history to read.' },
      },
      required: ['projectId', 'cellId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_prompt_preview',
    description:
      'See the prompt the project copilot would ACTUALLY send when drafting one cell — base ' +
      'instructions after language substitution, the translation brief, the compiled rules ' +
      'block (project/org rules plus terminology), the retrieved few-shot examples, and the ' +
      'preceding approved-target discourse window — as both the assembled system+user ' +
      'messages and the same content labeled by origin. Args: projectId, cellId, optional ' +
      'targetLang (target-language lane tag; "" = default lane) and fileId (only needed when ' +
      'the same cellId exists in more than one file). This is the verification half of prompt ' +
      'tuning: after PatchSettings changes systemPrompt / completionSettings / ' +
      'translationBrief / rules, or after a terminology entry lands, call this on a ' +
      'representative cell to confirm the change actually reached the model instead of ' +
      'inferring it from a draft. Read-only — it drafts nothing and spends no credits. ' +
      'Returns not_found if the cell has no source row in this project, and ' +
      'scope_denied / permission_denied like every other read. `warnings` names anything the ' +
      'live draft call adds that a read cannot reproduce (footnote output contracts, ' +
      'per-device provider overrides).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        cellId: { type: 'string', description: 'Cell id to preview the prompt for.' },
        targetLang: {
          type: 'string',
          description: 'Target-language lane tag. Omit or "" for the project default lane.',
        },
        fileId: {
          type: 'string',
          description: 'Disambiguates a cellId present in more than one file.',
        },
      },
      required: ['projectId', 'cellId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_memory',
    description:
      'Read a project’s Living Memory: the human-authored project brief plus every memory ' +
      'entry the copilot learns from — examples (source→target pairs), decisions (standing ' +
      'rendering rules), notes (per-cell rationale), and observations. Same rows a human ' +
      'sees on the project’s Memory page, newest first. Each entry carries its path, kind, ' +
      'status (proposed|approved|rejected|archived), full content, humanEdited, and ' +
      '`inRetrieval` — whether the copilot is ACTUALLY being given it (only approved entries ' +
      'within the index render cap are). Call this BEFORE proposing a memory entry: it shows ' +
      'whether one already exists at that path, whether a human approved it, and whether a ' +
      'human has edited it (human-edited entries are human-owned — raise a question instead ' +
      'of re-proposing over them). Author fields are per-project pseudonyms, never usernames. ' +
      'Args: projectId, optional status, kind, limit, cursor. Errors: permission_denied, ' +
      'scope_denied, validation_failed (unknown status/kind), rate_limited.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        status: {
          type: 'string',
          enum: ['proposed', 'approved', 'rejected', 'archived'],
          description: 'Only entries in this state. Omit for all states (what the in-app page shows).',
        },
        kind: {
          type: 'string',
          enum: ['example', 'decision', 'note', 'observation', 'other'],
          description: 'Only entries of this kind (derived from the path prefix).',
        },
        limit: { type: 'number', description: 'Entries per page (1-200, default 50).' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous nextCursor.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_cell_memory',
    description:
      'Show what the copilot’s memory retrieval would inject for ONE cell’s draft: the ' +
      'project brief plus the approved-memory index it is given (path + first line per ' +
      'entry, which is all the prompt carries — full text is fetched just-in-time). Use it ' +
      'to predict what the copilot is working from before asking it to draft, or to explain ' +
      'a draft after the fact. NOTE the `retrieval.scope` field: retrieval is currently ' +
      'PROJECT-scoped, i.e. the same brief and index for every cell in the project, with no ' +
      'per-cell ranking or filtering — do not assume this returned set was narrowed to your ' +
      'cell. `retrieval.truncated` tells you approved entries exist that are NOT being ' +
      'injected. Args: projectId, fileId, cellId. Errors: not_found (no such cell), ' +
      'permission_denied, scope_denied, rate_limited.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        fileId: { type: 'string', description: 'File the cell lives in.' },
        cellId: { type: 'string', description: 'Cell whose retrieval context to preview.' },
      },
      required: ['projectId', 'fileId', 'cellId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_quality',
    description:
      'Audit a project\'s quality WITHOUT recomputing anything: per-file health score ' +
      '(0-100, the mean confidence over translated cells) plus coverage — total, filled ' +
      'and validated cell counts and their percentages — and the project-level rollup. ' +
      'These are the SAME numbers the human sees on the in-app health ring and progress ' +
      'surfaces (this tool delegates to the routes those surfaces read), so never derive ' +
      'health or coverage yourself from read_content: your denominators will not match ' +
      'theirs. Args: projectId; optional fileId to scope to one file, lane for one ' +
      'target-language lane, limit/offset to page the per-file list. Returns ' +
      '{ projectHealth, coverage, data: [{ fileId, name, health, coverage, ... }], ' +
      'nextCursor }. health is null for a file with no translated cells (not started, ' +
      'not unhealthy). Errors: scope_denied (403) if your credential is scoped to a ' +
      'different project, not_found (404) for an unknown fileId, rate_limited (429).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        fileId: { type: 'string', description: 'Scope to one file; omit for the whole project (up to 200 files).' },
        lane: { type: 'string', description: 'Target-language lane (e.g. "es"). Omit for the default lane.' },
        limit: { type: 'number', description: 'Per-file page size.' },
        offset: { type: 'number', description: 'Per-file page offset.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_term_consistency',
    description:
      'Answer "which terms are rendered inconsistently, and where?". For every ACTIVE ' +
      'termbase concept with at least one approved (preferred|admitted) rendering, returns ' +
      'totalOccurrences (translated cells whose SOURCE matches the concept\'s source term), ' +
      'consistentCount + consistencyPercent, renderingUsage (which approved rendering was ' +
      'used in which cellIds — the variant map), and flaggedCells (occurrences whose target ' +
      'used NONE of the approved renderings — the drift). Runs the same scan as the in-app ' +
      '"Check file" pass, so your findings match what a reviewer sees. Args: projectId; ' +
      'optional fileId to scope to one book/file, lane, onlyDrift=true to return only ' +
      'concepts with flagged cells, limit/offset. Feed flaggedCells straight into ' +
      'prepare_translations to propose fixes. Errors: scope_denied (403), not_found (404), ' +
      'rate_limited (429).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        fileId: { type: 'string', description: 'Scope the scan to one file; omit for the whole project.' },
        lane: { type: 'string', description: 'Target-language lane (e.g. "es"). Omit for the default lane.' },
        onlyDrift: { type: 'boolean', description: 'Return only concepts that have flagged cells.' },
        limit: { type: 'number', description: 'Findings page size.' },
        offset: { type: 'number', description: 'Findings page offset.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_translations',
    description:
      'Stage a batch of commands as an immutable changeset (execution plan) WITHOUT applying ' +
      'them — the generic propose step for every MCP-stageable command kind (Agent API v1.1). ' +
      'Pass `translations` for a SetTranslation batch (as before), and/or `commands` for ' +
      'CreateProject, UpdateProjectSettings, or LinkMedia. Resolves preconditions from live ' +
      'state and computes a server-side effect summary (nothing is silently dropped) before ' +
      'returning { changesetId, summary, digest, mode, approvalUrl? }. If mode is "ask" you ' +
      'CANNOT commit directly: first DESCRIBE the staged plan in the conversation — the ' +
      'summary counts plus 2-3 representative before/after samples — so the human can review ' +
      'without leaving the chat, and give them the approvalUrl (the full approval page shows ' +
      'every per-cell diff). Wait for them to approve, then call confirm_changeset. If mode ' +
      'is "act", call confirm_changeset to commit immediately.\n\n' +
      'PlanImport is NOT accepted via `commands` — stage file imports with the dedicated ' +
      'preview_import / prepare_import tools (or REST; see get_capabilities.importing).\n\n' +
      '`commands` shapes (each enforced server-side; a validation_failed error names the ' +
      'violated rule):\n' +
      '  { kind: "CreateProject", name, projectId?, orgId? } — receipt-only (a plain row ' +
      'write, not an event); must be the SOLE command in the changeset. `projectId` is ' +
      'optional: when omitted, the DEFINITIVE new project id is this tool call\'s own ' +
      '`projectId` argument (the changeset\'s URL project id) — set BOTH to the same value ' +
      'to avoid ambiguity, or omit the command\'s `projectId` and rely on the top-level one. ' +
      'Requires an unscoped or org-scoped credential with org role >= MAINTAINER in the ' +
      'target org (a project-scoped credential gets scope_denied) — and prepare ALWAYS ' +
      'stages CreateProject in ask-mode regardless of credential mode, so it always needs ' +
      'human approval at the approvalUrl before commit. A project id already taken between ' +
      'prepare and commit surfaces as `conflict`.\n' +
      '  { kind: "UpdateProjectSettings", projectId, settings, ifMatchVersion } — ' +
      'receipt-only; must be the SOLE command in the changeset. Requires project role >= ' +
      'MAINTAINER. `ifMatchVersion` must equal the live settings version or you get ' +
      'plan_stale (re-fetch the current version and re-prepare); the receipt carries the new ' +
      'version.\n' +
      '  { kind: "LinkMedia", fileId, cellId, artifactId } — event-native (compiles to ' +
      'cell.audio.attach + cell.audio.select). `artifactId` must reference an audio-kind ' +
      'artifact already uploaded to this project via REST ' +
      '`POST .../projects/:projectId/artifacts` with header `x-artifact-kind: audio` — MCP ' +
      'is JSON-RPC text and cannot carry that binary upload itself. Multiple LinkMedia ' +
      'commands may share one changeset with each other, but LinkMedia cannot mix with ' +
      'SetTranslation/CreateProject/UpdateProjectSettings in the same changeset. Requires ' +
      'CONTRIBUTOR.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        changesetId: { type: 'string', description: 'Optional client-supplied UUIDv7 for idempotency.' },
        translations: {
          type: 'array',
          description:
            'SetTranslation entries to stage. Each may name a target-language lane via ' +
            'laneId to write one of a multi-language project\'s targets (e.g. "es", "pt"); ' +
            'omit laneId for the default lane. The lane must already be registered in the ' +
            'project\'s settings.targetLanes (via UpdateProjectSettings) or prepare returns ' +
            'validation_failed — see get_capabilities.multiLanguage for the full workflow.',
          items: {
            type: 'object',
            properties: {
              cellId: { type: 'string' },
              fileId: { type: 'string' },
              value: { type: 'string', description: 'Plain-text translation value.' },
              valueHtml: { type: 'string', description: 'Optional rich-text HTML value.' },
              laneId: {
                type: 'string',
                description:
                  'Target-language lane (a registered settings.targetLanes tag, e.g. "es"). Omit for the default lane.',
              },
            },
            required: ['cellId', 'fileId', 'value'],
            additionalProperties: false,
          },
        },
        commands: {
          type: 'array',
          description:
            'CreateProject / UpdateProjectSettings / LinkMedia commands to stage (Agent API ' +
            'v1.1) — see this tool\'s description for per-kind shape, role gates, and ' +
            'sole-command rules. PlanImport is not accepted here (REST-only).',
          items: {
            type: 'object',
            oneOf: [
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['CreateProject'] },
                  name: { type: 'string' },
                  projectId: {
                    type: 'string',
                    description: 'Optional — defaults to this call\'s top-level projectId.',
                  },
                  orgId: {
                    type: ['string', 'number'],
                    description: 'Target org id; omit for a personal (org-less) project.',
                  },
                },
                required: ['kind', 'name'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['UpdateProjectSettings'] },
                  projectId: { type: 'string' },
                  settings: { type: 'object', description: 'Settings blob to write (replaces the stored blob).' },
                  ifMatchVersion: {
                    type: 'number',
                    description: 'Must equal the live settings version, else plan_stale.',
                  },
                },
                required: ['kind', 'projectId', 'settings', 'ifMatchVersion'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['LinkMedia'] },
                  fileId: { type: 'string' },
                  cellId: { type: 'string' },
                  artifactId: {
                    type: 'string',
                    description: 'An audio-kind artifact id from the REST artifact upload endpoint.',
                  },
                },
                required: ['kind', 'fileId', 'cellId', 'artifactId'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_import',
    description:
      'Parse an uploaded source artifact with Aquilla\'s built-in importers and PREVIEW the ' +
      'result WITHOUT staging anything. This is step 2 of the artifact-first import ' +
      'workflow: (1) upload the original file bytes via REST ' +
      'POST .../projects/:projectId/artifacts with header "x-artifact-name" (25MB cap) — ' +
      'upload is REST-only because MCP is JSON-RPC text and cannot carry a binary body ' +
      '(from Claude Code, curl the upload); preserving the original in storage also enables ' +
      'round-trip export later. (2) preview_import to check the parse. (3) prepare_import ' +
      'to stage a PlanImport changeset. (4) the normal confirm_changeset / approval flow. ' +
      'Server-parseable formats: txt, md, json, po, properties, obs, vtt, srt, sbv, csv, ' +
      'tsv, usfm, docx (format is auto-detected; pass fileType to override — required for ' +
      'po/properties/obs/sbv, which are not sniffable). Still DOM-bound: pptx, html, ' +
      'xliff, tmx, usx, idml are NOT server-parseable — they return validation_failed ' +
      'naming the client-side alternatives (in-app Import dialog, or raw PlanImport cells). ' +
      'Returns { fileName, fileType, totalCells, sampleCells (first 10), warnings, ' +
      'results } — `results` lists every parsed file when a multi-book USFM splits into ' +
      'several (stage each via prepare_import\'s resultIndex). Cell cap per import: 5000.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        artifactId: {
          type: 'string',
          description: 'A source artifact already uploaded via REST POST .../artifacts.',
        },
        fileType: {
          type: 'string',
          description:
            'Override format detection: txt|md|json|po|properties|obs|vtt|srt|sbv|csv|tsv|usfm (sfm, markdown, plaintext, text accepted as aliases).',
        },
        fileName: { type: 'string', description: 'Name for the file to be created (default: the artifact name).' },
        sourceLanguage: { type: 'string', description: 'BCP-47-ish source language tag for the created file.' },
        targetLanguage: { type: 'string', description: 'Target language tag for the created file.' },
        resultIndex: {
          type: 'number',
          description: 'Which parsed file to preview when the parse yields several (multi-book USFM). Default 0.',
        },
        excludeFrontMatter: {
          type: 'boolean',
          description: 'USFM only: drop book-name/title/TOC front matter cells.',
        },
      },
      required: ['projectId', 'artifactId'],
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_import',
    description:
      'Parse an uploaded source artifact with Aquilla\'s built-in importers AND stage the ' +
      'result as a PlanImport changeset (sole command, artifactId linked so the original ' +
      'is preserved for round-trip export). Nothing is applied here — like every write ' +
      'this returns { changesetId, summary, digest, mode, approvalUrl? } for the normal ' +
      'confirm_changeset flow (ask mode: a human must approve at the approvalUrl first). ' +
      'Workflow: REST-upload the original bytes to POST .../projects/:projectId/artifacts ' +
      '(25MB cap; upload is REST-only — MCP JSON-RPC cannot carry binary, so agents like ' +
      'Claude Code should curl it), preview_import to check the parse, then this tool, ' +
      'then confirm_changeset. Same formats/limits as preview_import (5000-cell cap, ' +
      'validation_failed above it); a multi-book USFM artifact must be staged one book per ' +
      'changeset via resultIndex. Requires PROJECT_LEAD role (the floor of the compiled ' +
      'file.create/source.cell.create events).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        artifactId: {
          type: 'string',
          description: 'A source artifact already uploaded via REST POST .../artifacts.',
        },
        fileType: {
          type: 'string',
          description:
            'Override format detection: txt|md|json|po|properties|obs|vtt|srt|sbv|csv|tsv|usfm (sfm, markdown, plaintext, text accepted as aliases).',
        },
        fileName: { type: 'string', description: 'Name for the created file (default: the artifact name).' },
        sourceLanguage: { type: 'string', description: 'BCP-47-ish source language tag for the created file.' },
        targetLanguage: { type: 'string', description: 'Target language tag for the created file.' },
        resultIndex: {
          type: 'number',
          description: 'Which parsed file to stage when the parse yields several (multi-book USFM); required in that case.',
        },
        excludeFrontMatter: {
          type: 'boolean',
          description: 'USFM only: drop book-name/title/TOC front matter cells.',
        },
        changesetId: { type: 'string', description: 'Optional client-supplied UUIDv7 for idempotency.' },
      },
      required: ['projectId', 'artifactId'],
      additionalProperties: false,
    },
  },
  {
    name: 'export_file',
    description:
      'Export one file back out in its delivered format — the mirror of the import ' +
      'tools, and the last step of "messy files in → clean deliverable out" (e.g. USFM ' +
      'handed back to Paratext). Reconstructs the file from the ORIGINAL artifact ' +
      'preserved at import time with the current translations substituted in; ' +
      'untranslated segments keep their source text so the output stays valid. Args: ' +
      'projectId, fileId (from read_content), lane (optional — which target-language ' +
      'lane to export; omit for the default lane). Returns { fileName, contentType, ' +
      'exportMode, lossyVerseCount, bytes, content } where `content` is the file text. ' +
      'Read the fidelity fields before delivering: exportMode "round-trip" means ' +
      'translations were injected, "raw-original"/"raw-sidecar" means the file has no ' +
      'server-side target serializer yet and you are getting the preserved ORIGINAL ' +
      'bytes with NO translations in them; lossyVerseCount > 0 (USFM) counts verses ' +
      'whose footnotes/poetry/character markers the plain-text substitution dropped. ' +
      'Errors: permission_denied if your live project role is below the org export ' +
      'floor (MAINTAINER by default — export is gated higher than reading, and no ' +
      'retry will change it); not_found if the file has no preserved source artifact ' +
      '(it must be re-imported before it can be exported); validation_failed for a ' +
      'binary or oversized result, naming the REST URL to fetch instead — MCP is ' +
      'JSON-RPC text and cannot carry binary bodies, the same asymmetry as the ' +
      'REST-only artifact upload on the import side.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        fileId: { type: 'string', description: 'File to export (from read_content).' },
        lane: {
          type: 'string',
          description:
            'Target-language lane to export (e.g. "es"). Omit for the default lane.',
        },
      },
      required: ['projectId', 'fileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_changeset',
    description:
      'Fetch a staged changeset: its status (staged|committing|committed|discarded|stale|' +
      'expired — "committing" is a transient mid-apply state you should treat the same as ' +
      '"staged" and simply poll again), the server-computed effect summary, the content ' +
      'digest, the approvalUrl (for ask mode), and — once committed — the execution receipt. ' +
      'For SetTranslation/PlanImport/LinkMedia the receipt has applied event ids, counts, and ' +
      'warnings; for the receipt-only commands (CreateProject, UpdateProjectSettings) it is ' +
      'instead a provenance stamp { credentialId, channel, changesetId, command, appliedAt, ' +
      'projectId, version? } — there are no events to list, since those commands apply a ' +
      'plain row write. Poll this after directing a human to the approvalUrl to observe when ' +
      'status becomes committed. Args: projectId, changesetId.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        changesetId: { type: 'string' },
      },
      required: ['projectId', 'changesetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirm_changeset',
    description:
      'Commit a prepared changeset. Args: projectId, changesetId, digest (the digest from ' +
      'prepare_translations, an optimistic-concurrency guard — a mismatch returns plan_stale ' +
      'so you re-prepare). In act mode this applies the plan and returns the execution ' +
      'receipt. In ask mode it commits ONLY if a human has approved via the approvalUrl; ' +
      'otherwise it returns a confirmation_required error (with the approvalUrl) and applies ' +
      'nothing — approval is never fabricated. If state drifted since prepare you get ' +
      'plan_stale (for CreateProject specifically, a project id claimed by someone else ' +
      'between prepare and commit returns conflict instead). Committing is idempotent: a ' +
      'second call returns the same receipt — this also covers a crash mid-commit, which a ' +
      'retry safely resumes rather than double-applying.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        changesetId: { type: 'string' },
        digest: { type: 'string', description: 'Digest returned by prepare_translations.' },
      },
      required: ['projectId', 'changesetId', 'digest'],
      additionalProperties: false,
    },
  },
  {
    name: 'discard_changeset',
    description:
      'Discard a staged (or stale/expired) changeset so it can never be committed. A ' +
      'committed changeset cannot be discarded (returns validation_failed). Args: projectId, ' +
      'changesetId. Returns the changeset with status "discarded".',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        changesetId: { type: 'string' },
      },
      required: ['projectId', 'changesetId'],
      additionalProperties: false,
    },
  },
]
