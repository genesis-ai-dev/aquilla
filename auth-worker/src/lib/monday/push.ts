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

import type { Env } from "../../types"
import { makePostgres, type AquillaDb } from "../../../../db/shim/postgres"
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
  fetchBoardItemNameIndex,
  findItemsByColumnValues,
  gqlString,
  normalizeItemName,
  runAliasedMutations,
  MondayApiError,
  type AliasedMutation,
} from "./client"
import { computeProjectMetrics, type MondayEntityMetrics } from "./metrics"

export interface PushResult {
  ok: boolean
  pushed: boolean
  /**
   * AQU-1828: whether the project has an enabled Monday link at all. The
   * sync-worker DO caches `false` and stops nudging us on every edit, so an
   * unlinked project costs one request instead of one per 60s forever.
   */
  linked?: boolean
  itemsUpserted?: number
  error?: string
  /** Set when the failure was transient and a retry is already scheduled. */
  retryScheduled?: boolean
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

/** First retry delay; each further consecutive failure doubles it (AQU-1828). */
export const RETRY_BASE_SECONDS = 60
/** Backoff ceiling — a persistently failing board is retried hourly, not faster. */
export const RETRY_MAX_SECONDS = 3600
/**
 * Consecutive transient failures before we give up and clear the dirty marker.
 * Without a cap one broken board would occupy a slot in every cron flush
 * (`flushDirtyLinks` cap = 20) forever. 8 attempts ≈ 2h of retries.
 */
export const MAX_PUSH_ATTEMPTS = 8

/** Seconds to wait before the Nth consecutive retry (1-based). */
export function retryDelaySeconds(attempt: number): number {
  const exponent = Math.max(0, attempt - 1)
  return Math.min(RETRY_BASE_SECONDS * 2 ** exponent, RETRY_MAX_SECONDS)
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
 * Record the outcome. A success or a permanent failure clears `dirty_at` and
 * resets the retry counter; a transient failure KEEPS the link dirty and
 * schedules the next attempt, which is what makes the cron flush retry it
 * (AQU-1828 — this used to clear `dirty_at` unconditionally, so every failed
 * push was silently dropped).
 */
async function recordPushOutcome(
  env: Env,
  link: Pick<IntegrationLinkRow, "id" | "push_attempts">,
  status: "ok" | "error",
  error: string | null,
  transient = false,
): Promise<{ retryScheduled: boolean }> {
  const attempts = (link.push_attempts ?? 0) + 1
  const retry = transient && attempts < MAX_PUSH_ATTEMPTS
  if (!retry) {
    await env.AQUILLA_PG.prepare(
      `UPDATE integration_links
          SET last_pushed_at = now(), last_push_status = ?, last_push_error = ?,
              dirty_at = NULL, push_attempts = 0, next_retry_at = NULL, updated_at = now()
        WHERE id = ?`,
    )
      .bind(status, error, link.id)
      .run()
    return { retryScheduled: false }
  }
  await env.AQUILLA_PG.prepare(
    `UPDATE integration_links
        SET last_pushed_at = now(), last_push_status = ?, last_push_error = ?,
            dirty_at = COALESCE(dirty_at, now()), push_attempts = ?,
            next_retry_at = now() + make_interval(secs => ?::int), updated_at = now()
      WHERE id = ?`,
  )
    .bind(status, error, attempts, retryDelaySeconds(attempts), link.id)
    .run()
  return { retryScheduled: true }
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
  // `linked: false` is the signal the caller caches to stop nudging us at all
  // for this project (AQU-1828).
  if (!link) return { ok: true, pushed: false, linked: false }

  // In backoff after a transient failure: stay dirty and let the cron flush
  // own the retry, or an edit-driven nudge would defeat the backoff.
  if (link.next_retry_at && Date.parse(link.next_retry_at) > Date.now()) {
    await markDirty(env, link.id)
    return { ok: true, pushed: false, linked: true, retryScheduled: true }
  }

  if (link.last_pushed_at) {
    const ageMs = Date.now() - new Date(link.last_pushed_at).getTime()
    if (ageMs < PUSH_DEBOUNCE_SECONDS * 1000) {
      await markDirty(env, link.id)
      return { ok: true, pushed: false, linked: true }
    }
  }
  return pushBoardLink(env, link)
}

async function markDirty(env: Env, linkId: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "UPDATE integration_links SET dirty_at = COALESCE(dirty_at, now()) WHERE id = ?",
  )
    .bind(linkId)
    .run()
}

/**
 * Cron flush: push dirty enabled links, oldest first, capped per run. Links
 * waiting out a retry backoff are skipped so one failing board cannot occupy
 * the whole cap every minute (AQU-1828).
 */
export async function flushDirtyLinks(env: Env, cap = 20): Promise<number> {
  const result = await env.AQUILLA_PG.prepare(
    `SELECT * FROM integration_links
      WHERE dirty_at IS NOT NULL AND enabled = TRUE AND provider = ?
        AND (next_retry_at IS NULL OR next_retry_at <= now())
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

/** Which links a settings change touched: named projects, or a whole org. */
export type SettingsPushScope = { projectIds: readonly string[] } | { orgId: number }

/**
 * AQU-1771: push now the links a settings change just marked dirty, instead of
 * leaving them for the 5-minute cron. Only DIRTY links are pushed, so a save
 * that changed nothing the board shows finds nothing to do. Links waiting out
 * an AQU-1828 retry backoff are skipped, and an org-wide change pushes at most
 * `cap` links (the cron's per-run cap); the rest stay dirty for the cron.
 * Bypasses the edit debounce on purpose: someone just changed what the board
 * should say, so the board should say it.
 */
export async function pushDirtyLinksNow(
  env: Env,
  scope: SettingsPushScope,
  cap = 20,
): Promise<number> {
  const byOrg = "orgId" in scope
  if (!byOrg && scope.projectIds.length === 0) return 0
  const where = byOrg
    ? "il.project_id IN (SELECT p.id FROM projects p WHERE p.org_id = ? AND p.archived_at IS NULL)"
    : `il.project_id IN (${scope.projectIds.map(() => "?").join(", ")})`
  const result = await env.AQUILLA_PG.prepare(
    `SELECT il.* FROM integration_links il
      WHERE il.dirty_at IS NOT NULL AND il.enabled = TRUE AND il.provider = ?
        AND (il.next_retry_at IS NULL OR il.next_retry_at <= now())
        AND ${where}
      ORDER BY il.dirty_at ASC
      LIMIT ?`,
  )
    .bind(PROVIDER, ...(byOrg ? [scope.orgId] : scope.projectIds), cap)
    .all<IntegrationLinkRow>()
  let pushed = 0
  for (const link of result.results ?? []) {
    try {
      await pushBoardLink(env, link)
      pushed++
    } catch (err) {
      console.error(`[monday] settings push failed for link ${link.id}:`, err)
    }
  }
  return pushed
}

/**
 * Run `pushDirtyLinksNow` after the response, so a settings save never waits
 * on Monday. Without an ExecutionContext (Hono's bare test harness) it does
 * nothing and the cron flush pushes the dirty links as before.
 *
 * The push must not use the request-scoped `AQUILLA_PG`: index.ts closes that
 * shim the moment the Response returns (the AQU-1763 trap), so it opens its own
 * connection from PG_CONNECTION_STRING and releases it when the push settles.
 * The vitest harness injects AQUILLA_PG directly and sets no connection string,
 * so it keeps using the injected handle.
 */
export function pushDirtyLinksAfterResponse(
  c: { env: Env; executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  scope: SettingsPushScope,
): void {
  let ctx: { waitUntil(promise: Promise<unknown>): void }
  try {
    ctx = c.executionCtx
  } catch {
    return
  }
  ctx.waitUntil(pushOnOwnConnection(c.env, scope))
}

async function pushOnOwnConnection(env: Env, scope: SettingsPushScope): Promise<void> {
  const own = env.PG_CONNECTION_STRING ? makePostgres(env.PG_CONNECTION_STRING) : null
  try {
    await pushDirtyLinksNow(own ? { ...env, AQUILLA_PG: own as unknown as AquillaDb } : env, scope)
  } catch (err) {
    console.error("[monday] settings push failed:", err)
  } finally {
    await own?.close().catch((err: unknown) => {
      console.error("[monday] releasing the settings-push connection failed:", err)
    })
  }
}
