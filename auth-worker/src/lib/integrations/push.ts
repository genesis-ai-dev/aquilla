// When progress-sync links push, for every provider at once (AQU-804: Monday
// and Airtable share these triggers). Each provider's engine pushes ONE link
// (`pushIntegrationLink` routes on `integration_links.provider`); this module
// decides which links push and when:
//
//   * schedulePush — sync-worker's nudge after an edit (/api/v2/monday/internal/push):
//     push now unless the link pushed in the last 2 minutes, else mark dirty.
//   * flushDirtyLinks — the 5-minute cron: dirty links, oldest first, capped.
//   * pushDirtyLinksNow / pushDirtyLinksAfterResponse — a settings change that
//     moved the pushed numbers (AQU-1771) pushes its dirty links at once.
//
// The dirty marking itself is db/shared/progress-sync-dirty.ts.

import type { Env } from "../../types"
import { makePostgres, type AquillaDb } from "../../../../db/shim/postgres"
import {
  PROGRESS_SYNC_PROVIDERS,
  progressSyncProviderSql,
  type ProgressSyncProvider,
} from "../../../../db/shared/progress-sync-dirty"
import type { IntegrationLinkRow } from "../monday/types"
import { pushBoardLink } from "../monday/push"
import { pushAirtableLink } from "../airtable/push"
import { markDirty, PUSH_DEBOUNCE_SECONDS, type PushResult } from "./push-state"

const PUSHERS: Record<ProgressSyncProvider, (env: Env, link: IntegrationLinkRow) => Promise<PushResult>> = {
  monday: pushBoardLink,
  airtable: pushAirtableLink,
}

/** Push one link now, with its provider's engine. */
export async function pushIntegrationLink(env: Env, link: IntegrationLinkRow): Promise<PushResult> {
  const push = (PUSHERS as Record<string, (env: Env, link: IntegrationLinkRow) => Promise<PushResult>>)[
    link.provider
  ]
  if (!push) return { ok: false, pushed: false, linked: true, error: `no push engine for '${link.provider}'` }
  return push(env, link)
}

/** One link: push now, or mark it dirty when it pushed too recently or is backing off. */
async function scheduleLinkPush(env: Env, link: IntegrationLinkRow): Promise<PushResult> {
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
  return pushIntegrationLink(env, link)
}

/**
 * Debounced push for one project (fired by sync-worker on progress change):
 * each of its enabled links pushes now if its last push is older than the
 * debounce window, else is marked dirty for the cron to flush.
 */
export async function schedulePush(env: Env, projectId: string): Promise<PushResult> {
  const links = await env.AQUILLA_PG.prepare(
    `SELECT * FROM integration_links
      WHERE project_id = ? AND enabled = TRUE AND ${progressSyncProviderSql("provider")}
      ORDER BY provider`,
  )
    .bind(projectId, ...PROGRESS_SYNC_PROVIDERS)
    .all<IntegrationLinkRow>()
  const rows = links.results ?? []
  // `linked: false` is the signal the caller caches to stop nudging us at all
  // for this project (AQU-1828).
  if (rows.length === 0) return { ok: true, pushed: false, linked: false }

  const results: PushResult[] = []
  for (const link of rows) results.push(await scheduleLinkPush(env, link))
  if (results.length === 1) return results[0]!
  const failed = results.find((r) => !r.ok)
  return {
    ok: !failed,
    pushed: results.some((r) => r.pushed),
    linked: true,
    itemsUpserted: results.reduce((sum, r) => sum + (r.itemsUpserted ?? 0), 0),
    ...(failed?.error ? { error: failed.error } : {}),
    ...(results.some((r) => r.retryScheduled) ? { retryScheduled: true } : {}),
  }
}

/**
 * Cron flush: push dirty enabled links, oldest first, capped per run. Links
 * waiting out a retry backoff are skipped so one failing board cannot occupy
 * the whole cap every minute (AQU-1828).
 */
export async function flushDirtyLinks(env: Env, cap = 20): Promise<number> {
  const result = await env.AQUILLA_PG.prepare(
    `SELECT * FROM integration_links
      WHERE dirty_at IS NOT NULL AND enabled = TRUE AND ${progressSyncProviderSql("provider")}
        AND (next_retry_at IS NULL OR next_retry_at <= now())
      ORDER BY dirty_at ASC
      LIMIT ?`,
  )
    .bind(...PROGRESS_SYNC_PROVIDERS, cap)
    .all<IntegrationLinkRow>()
  let flushed = 0
  for (const link of result.results ?? []) {
    try {
      await pushIntegrationLink(env, link)
      flushed++
    } catch (err) {
      console.error(`[integrations] cron push failed for ${link.provider} link ${link.id}:`, err)
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
      WHERE il.dirty_at IS NOT NULL AND il.enabled = TRUE AND ${progressSyncProviderSql("il.provider")}
        AND (il.next_retry_at IS NULL OR il.next_retry_at <= now())
        AND ${where}
      ORDER BY il.dirty_at ASC
      LIMIT ?`,
  )
    .bind(...PROGRESS_SYNC_PROVIDERS, ...(byOrg ? [scope.orgId] : scope.projectIds), cap)
    .all<IntegrationLinkRow>()
  let pushed = 0
  for (const link of result.results ?? []) {
    try {
      await pushIntegrationLink(env, link)
      pushed++
    } catch (err) {
      console.error(`[integrations] settings push failed for ${link.provider} link ${link.id}:`, err)
    }
  }
  return pushed
}

/**
 * Run `pushDirtyLinksNow` after the response, so a settings save never waits
 * on the provider. Without an ExecutionContext (Hono's bare test harness) it
 * does nothing and the cron flush pushes the dirty links as before.
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
    console.error("[integrations] settings push failed:", err)
  } finally {
    await own?.close().catch((err: unknown) => {
      console.error("[integrations] releasing the settings-push connection failed:", err)
    })
  }
}
