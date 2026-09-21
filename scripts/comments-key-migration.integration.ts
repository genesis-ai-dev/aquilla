// Real PostgreSQL check for CONCURRENTLY and pg's multi-statement query path.
// pnpm test:neon:comments (local Docker Postgres must already be running).
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, test } from "node:test"
import { Client } from "pg"
import { prepareCommentsKey } from "./neon-comments-key"
import { applyMigrationFile } from "./neon-migration-file"

const connectionString = process.env.COMMENTS_MIGRATION_TEST_PG_URL
  ?? "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname)) {
  throw new Error("Migration integration tests require a local PostgreSQL host")
}
const name = "0093_comments_project_scoped_pk.sql"
const sql = readFileSync(new URL(`../db/postgres/migrations/${name}`, import.meta.url), "utf8")
let client: Client
let schema: string

beforeEach(async () => {
  schema = `aqu1329_${randomUUID().replaceAll("-", "")}`
  client = new Client({ connectionString, connectionTimeoutMillis:15_000, statement_timeout:30_000 })
  await client.connect()
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
    CREATE TABLE schema_migrations (name text PRIMARY KEY);
    CREATE TABLE comments (comment_id text PRIMARY KEY, project_id text NOT NULL);
    INSERT INTO comments VALUES ('shared', 'p1');`)
})
afterEach(async () => {
  try {
    await client.query("ROLLBACK")
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  } finally { await client.end() }
})
async function key() {
  return (await client.query(`SELECT oid, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='comments'::regclass AND contype='p'`)).rows[0]
}

test("real runner prepares, applies, and preserves a repeated manual replay", async () => {
  const original = await key()
  await prepareCommentsKey(client)
  await prepareCommentsKey(client)
  assert.deepEqual(await key(), original)
  await applyMigrationFile(client, name, sql)
  const migrated = await key()
  assert.equal(migrated.definition, "PRIMARY KEY (project_id, comment_id)")
  assert.equal((await client.query("SELECT name FROM schema_migrations")).rows[0].name, name)
  await client.query(`INSERT INTO comments VALUES ('shared','p2')
    ON CONFLICT (project_id, comment_id) DO NOTHING`)
  await client.query(sql)
  await prepareCommentsKey(client)
  assert.deepEqual(await key(), migrated)
  assert.equal((await client.query("SELECT count(*)::int AS n FROM comments")).rows[0].n, 2)
})

test("missing preparation leaves both key and ledger unchanged", async () => {
  const original = await key()
  await assert.rejects(applyMigrationFile(client, name, sql), /prepare-comments-key/)
  await client.query("ROLLBACK")
  assert.deepEqual(await key(), original)
  assert.equal((await client.query("SELECT * FROM schema_migrations")).rows.length, 0)
})

test("manual composite key without ledger is preserved and recorded", async () => {
  await client.query(`ALTER TABLE comments DROP CONSTRAINT comments_pkey;
    ALTER TABLE comments ADD CONSTRAINT manual_key PRIMARY KEY(project_id,comment_id)`)
  const original = await key()
  await applyMigrationFile(client, name, sql)
  assert.deepEqual(await key(), original)
  assert.equal((await client.query("SELECT * FROM schema_migrations")).rows.length, 1)
})

test("failed concurrent build is rejected without changing the original key", async () => {
  await client.query("INSERT INTO comments VALUES ('another','p1')")
  const original = await key()
  await assert.rejects(client.query(`CREATE UNIQUE INDEX CONCURRENTLY
    comments_project_comment_pk ON comments(project_id)`), /could not create unique index/)
  const index = (await client.query(`SELECT indisvalid FROM pg_index
    WHERE indexrelid='comments_project_comment_pk'::regclass`)).rows[0]
  assert.equal(index.indisvalid, false)
  await assert.rejects(prepareCommentsKey(client), /not a valid unique index/)
  await assert.rejects(applyMigrationFile(client, name, sql), /Missing or invalid index/)
  await client.query("ROLLBACK")
  assert.deepEqual(await key(), original)
})

test("dependent foreign key prevents contract and the transaction restores the key", async () => {
  await client.query("CREATE TABLE replies (comment_id text REFERENCES comments(comment_id))")
  await prepareCommentsKey(client)
  const original = await key()
  await assert.rejects(applyMigrationFile(client, name, sql), /other objects depend on it/)
  await client.query("ROLLBACK")
  assert.deepEqual(await key(), original)
  assert.equal((await client.query("SELECT * FROM schema_migrations")).rows.length, 0)
})
