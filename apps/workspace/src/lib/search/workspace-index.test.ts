import { describe, it, expect, beforeEach } from "vitest"
import { WorkspaceIndex } from "./workspace-index"
import type { ExportCell } from "@/lib/store/file-doc"

function makeCell(overrides: Partial<ExportCell> & { id: string }): ExportCell {
  return {
    original: "", translated: "", context: "", group: "", type: "text",
    ...overrides,
  }
}

describe("WorkspaceIndex", () => {
  let index: WorkspaceIndex
  beforeEach(() => { index = new WorkspaceIndex() })

  it("returns empty results for empty query", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "Hello", translated: "Bonjour", context: "P1" }),
    ]}])
    expect(index.search("")).toHaveLength(0)
  })

  it("finds matches on source text", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "In the beginning God created", translated: "", context: "V1" }),
    ]}])
    const results = index.search("beginning")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
    expect(results[0].matchedFields.has("original")).toBe(true)
  })

  it("finds matches on target text", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "Hello", translated: "Bonjour le monde", context: "P1" }),
    ]}])
    const results = index.search("monde")
    expect(results).toHaveLength(1)
    expect(results[0].matchedFields.has("translated")).toBe(true)
  })

  it("finds matches on context", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "text", translated: "", context: "Genesis 3:15" }),
    ]}])
    const results = index.search("Genesis")
    expect(results).toHaveLength(1)
    expect(results[0].matchedFields.has("context")).toBe(true)
  })

  it("does partial / prefix matching (issue #25)", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "Abraham was a man", translated: "", context: "" }),
    ]}])
    expect(index.search("Abraha")).toHaveLength(1)
    expect(index.search("brah")).toHaveLength(1)
  })

  it("matchCount counts all literal occurrences", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "cat cat cat", translated: "dog cat", context: "" }),
    ]}])
    const [r] = index.search("cat")
    expect(r.matchCount).toBe(4)
  })

  it("respects match-case (issue #24)", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "abraham", translated: "", context: "" }),
      makeCell({ id: "c2", original: "Abraham", translated: "", context: "" }),
    ]}])
    const insensitive = index.search("Abraham")
    expect(insensitive).toHaveLength(2)
    const sensitive = index.search("Abraham", { caseSensitive: true })
    expect(sensitive).toHaveLength(1)
    expect(sensitive[0].cellId).toBe("c2")
  })

  it("scopes by fileId (issue #23)", () => {
    index.buildFromProject([
      { fileId: "f1", fileName: "a.txt", cells: [makeCell({ id: "c1", original: "apple" })] },
      { fileId: "f2", fileName: "b.txt", cells: [makeCell({ id: "c2", original: "apple" })] },
    ])
    expect(index.search("apple")).toHaveLength(2)
    const scoped = index.search("apple", { fileId: "f1" })
    expect(scoped).toHaveLength(1)
    expect(scoped[0].fileId).toBe("f1")
  })

  it("respects limit", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "hello world" }),
      makeCell({ id: "c2", original: "hello there" }),
      makeCell({ id: "c3", original: "hello friend" }),
    ]}])
    const results = index.search("hello", { limit: 2 })
    expect(results).toHaveLength(2)
  })

  it("strips HTML tags from indexed text", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "Hello <b>brave</b> world" }),
    ]}])
    expect(index.search("brave")).toHaveLength(1)
    expect(index.search("<b>")).toHaveLength(0)
  })

  it("indexes empty cells too", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "empty target cell" }),
    ]}])
    expect(index.search("empty")).toHaveLength(1)
  })
})
