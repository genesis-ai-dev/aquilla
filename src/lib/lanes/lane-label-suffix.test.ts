// laneLabelSuffixes — telling two same-named lanes apart (AQU-1784).
// WHY: identical "Tshangla" rows in the lane switcher are why the Come and See
// report could not be read off the screen. These pin the four rules every lane
// surface now shares: a unique label is untouched, a collision is numbered from
// the second lane, a code override wins over the number, and the numbering is
// read off the caller's list — so a walled member holding one of the colliding
// lanes sees no suffix at all.
import { describe, expect, it } from "vitest"
import {
  disambiguatedLaneLabels,
  laneLabelSuffixes,
  withLaneLabelSuffix,
} from "./lane-label-suffix"

describe("laneLabelSuffixes", () => {
  it("leaves unique labels alone", () => {
    expect(
      laneLabelSuffixes([{ label: "Tshangla" }, { label: "French" }, { label: "Dzongkha" }]),
    ).toEqual([null, null, null])
  })

  it("numbers a collision from the second lane, keeping the first bare", () => {
    expect(
      disambiguatedLaneLabels([{ label: "Tshangla" }, { label: "Tshangla" }]),
    ).toEqual(["Tshangla", "Tshangla · 2"])
  })

  it("collides on case and surrounding whitespace, not just the exact string", () => {
    expect(
      disambiguatedLaneLabels([{ label: "Tshangla" }, { label: " tshangla " }]),
    ).toEqual(["Tshangla", " tshangla  · 2"])
  })

  it("prefers the lane's code override to its position", () => {
    expect(
      disambiguatedLaneLabels([
        { label: "Tshangla", code: "tsj" },
        { label: "Tshangla", code: "dz" },
      ]),
    ).toEqual(["Tshangla · tsj", "Tshangla · dz"])
  })

  it("numbers the lane that has no code beside the one that does", () => {
    expect(
      disambiguatedLaneLabels([{ label: "Tshangla", code: "tsj" }, { label: "Tshangla" }]),
    ).toEqual(["Tshangla · tsj", "Tshangla · 2"])
  })

  it("falls back to position when two colliding lanes share one code override", () => {
    // A code only tells lanes apart while it is itself distinct, so the whole
    // group is numbered rather than leaving the pair identical again.
    expect(
      disambiguatedLaneLabels([
        { label: "Tshangla", code: "tsj" },
        { label: "Tshangla", code: "TSJ" },
      ]),
    ).toEqual(["Tshangla", "Tshangla · 2"])
  })

  it("numbers each collision independently and ignores lanes between them", () => {
    expect(
      disambiguatedLaneLabels([
        { label: "Tshangla" },
        { label: "French" },
        { label: "Tshangla" },
        { label: "French" },
        { label: "Tshangla" },
      ]),
    ).toEqual(["Tshangla", "French", "Tshangla · 2", "French · 2", "Tshangla · 3"])
  })

  it("keeps the colliding lanes' numbers when a lane that does not collide moves", () => {
    // Stability under reorder: the number is the place among the COLLIDING
    // lanes, so moving "French" cannot renumber the two "Tshangla" rows.
    const before = disambiguatedLaneLabels([
      { label: "Tshangla" },
      { label: "French" },
      { label: "Tshangla" },
    ])
    const after = disambiguatedLaneLabels([
      { label: "French" },
      { label: "Tshangla" },
      { label: "Tshangla" },
    ])
    expect(before.filter((label) => label.startsWith("Tshangla"))).toEqual([
      "Tshangla",
      "Tshangla · 2",
    ])
    expect(after.filter((label) => label.startsWith("Tshangla"))).toEqual([
      "Tshangla",
      "Tshangla · 2",
    ])
  })

  it("gives a lone visible lane no suffix, so a walled member learns nothing", () => {
    // AQU-1421: the list is the lanes the read wall left this member. One of
    // two colliding lanes is not a collision from where they are standing.
    expect(laneLabelSuffixes([{ label: "Tshangla" }])).toEqual([null])
    expect(disambiguatedLaneLabels([{ label: "Tshangla" }])).toEqual(["Tshangla"])
  })

  it("is empty for an empty list", () => {
    expect(laneLabelSuffixes([])).toEqual([])
  })
})

describe("withLaneLabelSuffix", () => {
  it("returns the label unchanged without a suffix", () => {
    expect(withLaneLabelSuffix("Tshangla", null)).toBe("Tshangla")
  })

  it("joins label and suffix with the one separator every surface uses", () => {
    expect(withLaneLabelSuffix("Tshangla", "2")).toBe("Tshangla · 2")
  })
})
