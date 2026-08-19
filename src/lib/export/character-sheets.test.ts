// Giving Anna her character sheets back. (AQU-646, 2026-08-19)
//
// Two kinds of assertion here, and the second kind matters more.
//
// The first kind checks that a corrected row is visibly corrected — the right
// cell highlighted, the old value named in the Changed column. Those are the
// tests that would fail if somebody rearranged the columns.
//
// The second kind checks the things this export REFUSES to do: it does not
// touch a line the two sheets are still arguing about, it does not claim a
// correction that never happened, and it does not fill in a blank character
// from the other team's file. Every one of those guards a way of quietly
// corrupting a document the client is about to treat as her own team's work,
// which is a failure nobody would notice until an episode was dubbed wrong.

import { describe, it, expect } from "vitest"

import {
  buildAudioSheet,
  buildCharacterSheets,
  buildSubtitleSheet,
  type CharacterSheetsArgs,
} from "./character-sheets"
import type { XlsxSheet } from "./xlsx-write"
import type { CellData } from "@/hooks/useCells"
import {
  buildCueLinkIndex,
  EMPTY_CUE_LINK_INDEX,
  type CueLink,
} from "@/lib/sync/cell-links-read"
import { resolutionKey } from "@/lib/timeline/character-agreement"
import { parseXlsxToSheets, splitCastName } from "@/lib/parsers/spreadsheet"

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
  cameraState?: "on" | "off" | "mixed",
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

const edge = (textCellId: string, cueCellId: string): CueLink => ({
  kind: "text-audio",
  fromFileId: "f-subs",
  fromCellId: textCellId,
  toFileId: "f-cues",
  toCellId: cueCellId,
  origin: "auto",
  confidence: 1,
})

const args = (over: Partial<CharacterSheetsArgs> = {}): CharacterSheetsArgs => ({
  textCells: [],
  cueCells: [],
  links: EMPTY_CUE_LINK_INDEX,
  settings: undefined,
  ...over,
})

/** One subtitle row linked to one cue row — the shape every disagreement takes. */
const onePair = (text: CellData, cue: CellData, over: Partial<CharacterSheetsArgs> = {}) =>
  args({
    textCells: [text],
    cueCells: [cue],
    links: buildCueLinkIndex([edge(text.id, cue.id)]),
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
  changed: 8,
} as const
const AUDIO = {
  line: 0,
  startTime: 1,
  endTime: 2,
  character: 3,
  translation: 4,
  camera: 5,
  changed: 6,
} as const

const valueAt = (sheet: XlsxSheet, row: number, column: number) => sheet.rows[row][column].value
const isHighlighted = (sheet: XlsxSheet, row: number, column: number) =>
  sheet.rows[row][column].highlight === true

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("the sheet whose answer was overruled", () => {
  // After a resolution BOTH cells hold the winner, so the fixtures below give
  // both sides the same value — that is what the app looks like the moment
  // after she clicks. The record is the only surviving trace of the argument.
  const settledOnAudio = onePair(
    named("s1", "JESUS", "on", { original: "Come and see." }),
    named("c1", "JESUS", "on", { original: "Ven y ve." }),
    {
      resolutions: {
        [resolutionKey("s1", "c1")]: { name: { chose: "audio", rejected: "MARY" }, at: 1000 },
      },
    },
  )

  it("shows the corrected name and names the value it replaced", () => {
    const sheet = buildSubtitleSheet(settledOnAudio)
    expect(valueAt(sheet, 0, SUB.character)).toBe("JESUS  (On)")
    expect(valueAt(sheet, 0, SUB.changed)).toBe("was MARY")
  })

  it("highlights the cell it changed, so the diff survives being printed", () => {
    expect(isHighlighted(buildSubtitleSheet(settledOnAudio), 0, SUB.character)).toBe(true)
  })

  it("leaves the sheet that was believed completely unmarked", () => {
    // The audio sheet says today what it said when she sent it. Marking it too
    // would tell her team to review a row nobody touched.
    const sheet = buildAudioSheet(settledOnAudio)
    expect(valueAt(sheet, 0, AUDIO.changed)).toBe("")
    expect(isHighlighted(sheet, 0, AUDIO.character)).toBe(false)
  })

  it("writes a camera correction in the words that sheet's own column uses", () => {
    // `chose: "subtitle"` means the AUDIO sheet lost, so its row is the one
    // that owes an explanation — and its columns shout, where the subtitle
    // sheet's are title case.
    const input = onePair(named("s1", "JESUS", "on"), named("c1", "JESUS", "on"), {
      resolutions: {
        [resolutionKey("s1", "c1")]: { camera: { chose: "subtitle", rejected: "off" }, at: 1000 },
      },
    })
    const audio = buildAudioSheet(input)
    expect(valueAt(audio, 0, AUDIO.camera)).toBe("ON")
    expect(valueAt(audio, 0, AUDIO.changed)).toBe("was Off")
    expect(isHighlighted(audio, 0, AUDIO.camera)).toBe(true)
    expect(buildSubtitleSheet(input).rows[0][SUB.changed].value).toBe("")
  })

  it("highlights the name cell when the CAMERA changed, because the angle is written inside it", () => {
    // Her audio sheet spells the character as "JESUS\u00a0   (ON)". Settling a
    // camera dispute rewrites the suffix in that very cell, and an unmarked
    // "(ON)" where her team wrote "(OFF)" is exactly the silent edit the
    // highlight exists to prevent.
    const audio = buildAudioSheet(
      onePair(named("s1", "JESUS", "on"), named("c1", "JESUS", "on"), {
        resolutions: {
          [resolutionKey("s1", "c1")]: { camera: { chose: "subtitle", rejected: "off" }, at: 1000 },
        },
      }),
    )
    expect(valueAt(audio, 0, AUDIO.character)).toBe("JESUS\u00a0   (ON)")
    expect(isHighlighted(audio, 0, AUDIO.character)).toBe(true)
  })

  it("says nothing at all about a line nobody ever argued about", () => {
    const sheet = buildSubtitleSheet(onePair(named("s1", "JESUS", "on"), named("c1", "JESUS", "on")))
    expect(valueAt(sheet, 0, SUB.changed)).toBe("")
    expect(isHighlighted(sheet, 0, SUB.character)).toBe(false)
  })

  it("does not claim a correction when the value never actually moved", () => {
    // A record whose rejected answer equals what the cell holds now is a record
    // of nothing — the resolution was undone, or the 2026-08-18 re-click bug
    // wrote the winner down as its own loser. "was JESUS" beside a cell reading
    // JESUS is not a diff; it is a reason to distrust every other row.
    const sheet = buildSubtitleSheet(
      onePair(named("s1", "JESUS", "on"), named("c1", "JESUS", "on"), {
        resolutions: {
          [resolutionKey("s1", "c1")]: { name: { chose: "audio", rejected: "JESUS" }, at: 1000 },
        },
      }),
    )
    expect(valueAt(sheet, 0, SUB.changed)).toBe("")
    expect(isHighlighted(sheet, 0, SUB.character)).toBe(false)
  })

  it("reads the decisions out of the project settings when the caller passes none", () => {
    const sheet = buildSubtitleSheet(
      onePair(named("s1", "JESUS", "on"), named("c1", "JESUS", "on"), {
        settings: {
          characterResolutions: {
            [resolutionKey("s1", "c1")]: { name: { chose: "audio", rejected: "MARY" }, at: 1000 },
          },
        },
      }),
    )
    expect(valueAt(sheet, 0, SUB.changed)).toBe("was MARY")
  })
})

describe("a disagreement nobody has settled yet", () => {
  // THE SAFETY RULE. Guessing here would produce a file that looks authoritative
  // and is wrong in places her team cannot find, which is worse than the errors
  // she started with — those at least are their own and recognisable.
  const open = onePair(
    named("s1", "JESUS", "on", { original: "Come and see." }),
    named("c1", "MARY", "on", { original: "Ven y ve." }),
  )

  it("hands the subtitle row back with the name its own team wrote", () => {
    const sheet = buildSubtitleSheet(open)
    expect(valueAt(sheet, 0, SUB.character)).toBe("JESUS  (On)")
    expect(valueAt(sheet, 0, SUB.changed)).toBe("unresolved")
    expect(isHighlighted(sheet, 0, SUB.character)).toBe(false)
  })

  it("hands the audio row back with the name its own team wrote", () => {
    const sheet = buildAudioSheet(open)
    expect(valueAt(sheet, 0, AUDIO.character)).toBe("MARY\u00a0   (ON)")
    expect(valueAt(sheet, 0, AUDIO.changed)).toBe("unresolved")
    expect(isHighlighted(sheet, 0, AUDIO.character)).toBe(false)
  })

  it("reports the settled half of a half-decided line and still warns about the open half", () => {
    // The two sheets now agree on the speaker and still disagree about the
    // shot. Hiding the settled half would waste her afternoon's work; claiming
    // the open half would break the rule above. The row says both.
    const sheet = buildSubtitleSheet(
      onePair(named("s1", "JESUS", "on"), named("c1", "JESUS", "off"), {
        resolutions: {
          [resolutionKey("s1", "c1")]: { name: { chose: "audio", rejected: "MARY" }, at: 1000 },
        },
      }),
    )
    expect(valueAt(sheet, 0, SUB.changed)).toBe("was MARY; unresolved")
    expect(isHighlighted(sheet, 0, SUB.character)).toBe(true)
    // The disputed axis itself is untouched on both sides.
    expect(valueAt(sheet, 0, SUB.camera)).toBe("On")
    expect(isHighlighted(sheet, 0, SUB.camera)).toBe(false)
  })

  it("does not fill a blank character in from the other sheet", () => {
    // Her subtitle sheet leaves "Character Label" empty on most rows and the
    // app is perfectly happy to resolve a name across the link on screen.
    // Writing it into the file would be merging the other team's document into
    // hers, not correcting hers.
    const sheet = buildSubtitleSheet(
      onePair(cell({ id: "s1", startTime: 1, endTime: 2 }), named("c1", "MARY", "on")),
    )
    expect(valueAt(sheet, 0, SUB.character)).toBe("")
    expect(valueAt(sheet, 0, SUB.changed)).toBe("")
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
  const input = onePair(
    named("s1", "JESUS", "on", { original: "Come and see." }),
    named("c1", "JESUS", "on", { original: "Ven y ve." }),
    {
      resolutions: {
        [resolutionKey("s1", "c1")]: { name: { chose: "audio", rejected: "MARY" }, at: 1000 },
      },
    },
  )

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
      "Changed",
    ])
    expect(sheets[1].rows[0]).toEqual([
      "Line #",
      "startTime",
      "endTime",
      "Character",
      "Translation",
      "Camera",
      "Changed",
    ])
  })

  it("carries the correction all the way into the file", async () => {
    const blob = await buildCharacterSheets(input)
    const sheets = await parseXlsxToSheets(await blob.arrayBuffer())
    // Row 1 is the header; row 2 is the only line in this fixture.
    expect(sheets[0].rows[1][SUB.character]).toBe("JESUS  (On)")
    expect(sheets[0].rows[1][SUB.changed]).toBe("was MARY")
    expect(sheets[1].rows[1][AUDIO.changed]).toBe("")
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
// Every one of these is a format an adversarial review caught the first cut
// getting wrong, and the reason it caught them is that nothing here was
// checked against the real files — the fixtures agreed with the code because
// the same person wrote both. The numbers below are counted from
// `~/Code/aquilla-app/the-chosen-media/101/`:
//
//   audio sheet   `LITTLE MARY MAGDALENE\u00a0   (ON)`   548 rows, NBSP + 3 spaces
//                 camera column `ON` (329) but `Off` (112), `Mixed` (100)
//   subtitle      `LITTLE MARY MAGDALENE.  (Mixed)`      637 of 650 rows, 2 spaces
//                 camera column `On` (333), `Off` (141), `Mixed` (151)
//
// These are strings something downstream may well match on, so "close enough"
// is not a standard this file gets to hold itself to.

describe("the formats measured from her own files", () => {
  const line = (over: Partial<CellData>) =>
    cell({ id: "s1", startTime: 63.209, endTime: 63.667, ...over })

  it("writes the audio name with a non-breaking space before the angle", () => {
    const sheet = buildAudioSheet({
      textCells: [],
      cueCells: [line({ id: "c1", metadata: { cast_name: "LITTLE MARY MAGDALENE" }, cameraState: "on" })],
      links: EMPTY_CUE_LINK_INDEX,
      settings: undefined,
    })
    expect(sheet.rows[0]![AUDIO.character]!.value).toBe("LITTLE MARY MAGDALENE\u00a0   (ON)")
  })

  it("writes the subtitle label with its angle too, two plain spaces", () => {
    const sheet = buildSubtitleSheet({
      textCells: [line({ metadata: { cast_name: "LITTLE MARY MAGDALENE." }, cameraState: "mixed" })],
      cueCells: [],
      links: EMPTY_CUE_LINK_INDEX,
      settings: undefined,
    })
    expect(sheet.rows[0]![SUB.character]!.value).toBe("LITTLE MARY MAGDALENE.  (Mixed)")
  })

  it("shouts ON but not OFF, which is her house style and not a typo", () => {
    const of = (state: "on" | "off" | "mixed") =>
      buildAudioSheet({
        textCells: [],
        cueCells: [line({ id: "c1", metadata: { cast_name: "X" }, cameraState: state })],
        links: EMPTY_CUE_LINK_INDEX,
        settings: undefined,
      }).rows[0]![AUDIO.camera]!.value
    expect(of("on")).toBe("ON")
    expect(of("off")).toBe("Off")
    expect(of("mixed")).toBe("Mixed")
  })

  it("keeps her VTT_closest column rather than quietly dropping it", () => {
    const sheet = buildSubtitleSheet({
      textCells: [line({ metadata: { cast_name: "X" } })],
      cueCells: [],
      links: EMPTY_CUE_LINK_INDEX,
      settings: undefined,
    })
    expect(sheet.headers).toContain("VTT_closest")
    expect(sheet.rows[0]![SUB.vttClosest]!.value).toBe("00:01:03.209 --> 00:01:03.667")
  })

  it("writes a name our own importer can read the angle back out of", () => {
    // The two files are far apart and nothing else would notice them drifting.
    const written = buildAudioSheet({
      textCells: [],
      cueCells: [line({ id: "c1", metadata: { cast_name: "MARY MAGDALENE'S FATHER" }, cameraState: "on" })],
      links: EMPTY_CUE_LINK_INDEX,
      settings: undefined,
    }).rows[0]![AUDIO.character]!.value as string
    const back = splitCastName(written)
    expect(back.voice).toBe("MARY MAGDALENE'S FATHER")
    expect(back.cameraState).toBe("on")
  })
})

