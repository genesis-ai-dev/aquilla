import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  finalizeArtifactBindingSchema,
  prepareArtifactBindingSchema,
  type PgSchemaClient,
} from "./dev-stack-artifact-schema"

let pg: PGlite

beforeEach(async () => {
  pg = new PGlite()
  await pg.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id UUID PRIMARY KEY,
      project_id TEXT NOT NULL,
      credential_id TEXT NOT NULL
    );
  `)
}, 30_000)

afterEach(async () => {
  await pg.close()
}, 30_000)

const client = (): PgSchemaClient => pg as unknown as PgSchemaClient
const run = async (sql: string): Promise<void> => {
  await pg.exec(sql)
}

describe("local dev artifact schema reconciliation", () => {
  it("upgrades a pre-0066 database in dependency order and remains idempotent", async () => {
    expect(await prepareArtifactBindingSchema(client(), run)).toEqual([
      "added constraint artifacts_id_project_id_key",
      "added constraint files_id_project_id_key",
    ])

    // Migration 0066's original shape used a conventional artifact FK. The
    // finalizer must replace it without requiring the local DB to be deleted.
    await pg.exec(`
      CREATE TABLE artifact_bindings (
        id UUID PRIMARY KEY,
        project_id TEXT NOT NULL,
        artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL
      );
    `)

    expect(await finalizeArtifactBindingSchema(client(), run)).toEqual([
      "made artifacts.credential_id nullable",
      "removed legacy artifact binding FK",
      "added constraint artifact_bindings_artifact_project_fkey",
      "added constraint artifact_bindings_file_project_fkey",
    ])

    const constraints = await pg.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'artifact_bindings'::regclass",
    )
    expect(constraints.rows.map((row) => row.conname)).toEqual(expect.arrayContaining([
      "artifact_bindings_artifact_project_fkey",
      "artifact_bindings_file_project_fkey",
    ]))
    expect(constraints.rows.map((row) => row.conname)).not.toContain(
      "artifact_bindings_artifact_id_fkey",
    )

    const credential = await pg.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'artifacts'
          AND column_name = 'credential_id'`,
    )
    expect(credential.rows).toEqual([{ is_nullable: "YES" }])

    expect(await prepareArtifactBindingSchema(client(), run)).toEqual([])
    expect(await finalizeArtifactBindingSchema(client(), run)).toEqual([])
  })
})
