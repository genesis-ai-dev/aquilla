// Monday push engine — upserts one board item per entity (project, or one per
// file) and writes the mapped metric columns. Contract §"Push engine". With
// `fileSubitems` on, the project's item then gets one subitem per file
// (subitems.ts).
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
import { computeProjectMetrics } from "./metrics"
import { recordPushOutcome, type PushResult } from "../integrations/push-state"
import { renderItemName, templateNamesFile } from "../integrations/item-name"
import { buildColumnValues, failingColumnId, type PushEntity } from "./values"
import { pushFileSubitems } from "./subitems"
import { saveItemLinks, type ItemLinkPair } from "./item-links"

export type { PushResult } from "../integrations/push-state"

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

  // A template written for the project's row would name every file's row the
  // same, and one written for a file's row would leave the project's ending in
  // a dash, so each kind of row only uses a template written for it.
  const namesFile = templateNamesFile(mapping.itemNameTemplate)
  const entities: PushEntity[] =
    mapping.itemGranularity === "project"
      ? [
          {
            kind: "project",
            id: summary.projectId,
            itemName: renderItemName(
              namesFile ? undefined : mapping.itemNameTemplate,
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
            namesFile ? mapping.itemNameTemplate : undefined,
            "file",
            summary.projectName,
            f.fileName,
          ),
          metrics: f.metrics,
        }))

  try {
    const itemIds = await upsertEntities(env, link, mapping, token, entities)
    let itemsUpserted = entities.length
    // Files as subitems: under the project's row, named for the file alone.
    const parentItemId = itemIds.get(`project:${summary.projectId}`)
    if (mapping.itemGranularity === "project" && mapping.fileSubitems && parentItemId) {
      itemsUpserted += await pushFileSubitems(
        env,
        link,
        mapping,
        token,
        parentItemId,
        summary.files.map((f) => ({ kind: "file", id: f.fileId, itemName: f.fileName, metrics: f.metrics })),
      )
    }
    await recordPushOutcome(env, link, "ok", null)
    return { ok: true, pushed: true, linked: true, itemsUpserted }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedColumn = failingColumnId(message, mapping.columns)
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

/** Upsert the board's own rows; answers every entity's item id, keyed `kind:id`. */
async function upsertEntities(
  env: Env,
  link: IntegrationLinkRow,
  mapping: MondayMapping,
  token: string,
  entities: PushEntity[],
): Promise<Map<string, string>> {
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
    await saveItemLinks(env, link.id, matchedLinks.map(linkPair))
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
      const values = buildColumnValues(mapping.columns, entity, new Set())
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
    await saveItemLinks(env, link.id, createdLinks.map(linkPair))
  }

  // 4. Update column values on already-known items.
  const toUpdate = entities.filter(
    (e) => itemIdByEntity.has(`${e.kind}:${e.id}`) && !toCreate.includes(e),
  )
  if (toUpdate.length > 0) {
    const buildUpdateMutations = (excluded: ReadonlySet<string>): AliasedMutation[] =>
      toUpdate.map((entity, i) => ({
        alias: `u${i}`,
        body: `change_multiple_column_values(board_id: ${gqlString(link.external_id)}, item_id: ${gqlString(itemIdByEntity.get(`${entity.kind}:${entity.id}`) ?? "")}, column_values: ${gqlString(JSON.stringify(buildColumnValues(mapping.columns, entity, excluded)))}, create_labels_if_missing: true) { id }`,
      }))
    try {
      await runAliasedMutations(token, buildUpdateMutations(new Set()))
    } catch (err) {
      // Unknown-column error: drop the failing column and retry this push
      // once without it, then surface the error to the caller for recording.
      const message = err instanceof Error ? err.message : String(err)
      const failed = failingColumnId(message, mapping.columns)
      if (!failed) throw err
      await runAliasedMutations(token, buildUpdateMutations(new Set([failed])))
      throw err
    }
  }

  return itemIdByEntity
}

const linkPair = ({ entity, itemId }: { entity: PushEntity; itemId: string }): ItemLinkPair => ({
  kind: entity.kind,
  id: entity.id,
  itemId,
})

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
