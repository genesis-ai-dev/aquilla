import { describe, expect, it } from "vitest"
import { switcherLaneTags } from "./switcher-lanes"

const tagged = (legacyTag: string, position: number, id = legacyTag || "blank") => ({
  id,
  position,
  legacyTag,
})

describe("switcherLaneTags (AQU-1776)", () => {
  it("does not invent a blank lane beside the only target", () => {
    expect(switcherLaneTags([tagged("English", 0, "lane-en")], ["", "English"])).toEqual(["English"])
  })

  it("keeps a real blank bridge and does not force it in front of a later lane", () => {
    expect(
      switcherLaneTags(
        [tagged("English", 0, "lane-en"), tagged("", 1, "lane-blank")],
        [],
      ),
    ).toEqual(["English", ""])
  })

  it("orders by position and collapses a repeated tag", () => {
    expect(
      switcherLaneTags(
        [tagged("fr", 2, "b"), tagged("en", 0, "a"), tagged("en", 1, "c")],
        [],
      ),
    ).toEqual(["en", "fr"])
  })

  it("returns the caller's fallback when the project has no lane rows yet", () => {
    expect(switcherLaneTags([], ["", "fr"])).toEqual(["", "fr"])
  })
})
