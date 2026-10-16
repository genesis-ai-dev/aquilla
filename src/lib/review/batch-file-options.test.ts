import { describe, expect, it } from "vitest"
import { ROLE } from "@/lib/frontier/roles"
import {
  canIncludeUntouchedAiDrafts,
  classifyBatchDraft,
  isUntouchedAiDraft,
  selectBatchDraft,
} from "./batch-file-options"

describe("canIncludeUntouchedAiDrafts", () => {
  it("lets a reviewer and a project lead opt in, and keeps the contributor on one-by-one review", () => {
    expect(canIncludeUntouchedAiDrafts(ROLE.REVIEWER)).toBe(true)
    expect(canIncludeUntouchedAiDrafts(ROLE.PROJECT_LEAD)).toBe(true)
    expect(canIncludeUntouchedAiDrafts(ROLE.MAINTAINER)).toBe(true)
    expect(canIncludeUntouchedAiDrafts(ROLE.OWNER)).toBe(true)
    expect(canIncludeUntouchedAiDrafts(ROLE.CONTRIBUTOR)).toBe(false)
    expect(canIncludeUntouchedAiDrafts(ROLE.COMMENTER)).toBe(false)
    expect(canIncludeUntouchedAiDrafts(ROLE.VIEWER)).toBe(false)
  })

  it("fails open when the project has no role, matching canPerform", () => {
    expect(canIncludeUntouchedAiDrafts(null)).toBe(true)
    expect(canIncludeUntouchedAiDrafts(undefined)).toBe(true)
  })
})

describe("isUntouchedAiDraft", () => {
  it("is machine text nobody has validated yet", () => {
    expect(isUntouchedAiDraft({ aiDrafted: true, activeValidators: [] })).toBe(true)
    expect(isUntouchedAiDraft({ aiDrafted: true })).toBe(true)
  })

  it("is not a second pass, and not a human translation", () => {
    expect(isUntouchedAiDraft({ aiDrafted: true, activeValidators: ["joy"] })).toBe(false)
    expect(isUntouchedAiDraft({ aiDrafted: false, activeValidators: [] })).toBe(false)
  })
})

describe("classifyBatchDraft", () => {
  it("offers empty cells and untouched AI drafts, and counts human text as left alone", () => {
    const groups = classifyBatchDraft([
      { id: "empty", translated: "", original: "In the beginning" },
      { id: "ai", translated: "Au commencement", original: "In the beginning", aiDrafted: true },
      { id: "human", translated: "Au commencement", original: "In the beginning", aiDrafted: false },
      { id: "checked", translated: "Au commencement", original: "In the beginning", aiDrafted: true, activeValidators: ["joy"] },
      { id: "parked", translated: "", original: "hidden source", hidden: true },
      { id: "nosource", translated: "", original: "" },
    ])
    expect(groups.empty.map((c) => c.id)).toEqual(["empty"])
    expect(groups.refreshable.map((c) => c.id)).toEqual(["ai"])
    expect(groups.humanOwned).toBe(2)
    expect(groups.hidden).toBe(1)
  })
})

describe("selectBatchDraft", () => {
  const groups = {
    empty: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
    refreshable: [{ id: "a1" }, { id: "a2" }],
  }

  it("drafts only the ticked groups, empty cells first", () => {
    expect(selectBatchDraft(groups, {
      includeEmpty: true,
      refreshAiDrafts: false,
      scope: "all",
      batchSize: 10,
    }).map((c) => c.id)).toEqual(["e1", "e2", "e3"])
    expect(selectBatchDraft(groups, {
      includeEmpty: false,
      refreshAiDrafts: true,
      scope: "all",
      batchSize: 10,
    }).map((c) => c.id)).toEqual(["a1", "a2"])
  })

  it("limits a next-package run to the batch size and lets an all-run go past it", () => {
    const next = selectBatchDraft(groups, {
      includeEmpty: true,
      refreshAiDrafts: true,
      scope: "next",
      batchSize: 4,
    })
    expect(next.map((c) => c.id)).toEqual(["e1", "e2", "e3", "a1"])
    const all = selectBatchDraft(groups, {
      includeEmpty: true,
      refreshAiDrafts: true,
      scope: "all",
      batchSize: 4,
    })
    expect(all).toHaveLength(5)
  })
})
