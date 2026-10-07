// @vitest-environment node
import { PGlite } from "@electric-sql/pglite"
import { expect, it } from "vitest"
import { finalizeProgressSchema } from "./dev-stack-progress-schema"

it("upgrades both legacy progress checks without losing rows and is repeatable", async () => {
  const pg = new PGlite()
  try {
    await pg.exec(`CREATE TABLE file_section_progress (
      project_id text, file_id text, scope text CHECK (scope IN ('file','section')),
      section_key text, total_count integer CHECK (total_count >= 0),
      CHECK ((scope = 'file' AND section_key = '') OR (scope = 'section' AND section_key <> ''))
    ); INSERT INTO file_section_progress VALUES ('p', 'f', 'section', 'GEN 1', 31);`)
    const insertBook = () => pg.exec("INSERT INTO file_section_progress VALUES ('p', 'f', 'book', 'GEN', 1533)")
    await expect(insertBook()).rejects.toThrow()
    const run = async (sql: string) => { await pg.exec(sql) }
    await finalizeProgressSchema(run)
    await finalizeProgressSchema(run)
    await insertBook()
    expect((await pg.query("SELECT scope, total_count FROM file_section_progress ORDER BY total_count")).rows)
      .toEqual([{ scope: "section", total_count: 31 }, { scope: "book", total_count: 1533 }])
    await expect(pg.exec("INSERT INTO file_section_progress (scope, section_key) VALUES ('book', '')")).rejects.toThrow()
    await expect(pg.exec("INSERT INTO file_section_progress (scope, section_key) VALUES ('file', 'GEN')")).rejects.toThrow()
    await expect(pg.exec("INSERT INTO file_section_progress (scope, section_key, audio_count) VALUES ('book', 'EXO', -1)")).rejects.toThrow()
  } finally {
    await pg.close()
  }
}, 30_000)
