// Generic fixed-window rate limiting shared by auth-worker and sync-worker.
//
// AQU-1843 rewrote this module. It used to COUNT(*) rows in
// `auth_rate_limit_events` over a trailing window and then INSERT one more row
// — two statements, so a parallel burst all read the same pre-burst count and
// every request passed; one row written per request into a table the
// sync-worker side never pruned; and a lookup error returned 0, which silently
// disabled every throttle at once.
//
// What replaced it:
//
//   * ONE statement per check. `rate_limit_counters` holds a single row per
//     (kind, identifier, window) and the check is an upsert that increments and
//     RETURNS the new value. `ON CONFLICT DO UPDATE` takes a row lock, so
//     concurrent callers serialize on that row and each one is handed a
//     distinct ordinal: the Nth caller inside a window sees `hits = N`, and
//     `allowed` is `hits <= limit` whatever the concurrency. That is the
//     atomicity the old count-then-insert never had.
//   * Fixed windows, aligned to the epoch, instead of a trailing window. A
//     fixed window is what a single counter row can express; the cost is that a
//     caller can spend `limit` at the end of one window and `limit` again at the
//     start of the next. For volumetric floors (this module's only job — the
//     spend guards live elsewhere) that is an acceptable trade for atomicity.
//   * A rejected call still increments. Hammering while blocked therefore
//     extends the block to the end of the window rather than freeing budget,
//     and it keeps the whole decision in one statement.
//   * `failMode` is REQUIRED per call site, because there is no safe default:
//     a route that spends money must fail CLOSED when the limiter is unavailable
//     (a Postgres hiccup must not become a free pass to the shared OpenRouter /
//     Inworld keys), while a free paginated read must fail OPEN (blocking it
//     would turn a cost control into an outage). The old module fixed that
//     choice at "open" for every caller.
//   * Writes are bounded: one row per key per window instead of one row per
//     request, and `pruneRateLimitCounters` drops finished windows from the
//     auth-worker cron (see auth-worker/src/index.ts `scheduled`).
//
// The table is intentionally generic (no `kind` enum/FK) so any caller can
// bucket its own counters into it without a new migration. auth-worker's own
// auth throttles (auth-worker/src/utils/rate-limit.ts) still use the older
// `auth_rate_limit_events` log: they count FAILURES only and need the per-attempt
// rows to do it, and none of them spends money.

import type { AquillaDb } from "../shim/postgres"

/** Default window for every caller. Exported so a route can state the cap it
 *  enforces in its own error message without re-deriving the period. */
export const RATE_LIMIT_WINDOW_MINUTES = 15

export type RateLimitFailMode = "open" | "closed"

export interface RateLimitDecision {
  /** May this call proceed? */
  allowed: boolean
  /** Calls counted in this window including this one — 0 when `degraded`. */
  hits: number
  limit: number
  /** Seconds until the current window rolls over (for `Retry-After`). */
  retryAfterSeconds: number
  /** True when the limiter backend errored and `failMode` decided the answer. */
  degraded: boolean
}

export interface RateLimitRequest {
  /** Counter bucket, e.g. "chat_completions". */
  kind: string
  /** Namespaced subject, e.g. "user:42" — build it with the helpers below. */
  identifier: string
  /** Calls allowed per window. */
  limit: number
  /** What to answer when the limiter itself is unavailable. See the header. */
  failMode: RateLimitFailMode
  /** Units this call consumes (a fan-out charges more than 1). Default 1. */
  cost?: number
  /** Override the window. Default RATE_LIMIT_WINDOW_MINUTES. */
  windowMinutes?: number
}

/**
 * AQU-1843: throttles key on the human who owns the credential, never on the
 * credential itself — minting a second PAT must not buy a second budget.
 */
export function userRateLimitIdentifier(userId: string | number): string {
  return `user:${userId}`
}

export function projectRateLimitIdentifier(projectId: string | number): string {
  return `project:${projectId}`
}

export function ipRateLimitIdentifier(ip: string): string {
  return `ip:${ip.trim().toLowerCase()}`
}

/** Seconds left in the fixed window the next check will land in. Derived from
 *  the local clock rather than read back from Postgres: the value only feeds
 *  `Retry-After`, and a second of NTP skew does not matter there. */
function retryAfterSeconds(windowSeconds: number): number {
  const elapsed = Math.floor(Date.now() / 1000) % windowSeconds
  return Math.max(1, windowSeconds - elapsed)
}

/** The atomic check-and-increment. `window_start` is computed by Postgres so
 *  every worker buckets on the same clock. */
const UPSERT_SQL = `
  INSERT INTO rate_limit_counters (kind, identifier, window_start, hits)
  VALUES (?, ?, to_timestamp(floor(extract(epoch FROM now()) / ?) * ?), ?)
  ON CONFLICT (kind, identifier, window_start)
  DO UPDATE SET hits = rate_limit_counters.hits + EXCLUDED.hits, updated_at = now()
  RETURNING hits`

/**
 * Check and consume budget in one statement. The returned `hits` is this
 * call's ordinal inside the current window, so `allowed` is exact under any
 * concurrency.
 *
 * On a backend error the decision comes from `failMode` and `degraded` is true;
 * callers that spend money must pass `"closed"`.
 */
export async function enforceRateLimit(
  db: AquillaDb,
  req: RateLimitRequest,
): Promise<RateLimitDecision> {
  const cost = Math.max(1, Math.trunc(req.cost ?? 1))
  const windowSeconds = (req.windowMinutes ?? RATE_LIMIT_WINDOW_MINUTES) * 60
  try {
    const row = await db
      .prepare(UPSERT_SQL)
      .bind(req.kind, req.identifier, windowSeconds, windowSeconds, cost)
      .first<{ hits: number }>()
    const hits = Number(row?.hits ?? cost)
    return {
      allowed: hits <= req.limit,
      hits,
      limit: req.limit,
      retryAfterSeconds: retryAfterSeconds(windowSeconds),
      degraded: false,
    }
  } catch (err) {
    console.warn(`[rate-limit] ${req.kind} failed, failing ${req.failMode}:`, err)
    return {
      allowed: req.failMode === "open",
      hits: 0,
      limit: req.limit,
      retryAfterSeconds: retryAfterSeconds(windowSeconds),
      degraded: true,
    }
  }
}

/**
 * Read the current window's count WITHOUT consuming budget. For the
 * failure-only counters (an invalid-credential throttle must not count the
 * caller who keeps presenting a valid token), which pair this with
 * `bumpRateLimit` on the failure path. Returns null when the lookup failed, so
 * the caller picks its own fail mode.
 */
export async function peekRateLimit(
  db: AquillaDb,
  kind: string,
  identifier: string,
  windowMinutes = RATE_LIMIT_WINDOW_MINUTES,
): Promise<number | null> {
  const windowSeconds = windowMinutes * 60
  try {
    const row = await db
      .prepare(
        `SELECT hits FROM rate_limit_counters
         WHERE kind = ? AND identifier = ?
           AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ?) * ?)`,
      )
      .bind(kind, identifier, windowSeconds, windowSeconds)
      .first<{ hits: number }>()
    return Number(row?.hits ?? 0)
  } catch (err) {
    console.warn(`[rate-limit] peek ${kind} failed:`, err)
    return null
  }
}

/** Consume budget without checking it. Best-effort: a failed bump must never
 *  fail the request it is counting. Pairs with `peekRateLimit`. */
export async function bumpRateLimit(
  db: AquillaDb,
  kind: string,
  identifier: string,
  cost = 1,
  windowMinutes = RATE_LIMIT_WINDOW_MINUTES,
): Promise<void> {
  const windowSeconds = windowMinutes * 60
  try {
    await db
      .prepare(UPSERT_SQL)
      .bind(kind, identifier, windowSeconds, windowSeconds, Math.max(1, Math.trunc(cost)))
      .run()
  } catch (err) {
    console.warn(`[rate-limit] bump ${kind} failed (non-fatal):`, err)
  }
}

/**
 * Drop counter rows for windows that can no longer be hit. Runs on the
 * auth-worker 5-minute cron (index.ts `scheduled`) rather than opportunistically
 * off a request, the same move `pruneExpiredRevokedTokens` made. Non-throwing.
 */
export async function pruneRateLimitCounters(db: AquillaDb): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 hour'")
      .bind()
      .run()
  } catch (err) {
    console.warn("[rate-limit] counter prune failed (non-fatal):", err)
  }
}
