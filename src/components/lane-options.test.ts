// laneComboboxOptions — the one lane→option mapping (AQU-1631).
// WHY: the editor's lane switcher and the file-target import's destination
// picker must name the same lane the same way. These pin the three rules a
// second inline copy got wrong before: a blank lane-row name falls through to
// the tag rather than rendering an empty row, `''` takes the caller's default
// label, and archived lanes stay flagged so LaneCombobox can hide them.
import { describe, expect, it } from "vitest"
import { laneComboboxOptions } from "./lane-options"

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

  it("carries the tag as the e2e test id every lane picker is driven by", () => {
    const options = laneComboboxOptions({ lanes: ["", "fr"], defaultLaneLabel: "Spanish" })
    expect(options.map((o) => o.testId)).toEqual(["", "fr"])
  })
})
