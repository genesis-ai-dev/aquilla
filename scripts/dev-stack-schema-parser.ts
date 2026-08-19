export type SchemaTable = {
  /** Full CREATE TABLE block, with IF NOT EXISTS forced in. */
  createSql: string
  columns: Array<{ name: string; def: string }>
}

function sqlParenthesisDelta(line: string): number {
  let delta = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inSingleQuote) {
      if (char === "'" && line[i + 1] === "'") i++
      else if (char === "'") inSingleQuote = false
      continue
    }
    if (inDoubleQuote) {
      if (char === '"' && line[i + 1] === '"') i++
      else if (char === '"') inDoubleQuote = false
      continue
    }
    if (char === "'") inSingleQuote = true
    else if (char === '"') inDoubleQuote = true
    else if (char === "(") delta++
    else if (char === ")") delta--
  }
  return delta
}

const TABLE_CONSTRAINT_KEYWORDS = new Set([
  "PRIMARY",
  "UNIQUE",
  "CHECK",
  "CONSTRAINT",
  "FOREIGN",
  "REFERENCES",
  "ON",
  "MATCH",
  "DEFERRABLE",
  "INITIALLY",
  "EXCLUDE",
])

/**
 * Parse schema.sql into table blocks + column definitions + index statements.
 * Relies on the file's regular shape (scripts/neon-migrate.ts gates prod
 * deploys on a comma-splitting parse of the same file): blocks open with
 * `CREATE TABLE name (` and close with `);`. Entries are comma-separated; a
 * column or constraint may wrap onto continuation lines (e.g. a DEFAULT
 * expression), which are folded into the entry that opened them. Index
 * statements may span lines and are accumulated through their semicolon.
 */
export function parsePgSchema(sql: string): {
  tables: Map<string, SchemaTable>
  indexesByTable: Map<string, string[]>
} {
  const tables = new Map<string, SchemaTable>()
  const indexesByTable = new Map<string, string[]>()
  let current: SchemaTable | null = null
  let block: string[] = []
  let tableDepth = 0
  let pendingIndex: string[] | null = null
  // Entry tracking: a top-level line starts a new column/constraint only when
  // the previous entry was closed by a trailing comma; otherwise it continues
  // the open entry. openColumn is that entry when it is a column (null for
  // constraints), so continuation lines extend its ALTER-able definition.
  let expectNewEntry = true
  let openColumn: { name: string; def: string } | null = null
  const recordIndex = (lines: string[]): void => {
    const statement = lines.join(" ").replace(/\s+/g, " ").trim()
    const index = statement.match(
      /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?\S+\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)/i,
    )
    if (!index) return
    const tableName = index[2].toLowerCase()
    const idempotent = /IF NOT EXISTS/i.test(statement)
      ? statement
      : statement.replace(
          /^CREATE\s+(UNIQUE\s+)?INDEX\s+/i,
          (_, uniq) => `CREATE ${uniq ? "UNIQUE " : ""}INDEX IF NOT EXISTS `,
        )
    if (!indexesByTable.has(tableName)) indexesByTable.set(tableName, [])
    indexesByTable.get(tableName)!.push(idempotent)
  }
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "").trimEnd()
    const trimmed = line.trim()
    if (current === null) {
      if (pendingIndex) {
        if (trimmed) pendingIndex.push(trimmed)
        if (trimmed.endsWith(";")) {
          recordIndex(pendingIndex)
          pendingIndex = null
        }
        continue
      }
      const table = trimmed.match(
        /^CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z0-9_]*)\s*\($/i,
      )
      if (table) {
        current = { createSql: "", columns: [] }
        block = [`CREATE TABLE IF NOT EXISTS ${table[1]} (`]
        tableDepth = 1
        expectNewEntry = true
        openColumn = null
        tables.set(table[1].toLowerCase(), current)
        continue
      }
      if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(trimmed)) {
        pendingIndex = [trimmed]
        if (trimmed.endsWith(";")) {
          recordIndex(pendingIndex)
          pendingIndex = null
        }
      }
      continue
    }
    block.push(line)
    const depthBeforeLine = tableDepth
    tableDepth += sqlParenthesisDelta(line)
    if (tableDepth === 0) {
      current.createSql = block.join("\n")
      current = null
      continue
    }
    if (!trimmed) continue
    const startsEntry = expectNewEntry
    // Only a trailing comma at top level closes an entry; commas inside
    // multiline CHECK/FK parens must not.
    expectNewEntry = tableDepth === 1 && trimmed.endsWith(",")
    // Only top-level lines are entries or their continuations. Lines nested
    // inside multiline CHECK/CONSTRAINT parens must never become additive
    // ALTER statements.
    if (depthBeforeLine !== 1) continue
    if (!startsEntry) {
      // Continuation of a wrapped entry (e.g. a DEFAULT expression on its own
      // line) — fold it into the open column's definition, never a new column.
      if (openColumn) openColumn.def += ` ${trimmed.replace(/,\s*$/, "")}`
      continue
    }
    const first = trimmed.split(/[\s(,]/)[0]
    if (!first || TABLE_CONSTRAINT_KEYWORDS.has(first.toUpperCase())) {
      openColumn = null
      continue
    }
    openColumn = {
      name: first.toLowerCase(),
      def: trimmed.replace(/,\s*$/, ""),
    }
    current.columns.push(openColumn)
  }
  return { tables, indexesByTable }
}
