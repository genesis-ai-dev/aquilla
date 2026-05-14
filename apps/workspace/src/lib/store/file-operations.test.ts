import { describe, it, expect } from "vitest"
import {
  renameFile, moveFileToCorpus, renameCorpus, deleteFile,
} from "./file-operations"
import type { ProjectRecord, FileReference } from "@/lib/parsers/types"

function mkFile(overrides: Partial<FileReference>): FileReference {
  return {
    id: "f1", name: "genesis.usfm", type: "usfm",
    createdAt: "2026-01-01T00:00:00Z", cellCount: 50,
    ...overrides,
  }
}

function mkProject(files: FileReference[]): ProjectRecord {
  return {
    id: "p1", name: "Test", sourceLanguage: "en", targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00Z", files, members: [],
  }
}

describe("renameFile", () => {
  it("updates the file's name", () => {
    const project = mkProject([mkFile({ id: "f1", name: "genesis.usfm" })])
    const next = renameFile(project, "f1", "Genesis")
    expect(next.files[0].name).toBe("Genesis")
  })
  it("sets originalName the first time name changes", () => {
    const project = mkProject([mkFile({ id: "f1", name: "genesis.usfm" })])
    const next = renameFile(project, "f1", "Genesis")
    expect(next.files[0].originalName).toBe("genesis.usfm")
  })
  it("does not overwrite originalName on subsequent renames", () => {
    const project = mkProject([mkFile({
      id: "f1", name: "Genesis", originalName: "genesis.usfm",
    })])
    const next = renameFile(project, "f1", "Book of Beginnings")
    expect(next.files[0].originalName).toBe("genesis.usfm")
    expect(next.files[0].name).toBe("Book of Beginnings")
  })
  it("throws if new name collides with another file in the project", () => {
    const project = mkProject([
      mkFile({ id: "f1", name: "Genesis" }),
      mkFile({ id: "f2", name: "Exodus" }),
    ])
    expect(() => renameFile(project, "f1", "Exodus")).toThrow(/already exists/i)
  })
  it("allows renaming to the same name (no-op)", () => {
    const project = mkProject([mkFile({ id: "f1", name: "Genesis" })])
    const next = renameFile(project, "f1", "Genesis")
    expect(next.files[0].name).toBe("Genesis")
    expect(next.files[0].originalName).toBeUndefined()
  })
  it("throws if fileId not found", () => {
    const project = mkProject([mkFile({ id: "f1" })])
    expect(() => renameFile(project, "missing", "x")).toThrow(/not found/i)
  })
  it("returns a new project object (immutable)", () => {
    const project = mkProject([mkFile({ id: "f1", name: "a" })])
    const next = renameFile(project, "f1", "b")
    expect(next).not.toBe(project)
    expect(next.files).not.toBe(project.files)
  })
  it("throws on empty/whitespace-only new name", () => {
    const project = mkProject([mkFile({ id: "f1", name: "a" })])
    expect(() => renameFile(project, "f1", "   ")).toThrow(/empty/i)
  })
})

describe("moveFileToCorpus", () => {
  it("sets corpusMarker", () => {
    const project = mkProject([mkFile({ id: "f1", corpusMarker: "OT" })])
    const next = moveFileToCorpus(project, "f1", "NT")
    expect(next.files[0].corpusMarker).toBe("NT")
  })
  it("clears corpusMarker when given empty string", () => {
    const project = mkProject([mkFile({ id: "f1", corpusMarker: "OT" })])
    const next = moveFileToCorpus(project, "f1", "")
    expect(next.files[0].corpusMarker).toBeUndefined()
  })
})

describe("renameCorpus", () => {
  it("rewrites corpusMarker on every member of the group", () => {
    const project = mkProject([
      mkFile({ id: "f1", corpusMarker: "OT" }),
      mkFile({ id: "f2", corpusMarker: "OT" }),
      mkFile({ id: "f3", corpusMarker: "NT" }),
    ])
    const next = renameCorpus(project, "OT", "Old Testament")
    expect(next.files[0].corpusMarker).toBe("Old Testament")
    expect(next.files[1].corpusMarker).toBe("Old Testament")
    expect(next.files[2].corpusMarker).toBe("NT")
  })
  it("is a no-op when no files match", () => {
    const project = mkProject([mkFile({ id: "f1", corpusMarker: "NT" })])
    const next = renameCorpus(project, "OT", "Old Testament")
    expect(next.files[0].corpusMarker).toBe("NT")
  })
})

describe("deleteFile", () => {
  it("removes the file", () => {
    const project = mkProject([
      mkFile({ id: "f1" }),
      mkFile({ id: "f2", name: "Exodus" }),
    ])
    const next = deleteFile(project, "f1")
    expect(next.files).toHaveLength(1)
    expect(next.files[0].id).toBe("f2")
  })
  it("is a no-op when file not found", () => {
    const project = mkProject([mkFile({ id: "f1" })])
    const next = deleteFile(project, "missing")
    expect(next.files).toHaveLength(1)
  })
})
