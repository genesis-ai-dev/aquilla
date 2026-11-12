// AQU-1953: SEED_TABLES is checked against the live schema. `lanes` went
// missing for a month after the lane foreign keys landed, and every fresh
// bundle failed on cells_lane_id_fkey with nothing to say so before a load.
import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEPENDENT_TABLES, EXCLUDED_TABLES, SEED_TABLES } from "./seed-tables"

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/postgres/schema.sql")

type OnDelete = "none" | "cascade" | "set null"
interface ForeignKey { from: string; to: string; onDelete: OnDelete }
interface Schema { columns: Map<string, Set<string>>; foreignKeys: ForeignKey[] }

// Words that open a table-level constraint rather than a column.
const CONSTRAINT_WORDS = new Set(["PRIMARY", "UNIQUE", "CONSTRAINT", "FOREIGN", "CHECK", "EXCLUDE", "LIKE"])

/**
 * Just enough of schema.sql: one column per line inside `CREATE TABLE … (` … `);`,
 * inline `REFERENCES t` on a column or table-level constraint, and single-line
 * `ALTER TABLE t ADD CONSTRAINT … FOREIGN KEY (…) REFERENCES r (…)`.
 */
export function parseSchema(sql: string): Schema {
  const columns = new Map<string, Set<string>>()
  const foreignKeys: ForeignKey[] = []
  const onDeleteOf = (line: string): OnDelete =>
    /ON DELETE CASCADE/i.test(line) ? "cascade" : /ON DELETE SET NULL/i.test(line) ? "set null" : "none"
  let current: string | null = null
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "").trimEnd()
    const body = line.trim()
    if (!body) continue
    const create = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?"?(\w+)"?\s*\(/.exec(body)
    if (create) {
      current = create[1]
      columns.set(current, new Set())
      if (/\);\s*$/.test(body)) current = null // single-line table: nothing more to read
      continue
    }
    // The terminator sits at column 0; a `)` inside a multi-line CHECK is indented.
    if (current && /^\)/.test(line)) {
      current = null
      continue
    }
    const alter = /^ALTER TABLE\s+"?(\w+)"?\s+ADD CONSTRAINT\s+\w+\s+FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+"?(\w+)"?/i.exec(body)
    if (alter) {
      foreignKeys.push({ from: alter[1], to: alter[2], onDelete: onDeleteOf(body) })
      continue
    }
    if (!current) continue
    const word = /^"?(\w+)"?/.exec(body)?.[1]
    if (word && !CONSTRAINT_WORDS.has(word.toUpperCase())) columns.get(current)!.add(word)
    const ref = /\bREFERENCES\s+"?(\w+)"?/i.exec(body)
    if (ref) foreignKeys.push({ from: current, to: ref[1], onDelete: onDeleteOf(body) })
  }
  return { columns, foreignKeys }
}

const schema = parseSchema(fs.readFileSync(SCHEMA_PATH, "utf8"))
const order = new Map(SEED_TABLES.map((t, i) => [t.name, i] as const))
const seeded = (name: string) => order.has(name)

describe("SEED_TABLES against db/postgres/schema.sql", () => {
  it("reads the schema it is checking", () => {
    expect(schema.columns.size).toBeGreaterThan(100)
    expect(schema.columns.get("cells")).toContain("lane_id")
    expect(schema.foreignKeys).toContainEqual({ from: "cells", to: "lanes", onDelete: "none" })
    expect(schema.foreignKeys).toContainEqual({ from: "checking_links", to: "projects", onDelete: "cascade" })
  })

  it("names only tables and columns that exist", () => {
    const missing: string[] = []
    for (const t of SEED_TABLES) {
      const cols = schema.columns.get(t.name)
      if (!cols) {
        missing.push(t.name)
        continue
      }
      for (const col of [t.by.col, ...t.pk, ...(t.pageKey ?? []), ...(t.authorCols ?? [])]) {
        if (!cols.has(col)) missing.push(`${t.name}.${col}`)
      }
    }
    for (const d of DEPENDENT_TABLES) {
      const cols = schema.columns.get(d.name)
      if (!cols) missing.push(d.name)
      else if (!cols.has(d.by.col)) missing.push(`${d.name}.${d.by.col}`)
    }
    for (const name of EXCLUDED_TABLES) if (!schema.columns.has(name)) missing.push(name)
    expect(missing).toEqual([])
  })

  it("loads every table after the tables it references", () => {
    // seed-load.ts inserts in list order with constraints on, so a seeded
    // table's referenced tables must be seeded, and earlier.
    const violations = schema.foreignKeys
      .filter((fk) => seeded(fk.from) && fk.from !== fk.to)
      .filter((fk) => !seeded(fk.to) || order.get(fk.to)! > order.get(fk.from)!)
      .map((fk) => `${fk.from} -> ${fk.to}`)
    expect([...new Set(violations)]).toEqual([])
  })

  it("clears every project-scoped table that would block a re-load", () => {
    // A table the seed does not carry, holding a non-cascading foreign key
    // onto a seeded project-scoped table, keeps rows the second seed:load
    // trips over at DELETE FROM lanes / files / projects. Org- and user-scoped
    // dependents (billing_price_cohorts, platform_settings, …) are a known gap
    // outside this check — docs/runbooks/seed-project-to-local.md § Limits.
    const projectScoped = new Set(SEED_TABLES.filter((t) => t.by.set === "project").map((t) => t.name))
    const cleaned = new Set(DEPENDENT_TABLES.map((d) => d.name))
    const violations = schema.foreignKeys
      .filter((fk) => projectScoped.has(fk.to) && !seeded(fk.from) && fk.onDelete === "none" && !cleaned.has(fk.from))
      .map((fk) => `${fk.from} -> ${fk.to}`)
    expect([...new Set(violations)]).toEqual([])
  })
})
