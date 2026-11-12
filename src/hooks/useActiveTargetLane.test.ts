// AQU-1902: the editor only writes once it can name the active lane's row.
import { describe, expect, it } from "vitest"
import { activeTargetLaneFor } from "./useActiveTargetLane"

const TAGGED = [
  { id: "lane-es", legacyTag: "Spanish" },
  { id: "lane-fr", legacyTag: "French" },
]

describe("activeTargetLaneFor (AQU-1902)", () => {
  it("names the active lane's row once the rows are loaded", () => {
    expect(
      activeTargetLaneFor({ laneRows: TAGGED, settingsFetched: true, activeLane: "French", stored: null }),
    ).toEqual({ targetLang: "French", laneId: "lane-fr" })
  })

  it("is null (editor read-only) while a first-time reader's rows load", () => {
    expect(
      activeTargetLaneFor({ laneRows: null, settingsFetched: false, activeLane: "", stored: null }),
    ).toBeNull()
  })

  it("is null in the render between the rows arriving and the lane choice resolving off ''", () => {
    expect(
      activeTargetLaneFor({ laneRows: TAGGED, settingsFetched: true, activeLane: "", stored: null }),
    ).toBeNull()
  })

  it("uses a returning reader's stored lane id at once — the lane the editor is already showing", () => {
    expect(
      activeTargetLaneFor({
        laneRows: null,
        settingsFetched: false,
        activeLane: "Spanish",
        stored: { laneId: "lane-es", legacyTag: "Spanish" },
      }),
    ).toEqual({ targetLang: "Spanish", laneId: "lane-es" })
  })

  it("never uses a stored id for a different tag than the one on screen", () => {
    expect(
      activeTargetLaneFor({
        laneRows: null,
        settingsFetched: false,
        activeLane: "",
        stored: { laneId: "lane-es", legacyTag: "Spanish" },
      }),
    ).toBeNull()
  })

  it("keeps a project with no target lane writable (the write mints the bridge)", () => {
    expect(
      activeTargetLaneFor({ laneRows: [], settingsFetched: true, activeLane: "", stored: null }),
    ).toEqual({ targetLang: "", laneId: null })
  })

  it("keeps a server without lane rows on the tag-only path", () => {
    expect(
      activeTargetLaneFor({ laneRows: null, settingsFetched: true, activeLane: "", stored: null }),
    ).toEqual({ targetLang: "", laneId: null })
  })
})
