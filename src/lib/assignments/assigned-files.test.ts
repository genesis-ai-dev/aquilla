// AQU-894 regression guards for "which files are mine".

import { describe, it, expect } from "vitest"
import { assignedFileIds, shouldDimUnassigned } from "./assigned-files"
import type { MyAssignment } from "@/lib/sync/assignments"

function assignment(overrides: Partial<MyAssignment> = {}): MyAssignment {
  return {
    assignmentId: "as-1",
    projectId: "p1",
    fileId: "f1",
    scopeKind: "books",
    scopeLabel: "Genesis",
    deadline: null,
    note: null,
    cellsTotal: 3,
    cellsDone: 0,
    createdAt: 1000,
    ...overrides,
  }
}

describe("assignedFileIds", () => {
  it("collects every file an assignment's cells touch, not just the first", () => {
    // The bug this exists to prevent: a books-scope assignment over GEN + EXO
    // reports ONE arbitrary `fileId`, so reading that alone would present half
    // of a person's own work as somebody else's.
    const ids = assignedFileIds(
      [assignment({ fileId: "f1", fileIds: ["f1", "f2", "f3"] })],
      "p1",
    )
    expect([...ids].sort()).toEqual(["f1", "f2", "f3"])
  })

  it("unions across assignments and de-duplicates", () => {
    const ids = assignedFileIds(
      [
        assignment({ assignmentId: "as-1", fileIds: ["f1", "f2"] }),
        assignment({ assignmentId: "as-2", fileIds: ["f2", "f9"] }),
      ],
      "p1",
    )
    expect([...ids].sort()).toEqual(["f1", "f2", "f9"])
  })

  it("ignores assignments belonging to another project", () => {
    const ids = assignedFileIds(
      [assignment({ projectId: "other", fileIds: ["fx"] }), assignment({ fileIds: ["f1"] })],
      "p1",
    )
    expect([...ids]).toEqual(["f1"])
  })

  it("falls back to the single fileId when an older worker sent no array", () => {
    // Deploy skew: the SPA and the workers ship separately. An under-count is
    // the safe failure — a file that really is yours just looks like everyone
    // else's; it never claims a file that isn't.
    expect([...assignedFileIds([assignment({ fileId: "f7", fileIds: undefined })], "p1")])
      .toEqual(["f7"])
    expect([...assignedFileIds([assignment({ fileId: "f7", fileIds: [] })], "p1")])
      .toEqual(["f7"])
  })

  it("yields nothing when the scope resolved to no cells at all", () => {
    expect(assignedFileIds([assignment({ fileId: null, fileIds: [] })], "p1").size).toBe(0)
    expect(assignedFileIds([], "p1").size).toBe(0)
  })
})

describe("shouldDimUnassigned", () => {
  it("stays off for a caller who holds nothing — the no-assignments team case", () => {
    // Teams that never assign, and a member with no open assignment, must see
    // an ordinary file list rather than a project greyed out end to end.
    expect(shouldDimUnassigned(new Set())).toBe(false)
  })

  it("switches on once the caller holds at least one file", () => {
    expect(shouldDimUnassigned(new Set(["f1"]))).toBe(true)
  })
})
