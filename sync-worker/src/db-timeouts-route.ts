// GET /admin/db/timeouts — operator probe for the connection timeouts (AQU-1876).
//
// The ceilings this reports are carried as Postgres *startup parameters* on
// every handle makePostgres() builds (db/shim/postgres.ts). Startup parameters
// are cheap and apply from the first query, but they travel through
// Hyperdrive's pooling, and a parameter silently dropped on the way to Neon
// would leave the whole fix a no-op that nothing else in the system would
// notice. So this route asks Postgres itself what is in force.
//
// Two arms:
//   GET /admin/db/timeouts            → what the server reports for this
//                                       connection (the acceptance check that
//                                       the defaults actually arrived).
//   GET /admin/db/timeouts?sleep=30   → run pg_sleep(30) and report how it
//                                       ended, so an operator can watch the
//                                       server cancel a deliberately slow
//                                       query (AQU-1876 acceptance criterion
//                                       1). Self-limiting: the statement it
//                                       runs is bounded by the very timeout it
//                                       demonstrates.
//
// The sleep arm is refused on a deployed production worker. The report is
// harmless anywhere, but deliberately parking a Hyperdrive connection for the
// length of the timeout has no business on the surface serving customers.

import { isAuthorizedAdminBearer, hasAdminSecretConfigured } from "./lib/admin-auth"
import { isDeployedEnvironment } from "./environment-guard"

export interface DbTimeoutsEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  ENVIRONMENT?: string
}

const TIMEOUTS_PATH = "/admin/db/timeouts"

/** Largest `?sleep=` the route will accept, in seconds. Past this the request
 *  is refused rather than silently clamped: a sleep longer than the ceiling
 *  under test tells the operator nothing the ceiling itself does not. */
const MAX_SLEEP_SECONDS = 120

/** Returns null when the path is not this route, so the caller falls through. */
export async function handleDbTimeoutsRequest(
  request: Request,
  env: DbTimeoutsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== TIMEOUTS_PATH) return null
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 })

  // Fail closed: an admin surface with no admin credential bound is a 500, not
  // an open door (mirrors the migration routes).
  if (!hasAdminSecretConfigured(env)) {
    return new Response("no admin credential configured", { status: 500 })
  }
  if (!isAuthorizedAdminBearer(request.headers.get("Authorization") ?? "", env)) {
    return new Response("unauthorized", { status: 401 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }
  const db = env.AQUILLA_PG

  const inForce = await db
    .prepare(
      `SELECT current_setting('statement_timeout') AS statement_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`,
    )
    .first<{ statement_timeout: string; idle_in_transaction_session_timeout: string }>()

  const sleepParam = url.searchParams.get("sleep")
  if (sleepParam == null) {
    return Response.json({ ok: true, inForce })
  }

  const seconds = Number(sleepParam)
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_SLEEP_SECONDS) {
    return new Response(`sleep must be an integer 1..${MAX_SLEEP_SECONDS} seconds`, { status: 400 })
  }
  if (isDeployedEnvironment(env) && env.ENVIRONMENT === "production") {
    return new Response("sleep probe is not available on production", { status: 403 })
  }

  const startedAt = Date.now()
  try {
    await db.prepare(`SELECT pg_sleep(${seconds})`).run()
    return Response.json({
      ok: true,
      inForce,
      sleepSeconds: seconds,
      cancelled: false,
      elapsedMs: Date.now() - startedAt,
      note: "pg_sleep ran to completion — statement_timeout did NOT cancel it.",
    })
  } catch (err) {
    // The expected outcome: Postgres cancels the statement and the driver
    // surfaces SQLSTATE 57014 (query_canceled).
    const code = (err as { code?: string }).code
    return Response.json({
      ok: true,
      inForce,
      sleepSeconds: seconds,
      cancelled: true,
      elapsedMs: Date.now() - startedAt,
      code: code ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
