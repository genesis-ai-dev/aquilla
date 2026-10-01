// AQU-1493: lines nobody gave a reference — a line added in the editor carries
// no canonical_ref — on the plan's chapter and book rows.
//
// The file's own row always counted them; no book or chapter row did. Six blank
// added lines left a book at 100% and "Nothing left" on the board while the
// file's untranslated count said six (ETEN, 2026-09-29). Sam's rule
// (2026-10-01): such a line belongs to the chapter of the line ABOVE it in the
// file — however many are stacked in a row — and a line at the top of a file to
// the front matter of its first book. Projection-time only; no cell is written.
//
// "Above" is the anchor chain, which is the editor's own order. Each fixture
// below chains its cells explicitly, head first.
import { describe, it, expect } from "vitest"
import {
  fullProgressRecomputeStmts,
  sectionsProgressRecomputeStmt,
  UNREFERENCED_LINES_STALE_FILES_SQL,
} from "../events/progress-projection"
import {
  handleProgressReadRequest,
  readFirstOpenCell,
  type SectionProgressDetailResponse,
} from "../events/progress-read-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const P = "proj-a"
const F = "file-1"
const TS = 1_700_000_000_000
const SECRET = "progress-secret"

interface Line {
  id: string
  /** The verse reference; omitted for a line added by hand. */
  ref?: string
  /** Translated (and validated once) when true. */
  done?: boolean
  hidden?: boolean
  startMs?: number
}

/**
 * A file as the editor shows it, top to bottom: each line anchored on the one
 * before it, the first on nothing. Returns source rows plus a target row for
 * every line marked done.
 */
function chain(lines: Line[]) {
  const rows: object[] = []
  lines.forEach((l, i) => {
    rows.push({
      project_id: P, file_id: F, cell_id: l.id, side: "source", target_lang: "",
      value: `source ${l.id}`, canonical_ref: l.ref ?? null,
      anchor_cell_id: i === 0 ? null : lines[i - 1].id,
      start_ms: l.startMs ?? null, hidden_at: l.hidden ? TS : null,
      last_edit_at: TS, event_id: `ev-${l.id}`,
    })
    if (l.done) {
      rows.push({
        project_id: P, file_id: F, cell_id: l.id, side: "target", target_lang: "",
        value: "done", endorsement_count: 1, last_edit_at: TS, event_id: `tev-${l.id}`,
      })
    }
  })
  return rows
}

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

/** Jonah 1–2 with two lines added by hand below 2:1. */
const JONAH = [
  { id: "j11", ref: "JON 1:1", done: true },
  { id: "j12", ref: "JON 1:2", done: true },
  { id: "j21", ref: "JON 2:1", done: true },
  { id: "x1" },
  { id: "x2" },
  { id: "j22", ref: "JON 2:2", done: true },
]

describe("a line with no reference counts in the chapter of the line above it (AQU-1493)", () => {
  it("takes the chapter above it, two added lines in a row included", async () => {
    const { db } = await makeTestDb({ cells: chain(JONAH) })
    await recompute(db)

    // Chapter 2 now holds 2:1, both added lines and 2:2 — two of them blank.
    expect(await row(db, "section", "JON 2")).toEqual({ total_count: 4, filled_count: 2 })
    expect(await row(db, "section", "JON 1")).toEqual({ total_count: 2, filled_count: 2 })
    expect(await row(db, "book", "JON")).toEqual({ total_count: 6, filled_count: 4 })
    // Every line is in some chapter: the file and its chapters agree.
    expect(await row(db, "file", "")).toEqual({ total_count: 6, filled_count: 4 })
  })

  it("puts a line at the top of the file in its first book's front matter", async () => {
    const { db } = await makeTestDb({
      cells: chain([{ id: "t1" }, { id: "t2" }, ...JONAH.filter((l) => l.ref)]),
    })
    await recompute(db)
    // A bare book code is the section key USFM front matter already uses; the
    // board draws it on the "front matter" tile beside the numbered chapters.
    expect(await row(db, "section", "JON")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await keys(db, "section")).toEqual(["JON", "JON 1", "JON 2"])
    expect(await row(db, "book", "JON")).toEqual({ total_count: 6, filled_count: 4 })
  })

  it("follows the line above across books in a file of several", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "g1", ref: "GEN 1:1", done: true }, { id: "xg" },
        { id: "e1", ref: "EXO 1:1", done: true }, { id: "xe" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 2, filled_count: 1 })
    expect(await row(db, "section", "EXO 1")).toEqual({ total_count: 2, filled_count: 1 })
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 2, filled_count: 1 })
    expect(await row(db, "book", "EXO")).toEqual({ total_count: 2, filled_count: 1 })
  })

  it("moves with the chain when the referenced line above is removed", async () => {
    // Removing 2:1 re-anchors the line below it onto 1:2 (the editor sends
    // that reorder with the delete), so the run now hangs below chapter 1.
    const { db, pg } = await makeTestDb({ cells: chain(JONAH) })
    await recompute(db)
    await pg.query(`DELETE FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = 'j21'`, [P, F])
    await pg.query(
      `UPDATE cells SET anchor_cell_id = 'j12' WHERE project_id = $1 AND file_id = $2 AND cell_id = 'x1'`,
      [P, F],
    )
    await recompute(db)
    expect(await row(db, "section", "JON 1")).toEqual({ total_count: 4, filled_count: 2 })
    expect(await row(db, "section", "JON 2")).toEqual({ total_count: 1, filled_count: 1 })
  })

  it("keeps a chapter current on the incremental path when only an added line changes", async () => {
    const { db, pg } = await makeTestDb({ cells: chain(JONAH) })
    await recompute(db)
    await pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, last_edit_at, event_id)
       VALUES ($1, $2, 'x2', 'target', '', 'translated', $3, 'tev-x2')`,
      [P, F, TS],
    )
    await sectionsProgressRecomputeStmt(db, P, F, TS, ["x2"]).run()
    expect(await row(db, "section", "JON 2")).toEqual({ total_count: 4, filled_count: 3 })
    expect(await row(db, "book", "JON")).toEqual({ total_count: 6, filled_count: 5 })
  })

  it("passes a chapter through a parked line, and keeps a chapter only an added line is left in", async () => {
    // 2:1 is parked: it leaves progress, but it is still the line above x1. Its
    // chapter's only visible cells are the added lines and 2:2 is gone too, so
    // the prune must keep a row the insert wrote for inherited lines alone.
    const { db } = await makeTestDb({
      cells: chain([
        { id: "j11", ref: "JON 1:1", done: true },
        { id: "j21", ref: "JON 2:1", hidden: true },
        { id: "x1" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "JON 2")).toEqual({ total_count: 1, filled_count: 0 })
    expect(await keys(db, "section")).toEqual(["JON 1", "JON 2"])
  })

  it("leaves a media file alone: time buckets, no book rows", async () => {
    const { db } = await makeTestDb({
      cells: chain([{ id: "m1", startMs: 0 }, { id: "m2", startMs: 400_000 }]),
    })
    await recompute(db)
    expect(await keys(db, "book")).toEqual([])
    expect((await keys(db, "section")).every((k) => k.startsWith("t:"))).toBe(true)
  })
})

describe("the backfill's --unreferenced-lines selector (AQU-1493)", () => {
  async function selected(db: Db) {
    const r = await db.prepare(UNREFERENCED_LINES_STALE_FILES_SQL).all<{ project_id: string; id: string }>()
    return (r.results ?? []).map((x) => x.id)
  }

  it("selects a file whose chapters miss lines, and nothing once it is re-projected", async () => {
    const { db, pg } = await makeTestDb({ cells: chain(JONAH) })
    await recompute(db)
    // What the projection before this change left behind: the added lines in
    // the file's row and in no chapter.
    await pg.query(
      `UPDATE file_section_progress SET total_count = 2
        WHERE project_id = $1 AND file_id = $2 AND scope = 'section' AND section_key = 'JON 2'`,
      [P, F],
    )
    expect(await selected(db)).toEqual([F])
    await recompute(db)
    expect(await selected(db)).toEqual([])
  })
})

describe("the plan's readers walk an added line where it sits (AQU-1493)", () => {
  const settings = [{ project_id: P, settings: JSON.stringify({ validationCount: 1 }), version: 1 }]
  const files = [{ id: F, project_id: P, name: F, event_id: `fev-${F}` }]

  it("sends 'go to first untranslated' to the added line before the verse below it", async () => {
    const lines = JONAH.map((l) => (l.id === "j22" ? { ...l, done: false } : l))
    const { db } = await makeTestDb({ files, project_settings: settings, cells: chain(lines) })
    expect(await readFirstOpenCell(db, P, F, "JON", "untranslated", "")).toBe("x1")
  })

  it("lists the chapter's added lines in file order, marked unnumbered", async () => {
    const { db } = await makeTestDb({ files, project_settings: settings, cells: chain(JONAH) })
    await recompute(db)
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const url = `https://worker/api/v1/projects/${P}/files/${F}/progress/sections/${encodeURIComponent("JON 2")}`
    const res = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    const body = await res.json() as SectionProgressDetailResponse
    expect(body.verses.map((v) => [v.cellId, v.ref, v.unnumbered ?? false])).toEqual([
      ["j21", "JON 2:1", false],
      ["x1", "", true],
      ["x2", "", true],
      ["j22", "JON 2:2", false],
    ])
  })
})
