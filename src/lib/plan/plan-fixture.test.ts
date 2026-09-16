/**
 * The AQU-1278 fixture claims each book lands in a particular group. This runs
 * the shipping `planUnitStatus` over the fixture and checks that it does.
 *
 * Why a test and not a printout in the seeder: the seeder cannot import the
 * client's plan library (it reaches `import.meta.env` through the auth module,
 * which is undefined outside Vite), and a fixture whose stated intent is never
 * checked rots the first time a threshold moves. Here the claim and the rule
 * meet, so changing `planNearlyCompleteThreshold` fails this file by name and
 * tells you which fixture book stopped meaning what it says.
 */
import { describe, expect, it } from "vitest"
import {
  ALL_BOOKS,
  AUDIO_BOOKS,
  TEXT_BOOKS,
  ASSIGNMENTS,
  LANE2,
  assignedCells,
  cellsFor,
  expectedCounts,
  fileOf,
  isStructural,
  shortChapters,
  type Book,
} from "./plan-fixture"
import {
  audioFileIds,
  planNearlyCompleteThreshold,
  planShortfallParts,
  planUnitShortfall,
  planUnitStatus,
  type PlanUnit,
} from "./plan-status"

const DAY = 86_400_000
/** A fixed clock; the seeder writes dates relative to its own run date. */
const NOW = Date.parse("2026-09-16T12:00:00Z")

function unitFor(b: Book): PlanUnit {
  const c = expectedCounts(b)
  return {
    fileId: fileOf(b.code),
    fileName: fileOf(b.code),
    sectionKey: b.code,
    ...c,
    lastEditAt: NOW - DAY,
    targetDate: b.targetDateInDays === undefined
      ? null
      : new Date(NOW + b.targetDateInDays * DAY).toISOString().slice(0, 10),
    doneAt: b.doneDaysAgo === undefined ? null : NOW - b.doneDaysAgo * DAY,
    doneBy: b.doneDaysAgo === undefined ? null : "dev",
  }
}

/** Every unit the board would hold, including the two file-grain ones. */
function board(): PlanUnit[] {
  const empty = (fileId: string, fileName: string, over: Partial<PlanUnit>): PlanUnit => ({
    fileId, fileName, sectionKey: "", totalCount: 0, filledCount: 0, validatedCount: 0,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null, targetDate: null,
    doneAt: null, doneBy: null, ...over,
  })
  return [
    ...ALL_BOOKS.map(unitFor),
    // The media file: a file-grain unit, 40 cues, 34 translated, 30 validated.
    empty("plan-1278-media", "episode-03.vtt", {
      totalCount: 40, filledCount: 34, validatedCount: 30, lastEditAt: NOW - DAY,
    }),
    // The notes file: no cells at all.
    empty("plan-1278-empty", "production-notes.md", {}),
  ]
}

describe("AQU-1278 fixture", () => {
  const units = board()
  const audioFiles = audioFileIds(units)

  it("expects audio of the dubbed file only, never the text file", () => {
    // The per-file gate is the fixture's load-bearing shape: put a take in the
    // text file and every text book's shortfall becomes its whole cell count.
    expect([...audioFiles]).toEqual(["plan-1278-audio"])
  })

  it.each(ALL_BOOKS.map((b) => [b.code, b] as const))(
    "%s lands in the group the fixture claims",
    (_code, b) => {
      const u = units.find((x) => x.sectionKey === b.code)!
      expect(planUnitStatus(u, NOW, audioFiles)).toBe(b.expect)
    },
  )

  it("puts the media file in progress and the empty file in not started", () => {
    const media = units.find((u) => u.fileId === "plan-1278-media")!
    const empty = units.find((u) => u.fileId === "plan-1278-empty")!
    expect(planUnitStatus(media, NOW, audioFiles)).toBe("in_progress")
    // Landmine 3: a zero shortfall clears every threshold, so without the
    // totalCount guard this file would be promoted above In progress and
    // labelled "Nothing left" — a file with nothing in it.
    expect(planUnitStatus(empty, NOW, audioFiles)).toBe("not_started")
  })

  it("covers every status in the vocabulary", () => {
    const seen = new Set(units.map((u) => planUnitStatus(u, NOW, audioFiles)))
    expect([...seen].sort()).toEqual(
      ["done", "in_progress", "nearly_complete", "not_started", "overdue", "soon"],
    )
  })

  it("puts Philemon exactly on the seven-cell floor", () => {
    const phm = ALL_BOOKS.find((b) => b.code === "PHM")!
    const u = unitFor(phm)
    // Six percent of twenty-five is one and a half. Only the floor qualifies it.
    expect(Math.ceil(u.totalCount * 0.06)).toBeLessThan(7)
    expect(planNearlyCompleteThreshold(u.totalCount)).toBe(7)
    expect(planUnitShortfall(u, false).worst).toBe(7)
    // One more outstanding cell and it must drop out — that is what makes this
    // book a boundary test rather than another passing row.
    const overBy1: PlanUnit = { ...u, validatedCount: u.validatedCount - 1 }
    expect(planUnitStatus(overBy1, NOW, audioFiles)).toBe("in_progress")
  })

  it("keeps Jonah overdue even though its queue is short", () => {
    const jon = units.find((u) => u.sectionKey === "JON")!
    expect(planUnitShortfall(jon, false).worst)
      .toBeLessThanOrEqual(planNearlyCompleteThreshold(jon.totalCount))
    expect(planUnitStatus(jon, NOW, audioFiles)).toBe("overdue")
  })

  it("ignores Mark's recorded headings, so audio equals the denominator exactly", () => {
    const mrk = units.find((u) => u.sectionKey === "MRK")!
    // Every verse AND every heading is recorded, with the org excluding
    // headings. AQU-1278: the recorded headings leave the audio numbers with
    // the headings themselves, so this lands ON the denominator rather than
    // over it. Equality is the assertion — `toBeLessThanOrEqual` would pass
    // just as well on a book that was never recorded at all.
    expect(mrk.audioCount).toBe(mrk.totalCount)
    const s = planUnitShortfall(mrk, true)
    expect(s.toRecord).toBe(0)
    expect(s.worst).toBe(0)
    expect(planShortfallParts(s)).toEqual([])
  })

  it("makes Acts name translation and the audio that grouped it", () => {
    const act = units.find((u) => u.sectionKey === "ACT")!
    const parts = planShortfallParts(planUnitShortfall(act, true))
    // Three outstanding mediums, room for two. Translation leads because a cell
    // nobody wrote cannot be validated; the worse medium must still appear.
    expect(parts.map((p) => p.kind)).toEqual(["translate", "record"])
  })

  it("gives Genesis a chapter gap and two short chapters", () => {
    const gen = TEXT_BOOKS.find((b) => b.code === "GEN")!
    const cells = cellsFor(gen)
    expect(cells.some((c) => c.ref.startsWith("GEN 7:"))).toBe(false)
    const shortBy = new Map<string, number>()
    for (const c of cells) {
      if (isStructural(c.type) || c.validated) continue
      const chapter = c.ref.split(":")[0]
      shortBy.set(chapter, (shortBy.get(chapter) ?? 0) + 1)
    }
    expect([...shortBy.entries()].sort()).toEqual([["GEN 12", 2], ["GEN 40", 1]])
  })

  it("leaves one Genesis cell untyped so the headings policy is exercised", () => {
    // Under `NOT (type IN (...))` a null type propagates NULL and WHERE drops
    // the row, so before the COALESCE fix this cell vanished from its chapter.
    const untyped = cellsFor(TEXT_BOOKS.find((b) => b.code === "GEN")!)
      .filter((c) => c.type === null)
    expect(untyped.map((c) => c.ref)).toEqual(["GEN 1:1", "GEN", "GEN"])
  })

  it("keeps Titus on a section key equal to its book code", () => {
    const tit = cellsFor(TEXT_BOOKS.find((b) => b.code === "TIT")!)
    expect(new Set(tit.map((c) => c.ref.split(":")[0]))).toEqual(new Set(["TIT"]))
  })

  it("names more short chapters in Deuteronomy than a row can list", () => {
    const deu = TEXT_BOOKS.find((b) => b.code === "DEU")!
    expect(shortChapters(deu).length).toBeGreaterThan(3)
  })

  it("assigns Deuteronomy to more people than the row can draw", () => {
    const onDeu = ASSIGNMENTS.filter((a) => a.book === "DEU")
    expect(onDeu.length).toBe(6)
    expect(new Set(onDeu.map((a) => a.user)).size).toBe(6)
  })

  it("pins exactly one assignment to the second lane", () => {
    const pinned = ASSIGNMENTS.filter((a) => a.lane !== "")
    expect(pinned.map((a) => [a.book, a.lane])).toEqual([["JOS", LANE2]])
  })

  it("assigns no cell twice and no cell that does not exist", () => {
    const existing = new Set(
      ALL_BOOKS.flatMap((b) => cellsFor(b).map((c) => `${fileOf(b.code)}:${c.cellId}`)),
    )
    const seen = new Set<string>()
    for (const a of ASSIGNMENTS) {
      for (const { fileId, cellId } of assignedCells(a)) {
        const key = `${fileId}:${cellId}`
        // A row pointing at a cell that does not exist joins to nothing and
        // quietly shrinks the person's own total — Genesis has no chapter 7.
        expect(existing.has(key)).toBe(true)
        // Two people holding one cell would double every per-person count.
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })

  it("leaves most of Leviticus unassigned, so the panel has something to say", () => {
    const lev = TEXT_BOOKS.find((b) => b.code === "LEV")!
    const held = ASSIGNMENTS.filter((a) => a.book === "LEV")
      .reduce((n, a) => n + assignedCells(a).length, 0)
    expect(held).toBeGreaterThan(0)
    expect(held).toBeLessThan(expectedCounts(lev).totalCount)
  })

  it("keeps every audio book in the audio file and no others", () => {
    expect(AUDIO_BOOKS.every((b) => fileOf(b.code) === "plan-1278-audio")).toBe(true)
    expect(TEXT_BOOKS.every((b) => fileOf(b.code) === "plan-1278-text")).toBe(true)
  })
})
