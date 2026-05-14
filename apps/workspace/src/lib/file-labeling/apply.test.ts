import { describe, it, expect } from "vitest"
import { applySuggestions, buildUndo } from "./apply"
import type { RenameSuggestion } from "./detect"
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
function mkSug(overrides: Partial<RenameSuggestion>): RenameSuggestion {
  return {
    fileId: "f", currentName: "x", suggestedName: "y",
    source: "bible-book",
    ...overrides,
  }
}

describe("applySuggestions", () => {
  it("renames files and sets originalName", () => {
    const project = mkProject([mkFile({ id: "f1", name: "gen.usfm" })])
    const next = applySuggestions(project, [
      mkSug({ fileId: "f1", currentName: "gen.usfm", suggestedName: "Genesis", suggestedCorpus: "OT" }),
    ])
    expect(next.files[0].name).toBe("Genesis")
    expect(next.files[0].corpusMarker).toBe("OT")
    expect(next.files[0].originalName).toBe("gen.usfm")
  })
  it("applies multiple in one pass", () => {
    const project = mkProject([
      mkFile({ id: "f1", name: "gen.usfm" }),
      mkFile({ id: "f2", name: "exo.usfm" }),
    ])
    const next = applySuggestions(project, [
      mkSug({ fileId: "f1", currentName: "gen.usfm", suggestedName: "Genesis", suggestedCorpus: "OT" }),
      mkSug({ fileId: "f2", currentName: "exo.usfm", suggestedName: "Exodus", suggestedCorpus: "OT" }),
    ])
    expect(next.files.map((f) => f.name)).toEqual(["Genesis", "Exodus"])
  })
  it("skips files that no longer exist in the project", () => {
    const project = mkProject([mkFile({ id: "f1", name: "gen.usfm" })])
    const next = applySuggestions(project, [
      mkSug({ fileId: "missing", currentName: "x", suggestedName: "y" }),
    ])
    expect(next.files[0].name).toBe("gen.usfm")
  })
  it("preserves originalName when already set", () => {
    const project = mkProject([mkFile({
      id: "f1", name: "partly-renamed", originalName: "gen.usfm",
    })])
    const next = applySuggestions(project, [
      mkSug({ fileId: "f1", currentName: "partly-renamed", suggestedName: "Genesis" }),
    ])
    expect(next.files[0].originalName).toBe("gen.usfm")
  })
})

describe("buildUndo", () => {
  it("restores previous name and corpus and clears originalName", () => {
    const before = mkProject([mkFile({
      id: "f1", name: "gen.usfm", corpusMarker: undefined,
    })])
    const suggestions: RenameSuggestion[] = [
      mkSug({
        fileId: "f1", currentName: "gen.usfm", suggestedName: "Genesis",
        suggestedCorpus: "OT", currentCorpus: undefined,
      }),
    ]
    const after = applySuggestions(before, suggestions)
    const undone = buildUndo(after, suggestions)
    expect(undone.files[0].name).toBe("gen.usfm")
    expect(undone.files[0].corpusMarker).toBeUndefined()
    expect(undone.files[0].originalName).toBeUndefined()
  })
})
