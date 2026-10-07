import { describe, expect, it } from "vitest"
import {
  conceptsForLane,
  conceptsForLaneTag,
  legacyEmptyLaneId,
  renderingLaneId,
  renderingsForLane,
  replaceLaneRenderings,
  stampRenderingLanes,
} from "./rendering-lane"

const EMPTY = "aaaaaaaa"
const SPANISH = "bbbbbbbb"
const lanes = [
  { id: EMPTY, role: "target" as const, legacyTag: "" },
  { id: SPANISH, role: "target" as const, legacyTag: "es" },
  { id: "src00001", role: "source" as const, legacyTag: null },
]

describe("renderingLaneId", () => {
  it("sends a rendering with no laneId to the legacy empty lane", () => {
    expect(renderingLaneId({ laneId: undefined }, EMPTY)).toBe(EMPTY)
    expect(renderingLaneId({ laneId: "" }, EMPTY)).toBe(EMPTY)
    expect(renderingLaneId({ laneId: null }, EMPTY)).toBe(EMPTY)
  })

  it("keeps a rendering that already names a lane", () => {
    expect(renderingLaneId({ laneId: SPANISH }, EMPTY)).toBe(SPANISH)
  })

  it("does not treat a null legacy tag as the empty lane", () => {
    expect(legacyEmptyLaneId(lanes)).toBe(EMPTY)
    expect(legacyEmptyLaneId([{ id: "src00001", role: "source", legacyTag: null }])).toBeNull()
  })
})

describe("two lanes, one concept", () => {
  const concepts = [
    {
      id: "grace",
      sourceTerm: "grace",
      renderings: [
        { rendering: "favor", status: "preferred" as const },
        { rendering: "gracia", status: "preferred" as const, laneId: SPANISH },
      ],
    },
  ]

  it("shows each lane only its own renderings, and keeps the source term", () => {
    const english = conceptsForLane(concepts, EMPTY, EMPTY)
    const spanish = conceptsForLane(concepts, SPANISH, EMPTY)
    expect(english[0].sourceTerm).toBe("grace")
    expect(english[0].renderings.map((r) => r.rendering)).toEqual(["favor"])
    expect(spanish[0].renderings.map((r) => r.rendering)).toEqual(["gracia"])
  })

  it("resolves the same split from legacy tags", () => {
    expect(conceptsForLaneTag(concepts, "", lanes)[0].renderings.map((r) => r.rendering)).toEqual(["favor"])
    expect(conceptsForLaneTag(concepts, "es", lanes)[0].renderings.map((r) => r.rendering)).toEqual(["gracia"])
  })

  it("stamps only the missing id, so a replay is deterministic", () => {
    const stamped = stampRenderingLanes(concepts[0].renderings, EMPTY)
    expect(stamped.map((r) => r.laneId)).toEqual([EMPTY, SPANISH])
    expect(stampRenderingLanes(stamped, EMPTY)).toEqual(stamped)
    expect(stampRenderingLanes(concepts[0].renderings, null)[0].laneId).toBeUndefined()
  })

  it("replaces one lane without wiping the other", () => {
    const next = replaceLaneRenderings(concepts[0].renderings, EMPTY, EMPTY, [
      { rendering: "favour", status: "preferred" },
    ])
    expect(renderingsForLane(next, EMPTY, EMPTY).map((r) => r.rendering)).toEqual(["favour"])
    expect(renderingsForLane(next, SPANISH, EMPTY).map((r) => r.rendering)).toEqual(["gracia"])
    expect(next.find((r) => r.rendering === "favour")?.laneId).toBe(EMPTY)
  })

  it("gives an unknown tag no renderings, and an unbridged project all of them", () => {
    expect(conceptsForLaneTag(concepts, "fr", lanes)[0].renderings).toEqual([])
    expect(conceptsForLaneTag(concepts, "es", [])).toEqual(concepts.slice())
  })
})
