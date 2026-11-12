import { describe, expect, it } from "vitest"
import {
  archivedLaneReason,
  laneTagForArchiveCheck,
  LANE_DOES_NOT_EXIST_REASON,
  type ArchiveLaneRow,
} from "./archived-lane"

const spanish: ArchiveLaneRow = {
  id: "eslane01",
  name: "Spanish",
  legacyTag: "es",
  archivedAt: "2026-09-29T00:00:00.000Z",
}
const french: ArchiveLaneRow = {
  id: "frlane01",
  name: "French",
  legacyTag: "fr",
  archivedAt: null,
}
const defaultLane: ArchiveLaneRow = {
  id: "default1",
  name: "English",
  legacyTag: "",
  archivedAt: null,
}

describe("laneTagForArchiveCheck", () => {
  it("treats an omitted targetLang on a target commit as the default lane", () => {
    expect(laneTagForArchiveCheck("target.cell.commit", { value: "hi" })).toBe("")
    expect(laneTagForArchiveCheck("cell.validate", {})).toBe("")
    expect(laneTagForArchiveCheck("target.cell.repin", { targetLang: "es" })).toBe("es")
  })

  it("ignores audio, waivers, and back-translations that do not name a lane", () => {
    expect(laneTagForArchiveCheck("cell.audio.attach", { audioId: "a" })).toBeNull()
    expect(laneTagForArchiveCheck("cell.waive", { ruleId: "r", targetLang: "" })).toBeNull()
    expect(laneTagForArchiveCheck("cell.backtranslation.set", { targetLang: "es" })).toBe("es")
    expect(laneTagForArchiveCheck("cell.lane.retime", { targetLang: "es" })).toBe("es")
  })

  it("does not freeze source edits, comments, file ops, cell.retime, or assignments", () => {
    expect(laneTagForArchiveCheck("source.cell.commit", { targetLang: "es" })).toBeNull()
    expect(laneTagForArchiveCheck("comment.create", { targetLang: "es" })).toBeNull()
    expect(laneTagForArchiveCheck("file.delete", {})).toBeNull()
    expect(laneTagForArchiveCheck("cell.retime", { targetLang: "es" })).toBeNull()
    expect(laneTagForArchiveCheck("assignment.create", { targetLang: "es" })).toBeNull()
  })
})

describe("archivedLaneReason", () => {
  const lanes = [defaultLane, spanish, french]

  it("refuses a write that names an archived lane, by tag or by name", () => {
    expect(archivedLaneReason({ tag: "es", lanes })).toBe("lane 'Spanish' is archived")
    expect(archivedLaneReason({ tag: "Spanish", lanes })).toBe("lane 'Spanish' is archived")
  })

  it("does not archive a second lane of the same language", () => {
    const latin: ArchiveLaneRow = {
      id: "eslane02",
      name: "Spanish B",
      legacyTag: "spa",
      archivedAt: null,
    }
    expect(archivedLaneReason({ tag: "spa", lanes: [...lanes, latin] })).toBeNull()
    expect(archivedLaneReason({ tag: "es", lanes: [...lanes, latin] })).toBe(
      "lane 'Spanish' is archived",
    )
  })

  it("allows an active default lane, an active sibling, and a restored lane", () => {
    expect(archivedLaneReason({ tag: "", lanes })).toBeNull()
    expect(archivedLaneReason({ tag: "fr", lanes })).toBeNull()
    const restored = [{ ...spanish, archivedAt: null }]
    expect(archivedLaneReason({ tag: "es", lanes: restored })).toBeNull()
  })

  // AQU-1600: the former default lane is an ordinary lane. Once archived it
  // freezes writes exactly like any other, and an ALWAYS_LANE_KIND with no
  // targetLang is the write that names it.
  it("refuses a write to the former default lane once its row is archived", () => {
    const archivedDefault = [
      { ...defaultLane, archivedAt: "2026-10-03T00:00:00.000Z" },
      french,
    ]
    expect(archivedLaneReason({ tag: "", lanes: archivedDefault })).toBe(
      "lane 'English' is archived",
    )
    // The same refusal reaches the caller via laneTagForArchiveCheck's '' tag.
    const tag = laneTagForArchiveCheck("target.cell.commit", { value: "hola" })
    expect(tag).toBe("")
    expect(archivedLaneReason({ tag: tag!, lanes: archivedDefault })).toBe(
      "lane 'English' is archived",
    )
  })

  it("hides the archived former default lane from a caller who cannot know it", () => {
    const archivedDefault = [{ ...defaultLane, archivedAt: "2026-10-03T00:00:00.000Z" }]
    const hidden = archivedLaneReason({
      tag: "",
      lanes: archivedDefault,
      visibleLaneIds: new Set(["frlane01"]),
    })
    expect(hidden).toBe(LANE_DOES_NOT_EXIST_REASON)
    expect(hidden).not.toContain("English")
  })

  it("does not refuse a project that has no former-default lane row at all", () => {
    expect(archivedLaneReason({ tag: "", lanes: [french] })).toBeNull()
  })

  // AQU-2223: the row is the only record. The retired settings mirror is not
  // an input, so a restored row is open whatever an old blob still lists.
  it("allows a restored lane", () => {
    const restored = [{ ...spanish, archivedAt: null }]
    expect(archivedLaneReason({ tag: "es", lanes: restored })).toBeNull()
  })

  it("hides the name and the archived state from a caller who cannot know the lane", () => {
    const german: ArchiveLaneRow = {
      id: "delane01",
      name: "German",
      legacyTag: "de",
      archivedAt: "2026-09-29T00:00:00.000Z",
    }
    const hidden = archivedLaneReason({
      tag: "German",
      lanes: [german],
      visibleLaneIds: new Set(),
    })
    expect(hidden).toBe(LANE_DOES_NOT_EXIST_REASON)
    expect(hidden).not.toContain("German")
    expect(hidden).not.toContain("archived")

    const byTag = archivedLaneReason({
      tag: "de",
      lanes: [german],
      visibleLaneIds: new Set(["frlane01"]),
    })
    expect(byTag).toBe(LANE_DOES_NOT_EXIST_REASON)
    expect(byTag).not.toContain("German")
    expect(byTag).not.toContain("archived")
  })

  it("still names an archived lane the caller is allowed to know", () => {
    expect(
      archivedLaneReason({
        tag: "es",
        lanes,
        visibleLaneIds: new Set(["eslane01"]),
      }),
    ).toBe("lane 'Spanish' is archived")
  })
})
