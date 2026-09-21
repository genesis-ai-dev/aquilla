/**
 * AQU-1245: the two remaining jump-target lookups that used to resolve to a
 * whole-file row index now resolve to a cell ID, so the editor's ID-based
 * scroll can turn to the milestone that contains the target.
 */

import { describe, it, expect } from "vitest"
import {
  resolveRecordingRowCellId,
  resolveScopeLabelCellId,
  type SectionCellIdLookup,
} from "./milestone-jump-targets"

function lookup(sections: Record<string, string>): SectionCellIdLookup {
  return { findCellIdBySection: (label) => sections[label] ?? null }
}

describe("resolveScopeLabelCellId (AQU-1245)", () => {
  const store = lookup({
    "1 Thessalonians 4": "cell-1th-4-1",
    "1 Thessalonians 5": "cell-1th-5-1",
  })

  it("resolves a single-chapter scope to that chapter's first cell", () => {
    expect(resolveScopeLabelCellId(store, "1 Thessalonians 4")).toBe("cell-1th-4-1")
  })

  it("strips the ` in <file>` suffix the assignment list appends", () => {
    expect(resolveScopeLabelCellId(store, "1 Thessalonians 4 in 1TH.usfm")).toBe("cell-1th-4-1")
  })

  it("takes the first chapter the file actually has from a multi-chapter scope", () => {
    expect(resolveScopeLabelCellId(store, "1 Thessalonians 9, 1 Thessalonians 5"))
      .toBe("cell-1th-5-1")
  })

  it("is null for a scope no section matches, so the caller can fall back to the top", () => {
    expect(resolveScopeLabelCellId(store, "1 Thessalonians")).toBeNull()
  })
})

describe("resolveRecordingRowCellId (AQU-1245)", () => {
  it("uses the recorded cell itself outside a cue arrangement", () => {
    expect(resolveRecordingRowCellId({ cellId: "cell-a", isCueArrangement: false }))
      .toBe("cell-a")
  })

  it("follows a cue to its linked subtitle row, which is the row the table shows", () => {
    expect(resolveRecordingRowCellId({
      cellId: "cue-3",
      isCueArrangement: true,
      linkedTextIds: ["cell-sub-3", "cell-sub-4"],
    })).toBe("cell-sub-3")
  })

  it("is null for an unlinked cue — there is no row to reveal", () => {
    expect(resolveRecordingRowCellId({ cellId: "cue-9", isCueArrangement: true }))
      .toBeNull()
    expect(resolveRecordingRowCellId({ cellId: "cue-9", isCueArrangement: true, linkedTextIds: [] }))
      .toBeNull()
  })
})
