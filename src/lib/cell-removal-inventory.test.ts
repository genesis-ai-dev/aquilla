// AQU-1068: the removal confirmation is only worth having if its list is
// honest — Sam chose confirm-and-remove over refusing until the cell is empty,
// and that trade rests entirely on the person being told the truth about what
// they are about to lose.

import { describe, it, expect } from "vitest"
import { buildCellRemovalInventory } from "./cell-removal-inventory"
import type { CellData } from "@/hooks/useCells"

const CELL_ID = "01890000-0000-7000-8000-000000000001"

function cell(overrides: Partial<CellData> = {}): CellData {
  return {
    id: CELL_ID,
    fileId: "file-a",
    original: "In the beginning",
    translated: "",
    ...overrides,
  } as unknown as CellData
}

/** An audio id seeded with the cell id — what marks a take as THIS cell's.
 *  buildAudioId embeds the seed dash-delimited, which is what
 *  `audioIdSeededWith` reads back out. */
const ownTake = (n: number) => `take-${CELL_ID}-${n}`

describe("buildCellRemovalInventory", () => {
  it("counts the lanes the removal plan resolved", () => {
    const inv = buildCellRemovalInventory({
      cell: cell(),
      targetLangs: ["", "fr", "es"],
      commentCount: 0,
    })
    expect(inv.laneCount).toBe(3)
  })

  it("counts only takes that belong to this cell, not a clip the file shares", () => {
    // The imported source clip is seeded with the FILE, not the cell. Counting
    // it would tell someone they are destroying a recording every other row
    // also plays.
    const inv = buildCellRemovalInventory({
      cell: cell({
        attachments: {
          [ownTake(1)]: { url: "u", type: "audio", createdAt: 1, updatedAt: 1, isDeleted: false },
          [ownTake(2)]: { url: "u", type: "audio", createdAt: 1, updatedAt: 1, isDeleted: false },
          "file-seeded-clip": { url: "u", type: "audio", createdAt: 1, updatedAt: 1, isDeleted: false },
        },
      } as Partial<CellData>),
      targetLangs: [],
      commentCount: 0,
    })
    expect(inv.takeCount).toBe(2)
  })

  it("ignores takes that are already deleted", () => {
    const inv = buildCellRemovalInventory({
      cell: cell({
        attachments: {
          [ownTake(1)]: { url: "u", type: "audio", createdAt: 1, updatedAt: 1, isDeleted: true },
        },
      } as Partial<CellData>),
      targetLangs: [],
      commentCount: 0,
    })
    expect(inv.takeCount).toBe(0)
  })

  it("flags a take that also performs other lines", () => {
    const inv = buildCellRemovalInventory({
      cell: cell(),
      targetLangs: [],
      commentCount: 0,
      sharedTakeCount: 1,
    })
    expect(inv.hasSharedTake).toBe(true)
  })

  it("surfaces the chapter heading the row carries", () => {
    // Chapter navigation is derived from cell metadata, so removing the cell
    // that holds the envelope removes the chapter from the navigator.
    const inv = buildCellRemovalInventory({
      cell: cell({
        metadata: {
          aquillaImport: {
            milestone: { key: "gen-1", kind: "chapter", label: "Genesis 1", shortLabel: "1" },
          },
        },
      } as Partial<CellData>),
      targetLangs: [],
      commentCount: 0,
    })
    expect(inv.milestoneLabel).toBe("Genesis 1")
  })

  it("reports null for a row carrying no heading", () => {
    expect(buildCellRemovalInventory({ cell: cell(), targetLangs: [], commentCount: 0 }).milestoneLabel)
      .toBeNull()
  })

  it("counts standing validations", () => {
    const inv = buildCellRemovalInventory({
      cell: cell({ activeValidators: ["anna", "bob"] } as Partial<CellData>),
      targetLangs: [],
      commentCount: 0,
    })
    expect(inv.validatorCount).toBe(2)
  })

  describe("isEmpty — the take-back case that skips the dialog entirely", () => {
    it("is empty for a blank line nobody has touched", () => {
      const inv = buildCellRemovalInventory({
        cell: cell({ original: "" }),
        targetLangs: [],
        commentCount: 0,
      })
      expect(inv.isEmpty).toBe(true)
    })

    it("is NOT empty once the cell has source text", () => {
      expect(
        buildCellRemovalInventory({ cell: cell(), targetLangs: [], commentCount: 0 }).isEmpty,
      ).toBe(false)
    })

    it("is NOT empty for a blank line that still carries a comment", () => {
      // The row looks untouched, but a thread on it would vanish silently.
      expect(
        buildCellRemovalInventory({
          cell: cell({ original: "" }),
          targetLangs: [],
          commentCount: 1,
        }).isEmpty,
      ).toBe(false)
    })

    it("is NOT empty for a blank line with a transcription", () => {
      expect(
        buildCellRemovalInventory({
          cell: cell({ original: "", transcription: "spoken words" } as Partial<CellData>),
          targetLangs: [],
          commentCount: 0,
        }).isEmpty,
      ).toBe(false)
    })

    it("is NOT empty for a blank line with a translation in some lane", () => {
      expect(
        buildCellRemovalInventory({
          cell: cell({ original: "" }),
          targetLangs: ["fr"],
          commentCount: 0,
        }).isEmpty,
      ).toBe(false)
    })
  })
})
