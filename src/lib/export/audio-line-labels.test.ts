// AQU-2073: the Export dialog's names for lines — a reference when the line
// has one, else "L" and its place in time order, as the by-line export names
// its files.
import { describe, expect, it } from "vitest"
import { audioLineLabels } from "./audio-line-labels"

describe("audioLineLabels", () => {
  it("numbers lines in time order, every line counted, like the by-line export", () => {
    const labels = audioLineLabels([
      { id: "b", startTime: 5 },
      { id: "a", startTime: 1 },
      { id: "c", startTime: 9 },
    ])
    expect([...labels.entries()]).toEqual([["a", "L1"], ["b", "L2"], ["c", "L3"]])
  })

  it("uses a line's own reference, never an opaque id", () => {
    const labels = audioLineLabels([
      { id: "v1", context: "JHN 6:1" },
      { id: "v2", context: "", globalReferences: ["JHN 6:2"] },
      { id: "x", context: "0f2c4f2e-1b3a-4c5d-8e9f-a0b1c2d3e4f5" },
    ])
    expect(labels.get("v1")).toBe("JHN 6:1")
    expect(labels.get("v2")).toBe("JHN 6:2")
    expect(labels.get("x")).toBe("L3")
  })

  it("keeps file order for lines with no time, after the timed ones", () => {
    const labels = audioLineLabels([{ id: "u1" }, { id: "t", startTime: 2 }, { id: "u2" }])
    expect([...labels.entries()]).toEqual([["t", "L1"], ["u1", "L2"], ["u2", "L3"]])
  })

  it("never names a subtitle cue by its stored timing", () => {
    const labels = audioLineLabels([
      { id: "c1", startTime: 2, context: "00:00:02.000 --> 00:00:06.500" },
      { id: "c2", startTime: 7, context: "00:07.000" },
      { id: "c3", startTime: 9, context: "00:00:09.000 --> 00:00:11.000", globalReferences: ["B4"] },
    ])
    expect(labels.get("c1")).toBe("L1")
    expect(labels.get("c2")).toBe("L2")
    expect(labels.get("c3")).toBe("B4")
  })
})
