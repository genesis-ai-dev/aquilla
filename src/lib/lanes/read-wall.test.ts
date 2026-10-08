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
  restoreHiddenLaneSettings,
  visibilityCacheToken,
  scopedTargetVisibilityClause,
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

  it("keeps only the granted target lane rows, and every source lane row (AQU-1418)", () => {
    const lanes = [
      { id: "es", name: "Spanish", legacyTag: "es" },
      { id: "fr", name: "French", legacyTag: "fr" },
    ]
    const rows = [
      { id: "src", role: "source" },
      { id: "es", role: "target" },
      { id: "fr", role: "target" },
    ]
    const filtered = filterSettingsToVisibleLanes(
      { settings: { targetLanes: ["Spanish", "French"] }, lanes: rows },
      new Set(["es"]),
      lanes,
    )
    expect(filtered.lanes?.map((lane) => lane.id)).toEqual(["src", "es"])
    expect(filtered.settings.targetLanes).toEqual(["Spanish"])
    // A response without rows, and an unrestricted caller, are left alone.
    expect(filterSettingsToVisibleLanes({ settings: {}, lanes: undefined }, new Set(["es"]), lanes).lanes).toBeUndefined()
    expect(filterSettingsToVisibleLanes({ settings: {}, lanes: rows }, null, lanes).lanes).toBe(rows)
  })

  describe("restoreHiddenLaneSettings (AQU-1750)", () => {
    // German and Italian are hidden from a caller granted Spanish only.
    const lanes = [
      { id: "ln-main", name: "French", legacyTag: "" },
      { id: "ln-de", name: "German", legacyTag: "de" },
      { id: "ln-es", name: "Spanish", legacyTag: "es" },
      { id: "ln-it", name: "Italian", legacyTag: "it" },
    ]
    const visible = new Set(["ln-es"])
    const stored = {
      targetLanguage: "French",
      targetLanes: ["de", "es", "it"],
      archivedLanes: ["it"],
      systemPrompt: "Formal.",
    }

    it("turns an echo of the filtered read back into the stored blob exactly", () => {
      // The client's echo is the filter's own output. Restored, it must equal
      // the stored row key for key and in the same order, or the route's diff
      // reports a language change and a one-key carve-out write is refused.
      const echo = filterSettingsToVisibleLanes({ settings: stored }, visible, lanes).settings
      expect(echo).toEqual({ targetLanguage: "", targetLanes: ["es"], archivedLanes: [], systemPrompt: "Formal." })
      expect(restoreHiddenLaneSettings(stored, echo, visible, lanes)).toEqual({ ok: true, settings: stored })
    })

    it("keeps the caller's own lane edits around the hidden entries", () => {
      const removed = restoreHiddenLaneSettings(stored, { ...stored, targetLanes: [] }, visible, lanes)
      expect(removed).toEqual({ ok: true, settings: { ...stored, targetLanes: ["de", "it"] } })
      // A hidden label sent again is not doubled.
      const added = restoreHiddenLaneSettings(stored, { ...stored, targetLanes: ["es", "pt", "de"] }, visible, lanes)
      expect(added).toEqual({ ok: true, settings: { ...stored, targetLanes: ["de", "es", "it", "pt"] } })
    })

    it("restores a hidden primary the body leaves out, and refuses one it replaces", () => {
      const { targetLanguage: _dropped, ...withoutPrimary } = stored
      expect(restoreHiddenLaneSettings(stored, withoutPrimary, visible, lanes)).toEqual({ ok: true, settings: stored })
      const replaced = restoreHiddenLaneSettings(stored, { ...stored, targetLanguage: "Spanish" }, visible, lanes)
      expect(replaced.ok).toBe(false)
    })

    it("leaves the body alone when nothing is hidden", () => {
      // No key is added where the stored row has none, and a visible primary
      // stays the caller's to change.
      const plain = { targetLanguage: "Spanish", sourceLanguage: "English" }
      const body = { targetLanguage: "", sourceLanguage: "Hebrew" }
      expect(restoreHiddenLaneSettings(plain, body, visible, lanes)).toEqual({ ok: true, settings: body })
      expect(restoreHiddenLaneSettings(stored, { targetLanes: [] }, null, lanes)).toEqual({
        ok: true,
        settings: { targetLanes: [] },
      })
    })
  })
})

describe("scoped target visibility", () => {
  it("matches a lane id or a target_lang, including the former default lane", () => {
    const clause = scopedTargetVisibilityClause({
      ids: ["lane-es"],
      tags: ["es", ""],
      sideExpr: "side",
      laneIdExpr: "lane_id",
      targetLangExpr: "target_lang",
    })
    expect(clause.sql).toBe(
      "AND (side = 'source' OR lane_id IN (?) OR target_lang IN (?, ?))",
    )
    expect(clause.binds).toEqual(["lane-es", "es", ""])
  })

  it("hides every target row when the scope named nothing", () => {
    expect(
      scopedTargetVisibilityClause({
        ids: [],
        tags: [],
        sideExpr: "side",
        laneIdExpr: "lane_id",
        targetLangExpr: "target_lang",
      }),
    ).toEqual({ sql: "AND side = 'source'", binds: [] })
  })
})
