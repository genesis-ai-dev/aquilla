import { describe, it, expect } from "vitest"
import {
  renameFile, moveFileToCorpus, renameCorpus, deleteFile, applyFileSortIndexes,
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

// AQU-1569: the optimistic half of a reorder — the sidebar has to show the new
// order on drop, not on the next server read.
describe("applyFileSortIndexes", () => {
  it("writes each file's new position", () => {
    const project = mkProject([
      mkFile({ id: "f1", name: "A" }),
      mkFile({ id: "f2", name: "B" }),
    ])
    const next = applyFileSortIndexes(project, [
      { fileId: "f2", sortIndex: 0 },
      { fileId: "f1", sortIndex: 1024 },
    ])
    expect(next.files.map((f) => [f.id, f.sortIndex])).toEqual([["f1", 1024], ["f2", 0]])
  })

  it("stores 0 rather than dropping it", () => {
    // 0 is what a renumber stamps on the first file; a truthiness check here
    // would silently unplace it and the row would jump back on the next render.
    const project = mkProject([mkFile({ id: "f1", sortIndex: 512 })])
    expect(applyFileSortIndexes(project, [{ fileId: "f1", sortIndex: 0 }]).files[0].sortIndex).toBe(0)
  })

  it("removes the field for null, rather than setting it to null", () => {
    // `groupByCorpus` asks whether the field is a finite number; a literal null
    // would read as unplaced either way, but the cached record is also written
    // back to IDB, and "absent" is the shape the server sends.
    const project = mkProject([mkFile({ id: "f1", sortIndex: 512 })])
    const next = applyFileSortIndexes(project, [{ fileId: "f1", sortIndex: null }])
    expect("sortIndex" in next.files[0]).toBe(false)
  })

  it("leaves files the batch does not name alone", () => {
    const project = mkProject([
      mkFile({ id: "f1", sortIndex: 0 }),
      mkFile({ id: "f2", name: "B" }),
    ])
    const next = applyFileSortIndexes(project, [{ fileId: "f1", sortIndex: 99 }])
    expect(next.files[1]).toBe(project.files[1])
  })

  it("returns the same project for an empty batch", () => {
    const project = mkProject([mkFile({ id: "f1" })])
    expect(applyFileSortIndexes(project, [])).toBe(project)
  })

  // Unlike its single-file neighbours this does NOT throw: the writes come
  // from a group the sidebar rendered, and a file deleted in another tab
  // between the render and the drop must not cost the rest of the batch.
  it("ignores an id it cannot find instead of throwing", () => {
    const project = mkProject([mkFile({ id: "f1" })])
    const next = applyFileSortIndexes(project, [
      { fileId: "gone", sortIndex: 0 },
      { fileId: "f1", sortIndex: 1024 },
    ])
    expect(next.files).toHaveLength(1)
    expect(next.files[0].sortIndex).toBe(1024)
  })
})
