// Reading the character spreadsheet and keying it to a file's cells.
// (AQU-646 stage 6)
//
// The assertion that matters most is a refusal. A wrong keying assigns hundreds
// of characters to lines they do not belong to, silently, with nothing on
// screen to say so — so the direction of the check is the whole safety story:
// a CELL with no row is fine, a ROW with no cell means the sheet is not this
// episode's and the import must stop.
//
// The last block runs against the REAL episode-101 workbook and pins the shape
// measured from it; it skips itself when the file isn't on the machine.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect } from "vitest"

import {
  guessCharacterColumns,
  readCharacterRows,
  planCharacterAssignments,
  MATCH_TOLERANCE_MS,
  type CharacterSheetColumns,
} from "./character-sheet"
import { parseXlsxToSheets } from "@/lib/parsers/spreadsheet"

const HEADER = ["ID", "Source", "endTime", "startTime", "timeStamp", "Character Label", "VTT_closest", "Camera"]
// `text` is null: the subtitle sheet carries no copy of the line. Only the
// AUDIO sheet does, which is what lets that one match by wording.
const COLS: CharacterSheetColumns = { character: 5, camera: 7, start: 3, range: 4, text: null }

const row = (start: string, character: string, camera = ""): string[] => [
  "1", "text", "", start, `${start} --> 00:00:00.000`, character, "", camera,
]

const cell = (id: string, startTime: number) => ({ cellId: id, startTime })

describe("guessCharacterColumns", () => {
  it("finds the real workbook's columns from its headers", () => {
    // `text` finds "Source" — this sheet's copy of the line. Unused here (it
    // keys on timestamps) but the same guesser serves the AUDIO sheet, which
    // matches on wording and needs it.
    expect(guessCharacterColumns(HEADER)).toEqual({
      character: 5, camera: 7, start: 3, range: 4, text: 1,
    })
  })

  it("refuses when there is no character column — nothing else can be inferred", () => {
    expect(guessCharacterColumns(["ID", "Source", "startTime"])).toBeNull()
  })

  it("tolerates the naming a different studio might use", () => {
    const g = guessCharacterColumns(["speaker", "in", "angle"])
    expect(g).toEqual({ character: 0, camera: 2, start: 1, range: null, text: null })
  })
})

describe("reading rows", () => {
  it("splits the angle out of the label", () => {
    const [r] = readCharacterRows([HEADER, row("00:00:22.940", "JESUS.  (On)")], COLS)
    expect(r.castName).toBe("JESUS.")
    expect(r.cameraState).toBe("on")
  })

  it("lets the dedicated column win over the embedded angle", () => {
    const [r] = readCharacterRows([HEADER, row("00:00:22.940", "JESUS.  (On)", "Off")], COLS)
    expect(r.cameraState).toBe("off")
    expect(r.cameraDisagrees).toBe(true)
  })

  it("does not call it a disagreement when they agree", () => {
    const [r] = readCharacterRows([HEADER, row("00:00:22.940", "JESUS.  (On)", "On")], COLS)
    expect(r.cameraDisagrees).toBe(false)
  })

  it("reads Group as mixed — a group shot is a mixed lip-sync constraint", () => {
    const [r] = readCharacterRows([HEADER, row("00:00:22.940", "CROWD", "Group")], COLS)
    expect(r.cameraState).toBe("mixed")
  })

  it("keeps a blank character as blank rather than inventing a name", () => {
    const [r] = readCharacterRows([HEADER, row("00:00:22.940", "", "Off")], COLS)
    expect(r.castName).toBe("")
  })

  it("falls back to the range column when there is no start column", () => {
    const rows = [HEADER, row("00:00:22.940", "JESUS.")]
    const [r] = readCharacterRows(rows, { ...COLS, start: null })
    expect(r.startSec).toBeCloseTo(22.94, 3)
  })

  it("cites the sheet's own row numbers, header included", () => {
    const rows = [HEADER, row("00:00:01.000", "A"), row("00:00:02.000", "B")]
    expect(readCharacterRows(rows, COLS).map((r) => r.rowNumber)).toEqual([2, 3])
  })
})

describe("keying rows to cells", () => {
  const rows = readCharacterRows(
    [HEADER, row("00:00:10.000", "JESUS. (On)"), row("00:00:20.000", "MARY (Off)")],
    COLS,
  )

  it("assigns each row to the cell at its timestamp", () => {
    const p = planCharacterAssignments({ rows, cells: [cell("c1", 10), cell("c2", 20)] })
    expect(p.assignments).toEqual([
      { cellId: "c1", castName: "JESUS.", cameraState: "on", rowNumber: 2 },
      { cellId: "c2", castName: "MARY", cameraState: "off", rowNumber: 3 },
    ])
    expect(p.unmatchedRows).toEqual([])
  })

  it("absorbs millisecond rounding", () => {
    const p = planCharacterAssignments({ rows, cells: [cell("c1", 10.02), cell("c2", 19.98)] })
    expect(p.assignments).toHaveLength(2)
  })

  it("takes the NEAREST cell, not the first one within tolerance", () => {
    // Two cells inside the window: the closer one must win, or a row between
    // two lines lands on whichever the loop happened to reach first.
    const p = planCharacterAssignments({
      rows: readCharacterRows([HEADER, row("00:00:10.000", "JESUS.")], COLS),
      cells: [cell("far", 10.02), cell("near", 10.001)],
      toleranceMs: 50,
    })
    expect(p.assignments[0].cellId).toBe("near")
  })

  it("never gives one cell to two rows", () => {
    const p = planCharacterAssignments({
      rows: readCharacterRows(
        [HEADER, row("00:00:10.000", "JESUS."), row("00:00:10.010", "MARY")],
        COLS,
      ),
      cells: [cell("only", 10)],
    })
    expect(p.assignments).toHaveLength(1)
    expect(p.unmatchedRows).toHaveLength(1)
  })

  describe("the refusal is directional", () => {
    it("is SILENT about a cell no row covers", () => {
      // A line nobody wrote a character for. Normal, not a failure.
      const p = planCharacterAssignments({
        rows,
        cells: [cell("c1", 10), cell("c2", 20), cell("c3", 30)],
      })
      expect(p.unmatchedRows).toEqual([])
      expect(p.cellsWithoutRow).toBe(1)
    })

    it("REFUSES a row that matches no cell — the wrong-episode signal", () => {
      const p = planCharacterAssignments({ rows, cells: [cell("c1", 10)] })
      expect(p.unmatchedRows).toEqual([3])
      // ...and it names the sheet's row so the message can cite it.
      expect(p.assignments).toHaveLength(1)
    })

    it("refuses a whole mismatched sheet rather than assigning a lucky few", () => {
      const p = planCharacterAssignments({ rows, cells: [cell("x", 500), cell("y", 600)] })
      expect(p.assignments).toEqual([])
      expect(p.unmatchedRows).toEqual([2, 3])
    })

    it("does not use row COUNT as the test", () => {
      // Equal counts, both wrong. A count check would wave this through; and
      // it would refuse a good file the moment anything legitimately differed.
      const p = planCharacterAssignments({ rows, cells: [cell("x", 500), cell("y", 600)] })
      expect(rows).toHaveLength(2)
      expect(p.unmatchedRows).toHaveLength(2)
    })

    it("refuses a row whose timestamp will not parse", () => {
      const bad = readCharacterRows([HEADER, ["1", "t", "", "not a time", "", "JESUS.", "", ""]], COLS)
      const p = planCharacterAssignments({ rows: bad, cells: [cell("c1", 10)] })
      expect(p.unmatchedRows).toEqual([2])
    })
  })

  it("skips blank-character rows silently and counts them", () => {
    const withBlanks = readCharacterRows(
      [HEADER, row("00:00:10.000", ""), row("00:00:20.000", "MARY")],
      COLS,
    )
    const p = planCharacterAssignments({
      rows: withBlanks,
      cells: [cell("c1", 10), cell("c2", 20)],
    })
    expect(p.blankRows).toBe(1)
    expect(p.unmatchedRows).toEqual([])
    expect(p.assignments).toHaveLength(1)
  })

  describe("recovering a drifted row by position", () => {
    // From Sam's real import (2026-08-15): two of episode 101's rows sit
    // exactly 84ms after the cell they belong to — two frames at 23.976fps,
    // which is the minimum gap between adjacent cues. Widening the tolerance
    // would be the wrong fix, because 84ms IS the neighbour gap.
    const drifted = readCharacterRows(
      [
        HEADER,
        row("00:00:10.000", "A"),
        row("00:00:20.084", "B"), // 84ms late — misses cell c2 at 20.000
        row("00:00:30.000", "C"),
      ],
      COLS,
    )

    it("takes the one free cell its neighbours leave", () => {
      const p = planCharacterAssignments({
        rows: drifted,
        cells: [cell("c1", 10), cell("c2", 20), cell("c3", 30)],
      })
      expect(p.unmatchedRows).toEqual([])
      expect(p.filledByPosition).toBe(1)
      expect(p.assignments.map((a) => a.cellId)).toEqual(["c1", "c2", "c3"])
    })

    it("keeps the assignments in sheet order after filling", () => {
      const p = planCharacterAssignments({
        rows: drifted,
        cells: [cell("c1", 10), cell("c2", 20), cell("c3", 30)],
      })
      expect(p.assignments.map((a) => a.rowNumber)).toEqual([2, 3, 4])
    })

    it("REFUSES rather than guessing when the gap holds two candidates", () => {
      // Two free cells is a guess, and a guess here puts a performance on the
      // wrong line.
      const p = planCharacterAssignments({
        rows: drifted,
        cells: [cell("c1", 10), cell("c2a", 20), cell("c2b", 25), cell("c3", 30)],
      })
      expect(p.filledByPosition).toBe(0)
      expect(p.unmatchedRows).toEqual([3])
    })

    it("cannot rescue a wrong-episode sheet, which is the point", () => {
      // Nothing matches, so nothing brackets anything and the second pass has
      // no neighbours to reason from. The refusal survives intact.
      const p = planCharacterAssignments({
        rows: drifted,
        cells: [cell("x", 500), cell("y", 600), cell("z", 700)],
      })
      expect(p.filledByPosition).toBe(0)
      expect(p.unmatchedRows).toEqual([2, 3, 4])
    })

    it("does not fill at the ends, where there is nothing on one side", () => {
      const ends = readCharacterRows(
        [HEADER, row("00:00:05.500", "First"), row("00:00:20.000", "B")],
        COLS,
      )
      const p = planCharacterAssignments({ rows: ends, cells: [cell("c1", 5), cell("c2", 20)] })
      expect(p.filledByPosition).toBe(0)
      expect(p.unmatchedRows).toEqual([2])
    })
  })

  it("counts the cast", () => {
    const p = planCharacterAssignments({ rows, cells: [cell("c1", 10), cell("c2", 20)] })
    expect(p.distinctCharacters).toBe(2)
  })

  it("keeps the tolerance well inside the gap between neighbouring cues", () => {
    // Two frames at 23.976fps is ~83ms; the tolerance must not reach a
    // neighbour or a row could land on the wrong line.
    expect(MATCH_TOLERANCE_MS).toBeLessThan(40)
  })
})

// ── The real workbook ────────────────────────────────────────────────────
// Client source files live outside the repo so they are never committed.
const MEDIA = path.join(os.homedir(), "Code", "aquilla-app", "the-chosen-media", "101")
const XLSX = path.join(MEDIA, "101_split subs_characters.xlsx")
const VTT = path.join(MEDIA, "TheChosen_101_en_5&2.vtt")
const haveSamples = fs.existsSync(XLSX) && fs.existsSync(VTT)

const TS = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->/
function vttStarts(file: string): { cellId: string; startTime: number }[] {
  const out: { cellId: string; startTime: number }[] = []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.trim().match(TS)
    if (!m) continue
    out.push({
      cellId: `cell-${out.length}`,
      startTime: (+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
    })
  }
  return out
}

describe.skipIf(!haveSamples)("against The Chosen episode 101", () => {
  it("reads, keys and assigns the whole episode", async () => {
    const buf = fs.readFileSync(XLSX)
    const sheets = await parseXlsxToSheets(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    )
    const sheet = sheets[0]
    expect(sheet.rows).toHaveLength(651) // 650 data rows + header

    const cols = guessCharacterColumns(sheet.rows[0])!
    expect(cols).toEqual({ character: 5, camera: 7, start: 3, range: 4, text: 1 })

    const rows = readCharacterRows(sheet.rows, cols)
    expect(rows).toHaveLength(650)

    const plan = planCharacterAssignments({ rows, cells: vttStarts(VTT) })

    // EVERY row keys onto a cell. This is the claim the whole feature rests on,
    // and it is luck rather than contract — which is why an unmatched row
    // refuses rather than warning.
    expect(plan.unmatchedRows).toEqual([])
    // The 13 screen-text cards carry no character.
    expect(plan.blankRows).toBe(13)
    // Against the RAW VTT everything matches on timestamp. The imported cells
    // are what drift (see the dialog test) — this file needs no filling.
    expect(plan.filledByPosition).toBe(0)
    expect(plan.assignments).toHaveLength(637)
    // The camera column and the embedded angle never disagree in this file.
    expect(plan.cameraDisagreements).toBe(0)
    // 41 distinct NAMES. The roadmap recorded "48 characters in ep101", which
    // counted raw labels — the same person appears as both "JESUS.  (On)" and
    // "JESUS.  (Off)", so splitting the angle collapses seven of them. 41 is
    // the number the cast gutter and the export voice filter actually see.
    expect(plan.distinctCharacters).toBe(41)
  })
})
