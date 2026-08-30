// AQU-1068: the truth table behind a destructive button.
//
// ProjectWorkspace has no test harness, so without this the rules deciding who
// may restructure a file would be verified only in a browser — the wrong
// instrument for a matrix of ranks, tiers and file kinds.

import { describe, it, expect } from "vitest"
import { canEditCells, canRemoveImportedCells, cellInsertMode } from "./cell-editing-gate"
import { ROLE } from "@/lib/frontier/roles"

const subject = (over: Partial<Parameters<typeof canEditCells>[0]> = {}) => ({
  floor: ROLE.MAINTAINER as number | null,
  roleLevel: ROLE.MAINTAINER as number | null,
  staticFloorPasses: true,
  sourceIsMirrored: false,
  ...over,
})

describe("canEditCells", () => {
  it("refuses when the project has not opted in, whatever the rank", () => {
    // "none" is the default and it means nobody — an owner included, because
    // the setting answers WHETHER this project restructures its files.
    expect(canEditCells(subject({ floor: null, roleLevel: ROLE.OWNER }))).toBe(false)
  })

  it("admits at the tier and refuses below it", () => {
    expect(canEditCells(subject({ floor: ROLE.MAINTAINER, roleLevel: ROLE.MAINTAINER }))).toBe(true)
    expect(canEditCells(subject({ floor: ROLE.MAINTAINER, roleLevel: ROLE.PROJECT_LEAD }))).toBe(false)
    expect(canEditCells(subject({ floor: ROLE.PROJECT_LEAD, roleLevel: ROLE.PROJECT_LEAD }))).toBe(true)
    expect(canEditCells(subject({ floor: ROLE.CONTRIBUTOR, roleLevel: ROLE.CONTRIBUTOR }))).toBe(true)
  })

  it("still refuses whoever the static floor refuses, at any tier", () => {
    // The tier can widen who is admitted, never past the event's own floor —
    // a viewer emitting source.cell.create would be refused at the perimeter.
    expect(
      canEditCells(subject({ floor: ROLE.CONTRIBUTOR, roleLevel: ROLE.VIEWER, staticFloorPasses: false })),
    ).toBe(false)
  })

  it("refuses while the source is mirrored, whatever the tier says", () => {
    // A live link or a DCS pin overwrites local source divergence, so the
    // change would be silently undone — the button must not be offered.
    expect(canEditCells(subject({ roleLevel: ROLE.OWNER, sourceIsMirrored: true }))).toBe(false)
  })

  it("treats a null role as no role", () => {
    expect(canEditCells(subject({ roleLevel: null }))).toBe(false)
  })
})

describe("canRemoveImportedCells", () => {
  it("needs MAINTAINER on top of the tier", () => {
    // An imported cell is the client's own work. A lead admitted by a lower
    // tier may add cells and take back their own lines, not remove imports.
    expect(
      canRemoveImportedCells(subject({ floor: ROLE.PROJECT_LEAD, roleLevel: ROLE.PROJECT_LEAD })),
    ).toBe(false)
    expect(
      canRemoveImportedCells(subject({ floor: ROLE.PROJECT_LEAD, roleLevel: ROLE.MAINTAINER })),
    ).toBe(true)
  })

  it("is refused when the project never opted in, maintainer or not", () => {
    // Rank never substitutes for opt-in; the first gate runs first.
    expect(canRemoveImportedCells(subject({ floor: null, roleLevel: ROLE.OWNER }))).toBe(false)
  })
})

describe("cellInsertMode", () => {
  const file = (over: Partial<Parameters<typeof cellInsertMode>[0]> = {}) => ({
    hasMedia: false,
    isTimed: false,
    hasChunkedAudioCells: false,
    fileType: "usfm",
    ...over,
  })

  it("an ordinary text file takes a cell anywhere", () => {
    expect(cellInsertMode(file())).toBe("anywhere")
  })

  it("a subtitle file with footage takes one only in a gap", () => {
    expect(cellInsertMode(file({ hasMedia: true, isTimed: true, fileType: "vtt" }))).toBe("gaps")
  })

  it("offers nothing on a chunked-audio file", () => {
    // An inserted row there would be an audio cell with no audio.
    expect(cellInsertMode(file({ hasChunkedAudioCells: true }))).toBe("none")
    // ...even on a file that would otherwise take one anywhere.
    expect(cellInsertMode(file({ hasChunkedAudioCells: true, fileType: "usfm" }))).toBe("none")
  })

  it("offers nothing on IDML, which this slice excludes", () => {
    expect(cellInsertMode(file({ fileType: "idml" }))).toBe("none")
  })

  it("offers nothing on a half-timed file rather than guessing", () => {
    // Footage without derived rows, or derived rows without footage: neither
    // path's assumptions hold, so neither is offered.
    expect(cellInsertMode(file({ hasMedia: true, isTimed: false }))).toBe("none")
    expect(cellInsertMode(file({ hasMedia: false, isTimed: true }))).toBe("none")
  })
})
