import { beforeEach, describe, expect, it } from "vitest"
import {
  activeLaneStorageKey,
  firstPositionLaneId,
  laneIdForTag,
  laneTagForId,
  legacyActiveLaneStorageKey,
  orderedLaneChoices,
  readPersistedActiveLane,
  readPersistedLaneChoice,
  resolveDeepLinkLaneId,
  resolveOpeningLaneId,
  resolveStoredLaneId,
  writePersistedActiveLane,
  type LaneChoiceRow,
} from "./active-lane-choice"

/** The former default lane: `legacy_tag ''`, first in position order. */
const formerDefault: LaneChoiceRow = {
  id: "aa11bb22",
  legacyTag: "",
  position: 0,
  archivedAt: null,
}
const french: LaneChoiceRow = {
  id: "cc33dd44",
  legacyTag: "french",
  position: 1,
  archivedAt: null,
}
/** A lane created after AQU-1240: an id and no tag at all. */
const tagless: LaneChoiceRow = {
  id: "ee55ff66",
  legacyTag: null,
  position: 2,
  archivedAt: null,
}
const lanes = [formerDefault, french, tagless]

describe("orderedLaneChoices", () => {
  it("orders by position, then by id", () => {
    const a: LaneChoiceRow = { id: "bbbb", legacyTag: null, position: 1, archivedAt: null }
    const b: LaneChoiceRow = { id: "aaaa", legacyTag: null, position: 1, archivedAt: null }
    expect(orderedLaneChoices([a, b]).map((l) => l.id)).toEqual(["aaaa", "bbbb"])
  })

  it("does not mutate its input", () => {
    const input = [french, formerDefault]
    orderedLaneChoices(input)
    expect(input.map((l) => l.id)).toEqual([french.id, formerDefault.id])
  })
})

describe("firstPositionLaneId", () => {
  it("is the first lane in position order", () => {
    expect(firstPositionLaneId([french, tagless, formerDefault])).toBe(formerDefault.id)
  })

  it("skips an archived lane — including the archived former default lane (AQU-1600)", () => {
    const archivedDefault = { ...formerDefault, archivedAt: "2026-10-02T00:00:00.000Z" }
    expect(firstPositionLaneId([archivedDefault, french, tagless])).toBe(french.id)
  })

  it("still names a lane when every lane is archived", () => {
    const allArchived = lanes.map((l) => ({ ...l, archivedAt: "2026-10-02T00:00:00.000Z" }))
    expect(firstPositionLaneId(allArchived)).toBe(formerDefault.id)
  })

  it("is null when the project has no target lane rows", () => {
    expect(firstPositionLaneId([])).toBeNull()
  })
})

describe("laneTagForId", () => {
  it("gives the lane's legacy tag", () => {
    expect(laneTagForId(french.id, lanes)).toBe("french")
  })

  it("gives '' for the former default lane and for a tagless lane", () => {
    expect(laneTagForId(formerDefault.id, lanes)).toBe("")
    expect(laneTagForId(tagless.id, lanes)).toBe("")
  })

  it("gives '' for no lane and for an unknown lane", () => {
    expect(laneTagForId(null, lanes)).toBe("")
    expect(laneTagForId("nosuchid", lanes)).toBe("")
  })
})

describe("laneIdForTag", () => {
  it("maps an old tag through legacyTag", () => {
    expect(laneIdForTag("french", lanes)).toBe(french.id)
  })

  it("maps an old link's differently-cased tag (?lane=French)", () => {
    expect(laneIdForTag("French", lanes)).toBe(french.id)
  })

  it("maps '' to the former default lane, never to a tagless lane", () => {
    expect(laneIdForTag("", lanes)).toBe(formerDefault.id)
    expect(laneIdForTag("", [tagless, french])).toBeNull()
  })

  it("misses an unrelated tag rather than landing on a near neighbour", () => {
    expect(laneIdForTag("fr-CA", lanes)).toBeNull()
    expect(laneIdForTag("german", lanes)).toBeNull()
  })
})

describe("resolveDeepLinkLaneId", () => {
  it("keeps the last-used lane when ?lane= is absent", () => {
    expect(resolveDeepLinkLaneId(null, lanes)).toBeNull()
    expect(resolveDeepLinkLaneId(undefined, lanes)).toBeNull()
  })

  it("opens the lane in first position for an empty ?lane=", () => {
    expect(resolveDeepLinkLaneId("", lanes)).toBe(formerDefault.id)
  })

  it("opens a lane named by id", () => {
    expect(resolveDeepLinkLaneId(tagless.id, lanes)).toBe(tagless.id)
  })

  it("opens the right lane for an old ?lane=French link", () => {
    expect(resolveDeepLinkLaneId("French", lanes)).toBe(french.id)
  })

  it("falls back to first position for an unknown lane", () => {
    expect(resolveDeepLinkLaneId("german", lanes)).toBe(formerDefault.id)
  })

  it("does not fall back to the former default lane once it is archived", () => {
    const archivedDefault = { ...formerDefault, archivedAt: "2026-10-02T00:00:00.000Z" }
    const withArchived = [archivedDefault, french, tagless]
    expect(resolveDeepLinkLaneId("", withArchived)).toBe(french.id)
    expect(resolveDeepLinkLaneId("german", withArchived)).toBe(french.id)
  })

  it("still opens the archived former default lane when the link names it", () => {
    const archivedDefault = { ...formerDefault, archivedAt: "2026-10-02T00:00:00.000Z" }
    const withArchived = [archivedDefault, french]
    expect(resolveDeepLinkLaneId(archivedDefault.id, withArchived)).toBe(archivedDefault.id)
  })
})

describe("resolveStoredLaneId", () => {
  it("prefers a stored lane id", () => {
    expect(resolveStoredLaneId({ laneId: french.id, legacyTag: null }, lanes)).toBe(french.id)
  })

  it("migrates a stored tag through legacyTag", () => {
    expect(resolveStoredLaneId({ laneId: null, legacyTag: "french" }, lanes)).toBe(french.id)
  })

  it("migrates the stored default-lane tag ('') to the former default lane", () => {
    expect(resolveStoredLaneId({ laneId: null, legacyTag: "" }, lanes)).toBe(formerDefault.id)
  })

  it("resolves an archived lane the reader was last on", () => {
    const archivedFrench = { ...french, archivedAt: "2026-10-02T00:00:00.000Z" }
    expect(
      resolveStoredLaneId({ laneId: archivedFrench.id, legacyTag: null }, [formerDefault, archivedFrench]),
    ).toBe(archivedFrench.id)
  })

  it("is null for a stored lane that no longer exists, so the caller opens first position", () => {
    expect(resolveStoredLaneId({ laneId: "gonelane", legacyTag: null }, lanes)).toBeNull()
    expect(resolveStoredLaneId({ laneId: null, legacyTag: "german" }, lanes)).toBeNull()
  })

  it("is null when nothing is stored", () => {
    expect(resolveStoredLaneId({ laneId: null, legacyTag: null }, lanes)).toBeNull()
  })

  it("falls back to the stored tag when the stored id is another project's", () => {
    expect(resolveStoredLaneId({ laneId: "otherprj", legacyTag: "french" }, lanes)).toBe(french.id)
  })
})

describe("resolveOpeningLaneId", () => {
  it("lets a deep link outrank the stored choice", () => {
    expect(
      resolveOpeningLaneId({
        deepLinkParam: tagless.id,
        stored: { laneId: french.id, legacyTag: null },
        lanes,
      }),
    ).toBe(tagless.id)
  })

  it("keeps the stored choice when there is no deep link", () => {
    expect(
      resolveOpeningLaneId({ stored: { laneId: french.id, legacyTag: null }, lanes }),
    ).toBe(french.id)
  })

  it("opens first position when nothing names a lane", () => {
    expect(resolveOpeningLaneId({ lanes })).toBe(formerDefault.id)
  })

  it("opens first position when the stored lane is gone", () => {
    expect(
      resolveOpeningLaneId({ stored: { laneId: "gonelane", legacyTag: null }, lanes }),
    ).toBe(formerDefault.id)
  })

  it("is null for a project with no target lane rows", () => {
    expect(resolveOpeningLaneId({ deepLinkParam: "", lanes: [] })).toBeNull()
  })
})

describe("persistence", () => {
  const projectId = "proj-1"

  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips the lane id and its tag", () => {
    writePersistedActiveLane(projectId, french.id, "french")
    expect(readPersistedLaneChoice(projectId)).toMatchObject({
      laneId: french.id,
      tag: "french",
    })
    expect(readPersistedActiveLane(projectId)).toBe("french")
  })

  it("stores the former default lane explicitly, where the old key stored nothing", () => {
    writePersistedActiveLane(projectId, formerDefault.id, "")
    expect(localStorage.getItem(activeLaneStorageKey(projectId))).toBeTruthy()
    expect(resolveStoredLaneId(readPersistedLaneChoice(projectId), lanes)).toBe(formerDefault.id)
  })

  it("migrates a pre-AQU-1613 tag key and then rewrites it away", () => {
    localStorage.setItem(legacyActiveLaneStorageKey(projectId), "french")
    const stored = readPersistedLaneChoice(projectId)
    expect(stored).toMatchObject({ laneId: null, legacyTag: "french" })
    const laneId = resolveStoredLaneId(stored, lanes)
    expect(laneId).toBe(french.id)

    writePersistedActiveLane(projectId, laneId, laneTagForId(laneId, lanes))
    expect(localStorage.getItem(legacyActiveLaneStorageKey(projectId))).toBeNull()
    expect(readPersistedLaneChoice(projectId)).toMatchObject({ laneId: french.id })
  })

  it("reads an absent tag key as no stored choice, not as the default lane", () => {
    const stored = readPersistedLaneChoice(projectId)
    expect(stored).toEqual({ laneId: null, legacyTag: null, tag: "" })
    expect(resolveStoredLaneId(stored, lanes)).toBeNull()
    expect(resolveOpeningLaneId({ stored, lanes })).toBe(formerDefault.id)
  })

  it("still resolves a choice stored before the lane rows arrived (no id)", () => {
    writePersistedActiveLane(projectId, null, "french")
    expect(resolveStoredLaneId(readPersistedLaneChoice(projectId), lanes)).toBe(french.id)
  })

  it("falls back to the stored tag when the stored id named a lane that is gone", () => {
    writePersistedActiveLane(projectId, "gonelane", "french")
    expect(resolveStoredLaneId(readPersistedLaneChoice(projectId), lanes)).toBe(french.id)
  })

  it("survives a corrupt stored value", () => {
    localStorage.setItem(activeLaneStorageKey(projectId), "{not json")
    expect(readPersistedLaneChoice(projectId)).toEqual({ laneId: null, legacyTag: null, tag: "" })
  })

  it("keys storage per project", () => {
    writePersistedActiveLane(projectId, french.id, "french")
    expect(readPersistedLaneChoice("proj-2")).toEqual({ laneId: null, legacyTag: null, tag: "" })
  })
})
