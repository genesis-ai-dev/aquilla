// AQU-1068: the truth table behind a destructive button.
//
// ProjectWorkspace has no test harness, so without this the rules deciding who
// may restructure a file would be verified only in a browser — the wrong
// instrument for a matrix of ranks, tiers and file kinds.

import { describe, it, expect } from "vitest"
import { canEditCells, canRemoveImportedCells, cellPlacement, isImportedRow, rowActionAvailability } from "./cell-editing-gate"
import { userLineOrigin } from "@/lib/timeline/user-line-origin"
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

describe("cellPlacement", () => {
  it("a time-ordered file places into gaps", () => {
    expect(cellPlacement({ orderedBy: "time" })).toBe("gaps")
  })

  it("everything else places anywhere", () => {
    expect(cellPlacement({ orderedBy: "sequence" })).toBe("anywhere")
  })

  it("needs NO footage to be gap-constrained", () => {
    // A subtitle file's cues are timed whether or not a video is attached.
    // Round 1 required `coreMediaUrl` and left a footage-less cue sheet with
    // nothing; this function can no longer even ask, which is the point.
    expect(Object.keys({ orderedBy: "time" } as Parameters<typeof cellPlacement>[0]))
      .not.toContain("hasMedia")
  })

  it("never consults the timing mode — placement follows the source's clock", () => {
    // A Free-mode cue sheet is still gap-constrained, which is what makes a
    // Free -> Original switch a non-event: inserts are born timed either way.
    expect(Object.keys({ orderedBy: "time" } as Parameters<typeof cellPlacement>[0]))
      .not.toContain("timingMode")
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
    isImported: true,
    canRemoveImported: true,
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
    expect(rowActionAvailability(row({ isMediaCell: true, canRemoveImported: false })).remove)
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
    it("is maintainer work on an imported line", () => {
      expect(rowActionAvailability(row({ isImported: true, canRemoveImported: false })).remove)
        .toBe("maintainerOnly")
    })

    it("is open on a line somebody added here, whatever their rank", () => {
      // Taking your own empty line back is never gated on rank.
      expect(rowActionAvailability(row({ isImported: false, canRemoveImported: false })).remove)
        .toBeNull()
    })

    it("does not block INSERTS when removal is refused", () => {
      const out = rowActionAvailability(row({ isImported: true, canRemoveImported: false }))
      expect([out.above, out.below]).toEqual([null, null])
    })
  })
})

// AQU-1068 review round. Matthew: "after recording audio and then trying to
// remove the cell, I wasn't able to."
//
// Both surfaces used to ask `isUserAddedLine(cell) && isLineEmpty(cell)`, so a
// line became the client's imported content the moment its author put anything
// in it. The server never agreed — `isUserInsertedCell` reads the origin marker
// and nothing else — so the client was refusing a delete the server allows.
describe("isImportedRow", () => {
  const added = { metadata: { aquillaOrigin: userLineOrigin() } as Record<string, unknown> }

  it("says a line somebody added here is not imported", () => {
    expect(isImportedRow(added)).toBe(false)
  })

  it("STAYS not-imported once that line has content — the review bug", () => {
    // Emptiness is not part of the question. Whatever the author has since
    // typed, recorded or had translated into their own line, it is still
    // their line.
    expect(isImportedRow({ ...added, original: "typed after the fact" } as never)).toBe(false)
    expect(isImportedRow({ ...added, translated: "drafted" } as never)).toBe(false)
    expect(isImportedRow({
      ...added,
      attachments: { "take-x-1": { isDeleted: false } },
    } as never)).toBe(false)
  })

  it("says an imported row IS imported", () => {
    expect(isImportedRow({ metadata: null })).toBe(true)
    expect(isImportedRow({})).toBe(true)
    expect(isImportedRow({ metadata: { aquillaImport: { displayLabel: "1" } } })).toBe(true)
  })

  it("does not mistake some other origin marker for a user insert", () => {
    expect(isImportedRow({ metadata: { aquillaOrigin: { kind: "import" } } })).toBe(true)
  })

  it("keeps a contributor's own recorded line removable, and imported rows not", () => {
    // The composed rule, as both surfaces ask it.
    const asContributor = (cell: Parameters<typeof isImportedRow>[0]) =>
      rowActionAvailability({
        placement: "anywhere",
        isMediaCell: false,
        isIdmlCell: false,
        gapAbove: true,
        gapBelow: true,
        isImported: isImportedRow(cell),
        canRemoveImported: false,
      }).remove
    expect(asContributor({ ...added, attachments: { "take-x-1": { isDeleted: false } } } as never)).toBeNull()
    expect(asContributor({ metadata: null })).toBe("maintainerOnly")
  })
})
