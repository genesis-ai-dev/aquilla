import type { Client } from "pg"

export interface ExpectedColumn {
  nullable: boolean
}

export interface SchemaContract {
  tables: Map<string, Map<string, ExpectedColumn>>
  constraints: Set<string>
  indexes: Set<string>
  rls: Map<string, { enabled: boolean; forced: boolean }>
  policies: Map<string, Set<string>>
  grants: Map<string, Set<string>>
}

export type LiveSchemaContract = SchemaContract

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
}

function matchingParen(sql: string, open: number): number {
  let depth = 0
  let quote: "'" | '"' | null = null
  for (let index = open; index < sql.length; index++) {
    const char = sql[index]
    if (quote) {
      if (char === quote && sql[index + 1] === quote) {
        index++
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "(") depth++
    if (char === ")" && --depth === 0) return index
  }
  throw new Error("Unclosed CREATE TABLE body in schema.sql")
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: "'" | '"' | null = null
  let start = 0
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (quote) {
      if (char === quote && body[index + 1] === quote) index++
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === "(") depth++
    else if (char === ")") depth--
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index).trim())
      start = index + 1
    }
  }
  const tail = body.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function identifiers(value: string): string[] {
  return value.split(",").map((item) => item.trim().replace(/^"|"$/g, "").toLowerCase()).filter(Boolean)
}

export function expectedSchemaContract(schemaSql: string, migrationSql: string[]): SchemaContract {
  const schema = stripSqlComments(schemaSql)
  const tables = new Map<string, Map<string, ExpectedColumn>>()
  const constraints = new Set<string>()
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(/gi
  let tableMatch: RegExpExecArray | null
  while ((tableMatch = tablePattern.exec(schema)) !== null) {
    const table = tableMatch[1].replaceAll('"', "").toLowerCase()
    const open = tablePattern.lastIndex - 1
    const close = matchingParen(schema, open)
    const columns = new Map<string, ExpectedColumn>()
    const primaryKeyColumns = new Set<string>()
    for (const part of splitTopLevel(schema.slice(open + 1, close))) {
      const constraint = part.match(/^CONSTRAINT\s+("?[A-Za-z_][A-Za-z0-9_]*"?)/i)
      if (constraint) constraints.add(constraint[1].replaceAll('"', "").toLowerCase())
      const primary = part.match(/(?:^|\s)PRIMARY\s+KEY\s*\(([^)]+)\)/i)
      if (primary) identifiers(primary[1]).forEach((column) => primaryKeyColumns.add(column))
      if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(part)) continue
      const column = part.match(/^("?[A-Za-z_][A-Za-z0-9_]*"?)\s+([\s\S]+)$/)
      if (!column) continue
      const name = column[1].replaceAll('"', "").toLowerCase()
      columns.set(name, { nullable: !/\b(?:NOT\s+NULL|PRIMARY\s+KEY)\b/i.test(column[2]) })
    }
    for (const column of primaryKeyColumns) {
      const expected = columns.get(column)
      if (expected) expected.nullable = false
    }
    tables.set(table, columns)
    tablePattern.lastIndex = close + 1
  }

  for (const match of schema.matchAll(/\bCONSTRAINT\s+("?[A-Za-z_][A-Za-z0-9_]*"?)/gi)) {
    constraints.add(match[1].replaceAll('"', "").toLowerCase())
  }
  const indexes = new Set(
    [...schema.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)/gi)]
      .map((match) => match[1].replaceAll('"', "").toLowerCase()),
  )

  const migrations = stripSqlComments(migrationSql.join("\n"))
  const rls = new Map<string, { enabled: boolean; forced: boolean }>()
  for (const match of migrations.matchAll(/ALTER\s+TABLE\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY/gi)) {
    const table = match[1].replaceAll('"', "").toLowerCase()
    const value = rls.get(table) ?? { enabled: false, forced: false }
    if (match[2].toUpperCase() === "ENABLE") value.enabled = true
    else value.forced = true
    rls.set(table, value)
  }
  const policies = new Map<string, Set<string>>()
  for (const match of migrations.matchAll(/CREATE\s+POLICY\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s+ON\s+("?[A-Za-z_][A-Za-z0-9_]*"?)/gi)) {
    const policy = match[1].replaceAll('"', "").toLowerCase()
    const table = match[2].replaceAll('"', "").toLowerCase()
    if (!policies.has(table)) policies.set(table, new Set())
    policies.get(table)!.add(policy)
  }
  const grants = new Map<string, Set<string>>()
  for (const match of migrations.matchAll(/GRANT\s+([^;]+?)\s+ON\s+TABLE\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s+TO\s+app_runtime\s*;/gi)) {
    const table = match[2].replaceAll('"', "").toLowerCase()
    if (!grants.has(table)) grants.set(table, new Set())
    match[1].split(",").map((value) => value.trim().toUpperCase()).filter(Boolean)
      .forEach((privilege) => grants.get(table)!.add(privilege))
  }

  return { tables, constraints, indexes, rls, policies, grants }
}

export async function readLiveSchemaContract(client: Client): Promise<LiveSchemaContract> {
  const tables = new Map<string, Map<string, ExpectedColumn>>()
  const columnRows = await client.query(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public'`,
  )
  for (const row of columnRows.rows as Array<{ table_name: string; column_name: string; is_nullable: string }>) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, new Map())
    tables.get(row.table_name)!.set(row.column_name, { nullable: row.is_nullable === "YES" })
  }

  const constraints = new Set<string>((await client.query(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'`,
  )).rows.map((row: { conname: string }) => row.conname.toLowerCase()))
  const indexes = new Set<string>((await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  )).rows.map((row: { indexname: string }) => row.indexname.toLowerCase()))

  const rls = new Map<string, { enabled: boolean; forced: boolean }>()
  const rlsRows = await client.query(
    `SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  )
  for (const row of rlsRows.rows as Array<{ table_name: string; enabled: boolean; forced: boolean }>) {
    rls.set(row.table_name, { enabled: row.enabled, forced: row.forced })
  }

  const policies = new Map<string, Set<string>>()
  for (const row of (await client.query(
    `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`,
  )).rows as Array<{ tablename: string; policyname: string }>) {
    if (!policies.has(row.tablename)) policies.set(row.tablename, new Set())
    policies.get(row.tablename)!.add(row.policyname.toLowerCase())
  }

  const grants = new Map<string, Set<string>>()
  for (const row of (await client.query(
    `SELECT table_name, privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND grantee = 'app_runtime'`,
  )).rows as Array<{ table_name: string; privilege_type: string }>) {
    if (!grants.has(row.table_name)) grants.set(row.table_name, new Set())
    grants.get(row.table_name)!.add(row.privilege_type.toUpperCase())
  }

  return { tables, constraints, indexes, rls, policies, grants }
}

export function diffSchemaContract(expected: SchemaContract, live: LiveSchemaContract): string[] {
  const problems: string[] = []
  for (const [table, columns] of expected.tables) {
    const actual = live.tables.get(table)
    if (!actual) {
      problems.push(`missing table: ${table}`)
      continue
    }
    for (const [column, contract] of columns) {
      const liveColumn = actual.get(column)
      if (!liveColumn) problems.push(`missing column: ${table}.${column}`)
      else if (liveColumn.nullable !== contract.nullable) {
        problems.push(
          `column nullability mismatch: ${table}.${column} ` +
          `(expected ${contract.nullable ? "NULL" : "NOT NULL"}, live ${liveColumn.nullable ? "NULL" : "NOT NULL"})`,
        )
      }
    }
  }
  for (const constraint of expected.constraints) {
    if (!live.constraints.has(constraint)) problems.push(`missing constraint: ${constraint}`)
  }
  for (const index of expected.indexes) {
    if (!live.indexes.has(index)) problems.push(`missing index: ${index}`)
  }
  for (const [table, contract] of expected.rls) {
    const actual = live.rls.get(table)
    if (contract.enabled && !actual?.enabled) problems.push(`RLS is not enabled: ${table}`)
    if (contract.forced && !actual?.forced) problems.push(`RLS is not forced: ${table}`)
  }
  for (const [table, policies] of expected.policies) {
    for (const policy of policies) {
      if (!live.policies.get(table)?.has(policy)) problems.push(`missing RLS policy: ${table}.${policy}`)
    }
  }
  for (const [table, privileges] of expected.grants) {
    for (const privilege of privileges) {
      if (!live.grants.get(table)?.has(privilege)) problems.push(`missing app_runtime grant: ${table}.${privilege}`)
    }
  }
  return problems
}
