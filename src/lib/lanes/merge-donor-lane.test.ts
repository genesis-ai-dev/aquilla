import { describe, it, expect } from "vitest"
import {
  chooseDonorLane,
  donorLaneRefusalMessage,
  type DonorLaneCandidate,
} from "./merge-donor-lane"

function lane(partial: Partial<DonorLaneCandidate> & { id: string }): DonorLaneCandidate {
  return {
    name: partial.name ?? partial.id,
    legacyTag: partial.legacyTag ?? "",
    archivedAt: partial.archivedAt ?? null,
    ...partial,
  }
}

describe("chooseDonorLane (AQU-1602)", () => {
  it("takes the donor's single active lane when none is named", () => {
    const only = lane({ id: "d-1", name: "French", legacyTag: "" })
    expect(chooseDonorLane({ lanes: [only] })).toEqual({ ok: true, lane: only })
  })

  it("takes that single lane even when its tag is not the former default lane", () => {
    // The regression: a pair project whose one lane came from the languages
    // screen carries its lane id as the tag (AQU-1418), not ''. Reading
    // `target_lang = ''` found nothing and the merge reported success.
    const only = lane({ id: "d-9", name: "Quechua", legacyTag: "d-9" })
    expect(chooseDonorLane({ lanes: [only] })).toEqual({ ok: true, lane: only })
  })

  it("takes the lane the caller names, by id", () => {
    const first = lane({ id: "d-1", name: "French" })
    const second = lane({ id: "d-2", name: "Spanish", legacyTag: "es" })
    expect(chooseDonorLane({ lanes: [first, second], donorLaneId: "d-2" })).toEqual({
      ok: true,
      lane: second,
    })
  })

  it("trims a named id and ignores an empty one", () => {
    const only = lane({ id: "d-1" })
    expect(chooseDonorLane({ lanes: [only], donorLaneId: "  d-1 " })).toEqual({ ok: true, lane: only })
    expect(chooseDonorLane({ lanes: [only], donorLaneId: "   " })).toEqual({ ok: true, lane: only })
    expect(chooseDonorLane({ lanes: [only], donorLaneId: null })).toEqual({ ok: true, lane: only })
  })

  it("folds a named lane even when it is archived — the whole donor is being retired", () => {
    const archived = lane({ id: "d-1", name: "French", archivedAt: "2026-01-01T00:00:00Z" })
    const active = lane({ id: "d-2", name: "Spanish", legacyTag: "es" })
    expect(chooseDonorLane({ lanes: [archived, active], donorLaneId: "d-1" })).toEqual({
      ok: true,
      lane: archived,
    })
  })

  it("refuses a donor with several active lanes, and offers them", () => {
    const first = lane({ id: "d-1", name: "French" })
    const second = lane({ id: "d-2", name: "Spanish", legacyTag: "es" })
    expect(chooseDonorLane({ lanes: [first, second] })).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: [first, second],
    })
  })

  it("ignores archived lanes when auto-selecting, so one active lane is unambiguous", () => {
    const archived = lane({ id: "d-1", name: "French", archivedAt: "2026-01-01T00:00:00Z" })
    const active = lane({ id: "d-2", name: "Spanish", legacyTag: "es" })
    expect(chooseDonorLane({ lanes: [archived, active] })).toEqual({ ok: true, lane: active })
  })

  it("treats an empty-string archived_at as active, as the lane helpers do", () => {
    const active = lane({ id: "d-1", archivedAt: "" })
    expect(chooseDonorLane({ lanes: [active] })).toEqual({ ok: true, lane: active })
  })

  it("refuses a named id that is not one of the donor's lanes", () => {
    const only = lane({ id: "d-1" })
    expect(chooseDonorLane({ lanes: [only], donorLaneId: "nope" })).toEqual({
      ok: false,
      reason: "not_found",
      candidates: [only],
    })
  })

  it("refuses a donor with no target lane, and one whose lanes are all archived", () => {
    expect(chooseDonorLane({ lanes: [] })).toEqual({ ok: false, reason: "none", candidates: [] })
    const archived = lane({ id: "d-1", archivedAt: "2026-01-01T00:00:00Z" })
    expect(chooseDonorLane({ lanes: [archived] })).toEqual({
      ok: false,
      reason: "none",
      // Still listed, so the operator can see what the donor holds.
      candidates: [archived],
    })
  })
})

describe("donorLaneRefusalMessage", () => {
  it("names the candidate ids when the choice is ambiguous", () => {
    const message = donorLaneRefusalMessage("ambiguous", [lane({ id: "d-1" }), lane({ id: "d-2" })])
    expect(message).toContain("donorLaneId")
    expect(message).toContain("d-1, d-2")
  })

  it("says plainly when there is nothing to fold", () => {
    expect(donorLaneRefusalMessage("none", [])).toBe("the donor project has no target lane to fold")
  })

  it("lists the donor's lanes when the named id is unknown", () => {
    expect(donorLaneRefusalMessage("not_found", [lane({ id: "d-1" })])).toContain("d-1")
  })
})
