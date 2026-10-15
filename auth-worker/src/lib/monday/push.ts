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
//
// AQU-1828: a push that fails for a TRANSIENT reason (429, Monday 5xx, network)
// keeps the link dirty and sets next_retry_at to an exponential backoff, so the
// cron flush tries again instead of dropping it. Permanent failures (bad
// mapping, dead re-auth, board-structure drift) still clear dirty_at — retrying
// them changes nothing and would starve the flush cap. Item resolution for a
// first push is batched into one Monday query for all entities rather than one
// per file.
//
// When a link pushes (edit nudge, cron flush, settings change) is decided for
// every provider at once in lib/integrations/push.ts (AQU-804).

import type { Env } from "../../types"
import {
  parseJsonColumn,
  sanitizeMapping,
  type IntegrationLinkRow,
  type IntegrationConnectionRow,
  type MondayMapping,
  type MondayMetricKey,
} from "./types"
import { getConnectionAccessToken, MondayForeignConnectionError } from "./tokens"
import {
  fetchBoardItemNameIndex,
  findItemsByColumnValues,
  gqlString,
  normalizeItemName,
  runAliasedMutations,
  MondayApiError,
  type AliasedMutation,
} from "./client"
import { computeProjectMetrics, type MondayEntityMetrics } from "./metrics"
import { recordPushOutcome, type PushResult } from "../integrations/push-state"

export type { PushResult } from "../integrations/push-state"

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
    case "has_audio_pct":
    case "active_contributors_30d":
    case "recorded_minutes":
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
    case "deadline":
      // No deadline clears the cell: Monday treats an empty string as "clear"
      // for every column type, a date column included.
      if (!m.deadline) return ""
      return columnType === "date" ? { date: m.deadline } : m.deadline
    case "next_target_date":
      if (!m.next_target_date) return ""
      return columnType === "date" ? { date: m.next_target_date } : m.next_target_date
    case "days_since_activity":
      return m.days_since_activity == null ? "" : String(m.days_since_activity)
    case "project_link":
      return columnType === "link" ? { url: m.project_link, text: "Open in Aquilla" } : m.project_link
    case "schedule_status":
      return columnType === "status" ? { label: m.schedule_status } : m.schedule_status
    case "books_done":
    case "project_manager":
    case "languages":
    case "books_in_progress":
      return m[metric]
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

/**
 * Is this failure worth retrying? Rate limits, Monday server faults and
 * network/unknown throws are; a rejected query, an unknown column or a dead
 * token are not — the same push would fail identically next minute.
 */
export function isTransientPushError(err: unknown): boolean {
  if (err instanceof MondayApiError) {
    if (err.status === 429 || err.status >= 500) return true
    // Budget/complexity exhaustion arrives as a GraphQL error on an HTTP 200.
    return /rate.?limit|complexity|budget|too many|timeout|try again|temporarily/i.test(
      err.message,
    )
  }
  // fetch failures, aborts and anything unclassified: one more go is cheap.
  return true
}

/**
 * Push one board link now. Computes metrics, upserts items, writes columns,
 * and records last_pushed_at/status/error + clears dirty_at.
 */
export async function pushBoardLink(env: Env, link: IntegrationLinkRow): Promise<PushResult> {
  const { mapping } = sanitizeMapping(parseJsonColumn(link.config, null))
  if (!mapping) {
    await recordPushOutcome(env, link, "error", "invalid mapping config")
    return { ok: false, pushed: false, linked: true, error: "invalid mapping config" }
  }

  let token: string | null
  try {
    token = await loadConnectionToken(env, link.connection_id)
  } catch (err) {
    // AQU-1775: a row another deployment made is refused before any decrypt
    // or refresh. Permanent — this worker can never use it — so it clears
    // dirty_at like every other permanent failure.
    if (err instanceof MondayForeignConnectionError) {
      await recordPushOutcome(env, link, "error", err.message)
      return { ok: false, pushed: false, linked: true, error: err.message }
    }
    const message = err instanceof Error ? err.message : String(err)
    await recordPushOutcome(env, link, "error", `token decrypt failed: ${message}`)
    return { ok: false, pushed: false, linked: true, error: "token decrypt failed" }
  }
  if (!token) {
    await recordPushOutcome(env, link, "error", "org connection missing")
    return { ok: false, pushed: false, linked: true, error: "org connection missing" }
  }

  const summary = await computeProjectMetrics(env.AQUILLA_PG, link.project_id, { appBaseUrl: env.BASE_URL })
  if (!summary) {
    await recordPushOutcome(env, link, "error", "project not found")
    return { ok: false, pushed: false, linked: true, error: "project not found" }
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
    await recordPushOutcome(env, link, "ok", null)
    return { ok: true, pushed: true, linked: true, itemsUpserted }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedColumn = failingColumnId(message, mapping)
    if (failedColumn) {
      // Board structure drifted under us — flag for re-review; the failing
      // column is excluded from the retry inside upsertEntities already.
      // Permanent: the next PUT /link re-validates, a retry would not help.
      await env.AQUILLA_PG.prepare(
        "UPDATE integration_links SET remote_state_stale = TRUE WHERE id = ?",
      )
        .bind(link.id)
        .run()
      await recordPushOutcome(
        env,
        link,
        "error",
        `column '${failedColumn}' failed to write (board structure changed?): ${message}`,
      )
      return { ok: false, pushed: true, linked: true, error: `column '${failedColumn}' failed` }
    }
    const transient = isTransientPushError(err)
    const { retryScheduled } = await recordPushOutcome(env, link, "error", message, transient)
    return { ok: false, pushed: false, linked: true, error: message, retryScheduled }
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
  //    AQU-1828: ONE lookup for every unresolved entity. This used to run one
  //    Monday query per entity, so first-linking a 66-book project spent 66
  //    subrequests here before it created a single item.
  const externalIdColumn =
    mapping.matchExisting && "columnId" in mapping.matchExisting
      ? mapping.matchExisting.columnId
      : mapping.columns.find((c) => c.metric === "external_id")?.columnId
  const unresolved = entities.filter((e) => !itemIdByEntity.has(`${e.kind}:${e.id}`))
  const toCreate: PushEntity[] = []
  const matchedLinks: Array<{ entity: PushEntity; itemId: string }> = []
  if (unresolved.length > 0 && !mapping.matchExisting) {
    toCreate.push(...unresolved)
  } else if (unresolved.length > 0) {
    const byColumn = "columnId" in mapping.matchExisting! && externalIdColumn != null
    const matches = byColumn
      ? await findItemsByColumnValues(
          token,
          link.external_id,
          externalIdColumn!,
          unresolved.map((e) => e.id),
        )
      : await fetchBoardItemNameIndex(token, link.external_id)
    for (const entity of unresolved) {
      const matched = byColumn
        ? matches.get(entity.id)
        : matches.get(normalizeItemName(entity.itemName))
      if (matched) {
        itemIdByEntity.set(`${entity.kind}:${entity.id}`, matched)
        matchedLinks.push({ entity, itemId: matched })
      } else {
        toCreate.push(entity)
      }
    }
    await saveItemLinks(env, link.id, matchedLinks)
    // A row Aquilla adopts from the board (found by its Aquilla ID or name,
    // not created) joins the projects group, like a row it creates. Only at
    // adoption: later pushes never move a row the user dragged elsewhere.
    if (mapping.groupId && matchedLinks.length > 0) {
      await moveItemsToGroupBestEffort(
        token,
        matchedLinks.map((m) => m.itemId),
        mapping.groupId,
      )
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
    const createdLinks: Array<{ entity: PushEntity; itemId: string }> = []
    for (let i = 0; i < toCreate.length; i++) {
      const id = created[`c${i}`]?.id
      if (id == null) throw new Error("create_item returned no id")
      const entity = toCreate[i]
      itemIdByEntity.set(`${entity.kind}:${entity.id}`, String(id))
      createdLinks.push({ entity, itemId: String(id) })
    }
    await saveItemLinks(env, link.id, createdLinks)
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

/** Move rows into a group; a failure never fails the push (the values still land). */
async function moveItemsToGroupBestEffort(token: string, itemIds: string[], groupId: string): Promise<void> {
  try {
    await runAliasedMutations(
      token,
      itemIds.map((itemId, i) => ({
        alias: `g${i}`,
        body: `move_item_to_group(item_id: ${gqlString(itemId)}, group_id: ${gqlString(groupId)}) { id }`,
      })),
    )
  } catch (err) {
    console.warn("[monday] moving adopted rows into the projects group failed (best-effort):", err)
  }
}

/** Rows per item-link upsert statement — keeps a 66-file push to one write. */
const ITEM_LINK_WRITE_BATCH = 100

/**
 * Upsert the entity → Monday item mappings in one statement per batch
 * (AQU-1828: this used to be one statement per entity, so a first push over a
 * whole Bible issued ~130 DB round trips on top of the Monday calls).
 */
async function saveItemLinks(
  env: Env,
  linkId: string,
  pairs: Array<{ entity: PushEntity; itemId: string }>,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += ITEM_LINK_WRITE_BATCH) {
    const batch = pairs.slice(i, i + ITEM_LINK_WRITE_BATCH)
    const values = batch.map(() => "(?, ?, ?, ?)").join(", ")
    const bindings = batch.flatMap(({ entity, itemId }) => [
      linkId,
      entity.kind,
      entity.id,
      itemId,
    ])
    await env.AQUILLA_PG.prepare(
      `INSERT INTO integration_item_links (link_id, entity_kind, entity_id, external_item_id)
       VALUES ${values}
       ON CONFLICT (link_id, entity_kind, entity_id)
       DO UPDATE SET external_item_id = EXCLUDED.external_item_id`,
    )
      .bind(...bindings)
      .run()
  }
}
