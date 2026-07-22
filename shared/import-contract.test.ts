import { describe, expect, it } from "vitest"
import {
  SOURCE_ARTIFACT_FORMATS,
  sourceArtifactDescriptor,
} from "./import-contract"

describe("source artifact format registry", () => {
  it("covers every deterministic and specialty importer format", () => {
    expect(Object.keys(SOURCE_ARTIFACT_FORMATS).sort()).toEqual([
      "csv",
      "custom-original",
      "docx",
      "ebible",
      "helloao",
      "html",
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
    expect(sourceArtifactDescriptor("future-vendor-format")).toEqual({
      extension: "bin",
      contentType: "application/octet-stream",
      defaultFidelity: "content-only",
    })
  })
})
