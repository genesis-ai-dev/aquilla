/**
 * Client for the Airtable integration API (auth-worker /api/v2/airtable/*,
 * AQU-804) — the same fetch/auth/error style as src/lib/monday/api.ts.
 *
 * The server describes a table by its fields; the shared settings pieces read
 * a Monday board's `{ columns: [{ id, title, type }] }`. `toBoardStructure`
 * is the one place a table becomes that shape.
 */

import { AUTH_BASE } from "../frontier/auth"
import type { MessageKey } from "../i18n/messages/en"
import { t } from "../i18n/standalone"
import type { MondayAddColumnsResult, MondayBoardStructure } from "../monday/api"
import type { MondayMetricKey } from "../monday/types"
import type { AirtableMapping } from "./types"

function authHeaders(jwt: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` }
}

/** A non-2xx the caller should surface. `reason` and the flags come from the server's body. */
export class AirtableApiError extends Error {
  readonly status: number
  readonly reason: string | null
  readonly missingScopes: string[]
  /** The token was rejected or can't be read: paste a new one. */
  readonly needsReauth: boolean
  /** The token sees no tables at all. */
  readonly noTables: boolean
  constructor(
    message: string,
    status: number,
    details: { reason?: string | null; missingScopes?: string[]; needsReauth?: boolean; noTables?: boolean } = {},
  ) {
    super(message)
    this.name = "AirtableApiError"
    this.status = status
    this.reason = details.reason ?? null
    this.missingScopes = details.missingScopes ?? []
    this.needsReauth = details.needsReauth ?? false
    this.noTables = details.noTables ?? false
  }
}

/**
 * AQU-820, as Monday's: the message is OURS — a translated sentence chosen by
 * the call site. The server's `error` is a raw diagnostic, kept on `cause`.
 */
async function readError(res: Response, fallbackKey: MessageKey): Promise<never> {
  let body: {
    error?: string
    reason?: string
    missingScopes?: string[]
    needsReauth?: boolean
    noTables?: boolean
  } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    // non-JSON body; nothing to preserve
  }
  let key = fallbackKey
  if (body.noTables) key = "error.airtable.noTables"
  else if (body.needsReauth) key = "error.airtable.tokenRejected"
  const err = new AirtableApiError(t(key), res.status, body)
  err.cause = `HTTP ${res.status}${body.error ? ` — ${body.error.slice(0, 400)}` : ""}`
  throw err
}

// ── Shapes (mirror routes/airtable.ts) ─────────────────────────────────────

/** GET /orgs/:orgId/connection — never the token. */
export interface AirtableConnectionStatus {
  connected: boolean
  account?: { userId: string | null; email: string | null }
  scopes?: string | null
  createdAt?: string
  /** Airtable rejected the token since it was saved: paste a new one. */
  needsReauth?: boolean
  /** False when the connection was made by another deployment (AQU-1775). */
  usable?: boolean
  /** PUT only: how many bases the token can see. */
  baseCount?: number
}

export interface AirtableBase {
  id: string
  name: string
}

export interface AirtableField {
  id: string
  name: string
  type: string
}

export interface AirtableTable {
  id: string
  name: string
  primaryFieldId: string
  fields: AirtableField[]
  url: string
}

/** A table as the server describes it with its base. */
export interface AirtableTableStructure {
  baseId: string
  baseName: string | null
  tableId: string
  tableName: string | null
  primaryFieldId: string | null
  fields: AirtableField[]
  url: string
}

/** The table in the shape the shared mapping pieces read (fields as columns). */
export function toBoardStructure(
  table: Pick<AirtableTableStructure, "fields" | "url"> & { tableName?: string | null; name?: string },
): MondayBoardStructure {
  return {
    url: table.url,
    name: table.tableName ?? table.name ?? null,
    columns: table.fields.map((f) => ({ id: f.id, title: f.name, type: f.type })),
    groups: [],
  }
}

/** The `link` object from GET/PUT/PATCH /projects/:projectId/link. */
export interface AirtableTableLink {
  id: string
  baseId: string
  baseName: string | null
  tableId: string
  tableName: string | null
  tableUrl: string | null
  enabled: boolean
  config: AirtableMapping
  structureStale: boolean
  lastPushedAt: string | null
  lastPushStatus: "ok" | "error" | null
  lastPushError: string | null
  orgConnected: boolean
}

export interface AirtableLinkStatus {
  orgConnected?: boolean
  orgId?: number | null
  linked: boolean
  link?: AirtableTableLink
}

export interface AirtableSyncResult {
  ok: boolean
  pushed: boolean
  itemsUpserted?: number
  error?: string
}

// ── Org connection ─────────────────────────────────────────────────────────

export async function fetchAirtableConnection(jwt: string, orgId: number): Promise<AirtableConnectionStatus> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/orgs/${orgId}/connection`, { headers: authHeaders(jwt) })
  if (!res.ok) await readError(res, "error.airtable.loadConnection")
  return (await res.json()) as AirtableConnectionStatus
}

/**
 * PUT /orgs/:orgId/connection { token } (org maintainer+). The server checks
 * the token with Airtable before storing it; a refusal comes back as an
 * AirtableApiError whose message says what to fix.
 */
export async function connectAirtable(jwt: string, orgId: number, token: string): Promise<AirtableConnectionStatus> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/orgs/${orgId}/connection`, {
    method: "PUT",
    headers: authHeaders(jwt),
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    let body: { reason?: string; missingScopes?: string[]; error?: string } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      // non-JSON body
    }
    const message =
      body.reason === "token_rejected"
        ? t("error.airtable.tokenRejected")
        : body.reason === "missing_scopes"
          ? t("error.airtable.missingScopes", { scopes: (body.missingScopes ?? []).join(", ") })
          : body.reason === "airtable_unreachable"
            ? t("error.airtable.unreachable")
            : t("error.airtable.connect")
    const err = new AirtableApiError(message, res.status, body)
    err.cause = `HTTP ${res.status}${body.error ? ` — ${body.error.slice(0, 400)}` : ""}`
    throw err
  }
  return (await res.json()) as AirtableConnectionStatus
}

/** DELETE /orgs/:orgId/connection (org maintainer+). Cascades links; records stay in Airtable. */
export async function deleteAirtableConnection(jwt: string, orgId: number): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/orgs/${orgId}/connection`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.airtable.disconnect")
}

// ── Bases and tables ───────────────────────────────────────────────────────

export async function fetchAirtableBases(jwt: string, orgId: number): Promise<AirtableBase[]> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/orgs/${orgId}/bases`, { headers: authHeaders(jwt) })
  if (!res.ok) await readError(res, "error.airtable.loadBases")
  return ((await res.json()) as { bases?: AirtableBase[] }).bases ?? []
}

export async function fetchAirtableTables(jwt: string, orgId: number, baseId: string): Promise<AirtableTable[]> {
  const res = await fetch(
    `${AUTH_BASE}/api/v2/airtable/orgs/${orgId}/bases/${encodeURIComponent(baseId)}/tables`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) await readError(res, "error.airtable.loadTables")
  return ((await res.json()) as { tables?: AirtableTable[] }).tables ?? []
}

// ── Project table link ─────────────────────────────────────────────────────

export async function fetchAirtableLink(jwt: string, projectId: string): Promise<AirtableLinkStatus> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/link`, { headers: authHeaders(jwt) })
  if (!res.ok) await readError(res, "error.airtable.loadLink")
  return (await res.json()) as AirtableLinkStatus
}

/** PUT /projects/:projectId/link (maintainer+). Fields the table lacks come back in `warnings`. */
export async function putAirtableLink(
  jwt: string,
  projectId: string,
  body: { baseId: string; tableId: string; baseName?: string; config: AirtableMapping; enabled?: boolean },
): Promise<{ link: AirtableTableLink; warnings: string[] }> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/link`, {
    method: "PUT",
    headers: authHeaders(jwt),
    body: JSON.stringify(body),
  })
  if (!res.ok) await readError(res, "error.airtable.saveLink")
  const out = (await res.json()) as { link: AirtableTableLink; warnings?: string[] }
  return { link: out.link, warnings: out.warnings ?? [] }
}

export async function patchAirtableLink(
  jwt: string,
  projectId: string,
  body: { enabled?: boolean; config?: AirtableMapping },
): Promise<{ link: AirtableTableLink; warnings: string[]; push?: AirtableSyncResult }> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/link`, {
    method: "PATCH",
    headers: authHeaders(jwt),
    body: JSON.stringify(body),
  })
  if (!res.ok) await readError(res, "error.airtable.updateLink")
  const out = (await res.json()) as { link: AirtableTableLink; warnings?: string[]; push?: AirtableSyncResult }
  return { link: out.link, warnings: out.warnings ?? [], ...(out.push && { push: out.push }) }
}

export async function deleteAirtableLink(jwt: string, projectId: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/link`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.airtable.removeLink")
}

// ── AI setup, fields, sync ─────────────────────────────────────────────────

export interface AirtableAnalysis {
  proposal: AirtableMapping
  summary: string
  /** Why a field the user can see isn't in the proposal. */
  warnings: string[]
  /** One sentence on why this table — empty when chosen without the AI. */
  tableReason: string
  /** The table the proposal is for, with its base. */
  structure: AirtableTableStructure
}

/**
 * POST /projects/:projectId/analyze (maintainer+). Omit baseId/tableId and the
 * server picks the table too.
 */
export async function analyzeAirtableMapping(
  jwt: string,
  projectId: string,
  body: { baseId?: string; tableId?: string; baseName?: string; message?: string; currentConfig?: AirtableMapping },
): Promise<AirtableAnalysis> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/analyze`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(body),
  })
  if (!res.ok) await readError(res, "error.airtable.analyze")
  const data = (await res.json()) as Partial<AirtableAnalysis> & {
    proposal: AirtableMapping
    structure: AirtableTableStructure
  }
  return {
    proposal: data.proposal,
    summary: data.summary ?? "",
    warnings: data.warnings ?? [],
    tableReason: data.tableReason ?? "",
    structure: data.structure,
  }
}

/**
 * POST /projects/:projectId/fields (maintainer+): create the fields for
 * `metrics` the table lacks (plus "Aquilla ID"), reusing any already there.
 * Returned in the shape the shared "Add columns" pieces read.
 */
export async function addAirtableFields(
  jwt: string,
  projectId: string,
  body: { baseId: string; tableId: string; metrics: MondayMetricKey[] },
): Promise<MondayAddColumnsResult> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/fields`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(body),
  })
  if (!res.ok) await readError(res, "error.airtable.addFields")
  const data = (await res.json()) as Partial<Omit<MondayAddColumnsResult, "structure">> & {
    structure: AirtableTableStructure
  }
  return {
    created: data.created ?? [],
    reused: data.reused ?? [],
    failed: data.failed ?? [],
    structure: toBoardStructure(data.structure),
  }
}

/** Fields in the linked table that weren't there when the link was saved. */
export interface AirtableTableChanges {
  structureStale: boolean
  newFields: AirtableField[]
  structure: AirtableTableStructure
}

export async function fetchAirtableTableChanges(jwt: string, projectId: string): Promise<AirtableTableChanges> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/table-changes`, {
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.airtable.loadTables")
  return (await res.json()) as AirtableTableChanges
}

/** POST /projects/:projectId/table-changes/dismiss — "Not needed". */
export async function dismissAirtableTableChanges(
  jwt: string,
  projectId: string,
  fieldIds: string[],
): Promise<AirtableTableChanges> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/table-changes/dismiss`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ fieldIds }),
  })
  if (!res.ok) await readError(res, "error.airtable.loadTables")
  return (await res.json()) as AirtableTableChanges
}

/** POST /projects/:projectId/sync (maintainer+). Push now. */
export async function syncAirtableNow(jwt: string, projectId: string): Promise<AirtableSyncResult> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/projects/${projectId}/sync`, {
    method: "POST",
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.airtable.sync")
  return (await res.json()) as AirtableSyncResult
}

/** One project's link, as Org settings → Airtable lists it. */
export interface AirtableOrgProjectLink {
  projectId: string
  baseId: string
  baseName: string | null
  tableId: string
  tableName: string | null
  tableUrl: string | null
  enabled: boolean
  structureStale: boolean
  lastPushedAt: string | null
  lastPushStatus: string | null
}

export async function fetchAirtableOrgLinks(jwt: string, orgId: number): Promise<AirtableOrgProjectLink[]> {
  const res = await fetch(`${AUTH_BASE}/api/v2/airtable/orgs/${orgId}/links`, { headers: authHeaders(jwt) })
  if (!res.ok) await readError(res, "error.airtable.loadLink")
  return ((await res.json()) as { links: AirtableOrgProjectLink[] }).links
}
