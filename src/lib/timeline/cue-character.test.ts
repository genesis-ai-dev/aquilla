// Resolving a cue's character through its links. (AQU-646, 2026-08-16)
//
// The case that has to be right is SEVERAL names. It is rare — five cues in
// episode 101, out of the 96 that cover two or more subtitle rows — but
// showing only the first would tell a performer they are playing someone they
// are not, five times an episode. The case that has to stay unchanged is a
// plain text cell, which must answer for itself and never consult the links.

import { describe, it, expect } from "vitest"

import { resolveCueCharacter, formatCueCharacter, cameraLabel } from "./cue-character"
import { buildCueLinkIndex, type CueLink } from "@/lib/sync/cell-links-read"
import type { CellData } from "@/hooks/useCells"

const text = (id: string, castName?: string, cameraState?: "on" | "off" | "mixed"): CellData =>
  ({
    id,
    fileId: "f-subs",
    original: id,
    translated: "",
    ...(castName ? { metadata: { cast_name: castName } } : {}),
    ...(cameraState ? { cameraState } : {}),
  }) as unknown as CellData

const cue = (id: string): CellData =>
  ({ id, fileId: "f-cues", original: id, translated: "" }) as unknown as CellData

const edge = (textCellId: string, cueCellId: string): CueLink => ({
  kind: "text-audio",
  fromFileId: "f-subs",
  fromCellId: textCellId,
  toFileId: "f-cues",
  toCellId: cueCellId,
  origin: "auto",
  confidence: 0.9,
})

describe("a cue takes its character from the lines it performs", () => {
  it("names the one line it is linked to, with its camera state", () => {
    const r = resolveCueCharacter({
      cell: cue("c1"),
      links: buildCueLinkIndex([edge("s1", "c1")]),
      textCells: [text("s1", "MARY MAGDALENE'S FATHER.", "on")],
    })
    expect(r.names).toEqual(["MARY MAGDALENE'S FATHER."])
    expect(r.cameraState).toBe("on")
  })

  it("names BOTH speakers when one heard line covers two lines", () => {
    // Two speakers merged into one cue. Showing only the first would put a
    // performer in the wrong part.
    const r = resolveCueCharacter({
      cell: cue("c1"),
      links: buildCueLinkIndex([edge("s2", "c1"), edge("s1", "c1")]),
      textCells: [text("s1", "JESUS.", "on"), text("s2", "MARY.", "on")],
    })
    // Document order, not the order the edges came back in.
    expect(r.names).toEqual(["JESUS.", "MARY."])
  })

  it("collapses a repeated name rather than saying it twice", () => {
    const r = resolveCueCharacter({
      cell: cue("c1"),
      links: buildCueLinkIndex([edge("s1", "c1"), edge("s2", "c1")]),
      textCells: [text("s1", "JESUS.", "on"), text("s2", "JESUS.", "on")],
    })
    expect(r.names).toEqual(["JESUS."])
  })

  it("calls disagreeing camera states mixed", () => {
    // The same answer a "(Group)" label gets, and for the same reason: a shot
    // covering several people constrains none of them exactly.
    const r = resolveCueCharacter({
      cell: cue("c1"),
      links: buildCueLinkIndex([edge("s1", "c1"), edge("s2", "c1")]),
      textCells: [text("s1", "JESUS.", "on"), text("s2", "MARY.", "off")],
    })
    expect(r.cameraState).toBe("mixed")
  })

  it("keeps a single shared camera state as itself", () => {
    const r = resolveCueCharacter({
      cell: cue("c1"),
      links: buildCueLinkIndex([edge("s1", "c1"), edge("s2", "c1")]),
      textCells: [text("s1", "JESUS.", "off"), text("s2", "MARY.", "off")],
    })
    expect(r.cameraState).toBe("off")
  })

  it("says nothing for an unlinked cue rather than guessing", () => {
    // About ten an episode. Nothing is the honest answer.
    const r = resolveCueCharacter({
      cell: cue("c9"),
      links: buildCueLinkIndex([edge("s1", "c1")]),
      textCells: [text("s1", "JESUS.", "on")],
    })
    expect(r).toEqual({ names: [], cameraState: undefined })
  })

  it("says nothing when the linked lines have no character", () => {
    const r = resolveCueCharacter({
      cell: cue("c1"),
      links: buildCueLinkIndex([edge("s1", "c1")]),
      textCells: [text("s1")],
    })
    expect(r.names).toEqual([])
  })
})

describe("a cell with its own character answers for itself", () => {
  it("uses its own name and never consults the links", () => {
    // What keeps every file WITHOUT audio cues behaving exactly as before.
    const r = resolveCueCharacter({
      cell: text("s1", "JESUS.", "on"),
      // Links that would say something different, if they were consulted.
      links: buildCueLinkIndex([edge("s9", "s1")]),
      textCells: [text("s9", "SOMEONE ELSE.", "off")],
    })
    expect(r.names).toEqual(["JESUS."])
    expect(r.cameraState).toBe("on")
  })

  it("ignores an empty cast name and falls through to the links", () => {
    const cell = { ...cue("c1"), metadata: { cast_name: "" } } as unknown as CellData
    const r = resolveCueCharacter({
      cell,
      links: buildCueLinkIndex([edge("s1", "c1")]),
      textCells: [text("s1", "JESUS.")],
    })
    expect(r.names).toEqual(["JESUS."])
  })

  it("handles no cell at all", () => {
    expect(resolveCueCharacter({ cell: null, links: buildCueLinkIndex([]), textCells: [] })).toEqual({
      names: [],
      cameraState: undefined,
    })
  })
})

describe("how the two surfaces print it", () => {
  it("joins several names", () => {
    expect(formatCueCharacter(["JESUS.", "MARY."])).toBe("JESUS. / MARY.")
    expect(formatCueCharacter(["JESUS."])).toBe("JESUS.")
    expect(formatCueCharacter([])).toBeNull()
  })

  it("says camera state in words — a bare 'on' reads as a toggle", () => {
    expect(cameraLabel("on")).toBe("on camera")
    expect(cameraLabel("off")).toBe("off camera")
    expect(cameraLabel("mixed")).toBe("mixed")
    expect(cameraLabel(undefined)).toBeNull()
  })
})
