// AQU-2355 — the connection every access-migration script opens.
//
// Dry run is the default and is enforced by Postgres, not by the script's own
// good behaviour: the session starts with `default_transaction_read_only=on`
// and the script refuses to go on unless `SHOW default_transaction_read_only`
// says `on`. Only `--apply` opens a writable session.

import pg from "pg"

export interface MigrationConnection {
  client: pg.Client
  readOnly: boolean
}

export function migrationConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = env.NEON_PG_HOST?.trim()
  const database = env.NEON_PG_DB?.trim() || "neondb"
  const role = env.NEON_PG_ROLE?.trim() || "neondb_owner"
  const password = env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error("AQUILLA_DATABASE_URL, or NEON_PG_HOST and NEON_PG_PASSWORD, are required")
  const url = new URL("postgresql://placeholder")
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set("sslmode", "require")
  return url.toString()
}

/** Open the session. A read-only one that is not read-only throws. */
export async function openMigrationConnection(opts: { apply: boolean; connectionString?: string }): Promise<MigrationConnection> {
  const client = new pg.Client({
    connectionString: opts.connectionString ?? migrationConnectionString(),
    ...(opts.apply ? {} : { options: "-c default_transaction_read_only=on" }),
  })
  await client.connect()
  if (!opts.apply) {
    const res = await client.query<{ default_transaction_read_only: string }>("SHOW default_transaction_read_only")
    const value = res.rows[0]?.default_transaction_read_only
    if (value !== "on") {
      await client.end()
      throw new Error(`refusing to run: default_transaction_read_only is ${JSON.stringify(value)}, not "on"`)
    }
  }
  return { client, readOnly: !opts.apply }
}
