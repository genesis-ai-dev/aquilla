// @vitest-environment node
import { readFileSync } from "node:fs"
import type { Client } from "pg"
import { prepareCommentsKey } from "./neon-comments-key"
import { applyMigrationFile } from "./neon-migration-file"
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const sql = readFileSync(new URL(
  "../db/postgres/migrations/0093_comments_project_scoped_pk.sql",
  import.meta.url,
), "utf8")
let db: PGlite

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE schema_migrations (name text PRIMARY KEY);
    CREATE TABLE comments (
      comment_id text PRIMARY KEY,
      project_id text NOT NULL,
      body text NOT NULL
    );
    INSERT INTO comments VALUES ('shared', 'p1', 'original');
  `)
}, 30_000)
afterEach(async () => { await db.close() })

async function key() {
  return (await db.query<{ columns: string[]; oid: number }>(`
    SELECT c.oid, ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, pos)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
      ORDER BY k.pos
    ) AS columns
    FROM pg_constraint c WHERE conrelid = 'comments'::regclass AND contype = 'p'
  `)).rows[0]
}

async function apply() {
  try { await db.exec(sql) } catch (error) {
    await db.exec("ROLLBACK")
    throw error
  }
}

describe("comments primary-key migration", () => {
  it("explains missing preparation and preserves the original key and row", async () => {
    const before = await key()
    await expect(apply()).rejects.toThrow(/prepare-comments-key/)
    expect(await key()).toEqual(before)
    expect((await db.query("SELECT * FROM comments")).rows).toEqual([
      { comment_id: "shared", project_id: "p1", body: "original" },
    ])
  })

  it("promotes a prepared index and supports independent cross-project rows", async () => {
    await db.exec(`CREATE UNIQUE INDEX comments_project_comment_pk
      ON comments (project_id, comment_id)`)
    await apply()
    expect((await key()).columns).toEqual(["project_id", "comment_id"])
    await db.exec(`INSERT INTO comments VALUES ('shared', 'p2', 'second')
      ON CONFLICT (project_id, comment_id) DO NOTHING;
      INSERT INTO comments VALUES ('shared', 'p1', 'replay')
      ON CONFLICT (project_id, comment_id) DO NOTHING;`)
    expect((await db.query("SELECT body FROM comments ORDER BY project_id")).rows)
      .toEqual([{ body: "original" }, { body: "second" }])
  })

  it("preserves an already-migrated key across repeated execution", async () => {
    await db.exec(`ALTER TABLE comments DROP CONSTRAINT comments_pkey;
      ALTER TABLE comments ADD PRIMARY KEY (project_id, comment_id)`)
    const before = await key()
    await apply()
    await apply()
    expect(await key()).toEqual(before)
  })

  it("recognizes a manually named composite primary key by columns", async () => {
    await db.exec(`ALTER TABLE comments DROP CONSTRAINT comments_pkey;
      ALTER TABLE comments ADD CONSTRAINT manual_key
        PRIMARY KEY (project_id, comment_id)`)
    const before = await key()
    await apply()
    expect(await key()).toEqual(before)
  })

  it("rejects a wrong index definition before changing the existing key", async () => {
    await db.exec(`CREATE UNIQUE INDEX comments_project_comment_pk
      ON comments (comment_id)`)
    const before = await key()
    await expect(apply()).rejects.toThrow(/index.*project_id.*comment_id/)
    expect(await key()).toEqual(before)
  })

  it("rejects an unexpected primary key without replacing it", async () => {
    await db.exec(`ALTER TABLE comments DROP CONSTRAINT comments_pkey;
      ALTER TABLE comments ADD PRIMARY KEY (project_id)`)
    const before = await key()
    await expect(apply()).rejects.toThrow(/Unexpected comments primary key/)
    expect(await key()).toEqual(before)
  })
})

// PGlite exposes multi-statement execution as exec; pg uses query for both.
const client = {
  query: async (text: string, values?: unknown[]) => {
    if (text === sql) return db.exec(text)
    return db.query(text, values)
  },
} as unknown as Pick<Client, "query">

describe("Neon preparation and migration runner composition", () => {
  it("prepares outside a transaction, preserves the old key, then records apply", async () => {
    const before = await key()
    await prepareCommentsKey(client)
    await prepareCommentsKey(client)
    expect(await key()).toEqual(before)
    await applyMigrationFile(client, "0093_comments_project_scoped_pk.sql", sql)
    expect((await key()).columns).toEqual(["project_id", "comment_id"])
    expect((await db.query("SELECT name FROM schema_migrations")).rows).toEqual([
      { name: "0093_comments_project_scoped_pk.sql" },
    ])
    await prepareCommentsKey(client)
    expect((await db.query(
      "SELECT to_regclass('comments_project_comment_pk') AS index",
    )).rows).toEqual([{ index: null }])
  })

  it("does not record a failed migration", async () => {
    await expect(applyMigrationFile(client, "0093_comments_project_scoped_pk.sql", sql))
      .rejects.toThrow(/prepare-comments-key/)
    await db.exec("ROLLBACK")
    expect((await db.query("SELECT * FROM schema_migrations")).rows).toEqual([])
  })

  it("reconciles a manual key swap with a missing ledger entry", async () => {
    await db.exec(`ALTER TABLE comments DROP CONSTRAINT comments_pkey;
      ALTER TABLE comments ADD PRIMARY KEY (project_id, comment_id)`)
    const before = await key()
    await applyMigrationFile(client, "0093_comments_project_scoped_pk.sql", sql)
    expect(await key()).toEqual(before)
    expect((await db.query("SELECT * FROM schema_migrations")).rows).toHaveLength(1)
  })

  it("rejects an existing wrong index during preparation", async () => {
    await db.exec(`CREATE UNIQUE INDEX comments_project_comment_pk
      ON comments (comment_id)`)
    const before = await key()
    await expect(prepareCommentsKey(client)).rejects.toThrow(/not a valid unique index/)
    expect(await key()).toEqual(before)
  })
})
