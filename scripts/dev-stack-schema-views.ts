import type { Client } from "pg"
import type { SchemaView } from "./dev-stack-schema-parser"

type Run = (sql: string, what: string) => Promise<void>

/**
 * Bring the local container's views up to schema.sql.
 *
 * The additive reconciler creates tables, adds columns and ensures indexes,
 * but a view is none of those, so a long-lived container never gained one
 * that landed after it was created — `assignment_member_cells` (0147) left
 * every assignments read 500ing with "relation does not exist" on 2026-10-06,
 * and `access_grants` (0119/0121) had been missing locally for weeks behind a
 * shadow-query warning. A view holds no data, so re-creating it is lossless:
 * CREATE OR REPLACE each one, in file order (a view can only read what the
 * file defined before it). REPLACE refuses to drop, rename or reorder columns;
 * when it does, rebuild the view from scratch — a dependent view dropped by
 * the CASCADE comes later in the file and is re-created by this same loop.
 *
 * Runs after the table/column loop so the columns a view reads exist.
 */
export async function reconcilePgViews(
  client: Pick<Client, "query">,
  run: Run,
  views: SchemaView[],
): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`,
  )
  const live = new Set((rows as { table_name: string }[]).map((r) => r.table_name))
  const patched: string[] = []
  for (const view of views) {
    try {
      await client.query(view.createSql)
    } catch {
      await run(
        `DROP VIEW IF EXISTS ${view.name} CASCADE;\n${view.createSql}`,
        `rebuilding view ${view.name} (its column list changed shape)`,
      )
      patched.push(`rebuilt view ${view.name}`)
      continue
    }
    if (!live.has(view.name)) patched.push(`created view ${view.name}`)
  }
  return patched
}
