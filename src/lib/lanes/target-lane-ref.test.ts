import { describe, expect, it } from "vitest"
import { resolveTargetLaneRef, targetLanePayload } from "./target-lane-ref"

const TAGGED = [
  { id: "lane-es", legacyTag: "Spanish" },
  { id: "lane-fr", legacyTag: "French" },
]
const LEGACY = [
  { id: "lane-default", legacyTag: "" },
  { id: "lane-fr", legacyTag: "French" },
]

describe("resolveTargetLaneRef (AQU-1902)", () => {
  it("stamps the lane id for a tag that is a lane of the project", () => {
    expect(resolveTargetLaneRef(TAGGED, { targetLang: "Spanish" })).toEqual({
      ok: true,
      lane: { targetLang: "Spanish", laneId: "lane-es" },
    })
  })

  it("refuses a lane-less write on a project whose lanes are all tagged", () => {
    expect(resolveTargetLaneRef(TAGGED, {})).toEqual({ ok: false, reason: "no-such-lane" })
    expect(resolveTargetLaneRef(TAGGED, { targetLang: "" })).toEqual({ ok: false, reason: "no-such-lane" })
  })

  it("matches the tag exactly — a near neighbour is not the lane", () => {
    expect(resolveTargetLaneRef(TAGGED, { targetLang: "spanish" })).toEqual({ ok: false, reason: "no-such-lane" })
  })

  it("resolves '' to a legacy project's default lane row", () => {
    expect(resolveTargetLaneRef(LEGACY, { targetLang: "" })).toEqual({
      ok: true,
      lane: { targetLang: "", laneId: "lane-default" },
    })
  })

  it("keeps a lane-less write lane-less on a project with no target lane (the server mints the bridge)", () => {
    expect(resolveTargetLaneRef([], {})).toEqual({ ok: true, lane: { targetLang: "", laneId: null } })
    expect(resolveTargetLaneRef([], { targetLang: "Spanish" })).toEqual({ ok: false, reason: "no-such-lane" })
  })

  it("takes the tag from the row when an id is given, so the two forms cannot disagree", () => {
    expect(resolveTargetLaneRef(TAGGED, { laneId: "lane-fr", targetLang: "Spanish" })).toEqual({
      ok: true,
      lane: { targetLang: "French", laneId: "lane-fr" },
    })
    expect(resolveTargetLaneRef(TAGGED, { laneId: "lane-ghost" })).toEqual({ ok: false, reason: "no-such-lane" })
  })

  it("while the rows load, honours an explicit id or a matching hint, and waits otherwise", () => {
    expect(resolveTargetLaneRef(null, { laneId: "lane-es", targetLang: "Spanish" })).toEqual({
      ok: true,
      lane: { targetLang: "Spanish", laneId: "lane-es" },
    })
    const hint = { laneId: "lane-es", targetLang: "Spanish" }
    expect(resolveTargetLaneRef(null, { targetLang: "Spanish" }, hint)).toEqual({
      ok: true,
      lane: { targetLang: "Spanish", laneId: "lane-es" },
    })
    // The hint only stands in for the lane it names.
    expect(resolveTargetLaneRef(null, { targetLang: "" }, hint)).toEqual({ ok: false, reason: "lanes-loading" })
    expect(resolveTargetLaneRef(null, { targetLang: "Spanish" })).toEqual({ ok: false, reason: "lanes-loading" })
  })

  it("omits '' and a null id from the payload", () => {
    expect(targetLanePayload({ targetLang: "", laneId: null })).toEqual({})
    expect(targetLanePayload({ targetLang: "", laneId: "lane-default" })).toEqual({ laneId: "lane-default" })
    expect(targetLanePayload({ targetLang: "Spanish", laneId: "lane-es" })).toEqual({
      targetLang: "Spanish",
      laneId: "lane-es",
    })
  })
})
