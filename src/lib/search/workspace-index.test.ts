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
    expect(results[0].fileId).toBe("f1")
    expect(results[0].fileName).toBe("test.txt")
  })

  it("finds matches on target text", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "Hello", translated: "Bonjour le monde", context: "P1" }),
    ]}])
    const results = index.search("monde")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
  })

  it("finds matches on context", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "text", translated: "", context: "Genesis 3:15" }),
    ]}])
    const results = index.search("Genesis")
    expect(results).toHaveLength(1)
    expect(results[0].cellId).toBe("c1")
  })

  it("returns matched tokens", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "God created the heavens", translated: "", context: "" }),
    ]}])
    const results = index.search("God heavens")
    expect(results[0].matchedTokens).toContain("god")
    expect(results[0].matchedTokens).toContain("heavens")
  })

  it("ranks more matches higher", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "cat only", translated: "", context: "" }),
      makeCell({ id: "c2", original: "cat and dog together", translated: "", context: "" }),
    ]}])
    const results = index.search("cat dog together")
    expect(results[0].cellId).toBe("c2")
  })

  it("respects limit", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "hello world", translated: "", context: "" }),
      makeCell({ id: "c2", original: "hello there", translated: "", context: "" }),
      makeCell({ id: "c3", original: "hello friend", translated: "", context: "" }),
    ]}])
    const results = index.search("hello", 2)
    expect(results).toHaveLength(2)
  })

  it("searches across multiple files", () => {
    index.buildFromProject([
      { fileId: "f1", fileName: "one.txt", cells: [makeCell({ id: "c1", original: "apple", translated: "", context: "" })] },
      { fileId: "f2", fileName: "two.txt", cells: [makeCell({ id: "c2", original: "apple banana", translated: "", context: "" })] },
    ])
    const results = index.search("apple")
    expect(results).toHaveLength(2)
    const fileIds = results.map((r) => r.fileId)
    expect(fileIds).toContain("f1")
    expect(fileIds).toContain("f2")
  })

  it("indexes empty cells too (unlike SearchIndex)", () => {
    index.buildFromProject([{ fileId: "f1", fileName: "test.txt", cells: [
      makeCell({ id: "c1", original: "empty target cell", translated: "", context: "" }),
    ]}])
    const results = index.search("empty")
    expect(results).toHaveLength(1)
  })
})
