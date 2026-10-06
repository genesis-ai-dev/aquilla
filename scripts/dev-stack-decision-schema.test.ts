// AQU-1691: a local container created before migration 0142 must accept fact
// questions after `pnpm dev` reconciles it. The generic reconciler adds the new
// columns but cannot widen a CHECK or drop NOT NULL, so without this step every
// fact question 500s locally while tests (fresh schema) stay green.
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, expect, it } from "vitest"
import { finalizeDecisionSchema } from "./dev-stack-decision-schema"
import type { PgSchemaClient } from "./dev-stack-artifact-schema"

let pg: PGlite

beforeEach(async () => {
  pg = new PGlite()
  await pg.exec(`CREATE TABLE contextual_decisions (
    id text PRIMARY KEY,
    file_id text NOT NULL,
    readiness_item text
      CHECK (readiness_item IS NULL OR
             readiness_item IN ('terminology','brief','examples','rules','languages'))
  )`)
}, 30_000)

afterEach(async () => {
  await pg.close()
})

const client: PgSchemaClient = {
  query: async (sql, values) => ({ rows: (await pg.query<Record<string, unknown>>(sql, values ?? [])).rows }),
}
const run = async (sql: string) => {
  await pg.exec(sql)
}

it("widens readiness_item and drops file_id NOT NULL once, then leaves the table alone", async () => {
  expect(await finalizeDecisionSchema(client, run)).toEqual([
    "widened contextual_decisions.readiness_item for bible-fact",
    "made contextual_decisions.file_id nullable",
  ])
  await pg.exec("INSERT INTO contextual_decisions (id, file_id, readiness_item) VALUES ('q', NULL, 'bible-fact')")
  expect(await finalizeDecisionSchema(client, run)).toEqual([])
})

it("does nothing on a database without the table", async () => {
  await pg.exec("DROP TABLE contextual_decisions")
  expect(await finalizeDecisionSchema(client, run)).toEqual([])
})
