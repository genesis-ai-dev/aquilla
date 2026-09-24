import { describe, expect, it } from "vitest"
import {
  filterSettingsToVisibleLanes,
  laneReadWallEnabled,
  laneTagAllowed,
  visibilityCacheToken,
  visibleLaneTags,
} from "./read-wall"

describe("lane read wall", () => {
  it("stays off unless the flag is exactly on", () => {
    expect(laneReadWallEnabled(undefined)).toBe(false)
    expect(laneReadWallEnabled("0")).toBe(false)
    expect(laneReadWallEnabled("1")).toBe(true)
    expect(laneReadWallEnabled("true")).toBe(true)
  })

  it("shows every lane to a maintainer and nothing to an ungranted contributor", () => {
    expect(visibleLaneTags({ enabled: true, role: 600 })).toBeNull()
    expect(visibleLaneTags({ enabled: true, role: 400, src: "platform" })).toBeNull()
    expect(visibleLaneTags({ enabled: false, role: 400 })).toBeNull()
    const none = visibleLaneTags({ enabled: true, role: 400 })
    expect(none).toEqual(new Set())
  })

  it("ignores a grant below viewer and keeps a viewer grant", () => {
    const visible = visibleLaneTags({
      enabled: true,
      role: 400,
      laneGrants: [
        { lane: "es", level: 50 },
        { lane: "fr", level: 100 },
      ],
    })
    expect(visible).toEqual(new Set(["fr"]))
    expect(laneTagAllowed(visible, "fr")).toBe(true)
    expect(laneTagAllowed(visible, "French")).toBe(true)
    expect(laneTagAllowed(visible, "es")).toBe(false)
    expect(laneTagAllowed(visible, "")).toBe(false)
  })

  it("puts the visible set in the cache token and leaves unrestricted callers unmarked", () => {
    expect(visibilityCacheToken(null)).toBe("")
    expect(visibilityCacheToken(new Set(["fr", "es"]))).toBe(":vis:es.fr")
  })

  it("filters the settings registry and blanks an ungranted primary language", () => {
    const filtered = filterSettingsToVisibleLanes(
      { settings: { targetLanguage: "Spanish", targetLanes: ["Spanish", "French"], archivedLanes: ["French"] } },
      new Set(["es"]),
    )
    expect(filtered.settings.targetLanes).toEqual(["Spanish"])
    expect(filtered.settings.archivedLanes).toEqual([])
    expect(filtered.settings.targetLanguage).toBe("Spanish")

    const hidden = filterSettingsToVisibleLanes(
      { settings: { targetLanguage: "Spanish", targetLanes: ["French"] } },
      new Set(["fr"]),
    )
    expect(hidden.settings.targetLanguage).toBe("")
    expect(hidden.settings.targetLanes).toEqual(["French"])
  })
})
