import { describe, expect, it } from "vitest"
import { draftTargets } from "./draft-targets"

describe("draftTargets (AQU-1424)", () => {
  const cells = [
    { id: "a", translated: "done", hidden: undefined },
    { id: "b", translated: "", hidden: undefined },
    { id: "c", translated: "", hidden: true },
    { id: "d", translated: "   ", hidden: undefined },
  ]

  it("skips a parked cell even though it has no translation", () => {
    // The whole point: c LOOKS like work and must not be drafted, because the
    // credits would go on text nobody will read or export.
    expect(draftTargets(cells).map((c) => c.id)).toEqual(["b", "d"])
  })

  it("treats whitespace-only as untranslated, as the progress bar does", () => {
    expect(draftTargets([{ id: "d", translated: "  \n " }]).map((c) => c.id)).toEqual(["d"])
  })

  it("drafts the cell again once it is shown", () => {
    const shown = cells.map((c) => (c.id === "c" ? { ...c, hidden: undefined } : c))
    expect(draftTargets(shown).map((c) => c.id)).toEqual(["b", "c", "d"])
  })

  it("is unchanged for a file with nothing hidden", () => {
    const plain = [
      { id: "a", translated: "done" },
      { id: "b", translated: "" },
    ]
    expect(draftTargets(plain).map((c) => c.id)).toEqual(["b"])
  })

  it("preserves the order it was given", () => {
    const ordered = [
      { id: "z", translated: "" },
      { id: "y", translated: "" },
    ]
    expect(draftTargets(ordered).map((c) => c.id)).toEqual(["z", "y"])
  })
})
