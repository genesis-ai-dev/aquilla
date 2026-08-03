// Generic sliding-window rate limiting shared by auth-worker and sync-worker,
// backed by `auth_rate_limit_events` (kind, identifier, success, created_at —
// see db/postgres/schema.sql). The table is intentionally generic (no `kind`
// enum/FK) so any caller can bucket its own counters into it without a new
// migration; auth-worker's own throttles (auth-worker/src/utils/rate-limit.ts)
// predate this shared extraction and still own the login/reset/admin kinds.
//
// [Pen test] API security & data exposure (2026-07-30): the external Agent
// API (sync-worker /api/v1/external/*) had NO throttling on any route —
// `rate_limited` was a defined error code but explicitly documented as
// "reserved, not currently enforced" (discovery-route.ts). A leaked or
// malicious PAT could otherwise hammer the search/read endpoints without
// limit. This gives sync-worker the same primitive auth-worker already uses.

import type { AquillaDb } from "../shim/postgres"

const WINDOW_MINUTES = 15

/** Best-effort: a logging failure must never block the request it's throttling. */
export async function recordRateLimitEvent(
  db: AquillaDb,
  kind: string,
  identifier: string,
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO auth_rate_limit_events (kind, identifier, success) VALUES (?, ?, ?)")
      .bind(kind, identifier, 1)
      .run()
  } catch (err) {
    console.warn("[rate-limit] record failed (non-fatal):", err)
  }
}

/** Count events of `kind`/`identifier` in the trailing 15-minute window.
 *  Fails open (returns 0) on a lookup error — throttling infra must never
 *  become an outage vector for the thing it's protecting. */
export async function countRecentRateLimitEvents(
  db: AquillaDb,
  kind: string,
  identifier: string,
): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM auth_rate_limit_events
         WHERE kind = ? AND identifier = ?
           AND created_at > now() - interval '${WINDOW_MINUTES} minutes'`,
      )
      .bind(kind, identifier)
      .first<{ n: number }>()
    return row?.n ?? 0
  } catch (err) {
    console.warn("[rate-limit] count failed, failing open:", err)
    return 0
  }
}
