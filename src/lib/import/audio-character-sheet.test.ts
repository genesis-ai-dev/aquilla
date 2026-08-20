// The audio character sheet: characters keyed to the HEARD lines.
// (AQU-646, 2026-08-18)
//
// This sheet is a mirror of the audio VTT, so the assertions are mostly about
// that staying true — and about the one refusal that matters, a sheet from a
// different episode. The last block runs against the REAL episode-101 workbook
// and pins what was measured off it; it skips itself when the file is absent.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect } from "vitest"

import { planAudioCharacterAssignments, type AlignableCue } from "./audio-character-sheet"
import { guessCharacterColumns, readCharacterRows, type CharacterSheetColumns } from "./character-sheet"
import { parseXlsxToSheets } from "@/lib/parsers/spreadsheet"

const HEADER = ["Line #", "startTime", "endTime", "Character", "Translation", "Camera"]
const COLS: CharacterSheetColumns = {
  character: 3,
  camera: 5,
  start: 1,
  range: null,
  text: 4,
  lineNumber: 0,
}

const row = (start: string, character: string, text: string, camera = ""): string[] =>
  ["10", start, "", character, text, camera]

const cue = (id: string, startTime: number, original: string): AlignableCue =>
  ({ id, startTime, original })

const rows = (...rs: string[][]) => readCharacterRows([HEADER, ...rs], COLS)

describe("matching the sheet's rows to the heard lines", () => {
  it("assigns each row to the cue that says the same words", () => {
    const p = planAudioCharacterAssignments({
      rows: rows(
        row("00:01:03.209", "LITTLE MARY MAGDALENE    (ON)", "Abba?", "ON"),
        row("00:01:06.626", "MARY MAGDALENE'S FATHER    (ON)", "You should be sleeping, little one.", "ON"),
      ),
      cues: [
        cue("c1", 63.272, "Abba?"),
        cue("c2", 66.693, "You should be sleeping, little one."),
      ],
    })
    expect(p.assignments).toEqual([
      // `lineNumber` is HER `Line #`, carried from column 0 — the fixture rows
      // all say "10", the number episode 101's audio sheet really starts at.
      { cellId: "c1", castName: "LITTLE MARY MAGDALENE", cameraState: "on", rowNumber: 2, lineNumber: "10" },
      { cellId: "c2", castName: "MARY MAGDALENE'S FATHER", cameraState: "on", rowNumber: 3, lineNumber: "10" },
    ])
    expect(p.unmatchedRows).toEqual([])
    expect(p.filledByPosition).toBe(0)
  })

  it("carries her own Line # through to the assignment", () => {
    // The number her production uses, not a count of rows. Episode 101's runs
    // 10 to 710 across 548 lines with 86 gaps in it, so nothing about it can
    // be derived — an export that does not store it renumbers her whole file.
    const p = planAudioCharacterAssignments({
      rows: readCharacterRows(
        [HEADER, ["47", "00:01:03.209", "", "JESUS (ON)", "Abba?", "ON"]],
        COLS,
      ),
      cues: [cue("c1", 63.272, "Abba?")],
    })
    expect(p.assignments[0].lineNumber).toBe("47")
  })

  it("leaves the line number off entirely when her sheet has no such column", () => {
    // The subtitle sheet. Undefined rather than a fabricated count, so the
    // writer can tell "she gave us no number" from "her number is 1".
    const noLineCol: CharacterSheetColumns = { ...COLS, lineNumber: null }
    const p = planAudioCharacterAssignments({
      rows: readCharacterRows(
        [HEADER, ["47", "00:01:03.209", "", "JESUS (ON)", "Abba?", "ON"]],
        noLineCol,
      ),
      cues: [cue("c1", 63.272, "Abba?")],
    })
    expect(p.assignments[0].lineNumber).toBeUndefined()
  })

  it("matches on the WORDS, not the clock", () => {
    // The sheet carries the delivered file's own 24fps times; the cues have
    // been corrected onto the subtitles' 23.976 and sit up to three seconds
    // later. Keying on time would be wrong by exactly the drift the import
    // just removed.
    const p = planAudioCharacterAssignments({
      rows: rows(row("00:40:00.000", "JESUS (ON)", "Come, follow me.", "ON")),
      cues: [cue("c1", 2402.4, "Come, follow me.")],
    })
    expect(p.assignments).toHaveLength(1)
  })

  it("keeps Group as Group — her fourth camera label, not a flavour of mixed", () => {
    const p = planAudioCharacterAssignments({
      rows: rows(row("00:10:52.626", "STUDENT #1    (Group)", "Rabbi.", "Group")),
      cues: [cue("c1", 653.3, "Rabbi.")],
    })
    expect(p.assignments[0].cameraState).toBe("group")
  })

  it("does not pair two identical lines by their order in the file alone", () => {
    // An episode carries dozens of bare "Yes." lines. Plain longest-common-
    // subsequence takes the earliest equally-long reading, which would put a
    // character from 0:50 onto a line at 1:30. Proximity settles it.
    const p = planAudioCharacterAssignments({
      rows: rows(
        row("00:00:50.000", "SIMON (ON)", "Yes.", "ON"),
        row("00:01:30.000", "ANDREW (ON)", "Yes.", "ON"),
      ),
      cues: [cue("early", 50.05, "Yes."), cue("late", 90.09, "Yes.")],
    })
    expect(p.assignments.map((a) => `${a.cellId}:${a.castName}`)).toEqual([
      "early:SIMON",
      "late:ANDREW",
    ])
  })

  it("counts a cue the sheet does not cover, without complaining", () => {
    const p = planAudioCharacterAssignments({
      rows: rows(row("00:00:10.000", "JESUS (ON)", "Come, follow me.", "ON")),
      cues: [cue("c1", 10, "Come, follow me."), cue("c2", 20, "Whoa!")],
    })
    expect(p.cuesWithoutRow).toBe(1)
    expect(p.unmatchedRows).toEqual([])
  })

  it("skips a row with a line but no character, and counts it", () => {
    const p = planAudioCharacterAssignments({
      rows: rows(row("00:00:10.000", "", "[door slams]"), row("00:00:20.000", "JESUS (ON)", "Peace.", "ON")),
      cues: [cue("c1", 10, "[door slams]"), cue("c2", 20, "Peace.")],
    })
    expect(p.blankRows).toBe(1)
    expect(p.assignments).toHaveLength(1)
    expect(p.unmatchedRows).toEqual([])
  })

  it("carries the camera disagreement count through", () => {
    const p = planAudioCharacterAssignments({
      rows: rows(row("00:00:10.000", "JESUS (ON)", "Peace.", "Off")),
      cues: [cue("c1", 10, "Peace.")],
    })
    expect(p.cameraDisagreements).toBe(1)
    expect(p.assignments[0].cameraState).toBe("off")
  })

  it("recovers a re-transcribed row from the lines either side of it", () => {
    // The middle row's wording differs, so it matches nothing. Its neighbours
    // are pinned and bracket exactly one spare cue, which is therefore the
    // partner — refusing a whole sheet over one re-typed line would be brittle
    // without being any safer.
    const p = planAudioCharacterAssignments({
      rows: rows(
        row("00:00:10.000", "MARY (ON)", "Rabbi.", "ON"),
        row("00:00:20.000", "JESUS (ON)", "Come and follow me now.", "ON"),
        row("00:00:30.000", "SIMON (ON)", "Yes, Rabbi.", "ON"),
      ),
      cues: [
        cue("c1", 10, "Rabbi."),
        cue("c2", 20, "Come, follow me."),
        cue("c3", 30, "Yes, Rabbi."),
      ],
    })
    expect(p.assignments.map((a) => a.cellId)).toEqual(["c1", "c2", "c3"])
    expect(p.filledByPosition).toBe(1)
    expect(p.unmatchedRows).toEqual([])
  })

  it("will not guess inside a WIDE hole", () => {
    // Two unmatched rows against two spare cues: either order is possible and
    // getting it wrong puts a character on somebody else's line.
    const p = planAudioCharacterAssignments({
      rows: rows(
        row("00:00:10.000", "MARY (ON)", "Rabbi.", "ON"),
        row("00:00:20.000", "JESUS (ON)", "Come and follow me now.", "ON"),
        row("00:00:25.000", "SIMON (ON)", "We will follow.", "ON"),
        row("00:00:30.000", "ANDREW (ON)", "Yes, Rabbi.", "ON"),
      ),
      cues: [
        cue("c1", 10, "Rabbi."),
        cue("c2", 20, "Come, follow me."),
        cue("c3", 25, "We shall follow."),
        cue("c4", 30, "Yes, Rabbi."),
      ],
    })
    expect(p.filledByPosition).toBe(0)
    expect(p.unmatchedRows).toEqual([3, 4])
  })
})

describe("the refusal", () => {
  it("REFUSES a sheet whose rows match no cue — the wrong-episode signal", () => {
    const p = planAudioCharacterAssignments({
      rows: rows(
        row("00:00:10.000", "PILATE (ON)", "What is truth?", "ON"),
        row("00:00:20.000", "CLAUDIA (ON)", "You did not sleep.", "ON"),
      ),
      cues: [cue("c1", 10, "Abba?"), cue("c2", 20, "I can't sleep.")],
    })
    expect(p.assignments).toEqual([])
    expect(p.unmatchedRows).toEqual([2, 3])
  })

  it("does not count an uncovered BLANK row as a refusal", () => {
    // It had no character to give, so its being uncovered changes nothing.
    const p = planAudioCharacterAssignments({
      rows: rows(row("00:00:10.000", "", "[music]"), row("00:00:20.000", "JESUS (ON)", "Peace.", "ON")),
      cues: [cue("c2", 20, "Peace.")],
    })
    expect(p.unmatchedRows).toEqual([])
  })

  it("survives empty input on either side", () => {
    expect(planAudioCharacterAssignments({ rows: [], cues: [] }).assignments).toEqual([])
    expect(
      planAudioCharacterAssignments({
        rows: rows(row("00:00:10.000", "JESUS (ON)", "Peace.")),
        cues: [],
      }).assignments,
    ).toEqual([])
  })
})

// ── The real workbook ────────────────────────────────────────────────────
const MEDIA = path.join(os.homedir(), "Code", "aquilla-app", "the-chosen-media", "101")
const XLSX = path.join(MEDIA, "101_audio_DL_camera_CODEX.xlsx")
const VTT = path.join(MEDIA, "TheChosen_101_en_AUDIO_ONLY_5&2.vtt")
const haveSamples = fs.existsSync(XLSX) && fs.existsSync(VTT)

const TS = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->/
function readCues(file: string): AlignableCue[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  const out: AlignableCue[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(TS)
    if (!m) continue
    const text: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (t === "" || TS.test(t)) break
      text.push(t)
    }
    const raw = +(m[1] ?? 0) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
    // Stored as the import stores them: timebase-corrected onto 23.976. The
    // sheet's own times are NOT, which is the whole point of matching on words.
    out.push({ id: `c${out.length}`, startTime: raw * (24 / (24000 / 1001)), original: text.join(" ") })
  }
  return out
}

describe.skipIf(!haveSamples)("against The Chosen episode 101", () => {
  it("covers every heard line, with nothing left over", async () => {
    const buf = fs.readFileSync(XLSX)
    const sheets = await parseXlsxToSheets(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    )
    const cols = guessCharacterColumns(sheets[0].rows[0])!
    expect(cols.text).not.toBeNull()

    const cues = readCues(VTT)
    expect(cues).toHaveLength(548)

    const plan = planAudioCharacterAssignments({
      rows: readCharacterRows(sheets[0].rows, cols),
      cues,
    })
    // A perfect mirror: every row lands, every cue is covered, and every
    // matched pair says the same words.
    expect(plan.unmatchedRows).toEqual([])
    expect(plan.cuesWithoutRow).toBe(0)
    expect(plan.filledByPosition).toBe(0)
    expect(plan.assignments.length).toBeGreaterThan(540)
    // 43 distinct names, measured — against the subtitle sheet's 41.
    expect(plan.distinctCharacters).toBeGreaterThan(35)
    expect(plan.distinctCharacters).toBeLessThan(50)

    // THE ENTITY BUG THIS FEATURE FOUND. The workbook has no shared-strings
    // table and writes every cell as `t="str"`, so an apostrophe arrives as
    // `&apos;` unless the parser decodes that branch — and the roster would
    // then hold two spellings of one character.
    expect(plan.assignments.some((a) => a.castName.includes("&apos;"))).toBe(false)
    expect(plan.assignments.some((a) => a.castName.includes("'"))).toBe(true)
  })

  it("carries her real Line # column through, gaps and all", async () => {
    // THE MEASUREMENT BEHIND THE WHOLE FEATURE. Her numbering runs 10 to 710
    // across 548 rows, with 86 places where the next number is not the next
    // one — lines cut somewhere in her production. None of it is derivable,
    // which is why storing a starting number and counting up (the first idea)
    // would drift off her file by the second gap.
    const buf = fs.readFileSync(XLSX)
    const sheets = await parseXlsxToSheets(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    )
    const cols = guessCharacterColumns(sheets[0].rows[0])!
    // Detected from her real header text, not from a fixture written to match.
    expect(cols.lineNumber).toBe(0)

    const rows = readCharacterRows(sheets[0].rows, cols)
    const numbers = rows.map((r) => Number(r.lineNumber))
    expect(numbers).toHaveLength(548)
    expect(numbers[0]).toBe(10)
    expect(numbers[numbers.length - 1]).toBe(710)
    expect(numbers.some((n) => Number.isNaN(n))).toBe(false)
    const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1)
    expect(gaps).toHaveLength(86)

    // And it survives the matcher, which is what puts it on a cue.
    const plan = planAudioCharacterAssignments({ rows, cues: readCues(VTT) })
    expect(plan.assignments[0].lineNumber).toBe("10")
    expect(plan.assignments.every((a) => a.lineNumber !== undefined)).toBe(true)
  })

  it("reads her Group rows as Group rather than folding them into mixed", async () => {
    // 7 rows in this workbook, measured. They came back as `Mixed` in the
    // first corrected sheet Sam exported, which is what started this round.
    const buf = fs.readFileSync(XLSX)
    const sheets = await parseXlsxToSheets(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    )
    const cols = guessCharacterColumns(sheets[0].rows[0])!
    const rows = readCharacterRows(sheets[0].rows, cols)
    const group = rows.filter((r) => r.cameraState === "group")
    expect(group).toHaveLength(7)
    // All four of her camera words survive, and nothing became undefined.
    expect(new Set(rows.map((r) => r.cameraState))).toEqual(
      new Set(["on", "off", "mixed", "group"]),
    )
  })

  it("refuses the same workbook against a different episode's cues", async () => {
    const buf = fs.readFileSync(XLSX)
    const sheets = await parseXlsxToSheets(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    )
    const cols = guessCharacterColumns(sheets[0].rows[0])!
    const other = path.join(
      os.homedir(), "Code", "aquilla-app", "the-chosen-media", "306", "306_audio_timestamps.vtt",
    )
    if (!fs.existsSync(other)) return
    const plan = planAudioCharacterAssignments({
      rows: readCharacterRows(sheets[0].rows, cols),
      cues: readCues(other),
    })
    // Hundreds of rows with nowhere to go: the import must stop, not assign
    // whichever handful of "Yes." lines happened to coincide.
    expect(plan.unmatchedRows.length).toBeGreaterThan(300)
  })
})
