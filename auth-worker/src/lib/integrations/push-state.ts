// Push bookkeeping every progress-sync provider shares (Monday, Airtable —
// AQU-804): the outcome a push records on its integration_links row, the
// AQU-1828 retry backoff, and the dirty marker the cron flush reads. Each
// provider's push engine (lib/monday/push.ts, lib/airtable/push.ts) decides
// what is transient; this decides what that means for the row.

import type { Env } from "../../types"
import type { IntegrationLinkRow } from "../monday/types"

export interface PushResult {
  ok: boolean
  pushed: boolean
  /**
   * AQU-1828: whether the project has an enabled progress-sync link at all.
   * The sync-worker DO caches `false` and stops nudging us on every edit, so
   * an unlinked project costs one request instead of one per 60s forever.
   */
  linked?: boolean
  itemsUpserted?: number
  error?: string
  /** Set when the failure was transient and a retry is already scheduled. */
  retryScheduled?: boolean
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
 * Record the outcome. A success or a permanent failure clears `dirty_at` and
 * resets the retry counter; a transient failure KEEPS the link dirty and
 * schedules the next attempt, which is what makes the cron flush retry it
 * (AQU-1828 — this used to clear `dirty_at` unconditionally, so every failed
 * push was silently dropped).
 */
export async function recordPushOutcome(
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

/** How recent a push must be for /internal/push to debounce instead (seconds). */
export const PUSH_DEBOUNCE_SECONDS = 120

export async function markDirty(env: Env, linkId: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "UPDATE integration_links SET dirty_at = COALESCE(dirty_at, now()) WHERE id = ?",
  )
    .bind(linkId)
    .run()
}
