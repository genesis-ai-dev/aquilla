# Statement and idle-in-transaction ceilings

The workers are meant to run every query under a 15 s `statement_timeout` and
a 30 s `idle_in_transaction_session_timeout`
(`db/shim/postgres.ts::DEFAULT_STATEMENT_TIMEOUT_MS`,
`db/shim/postgres.ts::DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS`). As of
2026-11-16 neither is in force on a connection that goes through Hyperdrive.
This page says why, how to put them in force, and what keeps migrations out of
their way.

## What is in force today

`db/shim/postgres.ts::pgTimeoutConnectionParams` sends both ceilings as
Postgres startup parameters. Measured on the development Hyperdrive on
2026-11-13:

- Hyperdrive forwards `application_name` from a client's startup message and
  nothing else. `statement_timeout`, `idle_in_transaction_session_timeout`,
  `lock_timeout`, `TimeZone`, `search_path` and the `options` parameter are
  dropped without an error.
- A pooled session therefore runs on the server's defaults: no statement
  ceiling, and Neon's own five-minute idle-in-transaction limit. A 75 s
  `pg_sleep` ran to completion.
- Only a transaction-local `SET LOCAL` cancels anything. That is what
  `db/shim/postgres.ts::withLongOperationTimeout` and the agent SQL guard use,
  and it is why the only statement-timeout cancellations in a week of
  production logs came from the one route that sets its own.

On a direct connection (local dev stack, tests, every script under `scripts/`)
the startup parameters do arrive, so nothing local shows the gap.

Do not try to close it with a plain `SET` from a worker. A session-level `SET`
through Hyperdrive stays on the pooled connection and the next, unrelated
client inherits it.

## Putting the ceilings in force

A default on the role the workers connect as reaches every session that role
opens, pooled or not:

```sql
ALTER ROLE <worker role> SET statement_timeout = '15s';
ALTER ROLE <worker role> SET idle_in_transaction_session_timeout = '30s';
```

`<worker role>` is whatever role the environment's Hyperdrive configuration
logs in as. Confirm it rather than assume it:

```sql
SELECT usename, count(*) FROM pg_stat_activity
 WHERE datname = current_database() GROUP BY 1 ORDER BY 2 DESC;
```

What to expect, measured on the development branch on 2026-11-16:

- **It applies to new origin connections only.** Hyperdrive keeps connections
  for a long time (the oldest seen was 29 minutes), so the change phases in:
  18 connections opened after the `ALTER ROLE` cancelled a 20 s `pg_sleep` at
  15 s with SQLSTATE 57014, while 36 older ones ran it to completion.
- **An idle transaction is killed, not cancelled.** After 30 s the server
  closes the connection and the client sees `CONNECTION_CLOSED`.
- **Operations in `db/shim/postgres.ts::LONG_OPERATION_TIMEOUTS` are
  unaffected.** Their `SET LOCAL` outranks a role default.
- **A branch keeps its own role settings.** The nightly refresh of the
  development branch from production carries production's across.

Verify with `GET /admin/db/timeouts` on the sync-worker (admin bearer). Call it
several times: each call may land on a different pooled connection, and old
ones keep reporting `0` until Hyperdrive replaces them.

To undo it: `ALTER ROLE <worker role> RESET statement_timeout;` and the same for
the other setting. That also applies to new connections only.

## Sessions that must not inherit it

Migrations, backfills and seeds connect directly, and today they connect as the
same role as the workers. A 15 s ceiling would cancel an index build part-way;
on the non-transactional (`CREATE INDEX CONCURRENTLY`) path that leaves an
`INVALID` index behind.

- Everything that connects through `scripts/neon-connection.ts::neonConfig` or
  `scripts/neon-connection.ts::neonClient` sends
  `scripts/maintenance-session.ts::MAINTENANCE_SESSION_OPTIONS` at startup,
  which sets both ceilings to `0`. A startup setting has source `client` and
  outranks a role default. `scripts/seed-load.ts` does the same.
- `pnpm neon:apply:*` checks that this took effect before the first pending
  file and refuses otherwise
  (`scripts/maintenance-session.ts::ceilingRefusal`). The usual cause is a
  pooler host in `NEON_PG_HOST`: a pooler does not pass `options` through.
- Scripts built on `db/shim/postgres.ts::makeMaintenancePostgres` already send
  their own, longer ceiling as startup parameters on a direct connection.
- **An ad-hoc session is not covered.** `psql`, the Neon SQL editor, or a
  one-off script logged in as the worker role will be cancelled at 15 s. Start
  the session with `SET statement_timeout = 0;` when that is not what you want.
  `pg_dump` already does this for itself.
