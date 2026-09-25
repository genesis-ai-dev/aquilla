import { describe, expect, it } from "vitest"
import { languageSurfaceForms } from "../language-normalize"
import {
  filterSettingsToVisibleLanes,
  labelsForGrantedLanes,
  laneReadWallEnabled,
  laneTagAllowed,
  lanesForRequestedTag,
  legacyTagsForVisibleLanes,
  portfolioTextFromVisibleLanes,
  visibilityCacheToken,
  visibleDefaultLaneLanguage,
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

  it("treats es, spa, and Spanish as one grant", () => {
    expect(languageSurfaceForms("es").sort()).toEqual(["es", "spa", "spanish"])
    expect(languageSurfaceForms("Spanish").sort()).toEqual(["es", "spa", "spanish"])
    expect(languageSurfaceForms("")).toEqual([""])
    expect(languageSurfaceForms("Telugu")).toEqual(["telugu"])
  })

  it("ignores a grant below viewer and keeps a viewer grant", () => {
    const visible = visibleLaneTags({
      enabled: true,
      role: 400,
      laneGrants: [
        { lane: "lane-es", level: 50 },
        { lane: "lane-fr", level: 100 },
      ],
    })
    expect(visible).toEqual(new Set(["lane-fr"]))
    expect(laneTagAllowed(visible, "lane-fr")).toBe(true)
    expect(laneTagAllowed(visible, "fr")).toBe(false)
    expect(laneTagAllowed(visible, "French")).toBe(false)
  })

  it("puts the visible set in the cache token and leaves unrestricted callers unmarked", () => {
    expect(visibilityCacheToken(null)).toBe("")
    expect(visibilityCacheToken(new Set(["fr", "es"]))).toBe(":vis:es.fr")
  })

  it("resolves a request by tag or name, and does not fan out by language", () => {
    const lanes = [
      { id: "es", name: "Spanish", legacyTag: "es" },
      { id: "def", name: "Spanish", legacyTag: "" },
      { id: "team", name: "Yoruba Team", legacyTag: "yo" },
    ]
    expect(lanesForRequestedTag(lanes, "es").map((lane) => lane.id)).toEqual(["es"])
    expect(lanesForRequestedTag(lanes, "").map((lane) => lane.id)).toEqual(["def"])
    expect(lanesForRequestedTag(lanes, "Spanish").map((lane) => lane.id).sort()).toEqual(["def", "es"])
    expect(lanesForRequestedTag(lanes, "Yoruba Team").map((lane) => lane.id)).toEqual(["team"])
    expect(lanesForRequestedTag(lanes, "Yoruba")).toEqual([])
    expect(labelsForGrantedLanes(lanes, new Set(["team"]))).toEqual(new Set(["Yoruba Team", "yo"]))
  })

  it("filters the settings registry to the granted lane's name", () => {
    const lanes = [
      { id: "es", name: "Spanish", legacyTag: "es" },
      { id: "fr", name: "French", legacyTag: "fr" },
      { id: "team", name: "Yoruba Team", legacyTag: "yo" },
    ]
    const filtered = filterSettingsToVisibleLanes(
      { settings: { targetLanguage: "Spanish", targetLanes: ["Spanish", "French"], archivedLanes: ["French"] } },
      new Set(["es"]),
      lanes,
    )
    expect(filtered.settings.targetLanes).toEqual(["Spanish"])
    expect(filtered.settings.archivedLanes).toEqual([])
    expect(filtered.settings.targetLanguage).toBe("Spanish")

    const hidden = filterSettingsToVisibleLanes(
      { settings: { targetLanguage: "Spanish", targetLanes: ["French"] } },
      new Set(["fr"]),
      lanes,
    )
    expect(hidden.settings.targetLanguage).toBe("")
    expect(hidden.settings.targetLanes).toEqual(["French"])

    const named = filterSettingsToVisibleLanes(
      { settings: { targetLanguage: "Yoruba", targetLanes: ["Yoruba", "Yoruba Team"] } },
      new Set(["team"]),
      lanes,
    )
    expect(named.settings.targetLanguage).toBe("")
    expect(named.settings.targetLanes).toEqual(["Yoruba Team"])
  })

  it("drops lane records the caller was not granted", () => {
    const filtered = filterSettingsToVisibleLanes(
      {
        settings: { targetLanes: ["es"] },
        lanes: [
          { id: "es", name: "Spanish" },
          { id: "fr", name: "French" },
        ],
      },
      new Set(["es"]),
      [
        { id: "es", name: "Spanish", legacyTag: "es" },
        { id: "fr", name: "French", legacyTag: "fr" },
      ],
    )
    expect(filtered.lanes.map((lane) => lane.id)).toEqual(["es"])
  })

  it("sums only the granted lanes and hides the default language name", () => {
    const lanes = [
      { id: "def", name: "Spanish", legacyTag: "" },
      { id: "yo", name: "Yoruba Team", legacyTag: "yo" },
    ]
    const tags = legacyTagsForVisibleLanes(lanes, new Set(["yo"]))
    expect(tags).toEqual(new Set(["yo"]))
    const totals = portfolioTextFromVisibleLanes(
      [
        { lane: "", totalCells: 100, filledCells: 40, validatedCells: 10, lastEditAt: 5000 },
        { lane: "yo", totalCells: 100, filledCells: 3, validatedCells: 1, lastEditAt: 2000 },
      ],
      tags,
    )
    expect(totals).toEqual({
      lanes: [{ lane: "yo", totalCells: 100, filledCells: 3, validatedCells: 1, lastEditAt: 2000 }],
      totalCells: 100,
      filledCells: 3,
      validatedCells: 1,
      lastEditAt: 2000,
    })
    expect(visibleDefaultLaneLanguage("Spanish", tags)).toBeNull()
    expect(visibleDefaultLaneLanguage("Spanish", new Set([""]))).toBe("Spanish")
    expect(portfolioTextFromVisibleLanes([], null)).toBeNull()
  })
})
