// laneComboboxOptions — the one lane→option mapping (AQU-1631).
// WHY: the editor's lane switcher and the file-target import's destination
// picker must name the same lane the same way. These pin the three rules a
// second inline copy got wrong before: a blank lane-row name falls through to
// the tag rather than rendering an empty row, `''` takes the caller's default
// label, and archived lanes stay flagged so LaneCombobox can hide them.
import { describe, expect, it } from "vitest"
import { laneComboboxOptions, laneOptionLabels } from "./lane-options"

describe("laneComboboxOptions", () => {
  it("labels the default lane with the caller's label and keeps input order", () => {
    const options = laneComboboxOptions({
      lanes: ["", "fr", "pt-BR"],
      defaultLaneLabel: "Spanish",
    })
    expect(options.map((o) => [o.value, o.label])).toEqual([
      ["", "Spanish"],
      ["fr", "fr"],
      ["pt-BR", "pt-BR"],
    ])
  })

  it("prefers a lane row's name, and falls through a blank one to the tag", () => {
    const options = laneComboboxOptions({
      lanes: ["", "fr", "sw"],
      laneLabels: { "": "Default lane", fr: "French", sw: "   " },
      defaultLaneLabel: "Spanish",
    })
    expect(options.map((o) => o.label)).toEqual(["Default lane", "French", "sw"])
  })

  it("flags archived lanes case-insensitively so the reveal row can hide them", () => {
    const options = laneComboboxOptions({
      lanes: ["", "fr", "sw"],
      defaultLaneLabel: "Spanish",
      archivedLanes: ["SW"],
    })
    expect(options.map((o) => o.archived)).toEqual([false, false, true])
  })

  // AQU-1784: two lanes resolving to one label used to render as identical
  // rows. The suffix is applied over the lanes THIS surface shows, so a
  // filtered list cannot grow one.
  it("tells two lanes with the same label apart, numbering from the second", () => {
    const options = laneComboboxOptions({
      lanes: ["Tshangla", "a3f09c1e"],
      laneLabels: { Tshangla: "Tshangla", a3f09c1e: "Tshangla" },
      defaultLaneLabel: "Spanish",
    })
    expect(options.map((o) => [o.value, o.label])).toEqual([
      ["Tshangla", "Tshangla"],
      ["a3f09c1e", "Tshangla · 2"],
    ])
  })

  it("suffixes a colliding lane with its code override when it has one", () => {
    const options = laneComboboxOptions({
      lanes: ["Tshangla", "a3f09c1e"],
      laneLabels: { Tshangla: "Tshangla", a3f09c1e: "Tshangla" },
      laneCodes: { a3f09c1e: "tsj" },
      defaultLaneLabel: "Spanish",
    })
    expect(options.map((o) => o.label)).toEqual(["Tshangla", "Tshangla · tsj"])
  })

  it("collides the DEFAULT lane too, label and all", () => {
    // `''` takes the caller's default label, which is as collidable as any
    // other: a second lane of the project's target language reads the same.
    const options = laneComboboxOptions({
      lanes: ["", "a3f09c1e"],
      laneLabels: { a3f09c1e: "Spanish" },
      defaultLaneLabel: "Spanish",
    })
    expect(options.map((o) => o.label)).toEqual(["Spanish", "Spanish · 2"])
  })

  it("leaves a lane list whose labels are unique exactly as it was", () => {
    const options = laneComboboxOptions({
      lanes: ["", "fr", "pt-BR"],
      laneLabels: { fr: "French" },
      defaultLaneLabel: "Spanish",
    })
    expect(options.map((o) => o.label)).toEqual(["Spanish", "French", "pt-BR"])
  })

  it("exposes the base label and the suffix separately for the TARGET pill", () => {
    // EditorTable keeps its own base label for `''` (the project's target
    // language / the "set a language" prompt) and only borrows the suffix, so
    // the pill and the switcher name the same lane the same way.
    const labels = laneOptionLabels({
      lanes: ["Tshangla", "a3f09c1e"],
      laneLabels: { Tshangla: "Tshangla", a3f09c1e: "Tshangla" },
      defaultLaneLabel: "Spanish",
    })
    expect(labels.map((l) => [l.base, l.suffix])).toEqual([
      ["Tshangla", null],
      ["Tshangla", "2"],
    ])
  })

  it("carries the tag as the e2e test id every lane picker is driven by", () => {
    const options = laneComboboxOptions({ lanes: ["", "fr"], defaultLaneLabel: "Spanish" })
    expect(options.map((o) => o.testId)).toEqual(["", "fr"])
  })
})
