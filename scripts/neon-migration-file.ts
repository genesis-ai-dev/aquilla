import type { Client } from "pg"

/** Execute the actual file before recording it; failures never advance the ledger. */
export async function applyMigrationFile(
  client: Pick<Client, "query">,
  name: string,
  sql: string,
): Promise<void> {
  // One multi-statement query preserves the file's transactional semantics.
  await client.query(sql)
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name])
}
