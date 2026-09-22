// AQU-1093/1096/1098: book-grain rows, audio counts and per-unit activity on
// the progress projection.
//
// The project dashboard plans by UNIT — a Bible book where a file subdivides
// into books, the file otherwise — so the rollup that used to be recomputed
// client-side by re-parsing every chapter now lands in the projection.
import { describe, it, expect } from "vitest"
import { fullProgressRecomputeStmts, sectionsProgressRecomputeStmt } from "../events/progress-projection"
import { makeTestDb } from "./helpers/pg-test-db"

const P = "proj-a"
const F = "file-1"
const TS = 1_700_000_000_000

interface CellSeed {
  cell_id: string
  side?: string
  target_lang?: string
  canonical_ref?: string | null
  value?: string
  endorsement_count?: number
  last_edit_at?: number
  start_ms?: number | null
}

function cell(c: CellSeed) {
  return {
    project_id: P,
    file_id: F,
    cell_id: c.cell_id,
    side: c.side ?? "source",
    target_lang: c.target_lang ?? "",
    value: c.value ?? "",
    canonical_ref: c.canonical_ref ?? null,
    endorsement_count: c.endorsement_count ?? 0,
    last_edit_at: c.last_edit_at ?? TS,
    start_ms: c.start_ms ?? null,
    event_id: `ev-${c.cell_id}-${c.side ?? "source"}-${c.target_lang ?? ""}`,
  }
}

async function recompute(db: Parameters<typeof fullProgressRecomputeStmts>[0]) {
  for (const stmt of fullProgressRecomputeStmts(db, P, F, TS)) await stmt.run()
}

async function rows(db: { prepare: (s: string) => { bind: (...a: unknown[]) => { all: () => Promise<{ results: unknown[] }> } } }, scope: string) {
  const r = await db
    .prepare(
      `SELECT section_key, target_lang, total_count, filled_count, audio_count,
              audio_validated_count, last_edit_at
         FROM file_section_progress
        WHERE project_id = ? AND file_id = ? AND scope = ?
        ORDER BY section_key, target_lang`,
    )
    .bind(P, F, scope)
    .all()
  return r.results as Array<{
    section_key: string
    target_lang: string
    total_count: number
    filled_count: number
    audio_count: number
    audio_validated_count: number
    last_edit_at: number | null
  }>
}

describe("book-scope progress rows", () => {
  it("rolls chapter sections up to one row per book", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "g1", canonical_ref: "GEN 1:1", value: "In the beginning" }),
        cell({ cell_id: "g2", canonical_ref: "GEN 1:2" }),
        cell({ cell_id: "g3", canonical_ref: "GEN 2:1" }),
        cell({ cell_id: "e1", canonical_ref: "EXO 1:1" }),
      ],
    })
    await recompute(db)

    const books = await rows(db, "book")
    expect(books.map((b) => b.section_key)).toEqual(["EXO", "GEN"])
    // GEN's three cells span two chapters; the book row is their sum.
    expect(books.find((b) => b.section_key === "GEN")?.total_count).toBe(3)
    expect(books.find((b) => b.section_key === "EXO")?.total_count).toBe(1)

    const sections = await rows(db, "section")
    expect(sections.map((s) => s.section_key)).toEqual(["EXO 1", "GEN 1", "GEN 2"])
  })

  it("counts a heading with a chapter-only ref into its book", async () => {
    // \s1 headings carry "GEN 1" rather than a verse ref. They are part of the
    // denominator today (excluding them is AQU-1083, a separate decision), so
    // the book total must include them or book and file rows would disagree.
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "h1", canonical_ref: "GEN 1" }),
        cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }),
      ],
    })
    await recompute(db)
    expect((await rows(db, "book")).find((b) => b.section_key === "GEN")?.total_count).toBe(2)
  })

  it("emits no book rows for a file that is not Scripture", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "c1", canonical_ref: null, start_ms: 0 }),
        cell({ cell_id: "c2", canonical_ref: null, start_ms: 400_000 }),
      ],
    })
    await recompute(db)
    expect(await rows(db, "book")).toHaveLength(0)
    // ...but the media file still gets its time-bucket sections.
    expect((await rows(db, "section")).length).toBeGreaterThan(0)
  })

  it("keeps a book row separate from an identically keyed section row", async () => {
    // A one-chapter book referenced as "TIT" yields section_key 'TIT' AND
    // book_key 'TIT'. Same key, different scope — if the histogram grouping
    // ignored scope these two would clobber each other.
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "t1", canonical_ref: "TIT 1:1" }),
        cell({ cell_id: "t2", canonical_ref: "TIT" }),
        cell({ cell_id: "t1", side: "target", value: "done", endorsement_count: 3 }),
      ],
    })
    await recompute(db)
    const book = (await rows(db, "book")).find((b) => b.section_key === "TIT")
    const section = (await rows(db, "section")).find((s) => s.section_key === "TIT")
    expect(book?.total_count).toBe(2) // both cells belong to book TIT
    expect(section?.total_count).toBe(1) // only the bare "TIT" ref is that section
    expect(book?.filled_count).toBe(1)
  })

  it("produces a book row per lane", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }),
        cell({ cell_id: "g1", side: "target", target_lang: "es", value: "En el principio" }),
        cell({ cell_id: "g1", side: "target", target_lang: "fr", value: "" }),
      ],
    })
    await recompute(db)
    const books = await rows(db, "book")
    const byLane = Object.fromEntries(books.map((b) => [b.target_lang, b.filled_count]))
    // Every lane shares the denominator; only the filled count differs.
    expect(byLane["es"]).toBe(1)
    expect(byLane["fr"]).toBe(0)
    expect(byLane[""]).toBe(0)
    expect(books.every((b) => b.total_count === 1)).toBe(true)
  })
})

describe("audio counts", () => {
  const audioSeed = (over: Record<string, unknown>) => ({
    project_id: P,
    file_id: F,
    audio_id: "a1",
    cell_id: "g1",
    selected: 0,
    deleted: 0,
    approved: 0,
    duration_ms: 1000,
    ...over,
  })

  it("counts a cell as having audio on any live take, matching the portfolio", async () => {
    // The org portfolio counts audio cells on `deleted = 0` alone — recording
    // is what counts, not selecting. Per-unit rows must agree or the tiles and
    // the board would contradict each other.
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }), cell({ cell_id: "g2", canonical_ref: "GEN 1:2" })],
      cell_audio: [audioSeed({ selected: 0 })],
    })
    await recompute(db)
    const book = (await rows(db, "book"))[0]
    expect(book.audio_count).toBe(1)
    expect(book.audio_validated_count).toBe(0)
  })

  it("counts validated audio only when the SELECTED take is approved", async () => {
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" })],
      cell_audio: [
        audioSeed({ audio_id: "a1", selected: 1, approved: 1 }),
        audioSeed({ audio_id: "a2", selected: 0, approved: 0 }),
      ],
    })
    await recompute(db)
    expect((await rows(db, "book"))[0].audio_validated_count).toBe(1)
  })

  it("drops validation when an approved take is no longer selected", async () => {
    // Re-recording selects a fresh take; the old approval must stop counting.
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" })],
      cell_audio: [
        audioSeed({ audio_id: "a1", selected: 0, approved: 1 }),
        audioSeed({ audio_id: "a2", selected: 1, approved: 0 }),
      ],
    })
    await recompute(db)
    const book = (await rows(db, "book"))[0]
    expect(book.audio_count).toBe(1)
    expect(book.audio_validated_count).toBe(0)
  })

  it("ignores deleted takes entirely", async () => {
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" })],
      cell_audio: [audioSeed({ selected: 1, approved: 1, deleted: 1 })],
    })
    await recompute(db)
    expect((await rows(db, "book"))[0].audio_count).toBe(0)
  })

  it("reports the same audio totals on file, section and book rows", async () => {
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }), cell({ cell_id: "g2", canonical_ref: "GEN 1:2" })],
      cell_audio: [audioSeed({ cell_id: "g1", selected: 1, approved: 1 })],
    })
    await recompute(db)
    for (const scope of ["file", "section", "book"]) {
      const r = (await rows(db, scope)).find((x) => x.target_lang === "")
      expect(r?.audio_count, scope).toBe(1)
      expect(r?.audio_validated_count, scope).toBe(1)
    }
  })
})

describe("per-unit activity", () => {
  it("takes the newest edit across the source and the lane's target", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "g1", canonical_ref: "GEN 1:1", last_edit_at: 1000 }),
        cell({ cell_id: "g1", side: "target", target_lang: "es", value: "hola", last_edit_at: 5000 }),
      ],
    })
    await recompute(db)
    const books = await rows(db, "book")
    expect(books.find((b) => b.target_lang === "es")?.last_edit_at).toBe(5000)
    // The default lane has no target row, so only the source edit counts.
    expect(books.find((b) => b.target_lang === "")?.last_edit_at).toBe(1000)
  })

  it("leaves activity null when nothing has been edited", async () => {
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1", last_edit_at: 0 })],
    })
    await recompute(db)
    expect((await rows(db, "book"))[0].last_edit_at).toBeNull()
  })
})

describe("pruning", () => {
  it("prunes disappeared source keys across lanes without touching other files or file-level rows", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }),
        cell({ cell_id: "g2", canonical_ref: "GEN 2:1" }),
        cell({ cell_id: "m1", canonical_ref: "MAT 1" }),
        cell({ cell_id: "g1", side: "target", target_lang: "fr", value: "un" }),
        cell({ cell_id: "g2", side: "target", target_lang: "es", value: "dos" }),
      ],
    })
    await recompute(db)
    // A different file can have the same keys. Its rows must never satisfy
    // this file's existence checks or be removed by this file's cleanup.
    await db.prepare(`INSERT INTO file_section_progress
      (project_id, file_id, scope, section_key, target_lang, total_count, filled_count,
       validator_histogram, revision, updated_at)
      SELECT project_id, 'other-file', scope, section_key, target_lang, total_count,
             filled_count, validator_histogram, revision, updated_at
        FROM file_section_progress WHERE project_id = ? AND file_id = ?`).bind(P, F).run()
    const readOther = async () => (await db.prepare(
      `SELECT * FROM file_section_progress WHERE file_id = 'other-file' ORDER BY scope, section_key, target_lang`,
    ).all()).results
    const otherBefore = await readOther()

    // The orphan Spanish target must not keep GEN 2 alive.
    await db.prepare(`DELETE FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = 'g2' AND side = 'source'`).bind(P, F).run()
    await recompute(db)
    expect((await rows(db, "section")).map(({ section_key, target_lang }) => [section_key, target_lang]))
      .toEqual(["GEN 1", "MAT 1"].flatMap(key => ["", "es", "fr"].map(lane => [key, lane])))
    expect((await rows(db, "book")).map(({ section_key, target_lang }) => [section_key, target_lang]))
      .toEqual(["GEN", "MAT"].flatMap(key => ["", "es", "fr"].map(lane => [key, lane])))
    expect(await readOther()).toEqual(otherBefore)

    const fileRows = await rows(db, "file")
    await db.prepare(`DELETE FROM cells WHERE project_id = ? AND file_id = ? AND side = 'source'`).bind(P, F).run()
    // Exercise just the pruning statement with an empty source set. File
    // counters are the recompute statement's responsibility, not the prune's.
    await fullProgressRecomputeStmts(db, P, F, TS)[1].run()
    expect(await rows(db, "section")).toEqual([])
    expect(await rows(db, "book")).toEqual([])
    expect(await rows(db, "file")).toEqual(fileRows)
    expect(await readOther()).toEqual(otherBefore)
  })

  it("removes a book row once its cells are gone", async () => {
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }), cell({ cell_id: "e1", canonical_ref: "EXO 1:1" })],
    })
    await recompute(db)
    expect((await rows(db, "book")).map((b) => b.section_key)).toEqual(["EXO", "GEN"])

    await db.prepare(`DELETE FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = ?`).bind(P, F, "e1").run()
    await recompute(db)
    expect((await rows(db, "book")).map((b) => b.section_key)).toEqual(["GEN"])
  })

  it("removes every book row when a file stops being Scripture", async () => {
    // The key match alone would keep "GEN" alive off a leftover chapter-only
    // ref; the prune has to re-ask whether the file is Scripture at all.
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }), cell({ cell_id: "h1", canonical_ref: "GEN 1" })],
    })
    await recompute(db)
    expect(await rows(db, "book")).toHaveLength(1)

    await db.prepare(`DELETE FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = ?`).bind(P, F, "g1").run()
    await recompute(db)
    expect(await rows(db, "book")).toHaveLength(0)
  })

  it("keeps a book whose own refs are chapter-only, in a file that IS Scripture", async () => {
    // THE INSERT AND THE PRUNE HAVE TO AGREE. Book rows are written whenever
    // the FILE holds any verse-shaped ref; the prune used to demand that each
    // BOOK hold one. A book of chapter-only refs sitting in a Scripture file
    // was therefore written and deleted in the same batch, so it existed after
    // an incremental recompute and vanished after a full one.
    //
    // The damage is not cosmetic: a file with book rows has no file-grain
    // unit, so MAT's cells would belong to no planning unit at all — off the
    // board, out of the CSV, and any target date or Done mark already stored
    // against (file, 'MAT') unreachable, because the write route 404s a unit
    // it cannot enumerate.
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }),
        cell({ cell_id: "m1", canonical_ref: "MAT 1" }),
        cell({ cell_id: "m2", canonical_ref: "MAT 2" }),
      ],
    })
    await recompute(db)
    expect((await rows(db, "book")).map((b) => b.section_key)).toEqual(["GEN", "MAT"])
  })

  it("agrees with the incremental path about which books exist", async () => {
    const seeds = [
      cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }),
      cell({ cell_id: "m1", canonical_ref: "MAT 1" }),
    ]
    const full = await makeTestDb({ cells: seeds })
    await recompute(full.db)
    const incremental = await makeTestDb({ cells: seeds })
    await sectionsProgressRecomputeStmt(incremental.db, P, F, TS).run()

    expect((await rows(full.db, "book")).map((b) => b.section_key))
      .toEqual((await rows(incremental.db, "book")).map((b) => b.section_key))
  })
})

describe("partial recompute", () => {
  it("refreshes the touched cell's book as well as its chapter", async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: "g1", canonical_ref: "GEN 1:1" }),
        cell({ cell_id: "e1", canonical_ref: "EXO 1:1" }),
      ],
    })
    await recompute(db)

    // Translate GEN 1:1, then recompute only that cell's neighbourhood.
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
         VALUES (?, ?, 'g1', 'target', '', 'In the beginning', 'ev-x', ?)`,
      )
      .bind(P, F, TS)
      .run()
    await sectionsProgressRecomputeStmt(db, P, F, TS + 1, ["g1"]).run()

    const books = await rows(db, "book")
    expect(books.find((b) => b.section_key === "GEN")?.filled_count).toBe(1)
    // EXO was not touched and must be left exactly as it was.
    expect(books.find((b) => b.section_key === "EXO")?.filled_count).toBe(0)
  })
})

// ── The trigger ────────────────────────────────────────────────────────────
//
// Audio projections only touch `cell_audio`, so before AQU-1093 an audio event
// reported no affected file and no progress recompute ran. Per-unit audio
// counts would drift the moment anyone recorded or approved a take and only a
// full rebuild would repair them. These tests pin which kinds now schedule the
// recompute — and, just as importantly, which deliberately do not.
describe("audio events schedule a progress recompute", () => {
  const CLAIMS = { username: "randall", userId: 7, role: 600, projectId: P, fileId: F } as never

  function audioEvent(kind: string, payload: Record<string, unknown> = {}) {
    return {
      event: {
        id: `ev-${kind}-${Math.abs(kind.length)}`,
        schemaVersion: 1 as const,
        kind,
        projectId: P,
        fileId: F,
        cellId: "g1",
        parentId: null,
        payload: { audioId: "a1", ...payload },
        clientTs: TS,
      },
      claims: CLAIMS,
    } as never
  }

  async function counterFileFor(kind: string, payload?: Record<string, unknown>) {
    const { db } = await makeTestDb({
      cells: [cell({ cell_id: "g1", canonical_ref: "GEN 1:1" })],
      cell_audio: [
        {
          project_id: P, file_id: F, audio_id: "a1", cell_id: "g1",
          selected: 1, deleted: 0, approved: 0, duration_ms: 1000,
        },
      ],
    })
    const { handleCellEvent } = await import("../events/handlers/cell-events")
    const res = handleCellEvent(db, audioEvent(kind, payload), TS, {
      serverSeq: 1,
      updateProjection: true,
      deferFileCounters: true,
    })
    return res.counterFile
  }

  it("schedules one for the kinds that change a count", async () => {
    for (const kind of [
      "cell.audio.attach",
      "cell.audio.select",
      "cell.audio.remove",
      "cell.audio.validate",
      "cell.audio.unvalidate",
    ]) {
      expect(await counterFileFor(kind), kind).toEqual({ projectId: P, fileId: F })
    }
  })

  it("schedules none for count-neutral timeline edits", async () => {
    // One drag emits a stream of these; recomputing per event would be a
    // needless O(file) pass and none of them move an audio count.
    for (const kind of ["cell.audio.rename", "cell.audio.trim", "cell.audio.place"]) {
      expect(await counterFileFor(kind, { label: "take 2", startMs: 0, endMs: 10 }), kind).toBeUndefined()
    }
  })
})
