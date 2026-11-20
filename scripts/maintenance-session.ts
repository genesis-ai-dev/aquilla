// Timeout ceilings for maintenance sessions: migrations, backfills, seeds.
//
// The workers' ceilings cannot ride their own connections. Hyperdrive forwards
// only `application_name` from a client's startup message, so the 15s
// statement / 30s idle-in-transaction limits that db/shim/postgres.ts asks for
// never reach Postgres. The way to put them in force is a default on the role
// the workers connect as (`ALTER ROLE … SET statement_timeout = '15s'`).
//
// Every script here connects as that same role, directly, and would inherit a
// ceiling sized for request paths: a 15s cancel in the middle of an index
// build, or a backfill's transaction killed while the script thinks. This
// module is what keeps those sessions running as they do today once the role
// default exists. Runbook: docs/POSTGRES-TIMEOUTS.md.

/**
 * Startup `options` for a maintenance session: no statement ceiling and no
 * idle-in-transaction ceiling, whatever the role or database default says.
 *
 * A setting sent at startup has source `client`, which outranks a role or
 * database default. It is sent with the connection rather than as a `SET`
 * afterwards so that a `pg.Pool` gets it on every connection it opens.
 *
 * Direct connections only: a pooler does not pass `options` through.
 */
export const MAINTENANCE_SESSION_OPTIONS =
  "-c statement_timeout=0 -c idle_in_transaction_session_timeout=0"

/** One row of `pg_settings`, as SESSION_CEILINGS_SQL returns it. */
export interface SessionSetting {
  name: string
  setting: string
  unit: string | null
  source: string
}

/** The two ceilings this session must not be under, as Postgres reports them. */
export const SESSION_CEILINGS_SQL =
  "SELECT name, setting, unit, source FROM pg_settings " +
  "WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout') ORDER BY name"

/**
 * Why a migration must not start on this session, or null when it may.
 *
 * MAINTENANCE_SESSION_OPTIONS should have zeroed both settings. If either is
 * still in force the options did not arrive (a pooler host in NEON_PG_HOST,
 * say) and a role default would cancel a long statement part-way. On the
 * non-transactional path that leaves an INVALID index behind, so the runner
 * refuses before the first file rather than finding out on the slow one.
 */
export function ceilingRefusal(rows: SessionSetting[]): string | null {
  const inForce = rows.filter((row) => row.setting !== "0")
  if (rows.length === 2 && inForce.length === 0) return null
  const seen = rows.length
    ? rows.map((row) => `${row.name}=${row.setting}${row.unit ?? ""} (source: ${row.source})`).join(", ")
    : "neither setting was readable"
  return (
    `✗ this session is under a timeout ceiling: ${seen}.\n` +
    `  Migrations connect with "${MAINTENANCE_SESSION_OPTIONS}" so that a role-level default ` +
    `meant for the workers cannot cancel a long statement part-way. That did not take effect, ` +
    `which usually means NEON_PG_HOST names a pooler host rather than the direct one. ` +
    `Nothing was applied. See docs/POSTGRES-TIMEOUTS.md.`
  )
}
