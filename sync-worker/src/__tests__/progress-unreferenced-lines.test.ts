// AQU-1493: lines nobody gave a reference — a line added in the editor carries
// no canonical_ref — on the plan's book rows.
//
// The file's own row always counted them; no book or chapter row did. Six blank
// added lines left a book at 100% and "Nothing left" on the board while the
// file's untranslated count said six (ETEN, 2026-09-29). In a file that holds
// one book they now count toward it; in a file of several they stay in the
// file's row only, and nothing guesses which book they belong to.
import { describe, it, expect } from "vitest"
import { fullProgressRecomputeStmts, sectionsProgressRecomputeStmt } from "../events/progress-projection"
import { readFirstOpenCell } from "../events/progress-read-route"
import { makeTestDb } from "./helpers/pg-test-db"

const P = "proj-a"
const F = "file-1"
const TS = 1_700_000_000_000

interface CellSeed {
  cell_id: string
  side?: string
  canonical_ref?: string | null
  value?: string
  endorsement_count?: number
  start_ms?: number | null
  hidden_at?: number | null
}

function cell(c: CellSeed) {
  return {
    project_id: P,
    file_id: F,
    cell_id: c.cell_id,
    side: c.side ?? "source",
    target_lang: "",
    value: c.value ?? "",
    canonical_ref: c.canonical_ref ?? null,
    endorsement_count: c.endorsement_count ?? 0,
    last_edit_at: TS,
    start_ms: c.start_ms ?? null,
    hidden_at: c.hidden_at ?? null,
    event_id: `ev-${c.cell_id}-${c.side ?? "source"}`,
  }
}

/** A translated, validated verse: source plus its target. */
const done = (id: string, ref: string) => [
  cell({ cell_id: id, canonical_ref: ref }),
  cell({ cell_id: id, side: "target", value: "done", endorsement_count: 1 }),
]

/** A line added in the editor: no reference, nothing translated yet. */
const added = (id: string) => cell({ cell_id: id })

type Db = Parameters<typeof fullProgressRecomputeStmts>[0]

async function recompute(db: Db) {
  for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
}

async function row(db: Db, scope: string, key: string) {
  return db
    .prepare(
      `SELECT total_count, filled_count FROM file_section_progress
        WHERE project_id = ? AND file_id = ? AND scope = ? AND section_key = ? AND target_lang = ''`,
    )
    .bind(P, F, scope, key)
    .first<{ total_count: number; filled_count: number }>()
}

async function keys(db: Db, scope: string) {
  const r = await db
    .prepare(
      `SELECT section_key FROM file_section_progress
        WHERE project_id = ? AND file_id = ? AND scope = ? AND target_lang = ''
        ORDER BY section_key`,
    )
    .bind(P, F, scope)
    .all<{ section_key: string }>()
  return (r.results ?? []).map((x) => x.section_key)
}

describe("lines with no reference on a one-book file (AQU-1493)", () => {
  it("count toward the book, so the book is short exactly where the file is", async () => {
    const { db } = await makeTestDb({
      cells: [...done("g1", "GEN 1:1"), ...done("g2", "GEN 1:2"), added("x1"), added("x2")],
    })
    await recompute(db)

    // The book and the file now agree: four lines, two of them blank.
    expect(await row(db, "file", "")).toEqual({ total_count: 4, filled_count: 2 })
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 4, filled_count: 2 })
    // They have no chapter, and no chapter pretends to hold them.
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 2, filled_count: 2 })
    expect(await keys(db, "section")).toEqual(["GEN 1"])
  })

  it("keep the book current when only the added line changes", async () => {
    // The incremental path recomputes the touched cells' keys. An added line's
    // key used to be '', which matched no book row, so translating it left the
    // book short until the next full rebuild.
    const { db, pg } = await makeTestDb({
      cells: [...done("g1", "GEN 1:1"), added("x1")],
    })
    await recompute(db)
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 2, filled_count: 1 })

    await pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, last_edit_at, event_id)
       VALUES ($1, $2, 'x1', 'target', '', 'translated', $3, 'ev-x1-target')`,
      [P, F, TS],
    )
    await sectionsProgressRecomputeStmt(db, P, F, TS, ["x1"]).run()
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 2, filled_count: 2 })
  })

  it("survive the full rebuild's prune rather than being written and deleted in one batch", async () => {
    const { db } = await makeTestDb({ cells: [...done("g1", "GEN 1:1"), added("x1")] })
    await recompute(db)
    await recompute(db)
    expect(await keys(db, "book")).toEqual(["GEN"])
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 2, filled_count: 1 })
  })

  it("follow the file's one VISIBLE book: a parked other book does not split it", async () => {
    // Parked cells leave progress entirely (AQU-1424), so the book rows are
    // drawn from visible cells; the sole-book answer has to be too, or this
    // file would be told it holds two books and the line would count nowhere.
    const { db } = await makeTestDb({
      cells: [
        ...done("g1", "GEN 1:1"),
        cell({ cell_id: "e1", canonical_ref: "EXO 1:1", hidden_at: TS }),
        added("x1"),
      ],
    })
    await recompute(db)
    expect(await keys(db, "book")).toEqual(["GEN"])
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 2, filled_count: 1 })
  })

  it("leave a parked added line out, as every other parked cell is", async () => {
    const { db } = await makeTestDb({
      cells: [...done("g1", "GEN 1:1"), cell({ cell_id: "x1", hidden_at: TS })],
    })
    await recompute(db)
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 1, filled_count: 1 })
  })
})

describe("lines with no reference on a file of several books (AQU-1493)", () => {
  it("stay in the file's row only — no book is guessed", async () => {
    const { db } = await makeTestDb({
      cells: [...done("g1", "GEN 1:1"), ...done("e1", "EXO 1:1"), added("x1")],
    })
    await recompute(db)
    expect(await row(db, "file", "")).toEqual({ total_count: 3, filled_count: 2 })
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 1, filled_count: 1 })
    expect(await row(db, "book", "EXO")).toEqual({ total_count: 1, filled_count: 1 })
  })
})

describe("files with no books are untouched (AQU-1493)", () => {
  it("still gives a media file time sections and no book rows", async () => {
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "m1", start_ms: 0 }), cell({ cell_id: "m2", start_ms: 400_000 })],
    })
    await recompute(db)
    expect(await keys(db, "book")).toEqual([])
    expect((await keys(db, "section")).length).toBe(2)
  })
})

describe("the plan's 'go to first' link reaches lines with no reference (AQU-1493)", () => {
  const settings = [{ project_id: P, settings: JSON.stringify({ validationCount: 1 }), version: 1 }]
  const files = [{ id: F, project_id: P, name: F, event_id: `fev-${F}` }]

  it("lands on an added line once every referenced verse is done", async () => {
    const { db } = await makeTestDb({
      files, project_settings: settings,
      cells: [...done("g1", "GEN 1:1"), added("x1")],
    })
    expect(await readFirstOpenCell(db, P, F, "GEN", "untranslated", "")).toBe("x1")
  })

  it("still puts the referenced verses first", async () => {
    const { db } = await makeTestDb({
      files, project_settings: settings,
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }), added("x1")],
    })
    expect(await readFirstOpenCell(db, P, F, "GEN", "untranslated", "")).toBe("g1")
  })

  it("does not send a book to a line that belongs to no book", async () => {
    const { db } = await makeTestDb({
      files, project_settings: settings,
      cells: [...done("g1", "GEN 1:1"), ...done("e1", "EXO 1:1"), added("x1")],
    })
    expect(await readFirstOpenCell(db, P, F, "GEN", "untranslated", "")).toBeNull()
    expect(await readFirstOpenCell(db, P, F, "EXO", "untranslated", "")).toBeNull()
  })
})
