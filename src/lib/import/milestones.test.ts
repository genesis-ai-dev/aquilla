import { describe, expect, it } from "vitest"
import type { FileType, TranslatableString } from "@/lib/parsers/types"
import { aquillaImportMetadata, normalizeTranslatableStrings } from "./normalized-manifest"

function text(
  id: string,
  original = id,
  overrides: Partial<TranslatableString> = {},
): TranslatableString {
  return {
    id,
    original,
    translated: "",
    context: "Paragraph",
    group: id,
    type: "text",
    ...overrides,
  }
}

describe("import milestone planning", () => {
  it("assigns Scripture headings and verses to stable book/chapter milestones", () => {
    const manifest = normalizeTranslatableStrings([
      text("heading", "Chapter two", {
        type: "heading",
        globalReferences: ["GEN 2:s1:1"],
      }),
      text("verse", "A verse", {
        type: "verse",
        globalReferences: ["GEN 2:1"],
      }),
    ], { fileName: "GEN.usfm", fileType: "usfm" })

    expect(manifest.units.map((unit) => unit.milestone)).toEqual([
      {
        key: "scripture:GEN:2",
        kind: "chapter",
        label: "Genesis 2",
        shortLabel: "2",
      },
      {
        key: "scripture:GEN:2",
        kind: "chapter",
        label: "Genesis 2",
        shortLabel: "2",
      },
    ])
  })

  it("promotes existing Biblica book/range metadata without coupling the navigator to it", () => {
    const manifest = normalizeTranslatableStrings([
      text("preface", "Preface note", {
        metadata: {
          biblica: { version: 1, contentType: "notes", bookCode: "GEN", chapterLabel: "Preface" },
        },
      }),
      text("range-a", "First split sentence", {
        metadata: {
          biblica: { version: 1, contentType: "notes", bookCode: "GEN", chapterLabel: "1-2" },
        },
      }),
      text("range-b", "Second split sentence", {
        metadata: {
          biblica: { version: 1, contentType: "notes", bookCode: "GEN", chapterLabel: "1-2" },
        },
      }),
    ], {
      fileName: "Genesis",
      fileType: "idml",
      profileId: "builtin:biblica-study-notes",
    })

    expect(manifest.units.map((unit) => unit.milestone)).toEqual([
      {
        key: "biblica:GEN:Preface",
        kind: "preface",
        label: "Genesis Preface",
        shortLabel: "P",
      },
      {
        key: "biblica:GEN:1-2",
        kind: "chapter-range",
        label: "Genesis 1–2",
        shortLabel: "1–2",
      },
      {
        key: "biblica:GEN:1-2",
        kind: "chapter-range",
        label: "Genesis 1–2",
        shortLabel: "1–2",
      },
    ])
  })

  it("starts document sections at headings and keeps duplicate labels addressable", () => {
    const manifest = normalizeTranslatableStrings([
      text("preamble", "Before"),
      text("first", "Introduction", { type: "heading", context: "Heading 1" }),
      text("body", "Body"),
      text("second", "Introduction", { type: "heading", context: "Heading 1" }),
    ], { fileName: "notes.md", fileType: "md" })

    expect(manifest.units.map((unit) => unit.milestone.label)).toEqual([
      "Start",
      "Introduction",
      "Introduction",
      "Introduction",
    ])
    expect(manifest.units[1].milestone.key).not.toBe(manifest.units[3].milestone.key)
  })

  it("uses slides and their titles as presentation milestones", () => {
    const manifest = normalizeTranslatableStrings([
      text("s1-title", "Welcome", {
        type: "heading",
        sourceLocation: { file: "ppt/slides/slide1.xml", blockPath: "p:sp[1]" },
      }),
      text("s1-body", "First body", {
        sourceLocation: { file: "ppt/slides/slide1.xml", blockPath: "p:sp[2]" },
      }),
      text("s2-body", "Second body", {
        sourceLocation: { file: "ppt/slides/slide2.xml", blockPath: "p:sp[1]" },
      }),
    ], { fileName: "deck.pptx", fileType: "pptx" })

    expect(manifest.units.map((unit) => unit.milestone)).toEqual([
      {
        key: "slide:ppt/slides/slide1.xml",
        kind: "slide",
        label: "Slide 1: Welcome",
        shortLabel: "1",
      },
      {
        key: "slide:ppt/slides/slide1.xml",
        kind: "slide",
        label: "Slide 1: Welcome",
        shortLabel: "1",
      },
      {
        key: "slide:ppt/slides/slide2.xml",
        kind: "slide",
        label: "Slide 2",
        shortLabel: "2",
      },
    ])
  })

  it("groups subtitles into fixed five-minute ranges and keeps untimed rows explicit", () => {
    const manifest = normalizeTranslatableStrings([
      text("one", "Opening", { type: "cue", start: 1, end: 2 }),
      text("two", "Later", { type: "cue", start: 301, end: 303 }),
      text("three", "No timing", { type: "cue" }),
    ], { fileName: "episode.vtt", fileType: "vtt" })

    expect(manifest.units.map((unit) => unit.milestone.label)).toEqual([
      "00:00–05:00",
      "05:00–10:00",
      "Untimed",
    ])
  })

  it("uses stable 50-cell fallback parts for flat formats", () => {
    const manifest = normalizeTranslatableStrings(
      Array.from({ length: 101 }, (_, index) => text(`cell-${index + 1}`)),
      { fileName: "memory.tmx", fileType: "tmx" },
    )

    expect(manifest.units[0].milestone).toMatchObject({ label: "Part 1", shortLabel: "1" })
    expect(manifest.units[49].milestone.key).toBe(manifest.units[0].milestone.key)
    expect(manifest.units[50].milestone).toMatchObject({ label: "Part 2", shortLabel: "2" })
    expect(manifest.units[100].milestone).toMatchObject({ label: "Part 3", shortLabel: "3" })
  })

  it("groups properties by dotted prefix while flat keys remain in numbered parts", () => {
    const manifest = normalizeTranslatableStrings([
      text("menu-open", "Open", { context: "menu.open", group: "menu.open" }),
      text("flat", "Welcome", { context: "welcome", group: "welcome" }),
      text("menu-close", "Close", { context: "menu.close", group: "menu.close" }),
    ], { fileName: "messages.properties", fileType: "properties" })

    expect(manifest.units.map((unit) => ({
      kind: unit.milestone.kind,
      label: unit.milestone.label,
    }))).toEqual([
      { kind: "group", label: "menu" },
      { kind: "part", label: "Part 1" },
      { kind: "group", label: "menu" },
    ])
    expect(manifest.units[0].milestone.key).toBe(manifest.units[2].milestone.key)
  })

  it("uses the selected worksheet and subdivides it at explicit heading rows", () => {
    const manifest = normalizeTranslatableStrings([
      text("before", "Before"),
      text("heading", "Details", { type: "heading" }),
      text("after", "After"),
    ], { fileName: "workbook.xlsx — Terms", fileType: "xlsx" })

    expect(manifest.units.map((unit) => ({
      kind: unit.milestone.kind,
      label: unit.milestone.label,
    }))).toEqual([
      { kind: "group", label: "Terms" },
      { kind: "section", label: "Details" },
      { kind: "section", label: "Details" },
    ])
  })

  it("keeps root JSON arrays and ungrouped localization entries in fallback parts", () => {
    const json = normalizeTranslatableStrings([
      text("array-zero", "Zero", { context: "[0]", group: "[0]" }),
      text("array-one", "One", { context: "[1]", group: "[1]" }),
    ], { fileName: "array.json", fileType: "json" })
    const po = normalizeTranslatableStrings([
      text("plain", "Plain message"),
    ], { fileName: "plain.po", fileType: "po" })

    expect(json.units.every((unit) => unit.milestone.kind === "part")).toBe(true)
    expect(po.units[0].milestone).toMatchObject({ kind: "part", label: "Part 1" })
  })

  it("persists the generic assignment in the aquillaImport envelope", () => {
    const manifest = normalizeTranslatableStrings(
      [text("one")],
      { fileName: "one.txt", fileType: "txt" },
    )

    expect(aquillaImportMetadata(manifest, manifest.units[0])).toMatchObject({
      milestone: {
        key: manifest.units[0].milestone.key,
        kind: "part",
        label: "Part 1",
        shortLabel: "1",
      },
    })
  })

  it.each([
    "md", "docx", "pptx", "idml", "xlsx", "txt", "html", "json", "po",
    "properties", "vtt", "srt", "sbv", "usfm", "ebible", "helloao", "xliff",
    "tmx", "csv", "tsv", "audio", "video", "obs", "sdbh", "custom",
  ] satisfies FileType[])("never leaves a %s import unit without a milestone", (fileType) => {
    const manifest = normalizeTranslatableStrings(
      [text(`${fileType}-cell`)],
      { fileName: `sample.${fileType}`, fileType },
    )
    expect(manifest.units[0].milestone.key).toBeTruthy()
    expect(manifest.units[0].milestone.label).toBeTruthy()
    expect(manifest.units[0].milestone.shortLabel).toBeTruthy()
  })
})
