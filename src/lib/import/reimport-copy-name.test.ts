import { describe, expect, it } from "vitest"
import { planSidebarReimport } from "./reimport-copy-name"

describe("planSidebarReimport", () => {
  const names = ["Genesis.usfm"]
  const base = {
    targetFileId: "file-1",
    uploadName: "Genesis.usfm",
    existingNames: names,
    forkFileId: "file-copy",
  }

  it("maps each sidebar choice onto the reconcile flags", () => {
    expect(planSidebarReimport({ ...base, mode: "update", suffix: "updated" })).toMatchObject({
      displayName: "Genesis.usfm",
      reconcileFileId: "file-1",
      fork: false,
      reviewChangedSource: true,
      stripTargets: true,
    })
    expect(planSidebarReimport({ ...base, mode: "updated-copy", suffix: "updated" })).toMatchObject({
      displayName: "Genesis.usfm (updated)",
      reconcileFileId: "file-copy",
      fork: true,
      sourceFileId: "file-1",
      reviewChangedSource: true,
      stripTargets: true,
    })
    expect(planSidebarReimport({ ...base, mode: "blank", suffix: "blank" })).toMatchObject({
      displayName: "Genesis.usfm (blank)",
      fork: false,
      reviewChangedSource: false,
      stripTargets: true,
    })
    expect(planSidebarReimport({ ...base, mode: "blank", suffix: "blank" }).reconcileFileId).toBeUndefined()
  })
})
