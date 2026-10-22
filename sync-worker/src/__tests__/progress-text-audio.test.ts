// Media redesign slice 1: the joint text × audio histogram on every progress
// row, so a language that delivers "Text and audio" counts a line done only
// when BOTH its text is validated and its recording approved, on the same line
// (P1.6), at any pair of thresholds.
import { describe, it, expect } from "vitest"
import {
  fileProgressRecomputeStmt,
  fullProgressRecomputeStmts,
  sectionsProgressRecomputeStmt,
  TEXT_AUDIO_STALE_FILES_SQL,
} from "../events/progress-projection"
import { bothApprovedFromHistogram } from "../../../src/lib/lanes/lane-delivers"
import { makeTestDb } from "./helpers/pg-test-db"

const P = "proj-ta"
const F = "file-ta"
const TS = 1_700_000_000_000
const LANE = "lnfr0000"

const source = (n: number, type?: string) => ({
  project_id: P, file_id: F, cell_id: `c${n}`, side: "source", target_lang: "fr",
  value: `Verse ${n}`, canonical_ref: `RUT 1:${n}`, endorsement_count: 0, last_edit_at: TS,
  event_id: `ev-s-${n}`, ...(type ? { type } : {}),
})
const target = (n: number, votes: number) => ({
  project_id: P, file_id: F, cell_id: `c${n}`, side: "target", target_lang: "fr",
  lane_id: LANE, value: `Vers ${n}`, canonical_ref: null, endorsement_count: votes,
  last_edit_at: TS, event_id: `ev-t-${n}`,
})
const take = (n: number, votes: number) => ({
  project_id: P, file_id: F, audio_id: `a${n}`, cell_id: `c${n}`, lane_id: LANE,
  selected: 1, deleted: 0, role: "dub", slot: "recording", validator_count: votes, duration_ms: 1000,
})

/**
 * P1.6's ten lines with both required-validator counts at 1:
 *   1–4 text validated and recording approved; 5–7 text validated, no
 *   recording; 8–9 recording approved, text typed but not validated; 10 nothing.
 */
function p16Seed(extraSource: ReturnType<typeof source>[] = []) {
  return {
    lanes: [
      { id: "lnsrc000", project_id: P, role: "source", name: "English", legacy_tag: null },
      { id: LANE, project_id: P, role: "target", name: "French", lang_code: "fr", legacy_tag: "fr", delivers: "text_and_audio" },
    ],
    cells: [
      ...Array.from({ length: 10 }, (_, i) => source(i + 1)),
      ...extraSource,
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => target(n, 1)),
      target(8, 0),
      target(9, 0),
    ],
    cell_audio: [1, 2, 3, 4, 8, 9].map((n) => take(n, 1)),
  }
}

async function progress(db: Awaited<ReturnType<typeof makeTestDb>>["db"], scope: string) {
  const r = await db
    .prepare(
      `SELECT p.section_key, p.text_audio_validator_histogram, p.structural_text_audio_validator_histogram,
              p.audio_validator_histogram
         FROM file_section_progress p
        WHERE p.project_id = ? AND p.file_id = ? AND p.scope = ? AND p.lane_id = ?
        ORDER BY p.section_key`,
    )
    .bind(P, F, scope, LANE)
    .all<{
      section_key: string
      text_audio_validator_histogram: Record<string, number>
      structural_text_audio_validator_histogram: Record<string, number>
      audio_validator_histogram: Record<string, number>
    }>()
  return r.results
}

describe("joint text × audio histogram", () => {
  it("counts the lines done on both halves, on file, section and book rows (P1.6)", async () => {
    const { db } = await makeTestDb(p16Seed())
    for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
    for (const scope of ["file", "section", "book"]) {
      const [row] = await progress(db, scope)
      expect(row, scope).toBeDefined()
      // Six lines carry a recording: four with validated text, two without.
      expect(row!.text_audio_validator_histogram, scope).toEqual({ "1:1": 4, "0:1": 2 })
      expect(bothApprovedFromHistogram(row!.text_audio_validator_histogram, 1, 1), scope).toBe(4)
      // The same lines the audio histogram counts, so the two can never disagree.
      const audioLines = Object.values(row!.audio_validator_histogram).reduce((a, b) => a + b, 0)
      const jointLines = Object.values(row!.text_audio_validator_histogram).reduce((a, b) => a + b, 0)
      expect(jointLines, scope).toBe(audioLines)
    }
  })

  it("is read at each threshold on its own: two text votes needed, one audio vote", async () => {
    const seed = p16Seed()
    seed.cells = seed.cells.map((c) => (c.side === "target" && c.cell_id === "c1" ? { ...c, endorsement_count: 2 } : c))
    const { db } = await makeTestDb(seed)
    for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
    const [file] = await progress(db, "file")
    expect(bothApprovedFromHistogram(file!.text_audio_validator_histogram, 2, 1)).toBe(1)
    expect(bothApprovedFromHistogram(file!.text_audio_validator_histogram, 1, 2)).toBe(0)
  })

  it("the incremental recomputes write the same histogram as the full one", async () => {
    const { db } = await makeTestDb(p16Seed())
    for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
    const full = { file: await progress(db, "file"), section: await progress(db, "section"), book: await progress(db, "book") }
    await db.prepare("DELETE FROM file_section_progress WHERE project_id = ?").bind(P).run()
    await fileProgressRecomputeStmt(db, P, F, TS).run()
    await sectionsProgressRecomputeStmt(db, P, F, TS).run()
    expect(await progress(db, "file")).toEqual(full.file)
    expect(await progress(db, "section")).toEqual(full.section)
    expect(await progress(db, "book")).toEqual(full.book)
  })

  it("records the structural share, so excluding headings subtracts them", async () => {
    const seed = p16Seed([{ ...source(11, "heading"), canonical_ref: "RUT 1" }])
    seed.cells.push(target(11, 1))
    seed.cell_audio.push(take(11, 1))
    const { db } = await makeTestDb(seed)
    for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
    const [file] = await progress(db, "file")
    expect(file!.text_audio_validator_histogram).toEqual({ "1:1": 5, "0:1": 2 })
    expect(file!.structural_text_audio_validator_histogram).toEqual({ "1:1": 1 })
  })

  it("is empty for a lane with no recordings", async () => {
    const seed = p16Seed()
    seed.cell_audio = []
    const { db } = await makeTestDb(seed)
    for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
    const [file] = await progress(db, "file")
    expect(file!.text_audio_validator_histogram).toEqual({})
  })

  it("the backfill selects a file projected before the histogram existed, and only until it is re-projected", async () => {
    const { db } = await makeTestDb(p16Seed())
    for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
    const stale = async () => (await db.prepare(TEXT_AUDIO_STALE_FILES_SQL).all<{ id: string }>()).results.map((r) => r.id)
    expect(await stale()).toEqual([])
    // What every row written before migration 0186 looks like after it.
    await db.prepare("UPDATE file_section_progress SET text_audio_validator_histogram = '{}'::jsonb").run()
    expect(await stale()).toEqual([F])
    for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
    expect(await stale()).toEqual([])
  })
})
