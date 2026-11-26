import { describe, it, expect } from "vitest"
import { parseTextFormat, TEXT_PARSE_FILE_TYPES } from "./parse-text-formats"
import {
  USFM_MARKER_SHAPES_CRLF,
  USFM_MARKER_SHAPES_LF,
} from "./__fixtures__/usfm-marker-shapes"
import type { UsfmNoteRecord } from "../../../db/shared/usfm-notes"

describe("parseTextFormat (worker-safe DOM-free parse core)", () => {
  it("parses a plain text file into strings", () => {
    const results = parseTextFormat({
      fileType: "txt",
      text: "First line.\n\nSecond line.",
      name: "sample.txt",
    })
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("sample.txt")
    expect(results[0].strings.length).toBeGreaterThan(0)
  })

  it("splits a multi-book USFM file into one ImportResult per \\id, carrying raw source", () => {
    const usfm =
      "\\id GEN\n\\c 1\n\\v 1 In the beginning God created the heavens and the earth.\n" +
      "\\id EXO\n\\c 1\n\\v 1 These are the names of the sons of Israel.\n"
    const results = parseTextFormat({ fileType: "usfm", text: usfm, name: "books.usfm" })

    expect(results).toHaveLength(2)
    // Each book becomes its own result named by its \id book code.
    expect(results.map((r) => r.name)).toEqual(["GEN", "EXO"])
    // Round-trip side-car: each result keeps its own raw USFM section.
    expect(results[0].rawSourceFormat).toBe("usfm")
    expect(results[0].rawSource).toContain("\\id GEN")
    expect(results[1].rawSource).toContain("\\id EXO")
    // The verse text is extracted into a translatable string.
    expect(results[0].strings.some((s) => s.original.includes("In the beginning"))).toBe(true)
  })

  // AQU-2508: Paratext bridges verses (`\v 27-28`) and gives the range one
  // combined translation. The importer must mint ONE cell for the bridge,
  // keeping the range in the ref — never a cell per verse with the text in
  // neither, which strands the translation.
  it("AQU-2508: a bridged verse imports as one ranged cell carrying the combined text", () => {
    const usfm =
      "\\id LUK\n\\c 5\n\\v 26 And they were all amazed.\n" +
      "\\v 27-28 And he saw a publican, and he left all, and followed him.\n" +
      "\\v 29 And Levi made him a great feast.\n"
    const [book] = parseTextFormat({ fileType: "usfm", text: usfm, name: "luk.usfm" })

    expect(book.strings.map((str) => str.group)).toEqual(["LUK 5:26", "LUK 5:27-28", "LUK 5:29"])
    const bridge = book.strings.find((str) => str.group === "LUK 5:27-28")
    expect(bridge?.original).toBe("And he saw a publican, and he left all, and followed him.")
    // The failure this guards: an empty cell per bridged verse.
    expect(book.strings.some((str) => str.original.trim() === "")).toBe(false)
    expect(book.strings.map((str) => str.group)).not.toContain("LUK 5:27")
    expect(book.strings.map((str) => str.group)).not.toContain("LUK 5:28")
  })

  it("AQU-634: imports USFM front matter by default, excludes it when opted out", () => {
    const usfm =
      "\\id GEN\n\\h Genesis\n\\mt1 Genesis\n\\ip An introduction.\n" +
      "\\c 1\n\\s The Creation\n\\v 1 In the beginning.\n"

    const withFront = parseTextFormat({ fileType: "usfm", text: usfm, name: "gen.usfm" })
    const defaultTexts = withFront[0].strings.map((s) => s.original)
    expect(defaultTexts).toEqual(expect.arrayContaining(["Genesis", "An introduction.", "The Creation", "In the beginning."]))

    const withoutFront = parseTextFormat({
      fileType: "usfm",
      text: usfm,
      name: "gen.usfm",
      excludeFrontMatter: true,
    })
    const optedTexts = withoutFront[0].strings.map((s) => s.original)
    // Book name/title/intro dropped; section heading + verse still present.
    expect(optedTexts).not.toContain("An introduction.")
    expect(optedTexts.filter((t) => t === "Genesis")).toHaveLength(0)
    expect(optedTexts).toEqual(expect.arrayContaining(["The Creation", "In the beginning."]))
  })

  it("AQU-2119: reads short-form VTT cue times instead of dropping the cues, and reports the repair", () => {
    // Legal WebVTT: the hours field is optional. The strict matcher behind
    // `extractVttStrings` never opens these cues, so before the repair their
    // words were swallowed as junk and the file imported short.
    const vtt =
      "WEBVTT\n\n01:03.209 --> 01:03.667\nFirst line\n\n" +
      "1:04.000 --> 1:05.500\nSecond line\n\n" +
      "00:00:06.000 --> 00:00:07.000\nAlready strict\n"

    const [result] = parseTextFormat({ fileType: "vtt", text: vtt, name: "clip.vtt" })

    expect(result.strings.map((cue) => cue.original)).toEqual([
      "First line",
      "Second line",
      "Already strict",
    ])
    // Short form is minutes and seconds, not hours and minutes.
    expect(result.strings[0].start).toBeCloseTo(63.209)
    expect(result.strings[0].end).toBeCloseTo(63.667)
    expect(result.strings[1].start).toBeCloseTo(64)
    // Only the two short-form lines count as repaired; nothing was refused.
    expect(result.cueRepair).toEqual({ repairedShortForm: 2, droppedCues: 0 })
  })

  it("AQU-2119: reports a cue timestamp line it still cannot read rather than losing it in silence", () => {
    // Centisecond fractions: neither the strict matcher nor the short-form pad
    // (which wants three digits) can read them, so the cue is genuinely lost.
    const vtt =
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nKept\n\n" +
      "00:00:03.1 --> 00:00:04.5\nLost wording\n"

    const [result] = parseTextFormat({ fileType: "vtt", text: vtt, name: "clip.vtt" })

    expect(result.strings.map((cue) => cue.original)).toEqual(["Kept"])
    expect(result.cueRepair).toEqual({ repairedShortForm: 0, droppedCues: 1 })
  })

  it("AQU-2119: leaves a clean subtitle file with no cue report at all", () => {
    const [vtt] = parseTextFormat({
      fileType: "vtt",
      text: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n",
      name: "clip.vtt",
    })
    const [srt] = parseTextFormat({
      fileType: "srt",
      text: "1\n00:00:01,000 --> 00:00:02,000\nOne\n",
      name: "clip.srt",
    })

    expect(vtt.strings).toHaveLength(1)
    expect(vtt.cueRepair).toBeUndefined()
    // SRT has no short form to pad, so it parses the original text — but an
    // unreadable range is still counted against the loose `-->` denominator.
    expect(srt.strings).toHaveLength(1)
    expect(srt.cueRepair).toBeUndefined()
  })

  it("declares exactly the DOM-free file types it can handle", () => {
    expect(TEXT_PARSE_FILE_TYPES.has("usfm")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("txt")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("csv")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("json")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("po")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("properties")).toBe(true)
    expect(TEXT_PARSE_FILE_TYPES.has("sbv")).toBe(true)
    // DOM-bound (DOMParser) formats must NOT be routed here.
    expect(TEXT_PARSE_FILE_TYPES.has("docx")).toBe(false)
    expect(TEXT_PARSE_FILE_TYPES.has("xliff")).toBe(false)
  })

  it.each([
    ["json", "messages.json", '{"title":"Hello"}', "Hello"],
    ["po", "messages.po", 'msgid "Hello"\nmsgstr "Bonjour"\n', "Hello"],
    ["properties", "messages.properties", "title=Hello\n", "Hello"],
    ["sbv", "captions.sbv", "0:00:01.000,0:00:02.000\nHello\n", "Hello"],
  ] as const)("parses %s through its deterministic adapter", (fileType, name, text, expected) => {
    const [result] = parseTextFormat({ fileType, name, text })
    expect(result.strings[0].original).toBe(expected)
  })
})

describe("USFM import is content-only (AQU-2743)", () => {
  const cellsOf = (text: string) => {
    const [book] = parseTextFormat({ fileType: "usfm", text, name: "41MAT.SFM" })
    return book.strings
  }
  const byRef = (text: string, ref: string) => {
    const cell = cellsOf(text).find((s) => s.context === ref)
    if (!cell) throw new Error(`no cell for ${ref}`)
    return cell
  }

  it("keeps no USFM markup in a verse cell's text", () => {
    for (const cell of cellsOf(USFM_MARKER_SHAPES_CRLF)) {
      expect(cell.original).not.toContain("\\")
      expect(cell.original).not.toContain("\r")
    }
  })

  it("lifts footnotes out of the verse and parks them in metadata.usfmNotes", () => {
    const mat1v1 = byRef(USFM_MARKER_SHAPES_CRLF, "MAT 1:1")
    expect(mat1v1.original).toBe(
      "This is the genealogy of Jesus the Messiah the son of David, the son of Abraham:",
    )
    const notes = mat1v1.metadata?.usfmNotes as UsfmNoteRecord[]
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatchObject({ kind: "footnote", caller: "+", ref: "1:1" })
    // The nested \+xt cross-reference is flattened into the note's text, and
    // the original span is kept verbatim so export can restore it (AQU-1295).
    expect(notes[1].text).toContain("verse 18")
    expect(notes[1].raw).toContain("\\+xt verse 18|MAT 1:18\\+xt*")
  })

  it("unwraps \\wj and joins poetry lines with a newline", () => {
    expect(byRef(USFM_MARKER_SHAPES_CRLF, "MAT 5:3").original).toBe(
      "“Blessed are the poor in spirit,\nfor theirs is the kingdom of heaven.",
    )
    // \wj spanning a footnote: the words survive, the note is parked.
    const mat5v4 = byRef(USFM_MARKER_SHAPES_CRLF, "MAT 5:4")
    expect(mat5v4.original).toBe(
      "“Blessed are those who mourn,\nfor they will be comforted.",
    )
    expect(mat5v4.metadata?.usfmNotes).toHaveLength(1)
  })

  it("reads CRLF and LF to the same cells", () => {
    const crlf = cellsOf(USFM_MARKER_SHAPES_CRLF).map((s) => [s.context, s.original, s.metadata])
    const lf = cellsOf(USFM_MARKER_SHAPES_LF).map((s) => [s.context, s.original, s.metadata])
    expect(crlf).toEqual(lf)
  })

  it("leaves a cell that never had USFM markup in it alone", () => {
    expect(byRef(USFM_MARKER_SHAPES_CRLF, "MAT 5:2").original).toBe(
      "and he began to teach them.",
    )
    expect(byRef(USFM_MARKER_SHAPES_CRLF, "MAT 1:s1:1").original).toBe(
      "The Genealogy of Jesus the Messiah",
    )
  })
})
