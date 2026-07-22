import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  finalizeArtifactBindingSchema,
  finalizeChangesetSchema,
  finalizeSourceBlobSchema,
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
    CREATE TABLE file_source_blobs (
      file_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      format TEXT NOT NULL,
      raw_source TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      r2_key TEXT,
      size_bytes BIGINT
    );
    CREATE TABLE changesets (
      id UUID PRIMARY KEY,
      status TEXT NOT NULL
        CONSTRAINT changesets_status_check
        CHECK (status IN ('staged', 'committed', 'discarded', 'stale', 'expired'))
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

  it("allows R2-backed originals in a long-lived pre-0046 local database", async () => {
    expect(await finalizeSourceBlobSchema(client(), run)).toEqual([
      "made file_source_blobs.raw_source nullable",
    ])

    const rawSource = await pg.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'file_source_blobs'
          AND column_name = 'raw_source'`,
    )
    expect(rawSource.rows).toEqual([{ is_nullable: "YES" }])

    await expect(pg.query(
      `INSERT INTO file_source_blobs
         (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES ('f1', 'p1', 'docx', NULL, 'artifacts/p1/a/original.docx', 4, 1)`,
    )).resolves.toBeDefined()
    expect(await finalizeSourceBlobSchema(client(), run)).toEqual([])
  })

  it("admits the crash-retry committing state in a pre-0065 database", async () => {
    expect(await finalizeChangesetSchema(client(), run)).toEqual([
      "updated changesets.status constraint for committing",
    ])
    await expect(pg.query(
      "INSERT INTO changesets (id, status) VALUES ('00000000-0000-4000-8000-000000000001', 'committing')",
    )).resolves.toBeDefined()
    expect(await finalizeChangesetSchema(client(), run)).toEqual([])
  })
})
