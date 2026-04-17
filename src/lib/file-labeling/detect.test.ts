import { describe, it, expect } from "vitest"
import { detectSuggestions } from "./detect"
import type { ProjectRecord, FileReference } from "@/lib/parsers/types"

function mkFile(overrides: Partial<FileReference>): FileReference {
  return {
    id: "f", name: "x", type: "usfm",
    createdAt: "2026-01-01T00:00:00Z", cellCount: 0,
    ...overrides,
  }
}

function mkProject(files: FileReference[]): ProjectRecord {
  return {
    id: "p1", name: "t", sourceLanguage: "en", targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z", files, members: [],
  }
}

describe("detectSuggestions — bible-book", () => {
  it("recognizes book code in USFM filename stem", () => {
    const p = mkProject([mkFile({ id: "1", name: "gen.usfm", type: "usfm" })])
    const s = detectSuggestions(p)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({
      fileId: "1", suggestedName: "Genesis",
      suggestedCorpus: "OT", source: "bible-book",
    })
  })
  it("handles numbered prefix like '40-MAT.usfm'", () => {
    const p = mkProject([mkFile({ id: "2", name: "40-MAT.usfm", type: "usfm" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({ suggestedName: "Matthew", suggestedCorpus: "NT" })
  })
  it("handles ebible type", () => {
    const p = mkProject([mkFile({ id: "3", name: "psa", type: "ebible" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({ suggestedName: "Psalms", suggestedCorpus: "OT" })
  })
  it("does not suggest if name is already the canonical English name", () => {
    const p = mkProject([mkFile({ id: "4", name: "Genesis", type: "usfm" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("does not suggest if corpus is already the canonical testament and name matches", () => {
    const p = mkProject([mkFile({
      id: "5", name: "Genesis", type: "usfm", corpusMarker: "OT",
    })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("suggests corpus update when name is canonical but corpus is missing", () => {
    const p = mkProject([mkFile({ id: "6", name: "Genesis", type: "usfm" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Genesis", suggestedCorpus: "OT",
    })
  })
  it("ignores non-scripture types", () => {
    const p = mkProject([mkFile({ id: "7", name: "gen.docx", type: "docx" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
})

describe("detectSuggestions — season-episode", () => {
  it("recognizes S01E02 pattern", () => {
    const p = mkProject([mkFile({ id: "1", name: "show.S01E02.vtt", type: "vtt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Season 1 · Episode 2",
      suggestedCorpus: "Season 1",
      source: "season-episode",
    })
  })
  it("recognizes 3-digit run as S1E{23}", () => {
    const p = mkProject([mkFile({ id: "2", name: "101.vtt", type: "vtt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Season 1 · Episode 1",
      suggestedCorpus: "Season 1",
    })
  })
  it("recognizes 4-digit run as S{12}E{34}", () => {
    const p = mkProject([mkFile({ id: "3", name: "1004.srt", type: "srt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({
      suggestedName: "Season 10 · Episode 4",
      suggestedCorpus: "Season 10",
    })
  })
  it("does not match 5+ digit runs", () => {
    const p = mkProject([mkFile({ id: "4", name: "10004.vtt", type: "vtt" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("does not match 2-digit runs", () => {
    const p = mkProject([mkFile({ id: "5", name: "10.vtt", type: "vtt" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("is case-insensitive on S/E", () => {
    const p = mkProject([mkFile({ id: "6", name: "s3e7.srt", type: "srt" })])
    const s = detectSuggestions(p)
    expect(s[0]).toMatchObject({ suggestedName: "Season 3 · Episode 7" })
  })
})

describe("detectSuggestions — numbered-family", () => {
  it("groups files sharing a stem with numeric suffixes", () => {
    const p = mkProject([
      mkFile({ id: "1", name: "lesson-01.docx", type: "docx" }),
      mkFile({ id: "2", name: "lesson-02.docx", type: "docx" }),
      mkFile({ id: "3", name: "lesson-03.docx", type: "docx" }),
    ])
    const s = detectSuggestions(p)
    expect(s).toHaveLength(3)
    expect(s.map((x) => x.suggestedName).sort()).toEqual(["01", "02", "03"])
    expect(s[0].suggestedCorpus).toBe("lesson")
  })
  it("does not fire for single-file 'family'", () => {
    const p = mkProject([mkFile({ id: "1", name: "lesson-01.docx", type: "docx" })])
    expect(detectSuggestions(p)).toHaveLength(0)
  })
  it("normalizes zero-padding across the family", () => {
    const p = mkProject([
      mkFile({ id: "1", name: "part1.docx", type: "docx" }),
      mkFile({ id: "2", name: "part10.docx", type: "docx" }),
    ])
    const s = detectSuggestions(p)
    const byId = new Map(s.map((x) => [x.fileId, x.suggestedName]))
    expect(byId.get("1")).toBe("01")
    expect(byId.get("2")).toBe("10")
  })
})

describe("detectSuggestions — priority", () => {
  it("bible-book wins over numbered-family for scripture files", () => {
    const p = mkProject([
      mkFile({ id: "1", name: "gen.usfm", type: "usfm" }),
      mkFile({ id: "2", name: "exo.usfm", type: "usfm" }),
    ])
    const s = detectSuggestions(p)
    expect(s.every((x) => x.source === "bible-book")).toBe(true)
  })
})
