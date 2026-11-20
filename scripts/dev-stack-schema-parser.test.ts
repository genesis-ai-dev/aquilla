import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { columnsToAdd, parsePgSchema } from "./dev-stack-schema-parser"
import { addedColumns } from "./neon-schema-contract"

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

  it("collects CREATE VIEW statements, with OR REPLACE forced in, without disturbing tables", () => {
    // Regression (2026-10-06): assignment_member_cells (migration 0147) is a
    // view, so the additive reconciler never created it in a long-lived
    // container and every assignments read 500ed with "relation does not
    // exist". Views come back in file order, comments stripped, so the
    // reconciler can CREATE OR REPLACE them after the tables they read.
    const { tables, views } = parsePgSchema(`
      CREATE TABLE assignment_scopes (
        assignment_id TEXT NOT NULL,
        chapter TEXT NOT NULL DEFAULT ''
      );
      -- AQU-1629: membership derived on read.
      CREATE OR REPLACE VIEW assignment_member_cells WITH (security_invoker = true) AS
        -- the frozen snapshot half
        SELECT s.assignment_id, s.chapter
          FROM assignment_scopes s
         WHERE s.chapter = ''; -- whole file
      CREATE VIEW plain_view AS SELECT 1 AS one;
      CREATE TABLE after_views (
        id TEXT PRIMARY KEY
      );
    `)

    expect(views.map((view) => view.name)).toEqual(["assignment_member_cells", "plain_view"])
    expect(views[0].createSql).toBe(
      [
        "CREATE OR REPLACE VIEW assignment_member_cells WITH (security_invoker = true) AS",
        "SELECT s.assignment_id, s.chapter",
        "FROM assignment_scopes s",
        "WHERE s.chapter = '';",
      ].join("\n"),
    )
    expect(views[1].createSql).toBe("CREATE OR REPLACE VIEW plain_view AS SELECT 1 AS one;")
    expect([...tables.keys()]).toEqual(["assignment_scopes", "after_views"])
    expect(tables.get("assignment_scopes")?.columns.map((column) => column.name)).toEqual([
      "assignment_id",
      "chapter",
    ])
  })
})

// AQU-2689: schema.sql declares some columns with `ALTER TABLE … ADD COLUMN`
// after their table. The parser read CREATE TABLE blocks only, so a long-lived
// local database never got users.email_changed_at,
// password_reset_tokens.email_at_issue or admin_elevations.factor_generation.
describe("columns added by ALTER TABLE … ADD COLUMN", () => {
  const parsed = parsePgSchema(`
    CREATE TABLE org_billing (
      org_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free'
    );
    -- AQU-1491: runtime grants.
    ALTER TABLE org_billing ADD COLUMN weekly_allowance BIGINT
      CHECK (weekly_allowance >= 0 AND weekly_allowance <= 10000000);
    ALTER TABLE org_billing ADD COLUMN IF NOT EXISTS plan TEXT;
    ALTER TABLE org_billing ADD CONSTRAINT org_billing_plan_check CHECK (plan <> '');
    ALTER TABLE never_created ADD COLUMN flag BOOLEAN;
  `)
  const orgBilling = parsed.tables.get("org_billing")!

  it("joins them to their table's columns, flagged, with the definition whole", () => {
    expect(orgBilling.columns).toEqual([
      { name: "org_id", def: "org_id TEXT PRIMARY KEY" },
      { name: "plan", def: "plan TEXT NOT NULL DEFAULT 'free'" },
      {
        name: "weekly_allowance",
        def: "weekly_allowance BIGINT CHECK (weekly_allowance >= 0 AND weekly_allowance <= 10000000)",
        addedByAlter: true,
      },
    ])
    expect(orgBilling.createSql).not.toContain("weekly_allowance")
    expect([...parsed.tables.keys()]).toEqual(["org_billing"])
  })

  it("adds whatever an existing table lacks, wherever schema.sql declares it", () => {
    expect(columnsToAdd(orgBilling, new Set(["org_id"])).map((column) => column.name)).toEqual([
      "plan",
      "weekly_allowance",
    ])
    expect(columnsToAdd(orgBilling, new Set(["org_id", "plan", "weekly_allowance"]))).toEqual([])
  })

  it("adds only the ALTER-declared columns to a table it has just created", () => {
    expect(columnsToAdd(orgBilling, undefined).map((column) => column.name)).toEqual([
      "weekly_allowance",
    ])
  })

  it("places every ADD COLUMN of the real schema.sql on a table it parsed", () => {
    const schema = readFileSync(path.resolve(import.meta.dirname, "..", "db", "postgres", "schema.sql"), "utf8")
    const { tables } = parsePgSchema(schema)
    const unplaced = addedColumns(schema)
      .filter(({ table, name }) => !tables.get(table)?.columns.some((column) => column.name === name && column.addedByAlter))
      .map(({ table, name }) => `${table}.${name}`)
    expect(unplaced).toEqual([])
  })
})
