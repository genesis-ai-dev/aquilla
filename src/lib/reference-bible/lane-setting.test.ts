import { describe, expect, it } from "vitest"
import {
  parseReferenceBibleSetting,
  referenceBibleForLane,
  referenceBibleSettingShapeProblem,
  withReferenceBibleForLane,
} from "./lane-setting"

const settings = (referenceBibleVersions: unknown, targetLanguage = "Arabic") => ({ referenceBibleVersions, targetLanguage })

describe("referenceBibleForLane (AQU-1573)", () => {
  it("reads the map form per lane, with '' as the default lane", () => {
    const s = settings({ "": "arb-vandyck", en: "eng-kjv" })
    expect(referenceBibleForLane(s, "")).toBe("arb-vandyck")
    expect(referenceBibleForLane(s, null)).toBe("arb-vandyck")
    expect(referenceBibleForLane(s, undefined)).toBe("arb-vandyck")
    expect(referenceBibleForLane(s, "en")).toBe("eng-kjv")
    expect(referenceBibleForLane(s, "EN")).toBe("eng-kjv")
    expect(referenceBibleForLane(s, "fr")).toBeNull()
  })

  it("reads the ticket's one-item array as the default lane", () => {
    expect(referenceBibleForLane(settings(["arb-vandyck"]), "")).toBe("arb-vandyck")
    expect(referenceBibleForLane(settings(["arb-vandyck"]), "en")).toBeNull()
  })

  it("treats a key naming the primary language as the default lane", () => {
    expect(referenceBibleForLane(settings({ Arabic: "arb-vandyck" }), "")).toBe("arb-vandyck")
    expect(referenceBibleForLane(settings({ ar: "arb-vandyck" }), "")).toBe("arb-vandyck")
    // The lane id naming the primary language reads the "" entry too.
    expect(referenceBibleForLane(settings({ "": "arb-vandyck" }), "Arabic")).toBe("arb-vandyck")
  })

  it("returns null for no setting, {} and junk", () => {
    for (const v of [undefined, null, {}, [], "arb-vandyck", 7, ["a", "b"], { "": 3 }, { "": "" }]) {
      expect(referenceBibleForLane(settings(v), "")).toBeNull()
    }
    expect(referenceBibleForLane(null, "")).toBeNull()
  })
})

describe("withReferenceBibleForLane (AQU-1573)", () => {
  it("sets and clears one lane, leaving the others", () => {
    expect(withReferenceBibleForLane({ "": "arb-vandyck" }, "en", "eng-kjv", "Arabic")).toEqual({ "": "arb-vandyck", en: "eng-kjv" })
    expect(withReferenceBibleForLane({ "": "arb-vandyck", en: "eng-kjv" }, "en", null, "Arabic")).toEqual({ "": "arb-vandyck" })
    expect(withReferenceBibleForLane({ "": "arb-vandyck" }, "", null, "Arabic")).toEqual({})
  })

  it("turns the array form into a map and drops alias keys for the same lane", () => {
    expect(withReferenceBibleForLane(["arb-vandyck"], "en", "eng-kjv", "Arabic")).toEqual({ "": "arb-vandyck", en: "eng-kjv" })
    expect(withReferenceBibleForLane({ Arabic: "arb-vandyck" }, "", "eng-kjv", "Arabic")).toEqual({ "": "eng-kjv" })
    expect(withReferenceBibleForLane(undefined, "", "arb-vandyck", "Arabic")).toEqual({ "": "arb-vandyck" })
    expect(withReferenceBibleForLane("junk", "", null, "Arabic")).toEqual({})
  })
})

describe("setting shape (AQU-1573)", () => {
  it("accepts a map, a one-item array, empty forms and null", () => {
    for (const v of [{ "": "arb-vandyck" }, ["arb-vandyck"], {}, [], null]) expect(referenceBibleSettingShapeProblem(v)).toBeNull()
    expect(parseReferenceBibleSetting({ " en ": " eng-kjv " })).toEqual({ en: "eng-kjv" })
  })

  it("rejects two-item arrays with the one-Bible-per-lane hint, and other junk", () => {
    expect(referenceBibleSettingShapeProblem(["a", "b"])).toMatch(/one Bible per lane/)
    for (const v of ["arb-vandyck", 3, true, { "": 1 }, { "": "" }, [""], [3]]) {
      expect(referenceBibleSettingShapeProblem(v)).toMatch(/expected/)
    }
  })
})
