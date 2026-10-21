// Airtable push engine (AQU-804) — Monday's push (lib/monday/push.ts) for a
// table: one record per entity (the project, each file, or both), the mapped
// metrics written into their fields.
//
// Finding the records Aquilla made before:
//   * With an Aquilla ID field (always added by setup, and mapped whenever the
//     table has one) every push is an Airtable upsert merged on it — a record
//     the user deleted is simply made again, and nothing is ever doubled.
//   * Without one, integration_item_links remembers each entity's record; the
//     table is read once per push so a deleted record is recreated, and with
//     matchExisting byName a record already named like the entity is adopted.
//
// When a link pushes is decided in lib/integrations/push.ts, for every
// provider; the outcome (and the AQU-1828 backoff on a transient failure) is
// recorded through lib/integrations/push-state.ts.

import type { Env } from "../../types"
import { parseJsonColumn, type IntegrationConnectionRow, type IntegrationLinkRow } from "../monday/types"
import { computeProjectMetrics, type MondayEntityMetrics } from "../monday/metrics"
import { recordPushOutcome, type PushResult } from "../integrations/push-state"
import {
  airtableClient,
  createRecords,
  listRecords,
  updateRecords,
  upsertRecords,
  AirtableApiError,
  type AirtableClient,
} from "./client"
import { AirtableForeignConnectionError, getAirtableToken, markAirtableNeedsNewToken } from "./tokens"
import {
  sanitizeAirtableMapping,
  type AirtableMapping,
  type AirtableMetricKey,
  type AirtableTableStructure,
} from "./types"

interface PushEntity {
  kind: "project" | "file"
  id: string
  itemName: string
  metrics: MondayEntityMetrics
}

const PERCENT_METRICS = new Set<AirtableMetricKey>([
  "completion_pct",
  "validated_pct",
  "audio_validated_pct",
  "has_audio_pct",
])

/** A number into a field of `fieldType`: a percent field holds a fraction (70% is 0.7). */
function numberValue(value: number | null, fieldType: string, percent = false): unknown {
  if (value == null) return null
  if (fieldType === "percent") return percent ? Math.round(value * 10) / 1000 : value / 100
  if (fieldType === "number") return value
  return String(value)
}

/** Format one metric as the value its Airtable field takes. `null` clears the cell. */
export function fieldValueFor(metric: AirtableMetricKey, fieldType: string, entity: PushEntity): unknown {
  const m = entity.metrics
  switch (metric) {
    case "completion_pct":
    case "validated_pct":
    case "audio_validated_pct":
    case "has_audio_pct":
      return numberValue(m[metric], fieldType, PERCENT_METRICS.has(metric))
    case "filled_count":
    case "total_count":
    case "validated_count":
    case "active_contributors_30d":
    case "recorded_minutes":
    case "days_since_activity":
      return numberValue(m[metric], fieldType)
    case "last_activity":
      return m.last_activity || null
    case "deadline":
    case "next_target_date":
      // No date clears the cell.
      return m[metric] || null
    case "status_auto":
    case "schedule_status":
    case "translators":
    case "project_link":
    case "books_done":
    case "project_manager":
    case "languages":
    case "books_in_progress":
      // Text, a single-select label (typecast adds a missing choice), or a URL.
      return m[metric] || null
    case "project_name":
      return entity.itemName
    case "external_id":
      return entity.id
  }
}

function recordFields(
  mapping: AirtableMapping,
  entity: PushEntity,
  excluded: ReadonlySet<string>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const col of mapping.columns) {
    if (excluded.has(col.columnId)) continue
    fields[col.columnId] = fieldValueFor(col.metric, col.columnType, entity)
  }
  return fields
}

function renderItemName(template: string | undefined, kind: PushEntity["kind"], projectName: string, fileName?: string): string {
  const tpl = template ?? (kind === "file" ? "{projectName} — {fileName}" : "{projectName}")
  return tpl
    .replaceAll("{projectName}", projectName)
    .replaceAll("{fileName}", fileName ?? "")
    .trim()
}

/**
 * The mapped field an Airtable refusal names, if any: by id (we write by id),
 * or by its name from the saved table structure (some messages use names).
 */
function failingFieldId(err: unknown, mapping: AirtableMapping, link: IntegrationLinkRow): string | null {
  if (!(err instanceof AirtableApiError) || err.status !== 422) return null
  const structure = parseJsonColumn<AirtableTableStructure | null>(link.remote_state, null)
  for (const col of mapping.columns) {
    if (err.message.includes(col.columnId)) return col.columnId
    const name = structure?.fields.find((f) => f.id === col.columnId)?.name
    if (name && err.message.includes(`"${name}"`)) return col.columnId
  }
  return null
}

/**
 * Is this failure worth retrying? Rate limits, Airtable server faults and
 * network/unknown throws are; a refused request (bad field, no permission,
 * dead token) would fail identically next minute.
 */
export function isTransientAirtableError(err: unknown): boolean {
  if (err instanceof AirtableApiError) return err.status === 429 || err.status >= 500
  return true
}

/** The entities a push writes, in the order their records are kept. */
function entitiesFor(
  mapping: AirtableMapping,
  summary: NonNullable<Awaited<ReturnType<typeof computeProjectMetrics>>>,
): PushEntity[] {
  // A project-shaped template ("{projectName}") would name every file's record
  // the same, and a file-shaped one would leave the project's record ending in
  // a dash, so each kind of record only uses a template written for it.
  const template = mapping.itemNameTemplate
  const namesFile = Boolean(template?.includes("{fileName}"))
  const project: PushEntity = {
    kind: "project",
    id: summary.projectId,
    itemName: renderItemName(namesFile ? undefined : template, "project", summary.projectName),
    metrics: summary.project,
  }
  const fileTemplate = namesFile ? template : undefined
  const files = summary.files.map((f) => ({
    kind: "file" as const,
    id: f.fileId,
    itemName: renderItemName(fileTemplate, "file", summary.projectName, f.fileName),
    metrics: f.metrics,
  }))
  if (mapping.itemGranularity === "project") return [project]
  if (mapping.itemGranularity === "file") return files
  return [project, ...files]
}

/** Push one Airtable link now and record the outcome. */
export async function pushAirtableLink(env: Env, link: IntegrationLinkRow): Promise<PushResult> {
  const { mapping } = sanitizeAirtableMapping(parseJsonColumn(link.config, null))
  if (!mapping) {
    await recordPushOutcome(env, link, "error", "invalid mapping config")
    return { ok: false, pushed: false, linked: true, error: "invalid mapping config" }
  }

  const conn = await env.AQUILLA_PG.prepare("SELECT * FROM integration_connections WHERE id = ?")
    .bind(link.connection_id)
    .first<IntegrationConnectionRow>()
  if (!conn) {
    await recordPushOutcome(env, link, "error", "org connection missing")
    return { ok: false, pushed: false, linked: true, error: "org connection missing" }
  }
  let token: string
  try {
    token = await getAirtableToken(env, conn)
  } catch (err) {
    // AQU-1775: another deployment's row; permanent, like every refusal here.
    if (err instanceof AirtableForeignConnectionError) {
      await recordPushOutcome(env, link, "error", err.message)
      return { ok: false, pushed: false, linked: true, error: err.message }
    }
    const message = err instanceof Error ? err.message : String(err)
    await recordPushOutcome(env, link, "error", `token decrypt failed: ${message}`)
    return { ok: false, pushed: false, linked: true, error: "token decrypt failed" }
  }

  const summary = await computeProjectMetrics(env.AQUILLA_PG, link.project_id, { appBaseUrl: env.BASE_URL })
  if (!summary) {
    await recordPushOutcome(env, link, "error", "project not found")
    return { ok: false, pushed: false, linked: true, error: "project not found" }
  }

  const entities = entitiesFor(mapping, summary)
  const client = airtableClient(env, token)
  try {
    const excluded = new Set<string>()
    try {
      await writeRecords(env, client, link, mapping, entities, excluded)
    } catch (err) {
      // A field the table no longer accepts: write everything else, then
      // report the field (the table changed under the mapping).
      const failed = failingFieldId(err, mapping, link)
      if (!failed) throw err
      excluded.add(failed)
      await writeRecords(env, client, link, mapping, entities, excluded).catch(() => undefined)
      await env.AQUILLA_PG.prepare("UPDATE integration_links SET remote_state_stale = TRUE WHERE id = ?")
        .bind(link.id)
        .run()
      const message = `field '${failed}' failed to write (table changed?): ${err instanceof Error ? err.message : String(err)}`
      await recordPushOutcome(env, link, "error", message)
      return { ok: false, pushed: true, linked: true, error: `field '${failed}' failed` }
    }
    await recordPushOutcome(env, link, "ok", null)
    return { ok: true, pushed: true, linked: true, itemsUpserted: entities.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A rejected token: the org needs to paste a new one (the settings page says so).
    if (err instanceof AirtableApiError && err.status === 401) {
      await markAirtableNeedsNewToken(env, conn.id)
    }
    const transient = isTransientAirtableError(err)
    const { retryScheduled } = await recordPushOutcome(env, link, "error", message, transient)
    return { ok: false, pushed: false, linked: true, error: message, retryScheduled }
  }
}

async function writeRecords(
  env: Env,
  client: AirtableClient,
  link: IntegrationLinkRow,
  mapping: AirtableMapping,
  entities: PushEntity[],
  excluded: ReadonlySet<string>,
): Promise<void> {
  if (entities.length === 0) return
  const baseId = link.external_id
  const tableId = mapping.tableId
  const mergeFieldId =
    mapping.matchExisting && "columnId" in mapping.matchExisting && !excluded.has(mapping.matchExisting.columnId)
      ? mapping.matchExisting.columnId
      : null

  if (mergeFieldId) {
    const ids = await upsertRecords(
      client,
      baseId,
      tableId,
      mergeFieldId,
      entities.map((e) => recordFields(mapping, e, excluded)),
    )
    await saveItemLinks(env, link.id, entities.map((entity, i) => ({ entity, recordId: ids[i]! })))
    return
  }

  // No Aquilla ID field: the records we remember, checked against the table.
  const known = await env.AQUILLA_PG.prepare(
    "SELECT entity_kind, entity_id, external_item_id FROM integration_item_links WHERE link_id = ?",
  )
    .bind(link.id)
    .all<{ entity_kind: string; entity_id: string; external_item_id: string }>()
  const remembered = new Map((known.results ?? []).map((r) => [`${r.entity_kind}:${r.entity_id}`, r.external_item_id]))
  const nameField = mapping.columns.find((c) => c.metric === "project_name")?.columnId
  const byName = Boolean(mapping.matchExisting && "byName" in mapping.matchExisting && nameField)
  const records = await listRecords(client, baseId, tableId, { fieldIds: nameField ? [nameField] : [] })
  const existing = new Set(records.map((r) => r.id))
  const nameIndex = new Map<string, string>()
  if (byName && nameField) {
    for (const r of records) {
      const key = String(r.fields[nameField] ?? "").trim().toLowerCase()
      if (key && !nameIndex.has(key)) nameIndex.set(key, r.id)
    }
  }

  const updates: Array<{ entity: PushEntity; recordId: string }> = []
  const creates: PushEntity[] = []
  for (const entity of entities) {
    const id = remembered.get(`${entity.kind}:${entity.id}`)
    const adopted = byName ? nameIndex.get(entity.itemName.trim().toLowerCase()) : undefined
    if (id && existing.has(id)) updates.push({ entity, recordId: id })
    else if (adopted) updates.push({ entity, recordId: adopted })
    else creates.push(entity)
  }
  if (updates.length > 0) {
    await updateRecords(
      client,
      baseId,
      tableId,
      updates.map(({ entity, recordId }) => ({ id: recordId, fields: recordFields(mapping, entity, excluded) })),
    )
  }
  const createdIds =
    creates.length > 0
      ? await createRecords(client, baseId, tableId, creates.map((e) => recordFields(mapping, e, excluded)))
      : []
  await saveItemLinks(env, link.id, [
    ...updates,
    ...creates.map((entity, i) => ({ entity, recordId: createdIds[i]! })),
  ])
}

/** Rows per item-link upsert statement (as Monday's AQU-1828 batching). */
const ITEM_LINK_WRITE_BATCH = 100

async function saveItemLinks(
  env: Env,
  linkId: string,
  pairs: Array<{ entity: PushEntity; recordId: string }>,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += ITEM_LINK_WRITE_BATCH) {
    const batch = pairs.slice(i, i + ITEM_LINK_WRITE_BATCH)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO integration_item_links (link_id, entity_kind, entity_id, external_item_id)
       VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")}
       ON CONFLICT (link_id, entity_kind, entity_id)
       DO UPDATE SET external_item_id = EXCLUDED.external_item_id`,
    )
      .bind(...batch.flatMap(({ entity, recordId }) => [linkId, entity.kind, entity.id, recordId]))
      .run()
  }
}
