// AQU-2560: a Bible file's takes are named by verse.
//
// The classic by-line name ends in the line's character. A book of scripture
// has no cast, and on a project migrated from Codex the "character" is worse
// than empty: the migration read each cell's verse number as a speaker, so a
// partner's export came out as `LUK_Pattani Malay_L0002_1.wav` — a verse with
// no chapter — and every section heading as `…_NO_CHARACTER`.

import { describe, expect, it } from "vitest"
import JSZip from "jszip"

import { exportAudioPerLine, perLineFileName, type PerLineClip } from "./audio-per-line"
import { scriptureLines } from "./scripture-line-names"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

/** The reported project's shape: every verse cast to a voice named after it. */
const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-1", name: "1" }, { id: "v-54", name: "54" }],
  castAssignments: { "luk-1-1": "v-1", "luk-1-54": "v-54" },
}

function line(id: string, over: Partial<CellData> = {}): CellData {
  return {
    id, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    selectedAudioId: `a-${id}`,
    attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.wav`, type: "audio" } },
    ...over,
  } as CellData
}

const verse = (id: string, ref: string) => line(id, { group: ref })
const heading = (id: string) => line(id, { type: "paratext" })
const added = (id: string) =>
  line(id, { metadata: { aquillaOrigin: { kind: "user-insert", version: 1, createdAt: 1 } } })

/** A minimal RIFF/WAVE the exporter can stamp. */
function makeWav(): Uint8Array {
  const bytes = new Uint8Array(52)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i += 1) view.setUint8(at + i, s.charCodeAt(i)) }
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE")
  tag(12, "fmt "); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 48000, true); view.setUint32(28, 96000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  tag(36, "data"); view.setUint32(40, 8, true)
  return bytes
}

const base = {
  settings: SETTINGS,
  projectId: "p1",
  langCode: "Pattani Malay",
  fileBase: "LUK",
  fetchBytes: async () => makeWav(),
}

const namesOf = async (blob: Blob) =>
  Object.keys((await JSZip.loadAsync(blob)).files).filter((n) => n !== "manifest.csv")

const clip = (over: Partial<PerLineClip> = {}) =>
  ({ lineNumber: 2, character: "1", ...over }) as PerLineClip

describe("placing a line in the book", () => {
  it("is null for a file with no verse references", () => {
    expect(scriptureLines([line("a"), line("b", { context: "00:00:02.000 --> 00:00:06.500" })])).toBeNull()
  })

  it("gives a verse its own book, chapter and verse", () => {
    const at = scriptureLines([verse("v", "LUK 1:54")])!
    expect(at.get("v")).toEqual({ book: "LUK", chapter: "1", verse: "54" })
  })

  it("keeps both ends of a verse range", () => {
    expect(scriptureLines([verse("v", "LUK 1:13-14")])!.get("v")?.verse).toBe("13-14")
  })

  it("names a heading after the verse it sits under", () => {
    const at = scriptureLines([verse("v4", "LUK 1:4"), heading("h"), verse("v5", "LUK 1:5")])!
    expect(at.get("h")).toEqual({ book: "LUK", chapter: "1", verse: "4", follows: "heading" })
  })

  it("puts a heading above the first verse at verse 0 of that verse's chapter", () => {
    const at = scriptureLines([heading("title"), verse("v1", "LUK 1:1")])!
    expect(at.get("title")).toEqual({ book: "LUK", chapter: "1", verse: "0", follows: "heading" })
  })

  it("tells a line someone added apart from a heading", () => {
    const at = scriptureLines([verse("v4", "LUK 1:4"), added("quote")])!
    expect(at.get("quote")?.follows).toBe("added")
  })

  it("does not let a heading that carries a reference take its verse's name", () => {
    const at = scriptureLines([line("h", { type: "heading", group: "LUK 2:1" }), verse("v", "LUK 2:1")])!
    expect(at.get("h")).toEqual({ book: "LUK", chapter: "2", verse: "1", follows: "heading" })
    expect(at.get("v")).toEqual({ book: "LUK", chapter: "2", verse: "1" })
  })
})

describe("naming a scripture file", () => {
  const opts = { fileBase: "LUK", langCode: "Pattani Malay", projectName: "Pattani Malay Bible" }

  it("is project, language, book, chapter and verse", () => {
    expect(perLineFileName(clip(), "wav", { ...opts, scripture: { book: "LUK", chapter: "1", verse: "54" } }))
      .toBe("Pattani_Malay_Bible_Pattani_Malay_LUK_001_054.wav")
  })

  it("pads chapter and verse so the folder sorts in reading order", () => {
    const name = (chapter: string, v: string) =>
      perLineFileName(clip(), "wav", { ...opts, scripture: { book: "LUK", chapter, verse: v } })
    const names = [name("10", "1"), name("2", "10"), name("2", "9")]
    expect([...names].sort()).toEqual([name("2", "9"), name("2", "10"), name("10", "1")])
  })

  it("pads both ends of a range", () => {
    expect(perLineFileName(clip(), "wav", { ...opts, scripture: { book: "LUK", chapter: "1", verse: "13-14" } }))
      .toBe("Pattani_Malay_Bible_Pattani_Malay_LUK_001_013-014.wav")
  })

  it("marks a heading, and sorts it straight after its verse", () => {
    const own = perLineFileName(clip(), "wav", { ...opts, scripture: { book: "LUK", chapter: "1", verse: "4" } })
    const head = perLineFileName(clip(), "wav", {
      ...opts, scripture: { book: "LUK", chapter: "1", verse: "4", follows: "heading" },
    })
    const next = perLineFileName(clip(), "wav", { ...opts, scripture: { book: "LUK", chapter: "1", verse: "5" } })
    expect(head).toBe("Pattani_Malay_Bible_Pattani_Malay_LUK_001_004_heading.wav")
    expect([next, head, own].sort()).toEqual([own, head, next])
  })

  it("tells the pieces of a cut take apart", () => {
    expect(perLineFileName(clip({ piece: 2 }), "wav", { ...opts, scripture: { book: "LUK", chapter: "1", verse: "54" } }))
      .toBe("Pattani_Malay_Bible_Pattani_Malay_LUK_001_054_p2.wav")
  })

  it("leaves the classic name alone when the line is not scripture", () => {
    expect(perLineFileName(clip(), "wav", opts)).toBe("LUK_Pattani Malay_L0002_1.wav")
  })
})

describe("the exported scripture folder", () => {
  const cells = [
    heading("title"),
    verse("luk-1-1", "LUK 1:1"),
    heading("section"),
    verse("luk-1-54", "LUK 1:54"),
  ]

  it("names every take by its verse, not by the voice called after its verse number", async () => {
    const result = await exportAudioPerLine({
      ...base, cells, scriptureNaming: { projectName: "Pattani Malay Bible" },
    })
    expect((await namesOf(result.blob)).sort()).toEqual([
      "Pattani_Malay_Bible_Pattani_Malay_LUK_001_000_heading.wav",
      "Pattani_Malay_Bible_Pattani_Malay_LUK_001_001.wav",
      "Pattani_Malay_Bible_Pattani_Malay_LUK_001_001_heading.wav",
      "Pattani_Malay_Bible_Pattani_Malay_LUK_001_054.wav",
    ])
  })

  it("keeps two headings under one verse as two files", async () => {
    const result = await exportAudioPerLine({
      ...base,
      cells: [verse("luk-1-1", "LUK 1:1"), heading("h1"), heading("h2")],
      scriptureNaming: { projectName: "Bible" },
    })
    expect((await namesOf(result.blob)).sort()).toEqual([
      "Bible_Pattani_Malay_LUK_001_001.wav",
      "Bible_Pattani_Malay_LUK_001_001_heading.wav",
      "Bible_Pattani_Malay_LUK_001_001_heading_2.wav",
    ])
  })

  it("keeps the manifest's columns, and lists the new names in it", async () => {
    const result = await exportAudioPerLine({
      ...base, cells, scriptureNaming: { projectName: "Bible" },
    })
    const manifest = await (await JSZip.loadAsync(result.blob)).file("manifest.csv")!.async("string")
    const [header, first] = manifest.split("\n")
    expect(header).toBe("file,line,character,start,end,start_seconds,end_seconds,cell_id")
    expect(first.startsWith("Bible_Pattani_Malay_LUK_001_000_heading.wav,1,")).toBe(true)
  })

  it("describes a timed verse by its reference inside the WAV", async () => {
    const result = await exportAudioPerLine({
      ...base,
      cells: [line("luk-1-54", { group: "LUK 1:54", startTime: 3, endTime: 4 })],
      scriptureNaming: { projectName: "Bible" },
    })
    const zip = await JSZip.loadAsync(result.blob)
    const bytes = await zip.file("Bible_Pattani_Malay_LUK_001_054.wav")!.async("uint8array")
    expect(new TextDecoder("latin1").decode(bytes)).toContain("LUK 1:54 - line 1")
  })

  it("writes the classic names when scripture naming is not asked for", async () => {
    const result = await exportAudioPerLine({ ...base, cells })
    expect((await namesOf(result.blob)).sort()).toEqual([
      "LUK_Pattani Malay_L0001_NO_CHARACTER.wav",
      "LUK_Pattani Malay_L0002_1.wav",
      "LUK_Pattani Malay_L0003_NO_CHARACTER.wav",
      "LUK_Pattani Malay_L0004_54.wav",
    ])
  })

  it("writes the classic names for a file that is not scripture, even when asked", async () => {
    const result = await exportAudioPerLine({
      ...base,
      cells: [line("c1", { startTime: 1, endTime: 2 }), line("c2", { startTime: 3, endTime: 4 })],
      resolveName: () => "JESUS",
      scriptureNaming: { projectName: "The Chosen" },
    })
    expect((await namesOf(result.blob)).sort()).toEqual([
      "LUK_Pattani Malay_L0001_JESUS.wav",
      "LUK_Pattani Malay_L0002_JESUS.wav",
    ])
  })
})
