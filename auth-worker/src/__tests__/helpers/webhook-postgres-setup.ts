import { beforeAll, beforeEach, afterAll } from "vitest"
import { URL } from "node:url"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { makePostgres } from "../../../../db/shim/postgres"
import { env, pg } from "./pg-test-env"

// Never reset aquilla_dev or the primary agent's test database.
const name = `aqu_837_webhook_${randomUUID().replaceAll("-", "")}`
const base = new URL(process.env.WEBHOOK_TEST_PG_URL ??
  "postgresql://aquilla:aquilla@127.0.0.1:5432/postgres")
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("Webhook integration tests require a local Postgres server")
}
const admin = makePostgres(base.toString(), 1)
base.pathname = `/${name}`
const db = makePostgres(base.toString(), 4)
let created = false

beforeAll(async () => {
  await admin.exec(`CREATE DATABASE ${name}`)
  created = true
  await db.exec(readFileSync(new URL(
    "../../../../db/postgres/schema.sql", import.meta.url), "utf8"))
  env.AQUILLA_PG = db
})

beforeEach(async () => {
  await db.exec(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
      EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) ||
        ' RESTART IDENTITY CASCADE';
    END LOOP; END $$;`)
})

afterAll(async () => {
  await db.close()
  if (created) await admin.exec(`DROP DATABASE ${name}`)
  await admin.close()
  await pg.close()
})
