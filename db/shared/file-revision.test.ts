import { describe, expect, it } from "vitest"
import { v5 as uuidv5 } from "uuid"
import {
  alignRevision,
  classifyTargetStaleness,
  contentHashOf,
  diceSimilarity,
  formatFilterStamp,
  optionsHash,
  parseFilterStamp,
  revisionCellId,
  uuidV5,
  type RevisionManifest,
  type RevisionUnitInput,
} from "./file-revision"

const FILE_ID = "018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b47"

function para(index: number, text: string): RevisionUnitInput {
  return { unitKey: `docx:word/document.xml:p[${index}]`, positional: true, text, sequenceIndex: index }
}

function verse(ref: string, text: string, sequenceIndex: number): RevisionUnitInput {
  return { unitKey: ref, positional: false, text, canonicalRef: ref, sequenceIndex }
}

function manifestFrom(units: readonly RevisionUnitInput[], revisionN = 1): RevisionManifest {
  const delta = alignRevision(null, units, { fileId: FILE_ID, revisionN })
  return {
    fileId: FILE_ID,
    revisionN,
    parentRevisionN: null,
    stamp: "docx@1",
    optionsHash: optionsHash({}),
    artifactSha256: "deadbeef",
    units: delta.units.map((u) => u.unit),
  }
}

describe("uuidV5", () => {
  // The sync-worker has no `uuid` dependency, so the primitive is in-house.
  // Every derived id and hash rests on it matching the reference exactly.
  it("matches the uuid package for ASCII and multi-byte names", () => {
    const ns = "adbd5e28-362b-4a7f-9a3b-d8932bc2c265"
    for (const name of ["", "TIT 1:1", "cell:r2:docx:p[7]", "Καὶ εἶπεν ὁ θεός", "😀 emoji", "x".repeat(200)]) {
      expect(uuidV5(name, ns)).toBe(uuidv5(name, ns))
    }
  })
})

describe("filter stamps", () => {
  it("round-trips and treats a bare id as walk 1 (AQU-2382 read-side rule)", () => {
    expect(formatFilterStamp({ filterId: "builtin:idml-roundtrip", walk: 2 })).toBe("builtin:idml-roundtrip@2")
    expect(parseFilterStamp("builtin:idml-roundtrip@2")).toEqual({ filterId: "builtin:idml-roundtrip", walk: 2 })
    expect(parseFilterStamp("builtin:docx")).toEqual({ filterId: "builtin:docx", walk: 1 })
    expect(parseFilterStamp("weird@notanumber")).toEqual({ filterId: "weird@notanumber", walk: 1 })
  })

  it("hashes options independent of key order and undefined values", () => {
    expect(optionsHash({ cellUnit: "paragraph", name: "a" })).toBe(optionsHash({ name: "a", cellUnit: "paragraph" }))
    expect(optionsHash({})).toBe(optionsHash({ cellUnit: undefined }))
    expect(optionsHash(undefined)).toBe(optionsHash({}))
    expect(optionsHash({ cellUnit: "paragraph" })).not.toBe(optionsHash({ cellUnit: "sentence" }))
  })
})

describe("contentHashOf", () => {
  it("ignores the differences ICE matching already ignores", () => {
    expect(contentHashOf("It’s  a te­st ")).toBe(contentHashOf("It's a test"))
    expect(contentHashOf("It's a test")).not.toBe(contentHashOf("It's a text"))
  })
})

describe("revisionCellId", () => {
  it("is deterministic per file and distinct per revision for the same key", () => {
    expect(revisionCellId(FILE_ID, 1, "k")).toBe(revisionCellId(FILE_ID, 1, "k"))
    expect(revisionCellId(FILE_ID, 1, "k")).not.toBe(revisionCellId(FILE_ID, 2, "k"))
    expect(revisionCellId(FILE_ID, 1, "k")).not.toBe(revisionCellId("018f6b2e-1c2a-7a2e-9a0e-5c0c7a1d2b48", 1, "k"))
  })
})

describe("alignRevision — revision 1", () => {
  it("mints a deterministic id per unit and reports every unit inserted", () => {
    const units = [para(0, "In the beginning"), para(1, "God created")]
    const a = alignRevision(null, units, { fileId: FILE_ID, revisionN: 1 })
    const b = alignRevision(null, units, { fileId: FILE_ID, revisionN: 1 })
    expect(a.units.map((u) => u.unit.cellId)).toEqual(b.units.map((u) => u.unit.cellId))
    expect(a.counts).toEqual({ equal: 0, changed: 0, moved: 0, inserted: 2, deleted: 0 })
    expect(a.units[0].unit.cellId).toBe(revisionCellId(FILE_ID, 1, units[0].unitKey))
  })

  it("refuses a parse that repeats a unit key", () => {
    expect(() => alignRevision(null, [para(0, "a"), para(0, "b")], { fileId: FILE_ID, revisionN: 1 })).toThrow(
      /duplicate unitKey/,
    )
  })
})

describe("alignRevision — positional documents", () => {
  const original = [
    para(0, "Chapter One"),
    para(1, "The quick brown fox jumps over the lazy dog."),
    para(2, "Amen."),
    para(3, "A second paragraph about something else entirely."),
    para(4, "Amen."),
    para(5, "The end."),
  ]

  it("an insertion shifts nothing: neighbours keep their ids (AQU-2380 finding 1's class)", () => {
    const parent = manifestFrom(original)
    const next = [
      original[0],
      original[1],
      { ...para(2, "A brand new paragraph nobody has translated."), unitKey: "docx:word/document.xml:p[2]" },
      { ...original[2], unitKey: "docx:word/document.xml:p[3]", sequenceIndex: 3 },
      { ...original[3], unitKey: "docx:word/document.xml:p[4]", sequenceIndex: 4 },
      { ...original[4], unitKey: "docx:word/document.xml:p[5]", sequenceIndex: 5 },
      { ...original[5], unitKey: "docx:word/document.xml:p[6]", sequenceIndex: 6 },
    ]
    const delta = alignRevision(parent, next, { fileId: FILE_ID, revisionN: 2 })
    expect(delta.counts).toEqual({ equal: 6, changed: 0, moved: 0, inserted: 1, deleted: 0 })
    // Every old unit continues under its old id, in order, around the insert.
    const ids = delta.units.map((u) => u.unit.cellId)
    expect(ids.filter((_, i) => i !== 2)).toEqual(parent.units.map((u) => u.cellId))
    expect(delta.units[2].outcome).toBe("inserted")
    expect(ids[2]).toBe(revisionCellId(FILE_ID, 2, next[2].unitKey))
    // Repeated "Amen." paragraphs pair with their own twin, not each other.
    expect(delta.units[3].parent?.cellId).toBe(parent.units[2].cellId)
    expect(delta.units[5].parent?.cellId).toBe(parent.units[4].cellId)
  })

  it("an edited paragraph keeps its id and is `changed`, so its translation stays attached", () => {
    const parent = manifestFrom(original)
    const next = original.map((u, i) => (i === 1 ? { ...u, text: "The quick brown fox jumps over the sleepy dog." } : u))
    const delta = alignRevision(parent, next, { fileId: FILE_ID, revisionN: 2 })
    expect(delta.counts).toEqual({ equal: 5, changed: 1, moved: 0, inserted: 0, deleted: 0 })
    expect(delta.units[1].outcome).toBe("changed")
    expect(delta.units[1].unit.cellId).toBe(parent.units[1].cellId)
    expect(delta.units[1].unit.contentHash).not.toBe(parent.units[1].contentHash)
  })

  it("a rewritten paragraph is delete + insert, never a false continuation", () => {
    const parent = manifestFrom(original)
    const next = original.map((u, i) => (i === 3 ? { ...u, text: "Completely unrelated replacement text here." } : u))
    const delta = alignRevision(parent, next, { fileId: FILE_ID, revisionN: 2 })
    expect(delta.counts).toEqual({ equal: 5, changed: 0, moved: 0, inserted: 1, deleted: 1 })
    expect(delta.deleted[0].cellId).toBe(parent.units[3].cellId)
    expect(delta.units[3].outcome).toBe("inserted")
  })

  it("a paragraph moved elsewhere keeps its id and is `moved`", () => {
    const parent = manifestFrom(original)
    const moved = [original[0], original[2], original[3], original[4], original[1], original[5]].map((u, i) => ({
      ...u,
      unitKey: `docx:word/document.xml:p[${i}]`,
      sequenceIndex: i,
    }))
    const delta = alignRevision(parent, moved, { fileId: FILE_ID, revisionN: 2 })
    expect(delta.counts.deleted).toBe(0)
    expect(delta.counts.inserted).toBe(0)
    const fox = delta.units.find((u) => u.unit.text.startsWith("The quick"))
    expect(fox?.unit.cellId).toBe(parent.units[1].cellId)
    expect(["moved", "equal"]).toContain(fox?.outcome)
    expect(delta.counts.moved).toBeGreaterThanOrEqual(1)
  })

  it("deleting a paragraph tombstones exactly that one", () => {
    const parent = manifestFrom(original)
    const next = original.filter((_, i) => i !== 3).map((u, i) => ({ ...u, unitKey: `docx:word/document.xml:p[${i}]`, sequenceIndex: i }))
    const delta = alignRevision(parent, next, { fileId: FILE_ID, revisionN: 2 })
    expect(delta.counts).toEqual({ equal: 5, changed: 0, moved: 0, inserted: 0, deleted: 1 })
    expect(delta.deleted.map((u) => u.cellId)).toEqual([parent.units[3].cellId])
  })

  it("is a pure function: replaying the same inputs re-derives the same ids", () => {
    const parent = manifestFrom(original)
    const next = [...original.slice(0, 2), para(2, "inserted"), ...original.slice(2).map((u, i) => ({ ...u, unitKey: `docx:word/document.xml:p[${i + 3}]` }))]
    const a = alignRevision(parent, next, { fileId: FILE_ID, revisionN: 2 })
    const b = alignRevision(parent, next, { fileId: FILE_ID, revisionN: 2 })
    expect(a).toEqual(b)
  })
})

describe("alignRevision — reference-addressed units", () => {
  it("pairs by key regardless of position; a changed verse is `changed`, a new verse `inserted`", () => {
    const parent = manifestFrom([verse("GEN 1:1", "In the beginning", 0), verse("GEN 1:2", "And the earth", 1)])
    const next = [verse("GEN 1:2", "And the earth", 0), verse("GEN 1:1", "In the beginning God", 1), verse("GEN 1:3", "Let there be light", 2)]
    const delta = alignRevision(parent, next, { fileId: FILE_ID, revisionN: 2 })
    expect(delta.counts).toEqual({ equal: 1, changed: 1, moved: 0, inserted: 1, deleted: 0 })
    expect(delta.units[1].unit.cellId).toBe(parent.units[0].cellId)
    expect(delta.units[1].outcome).toBe("changed")
  })

  it("never pairs a keyed unit with a positional one", () => {
    const parent = manifestFrom([verse("GEN 1:1", "Same text", 0)])
    const delta = alignRevision(parent, [para(0, "Same text")], { fileId: FILE_ID, revisionN: 2 })
    expect(delta.counts).toEqual({ equal: 0, changed: 0, moved: 0, inserted: 1, deleted: 1 })
  })
})

describe("diceSimilarity", () => {
  it("is 1 for identical, 0 for disjoint, and high for a one-word edit", () => {
    expect(diceSimilarity("a b c", "a b c")).toBe(1)
    expect(diceSimilarity("alpha beta", "gamma delta")).toBe(0)
    expect(diceSimilarity("The quick brown fox jumps", "The quick brown fox leaps")).toBeGreaterThan(0.6)
  })
})

describe("classifyTargetStaleness", () => {
  const pinned = { revisionN: 3, contentHash: "h1" }
  it("is fresh while the head has not moved past the pin", () => {
    expect(classifyTargetStaleness(pinned, { revisionN: 3, contentHash: "h1" })).toBe("fresh")
  })
  it("is stale only when the head moved AND the content changed", () => {
    expect(classifyTargetStaleness(pinned, { revisionN: 4, contentHash: "h2" })).toBe("stale")
    expect(classifyTargetStaleness(pinned, { revisionN: 4, contentHash: "h1" })).toBe("fresh")
  })
  it("reports a tombstoned source as source-deleted", () => {
    expect(classifyTargetStaleness(pinned, { revisionN: 4, contentHash: null })).toBe("source-deleted")
  })
})
