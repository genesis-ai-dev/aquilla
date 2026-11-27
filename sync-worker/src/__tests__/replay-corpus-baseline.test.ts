// The migration gate's "old code, new schema" leg (risk-label.yml
// `migration-gate`, docs/RELEASE-RISK-GATES.md): the base commit's replay
// harness runs on the PR's schema.sql and is compared with the base commit's
// golden. The harness hashes whole rows, so a column the PR adds changed
// every hash of that table with no row content changing, and the leg failed
// for exactly the migration the gate's first leg calls additive (seen on
// AQU-2664: five nullable columns on cell_audio, NULL on every row, red in
// every corpus with audio).
//
// With the base commit's column list (REPLAY_BASELINE_SCHEMA) the harness
// hashes only what the base commit's code can know about. These tests pin
// both directions on the committed synthetic corpus: what the leg now lets
// through, and that everything it existed to catch is still caught.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import {
  OUTPUT_TABLES,
  corpusProjectId,
  diffDigest,
  loadCorpus,
  readGolden,
  readManifest,
  replayCorpus,
  schemaColumns,
  type CorpusRows,
  type ProjectDigest,
  type SchemaColumns,
} from "./helpers/replay-corpus"

const SCHEMA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/postgres/schema.sql")
const SLUG = "synthetic-genesis"

// Columns of the kinds the additive leg allows (scripts/gate-migration.ts):
// nullable, and NOT NULL with a constant default. On tables the synthetic
// log projects rows into, so a hash that included them would change.
const ADDITIVE = `
  ALTER TABLE comments ADD COLUMN probe_nullable REAL;
  ALTER TABLE cells ADD COLUMN probe_nullable TEXT;
  ALTER TABLE cells ADD COLUMN probe_defaulted INTEGER NOT NULL DEFAULT 7;
`

describe("replay corpus: baseline columns (migration gate, old code on new schema)", () => {
  let corpus: CorpusRows
  let projectId: string
  let golden: ProjectDigest
  let baselineColumns: SchemaColumns

  beforeAll(async () => {
    const entry = readManifest().projects.find((project) => project.slug === SLUG)
    if (!entry) throw new Error(`${SLUG} is not in the manifest`)
    corpus = loadCorpus(entry)
    projectId = corpusProjectId(corpus)
    golden = readGolden()[SLUG]
    baselineColumns = await schemaColumns(readFileSync(SCHEMA_FILE, "utf8"))
  })

  it("reads the columns of every projection table off the schema", () => {
    expect(Object.keys(baselineColumns).sort()).toEqual([...OUTPUT_TABLES].sort())
    // Declared in CREATE TABLE, and volatile ones included: what is dropped
    // from the hash is canonicalRows' business, not the column list's.
    expect(baselineColumns.comments).toEqual(expect.arrayContaining(["comment_id", "body", "updated_at"]))
  })

  it("the tables these tests lean on have rows, so an unchanged hash means something", () => {
    expect(golden.cells.rows).toBeGreaterThan(0)
    expect(golden.comments.rows).toBeGreaterThan(0)
    expect(golden.cell_validators.rows).toBeGreaterThan(0)
  })

  it("on an unchanged schema, the baseline digest is the golden, byte for byte", async () => {
    const result = await replayCorpus(projectId, corpus, { baselineColumns })
    expect(result.digest).toEqual(golden)
    expect(result.ignoredColumns).toEqual([])
  })

  it("without a baseline every column is hashed: an added column changes the hash with no row changing", async () => {
    // The replay gate's own behaviour, and the reason for the baseline: the
    // PR's golden is written from the PR's schema, so there this is a golden
    // diff a person reviews.
    const result = await replayCorpus(projectId, corpus, { migration: ADDITIVE })
    expect(diffDigest(golden, result.digest)).toEqual([
      `cells: rows ${golden.cells.rows} -> ${golden.cells.rows}, hash changed`,
      `comments: rows ${golden.comments.rows} -> ${golden.comments.rows}, hash changed`,
    ])
  })

  it("with the baseline, added nullable and defaulted columns pass and are named", async () => {
    const result = await replayCorpus(projectId, corpus, { baselineColumns, migration: ADDITIVE })
    expect(result.digest).toEqual(golden)
    expect(result.ignoredColumns).toEqual(["cells.probe_defaulted", "cells.probe_nullable", "comments.probe_nullable"])
  })

  it("with the baseline, a changed value in an existing column still fails", async () => {
    // New columns alongside, so the pass above cannot be hiding this.
    const result = await replayCorpus(projectId, corpus, {
      baselineColumns,
      migration: `${ADDITIVE}
        CREATE FUNCTION probe_shout() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.body := upper(NEW.body); RETURN NEW; END $$;
        CREATE TRIGGER probe_shout BEFORE INSERT OR UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION probe_shout();`,
    })
    expect(diffDigest(golden, result.digest)).toEqual([
      `comments: rows ${golden.comments.rows} -> ${golden.comments.rows}, hash changed`,
    ])
  })

  it("with the baseline, a changed row count still fails", async () => {
    const result = await replayCorpus(projectId, corpus, {
      baselineColumns,
      migration: `
        CREATE FUNCTION probe_swallow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
        CREATE TRIGGER probe_swallow BEFORE INSERT ON cell_validators FOR EACH ROW EXECUTE FUNCTION probe_swallow();`,
    })
    // The lost sign-offs show in the tables derived from them too (cells,
    // progress); the count is the line this test is about.
    expect(diffDigest(golden, result.digest)).toContain(`cell_validators: rows ${golden.cell_validators.rows} -> 0, hash changed`)
  })

  it("with the baseline, a removed column fails by name, even on a table with no rows", async () => {
    // concepts is empty in the synthetic log: the rebuild never writes the
    // column and a hash of zero rows could not see it go.
    expect(golden.concepts.rows).toBe(0)
    await expect(
      replayCorpus(projectId, corpus, { baselineColumns, migration: `ALTER TABLE concepts DROP COLUMN notes;` }),
    ).rejects.toThrow(/concepts: the baseline schema has notes and the new schema does not/)
  })

  it("with the baseline, a renamed column fails the same way", async () => {
    await expect(
      replayCorpus(projectId, corpus, { baselineColumns, migration: `ALTER TABLE concepts RENAME COLUMN notes TO remarks;` }),
    ).rejects.toThrow(/concepts: the baseline schema has notes and the new schema does not/)
  })

  it("a projection table the baseline schema does not have is an error, not a pass", async () => {
    const withoutComments = Object.fromEntries(Object.entries(baselineColumns).filter(([table]) => table !== "comments"))
    await expect(replayCorpus(projectId, corpus, { baselineColumns: withoutComments })).rejects.toThrow(
      /comments: the baseline schema has no such table/,
    )
  })
})
