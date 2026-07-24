// Monday push engine — upserts one board item per entity (project, or one per
// file) and writes the mapped metric columns. Contract §"Push engine".
//
// Idempotency: integration_item_links is the primary key store; matchExisting
// (external-id column lookup or name match) recovers pre-existing items before
// creating new ones. Mutations are batched ~10 per HTTP request via GraphQL
// aliases (client.ts) and 429s get a single retry_in_seconds retry.
//
// Unknown-column write failures mark remote_state_stale, drop the failing column
// from THIS push, and record last_push_error naming the column — the next PUT
// /link re-validates against live structure.

import type { Env } from "../../types"
import {
  parseJsonColumn,
  sanitizeMapping,
  PROVIDER,
  type IntegrationLinkRow,
  type IntegrationConnectionRow,
  type MondayMapping,
  type MondayMetricKey,
} from "./types"
import { getConnectionAccessToken } from "./tokens"
import {
  findItemByColumnValue,
  findItemByName,
  gqlString,
  runAliasedMutations,
  type AliasedMutation,
} from "./client"
import { computeProjectMetrics, type MondayEntityMetrics } from "./metrics"

export interface PushResult {
  ok: boolean
  pushed: boolean
  itemsUpserted?: number
  error?: string
}

interface PushEntity {
  kind: "project" | "file"
  id: string
  itemName: string
  metrics: MondayEntityMetrics
}

/** Format one metric as the Monday column_values JSON value for its column type. */
function columnValueFor(
  metric: MondayMetricKey,
  columnType: string,
  entity: PushEntity,
): unknown {
  const m = entity.metrics
  switch (metric) {
    case "completion_pct":
    case "validated_pct":
    case "audio_validated_pct":
    case "filled_count":
    case "total_count":
    case "validated_count":
      // numbers and text columns both take the stringified value.
      return String(m[metric])
    case "translators":
      return m.translators
    case "last_activity":
      return columnType === "date" ? { date: m.last_activity } : m.last_activity
    case "status_auto":
      return columnType === "status" ? { label: m.status_auto } : m.status_auto
    case "project_name":
      return entity.itemName
    case "external_id":
      return entity.id
  }
}

function buildColumnValues(
  mapping: MondayMapping,
  entity: PushEntity,
  excludedColumnIds: ReadonlySet<string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const col of mapping.columns) {
    if (excludedColumnIds.has(col.columnId)) continue
    values[col.columnId] = columnValueFor(col.metric, col.columnType, entity)
  }
  return values
}

function renderItemName(
  template: string | undefined,
  granularity: MondayMapping["itemGranularity"],
  projectName: string,
  fileName?: string,
): string {
  const tpl =
    template ?? (granularity === "file" ? "{projectName} — {fileName}" : "{projectName}")
  return tpl
    .replaceAll("{projectName}", projectName)
    .replaceAll("{fileName}", fileName ?? "")
    .trim()
}

/** Extract the failing column id from a Monday column error message, if present. */
function failingColumnId(message: string, mapping: MondayMapping): string | null {
  if (!/column/i.test(message)) return null
  for (const col of mapping.columns) {
    if (message.includes(col.columnId)) return col.columnId
  }
  return null
}

async function loadConnectionToken(
  env: Env,
  connectionId: string,
): Promise<string | null> {
  const conn = await env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_connections WHERE id = ?",
  )
    .bind(connectionId)
    .first<IntegrationConnectionRow>()
  if (!conn) return null
  // Refreshes near-expiry OAuth 2.1 tokens; throws MondayAuthError (and marks
  // needs_reauth) when the refresh token is dead — caller records the error.
  return getConnectionAccessToken(env, conn)
}

async function recordPushOutcome(
  env: Env,
  linkId: string,
  status: "ok" | "error",
  error: string | null,
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `UPDATE integration_links
        SET last_pushed_at = now(), last_push_status = ?, last_push_error = ?,
            dirty_at = NULL, updated_at = now()
      WHERE id = ?`,
  )
    .bind(status, error, linkId)
    .run()
}

/**
 * Push one board link now. Computes metrics, upserts items, writes columns,
 * and records last_pushed_at/status/error + clears dirty_at.
 */
export async function pushBoardLink(env: Env, link: IntegrationLinkRow): Promise<PushResult> {
  const { mapping } = sanitizeMapping(parseJsonColumn(link.config, null))
  if (!mapping) {
    await recordPushOutcome(env, link.id, "error", "invalid mapping config")
    return { ok: false, pushed: false, error: "invalid mapping config" }
  }

  let token: string | null
  try {
    token = await loadConnectionToken(env, link.connection_id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordPushOutcome(env, link.id, "error", `token decrypt failed: ${message}`)
    return { ok: false, pushed: false, error: "token decrypt failed" }
  }
  if (!token) {
    await recordPushOutcome(env, link.id, "error", "org connection missing")
    return { ok: false, pushed: false, error: "org connection missing" }
  }

  const summary = await computeProjectMetrics(env.AQUILLA_PG, link.project_id)
  if (!summary) {
    await recordPushOutcome(env, link.id, "error", "project not found")
    return { ok: false, pushed: false, error: "project not found" }
  }

  const entities: PushEntity[] =
    mapping.itemGranularity === "project"
      ? [
          {
            kind: "project",
            id: summary.projectId,
            itemName: renderItemName(
              mapping.itemNameTemplate,
              "project",
              summary.projectName,
            ),
            metrics: summary.project,
          },
        ]
      : summary.files.map((f) => ({
          kind: "file" as const,
          id: f.fileId,
          itemName: renderItemName(
            mapping.itemNameTemplate,
            "file",
            summary.projectName,
            f.fileName,
          ),
          metrics: f.metrics,
        }))

  try {
    const itemsUpserted = await upsertEntities(env, link, mapping, token, entities)
    await recordPushOutcome(env, link.id, "ok", null)
    return { ok: true, pushed: true, itemsUpserted }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedColumn = failingColumnId(message, mapping)
    if (failedColumn) {
      // Board structure drifted under us — flag for re-review; the failing
      // column is excluded from the retry inside upsertEntities already.
      await env.AQUILLA_PG.prepare(
        "UPDATE integration_links SET remote_state_stale = TRUE WHERE id = ?",
      )
        .bind(link.id)
        .run()
      await recordPushOutcome(
        env,
        link.id,
        "error",
        `column '${failedColumn}' failed to write (board structure changed?): ${message}`,
      )
      return { ok: false, pushed: true, error: `column '${failedColumn}' failed` }
    }
    await recordPushOutcome(env, link.id, "error", message)
    return { ok: false, pushed: false, error: message }
  }
}

async function upsertEntities(
  env: Env,
  link: IntegrationLinkRow,
  mapping: MondayMapping,
  token: string,
  entities: PushEntity[],
): Promise<number> {
  // 1. Existing item links.
  const linksResult = await env.AQUILLA_PG.prepare(
    "SELECT entity_kind, entity_id, external_item_id FROM integration_item_links WHERE link_id = ?",
  )
    .bind(link.id)
    .all<{ entity_kind: string; entity_id: string; external_item_id: string }>()
  const itemIdByEntity = new Map(
    (linksResult.results ?? []).map((r) => [`${r.entity_kind}:${r.entity_id}`, r.external_item_id]),
  )

  // 2. Resolve missing items via matchExisting (external-id column or name).
  const externalIdColumn =
    mapping.matchExisting && "columnId" in mapping.matchExisting
      ? mapping.matchExisting.columnId
      : mapping.columns.find((c) => c.metric === "external_id")?.columnId
  const toCreate: PushEntity[] = []
  for (const entity of entities) {
    const key = `${entity.kind}:${entity.id}`
    if (itemIdByEntity.has(key)) continue
    let matched: string | null = null
    if (mapping.matchExisting) {
      matched =
        "columnId" in mapping.matchExisting && externalIdColumn
          ? await findItemByColumnValue(token, link.external_id, externalIdColumn, entity.id)
          : await findItemByName(token, link.external_id, entity.itemName)
    }
    if (matched) {
      itemIdByEntity.set(key, matched)
      await saveItemLink(env, link.id, entity, matched)
    } else {
      toCreate.push(entity)
    }
  }

  // 3. Create missing items (aliased batches; column values included up-front).
  if (toCreate.length > 0) {
    const mutations: AliasedMutation[] = toCreate.map((entity, i) => {
      const values = buildColumnValues(mapping, entity, new Set())
      const group = mapping.groupId ? `, group_id: ${gqlString(mapping.groupId)}` : ""
      return {
        alias: `c${i}`,
        body: `create_item(board_id: ${gqlString(link.external_id)}${group}, item_name: ${gqlString(entity.itemName)}, column_values: ${gqlString(JSON.stringify(values))}, create_labels_if_missing: true) { id }`,
      }
    })
    const created = await runAliasedMutations(token, mutations)
    for (let i = 0; i < toCreate.length; i++) {
      const id = created[`c${i}`]?.id
      if (id == null) throw new Error("create_item returned no id")
      const entity = toCreate[i]
      itemIdByEntity.set(`${entity.kind}:${entity.id}`, String(id))
      await saveItemLink(env, link.id, entity, String(id))
    }
  }

  // 4. Update column values on already-known items.
  const toUpdate = entities.filter(
    (e) => itemIdByEntity.has(`${e.kind}:${e.id}`) && !toCreate.includes(e),
  )
  if (toUpdate.length > 0) {
    const buildUpdateMutations = (excluded: ReadonlySet<string>): AliasedMutation[] =>
      toUpdate.map((entity, i) => ({
        alias: `u${i}`,
        body: `change_multiple_column_values(board_id: ${gqlString(link.external_id)}, item_id: ${gqlString(itemIdByEntity.get(`${entity.kind}:${entity.id}`) ?? "")}, column_values: ${gqlString(JSON.stringify(buildColumnValues(mapping, entity, excluded)))}, create_labels_if_missing: true) { id }`,
      }))
    try {
      await runAliasedMutations(token, buildUpdateMutations(new Set()))
    } catch (err) {
      // Unknown-column error: drop the failing column and retry this push
      // once without it, then surface the error to the caller for recording.
      const message = err instanceof Error ? err.message : String(err)
      const failed = failingColumnId(message, mapping)
      if (!failed) throw err
      await runAliasedMutations(token, buildUpdateMutations(new Set([failed])))
      throw err
    }
  }

  return entities.length
}

async function saveItemLink(
  env: Env,
  linkId: string,
  entity: PushEntity,
  mondayItemId: string,
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_item_links (link_id, entity_kind, entity_id, external_item_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (link_id, entity_kind, entity_id)
     DO UPDATE SET external_item_id = EXCLUDED.external_item_id`,
  )
    .bind(linkId, entity.kind, entity.id, mondayItemId)
    .run()
}

/** How recent a push must be for /internal/push to debounce instead (seconds). */
export const PUSH_DEBOUNCE_SECONDS = 120

/**
 * Debounced push for one project (fired by sync-worker on progress change):
 * push now if the last push is older than the debounce window, else mark
 * dirty for the cron to flush.
 */
export async function schedulePush(env: Env, projectId: string): Promise<PushResult> {
  const link = await env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_links WHERE project_id = ? AND provider = ? AND enabled = TRUE",
  )
    .bind(projectId, PROVIDER)
    .first<IntegrationLinkRow>()
  if (!link) return { ok: true, pushed: false }

  if (link.last_pushed_at) {
    const ageMs = Date.now() - new Date(link.last_pushed_at).getTime()
    if (ageMs < PUSH_DEBOUNCE_SECONDS * 1000) {
      await env.AQUILLA_PG.prepare(
        "UPDATE integration_links SET dirty_at = COALESCE(dirty_at, now()) WHERE id = ?",
      )
        .bind(link.id)
        .run()
      return { ok: true, pushed: false }
    }
  }
  return pushBoardLink(env, link)
}

/** Cron flush: push dirty enabled links, oldest first, capped per run. */
export async function flushDirtyLinks(env: Env, cap = 20): Promise<number> {
  const result = await env.AQUILLA_PG.prepare(
    `SELECT * FROM integration_links
      WHERE dirty_at IS NOT NULL AND enabled = TRUE AND provider = ?
      ORDER BY dirty_at ASC
      LIMIT ?`,
  )
    .bind(PROVIDER, cap)
    .all<IntegrationLinkRow>()
  let flushed = 0
  for (const link of result.results ?? []) {
    try {
      await pushBoardLink(env, link)
      flushed++
    } catch (err) {
      console.error(`[monday] cron push failed for link ${link.id}:`, err)
    }
  }
  return flushed
}
