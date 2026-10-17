import { describe, expect, it } from "vitest"
import {
  assignLaneOptions,
  DEFAULT_LANE_SELECT_VALUE,
  buildLaneItems,
  initialAssignmentLane,
  isDefaultLaneValue,
  laneIdForTag,
  lanesStaffedBy,
  laneTagForAssignment,
  selectValueForLane,
} from "./assignment-lane"

describe("assignment lane (AQU-729)", () => {
  it("treats empty, the select sentinel, and the word default as the default lane", () => {
    for (const value of ["", "  ", "default", "Default", "Default language", DEFAULT_LANE_SELECT_VALUE, null, undefined]) {
      expect(isDefaultLaneValue(value)).toBe(true)
      expect(laneTagForAssignment(value)).toBeUndefined()
      expect(selectValueForLane(value)).toBe(DEFAULT_LANE_SELECT_VALUE)
    }
  })

  it("keeps an explicit language tag and never rewrites it to the default lane", () => {
    expect(laneTagForAssignment("Swahili")).toBe("Swahili")
    expect(laneTagForAssignment(" es ")).toBe("es")
    expect(selectValueForLane("Swahili")).toBe("Swahili")
    expect(isDefaultLaneValue("World English")).toBe(false)
  })
})

describe("buildLaneItems (AQU-1601)", () => {
  const fallback = "Default language"

  it("names the only lane instead of returning nothing", () => {
    expect(buildLaneItems({ defaultLaneLabel: "French", defaultLaneFallback: fallback })).toEqual([
      { value: DEFAULT_LANE_SELECT_VALUE, label: "French" },
    ])
  })

  it("lists the default lane and each extra lane, and a row name wins over the tag", () => {
    expect(
      buildLaneItems({
        targetLanes: ["es", ""],
        laneLabels: { "": "French", es: "Spanish" },
        defaultLaneFallback: fallback,
      }),
    ).toEqual([
      { value: DEFAULT_LANE_SELECT_VALUE, label: "French" },
      { value: "es", label: "Spanish" },
    ])
  })

  it("keeps only the lanes a delegate grant names, including the default lane", () => {
    const items = buildLaneItems({
      targetLanes: ["es", "de"],
      defaultLaneLabel: "French",
      defaultLaneFallback: fallback,
      allowedTags: [""],
    })
    expect(items).toEqual([{ value: DEFAULT_LANE_SELECT_VALUE, label: "French" }])
  })

  it("pre-fills one lane, the lane the user arrived from, and nothing from All", () => {
    const one = [{ value: DEFAULT_LANE_SELECT_VALUE }]
    const several = [{ value: DEFAULT_LANE_SELECT_VALUE }, { value: "es" }]
    expect(initialAssignmentLane(one, null)).toBe(DEFAULT_LANE_SELECT_VALUE)
    expect(initialAssignmentLane(several, "es")).toBe("es")
    expect(initialAssignmentLane(several, "")).toBe(DEFAULT_LANE_SELECT_VALUE)
    expect(initialAssignmentLane(several, null)).toBeNull()
  })

  it("sends the lane id of the matching legacy tag, and nothing when the row is missing or ambiguous", () => {
    const rows = [
      { id: "lane-default", legacyTag: "" },
      { id: "lane-es", legacyTag: "es" },
    ]
    expect(laneIdForTag(undefined, rows)).toBe("lane-default")
    expect(laneIdForTag("es", rows)).toBe("lane-es")
    expect(laneIdForTag("es", [])).toBeUndefined()
    expect(laneIdForTag("es", [
      { id: "a", legacyTag: "es" },
      { id: "b", legacyTag: "es" },
    ])).toBeUndefined()
  })
})

// AQU-1977: a project made since AQU-1594 has no '' lane. The invented default
// option saved work into it — an assignment that belongs to no lane.
describe("the project's own lanes (AQU-1977)", () => {
  type Row = {
    id: string
    role: "source" | "target"
    language: string | null
    legacyTag: string | null
    position: number
    archivedAt: string | null
  }
  const row = (over: Partial<Row> & Pick<Row, "id" | "legacyTag">): Row => ({
    role: "target", language: null, position: 0, archivedAt: null, ...over,
  })

  it("lists the live target lanes in position order, by name", () => {
    const options = assignLaneOptions([
      row({ id: "src00001", role: "source", language: "English", legacyTag: null, position: 0 }),
      row({ id: "fr000001", language: "French", legacyTag: "French", position: 2 }),
      row({ id: "es000001", language: "Spanish", legacyTag: "Spanish", position: 1 }),
      row({ id: "de000001", language: "German", legacyTag: "German", position: 3, archivedAt: "2026-10-01" }),
    ], "Default language")
    expect(options).toEqual([
      { legacyTag: "Spanish", label: "Spanish", laneId: "es000001" },
      { legacyTag: "French", label: "French", laneId: "fr000001" },
    ])
  })

  it("keeps an old project's '' lane as an ordinary option, under its language", () => {
    const options = assignLaneOptions([
      row({ id: "def00001", language: "Bambara", legacyTag: "", position: 0 }),
      row({ id: "es000001", language: "Spanish", legacyTag: "es", position: 1 }),
    ], "Default language")
    expect(options).toEqual([
      { legacyTag: "", label: "Bambara", laneId: "def00001" },
      { legacyTag: "es", label: "Spanish", laneId: "es000001" },
    ])
  })

  it("offers exactly those lanes, and no default the project lacks", () => {
    const items = buildLaneItems({
      lanes: [{ legacyTag: "Spanish", label: "Spanish" }],
      targetLanes: [],
      defaultLaneFallback: "Default language",
    })
    expect(items).toEqual([{ value: "Spanish", label: "Spanish" }])
  })

  it("still maps an old project's '' lane to the sentinel, and still honours a delegate's grant", () => {
    const items = buildLaneItems({
      lanes: [{ legacyTag: "", label: "Bambara" }, { legacyTag: "es", label: "Spanish" }],
      defaultLaneFallback: "Default language",
      allowedTags: ["es"],
    })
    expect(items).toEqual([{ value: "es", label: "Spanish" }])
    expect(buildLaneItems({
      lanes: [{ legacyTag: "", label: "Bambara" }],
      defaultLaneFallback: "Default language",
    })).toEqual([{ value: DEFAULT_LANE_SELECT_VALUE, label: "Bambara" }])
  })
})

/**
 * AQU-1994 — an assign field offers only the lanes someone on the project is
 * on. The reported case: a project on French, Mandarin Chinese and Swedish
 * whose people are only on Mandarin Chinese offered all three, so a manager
 * could route French work to a team with no access to French.
 *
 * Pins the three answers that matter: a known staffing set narrows (by lane
 * ID, because two lanes can share a legacy tag), an unknown one — an older
 * server, or a caller who may not read staffing — narrows NOTHING, and a
 * known set matching no lane narrows to zero options rather than falling back
 * to the legacy "default + targetLanes" shape, which would have re-offered
 * every lane.
 */
describe("lanes someone on the project is on (AQU-1994)", () => {
  const fr = { legacyTag: "French", label: "French", laneId: "lane-fr" }
  const zh = { legacyTag: "Mandarin Chinese", label: "Mandarin Chinese", laneId: "lane-zh" }
  const sv = { legacyTag: "Swedish", label: "Swedish", laneId: "lane-sv" }

  it("keeps only the staffed lanes", () => {
    expect(lanesStaffedBy([fr, zh, sv], new Set(["lane-zh"]))).toEqual([zh])
    expect(lanesStaffedBy([fr, zh, sv], ["lane-zh", "lane-fr"])).toEqual([fr, zh])
  })

  it("treats unknown staffing as 'say nothing', not as 'nobody'", () => {
    expect(lanesStaffedBy([fr, zh, sv], null)).toEqual([fr, zh, sv])
    expect(lanesStaffedBy([fr, zh, sv], undefined)).toEqual([fr, zh, sv])
  })

  it("keeps a lane whose id the server never sent — staffing cannot judge it", () => {
    const old = { legacyTag: "Swedish", label: "Swedish" }
    expect(lanesStaffedBy([zh, old], new Set(["lane-zh"]))).toEqual([zh, old])
  })

  it("narrows by lane id, so one of two lanes sharing a tag can be unstaffed", () => {
    const zhA = { legacyTag: "Mandarin Chinese", label: "Mandarin (simplified)", laneId: "lane-zh-a" }
    const zhB = { legacyTag: "Mandarin Chinese", label: "Mandarin (traditional)", laneId: "lane-zh-b" }
    expect(lanesStaffedBy([zhA, zhB], new Set(["lane-zh-b"]))).toEqual([zhB])
  })

  it("offers only the staffed lane, and names it rather than listing a dropdown", () => {
    const items = buildLaneItems({
      lanes: [fr, zh, sv],
      defaultLaneFallback: "Default language",
      staffedLaneIds: new Set(["lane-zh"]),
    })
    expect(items).toEqual([{ value: "Mandarin Chinese", label: "Mandarin Chinese" }])
    // One option is the option: the field names the lane instead of asking.
    expect(initialAssignmentLane(items, null)).toBe("Mandarin Chinese")
  })

  it("does not preselect the lane tab the manager arrived from when nobody is on it", () => {
    const items = buildLaneItems({
      lanes: [fr, zh, sv],
      defaultLaneFallback: "Default language",
      staffedLaneIds: new Set(["lane-zh", "lane-sv"]),
    })
    expect(items.map((item) => item.value)).toEqual(["Mandarin Chinese", "Swedish"])
    expect(initialAssignmentLane(items, "French")).toBeNull()
    expect(initialAssignmentLane(items, "Swedish")).toBe("Swedish")
  })

  it("narrows to nothing rather than falling back to every target lane", () => {
    const items = buildLaneItems({
      lanes: [fr, zh, sv],
      // The legacy shape is still on the props; an empty narrowing must not
      // make buildLaneItems reach for it and re-offer all three lanes.
      targetLanes: ["French", "Mandarin Chinese", "Swedish"],
      defaultLaneLabel: "French",
      defaultLaneFallback: "Default language",
      staffedLaneIds: new Set<string>(),
    })
    expect(items).toEqual([])
  })

  it("leaves a project with no lane rows alone — there is no grant to read", () => {
    const items = buildLaneItems({
      targetLanes: ["Swahili"],
      defaultLaneLabel: "Bambara",
      defaultLaneFallback: "Default language",
      staffedLaneIds: new Set<string>(),
    })
    expect(items).toEqual([
      { value: DEFAULT_LANE_SELECT_VALUE, label: "Bambara" },
      { value: "Swahili", label: "Swahili" },
    ])
  })
})
