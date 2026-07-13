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
      'the domain command kinds available (currently SetTranslation), the operational ' +
      'limits (changeset expiry, max commands per changeset), the full list of stable ' +
      'machine-actionable error codes, and an explanation of the ask-mode approval flow ' +
      '(prepare -> approvalUrl -> a human approves in a browser -> confirm_changeset). ' +
      'This is the recommended first call: it tells an agent its ceiling so it does not ' +
      'attempt commits it cannot make. Takes no arguments.',
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
      'Returns { data, nextCursor, ... }. Use this together with search_project to gather ' +
      'context before staging translations.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        fileId: { type: 'string', description: 'Omit to list files; provide to read its cells.' },
        since: { type: 'number', description: 'Only cells changed after this server seq (delta read).' },
        limit: { type: 'number', description: 'Page size.' },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a prior nextCursor.' },
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
      'Stage a batch of translations as an immutable changeset (execution plan) WITHOUT ' +
      'applying them. Compiles each entry into a SetTranslation command, resolves per-cell ' +
      'preconditions from live state, and computes a server-side effect summary (added vs ' +
      'modified counts, plus warnings for missing/duplicate cells — nothing is silently ' +
      'dropped). Args: projectId, translations (array of { cellId, fileId, value, valueHtml? }), ' +
      'and optional changesetId (a client UUIDv7 for idempotent retries). Returns ' +
      '{ changesetId, summary, digest, mode, approvalUrl? }. If mode is "ask" you CANNOT ' +
      'commit directly: surface the approvalUrl to a human, wait for them to approve in the ' +
      'browser, then call confirm_changeset. If mode is "act", call confirm_changeset to ' +
      'commit immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdProp,
        changesetId: { type: 'string', description: 'Optional client-supplied UUIDv7 for idempotency.' },
        translations: {
          type: 'array',
          description: 'The translations to stage.',
          items: {
            type: 'object',
            properties: {
              cellId: { type: 'string' },
              fileId: { type: 'string' },
              value: { type: 'string', description: 'Plain-text translation value.' },
              valueHtml: { type: 'string', description: 'Optional rich-text HTML value.' },
            },
            required: ['cellId', 'fileId', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['projectId', 'translations'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_changeset',
    description:
      'Fetch a staged changeset: its status (staged|committed|discarded|stale|expired), the ' +
      'server-computed effect summary, the content digest, the approvalUrl (for ask mode), ' +
      'and — once committed — the execution receipt (applied event ids, counts, warnings). ' +
      'Poll this after directing a human to the approvalUrl to observe when status becomes ' +
      'committed. Args: projectId, changesetId.',
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
      'plan_stale. Committing is idempotent: a second call returns the same receipt.',
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
