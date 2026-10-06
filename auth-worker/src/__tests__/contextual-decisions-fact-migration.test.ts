// AQU-1691 — migration 0142 lets a contextual decision ask for a project fact.
//
// WHY: the decision lifecycle now stores an answer as a durable fact, and a
// fact question has no file and a new readiness item. On a database without
// this migration, raising one fails (CHECK, NOT NULL) and every decision read
// fails (missing columns). The migration must widen exactly what fact
// questions need, keep rejecting a readiness item nobody defined, leave old
// rows untouched, and be safe to re-run, as the migration runner requires.
import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { expect, it } from "vitest"

const MIGRATION = readFileSync(
  new URL("../../../db/postgres/migrations/0142_contextual_decisions_fact_questions.sql", import.meta.url),
  "utf8",
)

/** contextual_decisions as 0076 created it, with the columns this migration touches. */
const PRE_0142 = `CREATE TABLE contextual_decisions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  run_id text,
  file_id text NOT NULL,
  span_id text,
  cell_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  readiness_item text
    CHECK (readiness_item IS NULL OR
           readiness_item IN ('terminology','brief','examples','rules','languages')),
  status text NOT NULL DEFAULT 'open'
);
INSERT INTO contextual_decisions (id, project_id, run_id, file_id, reason, readiness_item)
VALUES ('old', 'p1', 'run-1', 'file-1', 'Two renderings conflict.', 'terminology');`

const insertFactQuestion = (pg: PGlite, id: string) =>
  pg.query(
    `INSERT INTO contextual_decisions (id, project_id, file_id, reason, readiness_item, fact_key, options, fact_scope)
     VALUES ($1, 'p1', NULL, 'Is Andrew older or younger than Peter?', 'bible-fact',
             'kin.andrew-peter.relative-age', $2::jsonb, $3::jsonb)`,
    [id, [{ value: "younger" }, { value: "older" }], { entity: "Andrew" }],
  )

it("accepts a project-wide bible-fact question with its key, options and scope, and re-runs cleanly", async () => {
  const pg = new PGlite()
  try {
    await pg.exec(PRE_0142)
    // Before: a fact question cannot be stored at all.
    await expect(insertFactQuestion(pg, "too-early")).rejects.toThrow()

    await pg.exec(MIGRATION)
    await insertFactQuestion(pg, "fact-1")
    const { rows } = await pg.query<{ id: string; file_id: string | null; fact_key: string | null; options: unknown; fact_scope: unknown }>(
      "SELECT id, file_id, fact_key, options, fact_scope FROM contextual_decisions ORDER BY id",
    )
    expect(rows).toEqual([
      {
        id: "fact-1",
        file_id: null,
        fact_key: "kin.andrew-peter.relative-age",
        options: [{ value: "younger" }, { value: "older" }],
        fact_scope: { entity: "Andrew" },
      },
      // The question raised before the migration is untouched.
      { id: "old", file_id: "file-1", fact_key: null, options: null, fact_scope: null },
    ])

    // The CHECK widened by one value only.
    await expect(
      pg.query(
        "INSERT INTO contextual_decisions (id, project_id, file_id, reason, readiness_item) VALUES ('bad', 'p1', 'f', 'x', 'facts')",
      ),
    ).rejects.toThrow(/readiness_item_check/)

    // Re-running is a no-op, as the migration runner requires.
    await pg.exec(MIGRATION)
    await insertFactQuestion(pg, "fact-2")
    expect((await pg.query("SELECT id FROM contextual_decisions")).rows).toHaveLength(3)
  } finally {
    await pg.close()
  }
})
