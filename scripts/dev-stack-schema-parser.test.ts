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

  it("makes single-line indexes idempotent", () => {
    const { indexesByTable } = parsePgSchema(`
      CREATE INDEX idx_artifact_bindings_project ON artifact_bindings(project_id);
    `)
    expect(indexesByTable.get("artifact_bindings")).toEqual([
      "CREATE INDEX IF NOT EXISTS idx_artifact_bindings_project ON artifact_bindings(project_id);",
    ])
  })
})
