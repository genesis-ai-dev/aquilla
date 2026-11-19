// AQU-1068: the truth table behind a destructive button.
//
// ProjectWorkspace has no test harness, so without this the rules deciding who
// may restructure a file would be verified only in a browser — the wrong
// instrument for a matrix of ranks, tiers and file kinds.

import { describe, it, expect } from "vitest"
import { canEditCells, rowActionAvailability } from "./cell-editing-gate"
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

describe("rowActionAvailability", () => {
  // Round 3's rule: a row that cannot take an action still SHOWS the control,
  // disabled, with the reason. `null` here means available.
  const row = (over: Partial<Parameters<typeof rowActionAvailability>[0]> = {}) => ({
    placement: "anywhere" as const,
    isMediaCell: false,
    isIdmlCell: false,
    gapAbove: true,
    gapBelow: true,
    ...over,
  })

  it("an ordinary row in a text file can do everything", () => {
    expect(rowActionAvailability(row())).toEqual({ above: null, below: null, remove: null })
  })

  it("a media row refuses all three, for the same reason", () => {
    // The row IS audio: nothing to mint an inserted cell from, and removing it
    // would destroy a stretch of the client's recording behind a confirmation
    // that cannot see it (the imported clip is file-seeded, so the take
    // inventory reads zero).
    expect(rowActionAvailability(row({ isMediaCell: true }))).toEqual({
      above: "media", below: "media", remove: "media",
    })
  })

  it("an IDML row refuses all three", () => {
    expect(rowActionAvailability(row({ isIdmlCell: true }))).toEqual({
      above: "idml", below: "idml", remove: "idml",
    })
  })

  it("media wins over IDML when a row is somehow both", () => {
    expect(rowActionAvailability(row({ isMediaCell: true, isIdmlCell: true })).above).toBe("media")
  })

  it("a structural refusal outranks a clearance one", () => {
    // A maintainer-only removal is not the useful thing to say about a row that
    // is a piece of audio.
    expect(rowActionAvailability(row({ isMediaCell: true })).remove)
      .toBe("media")
  })

  describe("on a clock, each direction answers for itself", () => {
    const timed = (over = {}) => row({ placement: "gaps", ...over })

    it("both directions when there is a silence on either side", () => {
      const out = rowActionAvailability(timed())
      expect([out.above, out.below]).toEqual([null, null])
    })

    it("only below when the silence is below", () => {
      expect(rowActionAvailability(timed({ gapAbove: false })))
        .toMatchObject({ above: "noRoom", below: null })
    })

    it("only above when the silence is above", () => {
      expect(rowActionAvailability(timed({ gapBelow: false })))
        .toMatchObject({ above: null, below: "noRoom" })
    })

    it("neither when the row is boxed in — but removal is untouched", () => {
      expect(rowActionAvailability(timed({ gapAbove: false, gapBelow: false })))
        .toEqual({ above: "noRoom", below: "noRoom", remove: null })
    })
  })

  it("ignores gaps entirely when the file has no clock", () => {
    // An ordinary text file has room between any two rows; a `gapAbove: false`
    // arriving from a caller that computed it anyway must not close the door.
    expect(rowActionAvailability(row({ gapAbove: false, gapBelow: false })))
      .toMatchObject({ above: null, below: null })
  })

  describe("removal", () => {
    it("is open on any line the viewer is allowed to restructure", () => {
      // AQU-2632: imported lines follow the project's tier like every other
      // line. Who the tier admits is answered by `canEditCells`, before the
      // control is drawn, so a row that reaches here is removable.
      expect(rowActionAvailability(row()).remove).toBeNull()
    })

    it("does not block INSERTS or removal on an ordinary row", () => {
      const out = rowActionAvailability(row())
      expect([out.above, out.below, out.remove]).toEqual([null, null, null])
    })
  })
})
