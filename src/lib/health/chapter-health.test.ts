import { describe, expect, it } from "vitest"
import { chapterHealthBuilderFor, createChapterHealthBuilder, type ChapterHealthSource } from "./chapter-health"

interface Summary {
  status: string
  translated: string
}

function harness() {
  const summaries = new Map<string, Summary>([
    ["a", { status: "validated", translated: "done" }],
    ["b", { status: "unvalidated", translated: "draft" }],
    ["c", { status: "empty", translated: "" }],
    ["d", { status: "unvalidated", translated: "draft" }],
  ])
  const health = new Map<string, number>([["b", 55], ["d", 70]])
  const issues = new Set<string>(["d"])
  const chapters: ChapterHealthSource[] = [
    { key: "1", label: "GEN 1", translated: 2, validated: 1, total: 3, cellIds: ["a", "b", "c"] },
    { key: "2", label: "GEN 2", translated: 1, validated: 0, total: 1, cellIds: ["d"] },
  ]
  const readers = {
    getSummary: (id: string) => summaries.get(id),
    health: (id: string) => health.get(id),
    hasIssue: (id: string) => issues.has(id),
  }
  return { summaries, health, issues, chapters, readers, builder: createChapterHealthBuilder() }
}

describe("createChapterHealthBuilder", () => {
  it("derives the same chapter map the workspace built from scratch", () => {
    const h = harness()
    expect(h.builder.build(h.chapters, h.readers)).toEqual([
      {
        key: "1", label: "GEN 1", translated: 2, validated: 1, total: 3,
        cells: [
          { id: "a", stage: "validated", health: 100, hasIssue: false },
          { id: "b", stage: "automatic", health: 55, hasIssue: false },
          { id: "c", stage: "untranslated", health: undefined, hasIssue: false },
        ],
      },
      {
        key: "2", label: "GEN 2", translated: 1, validated: 0, total: 1,
        cells: [{ id: "d", stage: "automatic", health: 70, hasIssue: true }],
      },
    ])
  })

  it("returns the same array when nothing changed", () => {
    const h = harness()
    const first = h.builder.build(h.chapters, h.readers)
    const second = h.builder.build(h.chapters.map((chapter) => ({ ...chapter })), h.readers)
    expect(second).toBe(first)
  })

  it("replaces only the chapter holding a changed cell", () => {
    const h = harness()
    const first = h.builder.build(h.chapters, h.readers)
    h.health.set("d", 20)

    const second = h.builder.build(h.chapters, h.readers)
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1].cells?.[0]).toEqual({ id: "d", stage: "automatic", health: 20, hasIssue: true })
  })

  it("keeps unchanged cell objects inside a chapter that changed", () => {
    const h = harness()
    const first = h.builder.build(h.chapters, h.readers)
    h.summaries.set("c", { status: "unvalidated", translated: "now drafted" })
    h.health.set("c", 40)

    const second = h.builder.build(h.chapters, h.readers)
    expect(second[0].cells?.[0]).toBe(first[0].cells?.[0])
    expect(second[0].cells?.[1]).toBe(first[0].cells?.[1])
    expect(second[0].cells?.[2]).toEqual({ id: "c", stage: "automatic", health: 40, hasIssue: false })
  })

  it("replaces a chapter whose counts changed even when its cells did not", () => {
    const h = harness()
    const first = h.builder.build(h.chapters, h.readers)
    const chapters = [{ ...h.chapters[0], translated: 3 }, h.chapters[1]]

    const second = h.builder.build(chapters, h.readers)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].translated).toBe(3)
    expect(second[1]).toBe(first[1])
  })

  it("reflects an issue appearing on a cell", () => {
    const h = harness()
    h.builder.build(h.chapters, h.readers)
    h.issues.add("b")
    const next = h.builder.build(h.chapters, h.readers)
    expect(next[0].cells?.[1]).toMatchObject({ id: "b", hasIssue: true })
  })

  it("skips cells with no summary and notices when a chapter's membership changes", () => {
    const h = harness()
    const first = h.builder.build([{ ...h.chapters[0], cellIds: ["a", "ghost", "b", "c"] }], h.readers)
    expect(first[0].cells?.map((cell) => cell.id)).toEqual(["a", "b", "c"])

    const second = h.builder.build([{ ...h.chapters[0], cellIds: ["a", "b"] }], h.readers)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].cells?.map((cell) => cell.id)).toEqual(["a", "b"])
  })

  it("clear() forgets identities so the next build allocates afresh", () => {
    const h = harness()
    const first = h.builder.build(h.chapters, h.readers)
    h.builder.clear()
    const second = h.builder.build(h.chapters, h.readers)
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  })
})

describe("chapterHealthBuilderFor", () => {
  it("returns one builder per store and a different builder for another store", () => {
    const storeA = {}
    const storeB = {}
    expect(chapterHealthBuilderFor(storeA)).toBe(chapterHealthBuilderFor(storeA))
    expect(chapterHealthBuilderFor(storeA)).not.toBe(chapterHealthBuilderFor(storeB))
  })
})
