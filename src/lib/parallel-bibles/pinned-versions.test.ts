import { beforeEach, describe, expect, it } from "vitest"
import {
  clearPersonalPins,
  LEGACY_VERSIONS_STORAGE_KEY,
  projectVersionsStorageKey,
  readPersonalPins,
  resolvePinnedVersions,
  writePersonalPins,
} from "./pinned-versions"

describe("pinned versions", () => {
  beforeEach(() => localStorage.clear())

  it("copies the old global pins into the project on first read, keeping the global list", () => {
    localStorage.setItem(LEGACY_VERSIONS_STORAGE_KEY, JSON.stringify(["BSB", "grc_sbl"]))
    expect(readPersonalPins("p1")).toEqual(["BSB", "grc_sbl"])
    expect(JSON.parse(localStorage.getItem(projectVersionsStorageKey("p1")) ?? "null")).toEqual(["BSB", "grc_sbl"])
    expect(localStorage.getItem(LEGACY_VERSIONS_STORAGE_KEY)).not.toBeNull()

    // From then on the project's own list wins, and other projects copy the global one.
    writePersonalPins("p1", ["hbo_wlc"])
    expect(readPersonalPins("p1")).toEqual(["hbo_wlc"])
    expect(readPersonalPins("p2")).toEqual(["BSB", "grc_sbl"])
  })

  it("falls back to the project defaults only when the translator has no pins of their own", () => {
    expect(readPersonalPins("p1")).toBeNull()
    expect(resolvePinnedVersions(null, ["grc_sbl", "BSB"])).toEqual({ ids: ["grc_sbl", "BSB"], source: "project" })
    expect(resolvePinnedVersions(null, [])).toEqual({ ids: [], source: "none" })

    // An emptied list is a choice, not "no pins".
    writePersonalPins("p1", [])
    expect(resolvePinnedVersions(readPersonalPins("p1"), ["BSB"])).toEqual({ ids: [], source: "personal" })

    clearPersonalPins("p1")
    expect(resolvePinnedVersions(readPersonalPins("p1"), ["BSB"]).source).toBe("project")
  })
})
