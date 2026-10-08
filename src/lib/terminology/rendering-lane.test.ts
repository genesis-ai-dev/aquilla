import { describe, expect, it } from "vitest"
import type { LaneLanguageRow } from "../lanes/lane-language"
import {
  conceptsForLane,
  conceptsForLaneTag,
  legacyEmptyLaneId,
  mapSubscribedConceptLanes,
  renderingLaneId,
  renderingsForLane,
  replaceLaneRenderings,
  stampRenderingLanes,
  subscribedLanesMatch,
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

// AQU-1777: a termbase a project subscribes to is another project with its
// own lanes, so its renderings carry the TERMBASE's lane ids. Those never
// equal the subscriber's, so without this mapping a stamped subscribed
// rendering was absent from every lane of the subscriber.
describe("subscribed termbase renderings map onto the subscriber's lanes (AQU-1777)", () => {
  const lane = (
    id: string,
    legacyTag: string | null,
    language: string | null,
    role: "source" | "target" = "target",
  ): LaneLanguageRow => ({ id, role, legacyTag, language, name: null, langCode: null })

  // Termbase T: its `''` bridge lane is Spanish, plus a French lane.
  const T_ES = lane("t0000e5a", "", "Spanish")
  const T_FR = lane("t0000f7a", "fr", "French")
  const termbase = [lane("t000055c", null, "English", "source"), T_ES, T_FR]
  // Subscriber S: an English `''` lane, a Spanish lane tagged "es", and a
  // Canadian-French lane whose tag is its own id (planNewTargetLane's case).
  const S_EN = lane("50000e00", "", "English")
  const S_ES = lane("50000e5a", "es", "spanish")
  const S_FR = lane("50000f7a", "50000f7a", "fr-CA")
  const subscriber = [lane("5000055c", null, "English", "source"), S_EN, S_ES, S_FR]

  type Rendering = { rendering: string; status: "preferred" | "admitted" | "forbidden"; laneId?: string }
  const renderings: Rendering[] = [
    // Unstamped: T's `''` lane, which is Spanish.
    { rendering: "gracia", status: "preferred" },
    { rendering: "grâce", status: "preferred", laneId: T_FR.id },
    // Stamped with a lane T no longer has.
    { rendering: "grazia", status: "admitted", laneId: "t0000111" },
  ]
  const grace = { id: "grace", sourceTerm: "grace", renderings }
  const favor: Rendering[] = [{ rendering: "favor", status: "admitted" }]
  const mapped = mapSubscribedConceptLanes([grace], termbase, subscriber)
  const inLane = (laneId: string) =>
    conceptsForLane(mapped, laneId, S_EN.id)[0].renderings.map((r) => r.rendering)

  it("matches lanes by language through the normalizer: name vs code, case, region", () => {
    expect(mapped[0].renderings.map((r) => [r.rendering, r.laneId])).toEqual([
      ["gracia", S_ES.id],
      ["grâce", S_FR.id],
    ])
  })

  it("reads an unstamped rendering as the TERMBASE's '' lane, never the subscriber's", () => {
    expect(inLane(S_EN.id)).toEqual([])
    expect(inLane(S_ES.id)).toEqual(["gracia"])
  })

  it("drops a rendering no subscriber lane matches", () => {
    expect(mapped[0].renderings.some((r) => r.rendering === "grazia")).toBe(false)
    expect(inLane(S_FR.id)).toEqual(["grâce"])
  })

  it("then resolves from the subscriber's legacy tags exactly like a local concept", () => {
    const byTag = (tag: string) => conceptsForLaneTag(mapped, tag, subscriber)[0].renderings.map((r) => r.rendering)
    expect(byTag("")).toEqual([])
    expect(byTag("es")).toEqual(["gracia"])
    expect(byTag(S_FR.id)).toEqual(["grâce"])
  })

  it("maps each rendering of a two-lane termbase to the right subscriber lane", () => {
    const stamped: Rendering[] = [{ rendering: "favor", status: "admitted", laneId: T_ES.id }]
    const [concept] = mapSubscribedConceptLanes([{ ...grace, renderings: stamped }], termbase, subscriber)
    expect(concept.renderings).toEqual([{ rendering: "favor", status: "admitted", laneId: S_ES.id }])
  })

  it("falls back to legacy_tag equality when either lane has no language", () => {
    // Two un-backfilled `''` lanes still find each other.
    expect(subscribedLanesMatch(lane("a0000000", "", null), lane("b0000000", "", "Spanish"))).toBe(true)
    expect(subscribedLanesMatch(lane("a0000000", "", null), lane("b0000000", "es", "Spanish"))).toBe(false)
    // An opaque 8-hex tag is never a language, so it only matches itself.
    expect(subscribedLanesMatch(lane("a0000000", "fr", "French"), lane("c0ffee01", "c0ffee01", null))).toBe(false)
    expect(subscribedLanesMatch(lane("a0000000", "c0ffee01", null), lane("c0ffee01", "c0ffee01", null))).toBe(true)
    // A tag that is a language string IS the lane's language (AQU-1592's reader).
    expect(subscribedLanesMatch(lane("a0000000", "es", null), lane("b0000000", "", "Spanish"))).toBe(true)
  })

  it("shows a termbase that has not grown lanes (no '' lane) in every matching subscriber lane", () => {
    // conceptsForLaneTag leaves such a termbase's lists unfiltered, so each of
    // its target lanes shows every rendering; the mapping follows suit.
    const twoLanes = [lane("t0000e5a", "Spanish", "Spanish"), lane("t0000f7a", "French", "French")]
    const [concept] = mapSubscribedConceptLanes([{ ...grace, renderings: favor }], twoLanes, subscriber)
    expect(concept.renderings.map((r) => r.laneId)).toEqual([S_ES.id, S_FR.id])
    const [single] = mapSubscribedConceptLanes(
      [{ ...grace, renderings: favor }],
      [lane("t0000e5a", "Spanish", "Spanish")],
      subscriber,
    )
    expect(single.renderings.map((r) => r.laneId)).toEqual([S_ES.id])
  })

  it("leaves the concepts unchanged when either side has no target lanes", () => {
    expect(mapSubscribedConceptLanes([grace], [], subscriber)).toEqual([grace])
    expect(mapSubscribedConceptLanes([grace], termbase, [lane("5000055c", null, "English", "source")])).toEqual([grace])
    expect(mapSubscribedConceptLanes([grace], [], subscriber)[0]).not.toBe(grace)
  })
})
