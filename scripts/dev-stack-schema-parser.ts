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
 * Relies on the file's regular shape (also assumed by scripts/neon-migrate.ts,
 * which gates prod deploys on the same parse): blocks open with
 * `CREATE TABLE name (`, one column per line, and close with `);`. Index
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
    // Only top-level entries are columns. Lines nested inside multiline
    // CHECK/CONSTRAINT clauses and balanced FK continuation lines must never
    // become additive ALTER statements.
    if (depthBeforeLine !== 1) continue
    const first = trimmed.split(/[\s(,]/)[0]
    if (!first || TABLE_CONSTRAINT_KEYWORDS.has(first.toUpperCase())) continue
    current.columns.push({
      name: first.toLowerCase(),
      def: trimmed.replace(/,\s*$/, ""),
    })
  }
  return { tables, indexesByTable }
}
