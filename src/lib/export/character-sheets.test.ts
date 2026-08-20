// Giving Anna her character sheets back. (AQU-646, 2026-08-19; annotations
// dropped 2026-08-20)
//
// Two kinds of assertion here, and the second kind matters more.
//
// The first kind pins her file formats — the column set, the gaps, the casing
// — measured from her real workbooks, because these are strings something
// downstream may match on and "close enough" is not a standard this export
// gets to hold itself to.
//
// The second kind checks the things this export REFUSES to do: it does not
// add columns her file never had (the "Changed" annotations were built and
// then dropped on Sam's call), it does not fill in a blank character from the
// other team's file, and it does not carry the subtitle sheet's trailing
// period into the audio sheet when a resolution crossed sides. Every one of
// those guards a way of quietly corrupting a document the client is about to
// treat as her own team's work.

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildAudioSheet,
  buildCharacterSheets,
  buildSubtitleSheet,
  type CharacterSheetsArgs,
} from "./character-sheets"
import type { XlsxSheet } from "./xlsx-write"
import type { CellData } from "@/hooks/useCells"
import type { CameraState } from "@/lib/sync/cells-read-types"
import { parseXlsxToSheets, splitCastName } from "@/lib/parsers/spreadsheet"
import { guessCharacterColumns, readCharacterRows } from "@/lib/import/character-sheet"

// ─── Fixtures ────────────────────────────────────────────────────────────────

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c",
    fileId: "f",
    original: "",
    translated: "",
    context: "",
    group: "",
    type: "cue",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...over,
  }
}

/** A cell one of the character sheets has named, with a place on the clock. */
const named = (
  id: string,
  castName: string,
  cameraState?: CameraState,
  over: Partial<CellData> = {},
): CellData =>
  cell({
    id,
    metadata: { cast_name: castName },
    startTime: 1,
    endTime: 2,
    ...(cameraState ? { cameraState } : {}),
    ...over,
  })

const args = (over: Partial<CharacterSheetsArgs> = {}): CharacterSheetsArgs => ({
  textCells: [],
  cueCells: [],
  ...over,
})

// Her columns, by position, so a test reads as "the character cell" rather
// than "row 0 column 5".
const SUB = {
  id: 0,
  source: 1,
  endTime: 2,
  startTime: 3,
  timeStamp: 4,
  character: 5,
  vttClosest: 6,
  camera: 7,
} as const
const AUDIO = {
  line: 0,
  startTime: 1,
  endTime: 2,
  character: 3,
  translation: 4,
  camera: 5,
} as const

const valueAt = (sheet: XlsxSheet, row: number, column: number) => sheet.rows[row][column].value

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("the sheets go back in her columns and nothing else", () => {
  // The first cut appended a "Changed" column (`was ANDREW`, `unresolved`) and
  // highlighted every corrected cell. Sam, after reading the real output
  // (2026-08-20): "I don't think it's necessary to note that something was or
  // wasn't resolved or what it used to be." So the header row is HERS, exactly
  // — a column her pipeline has never seen is a change she did not ask for.

  it("adds no Changed column to either sheet", () => {
    expect(buildSubtitleSheet(args()).headers).toEqual([
      "ID",
      "Source",
      "endTime",
      "startTime",
      "timeStamp",
      "Character Label",
      "VTT_closest",
      "Camera",
    ])
    expect(buildAudioSheet(args()).headers).toEqual([
      "Line #",
      "startTime",
      "endTime",
      "Character",
      "Translation",
      "Camera",
    ])
  })

  it("marks nothing — a corrected value simply sits where the wrong one was", () => {
    // After a resolution both cells hold the winner; the sheet's only job is
    // to carry that value out, unannotated.
    const sheet = buildAudioSheet(args({ cueCells: [named("c1", "NICODEMUS", "on")] }))
    expect(valueAt(sheet, 0, AUDIO.character)).toBe("NICODEMUS\u00a0   (ON)")
    expect(sheet.rows[0]).toHaveLength(6)
    expect(sheet.rows[0].every((c) => c.highlight !== true)).toBe(true)
  })

  it("hands an unresolved line back with whatever each team wrote", () => {
    // Resolving is the only operation that writes a value across the two
    // sheets, so a link still in dispute keeps both original answers — the
    // old safety rule, now enforced by structure rather than by a marker.
    const sub = buildSubtitleSheet(args({ textCells: [named("s1", "JESUS.", "on")] }))
    const audio = buildAudioSheet(args({ cueCells: [named("c1", "MARY", "on")] }))
    expect(valueAt(sub, 0, SUB.character)).toBe("JESUS.  (On)")
    expect(valueAt(audio, 0, AUDIO.character)).toBe("MARY\u00a0   (ON)")
  })

  it("does not fill a blank character in from anywhere", () => {
    // Her subtitle sheet leaves "Character Label" empty on most rows. Writing
    // a name into it would be merging the other team's document into hers,
    // not correcting hers.
    const sheet = buildSubtitleSheet(args({ textCells: [cell({ id: "s1", startTime: 1, endTime: 2 })] }))
    expect(valueAt(sheet, 0, SUB.character)).toBe("")
  })
})

describe("her own Line #, given back", () => {
  // Her audio sheet numbers lines 10 to 710 across 548 rows — production
  // numbering with 86 gaps where lines were cut, none of it derivable. The
  // importer stores each row's number on its cue; this writes it back.
  const numbered = (id: string, line: string, startTime: number): CellData =>
    cell({
      id,
      metadata: { cast_name: "JESUS", line_number: line },
      startTime,
      endTime: startTime + 1,
    })

  it("writes her numbers, gaps and all, instead of counting rows", () => {
    const sheet = buildAudioSheet(
      args({ cueCells: [numbered("c1", "10", 1), numbered("c2", "12", 2), numbered("c3", "47", 3)] }),
    )
    expect(sheet.rows.map((r) => r[AUDIO.line].value)).toEqual([10, 12, 47])
  })

  it("writes them as numbers, so her column still sorts like a number", () => {
    const sheet = buildAudioSheet(args({ cueCells: [numbered("c1", "10", 1)] }))
    expect(valueAt(sheet, 0, AUDIO.line)).toBe(10)
  })

  it("keeps a number that is not an integer as text rather than coercing it", () => {
    // A "10a" would become NaN under Number(); as text it survives intact.
    const sheet = buildAudioSheet(args({ cueCells: [numbered("c1", "10a", 1)] }))
    expect(valueAt(sheet, 0, AUDIO.line)).toBe("10a")
  })

  it("leaves a line added in the app blank rather than inventing a number", () => {
    // It has no number in her production. Inventing one is how a spreadsheet
    // starts lying about which line is which.
    const sheet = buildAudioSheet(
      args({ cueCells: [numbered("c1", "10", 1), named("c2", "MARY", "on", { startTime: 2, endTime: 3 })] }),
    )
    expect(sheet.rows.map((r) => r[AUDIO.line].value)).toEqual([10, ""])
  })

  it("falls back to counting when the file predates the change entirely", () => {
    // Every cue imported before 2026-08-20 carries no number at all. A column
    // of 548 blanks would be strictly less useful than our own count, so the
    // decision is made per FILE, not per row.
    const sheet = buildAudioSheet(
      args({
        cueCells: [
          named("c1", "JESUS", "on", { startTime: 1, endTime: 2 }),
          named("c2", "MARY", "on", { startTime: 2, endTime: 3 }),
        ],
      }),
    )
    expect(sheet.rows.map((r) => r[AUDIO.line].value)).toEqual([1, 2])
  })
})

describe("Group, her fourth camera label", () => {
  // Both importers folded Group into `mixed` until 2026-08-20, so this column
  // could only ever say three of her four words.
  it("writes Group in the audio sheet's own casing", () => {
    const sheet = buildAudioSheet(args({ cueCells: [named("c1", "CROWD", "group")] }))
    expect(valueAt(sheet, 0, AUDIO.camera)).toBe("Group")
    expect(valueAt(sheet, 0, AUDIO.character)).toBe("CROWD\u00a0   (Group)")
  })

  it("writes it in the subtitle sheet too", () => {
    const sheet = buildSubtitleSheet(args({ textCells: [named("s1", "CROWD.", "group")] }))
    expect(valueAt(sheet, 0, SUB.camera)).toBe("Group")
    expect(valueAt(sheet, 0, SUB.character)).toBe("CROWD.  (Group)")
  })

  it("round-trips through our own importer as Group, not mixed", () => {
    const written = String(
      valueAt(buildAudioSheet(args({ cueCells: [named("c1", "CROWD", "group")] })), 0, AUDIO.character),
    )
    expect(splitCastName(written)).toEqual({ voice: "CROWD", cameraState: "group" })
  })
})

describe("the trailing period that must not cross sheets", () => {
  // Her two sheets spell names differently: every subtitle name ends in a full
  // stop (`NICODEMUS.`, 637 of 650 rows) and no audio name does (0 of 548).
  // Resolving writes the winning string onto BOTH cells, so a dispute the
  // subtitle side won leaves `NICODEMUS.` on the audio cue — which is exactly
  // how Sam's first real export came out. (Sam, 2026-08-20: strip it.)

  it("strips the period the subtitle side's win carried onto the cue", () => {
    const sheet = buildAudioSheet(args({ cueCells: [named("c1", "NICODEMUS.", "on")] }))
    expect(valueAt(sheet, 0, AUDIO.character)).toBe("NICODEMUS\u00a0   (ON)")
  })

  it("strips it from a name with no angle too", () => {
    const sheet = buildAudioSheet(args({ cueCells: [named("c1", "NICODEMUS.")] }))
    expect(valueAt(sheet, 0, AUDIO.character)).toBe("NICODEMUS")
  })

  it("leaves the subtitle sheet's own period alone — it is her convention", () => {
    const sheet = buildSubtitleSheet(args({ textCells: [named("s1", "NICODEMUS.", "on")] }))
    expect(valueAt(sheet, 0, SUB.character)).toBe("NICODEMUS.  (On)")
  })

  it("writes the stripped name in a form her audio pipeline reads back", () => {
    const written = String(
      valueAt(buildAudioSheet(args({ cueCells: [named("c1", "NICODEMUS.", "on")] })), 0, AUDIO.character),
    )
    expect(splitCastName(written)).toEqual({ voice: "NICODEMUS", cameraState: "on" })
  })
})

describe("the camera angle her audio sheet writes inside the character name", () => {
  const characterFor = (state: "on" | "off" | "mixed" | undefined) =>
    String(valueAt(buildAudioSheet(args({ cueCells: [named("c1", "LITTLE MARY MAGDALENE", state)] })), 0, AUDIO.character))

  it("writes a name our own importer reads back unchanged", () => {
    // The writer and `splitCastName` live far apart and nothing else would
    // notice them drifting — but a sheet we exported and she re-imports would
    // silently lose every camera angle in the episode.
    for (const state of ["on", "off", "mixed"] as const) {
      expect(splitCastName(characterFor(state))).toEqual({
        voice: "LITTLE MARY MAGDALENE",
        cameraState: state,
      })
    }
  })

  it("uses her non-breaking gap and her own casing, measured from the file", () => {
    expect(characterFor("on")).toBe("LITTLE MARY MAGDALENE\u00a0   (ON)")
  })

  it("leaves the brackets off a character whose angle nobody has decided", () => {
    // An empty "()" is not something splitCastName matches, and "(UNKNOWN)"
    // would be inventing an answer.
    expect(characterFor(undefined)).toBe("LITTLE MARY MAGDALENE")
    expect(splitCastName(characterFor(undefined)).cameraState).toBeUndefined()
  })
})

describe("the order the rows come out in", () => {
  it("puts the lines where they are heard, however they arrived", () => {
    const sheet = buildSubtitleSheet(
      args({
        textCells: [
          named("s3", "MARY", "on", { startTime: 30, endTime: 31, original: "third" }),
          named("s1", "JESUS", "on", { startTime: 10, endTime: 11, original: "first" }),
          named("s2", "ANDREW", "on", { startTime: 20, endTime: 21, original: "second" }),
        ],
      }),
    )
    expect(sheet.rows.map((r) => r[SUB.source].value)).toEqual(["first", "second", "third"])
    expect(sheet.rows.map((r) => r[SUB.id].value)).toEqual([1, 2, 3])
  })

  it("puts a line with no time of its own at the end, not at the top of the episode", () => {
    // Sorting an untimed line as second zero would file it before the first
    // spoken word, where nobody would think to look for it.
    const sheet = buildAudioSheet(
      args({
        cueCells: [
          named("c2", "MARY", "on", { startTime: undefined, endTime: undefined, original: "untimed" }),
          named("c1", "JESUS", "on", { startTime: 10, endTime: 11, original: "timed" }),
        ],
      }),
    )
    expect(sheet.rows.map((r) => r[AUDIO.translation].value)).toEqual(["timed", "untimed"])
    expect(valueAt(sheet, 1, AUDIO.startTime)).toBe("")
  })

  it("writes the times the way both of her sheets write them", () => {
    const sheet = buildSubtitleSheet(
      args({ textCells: [named("s1", "JESUS", "on", { startTime: 22.94, endTime: 24.441 })] }),
    )
    expect(valueAt(sheet, 0, SUB.startTime)).toBe("00:00:22.940")
    expect(valueAt(sheet, 0, SUB.endTime)).toBe("00:00:24.441")
    expect(valueAt(sheet, 0, SUB.timeStamp)).toBe("00:00:22.940 --> 00:00:24.441")
  })
})

describe("the workbook that actually leaves the building", () => {
  const input = args({
    textCells: [named("s1", "JESUS.", "on", { original: "Come and see." })],
    cueCells: [named("c1", "JESUS", "on", { original: "Ven y ve." })],
  })

  it("opens through our own xlsx reader with both of her sheets on it", async () => {
    // Round-tripped through the reader rather than asserted on the builders,
    // because the builders agreeing with themselves proves nothing about a file
    // Excel has to open. See `xlsx-write.test.ts` for the same argument at
    // length.
    const blob = await buildCharacterSheets(input)
    const sheets = await parseXlsxToSheets(await blob.arrayBuffer())
    expect(sheets.map((s) => s.name)).toEqual(["Subtitle characters", "Audio characters"])
    expect(sheets[0].rows[0]).toEqual([
      "ID",
      "Source",
      "endTime",
      "startTime",
      "timeStamp",
      "Character Label",
      "VTT_closest",
      "Camera",
    ])
    expect(sheets[1].rows[0]).toEqual([
      "Line #",
      "startTime",
      "endTime",
      "Character",
      "Translation",
      "Camera",
    ])
  })

  it("carries the values all the way into the file", async () => {
    const blob = await buildCharacterSheets(input)
    const sheets = await parseXlsxToSheets(await blob.arrayBuffer())
    // Row 1 is the header; row 2 is the only line in this fixture.
    expect(sheets[0].rows[1][SUB.character]).toBe("JESUS.  (On)")
    expect(sheets[1].rows[1][AUDIO.character]).toBe("JESUS\u00a0   (ON)")
  })

  it("leaves out the frame-grid timecodes rather than guessing at them", async () => {
    // We store seconds; her "TC In (orig)" is a frame grid whose rate is not
    // always recoverable. A timecode two frames out in the back half of the
    // episode is invisible until somebody conforms an edit against it, which is
    // worse than a column that is obviously not there.
    const blob = await buildCharacterSheets(input)
    const sheets = await parseXlsxToSheets(await blob.arrayBuffer())
    expect(sheets[1].rows[0]).not.toContain("TC In (orig)")
    expect(sheets[1].rows[0]).not.toContain("TC Out (orig)")
  })

  it("still produces a workbook for an episode whose sheets have no rows yet", async () => {
    // An empty sheet is a valid answer — "we looked and there is nothing here"
    // — and a throw would take the whole export down with it.
    const blob = await buildCharacterSheets(args())
    const sheets = await parseXlsxToSheets(await blob.arrayBuffer())
    expect(sheets).toHaveLength(2)
    expect(sheets[0].rows).toHaveLength(1)
  })
})

// ── Measured against her actual workbooks (2026-08-19) ───────────────────
//
// Counted from `~/Code/aquilla-app/the-chosen-media/101/`:
//
//   audio sheet   `LITTLE MARY MAGDALENE\u00a0   (ON)`   548 rows, NBSP + 3 spaces
//                 camera column `ON` (329) but `Off` (112), `Mixed` (100)
//   subtitle      `LITTLE MARY MAGDALENE.  (Mixed)`      637 of 650 rows, 2 spaces
//                 camera column `On` (333), `Off` (141), `Mixed` (151)

describe("the formats measured from her own files", () => {
  const line = (over: Partial<CellData>) =>
    cell({ id: "s1", startTime: 63.209, endTime: 63.667, ...over })

  it("writes the audio name with a non-breaking space before the angle", () => {
    const sheet = buildAudioSheet(
      args({ cueCells: [line({ id: "c1", metadata: { cast_name: "LITTLE MARY MAGDALENE" }, cameraState: "on" })] }),
    )
    expect(sheet.rows[0]![AUDIO.character]!.value).toBe("LITTLE MARY MAGDALENE\u00a0   (ON)")
  })

  it("writes the subtitle label with its angle too, two plain spaces", () => {
    const sheet = buildSubtitleSheet(
      args({ textCells: [line({ metadata: { cast_name: "LITTLE MARY MAGDALENE." }, cameraState: "mixed" })] }),
    )
    expect(sheet.rows[0]![SUB.character]!.value).toBe("LITTLE MARY MAGDALENE.  (Mixed)")
  })

  it("shouts ON but not OFF, which is her house style and not a typo", () => {
    const of = (state: "on" | "off" | "mixed") =>
      buildAudioSheet(
        args({ cueCells: [line({ id: "c1", metadata: { cast_name: "X" }, cameraState: state })] }),
      ).rows[0]![AUDIO.camera]!.value
    expect(of("on")).toBe("ON")
    expect(of("off")).toBe("Off")
    expect(of("mixed")).toBe("Mixed")
  })

  it("keeps her VTT_closest column rather than quietly dropping it", () => {
    const sheet = buildSubtitleSheet(args({ textCells: [line({ metadata: { cast_name: "X" } })] }))
    expect(sheet.headers).toContain("VTT_closest")
    expect(sheet.rows[0]![SUB.vttClosest]!.value).toBe("00:01:03.209 --> 00:01:03.667")
  })

  it("writes a name our own importer can read the angle back out of", () => {
    // The two files are far apart and nothing else would notice them drifting.
    const written = buildAudioSheet(
      args({ cueCells: [line({ id: "c1", metadata: { cast_name: "MARY MAGDALENE'S FATHER" }, cameraState: "on" })] }),
    ).rows[0]![AUDIO.character]!.value as string
    const back = splitCastName(written)
    expect(back.voice).toBe("MARY MAGDALENE'S FATHER")
    expect(back.cameraState).toBe("on")
  })
})

// ── Round-tripped through her actual workbook (2026-08-20) ──────────────────
//
// Every fixture above was written by the same hand as the code, so the two
// agreeing proves only that they agree. This one starts from the file the
// client actually sent, walks it through the importer and back out through the
// exporter, and compares the two columns that were losing information a day
// ago against hers, cell for cell.

describe("against The Chosen episode 101", () => {
  const XLSX = path.join(
    os.homedir(), "Code", "aquilla-app", "the-chosen-media", "101",
    "101_audio_DL_camera_CODEX.xlsx",
  )
  const haveSample = fs.existsSync(XLSX)

  /** Her rows, read the way the importer reads them, then turned into the cue
   *  cells the projection would have left behind. */
  async function cuesFromHerWorkbook(): Promise<{ hers: string[][]; cells: CellData[] }> {
    const buf = fs.readFileSync(XLSX)
    const sheets = await parseXlsxToSheets(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    )
    const cols = guessCharacterColumns(sheets[0].rows[0])!
    const rows = readCharacterRows(sheets[0].rows, cols)
    const cells = rows.map((r, i) =>
      cell({
        id: `c${i}`,
        original: r.text,
        startTime: i,
        endTime: i + 0.5,
        metadata: {
          cast_name: r.castName,
          ...(r.lineNumber ? { line_number: r.lineNumber } : {}),
        },
        ...(r.cameraState ? { cameraState: r.cameraState } : {}),
      }),
    )
    return { hers: sheets[0].rows, cells }
  }

  it.skipIf(!haveSample)("gives her Line # column back exactly as she sent it", async () => {
    const { hers, cells } = await cuesFromHerWorkbook()
    const sheet = buildAudioSheet(args({ cueCells: cells }))
    const mine = sheet.rows.map((r) => String(r[AUDIO.line].value))
    // Her column, minus the header. Numbers arrive from the reader as strings.
    const theirs = hers.slice(1).map((r) => String(Number(r[0])))
    expect(mine).toEqual(theirs)
    // And spot-check the shape everyone keeps getting wrong: it starts at 10,
    // not 1, and it skips.
    expect(mine[0]).toBe("10")
    expect(mine[mine.length - 1]).toBe("710")
  })

  it.skipIf(!haveSample)("gives her Camera column back, all four words", async () => {
    const { hers, cells } = await cuesFromHerWorkbook()
    const sheet = buildAudioSheet(args({ cueCells: cells }))
    const mine = sheet.rows.map((r) => String(r[AUDIO.camera].value))
    const theirs = hers.slice(1).map((r) => (r[5] ?? "").trim())
    expect(mine).toEqual(theirs)
    // Including the seven Group rows that used to come back as Mixed.
    expect(mine.filter((c) => c === "Group")).toHaveLength(7)
  })
})
