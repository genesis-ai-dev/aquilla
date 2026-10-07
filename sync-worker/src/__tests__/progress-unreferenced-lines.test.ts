// AQU-1493: lines nobody gave a reference — a line added in the editor carries
// no canonical_ref — on the plan's chapter and book rows.
//
// The file's own row always counted them; no book or chapter row did. Six blank
// added lines left a book at 100% and "Nothing left" on the board while the
// file's untranslated count said six (ETEN, 2026-09-29). Sam's rule
// (2026-10-01): such a line belongs to the chapter of the line ABOVE it in the
// file — however many are stacked in a row — and a line at the top of a file to
// the front matter of its first book. Projection-time only; no cell is written.
// Extended for headings (lead, 2026-10-02): a heading or title with no
// reference counts with the verse BELOW it — the one it introduces — and so do
// the lines under it, up to that verse.
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
import { INTRODUCING_CELL_TYPES } from "../../../db/shared/plan-keys"
import { STRUCTURAL_CELL_TYPES } from "../events/structural-cells"
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
  /** Deleted upstream from a live link: kept for review, not counted. */
  tombstoned?: boolean
  startMs?: number
  /** The source row's cell type: 'heading' for a heading or title. */
  type?: string
}

/**
 * A file as the editor shows it, top to bottom: each line anchored on the one
 * before it, the first on nothing. Returns source rows plus a target row for
 * every line marked done.
 */
function chain(lines: Line[], file = F) {
  const rows: object[] = []
  lines.forEach((l, i) => {
    rows.push({
      project_id: P, file_id: file, cell_id: l.id, side: "source", target_lang: "",
      value: `source ${l.id}`, canonical_ref: l.ref ?? null, type: l.type ?? null,
      anchor_cell_id: i === 0 ? null : lines[i - 1].id,
      start_ms: l.startMs ?? null, hidden_at: l.hidden ? TS : null,
      tombstoned_at: l.tombstoned ? TS : null,
      last_edit_at: TS, event_id: `ev-${l.id}`,
    })
    if (l.done) {
      rows.push({
        project_id: P, file_id: file, cell_id: l.id, side: "target", target_lang: "",
        value: "done", endorsement_count: 1, last_edit_at: TS, event_id: `tev-${l.id}`,
      })
    }
  })
  return rows
}

type Db = Parameters<typeof fullProgressRecomputeStmts>[0]

async function recompute(db: Db, file = F) {
  for (const stmt of fullProgressRecomputeStmts(db, P, file, TS)) await stmt.run()
}

/**
 * The lane these assertions are about.
 *
 * AQU-1599 writes one progress row per lane, and the source lane's
 * `target_lang` is '' too (its `legacy_tag` is NULL). A bare
 * `target_lang = ''` therefore matches both, and `.first()` returns
 * whichever the engine lists first — the source row, whose `filled_count`
 * is 0 because it joins no translations. Prefer the target lane, where the
 * fills live, and fall back to the source lane for a fixture that has no
 * target lane yet. Both lanes count the same chapters, so the totals agree.
 */
async function row(db: Db, scope: string, key: string) {
  return db
    .prepare(
      `SELECT p.total_count, p.filled_count
         FROM file_section_progress p
         JOIN lanes l ON l.project_id = p.project_id AND l.id = p.lane_id
        WHERE p.project_id = ? AND p.file_id = ? AND p.scope = ? AND p.section_key = ?
        ORDER BY (l.role = 'target') DESC, l.id
        LIMIT 1`,
    )
    .bind(P, F, scope, key)
    .first<{ total_count: number; filled_count: number }>()
}

async function keys(db: Db, scope: string) {
  const r = await db
    .prepare(
      `SELECT DISTINCT section_key FROM file_section_progress
        WHERE project_id = ? AND file_id = ? AND scope = ?
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

/**
 * Genesis 1–2 as an imported Bible prints it, plus two lines added by hand:
 * "The Creation" at the very top, "The Seventh Day" right before 2:1, x1 added
 * after 1:2 (above that heading) and x2 added right under it.
 */
const GENESIS = [
  { id: "h1", type: "heading" },
  { id: "g11", ref: "GEN 1:1", done: true },
  { id: "g12", ref: "GEN 1:2" },
  { id: "x1" },
  { id: "h2", type: "heading" },
  { id: "x2" },
  { id: "g21", ref: "GEN 2:1", done: true },
  { id: "g22", ref: "GEN 2:2" },
]

describe("a heading counts with the verse below it (AQU-1493)", () => {
  it("puts a chapter's opening heading, and the lines under it, in that chapter", async () => {
    const { db } = await makeTestDb({ cells: chain(GENESIS) })
    await recompute(db)
    // "The Creation" counts in chapter 1, not on a front-matter tile; x1, added
    // above "The Seventh Day", keeps the chapter above it.
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 4, filled_count: 1 })
    // "The Seventh Day" and the line added under it count in chapter 2.
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 4, filled_count: 1 })
    expect(await keys(db, "section")).toEqual(["GEN 1", "GEN 2"])
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 8, filled_count: 2 })
  })

  it("gives stacked headings to the verse below them all", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "g11", ref: "GEN 1:1" },
        { id: "major", type: "heading" },
        { id: "minor", type: "heading" },
        { id: "g21", ref: "GEN 2:1" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 1, filled_count: 0 })
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 3, filled_count: 0 })
  })

  it("treats paratext with no reference like a heading", async () => {
    const { db } = await makeTestDb({
      cells: chain([{ id: "g11", ref: "GEN 1:1" }, { id: "p", type: "paratext" }, { id: "g21", ref: "GEN 2:1" }]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 2, filled_count: 0 })
  })

  // Decision 2026-10-02: a book's title, header, TOC and introduction are the
  // BOOK's front matter, as USFM has it and as the lossless importer keys them
  // ("GEN:mt1:1"). The plain USFM importer gives "\mt1 Genesis" no reference;
  // it must not land in chapter 1 because of which importer was used.
  it("keeps a book's title at the top of the file in front matter, and its first heading in chapter 1", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "mt", type: "paratext" },
        { id: "toc", type: "paratext" },
        { id: "h1", type: "heading" },
        { id: "g11", ref: "GEN 1:1" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 4, filled_count: 0 })
  })

  it("puts the next book's title on that book's front matter in a file of several", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "g50", ref: "GEN 50:26" },
        { id: "xAdded" },
        { id: "mtExo", type: "paratext" },
        { id: "hExo", type: "heading" },
        { id: "e11", ref: "EXO 1:1" },
      ]),
    })
    await recompute(db)
    // The line added under 50:26 stays with it; the title opens Exodus.
    expect(await row(db, "section", "GEN 50")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await row(db, "section", "EXO")).toEqual({ total_count: 1, filled_count: 0 })
    expect(await row(db, "section", "EXO 1")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await row(db, "book", "EXO")).toEqual({ total_count: 3, filled_count: 0 })
  })

  it("lets paratext under a book's first heading follow the heading", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "h1", type: "heading" },
        { id: "r", type: "paratext" },
        { id: "g11", ref: "GEN 1:1" },
      ]),
    })
    await recompute(db)
    expect(await keys(db, "section")).toEqual(["GEN 1"])
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 3, filled_count: 0 })
  })

  it("falls back to the line above for a heading with no verse below it", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "g11", ref: "GEN 1:1" }, { id: "g12", ref: "GEN 1:2" },
        { id: "hEnd", type: "heading" }, { id: "xEnd" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 4, filled_count: 0 })
    expect(await keys(db, "section")).toEqual(["GEN 1"])
  })

  it("moves a book's opening heading into that book in a file of several", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "g50", ref: "GEN 50:26", done: true },
        { id: "hExo", type: "heading" },
        { id: "e11", ref: "EXO 1:1", done: true },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 50")).toEqual({ total_count: 1, filled_count: 1 })
    expect(await row(db, "section", "EXO 1")).toEqual({ total_count: 2, filled_count: 1 })
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 1, filled_count: 1 })
    expect(await row(db, "book", "EXO")).toEqual({ total_count: 2, filled_count: 1 })
  })

  it("keeps a line added above the top heading in front matter", async () => {
    const { db } = await makeTestDb({
      cells: chain([{ id: "xt" }, { id: "ht", type: "heading" }, { id: "j11", ref: "JON 1:1" }]),
    })
    await recompute(db)
    expect(await row(db, "section", "JON")).toEqual({ total_count: 1, filled_count: 0 })
    expect(await row(db, "section", "JON 1")).toEqual({ total_count: 2, filled_count: 0 })
  })

  it("is anchored by a parked or upstream-deleted verse, and a parked heading still passes its chapter on", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "g11", ref: "GEN 1:1" },
        { id: "h2", type: "heading" },
        { id: "g21", ref: "GEN 2:1", hidden: true },
        { id: "h3", type: "heading", hidden: true },
        { id: "x3" },
        { id: "g31", ref: "GEN 3:1", tombstoned: true },
        { id: "h4", type: "heading" },
        { id: "g41", ref: "GEN 4:1", tombstoned: true },
        { id: "g42", ref: "GEN 4:2" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 1, filled_count: 0 })
    // h2 counts in chapter 2 though 2:1 itself is parked.
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 1, filled_count: 0 })
    // h3 is parked and out of the counts; x3 under it still goes with 3:1,
    // which is not counted either (deleted upstream) but still anchors.
    expect(await row(db, "section", "GEN 3")).toEqual({ total_count: 1, filled_count: 0 })
    expect(await row(db, "section", "GEN 4")).toEqual({ total_count: 2, filled_count: 0 })
  })

  it("keeps a heading's own reference when it has one", async () => {
    const { db } = await makeTestDb({
      cells: chain([
        { id: "g11", ref: "GEN 1:1" },
        { id: "s1", ref: "GEN 1:s1:1", type: "heading" },
        { id: "g21", ref: "GEN 2:1" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 1, filled_count: 0 })
  })

  it("sends a heading whose anchor dangles to front matter", async () => {
    const cells = chain([{ id: "g11", ref: "GEN 1:1" }, { id: "g21", ref: "GEN 2:1" }])
    cells.push({
      project_id: P, file_id: F, cell_id: "lost", side: "source", target_lang: "",
      value: "lost", canonical_ref: null, type: "heading", anchor_cell_id: "gone",
      last_edit_at: TS, event_id: "ev-lost",
    })
    const { db } = await makeTestDb({ cells })
    await recompute(db)
    expect(await row(db, "section", "GEN")).toEqual({ total_count: 1, filled_count: 0 })
  })

  it("counts each line once where the chain branches", async () => {
    // Two lines anchored on 1:1: a heading leading to 2:1, and an added line.
    const cells = chain([{ id: "g11", ref: "GEN 1:1" }, { id: "h2", type: "heading" }, { id: "g21", ref: "GEN 2:1" }])
    cells.push({
      project_id: P, file_id: F, cell_id: "xb", side: "source", target_lang: "",
      value: "xb", canonical_ref: null, anchor_cell_id: "g11", last_edit_at: TS, event_id: "ev-xb",
    })
    const { db } = await makeTestDb({ cells })
    await recompute(db)
    expect(await row(db, "section", "GEN 1")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 2, filled_count: 0 })
    expect(await row(db, "file", "")).toEqual({ total_count: 4, filled_count: 0 })
  })

  it("updates the chapter and book below on the incremental path when a heading is translated", async () => {
    const { db, pg } = await makeTestDb({
      cells: chain([
        { id: "g50", ref: "GEN 50:26", done: true },
        { id: "hExo", type: "heading" },
        { id: "e11", ref: "EXO 1:1", done: true },
      ]),
    })
    await recompute(db)
    await pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, last_edit_at, event_id)
       VALUES ($1, $2, 'hExo', 'target', '', 'translated', $3, 'tev-hExo')`,
      [P, F, TS],
    )
    await sectionsProgressRecomputeStmt(db, P, F, TS, ["hExo"]).run()
    expect(await row(db, "section", "EXO 1")).toEqual({ total_count: 2, filled_count: 2 })
    expect(await row(db, "book", "EXO")).toEqual({ total_count: 2, filled_count: 2 })
    expect(await row(db, "book", "GEN")).toEqual({ total_count: 1, filled_count: 1 })
  })

  it("re-keys a heading when the verse below it is removed", async () => {
    const { db, pg } = await makeTestDb({
      cells: chain([
        { id: "g11", ref: "GEN 1:1" }, { id: "h2", type: "heading" }, { id: "g21", ref: "GEN 2:1" },
        { id: "h3", type: "heading" }, { id: "g31", ref: "GEN 3:1" },
      ]),
    })
    await recompute(db)
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 2, filled_count: 0 })
    // Removing 2:1 re-anchors h3 onto h2: both headings now introduce 3:1.
    await pg.query(`DELETE FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = 'g21'`, [P, F])
    await pg.query(
      `UPDATE cells SET anchor_cell_id = 'h2' WHERE project_id = $1 AND file_id = $2 AND cell_id = 'h3'`,
      [P, F],
    )
    await recompute(db)
    expect(await row(db, "section", "GEN 3")).toEqual({ total_count: 3, filled_count: 0 })
    expect(await keys(db, "section")).toEqual(["GEN 1", "GEN 3"])
  })

  it("knows a heading by the same types the structural policy does", () => {
    expect([...INTRODUCING_CELL_TYPES]).toEqual([...STRUCTURAL_CELL_TYPES])
  })
})

describe("the backfill's --unreferenced-lines selector (AQU-1493)", () => {
  async function selected(db: Db) {
    const r = await db.prepare(UNREFERENCED_LINES_STALE_FILES_SQL).all<{ project_id: string; id: string }>()
    return (r.results ?? []).map((x) => x.id)
  }

  it("selects a file projected before line placements were stored, and nothing once it is re-projected", async () => {
    const { db, pg } = await makeTestDb({ cells: chain(JONAH) })
    await recompute(db)
    // Production before AQU-1493, and this branch's earlier builds: progress
    // rows, but no stored placement for any line with no reference.
    await pg.query(`DELETE FROM cell_plan_keys WHERE project_id = $1 AND file_id = $2`, [P, F])
    expect(await selected(db)).toEqual([F])
    await recompute(db)
    expect(await selected(db)).toEqual([])
  })

  it("selects a file whose stored placements an older rule wrote", async () => {
    const { db, pg } = await makeTestDb({ cells: chain(GENESIS) })
    await recompute(db)
    // The first AQU-1493 rule: "The Seventh Day" with the line above it, in
    // chapter 1. Its row exists; only its answer is out of date.
    await pg.query(
      `UPDATE cell_plan_keys SET section_key = 'GEN 1', place_ref = 'GEN 1:31', depth = 1
        WHERE project_id = $1 AND file_id = $2 AND cell_id = 'h2'`,
      [P, F],
    )
    expect(await selected(db)).toEqual([F])
    await recompute(db)
    expect(await selected(db)).toEqual([])
  })

  it("selects a file holding a placement for a line the walk no longer places", async () => {
    const { db, pg } = await makeTestDb({ cells: chain(GENESIS) })
    await recompute(db)
    await pg.query(
      `INSERT INTO cell_plan_keys (project_id, file_id, cell_id, section_key) VALUES ($1, $2, 'gone', 'GEN 1')`,
      [P, F],
    )
    expect(await selected(db)).toEqual([F])
    await recompute(db)
    expect(await selected(db)).toEqual([])
  })

  it("never selects a freshly projected file, whatever it holds", async () => {
    const F2 = "file-2"
    const { db } = await makeTestDb({
      cells: [
        ...chain([
          ...GENESIS,
          { id: "hp", type: "heading", hidden: true },
          { id: "xp", hidden: true },
          { id: "g31", ref: "GEN 3:1", tombstoned: true },
          { id: "x3" },
          { id: "m", startMs: 1_000 },
        ]),
        // A second file in the same project with no line lacking a reference.
        ...chain([{ id: "e11", ref: "EXO 1:1" }, { id: "e12", ref: "EXO 1:2" }], F2),
      ],
    })
    await recompute(db)
    await recompute(db, F2)
    expect(await selected(db)).toEqual([])
  })

  it("picks out only the stale file of several", async () => {
    const F2 = "file-2"
    const { db, pg } = await makeTestDb({
      cells: [...chain(GENESIS), ...chain([{ id: "e11", ref: "EXO 1:1" }, { id: "hx", type: "heading" }, { id: "e21", ref: "EXO 2:1" }], F2)],
    })
    await recompute(db)
    await recompute(db, F2)
    await pg.query(`DELETE FROM cell_plan_keys WHERE project_id = $1 AND file_id = $2`, [P, F2])
    expect(await selected(db)).toEqual([F2])
  })

  it("runs inside the backfill's UNION, which needs it parenthesised", async () => {
    const { db } = await makeTestDb({ cells: chain(GENESIS) })
    await recompute(db)
    // scripts/neon-backfill-progress.ts --missing-books --unreferenced-lines.
    const r = await db
      .prepare(`SELECT 'p' AS project_id, 'f' AS id WHERE false
                UNION (${UNREFERENCED_LINES_STALE_FILES_SQL})
                ORDER BY 1, 2`)
      .all<{ project_id: string; id: string }>()
    expect(r.results ?? []).toEqual([])
  })
})

describe("the plan's readers walk an added line where it sits (AQU-1493)", () => {
  const settings = [{ project_id: P, settings: JSON.stringify({ validationCount: 1 }), version: 1 }]
  const files = [{ id: F, project_id: P, name: F, event_id: `fev-${F}` }]

  async function verses(db: Db, sectionKey: string) {
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const url = `https://worker/api/v1/projects/${P}/files/${F}/progress/sections/${encodeURIComponent(sectionKey)}`
    const res = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    return (await res.json() as SectionProgressDetailResponse).verses.map((v) => v.cellId)
  }

  /** A project that does not count headings: the policy is read from `projects`. */
  const noHeadings = {
    organizations: [{ id: 1, name: "Org", owner_user_id: 1 }],
    projects: [{ id: P, name: "Plan", org_id: 1 }],
    org_settings: [{ org_id: 1, settings: "{}", version: 1 }],
    project_settings: [{
      project_id: P, settings: JSON.stringify({ validationCount: 1, countStructuralCells: false }), version: 1,
    }],
  }

  it("lists a heading right before the verse it introduces, and an added line where it sits", async () => {
    const { db } = await makeTestDb({ files, project_settings: settings, cells: chain(GENESIS) })
    await recompute(db)
    expect(await verses(db, "GEN 1")).toEqual(["h1", "g11", "g12", "x1"])
    expect(await verses(db, "GEN 2")).toEqual(["h2", "x2", "g21", "g22"])
  })

  it("sends 'go to first untranslated' to a book's top heading, or past it when headings do not count", async () => {
    const { db } = await makeTestDb({ files, project_settings: settings, cells: chain(GENESIS) })
    await recompute(db)
    expect(await readFirstOpenCell(db, P, F, "GEN", "untranslated", "")).toBe("h1")
    const off = await makeTestDb({ files, ...noHeadings, cells: chain(GENESIS) })
    await recompute(off.db)
    expect(await readFirstOpenCell(off.db, P, F, "GEN", "untranslated", "")).toBe("g12")
  })

  it("keeps a line under an uncounted heading in the heading's chapter", async () => {
    const { db } = await makeTestDb({ files, ...noHeadings, cells: chain(GENESIS) })
    await recompute(db)
    expect(await verses(db, "GEN 2")).toEqual(["x2", "g21", "g22"])
    expect(await verses(db, "GEN 1")).toEqual(["g11", "g12", "x1"])
  })

  it("sends 'go to first untranslated' to the added line before the verse below it", async () => {
    const lines = JONAH.map((l) => (l.id === "j22" ? { ...l, done: false } : l))
    const { db } = await makeTestDb({ files, project_settings: settings, cells: chain(lines) })
    await recompute(db)
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

  it("marks a heading as a heading, never as an unnumbered line, with or without a reference", async () => {
    // The chapter card labels a structural chip "Heading" and leaves it out of
    // its "unnumbered lines" note, which is about lines added in the editor.
    const lines = [
      ...GENESIS.slice(0, 2),
      { id: "s1", ref: "GEN 1:s1:1", type: "heading" },
      ...GENESIS.slice(2),
    ]
    const { db } = await makeTestDb({ files, project_settings: settings, cells: chain(lines) })
    await recompute(db)
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const flags = async (sectionKey: string) => {
      const url = `https://worker/api/v1/projects/${P}/files/${F}/progress/sections/${encodeURIComponent(sectionKey)}`
      const res = (await handleProgressReadRequest(new Request(url, {
        headers: { Authorization: `Bearer ${token}` },
      }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
      const body = await res.json() as SectionProgressDetailResponse
      return body.verses.map((v) => [v.cellId, v.structural ?? false, v.unnumbered ?? false])
    }
    // Sorted by id: where a USFM heading id like "1:s1:1" sorts among the
    // verses is the reference comparator's business, not this flag's.
    expect((await flags("GEN 1")).sort()).toEqual([
      ["g11", false, false],
      ["g12", false, false],
      ["h1", true, false],
      ["s1", true, false],
      ["x1", false, true],
    ])
    expect(await flags("GEN 2")).toEqual([
      ["h2", true, false],
      ["x2", false, true],
      ["g21", false, false],
      ["g22", false, false],
    ])
  })
})

// AQU-1493 (perf): the walk is linear but not free — 65-80 ms on a whole-Bible
// Hello AO import — and where a line counts only moves when lines move, gain
// or lose a reference or change type, all of which run the FULL recompute. So
// that recompute walks once and stores the answer (`cell_plan_keys`), and the
// hot paths read it: each translation save's incremental recompute, the
// chapter card, "Go to first ...". Inline, the save path went from ~47 ms to
// ~135 ms on that file.
describe("only the full recompute walks the anchor chain (AQU-1493)", () => {
  const settings = [{ project_id: P, settings: JSON.stringify({ validationCount: 1 }), version: 1 }]
  const files = [{ id: F, project_id: P, name: F, event_id: `fev-${F}` }]
  const isWalk = (sql: string) => sql.includes("ik_run")

  it("walks once per full recompute, and never on a save, a chapter card or a 'Go to first' click", async () => {
    const statements: string[] = []
    const { db, pg } = await makeTestDb(
      { files, project_settings: settings, cells: chain(GENESIS) },
      { onStatement: (sql) => statements.push(sql) },
    )
    await recompute(db)
    expect(statements.filter(isWalk)).toHaveLength(1)

    statements.length = 0
    await pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, last_edit_at, event_id)
       VALUES ($1, $2, 'h2', 'target', '', 'The Seventh Day', $3, 'tev-h2')`,
      [P, F, TS],
    )
    await sectionsProgressRecomputeStmt(db, P, F, TS, ["h2"]).run()
    expect(await readFirstOpenCell(db, P, F, "GEN", "untranslated", "")).toBe("h1")
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const url = `https://worker/api/v1/projects/${P}/files/${F}/progress/sections/${encodeURIComponent("GEN 2")}`
    const res = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect((await res.json() as SectionProgressDetailResponse).verses.map((v) => v.cellId))
      .toEqual(["h2", "x2", "g21", "g22"])
    expect(statements.length).toBeGreaterThan(0)
    expect(statements.filter(isWalk)).toEqual([])

    // ...and the save still lands in the heading's chapter, from the stored row.
    expect(await row(db, "section", "GEN 2")).toEqual({ total_count: 4, filled_count: 2 })
  })

  it("stores one placement per line with no reference, and rewrites none when nothing moved", async () => {
    const { db, pg } = await makeTestDb({ cells: chain(GENESIS) })
    await recompute(db)
    const stored = await pg.query<{ cell_id: string; section_key: string }>(
      `SELECT cell_id, section_key FROM cell_plan_keys WHERE project_id = $1 AND file_id = $2 ORDER BY cell_id`,
      [P, F],
    )
    expect(stored.rows.map((r) => [r.cell_id, r.section_key])).toEqual([
      ["h1", "GEN 1"], ["h2", "GEN 2"], ["x1", "GEN 1"], ["x2", "GEN 2"],
    ])
    const before = await pg.query<{ xmin: string }>(`SELECT xmin::text FROM cell_plan_keys ORDER BY cell_id`)
    await recompute(db)
    const after = await pg.query<{ xmin: string }>(`SELECT xmin::text FROM cell_plan_keys ORDER BY cell_id`)
    expect(after.rows).toEqual(before.rows)
  })

  it("lets a line's own reference win over a stale stored placement", async () => {
    const { db, pg } = await makeTestDb({ cells: chain(JONAH) })
    await recompute(db)
    // A placement left behind for a cell that has since gained a reference by
    // a path that ran no full recompute: it must not drag the verse along.
    await pg.query(
      `INSERT INTO cell_plan_keys (project_id, file_id, cell_id, section_key) VALUES ($1, $2, 'j11', 'JON 2')`,
      [P, F],
    )
    await sectionsProgressRecomputeStmt(db, P, F, TS, ["j11"]).run()
    expect(await row(db, "section", "JON 1")).toEqual({ total_count: 2, filled_count: 2 })
    expect(await row(db, "section", "JON 2")).toEqual({ total_count: 4, filled_count: 2 })
  })
})
