// The migration gate (docs/RELEASE-RISK-GATES.md, "Gates"). A schema change
// was the one holding area that always waited for a person, for two reasons
// the person was checking by eye:
//
//   1. Order. The migration lands on production before the code that needs
//      it (the deploy refuses to run past a pending migration), so for a
//      while production's CURRENT code runs on the NEW schema. A statement
//      the current code can notice (a dropped or renamed column, a new NOT
//      NULL, a rewritten function) breaks production in that window, and a
//      rollback of the code does not undo it.
//   2. Drift. The workers' tests run on db/postgres/schema.sql, production
//      runs what the migration files did. When the two disagree, every test
//      is green and the route answers 500.
//
// This file checks both without a person:
//
//   additive   every statement the PR's new migration files run is on a
//              short list the current code cannot notice: a new table, a new
//              nullable or defaulted column, a new index, a new type. A
//              statement off the list is not wrong, it is a person's call.
//   schema     the base commit's schema.sql plus the new migration files is,
//              catalog for catalog, the head commit's schema.sql.
//
// The third leg lives in the workflow (risk-label.yml, `migration-gate`): the
// BASE commit's replay corpus and permission matrix run against the HEAD
// schema.sql and must still answer their goldens. That is "production's
// code on the new schema", measured.
//
// Usage:
//   tsx scripts/gate-migration.ts check <baseDir> <headDir>
//   tsx scripts/gate-migration.ts additive <file.sql>...
// `additive` is also what release-deploy.yml asks before it applies a pending
// migration to production by itself: only files this list passes.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { planMigration, scanSql } from "./neon-migration-file"

/**
 * Tables every write goes through and whose size makes a rewrite or a
 * non-concurrent index build a write outage, whatever lock_timeout says
 * about waiting for the lock: the timeout bounds the wait, not the hold.
 */
export const HOT_TABLES = ["events", "cells"]

export type Verdict = { ok: true } | { ok: false; why: string }

const no = (why: string): Verdict => ({ ok: false, why })
const OK: Verdict = { ok: true }

const tableName = (raw: string) => raw.replace(/"/g, "").replace(/^public\./i, "").toLowerCase()

/** Top-level comma split: commas inside parentheses belong to an expression. */
function splitActions(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of text) {
    if (ch === "(") depth += 1
    if (ch === ")") depth -= 1
    if (ch === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function addColumnVerdict(action: string, table: string): Verdict {
  if (!/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)/i.test(action)) {
    return no(`ALTER TABLE ${table}: only ADD COLUMN is additive, not \`${action.slice(0, 60)}\``)
  }
  const generated = /\bGENERATED\b/i.test(action)
  const hasDefault = /\bDEFAULT\b/i.test(action)
  if (/\bNOT\s+NULL\b/i.test(action) && !hasDefault && !generated) {
    return no(`ALTER TABLE ${table}: a NOT NULL column with no DEFAULT fails every insert the current code makes`)
  }
  if (HOT_TABLES.includes(table)) {
    if (generated && /\bSTORED\b/i.test(action)) return no(`ALTER TABLE ${table}: a STORED generated column rewrites the table`)
    // A constant default is metadata only; a volatile one rewrites every row.
    // now() and CURRENT_TIMESTAMP are stable and do not.
    const expression = /\bDEFAULT\b(.*)$/i.exec(action)?.[1] ?? ""
    if (/\(/.test(expression.replace(/\bnow\s*\(\s*\)/gi, ""))) {
      return no(`ALTER TABLE ${table}: a DEFAULT that calls a function may rewrite the table`)
    }
  }
  return OK
}

/**
 * Whether one statement is additive: production's current code, which has
 * never heard of it, behaves the same after it runs.
 */
export function classifyStatement(statement: string): Verdict {
  const code = scanSql(statement).code.replace(/\s+/g, " ").trim().replace(/;$/, "").trim()
  if (!code) return OK
  if (/^(BEGIN|COMMIT|START TRANSACTION)$/i.test(code)) return OK
  if (/^SET (LOCAL )?(lock_timeout|statement_timeout)\b/i.test(code)) return OK
  if (/^COMMENT ON /i.test(code)) return OK
  if (/^CREATE TABLE /i.test(code)) return OK
  if (/^CREATE TYPE /i.test(code)) return OK
  if (/^ALTER TYPE \S+ ADD VALUE /i.test(code)) return OK
  if (/^CREATE FUNCTION /i.test(code)) return OK

  const index = /^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?\S+ ON (?:ONLY )?([^\s(]+)/i.exec(code)
  if (index) {
    const table = tableName(index[2])
    if (!index[1] && HOT_TABLES.includes(table)) return no(`an index on ${table} without CONCURRENTLY blocks every write while it builds`)
    return OK
  }

  const alter = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(\S+) (.+)$/i.exec(code)
  if (alter) {
    const table = tableName(alter[1])
    for (const action of splitActions(alter[2])) {
      const verdict = addColumnVerdict(action, table)
      if (!verdict.ok) return verdict
    }
    return OK
  }

  return no(`not on the additive list: \`${code.slice(0, 80)}\``)
}

export interface FileVerdict {
  file: string
  problems: string[]
}

/** Every statement of one migration file, classified. */
export function classifyMigration(file: string, sql: string): FileVerdict {
  const problems: string[] = []
  for (const statement of scanSql(sql).statements) {
    const verdict = classifyStatement(statement)
    if (!verdict.ok) problems.push(verdict.why)
  }
  return { file, problems }
}

const MIGRATIONS = path.join("db", "postgres", "migrations")
const SCHEMA = path.join("db", "postgres", "schema.sql")

const migrationFiles = (root: string) =>
  existsSync(path.join(root, MIGRATIONS)) ? readdirSync(path.join(root, MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort() : []

/**
 * What the head adds over the base: new files, in apply order, and any file
 * both have with different bytes. An edited file is never additive: one
 * environment has already run the old text, and the ledger will not run the
 * new one.
 */
export function migrationDelta(baseDir: string, headDir: string): { added: string[]; edited: string[]; removed: string[] } {
  const base = new Set(migrationFiles(baseDir))
  const head = migrationFiles(headDir)
  const read = (root: string, name: string) => readFileSync(path.join(root, MIGRATIONS, name), "utf8")
  return {
    added: head.filter((name) => !base.has(name)),
    edited: head.filter((name) => base.has(name) && read(baseDir, name) !== read(headDir, name)),
    removed: [...base].filter((name) => !head.includes(name)),
  }
}

// One row per catalog object the workers' SQL can depend on. Column position
// is left out: ADD COLUMN appends, schema.sql declares in place.
const CATALOG_SQL = `
SELECT 'column' AS kind, table_name || '.' || column_name AS name,
       concat_ws(' | ', udt_name, 'nullable=' || is_nullable, 'default=' || coalesce(column_default, ''),
                 'generated=' || coalesce(generation_expression, '')) AS def
  FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL
SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid <> 0
UNION ALL
SELECT 'trigger', tgrelid::regclass::text || '.' || tgname, pg_get_triggerdef(oid)
  FROM pg_trigger WHERE NOT tgisinternal
UNION ALL
SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(p.prosrc)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
ORDER BY 1, 2`

type Catalog = Map<string, string>

async function catalogOf(statements: string[][]): Promise<Catalog> {
  // Loaded here, not at the top: `additive` runs in the deploy job from a
  // bare copy of this file and must not need the package.
  const { PGlite } = await import("@electric-sql/pglite")
  const pg = new PGlite()
  try {
    for (const batch of statements) for (const sql of batch) await pg.exec(sql)
    const result = await pg.query<{ kind: string; name: string; def: string }>(CATALOG_SQL)
    return new Map(result.rows.map((row) => [`${row.kind} ${row.name}`, row.def]))
  } finally {
    await pg.close()
  }
}

/** A migration file as the runner would send it: whole, or statement by statement outside a transaction. */
function asBatches(sql: string): string[] {
  const plan = planMigration(sql)
  return plan.mode === "transactional" ? [sql] : plan.statements
}

export function catalogDiff(migrated: Catalog, committed: Catalog): string[] {
  const problems: string[] = []
  for (const [key, def] of committed) {
    if (!migrated.has(key)) problems.push(`schema.sql has ${key}; the migrations do not create it`)
    else if (migrated.get(key) !== def) problems.push(`${key} differs — schema.sql: ${def} — migrations: ${migrated.get(key)}`)
  }
  for (const key of migrated.keys()) if (!committed.has(key)) problems.push(`the migrations create ${key}; schema.sql does not have it`)
  return problems
}

export async function checkMigrations(baseDir: string, headDir: string): Promise<{ added: string[]; problems: string[] }> {
  const delta = migrationDelta(baseDir, headDir)
  const problems: string[] = []
  for (const name of delta.edited) problems.push(`${name}: an existing migration file was edited; environments that already ran it will not run the new text`)
  for (const name of delta.removed) problems.push(`${name}: an existing migration file was removed`)
  const read = (name: string) => readFileSync(path.join(headDir, MIGRATIONS, name), "utf8")
  for (const name of delta.added) {
    for (const problem of classifyMigration(name, read(name)).problems) problems.push(`${name}: ${problem}`)
  }
  // Drift is checked even when a statement is off the list: the person who
  // reviews that statement should see both findings at once.
  const baseSchema = readFileSync(path.join(baseDir, SCHEMA), "utf8")
  const headSchema = readFileSync(path.join(headDir, SCHEMA), "utf8")
  try {
    const migrated = await catalogOf([[baseSchema], ...delta.added.map((name) => asBatches(read(name)))])
    const committed = await catalogOf([[headSchema]])
    problems.push(...catalogDiff(migrated, committed))
  } catch (error) {
    problems.push(`applying the new migrations to the base schema failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { added: delta.added, problems }
}

async function main(): Promise<number> {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === "additive" && args.length) {
    const verdicts = args.map((file) => classifyMigration(path.basename(file), readFileSync(file, "utf8")))
    for (const { file, problems } of verdicts) for (const problem of problems) console.log(`✗ ${file}: ${problem}`)
    const bad = verdicts.filter((verdict) => verdict.problems.length)
    if (!bad.length) console.log(`✓ additive: ${verdicts.map((verdict) => verdict.file).join(", ")}`)
    return bad.length ? 1 : 0
  }
  if (mode === "check" && args.length === 2) {
    const { added, problems } = await checkMigrations(args[0], args[1])
    for (const problem of problems) console.log(`✗ ${problem}`)
    if (!problems.length) console.log(`✓ migration gate: ${added.length ? added.join(", ") : "no new migration files"}; additive, and the result is schema.sql`)
    return problems.length ? 1 : 0
  }
  console.error("usage: gate-migration.ts check <baseDir> <headDir> | additive <file.sql>...")
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
