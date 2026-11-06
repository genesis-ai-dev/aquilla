import { describe, it, expect } from "vitest"
import { projectBookNames } from "./project-book-names"
import type { FileReference } from "@/lib/parsers/types"

const file = (over: Partial<FileReference>): FileReference => ({
  id: over.id ?? "f1",
  name: over.name ?? "file",
  type: "usfm",
  createdAt: "2026-01-01T00:00:00.000Z",
  cellCount: 1,
  ...over,
})

describe("projectBookNames", () => {
  it("returns null when the project has no files", () => {
    expect(projectBookNames(undefined)).toBeNull()
    expect(projectBookNames([])).toBeNull()
  })

  it("returns null when no file names a book", () => {
    expect(projectBookNames([file({ name: "Glossary" })])).toBeNull()
  })

  it("collects every name a file carries for its book", () => {
    const table = projectBookNames([
      file({ id: "a", bookCode: "JHN", name: "Jhn", displayLabel: "Jhn · ULT", originalName: "44-JHN.usfm" }),
    ])
    expect(table).toHaveLength(1)
    expect(table?.[0].code).toBe("JHN")
    expect(new Set(table?.[0].names)).toEqual(new Set(["Jhn", "Jhn · ULT", "44-JHN.usfm"]))
  })

  it("merges the names of several files for the same book", () => {
    const table = projectBookNames([
      file({ id: "a", bookCode: "JHN", name: "Jhn" }),
      file({ id: "b", bookCode: "JHN", name: "Yuhana" }),
    ])
    expect(table).toHaveLength(1)
    expect(new Set(table?.[0].names)).toEqual(new Set(["Jhn", "Yuhana"]))
  })

  it("ignores a bookCode the canonical table does not know", () => {
    expect(projectBookNames([file({ bookCode: "ZZZ", name: "Nope" })])).toBeNull()
  })
})
