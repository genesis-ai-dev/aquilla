import { describe, it, expect } from "vitest"
import { deriveLanes } from "./lanes"

const seg = (o: Partial<{ id: string; startTime: number; endTime: number; medium: "text" | "media"; sequenceIndex: number }>) =>
  ({ medium: "text", ...o }) as any

describe("deriveLanes", () => {
  it("splits timed media into dialogue, timed text into subtitle, untimed into untimed", () => {
    const cells = [
      seg({ id: "a", startTime: 0, endTime: 3, medium: "text" }),
      seg({ id: "b", startTime: 0.4, endTime: 6, medium: "media" }),
      seg({ id: "c", medium: "text", sequenceIndex: 9 }), // untimed
      seg({ id: "d", startTime: 8, endTime: 12, medium: "text" }),
    ]
    const { subtitle, dialogue, untimed } = deriveLanes(cells)
    expect(subtitle.map((s) => s.id)).toEqual(["a", "d"])
    expect(dialogue.map((s) => s.id)).toEqual(["b"])
    expect(untimed.map((s) => s.id)).toEqual(["c"])
  })

  it("sorts each timed lane by startTime", () => {
    const cells = [
      seg({ id: "late", startTime: 10, endTime: 11, medium: "media" }),
      seg({ id: "early", startTime: 1, endTime: 2, medium: "media" }),
    ]
    expect(deriveLanes(cells).dialogue.map((s) => s.id)).toEqual(["early", "late"])
  })

  it("treats missing medium as text (subtitle lane)", () => {
    const cells = [seg({ id: "x", startTime: 0, endTime: 1, medium: undefined })]
    expect(deriveLanes(cells).subtitle.map((s) => s.id)).toEqual(["x"])
  })
})
