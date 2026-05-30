import { env, applyD1Migrations } from "cloudflare:test"
import { beforeAll, afterEach } from "vitest"

beforeAll(async () => {
  await applyD1Migrations(env.AQUILLA_DB, env.TEST_MIGRATIONS)
})

// Truncate all application tables between tests so each test starts clean.
// Tables are discovered dynamically so future migrations are covered automatically.
// Exclusions:
//   - sqlite_%, d1_%, _cf_% — internal SQLite/D1/CF tables (incl. d1_migrations tracking table)
//   - FTS5 shadow tables (_data, _idx, _content, _docsize, _config suffixes) — cannot be DELETEd directly
// FTS5 virtual tables (e.g. cells_fts) are cleared by deleting from the virtual table itself.
// Tables are deleted in FK-safe topological order (children before parents) because D1 does not
// honor PRAGMA foreign_keys = OFF. FK graph is parsed from sqlite_master.sql.
afterEach(async () => {
  // Discover all tables and their DDL SQL
  const masterRows = await env.AQUILLA_DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string; sql: string | null }>()

  // Identify FTS5 virtual tables by their DDL
  const vtabNames = new Set(
    (masterRows.results ?? [])
      .filter((r) => r.sql?.toUpperCase().includes("USING FTS5"))
      .map((r) => r.name),
  )

  // Exclude FTS5 shadow tables (they cannot be DELETEd directly)
  const FTS_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"]
  function isFtsShadow(name: string): boolean {
    return FTS_SUFFIXES.some(
      (suffix) =>
        name.endsWith(suffix) && vtabNames.has(name.slice(0, name.length - suffix.length)),
    )
  }

  const rows = (masterRows.results ?? []).filter((r) => !isFtsShadow(r.name))

  // Parse FK references from DDL: find all REFERENCES <tablename> patterns
  // Returns the set of tables that `tbl` references (its parents in the FK graph).
  const REFERENCES_RE = /\bREFERENCES\s+"?(\w+)"?/gi
  const parentsOf = new Map<string, Set<string>>()
  const tableSet = new Set(rows.map((r) => r.name))
  for (const { name, sql } of rows) {
    const parents = new Set<string>()
    if (sql) {
      for (const m of sql.matchAll(REFERENCES_RE)) {
        const ref = m[1]
        if (ref !== name && tableSet.has(ref)) {
          // Exclude self-references from the FK ordering (handled separately below)
          parents.add(ref)
        }
      }
    }
    parentsOf.set(name, parents)
  }

  // Topological sort via Kahn's algorithm.
  // We want children (tables that reference other tables) to be deleted FIRST.
  // "In-degree" here = number of tables that reference this table (i.e., how many children
  // need to be deleted before we can safely delete this one).
  const childrenOf = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const { name } of rows) {
    childrenOf.set(name, [])
    inDegree.set(name, 0)
  }
  for (const [child, parents] of parentsOf) {
    for (const parent of parents) {
      inDegree.set(parent, (inDegree.get(parent) ?? 0) + 1)
      childrenOf.get(child)!.push(parent) // when child is deleted, parent's in-degree drops
    }
  }

  const sorted: string[] = []
  // Start with tables no other table depends on (i.e., pure children / leaf dependents)
  const queue: string[] = []
  for (const { name } of rows) {
    if ((inDegree.get(name) ?? 0) === 0) queue.push(name)
  }
  while (queue.length > 0) {
    const tbl = queue.shift()!
    sorted.push(tbl)
    for (const parent of childrenOf.get(tbl) ?? []) {
      const deg = (inDegree.get(parent) ?? 1) - 1
      inDegree.set(parent, deg)
      if (deg === 0) queue.push(parent)
    }
  }
  // Append any remaining tables not yet visited (cycles → best-effort)
  for (const { name } of rows) {
    if (!sorted.includes(name)) sorted.push(name)
  }

  // For tables with self-referencing FKs (e.g. files.source_file_id → files.id),
  // NULL out those columns first to avoid FK violations during DELETE.
  for (const { name, sql } of rows) {
    if (!sql) continue
    const selfRefs: string[] = []
    for (const m of sql.matchAll(/(\w+)\s+\w+.*?\bREFERENCES\s+"?(\w+)"?/gi)) {
      if (m[2] === name) selfRefs.push(m[1])
    }
    if (selfRefs.length > 0) {
      const setClause = selfRefs.map((col) => `"${col}" = NULL`).join(", ")
      await env.AQUILLA_DB.prepare(`UPDATE "${name}" SET ${setClause}`).run()
    }
  }

  for (const name of sorted) {
    await env.AQUILLA_DB.prepare(`DELETE FROM "${name}"`).run()
  }
})
