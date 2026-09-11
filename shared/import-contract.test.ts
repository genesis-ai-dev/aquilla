import { describe, expect, it } from "vitest"
import {
  SOURCE_ARTIFACT_FORMATS,
  humanOriginalDownloadName,
  isGeneratedDownloadStem,
  originalDownloadName,
  sourceArtifactDescriptor,
  uniqueZipEntryName,
} from "./import-contract"

describe("source artifact format registry", () => {
  it("covers every deterministic and specialty importer format", () => {
    expect(Object.keys(SOURCE_ARTIFACT_FORMATS).sort()).toEqual([
      "csv",
      "custom-original",
      "docx",
      "ebible",
      "epub",
      "helloao",
      "html",
      "idml",
      "json",
      "macula-tsv",
      "md",
      "obs",
      "obs-package",
      "paratext-project",
      "po",
      "pptx",
      "properties",
      "sdbh-localized",
      "sdbh-master",
      "sbv",
      "srt",
      "tmx",
      "tn-tsv",
      "tsv",
      "txt",
      "usfm",
      "usx",
      "vtt",
      "xliff",
      "xlsx",
    ].sort())

    for (const descriptor of Object.values(SOURCE_ARTIFACT_FORMATS)) {
      expect(descriptor.extension).toMatch(/^[a-z0-9]+$/)
      expect(descriptor.contentType).toContain("/")
    }
  })

  it("keeps native claims narrow and falls back safely for future formats", () => {
    const native = Object.entries(SOURCE_ARTIFACT_FORMATS)
      .filter(([, descriptor]) => descriptor.defaultFidelity === "native")
      .map(([format]) => format)
      .sort()
    expect(native).toEqual(["docx", "pptx", "usfm"])
    expect(sourceArtifactDescriptor("idml")).toEqual({
      extension: "idml",
      contentType: "application/vnd.adobe.indesign-idml-package",
      defaultFidelity: "content-only",
    })
    expect(sourceArtifactDescriptor("future-vendor-format")).toEqual({
      extension: "bin",
      contentType: "application/octet-stream",
      defaultFidelity: "content-only",
    })
  })
})

describe("originalDownloadName (AQU-656)", () => {
  it("appends the original extension when the current name has none", () => {
    expect(originalDownloadName("Matthew", "docx")).toBe("Matthew.docx")
    expect(originalDownloadName("Berean Standard Bible (BSB)", "usfm"))
      .toBe("Berean Standard Bible (BSB).usfm")
  })

  it("keeps a USFM name that already ends in .sfm or .usfm", () => {
    expect(originalDownloadName("GEN.SFM", "usfm")).toBe("GEN.SFM")
    expect(originalDownloadName("EXO.usfm", "usfm")).toBe("EXO.usfm")
  })

  it("keeps a current name that already has an extension", () => {
    expect(originalDownloadName("Notes.md", "docx")).toBe("Notes.md")
  })
})

describe("humanOriginalDownloadName (AQU-656)", () => {
  it("never uses a file-id UUID as the save name", () => {
    const id = "01a045cf-1131-7158-8150-03ae69b8c1c0"
    expect(humanOriginalDownloadName(id, "json")).toBe("original.json")
    expect(humanOriginalDownloadName(`${id}.usfm`, "usfm")).toBe("original.usfm")
    expect(humanOriginalDownloadName("", "docx")).toBe("original.docx")
    expect(humanOriginalDownloadName(null, "docx", "Matthew")).toBe("Matthew.docx")
  })

  it("still uses a real display name", () => {
    expect(humanOriginalDownloadName("Berean Standard Bible (BSB)", "json"))
      .toBe("Berean Standard Bible (BSB).json")
  })
})

describe("isGeneratedDownloadStem (AQU-656)", () => {
  it("detects RFC-4122 ids with or without an extension", () => {
    expect(isGeneratedDownloadStem("01a045cf-1131-7158-8150-03ae69b8c1c0")).toBe(true)
    expect(isGeneratedDownloadStem("01a045cf-1131-7158-8150-03ae69b8c1c0.json")).toBe(true)
    expect(isGeneratedDownloadStem("Berean Standard Bible (BSB)")).toBe(false)
  })
})

describe("uniqueZipEntryName (AQU-656)", () => {
  it("suffixes collisions as ' (2)', ' (3)', …", () => {
    const used = new Set<string>()
    expect(uniqueZipEntryName("Matthew.docx", used)).toBe("Matthew.docx")
    expect(uniqueZipEntryName("Matthew.docx", used)).toBe("Matthew (2).docx")
    expect(uniqueZipEntryName("Matthew.docx", used)).toBe("Matthew (3).docx")
  })
})
