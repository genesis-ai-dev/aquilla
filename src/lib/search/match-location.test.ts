import { describe, expect, it } from "vitest"
import { assignMatchPlaces } from "./match-location"

const FILE = "019f19ed-27ae-7000-8000-000000000001"
const CELL_A = "019f19eb-eb40-7000-8000-0000000000a1"
const CELL_B = "019f19eb-eb40-7000-8000-0000000000b2"

describe("assignMatchPlaces", () => {
  it("names a scripture cell by book, chapter, and verse", () => {
    const [place] = assignMatchPlaces([
      {
        cellId: CELL_A,
        fileId: FILE,
        fileName: FILE,
        canonicalRef: "GEN 1:1",
        cellType: "verse",
        position: 1,
      },
    ])
    expect(place).toEqual({ place: { kind: "text", text: "Genesis 1:1" } })
  })

  it("numbers split verses that share a reference, in file order", () => {
    const places = assignMatchPlaces([
      {
        cellId: CELL_B,
        fileId: FILE,
        canonicalRef: "GEN 1:1",
        cellType: "verse",
        position: 2,
      },
      {
        cellId: CELL_A,
        fileId: FILE,
        canonicalRef: "GEN 1:1",
        cellType: "verse",
        position: 1,
      },
    ])
    expect(places[0]).toMatchObject({ place: { text: "Genesis 1:1" }, index: 2, total: 2 })
    expect(places[1]).toMatchObject({ place: { text: "Genesis 1:1" }, index: 1, total: 2 })
  })

  it("uses a section label for a heading, not the verse it sits beside", () => {
    const [place] = assignMatchPlaces([
      {
        cellId: CELL_A,
        fileId: FILE,
        canonicalRef: "GEN 1:1",
        cellType: "heading",
        placeLabel: "Creation",
        position: 1,
      },
    ])
    expect(place.place).toEqual({ kind: "text", text: "Creation" })
  })

  it("falls back to the chapter when a heading has no label of its own", () => {
    const [place] = assignMatchPlaces([
      {
        cellId: CELL_A,
        fileId: FILE,
        canonicalRef: "GEN 1:1",
        cellType: "paratext",
        position: 1,
      },
    ])
    expect(place.place).toEqual({ kind: "text", text: "Genesis 1" })
  })

  it("names a non-scripture cell by file and position, never by id", () => {
    const [place] = assignMatchPlaces([
      {
        cellId: CELL_A,
        fileId: FILE,
        fileName: "Study notes",
        placeLabel: "4",
        position: 4,
      },
    ])
    expect(place.place).toEqual({ kind: "filePosition", fileName: "Study notes", position: 4 })
    expect(JSON.stringify(place)).not.toContain(FILE)
    expect(JSON.stringify(place)).not.toContain(CELL_A)
  })

  it("uses the file name alone when a notes cell has no position", () => {
    const [place] = assignMatchPlaces([
      { cellId: CELL_A, fileId: FILE, fileName: "Study notes" },
    ])
    expect(place.place).toEqual({ kind: "text", text: "Study notes" })
  })

  it("does not treat a uuid file name as a place", () => {
    const [place] = assignMatchPlaces([
      { cellId: CELL_A, fileId: FILE, fileName: FILE, position: 3 },
    ])
    expect(place.place).toEqual({ kind: "line", position: 3 })
  })

  it("counts one cell once when both sides match", () => {
    const places = assignMatchPlaces([
      { cellId: CELL_A, fileId: FILE, canonicalRef: "GEN 1:1", position: 1 },
      { cellId: CELL_A, fileId: FILE, canonicalRef: "GEN 1:1", position: 1 },
    ])
    expect(places[0].index).toBeUndefined()
    expect(places[1].index).toBeUndefined()
  })
})
