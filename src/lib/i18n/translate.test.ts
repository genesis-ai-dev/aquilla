import { describe, it, expect } from "vitest"
import { interpolate, translate } from "./translate"
import { en } from "./messages/en"

describe("interpolate", () => {
  it("fills named placeholders from vars", () => {
    expect(interpolate("Switch to {language}", { language: "Thai" })).toBe("Switch to Thai")
  })
  it("stringifies numeric vars", () => {
    expect(interpolate("{n} items", { n: 3 })).toBe("3 items")
  })
  it("leaves unknown placeholders intact", () => {
    expect(interpolate("Hello {name}", {})).toBe("Hello {name}")
  })
  it("returns the template unchanged when no vars are given", () => {
    expect(interpolate("Hello {name}")).toBe("Hello {name}")
  })
})

describe("translate", () => {
  it("uses the catalog value when the key is present", () => {
    expect(translate({ "common.save": "บันทึก" }, "common.save")).toBe("บันทึก")
  })
  it("falls back to English when the catalog omits the key", () => {
    expect(translate({}, "common.save")).toBe(en["common.save"])
  })
  it("falls back to English when the catalog is undefined", () => {
    expect(translate(undefined, "common.cancel")).toBe(en["common.cancel"])
  })
  it("interpolates against the resolved template", () => {
    expect(translate(undefined, "language.switchTo", { language: "Arabic" })).toBe(
      "Switch language to Arabic",
    )
  })
  it("never returns a raw key for any base key", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(translate({}, key)).not.toBe(key)
    }
  })
})
