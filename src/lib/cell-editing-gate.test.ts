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
  // Round 1's defect lived HERE, and not in this function: the truth table was
  // fine, the CALL SITE fed it lens state. These cases are written in the
  // vocabulary the call site now uses, so a wrong signal cannot pass as a right
  // one — `orderedBy` and `hasMediaCells` are file facts with no other reading.
  const file = (over: Partial<Parameters<typeof cellInsertMode>[0]> = {}) => ({
    orderedBy: "sequence" as const,
    hasMediaCells: false,
    fileType: "usfm",
    ...over,
  })

  it("an ordinary text file takes a cell anywhere", () => {
    expect(cellInsertMode(file())).toBe("anywhere")
  })

  it("a time-ordered file takes one only in a gap", () => {
    expect(cellInsertMode(file({ orderedBy: "time", fileType: "vtt" }))).toBe("gaps")
  })

  it("a time-ordered file needs NO footage to be gap-constrained", () => {
    // Its cues are timed whether or not a video is attached. Round 1 required
    // `coreMediaUrl`, which left a cue sheet with no footage offering nothing —
    // and this function can no longer even ask, which is the point.
    expect(cellInsertMode(file({ orderedBy: "time", fileType: "vtt" }))).toBe("gaps")
  })

  it("offers nothing on a file containing a media cell", () => {
    // A media cell IS its audio: nothing to mint an inserted one from, and the
    // removal inventory cannot see a file-seeded clip (it would say "nothing
    // attached" while destroying source audio).
    expect(cellInsertMode(file({ orderedBy: "time", hasMediaCells: true }))).toBe("none")
  })

  it("one media cell switches the WHOLE file off", () => {
    // Same rule the media table already uses; a mixed file is still excluded.
    expect(cellInsertMode(file({ orderedBy: "sequence", hasMediaCells: true }))).toBe("none")
  })

  it("offers nothing on IDML, which this slice excludes", () => {
    expect(cellInsertMode(file({ fileType: "idml" }))).toBe("none")
  })

  it("treats an absent order as sequence — the FileReference default", () => {
    // `fileOrderedBy` resolves absent to "sequence"; a file that predates the
    // field must not read as timed.
    expect(cellInsertMode(file({ orderedBy: "sequence" }))).toBe("anywhere")
  })

  it("never consults the timing mode — placement follows the source's clock", () => {
    // The signature cannot express Free vs Original, deliberately. A Free-mode
    // cue sheet is still gap-constrained, which is what makes a Free -> Original
    // switch a non-event: inserts are born timed either way.
    const keys = Object.keys(file())
    expect(keys).not.toContain("timingMode")
    expect(keys).not.toContain("hasMedia")
  })
})
