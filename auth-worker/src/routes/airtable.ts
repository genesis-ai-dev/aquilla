// Airtable integration routes — mounted at /api/v2/airtable in src/index.ts
// (AQU-804). The same shape as Monday's (routes/monday.ts): one connection per
// org, one table link per project, an AI-proposed field mapping the user
// reviews, and pushes on the same triggers.
//
//   GET    /orgs/:orgId/connection              org member — status (never the token)
//   PUT    /orgs/:orgId/connection              org maintainer+ — { token }: checked with Airtable, stored encrypted
//   DELETE /orgs/:orgId/connection              org maintainer+ — disconnect (cascades links)
//   GET    /orgs/:orgId/bases                   org maintainer+ — base picker
//   GET    /orgs/:orgId/bases/:baseId/tables    org maintainer+ — table picker, with each table's fields
//   GET    /orgs/:orgId/links                   org maintainer+ — each project's link, for org settings
//   GET    /projects/:projectId/link            any project member
//   PUT    /projects/:projectId/link            project maintainer+ — create/replace link
//   PATCH  /projects/:projectId/link            project maintainer+ — enabled/config
//   DELETE /projects/:projectId/link            project maintainer+
//   POST   /projects/:projectId/analyze         project maintainer+ — AI mapping proposal
//                                               (omit baseId/tableId and the AI picks the table too)
//   POST   /projects/:projectId/fields          project maintainer+ — add the missing Aquilla fields to a table
//   POST   /projects/:projectId/sync            project maintainer+ — push now
//   GET    /projects/:projectId/table-changes   project maintainer+ — fields new in the table since the link was saved
//   POST   /projects/:projectId/table-changes/dismiss  project maintainer+ — "Not needed" for some of them
//
// The connection is a personal access token the org pastes in, AES-GCM
// encrypted at rest (lib/airtable/tokens.ts). Edits push through the shared
// /api/v2/monday/internal/push nudge, which schedules every provider's links
// (lib/integrations/push.ts). Airtable has no webhook here: the settings page
// re-reads the table instead (table-changes).

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Context } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import type { Env } from "../types"
import { parseJsonColumn, type IntegrationConnectionRow, type IntegrationLinkRow } from "../lib/monday/types"
import { computeProjectMetrics } from "../lib/monday/metrics"
import { runningEnvironment } from "../lib/monday/tokens"
import { AnalyzeUpstreamError } from "../lib/integrations/llm"
import {
  airtableClient,
  fetchBaseTables,
  fetchTable,
  listBases,
  listRecords,
  tableUrl,
  whoAmI,
  AirtableApiError,
  type AirtableClient,
} from "../lib/airtable/client"
import {
  airtableForeignConnectionError,
  encryptAirtableToken,
  getAirtableToken,
  markAirtableNeedsNewToken,
  AirtableForeignConnectionError,
} from "../lib/airtable/tokens"
import {
  PROVIDER,
  sanitizeAirtableMapping,
  type AirtableAccountInfo,
  type AirtableMapping,
  type AirtableTable,
  type AirtableTableStructure,
} from "../lib/airtable/types"
import { analyzeTableMapping, NoTablesError, selectTableForProject, type TableCandidate } from "../lib/airtable/analyze"
import { addMissingFields, findExistingField, isCreatableFieldMetric } from "../lib/airtable/fields"
import { pushAirtableLink } from "../lib/airtable/push"
import {
  getProjectOrgId,
  MANAGE_MIN_ROLE,
  notifyLinkChangedBestEffort,
  orgGuard,
  projectGuard,
} from "./_integration-helpers"

const airtable = new Hono<AuthHonoEnv>()

/** What a push needs. schema.bases:write (adding fields) is optional. */
export const REQUIRED_SCOPES = ["data.records:read", "data.records:write", "schema.bases:read"] as const

/** How many bases "Set up with AI" reads tables from when it picks the table. */
const MAX_BASES_FOR_SELECTION = 10

async function getConnection(env: Env, orgId: number): Promise<IntegrationConnectionRow | null> {
  return env.AQUILLA_PG.prepare("SELECT * FROM integration_connections WHERE org_id = ? AND provider = ?")
    .bind(String(orgId), PROVIDER)
    .first<IntegrationConnectionRow>()
}

async function getLink(env: Env, projectId: string): Promise<IntegrationLinkRow | null> {
  return env.AQUILLA_PG.prepare("SELECT * FROM integration_links WHERE project_id = ? AND provider = ?")
    .bind(projectId, PROVIDER)
    .first<IntegrationLinkRow>()
}

/** The org's client, or the 409 that says why there is none. */
async function orgClientOr409(
  c: Context<AuthHonoEnv>,
  orgId: number,
): Promise<{ client: AirtableClient; conn: IntegrationConnectionRow } | Response> {
  const conn = await getConnection(c.env, orgId)
  if (!conn) return c.json({ error: "org is not connected to Airtable" }, 409)
  return clientFor(c, conn)
}

async function clientFor(
  c: Context<AuthHonoEnv>,
  conn: IntegrationConnectionRow,
): Promise<{ client: AirtableClient; conn: IntegrationConnectionRow } | Response> {
  try {
    return { client: airtableClient(c.env, await getAirtableToken(c.env, conn)), conn }
  } catch (err) {
    // AQU-1775: another deployment's row. Pasting a token HERE is the fix.
    if (err instanceof AirtableForeignConnectionError) {
      return c.json(
        { error: err.message, foreignConnection: true, connectionEnvironment: err.connectionEnvironment },
        409,
      )
    }
    console.error("[airtable] token decrypt failed:", err)
    return c.json({ error: "the stored Airtable token can't be read; paste it again", needsReauth: true }, 409)
  }
}

async function linkClientOr409(
  c: Context<AuthHonoEnv>,
  link: IntegrationLinkRow,
): Promise<{ client: AirtableClient; conn: IntegrationConnectionRow } | Response> {
  const conn = await c.env.AQUILLA_PG.prepare("SELECT * FROM integration_connections WHERE id = ?")
    .bind(link.connection_id)
    .first<IntegrationConnectionRow>()
  if (!conn) return c.json({ error: "org is not connected to Airtable" }, 409)
  return clientFor(c, conn)
}

/** An Airtable refusal as our answer. A rejected token flags the connection for a new one. */
async function airtableFailure(
  c: Context<AuthHonoEnv>,
  err: unknown,
  conn: Pick<IntegrationConnectionRow, "id"> | null,
  what: string,
): Promise<Response> {
  if (err instanceof AirtableApiError) {
    if (err.status === 401) {
      if (conn) await markAirtableNeedsNewToken(c.env, conn.id)
      return c.json({ error: "Airtable rejected the token", needsReauth: true }, 409)
    }
    if (err.status === 403) {
      return c.json({ error: "the Airtable token may not do this (check its scopes and bases)", tokenForbidden: true }, 409)
    }
    if (err.status === 404) return c.json({ error: "Airtable base or table not found" }, 404)
  }
  console.error(`[airtable] ${what} failed:`, err)
  return c.json({ error: "Airtable API error" }, 502)
}

function structureOf(
  baseId: string,
  baseName: string | null,
  table: AirtableTable,
): AirtableTableStructure {
  return {
    fetchedAt: new Date().toISOString(),
    baseId,
    baseName,
    tableId: table.id,
    tableName: table.name,
    primaryFieldId: table.primaryFieldId,
    fields: table.fields.map(({ id, name, type }) => ({ id, name, type })),
  }
}

/** The table as the SPA reads it (no fetch time). */
function publicStructure(s: Omit<AirtableTableStructure, "fetchedAt">) {
  return {
    baseId: s.baseId,
    baseName: s.baseName,
    tableId: s.tableId,
    tableName: s.tableName,
    primaryFieldId: s.primaryFieldId,
    fields: s.fields,
    url: tableUrl(s.baseId, s.tableId),
  }
}

function linkResponse(link: IntegrationLinkRow, orgConnected: boolean) {
  const structure = parseJsonColumn<AirtableTableStructure | null>(link.remote_state, null)
  const config = parseJsonColumn<AirtableMapping | null>(link.config, null)
  const tableId = config?.tableId ?? structure?.tableId ?? ""
  return {
    id: link.id,
    baseId: link.external_id,
    baseName: structure?.baseName ?? null,
    tableId,
    tableName: link.external_name,
    tableUrl: tableId ? tableUrl(link.external_id, tableId) : null,
    enabled: link.enabled,
    config,
    structureStale: link.remote_state_stale,
    lastPushedAt: link.last_pushed_at,
    lastPushStatus: link.last_push_status,
    lastPushError: link.last_push_error,
    orgConnected,
  }
}

function connectionStatus(env: Env, conn: IntegrationConnectionRow) {
  const account = parseJsonColumn<AirtableAccountInfo>(conn.account, {})
  return {
    connected: true,
    account: { userId: account.userId ?? null, email: account.email ?? null },
    scopes: conn.scopes,
    createdAt: conn.created_at,
    needsReauth: conn.needs_reauth,
    // AQU-1775: where the row was made, and whether THIS deployment may use it.
    environment: conn.environment,
    usable: airtableForeignConnectionError(env, conn) === null,
  }
}

// ── Org connection ─────────────────────────────────────────────────────────

airtable.get("/orgs/:orgId/connection", authMiddleware, async (c) => {
  const guard = await orgGuard(c, null)
  if (guard instanceof Response) return guard
  const conn = await getConnection(c.env, guard.orgId)
  if (!conn) return c.json({ connected: false })
  return c.json(connectionStatus(c.env, conn))
})

const connectSchema = z.object({ token: z.string().trim().min(10).max(500) })

/**
 * Store the org's personal access token. It is checked first: Airtable must
 * know who it belongs to, and it must be able to list bases (schema.bases:read
 * — Airtable doesn't report a personal token's scopes, so asking is the check).
 * Pasting again replaces the token and clears "needs a new token".
 */
airtable.put("/orgs/:orgId/connection", authMiddleware, zValidator("json", connectSchema), async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const token = c.req.valid("json").token
  const client = airtableClient(c.env, token)

  let me
  let baseCount: number
  try {
    me = await whoAmI(client)
  } catch (err) {
    if (err instanceof AirtableApiError && (err.status === 401 || err.status === 403)) {
      return c.json({ error: "Airtable didn't accept this token", reason: "token_rejected" }, 400)
    }
    console.error("[airtable] whoami failed:", err)
    return c.json({ error: "Airtable API error", reason: "airtable_unreachable" }, 502)
  }
  const missingScopes = me.scopes ? REQUIRED_SCOPES.filter((s) => !me.scopes!.includes(s)) : []
  if (missingScopes.length > 0) {
    return c.json({ error: "the token is missing scopes", reason: "missing_scopes", missingScopes }, 400)
  }
  try {
    baseCount = (await listBases(client)).length
  } catch (err) {
    if (err instanceof AirtableApiError && err.status === 403) {
      return c.json(
        { error: "the token is missing scopes", reason: "missing_scopes", missingScopes: ["schema.bases:read"] },
        400,
      )
    }
    console.error("[airtable] listing bases failed:", err)
    return c.json({ error: "Airtable API error", reason: "airtable_unreachable" }, 502)
  }

  const account: AirtableAccountInfo = { userId: me.id ?? null, email: me.email ?? null }
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections
       (id, org_id, provider, account, access_token_enc, refresh_token_enc, access_token_expires_at,
        needs_reauth, scopes, created_by, environment)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, FALSE, ?, ?, ?)
     ON CONFLICT (org_id, provider) DO UPDATE SET
       account = EXCLUDED.account,
       access_token_enc = EXCLUDED.access_token_enc,
       needs_reauth = FALSE,
       scopes = EXCLUDED.scopes,
       environment = EXCLUDED.environment,
       updated_at = now()`,
  )
    .bind(
      crypto.randomUUID(),
      String(guard.orgId),
      PROVIDER,
      JSON.stringify(account),
      await encryptAirtableToken(c.env, token),
      me.scopes?.join(" ") ?? null,
      c.get("user").username,
      // AQU-1775: the row belongs to the deployment that stored it.
      runningEnvironment(c.env),
    )
    .run()
  const conn = await getConnection(c.env, guard.orgId)
  if (!conn) return c.json({ error: "connection write failed" }, 500)
  return c.json({ ...connectionStatus(c.env, conn), baseCount })
})

airtable.delete("/orgs/:orgId/connection", authMiddleware, async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const conn = await getConnection(c.env, guard.orgId)
  if (!conn) return c.json({ ok: true, deleted: false })
  // Links and their record links go with it (ON DELETE CASCADE). The records
  // stay in the customer's table.
  await c.env.AQUILLA_PG.prepare("DELETE FROM integration_connections WHERE id = ?").bind(conn.id).run()
  return c.json({ ok: true, deleted: true })
})

// ── Bases and tables (proxy) ────────────────────────────────────────────────

airtable.get("/orgs/:orgId/bases", authMiddleware, async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const got = await orgClientOr409(c, guard.orgId)
  if (got instanceof Response) return got
  try {
    return c.json({ bases: (await listBases(got.client)).slice(0, 200) })
  } catch (err) {
    return airtableFailure(c, err, got.conn, "listing bases")
  }
})

airtable.get("/orgs/:orgId/bases/:baseId/tables", authMiddleware, async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const got = await orgClientOr409(c, guard.orgId)
  if (got instanceof Response) return got
  const baseId = c.req.param("baseId") ?? ""
  try {
    const tables = await fetchBaseTables(got.client, baseId)
    return c.json({
      tables: tables.map((t) => ({ ...t, url: tableUrl(baseId, t.id) })),
    })
  } catch (err) {
    return airtableFailure(c, err, got.conn, "reading tables")
  }
})

/** Every project in the org with an Airtable link, for the org settings list. */
airtable.get("/orgs/:orgId/links", authMiddleware, async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT l.* FROM integration_links l JOIN projects p ON p.id = l.project_id
      WHERE p.org_id = ? AND l.provider = ?`,
  )
    .bind(guard.orgId, PROVIDER)
    .all<IntegrationLinkRow>()
  return c.json({
    links: (rows.results ?? []).map((link) => {
      const view = linkResponse(link, true)
      return {
        projectId: link.project_id,
        baseId: view.baseId,
        baseName: view.baseName,
        tableId: view.tableId,
        tableName: view.tableName,
        tableUrl: view.tableUrl,
        enabled: view.enabled,
        structureStale: view.structureStale,
        lastPushedAt: view.lastPushedAt,
        lastPushStatus: view.lastPushStatus,
      }
    }),
  })
})

// ── Project table link ──────────────────────────────────────────────────────

airtable.get("/projects/:projectId/link", authMiddleware, async (c) => {
  const guard = await projectGuard(c, null)
  if (guard instanceof Response) return guard
  const orgId = await getProjectOrgId(c.env, guard.projectId)
  const orgConnected = orgId != null && (await getConnection(c.env, orgId)) != null
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ linked: false, orgConnected, orgId })
  return c.json({ linked: true, orgConnected, orgId, link: linkResponse(link, orgConnected) })
})

const putLinkSchema = z.object({
  baseId: z.string().min(1),
  tableId: z.string().min(1),
  baseName: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
})

airtable.put("/projects/:projectId/link", authMiddleware, zValidator("json", putLinkSchema), async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const body = c.req.valid("json")
  const orgId = await getProjectOrgId(c.env, guard.projectId)
  if (orgId == null) return c.json({ error: "project has no org" }, 409)
  const got = await orgClientOr409(c, orgId)
  if (got instanceof Response) return got

  // Validate against the table as it is now (warn-not-fail: fields it doesn't
  // have are dropped and reported back, never a hard 400).
  let table: AirtableTable
  try {
    table = await fetchTable(got.client, body.baseId, body.tableId)
  } catch (err) {
    return airtableFailure(c, err, got.conn, "reading the table")
  }
  const previous = await getLink(c.env, guard.projectId)
  const previousStructure = parseJsonColumn<AirtableTableStructure | null>(previous?.remote_state ?? null, null)
  const baseName =
    body.baseName ?? (previous?.external_id === body.baseId ? (previousStructure?.baseName ?? null) : null)
  const structure = structureOf(body.baseId, baseName, table)
  const { mapping, warnings } = sanitizeAirtableMapping({ ...body.config, tableId: table.id }, structure)
  if (!mapping) return c.json({ error: "invalid config", warnings }, 400)

  const linkId = previous?.id ?? crypto.randomUUID()
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO integration_links
       (id, project_id, provider, connection_id, external_id, external_name, config, enabled, webhook_ids,
        remote_state, remote_state_stale, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]'::jsonb, ?, FALSE, ?)
     ON CONFLICT (project_id, provider) DO UPDATE SET
       connection_id = EXCLUDED.connection_id,
       external_id = EXCLUDED.external_id,
       external_name = EXCLUDED.external_name,
       config = EXCLUDED.config,
       enabled = EXCLUDED.enabled,
       remote_state = EXCLUDED.remote_state,
       remote_state_stale = FALSE,
       updated_at = now()`,
  )
    .bind(
      linkId,
      guard.projectId,
      PROVIDER,
      got.conn.id,
      body.baseId,
      table.name,
      JSON.stringify(mapping),
      body.enabled ?? true,
      JSON.stringify(structure),
      c.get("user").username,
    )
    .run()
  // Records remembered in another table mean nothing in this one.
  const previousTableId = parseJsonColumn<Partial<AirtableMapping>>(previous?.config ?? null, {}).tableId
  if (previous && (previous.external_id !== body.baseId || previousTableId !== table.id)) {
    await c.env.AQUILLA_PG.prepare("DELETE FROM integration_item_links WHERE link_id = ?").bind(linkId).run()
  }

  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "link write failed" }, 500)
  notifyLinkChangedBestEffort(c, guard.projectId)
  return c.json({ link: linkResponse(link, true), warnings })
})

const patchLinkSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

airtable.patch("/projects/:projectId/link", authMiddleware, zValidator("json", patchLinkSchema), async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const body = c.req.valid("json")
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "project has no Airtable link" }, 404)

  const warnings: string[] = []
  let configJson: string | null = null
  // Set only when the table was re-read just now: replaces the saved
  // structure and clears "Table changed".
  let freshStructureJson: string | null = null
  if (body.config !== undefined) {
    const saved = parseJsonColumn<AirtableTableStructure | null>(link.remote_state, null)
    // The client edits fields, not the table: the link's table stands.
    const tableId = parseJsonColumn<Partial<AirtableMapping>>(link.config, {}).tableId ?? saved?.tableId ?? ""
    let structure = saved
    const got = await linkClientOr409(c, link)
    try {
      if (got instanceof Response) throw new Error("no Airtable token for this link")
      const table = await fetchTable(got.client, link.external_id, tableId)
      structure = structureOf(link.external_id, saved?.baseName ?? null, table)
      freshStructureJson = JSON.stringify(structure)
    } catch (err) {
      console.warn("[airtable] table re-read on mapping change failed; using the saved structure:", err)
      warnings.push(
        "could not read the table's current fields from Airtable; the mapping was checked against the fields saved when the table was linked",
      )
    }
    const result = sanitizeAirtableMapping({ ...body.config, tableId }, structure)
    if (!result.mapping) {
      return c.json({ error: "invalid config", warnings: [...warnings, ...result.warnings] }, 400)
    }
    warnings.push(...result.warnings)
    configJson = JSON.stringify(result.mapping)
  }

  await c.env.AQUILLA_PG.prepare(
    `UPDATE integration_links
        SET enabled = COALESCE(?, enabled),
            config = COALESCE(?::jsonb, config),
            remote_state = COALESCE(?::jsonb, remote_state),
            remote_state_stale = CASE WHEN ?::jsonb IS NULL THEN remote_state_stale ELSE FALSE END,
            updated_at = now()
      WHERE id = ?`,
  )
    .bind(body.enabled ?? null, configJson, freshStructureJson, freshStructureJson, link.id)
    .run()

  let fresh = await getLink(c.env, guard.projectId)
  if (!fresh) return c.json({ error: "link update failed" }, 500)
  notifyLinkChangedBestEffort(c, guard.projectId)

  // Turning Sync back on pushes straight away: edits made while it was off
  // were never queued, so nothing else would bring the table up to date.
  let push: Awaited<ReturnType<typeof pushAirtableLink>> | undefined
  if (body.enabled === true && !link.enabled) {
    push = await pushAirtableLink(c.env, fresh)
    fresh = (await getLink(c.env, guard.projectId)) ?? fresh
  }
  return c.json({ link: linkResponse(fresh, true), warnings, ...(push && { push }) })
})

airtable.delete("/projects/:projectId/link", authMiddleware, async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ ok: true, deleted: false })
  await c.env.AQUILLA_PG.prepare("DELETE FROM integration_links WHERE id = ?").bind(link.id).run()
  notifyLinkChangedBestEffort(c, guard.projectId)
  return c.json({ ok: true, deleted: true })
})

// ── Table changes since the link was saved ─────────────────────────────────
//
// Monday tells us about a new column with a webhook; here the settings page
// re-reads the table whenever it loads the link. A field in the table now that
// isn't in the saved structure is new, and "Table changed" names it.

async function tableChanges(
  c: Context<AuthHonoEnv>,
  link: IntegrationLinkRow,
  acknowledge: string[] = [],
): Promise<Response> {
  const got = await linkClientOr409(c, link)
  if (got instanceof Response) return got
  const saved = parseJsonColumn<AirtableTableStructure | null>(link.remote_state, null)
  const tableId = parseJsonColumn<Partial<AirtableMapping>>(link.config, {}).tableId ?? saved?.tableId ?? ""
  let table: AirtableTable
  try {
    table = await fetchTable(got.client, link.external_id, tableId)
  } catch (err) {
    return airtableFailure(c, err, got.conn, "table changes: reading the table")
  }
  const live = structureOf(link.external_id, saved?.baseName ?? null, table)
  const known = [...(saved?.fields ?? [])]
  for (const id of acknowledge) {
    const field = live.fields.find((f) => f.id === id)
    if (field && !known.some((k) => k.id === id)) known.push(field)
  }
  const newFields = live.fields.filter((f) => !known.some((k) => k.id === f.id))
  const stale = newFields.length > 0
  if (stale !== link.remote_state_stale || acknowledge.length > 0) {
    // With nothing new left, the saved list becomes the table as it is now
    // (deleted fields drop out too); otherwise only acknowledged fields join.
    const next: AirtableTableStructure = { ...live, fields: stale ? known : live.fields }
    await c.env.AQUILLA_PG.prepare(
      "UPDATE integration_links SET remote_state = ?::jsonb, remote_state_stale = ?, updated_at = now() WHERE id = ?",
    )
      .bind(JSON.stringify(next), stale, link.id)
      .run()
  }
  return c.json({ structureStale: stale, newFields, structure: publicStructure(live) })
}

airtable.get("/projects/:projectId/table-changes", authMiddleware, async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "project has no Airtable link" }, 404)
  return tableChanges(c, link)
})

const dismissChangesSchema = z.object({ fieldIds: z.array(z.string().min(1)).min(1).max(100) })

/** "Not needed": the table keeps these fields, Aquilla stops asking about them. */
airtable.post(
  "/projects/:projectId/table-changes/dismiss",
  authMiddleware,
  zValidator("json", dismissChangesSchema),
  async (c) => {
    const guard = await projectGuard(c, MANAGE_MIN_ROLE)
    if (guard instanceof Response) return guard
    const link = await getLink(c.env, guard.projectId)
    if (!link) return c.json({ error: "project has no Airtable link" }, 404)
    return tableChanges(c, link, c.req.valid("json").fieldIds)
  },
)

// ── AI analyze, fields, manual sync ─────────────────────────────────────────

const analyzeSchema = z.object({
  baseId: z.string().min(1).optional(),
  tableId: z.string().min(1).optional(),
  baseName: z.string().optional(),
  message: z.string().optional(),
  currentConfig: z.record(z.string(), z.unknown()).optional(),
})

airtable.post("/projects/:projectId/analyze", authMiddleware, zValidator("json", analyzeSchema), async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const body = c.req.valid("json")
  const orgId = await getProjectOrgId(c.env, guard.projectId)
  if (orgId == null) return c.json({ error: "project has no org" }, 409)
  const got = await orgClientOr409(c, orgId)
  if (got instanceof Response) return got

  const summary = await computeProjectMetrics(c.env.AQUILLA_PG, guard.projectId, { appBaseUrl: c.env.BASE_URL })
  if (!summary) return c.json({ error: "project not found" }, 404)

  let structure: AirtableTableStructure
  let tableReason: string
  let sampleRecords
  try {
    // The table is part of the proposal unless the caller named one: list the
    // bases, read their tables, and let selectTableForProject choose.
    const tablesByBase = new Map<string, AirtableTable[]>()
    let candidates: TableCandidate[]
    if (body.baseId) {
      const tables = await fetchBaseTables(got.client, body.baseId)
      tablesByBase.set(body.baseId, tables)
      candidates = tables.map((t) => ({
        baseId: body.baseId!,
        baseName: body.baseName ?? "",
        tableId: t.id,
        tableName: t.name,
      }))
    } else {
      candidates = []
      for (const base of (await listBases(got.client)).slice(0, MAX_BASES_FOR_SELECTION)) {
        const tables = await fetchBaseTables(got.client, base.id)
        tablesByBase.set(base.id, tables)
        for (const t of tables) {
          candidates.push({ baseId: base.id, baseName: base.name, tableId: t.id, tableName: t.name })
        }
      }
    }
    const named = body.tableId ? candidates.find((t) => t.tableId === body.tableId) : undefined
    if (body.tableId && !named) return c.json({ error: "Airtable base or table not found" }, 404)
    const choice = named ? { ...named, reason: "" } : await selectTableForProject(c.env, { tables: candidates, summary })
    tableReason = choice.reason
    const table = tablesByBase.get(choice.baseId)!.find((t) => t.id === choice.tableId)!
    structure = structureOf(choice.baseId, choice.baseName || null, table)
    sampleRecords = await listRecords(got.client, choice.baseId, table.id, {
      fieldIds: [table.primaryFieldId],
      maxRecords: 25,
    })
  } catch (err) {
    // A token that sees no tables is the user's to fix, not an outage.
    if (err instanceof NoTablesError) return c.json({ error: err.message, noTables: true }, 409)
    return airtableFailure(c, err, got.conn, "analyze: reading the table")
  }

  const currentConfig = body.currentConfig
    ? (sanitizeAirtableMapping({ ...body.currentConfig, tableId: structure.tableId }, structure).mapping ?? undefined)
    : undefined
  try {
    const result = await analyzeTableMapping(c.env, {
      structure,
      sampleRecords,
      summary,
      currentConfig,
      message: body.message,
    })
    return c.json({
      proposal: result.proposal,
      summary: result.summary,
      warnings: result.warnings,
      tableReason,
      structure: publicStructure(structure),
    })
  } catch (err) {
    console.error("[airtable] analyze failed:", err)
    if (err instanceof AnalyzeUpstreamError) return c.json({ error: err.message }, 502)
    return c.json({ error: "analyze failed" }, 502)
  }
})

// "Add the missing fields for me": create the fields a project's progress
// needs, so a table without them can still be linked without leaving for
// Airtable. Same permission as saving a link.
const addFieldsSchema = z.object({
  baseId: z.string().min(1),
  tableId: z.string().min(1),
  metrics: z.array(z.string()).max(25),
})

airtable.post("/projects/:projectId/fields", authMiddleware, zValidator("json", addFieldsSchema), async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const body = c.req.valid("json")
  const orgId = await getProjectOrgId(c.env, guard.projectId)
  if (orgId == null) return c.json({ error: "project has no org" }, 409)
  const got = await orgClientOr409(c, orgId)
  if (got instanceof Response) return got

  let before: AirtableTable
  try {
    before = await fetchTable(got.client, body.baseId, body.tableId)
  } catch (err) {
    return airtableFailure(c, err, got.conn, "add fields: reading the table")
  }
  const metrics = body.metrics.filter(isCreatableFieldMetric)
  // Finding the records again depends on the Aquilla ID field, so a table
  // without one always gets it, asked for or not.
  if (!metrics.includes("external_id") && !findExistingField("external_id", before.fields)) {
    metrics.push("external_id")
  }
  const result = await addMissingFields(got.client, body.baseId, body.tableId, metrics, before.fields)

  // Fields we just made aren't a "Table changed" surprise for any link on
  // this table: record them in each link's saved structure first.
  if (result.created.length > 0) {
    await rememberCreatedFields(c.env, body.baseId, body.tableId, result.created)
  }
  let after: AirtableTable
  try {
    after = await fetchTable(got.client, body.baseId, body.tableId)
  } catch {
    after = {
      ...before,
      fields: [
        ...before.fields,
        ...result.created.map((f) => ({ id: f.columnId, name: f.title, type: f.columnType })),
      ],
    }
  }
  return c.json({ ...result, structure: publicStructure(structureOf(body.baseId, null, after)) })
})

async function rememberCreatedFields(
  env: Env,
  baseId: string,
  tableId: string,
  created: Array<{ columnId: string; title: string; columnType: string }>,
): Promise<void> {
  const links = await env.AQUILLA_PG.prepare(
    "SELECT id, remote_state FROM integration_links WHERE external_id = ? AND provider = ?",
  )
    .bind(baseId, PROVIDER)
    .all<{ id: string; remote_state: unknown }>()
  for (const link of links.results ?? []) {
    const saved = parseJsonColumn<AirtableTableStructure | null>(link.remote_state, null)
    if (!saved || saved.tableId !== tableId) continue
    const fields = [...saved.fields]
    for (const f of created) {
      if (!fields.some((existing) => existing.id === f.columnId)) {
        fields.push({ id: f.columnId, name: f.title, type: f.columnType })
      }
    }
    await env.AQUILLA_PG.prepare("UPDATE integration_links SET remote_state = ?::jsonb, updated_at = now() WHERE id = ?")
      .bind(JSON.stringify({ ...saved, fields }), link.id)
      .run()
  }
}

airtable.post("/projects/:projectId/sync", authMiddleware, async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "project has no Airtable link" }, 404)
  // The Sync switch is off: nothing writes to the table, a manual push included.
  if (!link.enabled) return c.json({ error: "sync is paused for this project" }, 409)
  return c.json(await pushAirtableLink(c.env, link))
})

export default airtable
