export interface PgSchemaClient {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type RunSchemaSql = (sql: string, what: string) => Promise<void>

async function tableExists(client: PgSchemaClient, table: string): Promise<boolean> {
  const { rows } = await client.query("SELECT to_regclass($1) AS table_name", [`public.${table}`])
  return rows[0]?.table_name != null
}

async function hasConstraint(
  client: PgSchemaClient,
  table: string,
  constraint: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1
       FROM pg_constraint
      WHERE conrelid = $1::regclass
        AND conname = $2`,
    [table, constraint],
  )
  return rows.length > 0
}

async function ensureConstraint(
  client: PgSchemaClient,
  run: RunSchemaSql,
  table: string,
  constraint: string,
  definition: string,
): Promise<string | null> {
  if (await hasConstraint(client, table, constraint)) return null
  await run(
    `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${definition}`,
    `adding constraint ${constraint}`,
  )
  return `added constraint ${constraint}`
}

/**
 * Prepare long-lived local databases before artifact_bindings is created.
 * Postgres requires the referenced composite unique keys to exist when it
 * parses the CREATE TABLE statement, so this must run before generic table
 * reconciliation.
 */
export async function prepareArtifactBindingSchema(
  client: PgSchemaClient,
  run: RunSchemaSql,
): Promise<string[]> {
  const patched: string[] = []
  if (await tableExists(client, "artifacts")) {
    const message = await ensureConstraint(
      client,
      run,
      "artifacts",
      "artifacts_id_project_id_key",
      "UNIQUE (id, project_id)",
    )
    if (message) patched.push(message)
  }
  if (await tableExists(client, "files")) {
    const message = await ensureConstraint(
      client,
      run,
      "files",
      "files_id_project_id_key",
      "UNIQUE (id, project_id)",
    )
    if (message) patched.push(message)
  }
  return patched
}

/** Mirror migrations 0067-0068 after generic reconciliation creates/adds the
 * artifact import tables and columns. Safe and idempotent on every dev boot. */
export async function finalizeArtifactBindingSchema(
  client: PgSchemaClient,
  run: RunSchemaSql,
): Promise<string[]> {
  if (!(await tableExists(client, "artifact_bindings"))) return []
  const patched: string[] = []

  const { rows: credentialColumns } = await client.query(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'artifacts'
        AND column_name = 'credential_id'`,
  )
  if (credentialColumns[0]?.is_nullable === "NO") {
    await run(
      "ALTER TABLE artifacts ALTER COLUMN credential_id DROP NOT NULL",
      "allowing browser artifacts without an API credential",
    )
    patched.push("made artifacts.credential_id nullable")
  }

  if (await hasConstraint(client, "artifact_bindings", "artifact_bindings_artifact_id_fkey")) {
    await run(
      "ALTER TABLE artifact_bindings DROP CONSTRAINT artifact_bindings_artifact_id_fkey",
      "removing the legacy artifact binding foreign key",
    )
    patched.push("removed legacy artifact binding FK")
  }

  const artifactConstraint = await ensureConstraint(
    client,
    run,
    "artifact_bindings",
    "artifact_bindings_artifact_project_fkey",
    "FOREIGN KEY (artifact_id, project_id) REFERENCES artifacts(id, project_id) ON DELETE CASCADE",
  )
  if (artifactConstraint) patched.push(artifactConstraint)
  const fileConstraint = await ensureConstraint(
    client,
    run,
    "artifact_bindings",
    "artifact_bindings_file_project_fkey",
    "FOREIGN KEY (file_id, project_id) REFERENCES files(id, project_id) ON DELETE CASCADE",
  )
  if (fileConstraint) patched.push(fileConstraint)

  return patched
}

/** Mirror migration 0046 for long-lived local databases. The generic dev
 * reconciler can add the R2 pointer columns, but it intentionally does not
 * rewrite existing column constraints. Without this targeted repair, a local
 * database first created before 0046 rejects every R2-backed DOCX/PPTX source
 * because those rows correctly store raw_source = NULL. */
export async function finalizeSourceBlobSchema(
  client: PgSchemaClient,
  run: RunSchemaSql,
): Promise<string[]> {
  if (!(await tableExists(client, "file_source_blobs"))) return []

  const { rows } = await client.query(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'file_source_blobs'
        AND column_name = 'raw_source'`,
  )
  if (rows[0]?.is_nullable !== "NO") return []

  await run(
    "ALTER TABLE file_source_blobs ALTER COLUMN raw_source DROP NOT NULL",
    "allowing R2-backed source originals (migration 0046)",
  )
  return ["made file_source_blobs.raw_source nullable"]
}
