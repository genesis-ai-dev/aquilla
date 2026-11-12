import { describe, expect, it } from "vitest"
import { diffSchemaContract, expectedSchemaContract, type LiveSchemaContract } from "./neon-schema-contract"

function cloneAsLive(contract: ReturnType<typeof expectedSchemaContract>): LiveSchemaContract {
  return {
    tables: new Map([...contract.tables].map(([table, columns]) => [
      table,
      new Map([...columns].map(([column, value]) => [column, { ...value }])),
    ])),
    constraints: new Set(contract.constraints),
    indexes: new Set(contract.indexes),
    rls: new Map([...contract.rls].map(([table, value]) => [table, { ...value }])),
    policies: new Map([...contract.policies].map(([table, policies]) => [table, new Set(policies)])),
    grants: new Map([...contract.grants].map(([table, grants]) => [table, new Set(grants)])),
  }
}

const schema = `
CREATE TABLE artifacts (
  id UUID PRIMARY KEY,
  credential_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (id, credential_id)
);
CREATE TABLE artifact_bindings (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL,
  project_id TEXT NOT NULL,
  CONSTRAINT artifact_bindings_artifact_project_fkey
    FOREIGN KEY (artifact_id, project_id)
    REFERENCES artifacts(id, credential_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifact_bindings_project ON artifact_bindings(project_id);
`

const migration = `
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE artifact_bindings TO app_runtime;
ALTER TABLE artifact_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_artifact_bindings_project_access ON artifact_bindings
  FOR ALL TO app_runtime USING (true) WITH CHECK (true);
`

describe("Neon schema contract", () => {
  it("parses multiline constraints without inventing continuation-line columns", () => {
    const expected = expectedSchemaContract(schema, [migration])
    expect([...expected.tables.get("artifact_bindings")!.keys()]).toEqual([
      "id", "artifact_id", "project_id",
    ])
    expect(expected.constraints).toContain("artifact_bindings_artifact_project_fkey")
    expect(expected.indexes).toContain("idx_artifact_bindings_project")
  })

  it("captures nullability, RLS, policies, and runtime grants", () => {
    const expected = expectedSchemaContract(schema, [migration])
    expect(expected.tables.get("artifacts")!.get("credential_id")).toEqual({ nullable: true })
    expect(expected.tables.get("artifacts")!.get("id")).toEqual({ nullable: false })
    expect(expected.rls.get("artifact_bindings")).toEqual({ enabled: true, forced: true })
    expect(expected.policies.get("artifact_bindings")).toContain("rls_artifact_bindings_project_access")
    expect(expected.grants.get("artifact_bindings")).toEqual(new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]))
  })

  it("fails closed on security, relational, and column-contract drift", () => {
    const expected = expectedSchemaContract(schema, [migration])
    const live = cloneAsLive(expected)
    live.tables.get("artifacts")!.set("credential_id", { nullable: false })
    live.constraints.delete("artifact_bindings_artifact_project_fkey")
    live.indexes.delete("idx_artifact_bindings_project")
    live.rls.set("artifact_bindings", { enabled: true, forced: false })
    live.policies.get("artifact_bindings")!.clear()
    live.grants.get("artifact_bindings")!.delete("DELETE")

    expect(diffSchemaContract(expected, live)).toEqual([
      "column nullability mismatch: artifacts.credential_id (expected NULL, live NOT NULL)",
      "missing constraint: artifact_bindings_artifact_project_fkey",
      "missing index: idx_artifact_bindings_project",
      "RLS is not forced: artifact_bindings",
      "missing RLS policy: artifact_bindings.rls_artifact_bindings_project_access",
      "missing app_runtime grant: artifact_bindings.DELETE",
    ])
  })
})

// 2026-09-28 OPSEC review: the original grant pattern required
// `ON TABLE <one-identifier> TO app_runtime`, so it matched neither 0034's
// single 30-table statement nor 0090's keyword-less `ON <table>`. Every table
// granted that way — including `cells`, `events`, `files` and `comments` — was
// therefore absent from the expected contract, and `pnpm neon:status` checked
// no privilege at all for them.
describe("app_runtime grant parsing", () => {
  const grantSchema = `
CREATE TABLE cells (project_id TEXT NOT NULL);
CREATE TABLE events (project_id TEXT NOT NULL);
CREATE TABLE lanes (id TEXT PRIMARY KEY);
`
  const grantMigration = `
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    cells,
    events
TO app_runtime;
GRANT SELECT, INSERT ON lanes TO app_runtime;
GRANT EXECUTE ON FUNCTION app_user_can_access_project(TEXT) TO app_runtime;
`

  it("captures every table in a multi-table GRANT", () => {
    const expected = expectedSchemaContract(grantSchema, [grantMigration])
    expect(expected.grants.get("cells")).toEqual(new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]))
    expect(expected.grants.get("events")).toEqual(new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]))
  })

  it("captures a GRANT that omits the TABLE keyword", () => {
    const expected = expectedSchemaContract(grantSchema, [grantMigration])
    expect(expected.grants.get("lanes")).toEqual(new Set(["SELECT", "INSERT"]))
  })

  it("does not mistake GRANT EXECUTE ON FUNCTION for a table grant", () => {
    const expected = expectedSchemaContract(grantSchema, [grantMigration])
    expect([...expected.grants.keys()].sort()).toEqual(["cells", "events", "lanes"])
  })

  it("reports a multi-table grant missing from the live database", () => {
    const expected = expectedSchemaContract(grantSchema, [grantMigration])
    const live = cloneAsLive(expected)
    live.grants.get("events")!.delete("DELETE")
    expect(diffSchemaContract(expected, live)).toEqual(["missing app_runtime grant: events.DELETE"])
  })
})
