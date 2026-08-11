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
      'UpdateProjectSettings, LinkMedia — note PlanImport is staged over REST only, there ' +
      'is no MCP staging tool for it yet; the other four all stage/commit via ' +
      'prepare_translations/confirm_changeset — see the returned projectLifecycle and ' +
      'linkMedia fields for their per-kind rules), the operational limits (changeset ' +
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
    name: 'prepare_translations',
    description:
      'Stage a batch of commands as an immutable changeset (execution plan) WITHOUT applying ' +
      'them — the generic propose step for every MCP-stageable command kind (Agent API v1.1). ' +
      'Pass `translations` for a SetTranslation batch (as before), and/or `commands` for ' +
      'CreateProject, UpdateProjectSettings, or LinkMedia. Resolves preconditions from live ' +
      'state and computes a server-side effect summary (nothing is silently dropped) before ' +
      'returning { changesetId, summary, digest, mode, approvalUrl? }. If mode is "ask" you ' +
      'CANNOT commit directly: surface the approvalUrl to a human, wait for them to approve ' +
      'in the browser, then call confirm_changeset. If mode is "act", call confirm_changeset ' +
      'to commit immediately.\n\n' +
      'PlanImport is NOT accepted via `commands` — it remains REST-only ' +
      '(see get_capabilities.planImport).\n\n' +
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
