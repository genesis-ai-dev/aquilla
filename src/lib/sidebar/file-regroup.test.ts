// AQU-1702 — what "put this file in that group" writes, and the one drop it
// refuses. The component test drives a real drag through this same function,
// so the refusal a user sees and the refusal pinned here are the same rule.

import { describe, it, expect } from "vitest"
import { planFileRegroup, type RegroupableFile } from "./file-regroup"
import { SORT_INDEX_STEP, type PlaceableFile } from "./file-sort-index"

function file(id: string, extra: Partial<RegroupableFile> = {}): RegroupableFile & { id: string } {
  return { id, name: id, type: "usfm", ...extra }
}

/** A target group as the sidebar sees it: already in visual order. */
function group(...spec: [string, number?][]): PlaceableFile[] {
  return spec.map(([id, sortIndex]) =>
    sortIndex === undefined ? { id } : { id, sortIndex },
  )
}

describe("planFileRegroup — the group it writes", () => {
  it("writes the target group as the file's corpus marker", () => {
    const plan = planFileRegroup({
      file: file("episode-2", { corpusMarker: "Season 1", sortIndex: 0 }),
      targetGroup: "Season 2",
      targetFiles: group(["pilot", 0], ["finale", SORT_INDEX_STEP]),
      toPosition: 1,
    })
    expect(plan).toEqual({
      ok: true,
      corpusMarker: "Season 2",
      writes: [{ fileId: "episode-2", sortIndex: SORT_INDEX_STEP / 2 }],
    })
  })

  it("clears the marker when the target is the Ungrouped bucket", () => {
    // A file with no book code has nothing to fall back to, so clearing its
    // marker really does leave it ungrouped.
    const plan = planFileRegroup({
      file: file("notes", { corpusMarker: "Season 1", type: "docx" }),
      targetGroup: "Ungrouped",
      targetFiles: group(["readme", 0]),
      toPosition: 0,
    })
    expect(plan).toMatchObject({ ok: true, corpusMarker: null })
  })

  it("lands at the end of the group when the pointer was on the group itself", () => {
    // A collapsed group, or its header: there is no row to take a slot from.
    const plan = planFileRegroup({
      file: file("episode-2", { corpusMarker: "Season 1" }),
      targetGroup: "Season 2",
      targetFiles: group(["pilot", 0], ["finale", SORT_INDEX_STEP]),
      toPosition: null,
    })
    expect(plan).toEqual({
      ok: true,
      corpusMarker: "Season 2",
      writes: [{ fileId: "episode-2", sortIndex: SORT_INDEX_STEP * 2 }],
    })
  })

  it("is the first placement in a group nobody has ordered by hand", () => {
    const plan = planFileRegroup({
      file: file("episode-2", { corpusMarker: "Season 1" }),
      targetGroup: "Season 2",
      targetFiles: group(["pilot"], ["finale"]),
      toPosition: 0,
    })
    expect(plan).toEqual({
      ok: true,
      corpusMarker: "Season 2",
      writes: [
        { fileId: "episode-2", sortIndex: 0 },
        { fileId: "pilot", sortIndex: SORT_INDEX_STEP },
        { fileId: "finale", sortIndex: SORT_INDEX_STEP * 2 },
      ],
    })
  })
})

describe("planFileRegroup — the drop it refuses", () => {
  // The guardrail AQU-1702 asks for: never a silent visual-only move. A Bible
  // book with no marker is filed by its book code, so "Ungrouped" is a group
  // it cannot be put in — the drop would appear to do nothing at all.
  it("refuses sending a Bible book to Ungrouped, naming where it stays", () => {
    const plan = planFileRegroup({
      file: file("gen", { name: "GEN", corpusMarker: "Season 1" }),
      targetGroup: "Ungrouped",
      targetFiles: group(["notes", 0]),
      toPosition: 0,
    })
    expect(plan).toEqual({
      ok: false,
      reason: "derived-group",
      targetGroup: "Ungrouped",
      landsIn: "OT",
    })
  })

  it("accepts the same book into its own derived testament group", () => {
    // Dropping GEN on OT writes the marker "OT", which is where the book-code
    // fallback puts it anyway — the move is expressible, so it is allowed.
    const plan = planFileRegroup({
      file: file("gen", { name: "GEN" }),
      targetGroup: "OT",
      targetFiles: group(["exo", 0]),
      toPosition: 0,
    })
    expect(plan).toMatchObject({ ok: true, corpusMarker: "OT" })
  })

  it("accepts a New Testament book into a named group of its own", () => {
    const plan = planFileRegroup({
      file: file("act", { name: "ACT" }),
      targetGroup: "Luke–Acts",
      targetFiles: [],
      toPosition: null,
    })
    expect(plan).toEqual({
      ok: true,
      corpusMarker: "Luke–Acts",
      writes: [{ fileId: "act", sortIndex: 0 }],
    })
  })

  it("lets a non-scripture file be dropped on Ungrouped", () => {
    const plan = planFileRegroup({
      file: file("glossary", { name: "glossary", type: "docx", corpusMarker: "Reference" }),
      targetGroup: "Ungrouped",
      targetFiles: [],
      toPosition: null,
    })
    expect(plan).toMatchObject({ ok: true, corpusMarker: null })
  })
})
