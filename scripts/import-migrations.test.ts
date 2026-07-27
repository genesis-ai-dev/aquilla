import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const migration = (name: string) => readFileSync(
  path.join(ROOT, "db", "postgres", "migrations", name),
  "utf8",
)
const M0066 = migration("0066_artifact_import_bindings.sql")
const M0067 = migration("0067_artifact_binding_project_consistency.sql")
const M0068 = migration("0068_browser_artifact_provenance.sql")

const ARTIFACT_1 = "00000000-0000-0000-0000-000000000001"
const ARTIFACT_2 = "00000000-0000-0000-0000-000000000002"
const BINDING_1 = "00000000-0000-0000-0000-000000000011"
const BINDING_2 = "00000000-0000-0000-0000-000000000012"

let pg: PGlite

async function bootstrapPre0066(): Promise<void> {
  await pg.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        CREATE ROLE app_runtime NOINHERIT NOLOGIN;
      END IF;
    END $$;

    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );

    CREATE TABLE artifacts (
      id UUID PRIMARY KEY,
      project_id TEXT NOT NULL,
      uploaded_by_user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      name TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      file_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION app_user_can_access_project(p_project_id TEXT)
    RETURNS BOOLEAN
    LANGUAGE sql
    STABLE
    AS $$
      SELECT p_project_id = current_setting('app.project_id', true)
    $$;
    GRANT EXECUTE ON FUNCTION app_user_can_access_project(TEXT) TO app_runtime;
  `)
}

async function seedReferences(): Promise<void> {
  await pg.query("INSERT INTO files (id, project_id) VALUES ('f1', 'p1'), ('f2', 'p2')")
  await pg.query(
    `INSERT INTO artifacts
       (id, project_id, uploaded_by_user_id, credential_id, name, size_bytes, sha256, r2_key)
     VALUES ($1, 'p1', 'u', 'c', 'one.usfm', 1, 'a', 'r1'),
            ($2, 'p2', 'u', 'c', 'two.usfm', 1, 'b', 'r2')`,
    [ARTIFACT_1, ARTIFACT_2],
  )
}

beforeEach(async () => {
  pg = new PGlite()
  await bootstrapPre0066()
}, 30_000)

afterEach(async () => {
  await pg.close()
}, 30_000)

describe("0066-0068 normalized import provenance migrations", () => {
  it("upgrades the prior schema idempotently with complete constraints, indexes, grants, and RLS", async () => {
    await pg.exec(M0066)
    await pg.exec(M0067)
    await pg.exec(M0068)
    await pg.exec(M0066)
    await pg.exec(M0067)
    await pg.exec(M0068)

    const metadata = await pg.query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'artifacts' AND column_name = 'metadata'`,
    )
    expect(metadata.rows[0]).toMatchObject({ is_nullable: "NO" })
    expect(metadata.rows[0].column_default).toContain("jsonb")

    const credential = await pg.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'artifacts' AND column_name = 'credential_id'`,
    )
    expect(credential.rows[0]).toEqual({ is_nullable: "YES" })

    const indexes = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'artifact_bindings'`,
    )
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "idx_artifact_bindings_project_file",
      "idx_artifact_bindings_artifact",
    ]))

    const constraints = await pg.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'artifact_bindings'::regclass`,
    )
    expect(constraints.rows.map((row) => row.conname)).toEqual(expect.arrayContaining([
      "artifact_bindings_artifact_project_fkey",
      "artifact_bindings_file_project_fkey",
      "artifact_bindings_binding_role_check",
      "artifact_bindings_fidelity_check",
    ]))

    const security = await pg.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'artifact_bindings'::regclass`,
    )
    expect(security.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })

    const policy = await pg.query<{ roles: string[]; qual: string | null; with_check: string | null }>(
      `SELECT roles, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'artifact_bindings'
          AND policyname = 'rls_artifact_bindings_project_access'`,
    )
    expect(policy.rows[0].roles).toContain("app_runtime")
    expect(policy.rows[0].qual).toContain("app_user_can_access_project")
    expect(policy.rows[0].with_check).toContain("app_user_can_access_project")

    const grants = await pg.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'artifact_bindings' AND grantee = 'app_runtime'`,
    )
    expect(grants.rows.map((row) => row.privilege_type).sort())
      .toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"])
  })

  it("rejects cross-project bindings and enforces tenant RLS for reads and writes", async () => {
    await pg.exec(M0066)
    await pg.exec(M0067)
    await seedReferences()

    await expect(pg.query(
      `INSERT INTO artifact_bindings
         (id, project_id, artifact_id, file_id, binding_role, profile_id, profile_version, fidelity)
       VALUES ($1, 'p1', $2, 'f1', 'source', 'builtin:test', '1', 'native')`,
      [BINDING_1, ARTIFACT_2],
    )).rejects.toThrow(/artifact_bindings_artifact_project_fkey/)

    await expect(pg.query(
      `INSERT INTO artifact_bindings
         (id, project_id, artifact_id, file_id, binding_role, profile_id, profile_version, fidelity)
       VALUES ($1, 'p1', $2, 'f2', 'source', 'builtin:test', '1', 'native')`,
      [BINDING_1, ARTIFACT_1],
    )).rejects.toThrow(/artifact_bindings_file_project_fkey/)

    await pg.query(
      `INSERT INTO artifact_bindings
         (id, project_id, artifact_id, file_id, binding_role, profile_id, profile_version, fidelity)
       VALUES ($1, 'p1', $2, 'f1', 'source', 'builtin:test', '1', 'native'),
              ($3, 'p2', $4, 'f2', 'source', 'builtin:test', '1', 'native')`,
      [BINDING_1, ARTIFACT_1, BINDING_2, ARTIFACT_2],
    )

    await pg.exec("SET ROLE app_runtime; SET app.project_id = 'p1';")
    const visible = await pg.query<{ project_id: string }>("SELECT project_id FROM artifact_bindings")
    expect(visible.rows).toEqual([{ project_id: "p1" }])

    await expect(pg.query(
      `INSERT INTO artifact_bindings
         (id, project_id, artifact_id, file_id, binding_role, profile_id, profile_version, fidelity)
       VALUES ('00000000-0000-0000-0000-000000000099', 'p2', $1, 'f2', 'source', 'builtin:test', '1', 'native')`,
      [ARTIFACT_2],
    )).rejects.toThrow(/row-level security/)
    await pg.exec("RESET ROLE")
  })
})
