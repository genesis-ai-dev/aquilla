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

// AQU-1083. The chapter map is one of two places that count cells in the
// browser rather than reading a number the server resolved, so it is one of
// two places the policy has to be applied by hand.
describe("headings a project does not count (AQU-1083)", () => {
  it("marks them excluded rather than untranslated, and scores them not at all", () => {
    // An untypeset heading and an untranslated verse look identical to
    // getSummary — both empty. Only the exclusion tells them apart, and
    // getting it wrong leaves a chapter title looking like outstanding work,
    // which is the confusion this whole setting exists to remove.
    const h = harness()
    h.summaries.set("c", { status: "empty", translated: "" })
    const cells = h.builder.build(h.chapters, {
      ...h.readers,
      isExcluded: (id: string) => id === "c",
    })[0].cells!
    expect(cells.map((cell) => cell.stage)).toEqual(["validated", "automatic", "excluded"])
    expect(cells[2].health).toBeUndefined()
  })

  it("keeps a square for every cell — the map still shows the whole file", () => {
    const h = harness()
    const cells = h.builder.build(h.chapters, {
      ...h.readers,
      isExcluded: (id: string) => id === "c",
    })[0].cells!
    expect(cells).toHaveLength(3)
  })

  it("never scores an excluded cell even when it has been translated", () => {
    // A team can translate its headings and still not want them counted.
    const h = harness()
    const cells = h.builder.build(h.chapters, {
      ...h.readers,
      isExcluded: (id: string) => id === "a",
    })[0].cells!
    expect(cells[0]).toMatchObject({ id: "a", stage: "excluded", health: undefined })
  })

  it("behaves exactly as before when the reader is absent", () => {
    const h = harness()
    expect(h.builder.build(h.chapters, h.readers))
      .toEqual(createChapterHealthBuilder().build(h.chapters, { ...h.readers, isExcluded: () => false }))
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
