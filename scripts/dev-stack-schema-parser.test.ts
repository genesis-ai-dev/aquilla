import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parsePgSchema } from "./dev-stack-schema-parser"

describe("local dev schema parser", () => {
  it("does not treat multiline foreign-key continuations as columns", () => {
    const { tables, indexesByTable } = parsePgSchema(`
      CREATE TABLE artifacts (
        id UUID PRIMARY KEY,
        project_id TEXT NOT NULL,
        UNIQUE (id, project_id)
      );
      CREATE TABLE artifact_bindings (
        id UUID PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_id UUID NOT NULL,
        CONSTRAINT artifact_bindings_artifact_project_fkey
          FOREIGN KEY (artifact_id, project_id)
          REFERENCES artifacts(id, project_id)
          ON DELETE CASCADE
      );
      CREATE INDEX idx_artifact_bindings_project
        ON artifact_bindings(project_id);
    `)

    expect(tables.get("artifact_bindings")?.columns.map((column) => column.name)).toEqual([
      "id",
      "project_id",
      "artifact_id",
    ])
    expect(tables.get("artifact_bindings")?.createSql).toContain(
      "REFERENCES artifacts(id, project_id)",
    )
    expect(indexesByTable.get("artifact_bindings")).toEqual([
      "CREATE INDEX IF NOT EXISTS idx_artifact_bindings_project ON artifact_bindings(project_id);",
    ])
  })

  it("folds a wrapped DEFAULT expression into its column, not a new column", () => {
    // Regression: project_seq_counters.project_epoch (migration 0079) wraps
    // its DEFAULT onto a continuation line; the parser used to emit a bogus
    // column named "default" whose ALTER broke every local boot.
    const { tables } = parsePgSchema(`
      CREATE TABLE project_seq_counters (
        project_id  TEXT PRIMARY KEY,
        last_seq    BIGINT NOT NULL,
        rebuilt_seq BIGINT NOT NULL DEFAULT 0,
        project_epoch BIGINT NOT NULL
            DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::BIGINT
      );
    `)

    const table = tables.get("project_seq_counters")
    expect(table?.columns.map((column) => column.name)).toEqual([
      "project_id",
      "last_seq",
      "rebuilt_seq",
      "project_epoch",
    ])
    expect(table?.columns.at(-1)?.def).toBe(
      "project_epoch BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::BIGINT",
    )
  })

  it("keeps recognizing columns after a multiline CHECK constraint", () => {
    const { tables } = parsePgSchema(`
      CREATE TABLE widgets (
        id TEXT PRIMARY KEY,
        CHECK (
          id <> ''
        ),
        kind TEXT NOT NULL
            DEFAULT 'basic'
      );
    `)

    expect(tables.get("widgets")?.columns).toEqual([
      { name: "id", def: "id TEXT PRIMARY KEY" },
      { name: "kind", def: "kind TEXT NOT NULL DEFAULT 'basic'" },
    ])
  })

  it("makes single-line indexes idempotent", () => {
    const { indexesByTable } = parsePgSchema(`
      CREATE INDEX idx_artifact_bindings_project ON artifact_bindings(project_id);
    `)
    expect(indexesByTable.get("artifact_bindings")).toEqual([
      "CREATE INDEX IF NOT EXISTS idx_artifact_bindings_project ON artifact_bindings(project_id);",
    ])
  })

  // AQU-1686: the parser skips lines nested inside a column's parentheses, so
  // a generated column written as `AS (` + lines + `) STORED` came out as
  // `… GENERATED ALWAYS AS (` and its ALTER would have broken every local boot
  // that reconciles an existing container. Guard the real schema, not a fixture.
  it("reads every column of the real schema.sql as a complete definition", () => {
    // Two multi-line CHECK columns already parse short. They were created with
    // their tables (0074, 0076), and a missing table is rebuilt from its full
    // CREATE block, so the reconciler never ALTERs them in. Nothing else may.
    const knownShort = new Set(["contextual_run_events.kind", "contextual_decisions.readiness_item"])
    const schema = readFileSync(path.resolve(import.meta.dirname, "..", "db", "postgres", "schema.sql"), "utf8")
    const incomplete: string[] = []
    for (const [table, { columns }] of parsePgSchema(schema).tables) {
      for (const { name, def } of columns) {
        const opens = (def.match(/\(/g) ?? []).length
        const closes = (def.match(/\)/g) ?? []).length
        if (opens !== closes && !knownShort.has(`${table}.${name}`)) incomplete.push(`${table}.${name}: ${def}`)
      }
    }
    expect(incomplete).toEqual([])
  })
})
