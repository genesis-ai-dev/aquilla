// GET /admin/db/stuck-sessions — operator/monitor probe for half-sent sessions
// (AQU-2611).
//
// Why this exists. On 2026-11-13 and 2026-11-16 production ran out of
// Hyperdrive origin connections: up to 55 of 60 origin sessions sat `active` in
// `ClientRead` for ten minutes, all parked on the same statement, because a
// request had more statements in flight than its pool could send. `/health`
// stayed green the whole time — it runs `SELECT 1` on a *fresh* handle, which
// succeeds right up to the moment the origin has no connection left. The leak
// is only visible from the server's side of the socket.
//
// `pg_stat_activity` makes it unambiguous and cheap to read: a healthy database
// has zero sessions in this state for more than a few seconds. This route
// reports the count so monitor-worker's cron can alert on it; it reads one
// aggregate and writes nothing.
//
// The reported `sampleQuery` is the leading text of the stuck statement, which
// is what names the leaking route. postgres.js sends parameterized SQL, so that
// text is the statement *template* ($1, $2, …) rather than row values — see
// docs/OPSEC.md. It is capped and returned verbatim otherwise.
//
// Two extra counts exist because the headline `n` could read zero forever for
// reasons that have nothing to do with the database being healthy, and an alarm
// that cannot fire is worse than no alarm:
//
//   backendsAnyApplication — the same predicate without the `application_name`
//     filter. That filter is how we pick out our own driver's sessions, but
//     application_name travels as a startup parameter through Hyperdrive's
//     pooling; were it dropped on the way to Neon, `n` would be zero always. A
//     nonzero total beside a zero `n` names that failure directly.
//   observableBackends — other sessions whose `state` we are allowed to read.
//     Postgres shows `state`, `query` and `wait_event` as NULL for sessions
//     belonging to another role unless the reader holds `pg_read_all_stats`.
//     Our workers all connect as the same role, so this reads nonzero in
//     practice — and a zero here on a busy database means the predicate can
//     never match, whatever the pool is doing.

import { isAuthorizedAdminBearer, hasAdminSecretConfigured } from "./lib/admin-auth"

export interface DbStuckSessionsEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

const STUCK_SESSIONS_PATH = "/admin/db/stuck-sessions"

/** postgres.js' default `application_name`; our only driver (db/shim/postgres.ts). */
const DRIVER_APPLICATION_NAME = "postgres.js"

/** How long a session must have been stuck to count. A busy request legitimately
 *  spends a few ms in ClientRead between statements; 30s cannot be legitimate. */
const DEFAULT_MIN_AGE_SECONDS = 30
const MAX_MIN_AGE_SECONDS = 3_600

/** Leading characters of the stuck statement to report. Enough to name the
 *  route that leaks, short enough for one Discord field. */
const SAMPLE_QUERY_CHARS = 200

interface StuckSessionsRow {
  n: number | string | null
  backends_any_application: number | string | null
  observable_backends: number | string | null
  sample_query: string | null
}

const toCount = (value: number | string | null): number => {
  // Postgres count() is int8; drivers may hand it back as a string.
  const n = typeof value === "string" ? Number(value) : (value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export interface StuckSessionsReport {
  /** Sessions of our driver stuck past the threshold. */
  n: number
  /** Same predicate, any application_name — see the note at the top. */
  backendsAnyApplication: number
  /** Other sessions whose state this role can read — see the note at the top. */
  observableBackends: number
  /** Leading text of the longest-running stuck statement, or null when n is 0. */
  sampleQuery: string | null
  minAgeSeconds: number
}

/** Returns null when the path is not this route, so the caller falls through. */
export async function handleDbStuckSessionsRequest(
  request: Request,
  env: DbStuckSessionsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== STUCK_SESSIONS_PATH) return null
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 })

  // Fail closed: an admin surface with no admin credential bound is a 500, not
  // an open door (mirrors /admin/db/timeouts and the migration routes).
  if (!hasAdminSecretConfigured(env)) {
    return new Response("no admin credential configured", { status: 500 })
  }
  if (!isAuthorizedAdminBearer(request.headers.get("Authorization") ?? "", env)) {
    return new Response("unauthorized", { status: 401 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }

  const minAgeParam = url.searchParams.get("minAgeSeconds")
  let minAgeSeconds = DEFAULT_MIN_AGE_SECONDS
  if (minAgeParam != null) {
    const parsed = Number(minAgeParam)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_MIN_AGE_SECONDS) {
      return new Response(`minAgeSeconds must be an integer 1..${MAX_MIN_AGE_SECONDS}`, {
        status: 400,
      })
    }
    minAgeSeconds = parsed
  }

  // One aggregate over one scan of pg_stat_activity, no joins and no writes.
  // `stuck` is the ticket's predicate; the other two counts are the
  // can-this-alarm-even-fire checks described at the top.
  const row = await env.AQUILLA_PG
    .prepare(
      `WITH backends AS (
         SELECT application_name,
                state,
                wait_event,
                query,
                query_start
           FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
       ), stuck AS (
         SELECT application_name, query
           FROM backends
          WHERE state = 'active'
            AND wait_event = 'ClientRead'
            AND query_start IS NOT NULL
            AND now() - query_start > ($1::double precision * interval '1 second')
       )
       SELECT (SELECT count(*) FROM stuck WHERE application_name = $2) AS n,
              (SELECT count(*) FROM stuck) AS backends_any_application,
              (SELECT count(*) FROM backends WHERE state IS NOT NULL)
                AS observable_backends,
              (SELECT left(max(query), ${SAMPLE_QUERY_CHARS}) FROM stuck
                WHERE application_name = $2) AS sample_query`,
    )
    .bind(minAgeSeconds, DRIVER_APPLICATION_NAME)
    .first<StuckSessionsRow>()

  const report: StuckSessionsReport = {
    n: toCount(row?.n ?? 0),
    backendsAnyApplication: toCount(row?.backends_any_application ?? 0),
    observableBackends: toCount(row?.observable_backends ?? 0),
    sampleQuery: row?.sample_query ?? null,
    minAgeSeconds,
  }
  return Response.json({ ok: true, ...report }, {
    headers: { "Cache-Control": "no-store" },
  })
}
